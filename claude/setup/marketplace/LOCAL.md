# Skills Migration — Execution Plan

**Goal:** move Jarvis custom skills out of `~/.claude/skills/` (safetyCheck-protected)
to `~/jarvis/skills-marketplace/` (writable from any channel), with zero UX
regression in CLI or dashboard.

**Estimated time:** 15 minutes + 5 minutes testing.
**Rollback cost:** trivial (single `mv` to restore).
**Production risk:** low — operations are filesystem moves + one plugin registration.

---

## Current state

```
~/.claude/skills/
├── _archive/                  ← delete (obsolete)
├── agent-reach       → symlink to ~/.agents/skills/agent-reach   (LEAVE)
├── firecrawl         → symlink to ~/.agents/skills/firecrawl     (LEAVE)
├── jarvis-config     → symlink to ~/.claude/jarvis/skills/jarvis-config
├── reel-factory/     (real dir)                                  ← MOVE
└── trend-research/   (real dir)                                  ← MOVE
```

Three custom skills to migrate:
- **jarvis-config** — source already inside jarvis repo
- **reel-factory** — real dir, moves to new location
- **trend-research** — real dir, moves to new location

## Target state

```
~/jarvis/skills-marketplace/                (registered as CC marketplace)
├── .claude-plugin/
│   └── marketplace.json
└── skills/
    ├── jarvis-config       → symlink to ~/.claude/jarvis/skills/jarvis-config
    ├── reel-factory/       (real dir, moved)
    └── trend-research/     (real dir, moved)

~/.claude/skills/                           (unchanged except cleanup)
├── agent-reach       → symlink (untouched)
└── firecrawl         → symlink (untouched)
```

After migration:
- **CLI session:** `/jarvis-config`, `/reel-factory`, `/trend-research` work identically.
- **Telegram:** Jarvis can create new skills by writing to `~/jarvis/skills-marketplace/skills/<name>/SKILL.md`.
- **Dashboard:** Skills tab lists all skills as before.

---

## Pre-flight checklist

Before executing:

- [ ] No active Claude Code sessions editing the skills (check Cursor tabs, terminal sessions)
- [ ] Router running normally (`launchctl list | grep com.jarvis.router`)
- [ ] `~/jarvis/skills-marketplace/.claude-plugin/marketplace.json` exists (already created as part of the materials)
- [ ] Backup of current skills: the `mv` is reversible, but peace of mind:
  ```bash
  cp -R ~/.claude/skills ~/.claude/skills.backup-$(date +%Y%m%d)
  ```

---

## Execution — Step by step

### Step 1 — Move real-dir skills into the marketplace

```bash
# reel-factory
mv ~/.claude/skills/reel-factory ~/jarvis/skills-marketplace/skills/reel-factory

# trend-research
mv ~/.claude/skills/trend-research ~/jarvis/skills-marketplace/skills/trend-research
```

**Why `mv` and not `cp`:** mv is atomic on the same filesystem. If the source
is ever referenced by absolute path elsewhere (nothing found in codebase
search), we can re-symlink quickly. No duplicate copies to keep in sync.

### Step 2 — Symlink jarvis-config from the repo into the marketplace

```bash
# The jarvis-config source lives inside the jarvis repo at
# ~/.claude/jarvis/skills/jarvis-config (so it ships with the repo).
# We just expose it through the marketplace by symlinking.
ln -s ~/.claude/jarvis/skills/jarvis-config ~/jarvis/skills-marketplace/skills/jarvis-config
```

