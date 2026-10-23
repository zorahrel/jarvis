// The shell scripts must be checked out with LF endings, on every platform.
//
// This is not a style rule. Git for Windows defaults to core.autocrlf=true, so
// a plain clone there rewrites `vdm` with CRLF, and a shebang line ending in CR
// makes the kernel look for an interpreter called "bash\r". The error names a
// file that plainly exists, which is why it costs so much time to diagnose.
//
// .gitattributes is what prevents it. This test is what notices if that file is
// ever dropped or narrowed — a check that costs a millisecond and replaces an
// hour of confusion on someone else's machine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Everything an interpreter reads. install.ps1 is deliberately absent: it is
// read by PowerShell, which does not care, and .gitattributes gives it CRLF so
// that Notepad renders it as more than one line.
const MUST_BE_LF = ['vdm', 'install.sh', 'uninstall.sh', 'install-hooks.sh'];

for (const file of MUST_BE_LF) {
  test(`${file} has no CR bytes`, () => {
    const raw = readFileSync(join(root, file));
    const cr = raw.indexOf(0x0d);
    assert.equal(cr, -1,
      `${file} contains a CR at byte ${cr}. A shebang ending in CR makes execve ` +
      `look for "bash\\r" and report that a file which exists cannot be found.`);
  });
}

test('.gitattributes pins line endings so a Windows clone cannot rewrite them', () => {
  const attrs = readFileSync(join(root, '.gitattributes'), 'utf8');
  assert.match(attrs, /^\*\s+text=auto\s+eol=lf$/m,
    '.gitattributes must force LF for all text files, or Git for Windows will ' +
    'convert the shell scripts on checkout and nothing here will run.');
});

test('the JS sources are LF too, so source-slicing tests keep matching', () => {
  // Several tests lift functions out of dashboard.mjs by slicing on "\n}\n".
  // They now normalise on read, but the checked-in files should not need it.
  for (const f of readdirSync(root).filter(f => f.endsWith('.mjs'))) {
    const raw = readFileSync(join(root, f));
    assert.equal(raw.indexOf(0x0d), -1, `${f} contains CR bytes`);
  }
});

// ── No personal data in a public repository ──
//
// The patch notes and several test fixtures grew out of real incidents, so they
// naturally quoted real account addresses and real home directories. That is
// fine in a private checkout and not fine here. This catches the next one at
// commit time instead of after it is public and permanent in the git history.

test('no real email addresses or personal home paths are committed', () => {
  // Only what git actually tracks. A local activity-log.json is full of real
  // addresses by design — it is this machine's runtime data, it is gitignored,
  // and flagging it would train the reader to ignore this test.
  let tracked;
  try {
    tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
      .split('\n').map(f => f.trim()).filter(Boolean);
  } catch {
    return; // not a git checkout (a tarball, say): nothing to police
  }

  // Any address that is not on an example domain, and any absolute home path
  // naming a specific person rather than the placeholder user.
  const EMAIL = /[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net)\b)(?!company\.com\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  // At least two characters and not a placeholder: "/Users/..." inside a
  // comment explaining a Windows path is not personal data, and flagging it
  // would teach the reader that this test cries wolf.
  const PLACEHOLDER = /^(?:dev|user|username|you|me|name|someone|\.\.\.)$/i;
  const HOME  = /(?:\/Users\/|\/home\/|C:\\Users\\)([A-Za-z][A-Za-z0-9._-]+)/g;

  const offences = [];
  for (const name of tracked) {
    if (!/\.(mjs|js|md|sh|ps1|json|yml)$/.test(name) && name !== 'vdm') continue;
    let text;
    try { text = readFileSync(join(root, name), 'utf8'); } catch { continue; }
    for (const re of [EMAIL, HOME]) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) {
        const before = text.slice(Math.max(0, m.index - 12), m.index);
        if (/https?:\/\/\S*$/.test(before)) continue;      // a project URL, not a person
        if (m[1] && PLACEHOLDER.test(m[1])) continue;       // /Users/dev and friends
        offences.push(`${name}: ${m[0]}`);
      }
    }
  }
  assert.deepEqual(offences, [],
    `personal data in a public repo:\n  ${offences.join('\n  ')}\n` +
    'Use account-a@example.com / /Users/dev style placeholders instead.');
});
