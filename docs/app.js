const $ = (s) => document.querySelector(s);
const state = { days: [], day: null, tab: 'all', cats: new Set(), q: '' };

const fmtDay = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fmtTime = (iso) => new Date(iso).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeUrl = (u = '') => (/^https?:\/\//i.test(u) ? u : '#');

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
  sel.innerHTML = state.days.map((d) => `<option value="${d.date}">${fmtDay(d.date)} · ${d.articles + d.linkedin}</option>`).join('');
  if (!state.days.length) return renderEmpty();
  const fromHash = location.hash.slice(1);
  await loadDay(state.days.some((d) => d.date === fromHash) ? fromHash : state.days[0].date);

  sel.onchange = () => loadDay(sel.value);
  $('#prev').onclick = () => step(1);
  $('#next').onclick = () => step(-1);
  $('#q').oninput = (e) => { state.q = e.target.value.trim().toLowerCase(); render(); };
  document.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => {
    state.tab = b.dataset.tab;
    document.querySelectorAll('[data-tab]').forEach((x) => x.setAttribute('aria-selected', x === b));
    render();
  }));
}

function step(delta) {
  const i = state.days.findIndex((d) => d.date === state.day.date) + delta;
  if (state.days[i]) loadDay(state.days[i].date);
}

async function loadDay(date) {
  state.day = await getJSON(`data/${date}.json`);
  state.cats.clear();
  $('#day').value = date;
  history.replaceState(null, '', `#${date}`);
  const i = state.days.findIndex((d) => d.date === date);
  $('#prev').disabled = i >= state.days.length - 1;
  $('#next').disabled = i <= 0;
  renderStatic();
  render();
}

function renderStatic() {
  const d = state.day;
  const multi = d.items.filter((i) => i.sources.length > 1).length;
  const funding = d.items.filter((i) => i.categories.includes('Levées de fonds')).length;
  $('#stats').innerHTML = [
    [d.counts.articles, 'articles retenus'],
    [d.counts.linkedin, 'posts LinkedIn'],
    [funding, 'levées de fonds'],
    [multi, 'sujets multi-médias'],
  ].map(([n, l]) => `<div class="stat"><b>${n}</b><span>${l}</span></div>`).join('');

  const counts = {};
  d.items.forEach((i) => i.categories.forEach((c) => (counts[c] = (counts[c] || 0) + 1)));
  $('#chips').innerHTML = Object.entries(counts).sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `<button class="chip" aria-pressed="false" data-cat="${esc(c)}">${esc(c)}<small>${n}</small></button>`).join('');
  document.querySelectorAll('.chip').forEach((b) => (b.onclick = () => {
    const c = b.dataset.cat;
    state.cats.has(c) ? state.cats.delete(c) : state.cats.add(c);
    b.setAttribute('aria-pressed', state.cats.has(c));
    render();
  }));

  $('#watchlist').innerHTML = (d.watchlist || []).map((w) => `<li><a href="${esc(safeUrl(w.url))}" target="_blank" rel="noopener">${esc(w.name)} ↗</a></li>`).join('');
  $('#li-note').textContent = d.linkedinSearch
    ? 'Les posts LinkedIn publics sont repérés automatiquement chaque jour, en plus de ceux ajoutés à la main.'
    : 'Recherche LinkedIn automatique désactivée : ajoutez le secret BRAVE_API_KEY, ou ajoutez des posts dans config/linkedin.json.';
  $('#sources').innerHTML = d.sources.map((s) => `<li><span title="${esc(s.source)}">${esc(s.source)}</span>${s.ok ? `<span>${s.items}</span>` : `<span class="ko" title="${esc(s.error)}">erreur</span>`}</li>`).join('');
  $('#updated').textContent = `dernière collecte le ${fmtTime(d.generatedAt)}`;
}

function filtered() {
  return state.day.items.filter((i) =>
    (state.tab === 'all' || i.kind === state.tab) &&
    (!state.cats.size || i.categories.some((c) => state.cats.has(c))) &&
    (!state.q || `${i.title} ${i.summary} ${i.sources.join(' ')} ${i.author || ''}`.toLowerCase().includes(state.q))
  );
}

function card(i, withImage) {
  const li = i.kind === 'linkedin';
  return `<article class="card">
    ${withImage && i.image ? `<img src="${esc(safeUrl(i.image))}" alt="" loading="lazy" onerror="this.remove()">` : ''}
    <div class="meta">
      ${li ? `<span class="badge li">LinkedIn</span>${i.author ? `<span class="src">${esc(i.author)}</span>` : ''}` : `<span class="src">${esc(i.sources[0])}</span>`}
      ${i.sources.length > 1 ? `<span class="badge multi" title="${esc(i.sources.join(', '))}">${i.sources.length} médias</span>` : ''}
      <span>${fmtTime(i.date)}</span>
      <span class="score" title="Score de pertinence">★ ${i.score}</span>
    </div>
    <h3><a href="${esc(safeUrl(i.url))}" target="_blank" rel="noopener">${esc(i.title)}</a></h3>
    ${i.summary ? `<p>${esc(i.summary)}</p>` : ''}
    ${i.categories.length ? `<div class="meta">${i.categories.map((c) => `<span class="badge">${esc(c)}</span>`).join('')}</div>` : ''}
  </article>`;
}

function render() {
  const items = filtered();
  const filtering = state.q || state.cats.size;
  const top = filtering ? [] : items.slice(0, 5);
  const rest = filtering ? items : items.slice(5);
  $('#top').innerHTML = top.length
    ? `<h2 class="section-title">L'essentiel du jour</h2><div class="top-grid">${top.map((i, n) => card(i, n === 0)).join('')}</div>`
    : '';
  $('#list').innerHTML = (rest.length ? `<h2 class="section-title">${filtering ? `${items.length} résultat${items.length > 1 ? 's' : ''}` : 'Le reste de la veille'}</h2>` : '') +
    (rest.map((i) => card(i, false)).join('') || (top.length ? '' : '<div class="empty">Aucun élément ne correspond à ces filtres.</div>'));
}

function renderEmpty() {
  $('#top').innerHTML = `<div class="empty"><b>Pas encore de veille.</b><br>La première collecte aura lieu demain matin, ou lancez le workflow « Screening quotidien » depuis l'onglet Actions de GitHub.</div>`;
  ['#prev', '#next', '#day'].forEach((s) => ($(s).disabled = true));
}

init();
