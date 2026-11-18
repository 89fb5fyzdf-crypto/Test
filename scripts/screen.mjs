#!/usr/bin/env node
// Screening quotidien French Tech : collecte les flux RSS + Google News,
// filtre, regroupe les articles qui parlent du même sujet, score,
// et écrit docs/data/AAAA-MM-JJ.json + docs/data/index.json.
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

const now = args.now ? new Date(args.now) : new Date();
const runDate = args.date || parisDate(now);
const windowHours = Number(args.hours || 36);
const since = new Date(now.getTime() - windowHours * 3600e3);

const sources = JSON.parse(await readFile(path.join(ROOT, 'config', 'sources.json'), 'utf8'));
const keywords = JSON.parse(await readFile(path.join(ROOT, 'config', 'keywords.json'), 'utf8'));

const franceRe = new RegExp(keywords.france.join('|'), 'i');
const categories = Object.entries(keywords.categories).map(([name, c]) => ({
  name, weight: c.weight, re: new RegExp(c.patterns.join('|'), 'i'),
}));
const EVENT_CATS = new Set(['Levées de fonds', 'Rachats & IPO']);

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
    let kept = 0;
    for (const it of parseFeed(await getText(url, slug(name)))) {
      if (!it.title || !it.link) continue;
      raw.push({ ...it, source: name, focus, sourceWeight: weight ?? 1 });
      kept++;
    }
    report.push({ source: name, ok: true, items: kept });
  } catch (e) {
    report.push({ source: name, ok: false, error: String(e.message || e) });
  }
}

