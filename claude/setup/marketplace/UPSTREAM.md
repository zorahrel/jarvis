# Upstream — push to `zorahrel/jarvis-claudecode`

Repo-level changes that make the marketplace architecture available to all
Jarvis users. Strictly separate from the local migration (see `LOCAL.md`):
this plan does **not move any of your skills**. It only ships the
infrastructure and migration script so other users can upgrade cleanly.

---

## Scope split

|                                    | Local (`LOCAL.md` + `migrate-local.sh`)      | Upstream (this doc + `upstream/`)               |
|------------------------------------|----------------------------------------------|--------------------------------------------------|
| Moves `reel-factory`, `trend-research` | ✅ your machine only                         | ❌ never — those are your personal skills        |
| Modifies `~/.claude/skills/` symlinks | ✅ your machine only                         | ❌                                               |
| Registers marketplace with CC CLI  | ✅ your machine only                         | ❌ (done by each user's `setup.sh` / migration)  |
| Ships `marketplace.json` template   | ❌                                           | ✅ `skills-marketplace.template/`                |
| Ships migration script              | ❌                                           | ✅ `scripts/migrate-to-marketplace.sh`           |
| Updates `setup.sh`                  | ❌                                           | ✅ fresh-install path uses marketplace           |
| Updates `router/src/dashboard/api.ts` | ❌                                         | ✅ dashboard scans local marketplaces            |
| Updates docs + adds `CHANGELOG.md`  | ❌                                           | ✅                                               |

---

## Order of operations

1. **Execute `LOCAL.md`** on your machine first. Confirm everything works end to
   end — skills list in CLI, dashboard, skill creation from Telegram.
2. Only then, apply the upstream changes to the repo and push.
3. The upstream PR **ships only the architecture** — never your personal skill
   contents.

---

## Files to add to the repo

All ready-to-copy under `~/jarvis/skills-marketplace/upstream/`:

```
upstream/
├── CHANGELOG.md                              → repo root (NEW FILE)
├── scripts/
│   └── migrate-to-marketplace.sh             → repo: scripts/migrate-to-marketplace.sh (NEW)
└── skills-marketplace.template/
    ├── .claude-plugin/
    │   └── marketplace.json                  → repo: skills-marketplace.template/... (NEW)
    └── README.md                             → repo: skills-marketplace.template/README.md (NEW)
```

Copy these into the repo tree unchanged:

```bash
cd ~/.claude/jarvis
cp ~/jarvis/skills-marketplace/upstream/CHANGELOG.md ./CHANGELOG.md
mkdir -p scripts skills-marketplace.template/.claude-plugin
cp ~/jarvis/skills-marketplace/upstream/scripts/migrate-to-marketplace.sh ./scripts/
cp ~/jarvis/skills-marketplace/upstream/skills-marketplace.template/.claude-plugin/marketplace.json ./skills-marketplace.template/.claude-plugin/
cp ~/jarvis/skills-marketplace/upstream/skills-marketplace.template/README.md ./skills-marketplace.template/
chmod +x ./scripts/migrate-to-marketplace.sh
```

---

## Files to modify in the repo

### 1. `setup.sh`

Replace the **Install jarvis-config skill** block (currently lines 184–199):

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

With:

```bash
# --- 6. Install the Jarvis skills marketplace -------------------------------
# Skills live in ~/jarvis/skills-marketplace/ (outside ~/.claude/) so Jarvis
# agents running from remote channels can write new skills without hitting
# Claude Code's safetyCheck on ~/.claude/**.
step "Setting up Jarvis skills marketplace"
MP_DIR="$HOME/jarvis/skills-marketplace"
MP_MANIFEST="$MP_DIR/.claude-plugin/marketplace.json"
TEMPLATE="$REPO_ROOT/skills-marketplace.template"

# Detect pre-1.1 install (symlink at ~/.claude/skills/jarvis-config) and
# delegate to the migration script.
if [ -L "$HOME/.claude/skills/jarvis-config" ] || [ -d "$HOME/.claude/skills/reel-factory" ] 2>/dev/null; then
  warn "pre-marketplace skill layout detected"
  info "run:  bash scripts/migrate-to-marketplace.sh"
  info "(or re-run setup.sh after migration)"
else
  if [ ! -f "$MP_MANIFEST" ] && [ -d "$TEMPLATE" ]; then
    mkdir -p "$MP_DIR"
    cp -R "$TEMPLATE/." "$MP_DIR/"
    ok "scaffolded $MP_DIR"
  fi

  # Symlink the repo-shipped jarvis-config into the marketplace (read-only
  # reference — edited via git PRs, not from agents).
  SKILL_SRC="$REPO_ROOT/skills/jarvis-config"
  SKILL_LINK="$MP_DIR/skills/jarvis-config"
  if [ -d "$SKILL_SRC" ] && [ ! -e "$SKILL_LINK" ]; then
    mkdir -p "$MP_DIR/skills"
    ln -s "$SKILL_SRC" "$SKILL_LINK"
    ok "linked jarvis-config into marketplace"
  fi

  if command -v claude >/dev/null 2>&1 && [ -f "$MP_MANIFEST" ]; then
    if ! claude plugin marketplace list 2>/dev/null | grep -q "^jarvis-skills\b"; then
      claude plugin marketplace add "$MP_DIR" >/dev/null 2>&1 \
        && ok "marketplace registered" \
        || warn "marketplace registration failed (run manually: claude plugin marketplace add $MP_DIR)"
    else
      skip "marketplace already registered"
    fi

    if ! claude plugin list 2>/dev/null | grep -q "jarvis-custom-skills"; then
      claude plugin install jarvis-custom-skills@jarvis-skills >/dev/null 2>&1 \
        && ok "plugin installed" \
        || warn "plugin install failed (run manually: claude plugin install jarvis-custom-skills@jarvis-skills)"
    else
      skip "plugin already installed"
    fi
  else
    info "skill marketplace scaffolded at $MP_DIR (install claude CLI to register)"
  fi
fi
```

### 2. `router/src/dashboard/api.ts`

The Skills tab currently scans `~/.claude/skills/` and
`~/.claude/plugins/marketplaces/*/plugins/*/skills/*`. Local-path marketplaces
(our case) store their `installLocation` in `known_marketplaces.json` without
copying anything to `~/.claude/plugins/marketplaces/`, so the existing scan
misses them.

Find this line (around 334):

```ts
scanSkillsIn(claudeDir);
scanSkillsIn(join(claudeDir, "skills"));
```

Add the following block **immediately after**:

```ts
// Local-path marketplaces registered via `claude plugin marketplace add <path>`:
// their installLocation in known_marketplaces.json points at an external dir,
// never copied to ~/.claude/plugins/marketplaces/. Scan them too.
try {
  const kmPath = join(claudeDir, "plugins", "known_marketplaces.json");
  if (existsSync(kmPath)) {
    const km = JSON.parse(readFileSync(kmPath, "utf-8"));
    for (const entry of Object.values(km) as any[]) {
      const src = entry?.source;
      const loc = entry?.installLocation;
      if (src?.source === "directory" && typeof loc === "string" && existsSync(loc)) {
        scanSkillsIn(join(loc, "skills"));
      }
    }
  }
} catch {
  // non-fatal — list just misses local-path marketplaces
}
```

Then in the skill content GET/PUT handlers (around line 377–398), ensure the
path resolution also tries each local marketplace's `installLocation` so the
Skills tab can still edit SKILL.md files in the new location.

### 3. `README.md`

Search for the block describing `jarvis-config`:

> The repo ships a Claude Code skill, `jarvis-config`, that edits `config.yaml`,
> scaffolds agents, and wires channels for you. `./setup.sh` symlinks it into
> `~/.claude/skills/`…

Replace with:

> The repo ships a Claude Code skill, `jarvis-config`, that edits `config.yaml`,
> scaffolds agents, and wires channels for you. `./setup.sh` installs it via
> the Jarvis skills marketplace at `~/jarvis/skills-marketplace/`, which Claude
> Code loads automatically in every session (CLI, router-spawned agents, and
> any remote channel). Invoke with `/jarvis-config`.
>
> Custom skills added by Jarvis agents (from Telegram/WhatsApp/Discord) also
> land in the marketplace. Existing users can migrate their old
> `~/.claude/skills/` layout with `bash scripts/migrate-to-marketplace.sh`.

### 4. `ARCHITECTURE.md`

Add a new section after the `Spawn discipline` block:

```markdown
### Skills loading

Jarvis custom skills live in `~/jarvis/skills-marketplace/`, registered with
Claude Code as a local-path plugin marketplace (`claude plugin marketplace
add ~/jarvis/skills-marketplace`). This path is deliberately **outside
`~/.claude/`** because Claude Code 2.1.x blocks all writes to `~/.claude/**`
via a hard-coded `safetyCheck` that no permission flag bypasses.

By moving skills outside the protected zone:

- Jarvis agents running from remote channels (Telegram, WhatsApp, Discord)
  can `Write` new skills directly — no user approval prompt needed.
- Claude Code still discovers and loads them via its native marketplace
  mechanism, so the CLI experience is identical to skills living in
  `~/.claude/skills/`.
- The dashboard Skills tab reads `~/.claude/plugins/known_marketplaces.json`
  and scans each local-path marketplace's `installLocation`.

Third-party skills (`agent-reach`, `firecrawl`, etc.) remain as symlinks in
`~/.claude/skills/` since their source of truth (`~/.agents/skills/`) is
maintained outside of Jarvis.
```

---

## Pre-push verification

From `~/.claude/jarvis/`:

```bash
# TypeScript compiles
( cd router && npx tsc --noEmit )

# Dashboard builds
( cd router/dashboard && npm run build )

# Migration script passes shellcheck (optional but nice)
shellcheck scripts/migrate-to-marketplace.sh || true

# setup.sh still passes its own checks
bash -n setup.sh

# Migration script dry-run produces reasonable output
bash scripts/migrate-to-marketplace.sh --dry-run
```

---

## Push procedure

1. Create a branch:
   ```bash
   cd ~/.claude/jarvis
   git checkout -b feat/skills-marketplace
   ```

2. Apply the changes above (copy upstream files, patch `setup.sh`, patch
   `dashboard/api.ts`, patch `README.md` and `ARCHITECTURE.md`, add
   `CHANGELOG.md`).

3. Run pre-push verification (above).

4. Commit in logical chunks:
   ```bash
   git add CHANGELOG.md skills-marketplace.template/ scripts/migrate-to-marketplace.sh
   git commit -m "feat(skills): add marketplace architecture and migration script"

   git add setup.sh
   git commit -m "feat(setup): install jarvis-config via skills marketplace"

   git add router/src/dashboard/api.ts
   git commit -m "feat(dashboard): scan local-path plugin marketplaces"

   git add README.md ARCHITECTURE.md
   git commit -m "docs: describe skills marketplace architecture"
   ```

5. Push + open PR against `zorahrel/jarvis-claudecode:main`:
   ```bash
   git push -u origin feat/skills-marketplace
   gh pr create --title "feat: skills marketplace (fixes ~/.claude/** write block)" \
     --body "$(cat CHANGELOG.md | sed -n '/^## \[Unreleased\]/,/^## /p' | sed '$d')"
   ```

---

## Post-push

Once merged, on **every other machine** where you (or anyone) has Jarvis
installed:

```bash
cd path/to/jarvis
git pull
bash scripts/migrate-to-marketplace.sh --dry-run
bash scripts/migrate-to-marketplace.sh
launchctl kickstart -k gui/$(id -u)/com.jarvis.router   # macOS
# systemctl --user restart jarvis-router               # Linux
```

Fresh installs (new users running `./setup.sh` for the first time) get the
new architecture automatically — no migration needed.

---

## Decisions that still need your OK before push

1. **CHANGELOG version number.** Right now it's `[Unreleased]`. Should this
   ship as `1.1.0` (SemVer minor — new feature, backwards compatible)?
2. **PR title / description wording.** Draft provided above, adjust to taste.
3. **Keep `CHANGELOG.md` at repo root, or under `docs/`?** Root is the common
   convention.
4. **Separate PR or bundled?** Current plan is one PR with 4 commits. If
   you'd rather split (e.g., "migration infrastructure" then "dashboard"
   then "docs"), logical breakdown is easy.
