#!/usr/bin/env bats

# Phase 2 Plan 02-01 — orchestrator skill contract tests.
#
# Verifies SKILL.md frontmatter + body invariants AND that a JSON snapshot
# matching the locked output schema (sessions[].status, action.type) round-trips
# through curl. Mocks the router HTTP server with a tiny `nc` listener so the
# tests pass without a live router.
#
# Requires bats-core 1.10+: `brew install bats-core`. If bats is unavailable on
# the host the file-existence + grep checks in the spec are mirrored by the
# Plan 02-01 acceptance_criteria automated checks (see plan).

setup() {
  export SKILL_DIR="$HOME/jarvis/skills-marketplace/skills/orchestrator"
  export MOCK_PORT="$(jot -r 1 50000 60000 2>/dev/null || echo 55421)"
  export MOCK_PAYLOAD='{"generated_at":"2026-05-07T12:00:00Z","sessions":[{"pid":1234,"repo":"jarvis","branch":"main","cwd":"/x","status":"awaiting_user_input","last_assistant_summary":"Approve plan?","suggestion":"Approve and proceed","action":{"type":"inject","text":"y"},"confidence":"high","todo_link":null,"tmux":null,"conflict":null}]}'
  ( while true; do
      printf "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${#MOCK_PAYLOAD}\r\n\r\n${MOCK_PAYLOAD}" \
        | nc -l "$MOCK_PORT" >/dev/null 2>&1 || true
    done ) &
  export MOCK_PID=$!
  sleep 0.5
}

teardown() {
  kill "$MOCK_PID" 2>/dev/null || true
  pkill -P "$MOCK_PID" 2>/dev/null || true
}

@test "skill SKILL.md exists at marketplace path" {
  [ -f "$SKILL_DIR/SKILL.md" ]
}

@test "skill frontmatter contains name: orchestrator" {
  grep -q "^name: orchestrator" "$SKILL_DIR/SKILL.md"
}

@test "skill body contains /orchestrator section heading" {
  grep -q "^# /orchestrator" "$SKILL_DIR/SKILL.md"
}

@test "skill body forbids direct fs reads" {
  grep -q "HTTP only" "$SKILL_DIR/SKILL.md"
}

@test "skill references the snapshot endpoint" {
  grep -q "/api/sessions/snapshot" "$SKILL_DIR/SKILL.md"
}

@test "skill skill is NOT under ~/.claude/" {
  ! [ -e "$HOME/.claude/skills/orchestrator/SKILL.md" ]
}

@test "mock server returns valid JSON snapshot shape" {
  result="$(curl -s --max-time 2 http://localhost:$MOCK_PORT)"
  echo "$result" | jq -e '.sessions[0].status' | grep -q "awaiting_user_input"
  echo "$result" | jq -e '.sessions[0].action.type' | grep -q "inject"
}
