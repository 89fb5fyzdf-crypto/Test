#!/usr/bin/env node
// Screening quotidien French Tech : collecte les flux RSS + Google News (+ LinkedIn),
// filtre, score, dédoublonne et écrit docs/data/AAAA-MM-JJ.json + docs/data/index.json.
//
// Usage : node scripts/screen.mjs [--date AAAA-MM-JJ] [--hours 36] [--fixtures dossier]
//   --fixtures : lit des fichiers XML locaux (nommés <slug>.xml) au lieu du réseau (tests).

import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'docs', 'data');
const KEEP_DAYS = 120;

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]);
    return acc;
  }, [])
);

const now = new Date();
const runDate = args.date || parisDate(now);
const windowHours = Number(args.hours || 36);
const since = new Date(now.getTime() - windowHours * 3600e3);

const sources = JSON.parse(await readFile(path.join(ROOT, 'config', 'sources.json'), 'utf8'));
const keywords = JSON.parse(await readFile(path.join(ROOT, 'config', 'keywords.json'), 'utf8'));
const linkedin = JSON.parse(await readFile(path.join(ROOT, 'config', 'linkedin.json'), 'utf8'));

const franceRe = new RegExp(keywords.france.join('|'), 'i');
const categories = Object.entries(keywords.categories).map(([name, c]) => ({
  name, weight: c.weight, re: new RegExp(c.patterns.join('|'), 'i'),
}));

