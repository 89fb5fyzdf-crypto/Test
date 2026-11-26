// Base des levées de fonds (page Funding du site).
// Reconstruite à chaque collecte à partir de tous les jours conservés dans le dossier de données :
// une levée = un sujet du thème « Levées de fonds » / « Funding » avec un montant identifiable.
// Écrit <dossier>/funding.json.
//
// Utilisable seul pour reconstruire la base : node scripts/funding.mjs [--scope eu]

import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Conversion approximative en euros (taux fixes, pour comparer et additionner ; le montant
// d'origine reste affiché).
const TO_EUR = { EUR: 1, USD: 0.92, GBP: 1.17, CHF: 1.05, SEK: 0.087, NOK: 0.085, DKK: 0.134 };
const FUNDING = new Set(['Levées de fonds', 'Funding']);

// Montants : « 4,7 millions d'euros », « 25 M€ », « $500m », « €1.2bn », « £2.1M », « 2 billion dollars »…
const MONEY = /(?:([€$£])\s?(\d+(?:[.,]\d+)?)\s?(bn|billion|md|mds|m|mn|million|k)\b|(\d+(?:[.,]\d+)?)\s?(milliards?|millions?|billions?|mds?|bn|m|k)\s?(?:d['’]\s?euros|de dollars|de livres|d['’]euros|euros?|dollars?|pounds?|€|\$|£|chf|sek|nok|dkk)|(\d+(?:[.,]\d+)?)\s?(m€|md€|k€))/gi;

function parseMoney(text = '') {
  const out = [];
  for (const m of text.matchAll(MONEY)) {
    const raw = m[0];
    const n = parseFloat((m[2] || m[4] || m[7]).replace(',', '.'));
    const unit = (m[3] || m[5] || m[8] || '').toLowerCase();
    const mult = /^(bn|billion|md|mds|milliard)/.test(unit) || unit === 'md€' ? 1000 : /^k/.test(unit) ? 0.001 : 1;
    const cur = /\$|dollar/i.test(raw) ? 'USD' : /£|pound|livre/i.test(raw) ? 'GBP' : /chf/i.test(raw) ? 'CHF' : /sek/i.test(raw) ? 'SEK'
      : /nok/i.test(raw) ? 'NOK' : /dkk/i.test(raw) ? 'DKK' : 'EUR';
    // Un montant juste avant ou après « valuation / valorisation » est une valorisation, pas une levée.
    const before = text.slice(Math.max(0, m.index - 28), m.index).toLowerCase();
    const after = text.slice(m.index + raw.length, m.index + raw.length + 14).toLowerCase();
    const isValuation = /valu|valoris/.test(before) || /^\s*(val|valorisation)/.test(after);
    out.push({ raw: raw.trim(), millions: n * mult, currency: cur, isValuation });
  }
  return out;
}

// Nom de l'entreprise :
//  - sujet du verbe de levée (« Plural raises… », « QLUSTER lève… ») : le groupe de mots en
//    majuscule juste avant le verbe ;
//  - ou complément d'un verbe d'investissement (« Deutsche Telekom investit … dans Mistral »,
//    « UK government backs Agon Dynamics »).
// Les noms écrits en capitales (FrenchWeb) sont remis en casse normale.
const RAISE = /\s(?:raises|raised|secures|secured|lands|bags|closes|nabs|scores|completes|lève|lèvent|boucle|obtient|reçoit|réalise une levée|annonce une levée)\b/i;
const INVEST = /\b(?:investit|investissent|injecte|invests?|backs?)\b/i;
const FUNDING_VERB = new RegExp(`${RAISE.source}|${INVEST.source}|lev[ée]e de fonds|tour de table|funding round|\\braises?\\b|\\bround\\b|brings total funding`, 'i');
const GENERIC = new Set(`startup start-up scaleup scale-up la le les l the a an uk british french european german dutch swedish finnish danish norwegian spanish italian swiss irish polish ukrainian nordic
london paris berlin munich stockholm amsterdam helsinki copenhagen oslo madrid barcelona lisbon milan zurich dublin vienna tallinn warsaw exclusive exclusif
fintech healthtech medtech biotech deeptech climate tech ai ia robotics robotique saas jeune pépite government gouvernement defence defense défense startups spinout`.split(/\s+/));
const SUFFIX = /^(AI|IA|Labs?|Tech|Bio|Robotics|Systems|Technologies|Health|Energy|Space|Quantum|Security)$/;
const nice = (w) => (/^[A-Z0-9&.-]{5,}$/.test(w) ? w.charAt(0) + w.slice(1).toLowerCase() : w);
const tokens = (t) => t.replace(/[’']s\b/g, '').split(/\s+/).map((x) => x.replace(/^[^\p{L}\d]+|[^\p{L}\d.&-]+$/gu, '')).filter(Boolean);
const isName = (t) => /^\p{Lu}/u.test(t) && t.length >= 2 && !/^[A-Z]{1,2}$/.test(t) && !GENERIC.has(t.toLowerCase())
  && !/-(based|backed|born|headquartered)$/i.test(t) && !/^(million|millions|billion|value|valuation|round|series|seed)$/i.test(t);
function companyOf(title) {
  const raise = title.match(RAISE);
  if (raise && raise.index <= 90) {
    const before = title.slice(0, raise.index).replace(/^.*?:\s+/, '');
    // « le fondateur de Brevo lève… », « PolyAI's ex-ML chief raises… » : une personne, pas l'entreprise.
    if (!/(fondateur|founder|chief|ceo|ex-|former|alums?|anciens? de|backer)\b[^,]*$/i.test(before)) {
      const toks = tokens(before);
      while (toks.length && GENERIC.has(toks[toks.length - 1].toLowerCase()) && !SUFFIX.test(toks[toks.length - 1])) toks.pop(); // « … Start-Up Raises »
      const run = [];
      // « Genesis AI », « Isomorphic Labs » : suffixes gardés quand ils suivent un nom.
      let i = toks.length - 1;
      while (i > 0 && SUFFIX.test(toks[i]) && isName(toks[i - 1])) run.unshift(toks[i--]);
      for (; i >= 0 && isName(toks[i]); i--) run.unshift(nice(toks[i]));
      if (run.length && run.join(' ').length <= 40) return run.join(' ');
      // Nom en minuscules juste avant le verbe : « Swiss startup coprod raises », « each::labs bags ».
      const last = toks[toks.length - 1], prev = tokens(before).slice(-2)[0];
      if (!run.length && last && /^[a-z][\w:.&-]{2,}$/.test(last) && !COMMON.has(last) && (toks.length === 1 || GENERIC.has((prev || '').toLowerCase()) || /-(backed|based)$/i.test(prev || '')))
        return last;
    }
  }
  // « … funding round in Isomorphic Labs », « … investment in Agon »
  const inRound = title.match(/\b(?:round|investment|stake|series [a-f]\w*)\s+(?:in|into|for)\s+((?:\p{Lu}[\w'’&.-]*\s?){1,3})/iu);
  if (inRound) {
    const run = tokens(inRound[1]).filter((t, k) => isName(t) || (k > 0 && SUFFIX.test(t)));
    if (run.length) return run.map(nice).join(' ');
  }
  const inv = title.match(INVEST);
  if (inv) {
    const after = tokens(title.slice(inv.index + inv[0].length)).slice(0, 8);
    const start = after.findIndex(isName);
    if (start >= 0) {
      const run = [];
      for (let i = start; i < after.length && isName(after[i]) && run.length < 3; i++) run.push(nice(after[i]));
      return run.join(' ');
    }
  }
  return null;
}
// Mots distinctifs d'un titre (pour reconnaître la même levée racontée autrement).
const COMMON = new Set(`raises raised raise secures secured lands bags closes funding round series seed million millions billion euros dollars pounds
lève lèvent levée fonds pour avec dans sans plus startup start-up with from that this help helps build scale expand their into will
invest invests investit backs backed back leads mène années`.split(/\s+/));
const keyWords = (t) => new Set(t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !COMMON.has(w) && !/^\d/.test(w)));

const ROUNDS = [
  [/pr[ée]-?seed/i, 'Pre-seed'], [/\bseed\b|amor[çc]age/i, 'Seed'],
  [/s[ée]rie[s]? a\b/i, 'Series A'], [/s[ée]rie[s]? b\b/i, 'Series B'], [/s[ée]rie[s]? c\b/i, 'Series C'],
  [/s[ée]rie[s]? [d-h]\b/i, 'Series D+'], [/growth|croissance|late.stage/i, 'Growth'],
];
const roundOf = (text) => (ROUNDS.find(([re]) => re.test(text)) || [])[1] || null;
const FUND_RE = /(?<!lev[ée]e de )(?:to back (?:europe|startups|founders|\w+ startups)|to invest in (?:startups|founders)|first close|final close|\b(?:new|first|second|third|debut|venture|vc|growth)\s+fund\b|\bfund\s+(?:i{1,3}|iv|v|\d)\b|raises? (?:a |its )?[€$£]?\s?[\d.,]+\s?(?:m|bn|million|billion)?\s?fund\b|closes? .*fund\b|(?:lance|boucle|clôture|annonce)\s+(?:un|son)\s+(?:nouveau\s+)?fonds|premier closing|(?<!lev[ée]e de )fonds de \d|fonds souverain)|\bfund\b/i;
const TALKS_RE = /in talks|\bseeks? (?:to raise|[€$£]|funding|investment)|looking to raise|is raising|reportedly rais|en discussion|cherche à lever|s'apprête à lever|would raise|could raise|plans to raise|selon nos informations/i;

function factOf(brief, key) {
  const legacy = { amount: 'Montant', round: 'Tour', valuation: 'Valorisation', investors: 'Investisseurs' };
  return brief?.facts?.find((f) => f.key === key || f.label === legacy[key])?.value || null;
}

export async function buildFunding(dataDir, lang = 'fr', { excludeCompaniesFrom } = {}) {
  const files = (await readdir(dataDir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort(); // du plus ancien au plus récent
  // Entreprises couvertes par l'autre édition (French Tech : on écarte les levées européennes
  // comme Isomorphic Labs que la presse française relaie aussi).
  const foreign = new Set();
  if (excludeCompaniesFrom) {
    for (const f of (await readdir(excludeCompaniesFrom).catch(() => [])).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x))) {
      const day = JSON.parse(await readFile(path.join(excludeCompaniesFrom, f), 'utf8'));
      for (const it of day.items || []) { const c = companyOf(it.title); if (c) foreign.add(c.toLowerCase()); }
    }
  }
  let foreignRounds = [];
  if (excludeCompaniesFrom) {
    try { foreignRounds = JSON.parse(await readFile(path.join(excludeCompaniesFrom, 'funding.json'), 'utf8')).rounds; } catch {}
  }
  const entries = [];
  for (const f of files) {
    const day = JSON.parse(await readFile(path.join(dataDir, f), 'utf8'));
    for (const it of day.items || []) {
      if (!it.categories?.some((c) => FUNDING.has(c))) continue;
      if (!FUNDING_VERB.test(it.title)) continue; // « Europe Has €10 Billion for Startups » : pas une levée
      if (/\bles lev[ée]es\b|baromètre|bilan|panorama|report\b|most-funded|h[12] 20\d\d|\bq[1-4] 20\d\d|on track|this year|so far|en 20\d\d|depuis le début/i.test(it.title)) continue; // synthèses
      if (/^(how|why|what|inside|when|comment|pourquoi|dans les coulisses)\b/i.test(it.title.replace(/^[^:]*:\s*/, ''))) continue; // analyses, récits
      const text = `${it.title}. ${it.summary || ''} ${it.brief?.essentiel || ''}`;
      // Montant : d'abord dans le titre, sinon dans le résumé ; jamais une valorisation.
      const money = [...parseMoney(it.title), ...parseMoney(`${it.summary || ''} ${it.brief?.essentiel || ''}`)]
        .find((m) => !m.isValuation && m.millions >= 0.05);
      if (!money) continue;
      // Résumés hebdomadaires qui citent plusieurs levées (« …, Isomorphic Labs bags $5B, and inside Plural's €1B fund »).
      if (parseMoney(it.title).length >= 2 || /,\s+and inside|this week|roundup|weekly|newsletter|recap/i.test(it.title)) continue;
      const company = companyOf(it.title);
      if (company && foreign.has(company.toLowerCase())) continue;
      // Grosse levée déjà dans l'autre édition (même montant à 3 % près, à moins de 10 jours).
      const eur = money.millions * (TO_EUR[money.currency] || 1);
      const words = keyWords(it.title);
      if (eur >= 50 && foreignRounds.some((r) => Math.abs(r.amountEur - eur) <= 0.03 * eur && Math.abs(new Date(r.date) - new Date(it.date)) < 10 * 864e5
        && (eur >= 1000 || [...keyWords(r.title)].some((w) => words.has(w))))) continue;
      entries.push({
        company,
        title: it.title,
        url: it.url,
        date: it.date,
        day: day.date,
        amount: money.raw,
        currency: money.currency,
        amountM: Math.round(money.millions * 1000) / 1000, // millions, devise d'origine
        amountEur: Math.round(money.millions * (TO_EUR[money.currency] || 1) * 100) / 100, // millions d'euros (approx.)
        round: roundOf(`${it.title} ${factOf(it.brief, 'round') || ''}`) || roundOf(text),
        valuation: factOf(it.brief, 'valuation') || parseMoney(text).find((m) => m.isValuation)?.raw || null,
        investors: factOf(it.brief, 'investors'),
        kind: FUND_RE.test(it.title) ? 'fund' : 'company',
        status: TALKS_RE.test(it.title) ? 'talks' : 'announced',
        categories: it.categories,
        articles: (it.articles || [{ source: it.sources?.[0], title: it.title, url: it.url }]).slice(0, 12),
        image: it.image || undefined,
        _words: keyWords(it.title),
      });
    }
  }

  // Même levée vue plusieurs fois : même entreprise à moins de 21 jours, ou même montant
  // (à 3 % près) à moins de 10 jours avec un mot distinctif en commun.
  const parent = entries.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const days = (a, b) => Math.abs(new Date(a.date) - new Date(b.date)) / 864e5;
  for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
    const a = entries[i], b = entries[j];
    const sameCompany = a.company && b.company && a.company.toLowerCase() === b.company.toLowerCase() && days(a, b) < 21;
    const sameAmount = Math.abs(a.amountEur - b.amountEur) <= 0.03 * Math.max(a.amountEur, b.amountEur) && days(a, b) < 10
      && [...a._words].some((w) => b._words.has(w));
    if (sameCompany || sameAmount || a.url === b.url) parent[find(j)] = find(i);
  }
  const groups = new Map();
  entries.forEach((e, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(e); });

  const rounds = [...groups.values()].map((g) => {
    g.sort((a, b) => new Date(a.date) - new Date(b.date));
    // Nom le plus fréquent, à défaut celui de l'article le plus relayé.
    const names = g.map((e) => e.company).filter(Boolean);
    const company = names.sort((x, y) => names.filter((n) => n === y).length - names.filter((n) => n === x).length)[0] || null;
    const best = [...g].sort((a, b) => b.articles.length - a.articles.length || (b.company === company) - (a.company === company))[0];
    const seen = new Set();
    const articles = g.flatMap((e) => e.articles).filter((a) => a?.url && !seen.has(a.url) && seen.add(a.url)).slice(0, 15);
    const pick = (k) => g.map((e) => e[k]).find(Boolean) || null;
    const { _words, ...rest } = best;
    return {
      ...rest, company, date: g[0].date, day: g[0].day, articles,
      round: pick('round'), valuation: pick('valuation'), investors: pick('investors'), image: pick('image') || undefined,
      kind: g.some((e) => e.kind === 'fund') ? 'fund' : 'company',
      status: g.some((e) => e.status === 'announced') ? 'announced' : 'talks',
    };
  }).sort((a, b) => new Date(b.date) - new Date(a.date));

  const out = { updatedAt: new Date().toISOString(), lang, days: files.length, rates: TO_EUR, rounds };
  await writeFile(path.join(dataDir, 'funding.json'), JSON.stringify(out, null, 1));
  return out;
}

// Exécution directe : reconstruit la base d'une édition.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const eu = process.argv.includes('--scope') && process.argv[process.argv.indexOf('--scope') + 1] === 'eu';
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dir = path.join(ROOT, 'docs', 'data', ...(eu ? ['eu'] : []));
  const res = await buildFunding(dir, eu ? 'en' : 'fr', eu ? {} : { excludeCompaniesFrom: path.join(dir, 'eu') });
  console.log(`${res.rounds.length} levées sur ${res.days} jours → ${path.join(dir, 'funding.json')}`);
}
