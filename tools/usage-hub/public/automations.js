// Scheda «Automazioni»: rete, eventi, tastiera. Gira nel browser (usa j e $ di app.js).
// Stato tenuto qui: modello, ripasso, «da ieri» e costi già chiesti.
var auModel = null;
var auUi = { review: { open: false, key: null }, seen: { newKeys: [], changedKeys: [] }, costs: {}, filter: 'all', q: '', by: 'sistema', offline: false, sel: null, open: {} };
try { if (localStorage.getItem('automations.by') === 'esito') auUi.by = 'esito'; } catch (e) { /* senza storage resta «per sistema» */ }
var auUndoRef = null;

// Oggi in ora di Roma, «YYYY-MM-DD»: la base del confronto «da ieri».
function auToday() {
  var p = {};
  var f = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', year: 'numeric' });
  for (const x of f.formatToParts(new Date())) p[x.type] = x.value;
  return p.year + '-' + p.month + '-' + p.day;
}

function auUiNow() {
  return { now: auModel.checkedAt, review: auUi.review, seen: auUi.seen, costs: auUi.costs, filter: auUi.filter, q: auUi.q, by: auUi.by, offline: auUi.offline, sel: auUi.sel, open: auUi.open };
}

// Ridisegna tenendo il fuoco sulla stessa card: con la tastiera non si perde il posto a ogni salvataggio o giro dei 60 s.
function auRender() {
  if (!auModel) return;
  var a = document.activeElement;
  var art = a && a.closest ? a.closest('#t-automations article.au-card') : null;
  // La ricerca ridisegna a ogni tasto: il campo si rimette a fuoco con il cursore dov'era.
  var typing = a && a.matches && a.matches('input[data-au-q]') ? a.selectionStart : null;
  var rowKey = a && a.dataset && a.dataset.cx ? a.dataset.cx : null;
  var areaKey = a && a.dataset && a.dataset.auArea ? a.dataset.auArea : null;
  $('t-automations').innerHTML = AutomationsView.render(auModel, auUiNow());
  if (typing !== null) {
    var q = $('t-automations').querySelector('input[data-au-q]');
    if (q) { q.focus(); q.setSelectionRange(typing, typing); }
  }
  if (art) auFocusCard(art.dataset.key);
  else if (rowKey) { var r = $('t-automations').querySelector('[data-cx="' + CSS.escape(rowKey) + '"]'); if (r) r.focus(); }
  else if (areaKey) { var g = $('t-automations').querySelector('[data-au-area="' + CSS.escape(areaKey) + '"]'); if (g) g.focus(); }
}

// Pannello di dettaglio: si apre su una riga, si chiude con ✕, Esc o clic fuori. Il fuoco torna alla riga.
function auOpen(key) {
  auUi.sel = key;
  auRender();
  var p = $('t-automations').querySelector('.cx-panel');
  if (p) { var first = p.querySelector('article.au-card') || p.querySelector('.cx-x'); if (first) first.focus({ preventScroll: true }); }
}
function auClose() {
  var k = auUi.sel;
  auUi.sel = null;
  auRender();
  var r = k && $('t-automations').querySelector('[data-cx="' + CSS.escape(k) + '"]');
  if (r) r.focus();
}

async function auRefresh() {
  var m = await j('/api/automations');
  if (!m) return;
  auModel = m;
  auUi.seen = auLoadSeen(m);
  auRender();
  var n = (m.verdict.needsYou || 0) + (m.verdict.broken || 0);
  $('nauto').hidden = !n;
  $('nauto').textContent = n;
}

