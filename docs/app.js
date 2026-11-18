const $ = (s) => document.querySelector(s);

// Deux périmètres : French Tech (contenu en français) et European Tech (contenu en anglais).
// L'interface est en anglais ; le contenu garde sa langue d'origine.
const SCOPES = {
  fr: { base: 'data/', name: 'French Tech', lang: 'fr' },
  eu: { base: 'data/eu/', name: 'European Tech', lang: 'en' },
};
const state = { scope: 'fr', days: [], day: null, cats: new Set(), q: '' };
const LOCALE = 'en-GB';

// Libellés de l'interface pour les thèmes des données French Tech (en français dans les données).
const CAT_EN = {
  'Levées de fonds': 'Funding', 'Rachats & IPO': 'M&A & IPOs', 'Licornes & scale-ups': 'Unicorns & scale-ups', 'IA': 'AI',
  'Politique & écosystème': 'Policy & ecosystem', 'Difficultés': 'Trouble', 'Talents & nominations': 'People',
};
const catLabel = (c) => CAT_EN[c] || c;
const isFunding = (c) => c === 'Levées de fonds' || c === 'Funding';
const FACT_LABELS = { amount: 'Amount', round: 'Round', valuation: 'Valuation', investors: 'Investors',
  Montant: 'Amount', Tour: 'Round', Valorisation: 'Valuation', Investisseurs: 'Investors' };

// Sur téléphone, la barre est étroite : date sans le jour de la semaine.
const fmtDay = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(LOCALE, window.innerWidth < 640 ? { day: 'numeric', month: 'short' } : { weekday: 'short', day: 'numeric', month: 'short' });
const fmtLong = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' });
const fmtTime = (iso) => {
  const d = new Date(iso);
  const t = d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date(state.day.generatedAt).toDateString() ? t : `${d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' })}, ${t}`;
};
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeUrl = (u = '') => (/^https?:\/\//i.test(u) ? u : '#');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const L = () => SCOPES[state.scope].lang; // langue du contenu affiché
// Nettoie les résumés des flux : mentions automatiques, rubrique/auteur/date en tête, liens de fin.
const cleanSummary = (s = '') => s
  .replace(/(L[’']article|The post) .{0,300}? (est apparu en premier sur|appeared first on) .*$/i, '')
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

// Adresse : #2026-11-18 (French Tech), #eu ou #eu-2026-11-18 (European Tech).
function readHash() {
  const h = location.hash.slice(1);
  const m = h.match(/^(eu)?-?(\d{4}-\d{2}-\d{2})?$/);
  return m ? { scope: m[1] ? 'eu' : (h ? 'fr' : null), date: m[2] || null } : { scope: null, date: null };
}
function writeHash() {
  const prefix = state.scope === 'eu' ? 'eu-' : '';
  history.replaceState(null, '', `#${prefix}${state.day?.date || ''}`.replace(/-$/, ''));
}

async function init() {
  const fromHash = readHash();
  let saved = null;
  try { saved = localStorage.getItem('scope'); } catch {}
  state.scope = fromHash.scope || (saved === 'eu' ? 'eu' : 'fr');
  paintScope(false);

  $('#day').onchange = (e) => loadDay(e.target.value);
  $('#prev').onclick = () => step(1);
  $('#next').onclick = () => step(-1);
  $('#q').oninput = (e) => { state.q = e.target.value.trim().toLowerCase(); render(); };
  document.querySelectorAll('[data-scope]').forEach((b) => (b.onclick = () => switchScope(b.dataset.scope)));
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-open]');
    if (b) openSheet(state.day.items[Number(b.dataset.open)]);
  });
  const sheet = $('#sheet');
  $('#close').onclick = () => sheet.close();
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.close(); }); // clic hors de la fenêtre
  sheet.addEventListener('close', () => document.body.classList.remove('locked'));
  window.addEventListener('resize', () => paintScope(false));

  await loadScope(fromHash.date);
}

