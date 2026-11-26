#!/usr/bin/env node
// Screening quotidien : collecte les flux RSS + Google News, filtre, regroupe les articles
// qui parlent du même sujet, score, et écrit les données du site.
//   French Tech   (par défaut)  : config/sources.json + keywords.json       → docs/data/
//   European Tech (--scope eu)  : config/sources-eu.json + keywords-eu.json → docs/data/eu/
//
// Usage : node scripts/screen.mjs [--scope eu] [--date AAAA-MM-JJ] [--hours 36] [--fixtures dossier]
//   --fixtures : lit des fichiers XML locaux (nommés <slug>.xml) au lieu du réseau (tests).

import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

const SCOPE = args.scope === 'eu' ? 'eu' : 'fr';
const SUFFIX = SCOPE === 'eu' ? '-eu' : '';
const DATA_DIR = path.join(ROOT, 'docs', 'data', ...(SCOPE === 'eu' ? ['eu'] : []));
const sources = JSON.parse(await readFile(path.join(ROOT, 'config', `sources${SUFFIX}.json`), 'utf8'));
const keywords = JSON.parse(await readFile(path.join(ROOT, 'config', `keywords${SUFFIX}.json`), 'utf8'));
const LANG = sources.lang || 'fr';
const GN = sources.googleNewsEdition || 'hl=fr&gl=FR&ceid=FR:fr';

// Zone géographique couverte (sert à filtrer les médias généralistes et à scorer).
const franceRe = new RegExp((keywords.geo || keywords.france).join('|'), 'i');
// Sujets à écarter (European Tech : tout ce qui concerne la France).
const excludeRe = sources.exclude?.length ? new RegExp(sources.exclude.join('|'), 'i') : null;
// Bruit à écarter d'office (promotions, épargne, événements, listes de cadeaux…), sur le titre.
const noiseRe = keywords.noise?.length ? new RegExp(keywords.noise.join('|'), 'i') : null;
const categories = Object.entries(keywords.categories).map(([name, c]) => {
  const re = new RegExp(c.patterns.join('|'), 'i');
  const ex = c.exclude?.length ? new RegExp(c.exclude.join('|'), 'gi') : null;
  return { name, weight: c.weight, test: (text) => re.test(ex ? text.replace(ex, ' ') : text) };
});
const EVENT_CATS = new Set(keywords.events || ['Levées de fonds', 'Rachats & IPO']);
const FUNDING = keywords.funding || 'Levées de fonds';

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

