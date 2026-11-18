const $ = (s) => document.querySelector(s);
const state = { days: [], day: null, cats: new Set(), q: '', shown: [] };

const fmtDay = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtLong = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
const fmtTime = (iso) => {
  const d = new Date(iso);
  const t = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date(state.day.generatedAt).toDateString() ? t : `${d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}, ${t}`;
};
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeUrl = (u = '') => (/^https?:\/\//i.test(u) ? u : '#');
const plural = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;
// Nettoie les résumés des flux : mentions automatiques, rubrique/auteur/date en tête, liens de fin.
const cleanSummary = (s = '') => s
  .replace(/L[’']article .{0,300}? est apparu en premier sur .*$/i, '')
  .replace(/Lire l[’']article sur .*$/i, '')
  .replace(/^[A-ZÀ-Ü0-9 '&-]{2,40} · [^·]{2,60} · \d{2}\/\d{2}\/\d{4}\s*/, '')
  .trim();
const ICON_CHEVRON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg>';
const ICON_OUT = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3h7v7M13 3 4 12"/></svg>';

async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(r.status);
  return r.json();
}

async function init() {
  try {
    state.days = (await getJSON('data/index.json')).days;
  } catch { state.days = []; }
  const sel = $('#day');
  sel.innerHTML = state.days.map((d) => `<option value="${d.date}">${fmtDay(d.date)}</option>`).join('');
  if (!state.days.length) return renderEmpty();
  const fromHash = location.hash.slice(1);
  await loadDay(state.days.some((d) => d.date === fromHash) ? fromHash : state.days[0].date);

  sel.onchange = () => loadDay(sel.value);
  $('#prev').onclick = () => step(1);
  $('#next').onclick = () => step(-1);
  $('#q').oninput = (e) => { state.q = e.target.value.trim().toLowerCase(); render(); };
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-open]');
    if (b) openSheet(state.day.items[Number(b.dataset.open)]);
  });
  const sheet = $('#sheet');
  $('#close').onclick = () => sheet.close();
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.close(); }); // clic hors de la fenêtre
  sheet.addEventListener('close', () => document.body.classList.remove('locked'));
}

function step(delta) {
  const i = state.days.findIndex((d) => d.date === state.day.date) + delta;
  if (state.days[i]) loadDay(state.days[i].date);
}

async function loadDay(date) {
  state.day = await getJSON(`data/${date}.json`);
  state.day.items = state.day.items.filter((i) => i.kind !== 'linkedin'); // anciennes données
  state.cats.clear();
  $('#day').value = date;
  history.replaceState(null, '', `#${date}`);
  const i = state.days.findIndex((d) => d.date === date);
  $('#prev').disabled = i >= state.days.length - 1;
  $('#next').disabled = i <= 0;
  renderStatic();
  render();
}

// Tous les articles d'un sujet, sans « source principale ».
function articlesOf(i) {
  if (i.articles?.length) return i.articles;
  return [{ source: i.sources[0], title: i.title, url: i.url }, ...(i.related || [])];
}

function renderStatic() {
  const d = state.day;
  const media = new Set(d.items.flatMap((i) => i.sources)).size;
  const funding = d.items.filter((i) => i.categories.includes('Levées de fonds')).length;
  const isToday = d.date === state.days[0].date;
  $('#eyebrow').textContent = (isToday ? "Aujourd'hui, " : '') + fmtLong(d.date);
  $('#summary').innerHTML = `<b>${plural(d.items.length, 'sujet')}</b>, dont ${plural(funding, 'levée')} de fonds, repérés dans ${plural(media, 'média')}.`;

  const counts = {};
  d.items.forEach((i) => i.categories.forEach((c) => (counts[c] = (counts[c] || 0) + 1)));
  $('#chips').innerHTML = `<button class="chip glass" aria-pressed="true" data-cat="">Tout</button>` + Object.entries(counts).sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `<button class="chip glass" aria-pressed="false" data-cat="${esc(c)}">${esc(c)}<small>${n}</small></button>`).join('');
  document.querySelectorAll('.chip').forEach((b) => (b.onclick = () => {
    const c = b.dataset.cat;
    if (!c) state.cats.clear();
    else state.cats.has(c) ? state.cats.delete(c) : state.cats.add(c);
    document.querySelectorAll('.chip').forEach((x) => x.setAttribute('aria-pressed', x.dataset.cat ? state.cats.has(x.dataset.cat) : !state.cats.size));
    render();
  }));

  $('#sources').innerHTML = d.sources.map((s) => `<li><span title="${esc(s.source)}">${esc(s.source)}</span>${s.ok ? `<span>${s.items}</span>` : `<span class="ko" title="${esc(s.error)}">erreur</span>`}</li>`).join('');
  $('#src-count').textContent = d.sources.length;
  $('#updated').textContent = `Dernière collecte le ${new Date(d.generatedAt).toLocaleString('fr-FR', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}.`;
}

function filtered() {
  return state.day.items.filter((i) =>
    (!state.cats.size || i.categories.some((c) => state.cats.has(c))) &&
    (!state.q || `${i.title} ${i.summary} ${i.brief?.essentiel || ''} ${articlesOf(i).map((r) => `${r.source} ${r.title}`).join(' ')}`.toLowerCase().includes(state.q))
  );
}

const idx = (i) => state.day.items.indexOf(i);
const teaserOf = (i) => i.brief?.essentiel || cleanSummary(i.summary);

