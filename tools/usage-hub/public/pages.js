// Pagine nuove nel browser: rete ed eventi di Diario, Contesto e «Ti aspetta». L'HTML lo fa pages-view.js.
// Si carica prima di app.js: qui solo dichiarazioni e listener, `j` e `$` di app.js si usano a pagina già pronta.
var hubCfg = null;
function hubConfig() {
  if (hubCfg) return Promise.resolve(hubCfg);
  return fetch('/api/hub-config').then(function (r) { return r.json(); }).catch(function () { return {}; }).then(function (c) { hubCfg = c || {}; return hubCfg; });
}

// In demo una fascia fissa su ogni vista: chi guarda una prova non deve scambiare voci, automazioni e diario per veri.
hubConfig().then(function (c) {
  if (!c || !c.demo || document.querySelector('.demo-band')) return;
  var b = document.createElement('div');
  b.className = 'demo-band'; b.setAttribute('role', 'note');
  b.textContent = 'ESEMPIO: questa è la demo dell\'hub, voci e numeri sono di prova';
  document.body.prepend(b);
});

// ---- Ti aspetta (in cima alla Panoramica) ----
async function attesaSection() {
  var res = await Promise.all([j('/api/attesa'), hubConfig()]);
  var data = res[0];
  var n = data && data.items ? data.items.length : 0;
  $('nwait').hidden = !n;
  $('nwait').textContent = n;
  return PagesView.attesaHtml(data, res[1], Date.now());
}
document.getElementById('t-overview').addEventListener('click', function (e) {
  var b = e.target.closest('[data-wait-done]');
  if (!b) return;
  b.disabled = true;
  fetch('/api/attesa', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'chiudi', ref: b.dataset.waitDone, by: 'dashboard' }) })
    .then(function (r) { return r.json(); }).catch(function () { return null; })
    .then(function (r) {
      toast(r && r.ok ? 'Fatto: tolta da «Ti aspetta»' : 'Non salvato: ' + ((r && r.error) || 'hub non raggiungibile'));
      attesaSection().then(function (h) { var s = $('t-overview').querySelector('[data-sec=wait]'); if (s) s.outerHTML = h; });
    });
});

// ---- Diario ----
var jData = null;
var jUi = { f: 'all', q: '' };
function jDraw() {
  var a = document.activeElement, pos = a && a.matches && a.matches('input[data-j-q]') ? a.selectionStart : null;
  $('t-journal').innerHTML = PagesView.journalHtml(jData, jUi, Date.now());
  if (pos !== null) { var q = $('t-journal').querySelector('input[data-j-q]'); q.focus(); q.setSelectionRange(pos, pos); }
}
async function renderJournal() {
  if (!jData) $('t-journal').innerHTML = '<div class="au-skl" style="height:220px;border-radius:10px"></div>';
  var d = await j('/api/diario?days=7');
  if (d || !jData) jData = d;
  jDraw();
  if (jData && cur === 'journal') $('sub').textContent = (jData.items || []).length + ' eventi, aggiornato alle ' + hhmm(Date.now());
}
document.getElementById('t-journal').addEventListener('click', function (e) {
  var f = e.target.closest('[data-j-f]');
  if (f) { jUi.f = f.dataset.jF; jDraw(); return; }
  if (e.target.closest('[data-j-clear]')) { jUi = { f: 'all', q: '' }; jDraw(); }
});
document.getElementById('t-journal').addEventListener('input', function (e) {
  if (!e.target.matches('input[data-j-q]')) return;
  jUi.q = e.target.value;
  jDraw();
});

// ---- Contesto ----
var ctxData = null;
async function renderContext() {
  if (!ctxData) $('t-context').innerHTML = '<div class="au-skl" style="height:260px;border-radius:10px"></div>';
  var d = await j('/api/contesto');
  if (d || !ctxData) ctxData = d;
  $('t-context').innerHTML = PagesView.contextHtml(ctxData);
  // Il doctor gira dietro: finché non ha finito si richiede la pagina ogni 8 s, solo se resti qui.
  if (ctxData && ctxData.doctor && ctxData.doctor.pending) setTimeout(function () { if (cur === 'context') renderContext(); }, 8000);
  if (ctxData && cur === 'context') $('sub').textContent = (ctxData.files || []).length + ' file, letto alle ' + hhmm(ctxData.at);
}
document.getElementById('t-context').addEventListener('click', function (e) {
  var b = e.target.closest('[data-ctx-check]');
  if (!b) return;
  b.disabled = true;
  fetch('/api/contesto/check', { method: 'POST' }).then(function (r) { return r.json(); }).catch(function () { return null; }).then(function (r) {
    toast(r && r.ok ? 'Un agente sta leggendo i file: il risultato arriva qui tra qualche minuto' : 'Non partito: ' + ((r && r.error) || 'hub non raggiungibile'));
    renderContext();
  });
});