// Retire les mentions automatiques ajoutées par les flux (« L'article … est apparu en premier sur … »,
// rubrique · auteur · date en tête, liens « Lire l'article sur … », appels à s'abonner).
function cleanText(s = '') {
  return s
    .replace(/(L[’']article|The post) .{0,300}? (est apparu en premier sur|appeared first on) .*$/i, '')
    .replace(/Lire l[’']article sur .*$/i, '')
    .replace(/(Depuis \d{4}, \w+ décrypte|Recevoir la sélection|Abonnez-vous|Inscrivez-vous à notre newsletter).*$/i, '')
    .replace(/^[A-ZÀ-Ü0-9 '&-]{2,40} · [^·]{2,60} · \d{2}\/\d{2}\/\d{4}\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Images : pièce jointe image du flux, ou 1re <img> du contenu de l'article.
function imageEnclosure(b) {
  const m = b.match(/<enclosure\b[^>]*>/i);
  return m && /type=["']image\//i.test(m[0]) ? attr(m[0], 'enclosure', 'url') : '';
}
function firstImg(html = '') {
  for (const m of html.matchAll(/<img\b[^>]*?\bsrc=["']([^"']+)["'][^>]*>/gi)) {
    const w = m[0].match(/\bwidth=["']?(\d+)/i);
    if (w && Number(w[1]) < 200) continue; // pictos, pixels de suivi
    if (/^https?:\/\//.test(m[1]) && !/gravatar|emoji|pixel|feedburner|doubleclick/i.test(m[1])) return m[1];
  }
  return '';
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
      summary: cleanText(stripHtml(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content'))).slice(0, 400),
      content: cleanText(stripHtml(tag(b, 'content:encoded') || tag(b, 'content'))).slice(0, 5000),
      image: attr(b, 'media:content', 'url') || attr(b, 'media:thumbnail', 'url') || imageEnclosure(b) ||
        firstImg(decode(tag(b, 'content:encoded'))) || firstImg(decode(tag(b, 'description'))),
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
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query + ' when:2d')}&${GN}`;
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
const STOP = new Set('le la les un une des de du et à a au aux en pour par sur dans avec qui que son sa ses ce cette est the of to and in for on with its from has have will into over after says as at by an is are was its its new'.split(' '));
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
bpifrance station french-tech gouvernement état etat bourse cac
raises raise raised raising secures secured lands bags closes closed funding round rounds series million millions billion bn mn
startup startups scaleup scaleups unicorn unicorns decacorn europe european europe's uk british britain london berlin german germany
investors investor backed backs led leads deal deals buys acquires acquisition acquired merger ipo listing valuation valued
fintech healthtech climate climatetech defence defense deeptech saas platform app apps
says said report reports exclusive analysis opinion podcast newsletter week weekly daily today
how why what who when where which with without into after before over under from for and the its their our your
launches launch plans plan announces new big biggest top best more most first last year years month months
january february march april may june july august september october november december monday tuesday wednesday thursday friday`.split(/\s+/));

// Noms propres d'un titre : mots qui commencent par une majuscule (ou entièrement en
// majuscules), regroupés quand ils se suivent (« H Company », « Genesis AI »).
function entitiesOf(title) {
  const out = new Set();
  const initialOnly = new Set(); // « Enquête », « Comprendre »… : majuscule seulement parce qu'en tête de titre
  const tokens = title.replace(/[«»“”"’'():;,!?|–—]/g, ' $& ').split(/\s+/).filter(Boolean);
  const long = tokens.filter((t) => t.length > 3 && /^\p{L}/u.test(t));
  const titleCase = long.length >= 4 && long.filter((t) => /^\p{Lu}/u.test(t)).length / long.length > 0.6;
  let phrase = [];
  let start = -1;
  const flush = () => {
    if (phrase.length) {
      const full = phrase.map((w) => w.toLowerCase()).join(' ');
      if (phrase.length > 1 && phrase.some((w) => !GENERIC.has(w.toLowerCase()))) out.add(full);
      // « Stark Future Is a Unicorn » → aussi « stark future » (nom de deux mots en tête de groupe).
      if (phrase.length > 2 && !GENERIC.has(phrase[0].toLowerCase()) && !GENERIC.has(phrase[1].toLowerCase())) out.add(phrase.slice(0, 2).join(' ').toLowerCase());
      for (const w of phrase) {
        const k = w.toLowerCase();
        if (k.length < 3 || GENERIC.has(k) || /^\d/.test(k)) continue;
        out.add(k);
        if ((start === 0 && phrase.length === 1 || titleCase) && !/\p{Lu}/u.test(w.slice(1))) initialOnly.add(k);
      }
    }
    phrase = [];
  };
  tokens.forEach((t, i) => {
    const clean = t.replace(/[’']s$/u, '').replace(/^[^\p{L}\d]+|[^\p{L}\d]+$/gu, '');
    const cap = /^\p{Lu}/u.test(clean) || (/^[\p{Lu}\d&.-]{2,}$/u.test(clean) && /\p{Lu}/u.test(clean));
    if (clean && cap) {
      if (!phrase.length) start = i;
      phrase.push(clean);
    } else flush();
  });
  flush();
  return { all: out, initialOnly, titleCase };
}

// Le sujet d'un verbe d'action (« Plural raises… », « Qonto obtient… ») est l'entreprise :
// on retient le dernier groupe de mots en majuscule avant le verbe.
const ACTION = /\s(?:raises?|raised|secures?|secured|lands|bags|closes|hits|reaches|nabs|acquires|buys|snaps up|launches|valued|lève|lèvent|boucle|rachète|obtient|annonce)\b/i;
function subjectOf(title) {
  const m = title.match(ACTION);
  if (!m || m.index > 80) return [];
  const toks = title.slice(0, m.index).replace(/[’']s\b/g, '').split(/\s+/).map((t) => t.replace(/^[^\p{L}\d]+|[^\p{L}\d]+$/gu, '')).filter(Boolean);
  const run = [];
  for (let i = toks.length - 1; i >= 0; i--) {
    if (/^\p{Lu}/u.test(toks[i]) && !GENERIC.has(toks[i].toLowerCase())) run.unshift(toks[i].toLowerCase());
    else if (run.length) break;
  }
  return run.length ? [run.join(' '), ...run.filter((w) => w.length >= 3)] : [];
}

// ---------- filtrage ----------
const fresh = raw
  .filter((it) => it.date && !isNaN(it.date) && it.date >= since && it.date <= new Date(now.getTime() + 3600e3))
  .filter((it) => it.focus || franceRe.test(`${it.title} ${it.summary}`)) // média généraliste : sujet de la zone uniquement
  .filter((it) => !excludeRe || !excludeRe.test(`${it.title} ${it.summary}`))
  .filter((it) => !noiseRe || !noiseRe.test(it.title))
  .map((it) => {
    const text = `${it.title} ${it.summary}`;
    // Les résumés (écrits normalement) confirment les noms propres des titres en « Title Case ».
    const fromSummary = entitiesOf(it.summary || '');
    const ent = entitiesOf(it.title);
    for (const e of subjectOf(it.title)) { ent.all.add(e); ent.initialOnly.delete(e); }
    return { ...it, _w: words(it.title), _ent: ent, _sum: fromSummary, _c: new Set(categories.filter((c) => c.test(text)).map((c) => c.name)) };
  });

// Un nom n'est retenu que s'il apparaît au moins une fois ailleurs qu'en tête de titre
// (ou avec des majuscules internes : « OVHcloud », « QONTO »).
const confirmed = new Set();
for (const it of fresh) for (const src of [it._ent, it._sum]) for (const e of src.all) if (!src.initialOnly.has(e)) confirmed.add(e);

// European Tech : une entreprise déjà présente dans l'édition French Tech du jour est française
// (« Genesis AI raises $500m » ne dit pas qu'elle est parisienne) : on l'écarte.
const GLOBAL_NAMES = new Set('nvidia google alphabet microsoft openai anthropic amazon aws apple meta samsung zoom sequoia accel index tiger softbank a16z andreessen lightspeed general atlantic goldman sachs jpmorgan blackrock eqt balderton atomico creandum northzone eu europe commission'.split(' '));
let frenchNames = new Set();
if (SCOPE === 'eu') {
  const frFile = path.join(ROOT, 'docs', 'data', `${runDate}.json`);
  if (existsSync(frFile)) {
    const fr = JSON.parse(await readFile(frFile, 'utf8'));
    for (const item of fr.items) for (const a of item.articles || [{ title: item.title }]) {
      for (const e of [...subjectOf(a.title), ...entitiesOf(a.title).all]) if (e.length >= 4 && !GLOBAL_NAMES.has(e) && !GENERIC.has(e)) frenchNames.add(e);
    }
  }
}
const isFrench = (it) => subjectOf(it.title).some((e) => frenchNames.has(e));
// Dans un titre en « Title Case », un mot isolé n'est un nom que s'il est le sujet du verbe
// (sinon « Model » de « Tunable Decision Model » rejoindrait « Model ML »).
for (const it of fresh) it._e = new Set([...it._ent.all].filter((e) => confirmed.has(e) && !(it._ent.titleCase && it._ent.initialOnly.has(e))));

// Un nom cité dans beaucoup d'articles du jour (ex. « Mistral ») peut couvrir
// plusieurs sujets différents : il faut alors plus de mots en commun.
for (let k = fresh.length - 1; k >= 0; k--) if (isFrench(fresh[k])) fresh.splice(k, 1);
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

// ---------- résumé sans IA ----------
// Phrases les plus informatives des articles du sujet + chiffres clés repérés par motifs.
const MONEY_FR = /(\d+(?:[,.]\d+)?)\s*(milliards?|millions?|Mds?|M)\s*(?:d['’]euros|de dollars|d['’]\s?euros|€|\$|euros|dollars)/i;
const MONEY_EN = /(?:[€$£]\s?(\d+(?:[.,]\d+)?)\s?(bn|billion|m|mn|million)\b|(\d+(?:[.,]\d+)?)\s?(billion|million)\s(?:euros?|dollars?|pounds?))/i;
const MONEY = LANG === 'en' ? MONEY_EN : MONEY_FR;
function millions(text) {
  const m = text.match(MONEY);
  if (!m) return 0;
  const n = parseFloat((m[1] || m[3] || '0').replace(',', '.'));
  const unit = (m[2] || m[4] || '').toLowerCase();
  return /^(milliard|md|bn|billion)/.test(unit) ? n * 1000 : n;
}
const JUNK = /cookie|abonn|newsletter|inscri|lire aussi|à lire|crédit photo|©|cliquez|podcast|écoutez|en savoir plus|subscribe|sign up|read more|click here|listen|related:/i;
const splitSentences = (t) => t.split(/(?<=[.!?…])\s+(?=[«"“A-ZÀ-Ü0-9])/).map((x) => x.trim());

// Chiffres clés (levées de fonds) : clés neutres, le site affiche les libellés dans sa langue.
const FACT_RE = LANG === 'en' ? {
  round: /\b(Series [A-F]\+?|pre-seed|seed)\b/i,
  valuation: /valu(?:ed|ation|ing)\s+(?:[\w'’]+\s+){0,3}?(?:at|of|to|above|around)\s*((?:more than |over |around |about )?[€$£]\s?\d+(?:[.,]\d+)?\s?(?:bn|billion|m|mn|million))/i,
  investors: /(?:co-led by|led by|backed by|with participation from|from investors including|investors include)\s+([^.;:()]{3,140})/gi,
  stop: /\s+(?:to|which|who|that|with|as|at a|valu\w*|bringing|taking|and (?:backed|with|joined|participation))\b|,\s+(?:which|who|the|bringing|taking|with)\b/i,
} : {
  round: /\b(s[ée]rie [A-F]|pr[ée]-?seed|seed|amor[çc]age|tour d['’]amor[çc]age)\b/i,
  valuation: /valoris\w*\s+(?:[\w'’]+\s+){0,3}?(?:à|autour de|de|plus de|environ)\s*((?:plus de |près de |environ )?\d+(?:[,.]\d+)?\s*(?:milliards?|millions?|Mds?)\s*(?:d['’]euros|de dollars|€|\$)?)/i,
  investors: /(?:co-?men[ée]e? par|men[ée]e? par|aupr[èe]s de|avec la participation de|soutenue? par)\s+([^.;:()]{3,140})/gi,
  stop: /\s+(?:pour|afin|qui|dont|et doit|ce|cette|valoris\w*)\b|,\s+(?:qui|ce|cette|pour)\b/i,
};
function buildFacts(text, cats) {
  const facts = [];
  const isFunding = cats.has(FUNDING);
  const money = text.match(MONEY);
  if (money && isFunding) facts.push({ key: 'amount', value: money[0].replace(/\s+/g, ' ') });
  const round = text.match(FACT_RE.round);
  if (round && isFunding) facts.push({ key: 'round', value: round[1].replace(/^./, (c) => c.toUpperCase()) });
  const val = text.match(FACT_RE.valuation);
  if (val) {
    facts.push({ key: 'valuation', value: val[1].trim() });
    // Le montant repéré n'est parfois que la valorisation (« valued at $75bn ») : on ne l'affiche pas deux fois.
    const amount = facts.find((f) => f.key === 'amount');
    if (amount && val[1].replace(/\s/g, '').includes(amount.value.replace(/\s/g, ''))) facts.splice(facts.indexOf(amount), 1);
  }
  if (isFunding) {
    for (const inv of text.matchAll(FACT_RE.investors)) {
      const who = inv[1].split(FACT_RE.stop)[0].replace(/[,\s]+$/, '');
      if (who.length >= 3 && who.length <= 90 && /\p{Lu}/u.test(who)) { facts.push({ key: 'investors', value: who }); break; }
    }
  }
  return facts;
}

function buildBrief(members, cats) {
  const seenS = [];
  const cands = [];
  members.forEach((m, mi) => {
    splitSentences(m._content).forEach((sentence, pos) => {
      if (sentence.length < 50 || sentence.length > 320 || JUNK.test(sentence)) return;
      const w = words(sentence);
      if (w.size < 5 || seenS.some((o) => similar(o, w) >= 0.55)) return;
      seenS.push(w);
      let score = 3 - Math.min(pos, 6) * 0.5 - mi * 0.15;
      if (MONEY.test(sentence)) score += 2;
      if (/\d/.test(sentence)) score += 0.5;
      score += categories.filter((c) => cats.has(c.name) && c.test(sentence)).length;
      cands.push({ sentence, score, mi, pos });
    });
  });
  if (!cands.length) return null;
  // L'essentiel : la 1re phrase de l'article le plus complet, sinon la meilleure phrase.
  const richest = members.reduce((a, b) => (b._content.length > a._content.length ? b : a));
  const first = cands.find((c) => members[c.mi] === richest && c.pos <= 1) || cands.reduce((a, b) => (b.score > a.score ? b : a));
  const points = cands.filter((c) => c !== first).sort((a, b) => b.score - a.score).slice(0, 4).map((c) => c.sentence);
  const allText = members.map((m) => `${m.title}. ${m._content.replace(/[.\s]*$/, '')}.`).join(' ');
  const facts = buildFacts(allText, cats);
  if (!points.length && !facts.length && first.sentence.length < 80) return null;
  return { essentiel: first.sentence, points, facts };
}

// ---------- scoring ----------
// Plus la levée est grosse, plus le sujet monte (European Tech : priorité aux mega levées).
function amountBonus(members) {
  const m = Math.max(0, ...members.map((x) => millions(`${x.title} ${x.summary}`)));
  return m >= 1000 ? 11 : m >= 250 ? 9 : m >= 100 ? 7 : m >= 50 ? 4 : m >= 20 ? 2 : 0;
}
// Poids du nombre de médias (European Tech : réduit, pour que le montant compte davantage).
const COVERAGE = sources.coverageWeight ?? 3;
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
    Math.min(sourcesList.length - 1, 5) * COVERAGE + // plusieurs médias = sujet important
    (franceRe.test(text) ? 1 : 0) +
    Math.max(0, 2 - ageH / 12) +
    (sources.amountBoost ? amountBonus(members) : 0);
  const seen = new Set([lead.link]);
  members.forEach((m) => (m._content = m.content || m.summary || ''));
  return {
    id: slug(lead.title).slice(0, 80),
    title: lead.title,
    url: lead.link,
    summary: lead.summary || members.find((m) => m.summary)?.summary || '',
    image: members.find((m) => m.image && !m.via)?.image || members.find((m) => m.image)?.image || undefined,
    sources: sourcesList,
    // Tous les articles du sujet (un par média), sans « source principale ».
    articles: [lead, ...members.slice(1).filter((m) => !seen.has(m.link) && seen.add(m.link))]
      .filter((m, i, arr) => arr.findIndex((x) => x.source === m.source) === i)
      .slice(0, 20).map((m) => ({ source: m.source, title: m.title, url: m.link })),
    brief: buildBrief(members, _c) || undefined,
    date: date.toISOString(),
    categories: cats.map((c) => c.name),
    score: Math.round(score * 10) / 10,
    _keep: cats.length > 0 || members.length > 1 || members.some((m) => m.focus && !m.via),
  };
})
  // Sans thème, un seul article et pas d'un média spécialisé : hors sujet (économie générale,
  // consommation, faits divers ramenés par Google News…).
  .filter((it) => it._keep)
  .map(({ _keep, ...it }) => it)
  .sort((a, b) => b.score - a.score);

// ---------- images et descriptions manquantes ----------
// Pour les sujets affichés (à la une et les plus relayés), on lit la page d'un des articles :
// image de partage (og:image) et description (og:description). Les liens Google News ne mènent
// pas directement à l'article : ils sont ignorés.
async function pageMeta(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FrenchTechScreener/1.0)', Accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
    if (!res.ok || !/html/i.test(res.headers.get('content-type') || '')) return {};
    const html = (await res.text()).slice(0, 300000);
    const meta = (names) => {
      const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["'](?:${names})["'][^>]*>`, 'i'));
      const c = m && m[0].match(/content=["']([^"']+)["']/i);
      return c ? decode(c[1]).trim() : '';
    };
    const img = meta('og:image(?::secure_url)?|twitter:image(?::src)?');
    const image = img ? new URL(img, res.url).href : '';
    return { image: /^https:\/\//.test(image) ? image : '', description: cleanText(stripHtml(meta('og:description|twitter:description|description'))) };
  } catch { return {}; }
}
const mostCovered = items.slice(5).sort((a, b) => b.articles.length - a.articles.length || b.score - a.score).slice(0, 10);
const shown = [...new Set([...items.slice(0, 8), ...mostCovered])];
const needMeta = shown.filter((i) => !i.image || (!i.summary && !i.brief));
let found = 0, described = 0;
if (!args.fixtures) {
  const queue = [...needMeta];
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const it = queue.shift();
      for (const a of it.articles.filter((x) => !/news\.google\./.test(x.url)).slice(0, 3)) {
        const meta = await pageMeta(a.url);
        if (!it.image && meta.image) { it.image = meta.image; found++; }
        if (!it.summary && !it.brief && meta.description?.length >= 60) { it.summary = meta.description.slice(0, 400); described++; }
        if (it.image && (it.summary || it.brief)) break;
      }
    }
  }));
}
console.log(`Images : ${items.filter((i) => i.image).length}/${items.length} sujets (dont ${found} trouvées sur les pages) · ${described} descriptions ajoutées`);

// ---------- écriture ----------
await mkdir(DATA_DIR, { recursive: true });
const day = {
  date: runDate,
  generatedAt: now.toISOString(),
  windowHours,
  counts: { articles: items.length, raw: fresh.length, media: new Set(items.flatMap((i) => i.sources)).size },
  scope: SCOPE,
  lang: LANG,
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

// Base des levées de fonds (page Funding), reconstruite à partir de tous les jours conservés.
const { buildFunding } = await import('./funding.mjs');
const funding = await buildFunding(DATA_DIR, LANG, SCOPE === 'fr' ? { excludeCompaniesFrom: path.join(DATA_DIR, 'eu') } : {});
console.log(`Levées de fonds : ${funding.rounds.length} sur ${funding.days} jours`);

const failed = report.filter((r) => !r.ok);
console.log(`[${SCOPE} ${runDate}] ${raw.length} articles collectés → ${fresh.length} récents et pertinents → ${items.length} sujets`);
for (const f of failed) console.warn(`  ⚠ ${f.source} : ${f.error}`);
if (failed.length === report.length && report.length) process.exit(1);