**Note:** Claude Code's safetyCheck blocks WRITES to `~/.claude/**` but not
READS (or symlink traversal). The skill is read-only from Jarvis agents (which
is fine — it's shipped with the repo, edited by you via git).

### Step 3 — Remove stale entries in `~/.claude/skills/`

```bash
# Remove the symlink that points to the old jarvis-config location
rm ~/.claude/skills/jarvis-config

# Remove the archived obsolete skill
rm -rf ~/.claude/skills/_archive
```

**After this step:**
```bash
ls -la ~/.claude/skills/
# → only agent-reach + firecrawl symlinks remain
```

### Step 4 — Register the marketplace with Claude Code

```bash
claude plugin marketplace add ~/jarvis/skills-marketplace
claude plugin install jarvis-custom-skills@jarvis-skills
```

**What this writes:**
- `~/.claude/plugins/known_marketplaces.json` → adds `jarvis-skills` entry
  with `"installLocation": "~/jarvis/skills-marketplace"` (reference, no copy)
- `~/.claude/plugins/config.json` (or similar) → enables the plugin

These are Claude Code's own config files; the `plugin` CLI subcommand has the
necessary write access (it's the official tool for this). You run them from
your interactive CLI so they succeed.

### Step 5 — Verify in a fresh session

```bash
# Spawn a throwaway CC session and ask if it sees the skills
echo "List all skills whose name starts with jarvis, reel, or trend. One line each." | \
  claude --print --permission-mode default --model claude-haiku-4-5-20251001

# Expected: sees /jarvis-config, /reel-factory, /trend-research
```

### Step 6 — Update setup.sh for future installs (fresh machines)

See **Appendix A — setup.sh changes** below for the diff.

### Step 7 — Update dashboard API to also scan marketplaces dir

See **Appendix B — dashboard/api.ts changes** below for the diff.

Then rebuild + restart:

```bash
cd ~/.claude/jarvis/router/dashboard && npm run build
launchctl kickstart -k gui/$(id -u)/com.jarvis.router
```

### Step 8 — Test from Telegram

Send to Jarvis: *"Crea una skill chiamata 'hello-world' che stampa ciao."*

**Expected:** Jarvis writes `~/jarvis/skills-marketplace/skills/hello-world/SKILL.md`
without any permission error. Delete it after the test (or keep it as proof).

---

## Rollback plan

If anything goes wrong:

```bash
# Un-install + un-register
claude plugin uninstall jarvis-custom-skills@jarvis-skills
claude plugin marketplace remove jarvis-skills

# Restore skills
mv ~/jarvis/skills-marketplace/skills/reel-factory ~/.claude/skills/reel-factory
mv ~/jarvis/skills-marketplace/skills/trend-research ~/.claude/skills/trend-research
ln -s ~/.claude/jarvis/skills/jarvis-config ~/.claude/skills/jarvis-config

# (If you made the backup) restore _archive too
cp -R ~/.claude/skills.backup-YYYYMMDD/_archive ~/.claude/skills/_archive
```

Router continues to work throughout — skills not being loaded is a silent
no-op, not a crash.

---

## Testing plan

After migration, run these checks:

| Test | How | Expected |
|---|---|---|
| CLI skills listing | `claude` → `/` | `/jarvis-config`, `/reel-factory`, `/trend-research` appear |
| Skill invocation from CLI | `claude` → `/reel-factory` | skill loads its body |
| Dashboard Skills tab | http://localhost:3340 → Skills | all 3 custom + agent-reach + firecrawl listed |
| Dashboard skill edit | Click skill → edit SKILL.md → save | changes persist in marketplace dir |
| Jarvis Telegram: list skills | *"Quali skill hai?"* | mentions the 3 custom ones |
| Jarvis Telegram: create new skill | *"Crea skill test-xyz"* | SKILL.md appears in marketplace |
| Jarvis Telegram: next session sees new skill | wait 60s, ask about test-xyz | recognizes it |
| Skill with dependencies | Invoke reel-factory | ffmpeg/ElevenLabs paths still resolve |

---

## Appendix A — setup.sh changes

Replace the **current block** (setup.sh, lines 184–199):

```bash
# --- 6. Install the jarvis-config skill -------------------------------------
step "Installing jarvis-config skill"
SKILL_SRC="$REPO_ROOT/skills/jarvis-config"
SKILL_DST="$HOME/.claude/skills/jarvis-config"
if [ -d "$SKILL_SRC" ]; then
  mkdir -p "$HOME/.claude/skills"
  if [ -L "$SKILL_DST" ] || [ -d "$SKILL_DST" ]; then
    skip "~/.claude/skills/jarvis-config already present"
  else
    ln -s "$SKILL_SRC" "$SKILL_DST"
    ok "linked skill → ~/.claude/skills/jarvis-config"
    info "use from any Claude Code session with /jarvis-config"
  fi
else
  warn "skill source missing at $SKILL_SRC"
fi
```

With the **new block**:

```bash
# --- 6. Install the Jarvis skills marketplace -------------------------------
# Jarvis custom skills live in ~/jarvis/skills-marketplace/ (outside ~/.claude/
# so agents can create new skills from Telegram/WhatsApp/Discord without
# hitting Claude Code's safetyCheck on ~/.claude/**).
step "Registering Jarvis skills marketplace"
MP_DIR="$HOME/jarvis/skills-marketplace"
MP_MANIFEST="$MP_DIR/.claude-plugin/marketplace.json"

# Scaffold marketplace if missing
if [ ! -f "$MP_MANIFEST" ]; then
  mkdir -p "$MP_DIR/.claude-plugin" "$MP_DIR/skills"
  # Copy the manifest template from the repo
  if [ -f "$REPO_ROOT/skills-marketplace.template/marketplace.json" ]; then
    cp "$REPO_ROOT/skills-marketplace.template/marketplace.json" "$MP_MANIFEST"
    ok "scaffolded $MP_DIR"
  else
    warn "marketplace template missing at skills-marketplace.template/; skipping"
  fi
fi

# Symlink the repo-shipped jarvis-config into the marketplace
SKILL_SRC="$REPO_ROOT/skills/jarvis-config"
SKILL_DST="$MP_DIR/skills/jarvis-config"
if [ -d "$SKILL_SRC" ] && [ ! -e "$SKILL_DST" ]; then
  ln -s "$SKILL_SRC" "$SKILL_DST"
  ok "linked jarvis-config into marketplace"
fi

# Register marketplace with Claude Code (idempotent — CLI handles re-add)
if command -v claude >/dev/null 2>&1 && [ -f "$MP_MANIFEST" ]; then
  if ! claude plugin marketplace list 2>/dev/null | grep -q "^jarvis-skills\b"; then
    claude plugin marketplace add "$MP_DIR" >/dev/null 2>&1 \
      && ok "marketplace registered" \
      || warn "could not register marketplace (do manually: claude plugin marketplace add $MP_DIR)"
  else
    skip "marketplace already registered"
  fi

  if ! claude plugin list 2>/dev/null | grep -q "jarvis-custom-skills"; then
    claude plugin install jarvis-custom-skills@jarvis-skills >/dev/null 2>&1 \
      && ok "plugin installed" \
      || warn "could not install plugin (do manually: claude plugin install jarvis-custom-skills@jarvis-skills)"
  else
    skip "plugin already installed"
  fi
else
  info "skill marketplace scaffolded at $MP_DIR (install claude CLI to register)"
fi
```

And ship a template at `skills-marketplace.template/marketplace.json` in the
repo (identical to the one at `~/jarvis/skills-marketplace/.claude-plugin/marketplace.json`).

---

## Appendix B — dashboard/api.ts changes

The Skills tab on the dashboard currently scans:
- `~/.claude/` (flat legacy layout)
- `~/.claude/skills/` (canonical user scope)
- `~/.claude/plugins/marketplaces/*/plugins/*/skills/*` (GitHub marketplaces)

It does **not** scan local-path marketplaces registered via
`claude plugin marketplace add <local-path>`. We need to read
`~/.claude/plugins/known_marketplaces.json` and add any local-path
`installLocation` to the scan list.

### Current code — `router/src/dashboard/api.ts` around line 333

```ts
scanSkillsIn(claudeDir);
scanSkillsIn(join(claudeDir, "skills"));

// Plugin skills (SKILL.md in ~/.claude/plugins/marketplaces/*/plugins/*/skills/*)
const pluginSkills: any[] = [];
// ... existing marketplaces-dir scan ...
```

### Proposed change

Add, after the existing `scanSkillsIn(join(claudeDir, "skills"))` call:

```ts
// Local-path marketplaces (registered via `claude plugin marketplace add <path>`)
// store their installLocation in known_marketplaces.json and never copy to
// ~/.claude/plugins/marketplaces/, so the scan above misses them.
try {
  const kmPath = join(claudeDir, "plugins", "known_marketplaces.json");
  if (existsSync(kmPath)) {
    const km = JSON.parse(readFileSync(kmPath, "utf-8"));
    for (const entry of Object.values(km) as any[]) {
      const src = entry?.source;
      const loc = entry?.installLocation;
      if (src?.source === "directory" && typeof loc === "string" && existsSync(loc)) {
        // Marketplace layout: <loc>/skills/<name>/SKILL.md
        scanSkillsIn(join(loc, "skills"));
      }
    }
  }
} catch (e) {
  // non-fatal — skills list will just miss local marketplaces
}
```

Paste this immediately after line 334 (`scanSkillsIn(join(claudeDir, "skills"));`).

Then in the edit/content handler (around line 377–398), add a fallback that
resolves paths via the same `known_marketplaces.json` lookup so PUT requests
for skill content reach the right file in the local marketplace.

---

## Open decisions

1. **Third-party symlinks (`agent-reach`, `firecrawl`)** — leave as-is in
   `~/.claude/skills/`? **Yes** (they're maintained by `~/.agents/skills/`,
   not ours).

2. **Backwards-compat symlinks** from old paths to new? **No.** If we leave
   `~/.claude/skills/reel-factory` as a symlink to the marketplace, the
   dashboard would double-count, and the safetyCheck would still prevent
   writes through that path anyway. Clean break.

3. **Delete `_archive`?** **Yes** — it's obsolete and dormant.

4. **Rename the plugin?** Currently `jarvis-custom-skills@jarvis-skills`.
   The double-name is redundant but required by the marketplace schema
   (marketplace name + plugin name). Acceptable.

5. **Also migrate memory?** **Not now.** Memory writes currently happen via
   hooks (omega), which bypass the safetyCheck because they run outside the
   agent tool system. Migration would be a separate, larger project.