async function renderAutomations() {
  var el = $('t-automations');
  // Non ridisegna mentre scrivi: perderesti la nota.
  if (document.activeElement && document.activeElement.tagName === 'TEXTAREA') return;
  // Primo caricamento: segnaposto subito, invece di una pagina vuota fino alla risposta.
  if (!auModel && !el.querySelector('[data-sec]')) el.innerHTML = AutomationsView.skeleton();
  var m = await j('/api/automations');
  if (!m) {
    // Con una vista di prima la tengo e lo dico in cima; senza, errore con «Riprova».
    if (auModel) { auUi.offline = true; auRender(); }
    else el.innerHTML = AutomationsView.errorHtml();
    return;
  }
  auUi.offline = false;
  auModel = m;
  auUi.seen = auLoadSeen(m);
  // Il ripasso punta a una chiave che non esiste più: ricomincia dalla prima.
  var unc = (m.review && m.review.unconfirmed) || [];
  if (auUi.review.open && unc.indexOf(auUi.review.key) === -1) {
    auUi.review = unc.length ? { open: true, key: unc[0] } : { open: false, key: null };
  }
  auRender();
  var n = (m.verdict.needsYou || 0) + (m.verdict.broken || 0);
  $('nauto').hidden = !n;
  $('nauto').textContent = n;
}

// «Da ieri»: in localStorage la fotografia di oggi e quella del confronto.
// Senza storage la scheda funziona lo stesso, solo senza questa riga.
function auLoadSeen(m) {
  var blank = { newKeys: [], changedKeys: [] };
  try {
    if (!window.localStorage) return blank;
    var today = auToday();
    var cur = {};
    for (const k of Object.keys(m.cards || {})) cur[k] = m.cards[k].fp;
    var st = null;
    try { st = JSON.parse(localStorage.getItem('automations.seen')); } catch (e) { st = null; }
    if (!st || !st.fps) {
      localStorage.setItem('automations.seen', JSON.stringify({ day: today, fps: cur, base: { day: today, fps: cur } }));
      return blank;
    }
    // Giorno nuovo: la fotografia di ieri diventa la base del confronto.
    var base = (st.day === today && st.base) ? st.base : { day: st.day, fps: st.fps };
    if (st.day !== today) localStorage.setItem('automations.seen', JSON.stringify({ day: today, fps: cur, base: base }));
    var out = { newKeys: [], changedKeys: [] };
    for (const k of Object.keys(cur)) {
      if (!base.fps || !(k in base.fps)) out.newKeys.push(k);
      else if (base.fps[k] !== cur[k]) out.changedKeys.push(k);
    }
    return out;
  } catch (e) { return blank; }
}