// ---------- utilitaires ----------
function parisDate(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(d);
}
function slug(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', ndash: '–', mdash: '—', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', ecirc: 'ê', ocirc: 'ô', euro: '€', laquo: '«', raquo: '»' };
function decode(s = '') {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}
function stripHtml(s = '') {
  return decode(decode(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : '';
}
function attr(block, name, attribute) {
  const m = block.match(new RegExp(`<${name}\\b[^>]*\\b${attribute}=["']([^"']+)["']`, 'i'));
  return m ? decode(m[1]) : '';
}

// Parseur RSS 2.0 / Atom minimaliste (suffisant pour les flux de presse).
function parseFeed(xml) {
  const items = [];
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks) {
    const link = stripHtml(tag(b, 'link')) || attr(b, 'link', 'href');
    const date = tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date');
    items.push({
      title: stripHtml(tag(b, 'title')),
      link: link.trim(),
      date: date ? new Date(stripHtml(date)) : null,
      summary: stripHtml(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content')).slice(0, 400),
      image: attr(b, 'media:content', 'url') || attr(b, 'media:thumbnail', 'url') || attr(b, 'enclosure', 'url'),
      source: stripHtml(tag(b, 'source')),
    });
  }
  return items;
}

async function getText(url, fixtureName) {
  if (args.fixtures) {
    const f = path.join(args.fixtures, `${fixtureName}.xml`);
    return existsSync(f) ? readFile(f, 'utf8') : '';
  }
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FrenchTechScreener/1.0)', Accept: 'application/rss+xml, application/xml, text/xml, */*' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ---------- collecte ----------
const report = [];
const raw = [];

async function collectFeed({ name, url, focus, weight }) {
  try {
    const items = parseFeed(await getText(url, slug(name)));
    let kept = 0;
    for (const it of items) {
      if (!it.title || !it.link) continue;
      raw.push({ ...it, source: name, kind: 'article', focus, sourceWeight: weight ?? 1 });
      kept++;
    }
    report.push({ source: name, ok: true, items: kept });
  } catch (e) {
    report.push({ source: name, ok: false, error: String(e.message || e) });
  }
}

async function collectGoogleNews(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query + ' when:2d')}&hl=fr&gl=FR&ceid=FR:fr`;
  const name = `Google News · ${query}`;
  try {
    const items = parseFeed(await getText(url, slug(name)));
    for (const it of items) {
      // Les titres Google News se terminent par « - Nom du média ».
      const media = it.source || it.title.split(' - ').pop();
      const title = it.source && it.title.endsWith(` - ${it.source}`) ? it.title.slice(0, -(it.source.length + 3)) : it.title;
      raw.push({ ...it, title, summary: '', source: media, via: 'Google News', kind: 'article', focus: true, sourceWeight: 1 });
    }
    report.push({ source: name, ok: true, items: items.length });
  } catch (e) {
    report.push({ source: name, ok: false, error: String(e.message || e) });
  }
}

async function collectLinkedInSearch(query) {
  const key = process.env.BRAVE_API_KEY;
  if (!key || args.fixtures) return;
  const name = `LinkedIn · ${query}`;
  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&freshness=pd&count=20&country=fr&search_lang=fr`;
    const res = await fetch(url, { headers: { 'X-Subscription-Token': key, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const results = json.web?.results || [];
    for (const r of results) {
      if (!/linkedin\.com\/(posts|pulse|feed)/.test(r.url)) continue;
      raw.push({
        title: stripHtml(r.title).replace(/\s*\|\s*LinkedIn$/i, ''),
        link: r.url,
        summary: stripHtml(r.description || '').slice(0, 400),
        date: r.page_age ? new Date(r.page_age) : now,
        source: 'LinkedIn', author: authorFromLinkedIn(r.url, r.title), kind: 'linkedin', focus: true, sourceWeight: 2,
      });
    }
    report.push({ source: name, ok: true, items: results.length });
  } catch (e) {
    report.push({ source: name, ok: false, error: String(e.message || e) });
  }
}

function authorFromLinkedIn(url, title = '') {
  const t = stripHtml(title).match(/^(.+?) (?:on|sur) LinkedIn/i);
  if (t) return t[1];
  const m = url.match(/linkedin\.com\/posts\/([^_/]+)/);
  return m ? m[1].replace(/-[0-9a-z]{4,}$/, '').replace(/-/g, ' ') : '';
}

await Promise.all([
  ...sources.feeds.map(collectFeed),
  ...sources.googleNews.map(collectGoogleNews),
  ...linkedin.searchQueries.map(collectLinkedInSearch),
]);

// Posts LinkedIn ajoutés à la main pour cette date.
for (const p of linkedin.posts || []) {
  if (p.date !== runDate) continue;
  raw.push({
    title: p.title, link: p.url, summary: p.summary || '', date: new Date(`${p.date}T08:00:00Z`),
    source: 'LinkedIn', author: p.author || authorFromLinkedIn(p.url), kind: 'linkedin', focus: true, sourceWeight: 3, curated: true,
  });
}

// ---------- filtrage, scoring, dédoublonnage ----------
const STOP = new Set('le la les un une des de du et à a au aux en pour par sur dans avec qui que son sa ses ce cette est the of to and in for on with'.split(' '));
const words = (s) => new Set(slug(s).split('-').filter((w) => w.length > 2 && !STOP.has(w)));
function similar(a, b) {
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / Math.min(a.size, b.size || 1);
}

const fresh = raw.filter((it) => {
  if (it.curated) return true;
  if (!it.date || isNaN(it.date)) return false;
  return it.date >= since && it.date <= new Date(now.getTime() + 3600e3);
});

const groups = [];
for (const it of fresh.sort((a, b) => b.sourceWeight - a.sourceWeight)) {
  const text = `${it.title} ${it.summary}`;
  if (!it.focus && !franceRe.test(text)) continue; // média généraliste : on garde le sujet FR uniquement
  it._w = words(it.title);
  const g = groups.find((g) => g.kind === it.kind && (g.link === it.link || (it._w.size >= 4 && similar(g._w, it._w) >= 0.6)));
  if (g) {
    if (!g.sources.includes(it.source)) g.sources.push(it.source);
    g.sourceWeight = Math.max(g.sourceWeight, it.sourceWeight);
    if (!g.summary && it.summary) g.summary = it.summary;
    if (!g.image && it.image) g.image = it.image;
    if (g.via && !it.via) Object.assign(g, { link: it.link, via: undefined }); // préférer le lien direct au lien Google News
  } else {
    groups.push({ ...it, sources: [it.source] });
  }
}

const items = groups.map((g) => {
  const text = `${g.title} ${g.summary}`;
  const cats = categories.filter((c) => c.re.test(text));
  const ageH = (now - g.date) / 3600e3;
  const score =
    cats.reduce((s, c) => s + c.weight, 0) +
    g.sourceWeight +
    (g.sources.length - 1) * 3 + // plusieurs médias = sujet important
    (franceRe.test(text) ? 1 : 0) +
    Math.max(0, 2 - ageH / 12) +
    (g.curated ? 5 : 0);
  return {
    id: slug(g.title).slice(0, 80),
    kind: g.kind,
    title: g.title,
    url: g.link,
    summary: g.summary,
    image: g.image || undefined,
    author: g.author || undefined,
    sources: g.sources,
    via: g.via,
    date: g.date.toISOString(),
    categories: cats.map((c) => c.name),
    score: Math.round(score * 10) / 10,
  };
}).sort((a, b) => b.score - a.score);

// ---------- écriture ----------
await mkdir(DATA_DIR, { recursive: true });
const day = {
  date: runDate,
  generatedAt: now.toISOString(),
  windowHours,
  counts: { articles: items.filter((i) => i.kind === 'article').length, linkedin: items.filter((i) => i.kind === 'linkedin').length },
  linkedinSearch: Boolean(process.env.BRAVE_API_KEY),
  watchlist: linkedin.watchlist || [],
  sources: report,
  items,
};
await writeFile(path.join(DATA_DIR, `${runDate}.json`), JSON.stringify(day, null, 1));

// index des jours disponibles + purge des plus anciens
const files = (await readdir(DATA_DIR)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse();
for (const f of files.slice(KEEP_DAYS)) await unlink(path.join(DATA_DIR, f));
const index = [];
for (const f of files.slice(0, KEEP_DAYS)) {
  const d = JSON.parse(await readFile(path.join(DATA_DIR, f), 'utf8'));
  index.push({ date: d.date, ...d.counts, top: d.items[0]?.title });
}
await writeFile(path.join(DATA_DIR, 'index.json'), JSON.stringify({ updatedAt: now.toISOString(), days: index }, null, 1));

const failed = report.filter((r) => !r.ok);
console.log(`[${runDate}] ${raw.length} éléments collectés → ${fresh.length} récents → ${items.length} retenus (${day.counts.articles} articles, ${day.counts.linkedin} LinkedIn)`);
for (const f of failed) console.warn(`  ⚠ ${f.source} : ${f.error}`);
if (failed.length === report.length && report.length) process.exit(1);