async function loadScope(preferredDate) {
  try {
    state.days = (await getJSON(`${SCOPES[state.scope].base}index.json`)).days;
  } catch { state.days = []; }
  $('#day').innerHTML = state.days.map((d) => `<option value="${d.date}">${fmtDay(d.date)}</option>`).join('');
  if (!state.days.length) return renderEmpty();
  ['#prev', '#next', '#day'].forEach((s) => ($(s).disabled = false));
  const date = state.days.some((d) => d.date === preferredDate) ? preferredDate : state.days[0].date;
  await loadDay(date);
}

// Bascule French Tech ↔ European Tech : le contenu glisse vers la sortie, la pastille du
// sélecteur se déplace, puis le nouveau contenu arrive du côté opposé.
async function switchScope(scope) {
  if (scope === state.scope) return;
  const dir = scope === 'eu' ? 1 : -1;
  const main = document.querySelector('main');
  const keepDate = state.day?.date;
  state.scope = scope;
  try { localStorage.setItem('scope', scope); } catch {}
  state.q = ''; $('#q').value = '';
  paintScope(true);
  main.style.setProperty('--dir', dir);
  main.classList.add('swap-out');
  await new Promise((r) => setTimeout(r, 220));
  await loadScope(keepDate);
  main.classList.remove('swap-out');
  main.classList.add('swap-in');
  setTimeout(() => main.classList.remove('swap-in'), 650);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Sélecteur : bouton actif, pastille glissante, titre et teinte de fond du périmètre.
function paintScope(animate) {
  const root = document.documentElement;
  root.dataset.scope = state.scope;
  const seg = $('#scope');
  seg.classList.toggle('no-anim', !animate);
  document.querySelectorAll('[data-scope]').forEach((b) => b.setAttribute('aria-selected', b.dataset.scope === state.scope));
  const active = seg.querySelector(`[data-scope="${state.scope}"]`);
  seg.style.setProperty('--x', `${active.offsetLeft}px`);
  seg.style.setProperty('--w', `${active.offsetWidth}px`);
  const name = SCOPES[state.scope].name;
  document.title = `Radar · ${name}`;
  const h1 = document.querySelector('h1');
  // « The essentials of » mot à mot, puis le nom de l'édition d'un seul tenant (dégradé continu).
  h1.innerHTML = ['The', 'essentials', 'of'].map((w, i) => `<span class="w" style="--i:${i}">${w}</span>`).join(' ')
    + ` <span class="w scope-word" style="--i:3">${esc(name)}.</span>`;
  if (animate) { h1.classList.remove('retitle'); void h1.offsetWidth; h1.classList.add('retitle'); }
}

function step(delta) {
  const i = state.days.findIndex((d) => d.date === state.day.date) + delta;
  if (state.days[i]) loadDay(state.days[i].date);
}

async function loadDay(date) {
  state.day = await getJSON(`${SCOPES[state.scope].base}${date}.json`);
  state.day.items = state.day.items.filter((i) => i.kind !== 'linkedin'); // anciennes données
  state.cats.clear();
  $('#day').value = date;
  writeHash();
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
  const funding = d.items.filter((i) => i.categories.some(isFunding)).length;
  const isToday = d.date === state.days[0].date;
  $('#eyebrow').textContent = (isToday ? 'Today, ' : '') + fmtLong(d.date);
  $('#summary').innerHTML = `<b>${plural(d.items.length, 'story', 'stories')}</b>, including ${plural(funding, 'funding round')}, from ${plural(media, 'outlet')}.`;

  const counts = {};
  d.items.forEach((i) => i.categories.forEach((c) => (counts[c] = (counts[c] || 0) + 1)));
  $('#chips').innerHTML = `<button class="chip glass" aria-pressed="true" data-cat="">All</button>` + Object.entries(counts).sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `<button class="chip glass" aria-pressed="false" data-cat="${esc(c)}">${esc(catLabel(c))}<small>${n}</small></button>`).join('');
  document.querySelectorAll('.chip').forEach((b) => (b.onclick = () => {
    const c = b.dataset.cat;
    if (!c) state.cats.clear();
    else state.cats.has(c) ? state.cats.delete(c) : state.cats.add(c);
    document.querySelectorAll('.chip').forEach((x) => x.setAttribute('aria-pressed', x.dataset.cat ? state.cats.has(x.dataset.cat) : !state.cats.size));
    render();
  }));

  $('#sources').innerHTML = d.sources.map((s) => `<li><span title="${esc(s.source)}">${esc(s.source)}</span>${s.ok ? `<span>${s.items}</span>` : `<span class="ko" title="${esc(s.error)}">error</span>`}</li>`).join('');
  $('#src-count').textContent = d.sources.length;
  $('#updated').textContent = `Last updated ${new Date(d.generatedAt).toLocaleString(LOCALE, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}.`;
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
    ${i.categories[0] ? `<span class="dot"></span><span>${esc(i.categories.slice(0, 2).map(catLabel).join(' · '))}</span>` : ''}
    ${n > 1 ? `<span class="dot"></span><span class="multi">${n} articles</span>` : ''}
  </div>`;
}

function articleList(list) {
  return `<ul class="alist">${list.map((x) => `<li><a href="${esc(safeUrl(x.url))}" target="_blank" rel="noopener"><b>${esc(x.source)}</b><span lang="${L()}">${esc(x.title)}</span>${ICON_OUT}</a></li>`).join('')}</ul>`;
}

function articlesMenu(i) {
  const list = articlesOf(i);
  return `<details class="articles"><summary>${list.length > 1 ? `All ${list.length} articles` : 'The article'} ${ICON_CHEVRON}</summary>${articleList(list)}</details>`;
}

// Visuel : photo de l'article filtrée aux couleurs du thème, ou couverture générée (dégradé +
// courbes de niveau). Les deux partagent les mêmes couches pour garder une cohérence graphique.
const COVER_HUES = { Funding: [212, 172], 'M&A & IPOs': [268, 222], 'Unicorns & scale-ups': [290, 330], AI: [238, 300],
  'Policy & ecosystem': [28, 350], Trouble: [2, 330], People: [150, 196] };
function hashHue(t) { let h = 0; for (const c of t) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function hues(i) {
  return COVER_HUES[catLabel(i.categories[0])] || [hashHue(i.title), (hashHue(i.title) + 60) % 360];
}
function visual(i, cls) {
  const [a, b] = hues(i);
  const img = i.image ? `<img src="${esc(safeUrl(i.image))}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="imgFail(this)">` : '';
  return `<div class="visual ${cls} ${img ? 'photo' : 'generated'}" style="--h1:${a};--h2:${b}" aria-hidden="true">
    ${img}<i class="tint"></i><i class="lines"></i><span class="pill">${esc(catLabel(i.categories[0]) || SCOPES[state.scope].name)}</span>
  </div>`;
}
window.imgFail = (el) => { el.parentElement.classList.replace('photo', 'generated'); el.remove(); };