function auPost(body) {
  return fetch('/api/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(function (r) { return r.json(); }).catch(function () { return null; });
}

var auToastT;
function auToast(html, ms) {
  var t = $('toast');
  t.innerHTML = html;
  t.classList.add('on');
  // Col bottone dentro, il toast deve prendere i clic.
  t.style.pointerEvents = html.indexOf('<button') !== -1 ? 'auto' : '';
  clearTimeout(auToastT);
  auToastT = setTimeout(function () { t.classList.remove('on'); t.style.pointerEvents = ''; }, ms || 5000);
}

// Questo file arriva prima di app.js: al caricamento `$` non c'è ancora, qui si usa getElementById.
document.getElementById('toast').addEventListener('click', function (e) {
  if (!e.target.closest('[data-au-undo]')) return;
  var ref = auUndoRef;
  auUndoRef = null;
  $('toast').classList.remove('on');
  if (!ref) return;
  auPost({ kind: 'undo', ref: ref }).then(function () { auRefresh(); });
});

function auEachCard(key, fn) {
  if (!auModel) return;
  if (auModel.cards && auModel.cards[key]) fn(auModel.cards[key]);
  for (const c of auModel.needsYou || []) if (c.key === key) fn(c);
  for (const c of auModel.broken || []) if (c.key === key) fn(c);
  for (const g of auModel.groups || []) for (const c of g.cards || []) if (c.key === key) fn(c);
}

// Cambio ottimista: la card cambia subito, il server conferma dopo.
function auPatch(key, fn) {
  auEachCard(key, fn);
}

// Dopo un voto nel ripasso si passa da sola alla successiva.
function auReviewAdvance(votedKey) {
  var unc = ((auModel.review || {}).unconfirmed || []).filter(function (k) { return k !== votedKey; });
  if (!unc.length) {
    auUi.review = { open: false, key: null };
  } else {
    var after = ((auModel.review || {}).unconfirmed || []).filter(function (k, i, a) {
      return a.indexOf(votedKey) < i && k !== votedKey;
    });
    var next = after[0] || unc[0];
    auUi.review = { open: true, key: next };
    try { localStorage.setItem('automations.reviewKey', next); } catch (e) { /* senza storage si ricomincia da capo */ }
  }
}

async function auSend(body, key, patch, toastMsg) {
  auPatch(key, patch);
  if (auUi.review.open && (body.kind === 'vote')) auReviewAdvance(key);
  auRender();
  auFocusCard(key);
  var r = await auPost(body);
  if (r && r.ok !== false && r.row) {
    auUndoRef = r.row.id;
    auToast(toastMsg + ' · <button class="b" data-au-undo="1">Annulla</button>', 5000);
  } else {
    auToast('Non salvato: ' + ((r && r.error) || 'hub non raggiungibile'), 5000);
    auRefresh();
  }
}

// Visibile = nessun <details> chiuso sopra. WebKit 26 impagina anche il contenuto dei details chiusi
// (content-visibility), quindi offsetParent e getClientRects non bastano.
function auShown(a) {
  return !a.closest('details:not([open])');
}

function auFocusCard(key) {
  // La stessa card può stare anche in un gruppo chiuso (nel ripasso): vale quella che si vede.
  var found = null;
  var all = $('t-automations').querySelectorAll('article.au-card');
  for (const a of all) if (a.dataset.key === key && auShown(a)) { found = a; break; }
  var el = found || $('t-automations').querySelector('.au-rev-now article.au-card');
  if (el) el.focus({ preventScroll: true });
}

function auFb(article, kind) {
  var key = article.dataset.key;
  var fp = article.dataset.fp;
  if (kind === 'ok') {
    auSend({ kind: 'vote', key: key, fp: fp, v: 'ok' }, key, function (c) {
      c.feedback = c.feedback || {};
      c.feedback.vote = { v: 'ok', at: new Date().toISOString(), fp: fp, note: null, id: 'local' };
      c.feedback.changedSinceVote = false;
    }, 'Salvato');
    return;
  }
  auOpenForm(article, kind);
}

function auCloseForm() {
  var f = $('t-automations').querySelector('form.au-form');
  if (f) f.remove();
  return !!f;
}

// Nota obbligatoria per cambia, nota e segnala: senza non si capisce cosa fare.
function auOpenForm(article, kind) {
  auCloseForm();
  var form = document.createElement('form');
  form.className = 'au-form';
  if (kind === 'muta') {
    form.innerHTML = '<div class="au-mute">' +
      '<label><input type="radio" name="until" value="7" checked> 7 giorni</label>' +
      '<label><input type="radio" name="until" value="30"> 30 giorni</label>' +
      '<label><input type="radio" name="until" value="never"> sempre</label></div>' +
      '<textarea rows="2" placeholder="Perché non vuoi più avvisi? (obbligatorio)"></textarea>' +
      '<button class="b" type="submit">Salva</button>';
  } else {
    var ph = kind === 'cambia' ? 'Cosa non va? (obbligatorio, un agente se ne occupa)'
      : kind === 'nota' ? 'La tua nota (obbligatoria)'
      : 'Cosa segnali? (obbligatorio)';
    form.innerHTML = '<textarea rows="2" placeholder="' + ph + '"></textarea>' +
      '<button class="b" type="submit">Salva</button>';
  }
  article.appendChild(form);
  var ta = form.querySelector('textarea');
  ta.focus();
  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    auSubmitForm(article, kind, form);
  });
  ta.addEventListener('keydown', function (ev) {
    // Invio salva, Maiusc+Invio va a capo, Esc chiude senza salvare.
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); form.requestSubmit(); }
    if (ev.key === 'Escape') { ev.stopPropagation(); auCloseForm(); article.focus(); }
  });
}

