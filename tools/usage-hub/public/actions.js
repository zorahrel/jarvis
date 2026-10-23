// Cosa chiama ogni pulsante di scrittura della dashboard. Funzione pura: la usano la pagina e il test (con fetch finto).
// ctx = { value, checked, own, apiPriority } letti dall'elemento; ritorna null se l'azione non va inviata.
(function (root) {
  function actionRequest(act, d, ctx = {}) {
    const n = d.n;
    switch (act) {
      case 'prio': return { path: '/api/priority', body: { name: n, priority: Number(d.v) }, msg: 'Priorità aggiornata' };
      case 'switch': return { path: '/api/switch', body: { name: n }, msg: 'Account cambiato' };
      case 'refresh': return { path: '/api/refresh', body: { name: n }, msg: 'Token aggiornato' };
      case 'remove': return { path: '/api/remove', body: { name: n }, msg: 'Account rimosso' };
      case 'apiprio': return { path: '/api/api-profiles', method: 'PATCH', body: { name: n, priority: Number(ctx.apiPriority) }, msg: 'Priorità salvata' };
      case 'apidis': return { path: '/api/api-profiles', method: 'PATCH', body: { name: n, disabled: d.v === '1' }, msg: 'Aggiornato' };
      case 'enabled': return { path: '/api/account-enabled', body: { name: n, enabled: !!ctx.checked }, msg: ctx.checked ? 'Account acceso' : 'Account spento' };
      case 'cap': return { path: '/api/account-cap', body: d.own === '1' ? { name: n, fiveH: null, sevenD: null } : { name: n, fiveH: 75, sevenD: 75 }, msg: 'Tetto aggiornato' };
      case 'capv': {
        const v = ctx.value === '' || ctx.value == null ? null : Math.round(Number(ctx.value));
        if (v !== null && (!Number.isFinite(v) || v < 1 || v > 99)) return { error: 'Il tetto va da 1 a 99%' };
        return { path: '/api/account-cap', body: { name: n, [d.w]: v }, msg: 'Tetto salvato' };
      }
      default: return null;
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { actionRequest };
  else root.actionRequest = actionRequest;
})(typeof globalThis !== 'undefined' ? globalThis : this);
