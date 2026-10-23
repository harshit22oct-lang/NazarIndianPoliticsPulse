/* ==================================================================
 *  attack_lib.js -- "आज के सबसे बड़े हमले" (biggest attacks on BJP and
 *  the governments) for Nazar.  Pure functions; server.js does the I/O.
 *
 *   1. candidates()  -- no AI: original posts by non-BJP accounts that
 *                       name BJP / Modi / the government (Hindi + English)
 *   2. AI reader     -- labels each candidate once (attack? target? 1-5)
 *   3. AI checker    -- a second model re-reads only the posts heading for
 *                       the top; a post reaches the top two only if both agree
 *   4. board()       -- score = severity x reach; the top two are "sticky":
 *                       a newcomer must beat them by STICKY_MARGIN to take a slot
 *
 *  The Sentiment column of the data is NOT used: it was checked (Oct 2026)
 *  and does not match what the posts say.
 * ================================================================== */
'use strict';
var HA = require('./ha_lib.js');
var LIVE = require('./live_lib.js');

var C = {
  MIN_TEXT: 40,                 // shorter than this is rarely an argument
  BATCH: 5,                     // posts per request (Groq free: at most 1,000 output tokens a minute)
  CHECK_TOP: 6,                 // how many leading posts the checker re-reads
  STICKY_MARGIN: 1.15,          // a newcomer must score 15 % more to take a top-two slot
  LIST: 6                       // rows under the top two
};

/* state governments counted as "BJP / NDA governments". The ruling party of
   each state comes from handle_master.json (the record whose designation is
   Chief Minister); this is only the list of parties that count as NDA. */
var NDA = ['BJP', 'TDP', 'JD(U)', 'SHS', 'Shiv Sena', 'NCP', 'LJP (RV)', 'LJP(RV)', 'HAM', 'JD(S)', 'RLD', 'AGP', 'AINRC', 'NPP', 'NPF', 'SKM', 'UPPL', 'RLM'];

var MEDIA = ['Media House', 'Journalist'];
var TARGET_RX = new RegExp([
  '\\b(bjp|modi|pm|narendra|government|govt|sarkar|minister|cm|nda|rss|centre|center|union|amit shah|yogi|shah|ed|cbi|election commission|eci|jumla)\\b',
  'भाजपा', 'बीजेपी', 'मोदी', 'सरकार', 'मुख्यमंत्री', 'प्रधानमंत्री', 'योगी', 'शाह', 'मंत्री', 'आरएसएस', 'संघ', 'जुमला', 'केंद्र', 'चुनाव आयोग'
].join('|'), 'i');

function keyOf(r) { return String(r['Tweet URL'] || (r.Handle + '|' + r['Tweet Date'])); }

/* posts worth asking the AI about */
function candidates(rows) {
  return rows.filter(function (r) {
    if (HA.isRetweet(r)) return false;
    if (MEDIA.indexOf(r.Category) >= 0) return false;
    if (LIVE.normParty(r.Party) === 'BJP') return false;
    if (!/[a-zऀ-ॿ]/i.test(String(r['Candidate Name'] || '').replace(/^nan$/i, ''))) return false;   // unmapped accounts are not tracked leaders
    var t = String(r['Tweet Text'] || '');
    if (t.replace(/https?:\/\/\S+/g, '').trim().length < C.MIN_TEXT) return false;
    return TARGET_RX.test(t);
  });
}

/* ruling party per state, from the Chief Minister records of handle_master */
function rulingParties(master) {
  var out = {};
  Object.keys(master || {}).forEach(function (k) {
    var r = master[k] || {}, d = [r.designation_raw, r.designations, r.admin_designation].map(function (x) { return Array.isArray(x) ? x.join(',') : String(x || ''); }).join(' | ');
    if (!/\bchief minister\b/i.test(d) || /deputy|former|\bex-/i.test(d)) return;
    var st = LIVE.stateOf(r.state); if (st && r.party) out[st] = String(r.party).trim();
  });
  return out;
}
function isNdaGovt(state, ruling) { var p = ruling[state]; return !!p && NDA.indexOf(p) >= 0; }