function auSubmitForm(article, kind, form) {
  var key = article.dataset.key;
  var fp = article.dataset.fp;
  if (kind === 'muta') {
    var sel = form.querySelector('input[name="until"]:checked');
    var why = form.querySelector('textarea').value.trim();
    if (!why) { form.querySelector('textarea').focus(); return; }
    var until = !sel || sel.value === 'never' ? null
      : new Date(Date.now() + Number(sel.value) * 86400000).toISOString();
    auSend({ kind: 'mute', key: key, fp: fp, until: until, why: why }, key, function (c) {
      c.feedback = c.feedback || {};
      c.feedback.mute = { until: until, why: why };
    }, 'Salvato');
    return;
  }
  var note = form.querySelector('textarea').value.trim();
  if (!note) { form.querySelector('textarea').focus(); return; }
  if (kind === 'cambia') {
    auSend({ kind: 'vote', key: key, fp: fp, v: 'cambia', note: note }, key, function (c) {
      c.feedback = c.feedback || {};
      c.feedback.vote = { v: 'cambia', at: new Date().toISOString(), fp: fp, note: note, id: 'local' };
      c.feedback.changedSinceVote = false;
    }, 'Salvato · un agente se ne occupa');
  } else if (kind === 'nota') {
    auSend({ kind: 'note', key: key, fp: fp, note: note }, key, function (c) {
      c.feedback = c.feedback || {};
      c.feedback.open = (c.feedback.open || 0) + 1;
    }, 'Salvato');
  } else {
    auSend({ kind: 'complaint', key: key, fp: fp, note: note }, key, function (c) {
      c.feedback = c.feedback || {};
      c.feedback.open = (c.feedback.open || 0) + 1;
    }, 'Salvato');
  }
}

// Il ripasso riprende da dove eri: l'ultima chiave resta salvata.
function auReviewStart() {
  if (!auModel) return;
  var unc = (auModel.review && auModel.review.unconfirmed) || [];
  if (!unc.length) return;
  var saved = null;
  try { saved = localStorage.getItem('automations.reviewKey'); } catch (e) { /* senza storage si parte dalla prima */ }
  var key = (saved && unc.indexOf(saved) !== -1) ? saved : unc[0];
  auUi.review = { open: true, key: key };
  try { localStorage.setItem('automations.reviewKey', key); } catch (e) { /* come sopra */ }
  auRender();
  auFocusCard(key);
}

function auReviewGo(dir) {
  var unc = ((auModel.review || {}).unconfirmed) || [];
  var i = unc.indexOf(auUi.review.key);
  var next = unc[(i + dir + unc.length) % unc.length];
  if (!next) return;
  auUi.review = { open: true, key: next };
  try { localStorage.setItem('automations.reviewKey', next); } catch (e) { /* come sopra */ }
  auRender();
  auFocusCard(next);
}

// Filtri, ricerca, raggruppamento e «Riprova»: stato di sola vista, niente rete.
document.getElementById('t-automations').addEventListener('click', function (e) {
  var t = e.target;
  var flt = t.closest('[data-au-filter]');
  if (flt) { auUi.filter = flt.dataset.auFilter; auRender(); return; }
  if (t.closest('[data-cx-close]')) { auClose(); return; }
  var row = t.closest('[data-cx]');
  if (row) { auOpen(row.dataset.cx); return; }
  var area = t.closest('[data-au-area]');
  if (area) { var id = area.dataset.auArea; auUi.open[id] = !auUi.open[id]; auRender(); return; }
  var by = t.closest('[data-au-by]');
  if (by) {
    auUi.by = by.dataset.auBy;
    try { localStorage.setItem('automations.by', auUi.by); } catch (e2) { /* si perde alla chiusura */ }
    auRender();
    return;
  }
  if (t.closest('[data-au-clear]')) { auUi.q = ''; auUi.filter = 'all'; auRender(); return; }
  if (t.closest('[data-au-retry]')) { renderAutomations(); return; }
});
document.getElementById('t-automations').addEventListener('input', function (e) {
  if (!e.target.matches('input[data-au-q]')) return;
  auUi.q = e.target.value;
  auRender();
});