function feature(i, lead) {
  const t = teaserOf(i);
  return `<article class="feature pane${lead ? ' lead' : ''}">
    ${visual(i, 'wide')}
    <div class="body">
      ${kicker(i)}
      <h3 lang="${L()}"><button class="open" data-open="${idx(i)}">${esc(i.title)}</button></h3>
      ${t ? `<p class="teaser" lang="${L()}">${esc(t)}</p>` : ''}
      <button class="read" data-open="${idx(i)}">Read the summary</button>
      ${articlesMenu(i)}
    </div>
  </article>`;
}

function row(i) {
  const t = teaserOf(i);
  return `<article class="row">
    <div class="row-main">
      ${kicker(i)}
      <h3 lang="${L()}"><button class="open" data-open="${idx(i)}">${esc(i.title)}</button></h3>
      ${t ? `<p class="teaser" lang="${L()}">${esc(t)}</p>` : ''}
      ${articlesMenu(i)}
    </div>
  </article>`;
}

const LIST_SIZE = 10;
function render() {
  const items = filtered();
  const filtering = state.q || state.cats.size;
  const top = filtering ? [] : items.slice(0, 5);
  // Hors recherche : seulement les 10 sujets repris par le plus grand nombre d'articles.
  const rest = filtering ? items : items.slice(5)
    .sort((a, b) => articlesOf(b).length - articlesOf(a).length || b.score - a.score).slice(0, LIST_SIZE);
  $('#top').innerHTML = top.length
    ? `<h2 class="section-title">Top stories</h2><div class="top-grid">${top.map((i, n) => feature(i, n === 0)).join('')}</div>`
    : '';
  $('#list').innerHTML = rest.length
    ? `<h2 class="section-title">${filtering ? 'Results' : 'Most covered'}<small>${rest.length}</small></h2><div class="group pane">${rest.map(row).join('')}</div>`
    : (top.length ? '' : '<p class="empty">No stories match this search.</p>');
}