/* ------------------------------------------------------------ prompts */
var RULES = [
  'You work for an Indian political media-monitoring team. You read posts (Hindi, English or Hinglish) written by Indian politicians who are NOT from the BJP.',
  'For every post decide whether it ATTACKS the BJP, the central (Union) government, or a state government. Reply with JSON only.',
  '',
  'attack = true only when the post criticises, accuses, mocks or blames: the BJP or its leaders/RSS; PM Modi, the Union government, a Union minister, or central agencies (ED, CBI, Election Commission) as tools of the government; or a state government / its Chief Minister.',
  'attack = false for praise, greetings, condolences, event photos, neutral news, the author\'s own work, and criticism of parties other than BJP when no government is blamed.',
  'target: "bjp" (party, its leaders, RSS), "centre" (PM, Union government, Union ministers, central agencies), "state" (a state government or its CM), or null when attack is false. If both BJP and the centre are attacked, use "centre".',
  'target_state: the English name of the state when target is "state" (e.g. "Uttar Pradesh"), otherwise null.',
  'severity (1-5, only when attack is true):',
  '  5 = grave allegation: corruption or scam, crime or violence blamed on the government, vote theft / election rigging, betrayal of the nation, deaths blamed on the government.',
  '  4 = strong accusation with a concrete harm: lies or betrayal towards farmers, youth, women, workers; attack on the Constitution, dictatorship, misuse of agencies.',
  '  3 = clear policy criticism or demand for accountability (prices, jobs, roads, a specific scheme).',
  '  2 = taunt or sarcasm with little substance ("jumla").',
  '  1 = passing jab inside an otherwise different post.',
  'topic: one or two English words (corruption, farmers, jobs, prices, law and order, women safety, elections, constitution, communal, health, education, foreign policy, other).',
  'summary_en: at most 14 words, neutral, ONLY what the post itself says. Never add facts, names or numbers that are not in the post.',
  'summary_hi: the same summary in simple Hindi (Devanagari).',
  'When attack is false, return only {"i":n,"attack":false} for that post (no other fields).',
  '',
  'Examples:',
  '"मोदी सरकार ने किसानों की पीठ में छुरा घोंपा, MSP का वादा झूठा निकला।" -> {"attack":true,"target":"centre","target_state":null,"severity":4,"topic":"farmers"}',
  '"Happy Diwali to everyone! May this festival bring joy to your family." -> {"attack":false,"target":null,"target_state":null,"severity":null,"topic":null}',
  '"UP में योगी सरकार के राज में एक और दलित बेटी की हत्या, पुलिस सो रही है।" -> {"attack":true,"target":"state","target_state":"Uttar Pradesh","severity":5,"topic":"law and order"}',
  '"BJP ne chunav aayog ke saath milkar vote chori ki hai, ye loktantra ki hatya hai" -> {"attack":true,"target":"bjp","target_state":null,"severity":5,"topic":"elections"}',
  '"पेट्रोल के दाम फिर बढ़े, आम आदमी कब तक सहेगा?" -> {"attack":true,"target":"centre","target_state":null,"severity":3,"topic":"prices"}',
  '"Met farmers of Sangrur today and listened to their problems about paddy procurement." -> {"attack":false,"target":null,"target_state":null,"severity":null,"topic":null}',
  '"जुमलों के बादशाह का एक और जुमला 😂" -> {"attack":true,"target":"centre","target_state":null,"severity":2,"topic":"other"}',
  '',
  'Answer format: {"results":[{"i":1,"attack":true,"target":"centre","target_state":null,"severity":4,"topic":"farmers","summary_en":"...","summary_hi":"..."}, ...]} with exactly one entry per post, using the same i.'
].join('\n');

var CHECK_RULES = RULES.replace('For every post decide', 'You are the second reviewer. Be strict: when in doubt, attack = false. For every post decide');

function cleanText(t) { return String(t || '').replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 700); }
function userMessage(posts) {
  return 'Posts:\n' + posts.map(function (r, i) {
    return (i + 1) + '. [' + (r['Candidate Name'] || r.Handle) + ', ' + (LIVE.normParty(r.Party) || 'no party') + ', ' + (r.State || '-') + '] ' + cleanText(r['Tweet Text']);
  }).join('\n');
}

