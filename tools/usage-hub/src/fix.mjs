// «Risolvi tu»: da una voce dell'hub al compito per un agente, con tutto il contesto che serve per non ricostruirlo.
// Il lavoro passa dalla coda, quindi rispetta freno e ritmo come ogni altra delega.
import os from 'node:os';
import path from 'node:path';

const SYS = { openclaw: 'OpenClaw (cron)', launchd: 'launchd sul Mac', desktop: 'Claude desktop (task pianificato)', lobster: 'Lobster (workflow OpenClaw)', github: 'GitHub Actions', pc: 'il PC di casa', health: 'il doctor di OpenClaw' };
const WHERE = {
  openclaw: '~/.openclaw (cron: `openclaw cron list`, prompt in ~/.openclaw/prompts)',
  lobster: '~/.openclaw (workflow Lobster)',
  launchd: '~/Library/LaunchAgents e gli script in ~/.claude/jarvis/scripts',
  desktop: 'i task pianificati di Claude desktop',
  github: 'il file del workflow nel repo GitHub indicato dalla chiave',
  pc: 'il PC di casa (vedi ~/.claude/jarvis/memory/tools/pc-offload.md)',
};
const HUB = 'http://127.0.0.1:3360';

export function fixTask(card) {
  const c = card || {};
  const tech = c.tech || {};
  const last = c.last || {};
  const lines = [
    `Automazione «${c.title || c.key}» (chiave ${c.key}), eseguita da ${SYS[c.provider] || c.provider || 'sistema ignoto'}.`,
    c.reason ? `Stato: ${c.level === 'rotto' ? 'rotta' : c.level === 'te' ? 'segnalata' : c.level} — ${c.reason}.` : '',
    c.purpose && c.purpose.cosaFaPerTe ? `Cosa fa per Attilio: ${c.purpose.cosaFaPerTe}` : c.cosa ? `Cosa fa: ${c.cosa}` : '',
    c.purpose && c.purpose.seSiRompe ? `Se resta rotta: ${c.purpose.seSiRompe}` : '',
    last.at ? `Ultimo giro: ${new Date(last.at).toISOString()}, esito ${last.outcome || 'ignoto'}${last.error ? `, errore: ${String(last.error).slice(0, 600)}` : ''}.` : '',
    tech.schedule ? `Orario: ${tech.schedule}.` : '',
    tech.command ? `Comando: ${String(tech.command).slice(0, 400)}` : '',
    tech.prompt ? `Prompt: ${String(tech.prompt).slice(0, 400)}` : '',
    tech.url && c.provider === 'github' ? `Giro su GitHub: ${tech.url}` : '',
    `\nCompito: trova la causa e sistemala con la modifica più piccola che basta, dove l'automazione è definita: ${WHERE[c.provider] || 'cerca dove è definita partendo dalla chiave'}. Prova che funziona (un giro a mano se costa poco, o il comando che lo verifica). Non toccare altro.`,
    `Se per chiudere serve una decisione di Attilio (spesa, qualcosa che va in pubblico, un passo irreversibile, dati di persone vere), non prenderla: aprila in «Ti aspetta» con curl -s -X POST ${HUB}/api/attesa -H 'content-type: application/json' -d '{"tipo":"decisione","title":"<la domanda in una riga>","why":"<perché serve lui>","from":"Risolvi tu"}' e fermati.`,
    `Alla fine registra l'esito: curl -s -X POST ${HUB}/api/feedback -H 'content-type: application/json' -d '{"kind":"fix","key":"${c.key}","why":"<cosa hai cambiato e la prova>"}'.`,
  ];
  const dir = c.provider === 'openclaw' || c.provider === 'lobster' || c.provider === 'health' ? path.join(os.homedir(), '.openclaw') : path.join(os.homedir(), '.claude', 'jarvis');
  return { task: lines.filter(Boolean).join('\n'), dir, project: 'automazioni', ref: c.key };
}