document.getElementById('t-automations').addEventListener('click', function (e) {
  var t = e.target;
  var what = t.closest('.au-what');
  if (what) { what.classList.toggle('open'); return; }
  var cost = t.closest('[data-cost]');
  if (cost) {
    var id = cost.dataset.cost;
    cost.disabled = true;
    j('/api/automations/run/' + encodeURIComponent(id)).then(function (r) {
      if (r && r.ok) auUi.costs[id] = r;
      auRender();
    });
    return;
  }
  var rev = t.closest('[data-review]');
  if (rev) {
    var r = rev.dataset.review;
    if (r === 'start') auReviewStart();
    else if (r === 'prev') auReviewGo(-1);
    else if (r === 'next') auReviewGo(1);
    else if (r === 'close') { auUi.review = { open: false, key: null }; auRender(); }
    return;
  }
  var fb = t.closest('[data-fb]');
  if (fb) {
    var article = fb.closest('article.au-card');
    if (article) auFb(article, fb.dataset.fb);
  }
});

// Tastiera sulla card a fuoco: v c n s m come i pulsanti, frecce o j/k per muoverti.
// Mai mentre scrivi in un campo di testo.
document.addEventListener('keydown', function (e) {
  var box = $('t-automations');
  if (!box || !box.classList.contains('on')) return;
  var t = e.target;
  if (t && t.matches && t.matches('input,textarea,select')) return;
  if (t && t.isContentEditable) return;
  if (e.key === 'Escape') {
    if ($('t-automations').querySelector('form.au-form')) { auCloseForm(); return; }
    if (auUi.sel) { auClose(); return; }
    if (t && t.matches && t.matches('input[data-au-q]')) { auUi.q = ''; auRender(); }
    return;
  }
  if (e.key === '/' && !(t && t.matches && t.matches('input,textarea'))) { var qi = box.querySelector('input[data-au-q]'); if (qi) { e.preventDefault(); qi.focus(); } return; }
  if (t && t.dataset && t.dataset.cx) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); auOpen(t.dataset.cx); return; }
    var rows = Array.prototype.slice.call(box.querySelectorAll('[data-cx]'));
    var i = rows.indexOf(t);
    var kk = (e.key || '').toLowerCase();
    if (kk === 'j' || e.key === 'ArrowDown') { e.preventDefault(); (rows[i + 1] || rows[i]).focus(); return; }
    if (kk === 'k' || e.key === 'ArrowUp') { e.preventDefault(); (rows[i - 1] || rows[i]).focus(); return; }
  }
  var art = t && t.closest ? t.closest('article.au-card') : null;
  if (!art || !box.contains(t)) return;
  var k = (e.key || '').toLowerCase();
  var map = { v: 'ok', c: 'cambia', n: 'nota', s: 'segnala', m: 'muta' };
  if (map[k]) { e.preventDefault(); auFb(art, map[k]); return; }
  var down = e.key === 'ArrowDown' || k === 'j';
  var up = e.key === 'ArrowUp' || k === 'k';
  if (!down && !up) return;
  e.preventDefault();
  var cards = Array.prototype.filter.call(box.querySelectorAll('article.au-card'), auShown);
  var n = cards[cards.indexOf(art) + (down ? 1 : -1)];
  if (n) n.focus();
});