/* the model's text -> { i: label } ; tolerant of code fences and <think> blocks */
var TARGETS = ['bjp', 'centre', 'state'];
function parseLabels(text, n) {
  var s = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '');
  var a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < a) return null;
  var j; try { j = JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
  var list = Array.isArray(j) ? j : (j.results || []);
  var out = {};
  list.forEach(function (x) {
    var i = +x.i; if (!(i >= 1 && i <= n)) return;
    var atk = x.attack === true || x.attack === 'true';
    var tg = atk && TARGETS.indexOf(String(x.target)) >= 0 ? String(x.target) : null;
    var sev = atk ? Math.max(1, Math.min(5, Math.round(+x.severity) || 0)) : null;
    if (atk && (!tg || !sev)) atk = false;
    out[i] = {
      attack: atk, target: atk ? tg : null,
      target_state: atk && tg === 'state' ? (LIVE.stateOf(x.target_state) || null) : null,
      severity: atk ? sev : null,
      topic: atk ? String(x.topic || 'other').slice(0, 30) : null,
      summary_en: atk ? String(x.summary_en || '').slice(0, 200) : null,
      summary_hi: atk ? String(x.summary_hi || '').slice(0, 200) : null
    };
  });
  return out;
}

/* ------------------------------------------------------------- board */
function reach(r) { return HA.num(r['Total Views']) + 20 * (HA.num(r['Total Likes']) + HA.num(r['Total Retweets'])); }
function scoreOf(sev, r) { return sev * sev * (1 + Math.log(1 + reach(r)) / Math.LN10); }

/* is this labelled post on the board for this scope? */
function relevant(lab, r, scopeState, ruling) {
  if (!lab || !lab.attack) return false;
  if (lab.target === 'state' && !(lab.target_state && isNdaGovt(lab.target_state, ruling))) return false;   // only BJP / NDA governments
  if (!scopeState) return true;
  if (lab.target === 'state') return lab.target_state === scopeState;
  return LIVE.stateOf(r.State) === scopeState;          // attacks on BJP / the centre made by that state's leaders
}

/* rows: window rows; labels: key -> {r: reader, c: checker}; prev: {top:[key,key]} or null */
function board(rows, labels, opts) {
  var scopeState = opts.state || null, ruling = opts.ruling || {}, prev = opts.prev || null;
  var items = [];
  rows.forEach(function (r) {
    var k = keyOf(r), L = labels[k]; if (!L || !L.r) return;
    if (!relevant(L.r, r, scopeState, ruling)) return;
    /* the checker re-read it: it must also call it an attack; the two severities are averaged */
    var verified = !!(L.c && L.c.attack);
    if (L.c && !verified) return;                         // the checker says it is not an attack: drop it
    var sev = verified ? Math.round((L.r.severity + L.c.severity) * 5) / 10 : L.r.severity;
    items.push({ key: k, row: r, lab: L.r, sev: sev, verified: verified, score: scoreOf(sev, r) });
  });
  items.sort(function (a, b) { return b.score - a.score; });
  /* one place per leader: their strongest attack stands for them */
  var seenH = {};
  items = items.filter(function (x) { var h = String(x.row.Handle || '').toLowerCase(); if (seenH[h]) return false; seenH[h] = 1; return true; });

  /* sticky top two: keep last time's holders unless someone beats them clearly */
  var byKey = {}; items.forEach(function (x) { byKey[x.key] = x; });
  var top = [];
  ((prev && prev.top) || []).forEach(function (k) { if (byKey[k] && byKey[k].verified) top.push(byKey[k]); });
  items.forEach(function (x) {
    if (!x.verified || top.indexOf(x) >= 0) return;
    if (top.length < 2) { top.push(x); return; }
    var weakest = top[0].score < top[1].score ? 0 : 1;
    if (x.score > top[weakest].score * C.STICKY_MARGIN) top[weakest] = x;
  });
  top.sort(function (a, b) { return b.score - a.score; });
  var rest = items.filter(function (x) { return top.indexOf(x) < 0; }).slice(0, C.LIST);
  return { top: top, rest: rest, keys: top.map(function (x) { return x.key; }), total: items.length };
}

module.exports = { C: C, NDA: NDA, candidates: candidates, rulingParties: rulingParties, isNdaGovt: isNdaGovt,
  RULES: RULES, CHECK_RULES: CHECK_RULES, userMessage: userMessage, parseLabels: parseLabels,
  keyOf: keyOf, scoreOf: scoreOf, board: board, relevant: relevant };
