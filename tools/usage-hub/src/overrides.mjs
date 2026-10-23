// Override a tempo del freno di pacing: lo dà Attilio (o chi per lui, con --by) e scade da solo.
// Toglie solo il freno di ritmo e di giorno; quota esaurita, finestra 5h e riserva restano.
// Non va in state.json: quello è una mappa chiave → timestamp dei cooldown degli avvisi.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const overridesFile = () => process.env.USAGE_HUB_OVERRIDES || path.join(os.homedir(), '.local', 'state', 'usage-hub', 'overrides.json');

export function loadOverrides(file = overridesFile()) {
  try { const list = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(list) ? list : []; } catch { return []; }
}

function save(list, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(list, null, 2)}\n`);
}

export const activeOverrides = (list, now = Date.now()) => list.filter((o) => o.until > now);

// Un override per provider e classe: darne un altro sullo stesso ambito sostituisce il vecchio.
export function addOverride({ provider, hours = 12, cls = null, by, reason }, { now = Date.now(), file = overridesFile() } = {}) {
  if (!provider || !by || !reason) throw new Error('allow: servono provider, --by e --reason');
  const o = { provider, class: cls, by, reason, since: now, until: now + hours * 3600000 };
  save(activeOverrides(loadOverrides(file), now).filter((x) => !(x.provider === provider && x.class === cls)).concat(o), file);
  return o;
}

// L'opposto di un override: niente lavori nuovi in background (massivo e batch) fino a `until`. Quelli già partiti
// li gestisce la pausa automatica, coi suoi limiti provati; questo li ferma prima che partano, senza segnali a nessuno.
export function addHold({ hours = 1, by, reason }, { now = Date.now(), file = overridesFile() } = {}) {
  if (!by || !reason) throw new Error('hold: servono by e reason');
  const o = { provider: '*', hold: true, class: null, by, reason, since: now, until: now + hours * 3600000 };
  save(activeOverrides(loadOverrides(file), now).filter((x) => !x.hold).concat(o), file);
  return o;
}
export function revokeHold({ now = Date.now(), file = overridesFile() } = {}) {
  const list = activeOverrides(loadOverrides(file), now);
  const kept = list.filter((o) => !o.hold);
  save(kept, file);
  return list.length - kept.length;
}

export function revokeOverride(provider, { now = Date.now(), file = overridesFile() } = {}) {
  const list = activeOverrides(loadOverrides(file), now);
  const kept = list.filter((o) => o.provider !== provider || o.hold);
  save(kept, file);
  return list.length - kept.length;
}