function openSheet(i) {
  const b = i.brief;
  const list = articlesOf(i);
  const fallback = cleanSummary(i.summary);
  $('#sheet-body').innerHTML = `
    <p class="s-kicker">${esc([...i.categories.slice(0, 2).map(catLabel), plural(list.length, 'article')].join(' · '))}</p>
    <h2 class="s-title" id="sheet-title" lang="${L()}">${esc(i.title)}</h2>
    ${b ? `
      <p class="s-lead" lang="${L()}">${esc(b.essentiel)}</p>
      ${b.facts?.length ? `<dl class="s-facts glass">${b.facts.map((f) => `<div><dt>${esc(FACT_LABELS[f.key || f.label] || f.label)}</dt><dd lang="${L()}">${esc(f.value)}</dd></div>`).join('')}</dl>` : ''}
      ${b.points?.length ? `<p class="s-label">Key points</p><ul class="s-points" lang="${L()}">${b.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
    ` : (fallback ? `<p class="s-text" lang="${L()}">${esc(fallback)}</p>` : `<p class="s-text s-none">${list.length > 1 ? "These outlets don't" : "This outlet doesn't"} provide an excerpt. Open the ${list.length > 1 ? 'articles' : 'article'} below to read more.</p>`)}
    <p class="s-label">${list.length > 1 ? `All ${list.length} articles` : 'The article'}</p>
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
    btn.innerHTML = light ? `${ICON_MOON}Dark mode` : `${ICON_SUN}Light mode`;
    btn.setAttribute('aria-label', light ? 'Switch to dark mode' : 'Switch to light mode');
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
  state.day = null;
  writeHash();
  $('#eyebrow').textContent = 'Coming soon';
  $('#summary').textContent = `The first ${SCOPES[state.scope].name} briefing will appear after the next update (9:30, 13:30, 18:30 or 21:30, Paris time).`;
  ['#chips', '#top', '#list', '#sources'].forEach((s) => ($(s).innerHTML = ''));
  $('#src-count').textContent = '';
  $('#day').innerHTML = '';
  ['#prev', '#next', '#day'].forEach((s) => ($(s).disabled = true));
}

// ---------- Ouverture ----------
// Grand logo sur radar jusqu'au premier geste (toucher, clic, touche, défilement) ; puis zoom dans
// les courbes de niveau, logo qui s'éclaire en blanc, site dévoilé depuis le point bleu.
function setupIntro() {
  const root = document.documentElement;
  const intro = $('#intro');
  $('#replay').onclick = () => {
    try { localStorage.removeItem('intro'); } catch {}
    location.href = location.pathname; // sans le jour dans l'adresse, pour rejouer l'ouverture
  };
  if (!root.classList.contains('with-intro')) return;
  try { localStorage.setItem('intro', new Date().toISOString().slice(0, 10)); } catch {}

  let done = false;
  const enter = (e) => {
    if (done) return;
    done = true;
    e?.preventDefault?.();
    const d = $('#wm-dot').getBoundingClientRect();
    intro.style.setProperty('--cx', `${d.left + d.width / 2}px`);
    intro.style.setProperty('--cy', `${d.top + d.height / 2}px`);
    intro.classList.add('leaving');
    events.forEach(([t, f]) => window.removeEventListener(t, f));
    setTimeout(() => {
      window.scrollTo(0, 0);
      root.classList.add('entering');
      root.classList.remove('with-intro');
      paintScope(false); // la barre devient visible : on recale la pastille du sélecteur
    }, 520);
    setTimeout(() => { intro.remove(); root.classList.remove('entering'); }, 1900);
  };
  const events = [['pointerdown', enter], ['keydown', enter], ['wheel', enter], ['touchmove', enter]];
  events.forEach(([t, f]) => window.addEventListener(t, f, { passive: false }));
  intro.focus({ preventScroll: true });
}

setupTheme();
setupIntro();
init();