async function collectGoogleNews(entry) {
  const { query, label, weight, focus = true } = typeof entry === 'string' ? { query: entry } : entry;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query + ' when:2d')}&hl=fr&gl=FR&ceid=FR:fr`;
  const name = label || `Google News · ${query}`;
  try {
    const items = parseFeed(await getText(url, slug(name)));
    for (const it of items) {
      // Les titres Google News se terminent par « - Nom du média ».
      const media = it.source || it.title.split(' - ').pop();
      const title = it.title.endsWith(` - ${media}`) ? it.title.slice(0, -(media.length + 3)) : it.title;
      raw.push({ ...it, title, summary: '', source: media, via: 'Google News', focus, sourceWeight: weight ?? 1 });
    }
    report.push({ source: name, ok: true, items: items.length });
  } catch (e) {
    report.push({ source: name, ok: false, error: String(e.message || e) });
  }
}

await Promise.all([...sources.feeds.map(collectFeed), ...sources.googleNews.map(collectGoogleNews)]);

// ---------- analyse des titres ----------
const STOP = new Set('le la les un une des de du et à a au aux en pour par sur dans avec qui que son sa ses ce cette est the of to and in for on with its'.split(' '));
const words = (s) => new Set(slug(s).split('-').filter((w) => w.length > 2 && !STOP.has(w)));
function similar(a, b) {
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / Math.max(1, Math.min(a.size, b.size));
}

// Mots en majuscule qui ne désignent pas une entreprise précise.
const GENERIC = new Set(`le la les l un une des de du d et à au aux en pour par sur dans avec ce cet cette ces son sa ses leur nos notre votre qui que quoi
comment pourquoi quand où quel quelle quels quelles voici voilà après avant face selon entre chez vers sans sous plus moins très tout tous toute
deux trois quatre cinq six sept huit neuf dix cent mille premier première nouveau nouvelle nouveaux
ia ai tech techno startup startups start-up scale-up licorne licornes company group groupe labs lab capital ventures partners holding sas sa
france français française french paris lyon europe européen européenne europe's eu états-unis usa us uk allemagne chine
robotique fintech healthtech medtech greentech cybersécurité cloud quantique cyber data énergie santé logistique
série seed séries ceo cto pdg dg exclusif exclusive interview tribune podcast vidéo infographie édito
janvier février mars avril mai juin juillet août septembre octobre novembre décembre lundi mardi mercredi jeudi vendredi samedi dimanche
the a an how why what who when is are this that new first top best
bpifrance station french-tech gouvernement état etat bourse cac`.split(/\s+/));

// Noms propres d'un titre : mots qui commencent par une majuscule (ou entièrement en
// majuscules), regroupés quand ils se suivent (« H Company », « Genesis AI »).
function entitiesOf(title) {
  const out = new Set();
  const initialOnly = new Set(); // « Enquête », « Comprendre »… : majuscule seulement parce qu'en tête de titre
  const tokens = title.replace(/[«»“”"’'():;,!?|–—]/g, ' $& ').split(/\s+/).filter(Boolean);
  let phrase = [];
  let start = -1;
  const flush = () => {
    if (phrase.length) {
      const full = phrase.map((w) => w.toLowerCase()).join(' ');
      if (phrase.length > 1 && phrase.some((w) => !GENERIC.has(w.toLowerCase()))) out.add(full);
      for (const w of phrase) {
        const k = w.toLowerCase();
        if (k.length < 3 || GENERIC.has(k) || /^\d/.test(k)) continue;
        out.add(k);
        if (start === 0 && phrase.length === 1 && !/\p{Lu}/u.test(w.slice(1))) initialOnly.add(k);
      }
    }
    phrase = [];
  };
  tokens.forEach((t, i) => {
    const clean = t.replace(/^[^\p{L}\d]+|[^\p{L}\d]+$/gu, '');
    const cap = /^\p{Lu}/u.test(clean) || (/^[\p{Lu}\d&.-]{2,}$/u.test(clean) && /\p{Lu}/u.test(clean));
    if (clean && cap) {
      if (!phrase.length) start = i;
      phrase.push(clean);
    } else flush();
  });
  flush();
  return { all: out, initialOnly };
}

// ---------- filtrage ----------
const fresh = raw
  .filter((it) => it.date && !isNaN(it.date) && it.date >= since && it.date <= new Date(now.getTime() + 3600e3))
  .filter((it) => it.focus || franceRe.test(`${it.title} ${it.summary}`)) // média généraliste : sujet FR uniquement
  .map((it) => {
    const text = `${it.title} ${it.summary}`;
    return { ...it, _w: words(it.title), _ent: entitiesOf(it.title), _c: new Set(categories.filter((c) => c.re.test(text)).map((c) => c.name)) };
  });

// Un nom n'est retenu que s'il apparaît au moins une fois ailleurs qu'en tête de titre
// (ou avec des majuscules internes : « OVHcloud », « QONTO »).
const confirmed = new Set();
for (const it of fresh) for (const e of it._ent.all) if (!it._ent.initialOnly.has(e)) confirmed.add(e);
for (const it of fresh) it._e = new Set([...it._ent.all].filter((e) => confirmed.has(e)));

// Un nom cité dans beaucoup d'articles du jour (ex. « Mistral ») peut couvrir
// plusieurs sujets différents : il faut alors plus de mots en commun.
const entityFreq = new Map();
for (const it of fresh) for (const e of it._e) entityFreq.set(e, (entityFreq.get(e) || 0) + 1);
const MAX_ENTITY_FREQ = Math.max(6, Math.round(fresh.length / 25));

function sameStory(a, b) {
  if (a.link === b.link) return true;
  const sim = similar(a._w, b._w);
  if (Math.min(a._w.size, b._w.size) >= 4 && sim >= 0.6) return true;
  const shared = [...a._e].filter((e) => b._e.has(e));
  if (!shared.length) return false;
  const freq = Math.min(...shared.map((e) => entityFreq.get(e)));
  if (freq <= 3 && sim >= 0.2) return true; // nom rare (une entreprise précise) + un autre mot en commun
  // Même entreprise + même type d'événement (levée, rachat) le même jour = même sujet.
  if ([...a._c].some((c) => EVENT_CATS.has(c) && b._c.has(c))) return true;
  return sim >= (freq <= MAX_ENTITY_FREQ ? 0.3 : 0.45);
}

// ---------- regroupement ----------
// Union-find sur toutes les paires d'articles : le résultat ne dépend pas de l'ordre.
const parent = fresh.map((_, i) => i);
const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
for (let i = 0; i < fresh.length; i++)
  for (let j = i + 1; j < fresh.length; j++)
    if (find(i) !== find(j) && sameStory(fresh[i], fresh[j])) parent[find(j)] = find(i);

// Dans chaque groupe, la source la plus fiable fournit le titre et le lien.
const rank = (a, b) => (b.sourceWeight - a.sourceWeight) || (a.via ? 1 : 0) - (b.via ? 1 : 0) || b.summary.length - a.summary.length;
const byRoot = new Map();
fresh.forEach((it, i) => {
  const r = find(i);
  if (!byRoot.has(r)) byRoot.set(r, []);
  byRoot.get(r).push(it);
});
const groups = [...byRoot.values()].map((members) => {
  members.sort(rank);
  return { members, _c: new Set(members.flatMap((m) => [...m._c])) };
});

// ---------- scoring ----------
const items = groups.map(({ members, _c }) => {
  const lead = members[0];
  const sourcesList = [...new Set(members.map((m) => m.source))];
  const cats = categories.filter((c) => _c.has(c.name));
  const date = new Date(Math.min(...members.map((m) => m.date)));
  const ageH = (now - Math.max(...members.map((m) => m.date))) / 3600e3;
  const text = members.map((m) => m.title).join(' ');
  const score =
    cats.reduce((s, c) => s + c.weight, 0) +
    Math.max(...members.map((m) => m.sourceWeight)) +
    Math.min(sourcesList.length - 1, 5) * 3 + // plusieurs médias = sujet important
    (franceRe.test(text) ? 1 : 0) +
    Math.max(0, 2 - ageH / 12);
  const seen = new Set([lead.link]);
  return {
    id: slug(lead.title).slice(0, 80),
    title: lead.title,
    url: lead.link,
    summary: lead.summary || members.find((m) => m.summary)?.summary || '',
    image: members.find((m) => m.image)?.image || undefined,
    sources: sourcesList,
    // Autres articles sur le même sujet (un par média).
    related: members.slice(1).filter((m) => !seen.has(m.link) && seen.add(m.link)).filter((m, i, arr) => arr.findIndex((x) => x.source === m.source) === i)
      .slice(0, 6).map((m) => ({ source: m.source, title: m.title, url: m.link })),
    date: date.toISOString(),
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
  counts: { articles: items.length, raw: fresh.length, media: new Set(items.flatMap((i) => i.sources)).size },
  sources: report.sort((a, b) => a.source.localeCompare(b.source, 'fr')),
  items,
};
await writeFile(path.join(DATA_DIR, `${runDate}.json`), JSON.stringify(day, null, 1));

// index des jours disponibles + purge des plus anciens
const files = (await readdir(DATA_DIR)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse();
for (const f of files.slice(KEEP_DAYS)) await unlink(path.join(DATA_DIR, f));
const index = [];
for (const f of files.slice(0, KEEP_DAYS)) {
  const d = JSON.parse(await readFile(path.join(DATA_DIR, f), 'utf8'));
  index.push({ date: d.date, articles: d.items.length, top: d.items[0]?.title });
}
await writeFile(path.join(DATA_DIR, 'index.json'), JSON.stringify({ updatedAt: now.toISOString(), days: index }, null, 1));

const failed = report.filter((r) => !r.ok);
console.log(`[${runDate}] ${raw.length} articles collectés → ${fresh.length} récents et pertinents → ${items.length} sujets`);
for (const f of failed) console.warn(`  ⚠ ${f.source} : ${f.error}`);
if (failed.length === report.length && report.length) process.exit(1);