function kicker(i) {
  const n = articlesOf(i).length;
  return `<div class="kicker">
    <span>${fmtTime(i.date)}</span>
    ${i.categories[0] ? `<span class="dot"></span><span>${esc(i.categories.slice(0, 2).join(' · '))}</span>` : ''}
    ${n > 1 ? `<span class="dot"></span><span class="multi">${n} articles</span>` : ''}
  </div>`;
}

function articleList(list) {
  return `<ul class="alist">${list.map((x) => `<li><a href="${esc(safeUrl(x.url))}" target="_blank" rel="noopener"><b>${esc(x.source)}</b><span>${esc(x.title)}</span>${ICON_OUT}</a></li>`).join('')}</ul>`;
}

function articlesMenu(i) {
  const list = articlesOf(i);
  return `<details class="articles"><summary>${list.length > 1 ? `Les ${list.length} articles` : "L'article"} ${ICON_CHEVRON}</summary>${articleList(list)}</details>`;
}

function feature(i, lead) {
  const t = teaserOf(i);
  const img = lead && i.image ? `<img src="${esc(safeUrl(i.image))}" alt="" loading="lazy" onerror="this.closest('.feature').classList.remove('has-img');this.remove()">` : '';
  return `<article class="feature pane${lead ? ' lead' : ''}${img ? ' has-img' : ''}">
    ${img}
    <div class="body">
      ${kicker(i)}
      <h3><button class="open" data-open="${idx(i)}">${esc(i.title)}</button></h3>
      ${t ? `<p class="teaser">${esc(t)}</p>` : ''}
      <button class="read" data-open="${idx(i)}">Lire le résumé</button>
      ${articlesMenu(i)}
    </div>
  </article>`;
}

function row(i) {
  const t = teaserOf(i);
  return `<article class="row">
    ${kicker(i)}
    <h3><button class="open" data-open="${idx(i)}">${esc(i.title)}</button></h3>
    ${t ? `<p class="teaser">${esc(t)}</p>` : ''}
    ${articlesMenu(i)}
  </article>`;
}

function render() {
  const items = filtered();
  const filtering = state.q || state.cats.size;
  const top = filtering ? [] : items.slice(0, 5);
  const rest = filtering ? items : items.slice(5);
  $('#top').innerHTML = top.length
    ? `<h2 class="section-title">À la une</h2><div class="top-grid">${top.map((i, n) => feature(i, n === 0)).join('')}</div>`
    : '';
  $('#list').innerHTML = rest.length
    ? `<h2 class="section-title">${filtering ? 'Résultats' : 'Toute la veille'}<small>${rest.length}</small></h2><div class="group pane">${rest.map(row).join('')}</div>`
    : (top.length ? '' : '<p class="empty">Aucun article ne correspond à cette recherche.</p>');
}

function openSheet(i) {
  const b = i.brief;
  const list = articlesOf(i);
  const fallback = cleanSummary(i.summary);
  $('#sheet-body').innerHTML = `
    <p class="s-kicker">${esc([...i.categories.slice(0, 2), plural(list.length, 'article')].join(' · '))}</p>
    <h2 class="s-title" id="sheet-title">${esc(i.title)}</h2>
    ${b ? `
      <p class="s-lead">${esc(b.essentiel)}</p>
      ${b.facts?.length ? `<dl class="s-facts glass">${b.facts.map((f) => `<div><dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd></div>`).join('')}</dl>` : ''}
      ${b.points?.length ? `<p class="s-label">À retenir</p><ul class="s-points">${b.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
      ${b.enjeu ? `<p class="s-why glass"><b>Pourquoi c'est important</b>${esc(b.enjeu)}</p>` : ''}
      ${b.note ? `<p class="s-note">${esc(b.note)}</p>` : ''}
    ` : (fallback ? `<p class="s-text">${esc(fallback)}</p>` : `<p class="s-text s-none">${list.length > 1 ? 'Ces médias ne fournissent' : 'Ce média ne fournit'} pas d'extrait de l'article. Ouvrez-${list.length > 1 ? 'les' : 'le'} ci-dessous pour en savoir plus.</p>`)}
    <p class="s-label">${list.length > 1 ? `Les ${list.length} articles` : "L'article"}</p>
    ${articleList(list)}`;
  const sheet = $('#sheet');
  document.body.classList.add('locked');
  sheet.showModal();
  sheet.querySelector('.sheet-scroll').scrollTop = 0;
  $('#close').focus();
}

// Bouton clair / sombre (sombre par défaut). Le choix est mémorisé dans ce navigateur.
const ICON_SUN = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"/></svg>';
const ICON_MOON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7Z"/></svg>';
function setupTheme() {
  const btn = $('#theme');
  const paint = () => {
    const light = document.documentElement.dataset.theme === 'light';
    btn.innerHTML = light ? `${ICON_MOON}Mode sombre` : `${ICON_SUN}Mode clair`;
    btn.setAttribute('aria-label', light ? 'Passer en mode sombre' : 'Passer en mode clair');
    document.getElementById('theme-color').content = light ? '#f2f3f7' : '#000000';
  };
  btn.onclick = () => {
    const light = document.documentElement.dataset.theme !== 'light';
    if (light) document.documentElement.dataset.theme = 'light';
    else delete document.documentElement.dataset.theme;
    try { localStorage.setItem('theme', light ? 'light' : 'dark'); } catch {}
    paint();
  };
  paint();
}

function renderEmpty() {
  $('#eyebrow').textContent = 'Bientôt';
  $('#summary').textContent = "La première collecte aura lieu demain matin, ou lancez le workflow « Screening quotidien » depuis l'onglet Actions de GitHub.";
  ['#prev', '#next', '#day'].forEach((s) => ($(s).disabled = true));
}

setupTheme();
init();
