/* ===========================================================================
 *  media_lib.js  --  the Media Room's rules (no network, no storage here;
 *  media_room.js fetches, stores and schedules).
 *
 *    * parseFeed     RSS / Atom (website feeds, YouTube channels, Google News)
 *    * makeTagger    narrative topics from the config's Hindi + English words,
 *                    and the states a headline is about
 *    * cluster       the same story from several sources -> one card
 *    * buildView     the screens for one area: topic lists, "hot right now",
 *                    official statements, latest per source, the ticker
 *
 *  NOTHING IS MADE UP: a headline, its link, source and time are the feed's own.
 *  A topic is only a keyword match; "hot" is only how many different sources
 *  carried the same story. A feed item without a date gets the time we first saw
 *  it, and is marked so.
 * =========================================================================== */
'use strict';
var crypto = require('crypto');

var IST = 19800000;
function istStr(ms) { return new Date(ms + IST).toISOString().slice(0, 16).replace('T', ' '); }

/* ---------------------------------------------------------------- parsing */
var ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…' };
function decode(s) {
  s = String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  for (var k = 0; k < 2; k++) {                // feeds often escape twice (&amp;quot;)
    s = s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (m, e) {
      if (e[0] === '#') { var n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return isFinite(n) && n > 0 ? String.fromCodePoint(n) : m; }
      var v = ENT[e.toLowerCase()]; return v === undefined ? m : v;
    });
  }
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
function tag(block, name) {
  var m = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i').exec(block);
  return m ? decode(m[1]) : '';
}
/* RFC-822, ISO, and the few Indian variants seen in the wild ("... IST", no zone = IST) */
function parseDate(s) {
  s = String(s || '').trim(); if (!s) return NaN;
  var t = Date.parse(s); if (isFinite(t)) return t;
  t = Date.parse(s.replace(/\s+IST$/i, ' +0530').replace(/GMT\s*\+\s*5:?30/i, '+0530')); if (isFinite(t)) return t;
  var m = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d)(?::(\d\d))?$/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) - IST;
  return NaN;
}
function parseFeed(xml) {
  var out = [], re = /<(item|entry)\b[\s\S]*?<\/\1>/gi, m;
  while ((m = re.exec(xml))) {
    var b = m[0], title = tag(b, 'title'), link = '';
    var al = /<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i.exec(b) || /<link\b[^>]*href=["']([^"']+)["']/i.exec(b);
    if (al) link = decode(al[1]); else link = tag(b, 'link') || tag(b, 'guid');
    var src = /<source\b[^>]*>([\s\S]*?)<\/source>/i.exec(b), srcUrl = /<source\b[^>]*url=["']([^"']+)["']/i.exec(b);
    var date = tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date');
    if (!title || !/^https?:\/\//i.test(link)) continue;
    var dom = srcUrl ? (/^https?:\/\/(?:www\.)?([^\/:?#]+)/i.exec(decode(srcUrl[1])) || [])[1] : '';
    out.push({ title: title, link: link, date: parseDate(date), publisher: src ? decode(src[1]) : '', domain: dom ? dom.toLowerCase() : '', video: /<yt:videoId>/i.test(b) });
  }
  return out;
}

/* one id per article: the link without tracking parameters */
function canonical(u) {
  var s = String(u || '').trim().replace(/#.*$/, '');
  var q = s.indexOf('?');
  if (q >= 0 && !/news\.google\.com/i.test(s)) {
    var keep = s.slice(q + 1).split('&').filter(function (kv) { return kv && !/^(utm_[a-z]+|fbclid|gclid|ref|ref_src|cmpid|from|src)=/i.test(kv); });
    s = s.slice(0, q) + (keep.length ? '?' + keep.join('&') : '');
  }
  return s.replace(/^http:/i, 'https:').replace(/\/+$/, '');
}
function idOf(u) { return crypto.createHash('sha1').update(canonical(u)).digest('hex').slice(0, 20); }
function isHindi(s) { var d = (String(s).match(/[ऀ-ॿ]/g) || []).length; return d > String(s).length * 0.25; }

/* ---------------------------------------------------------------- tagging */
/* Hindi has no \b: a word must START after a space / punctuation (so नीति is not found
   inside राजनीति); very short words must also END there (बंद is not प्रतिबंध). English:
   SHORT CAPS words (ED, SIR, EVM) match case-sensitively as whole words; short words
   match whole (poll, not pollution); longer words match as word starts (protest -> protesters). */
var HB = '(?:^|[\\s,.:;!?\'"‘’“”()\\[\\]/|।–—-])';
var HE = '(?=$|[\\s,.:;!?\'"‘’“”()\\[\\]/|।–—-])';
function esc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function wordRe(w) {
  w = String(w).trim(); if (!w) return null;
  if (/[ऀ-ॿ]/.test(w)) return new RegExp(HB + esc(w) + (w.length <= 3 ? HE : ''));
  if (/^[A-Z0-9()&]{2,6}$/.test(w)) return new RegExp('(?:^|[^A-Za-z])' + esc(w) + '(?:[^A-Za-z]|$)');
  if (w.length < 6) return new RegExp('\\b' + esc(w) + '(?:s|es)?\\b', 'i');
  return new RegExp('\\b' + esc(w), 'i');
}
function anyRe(words) {
  var res = (words || []).map(wordRe).filter(Boolean);
  return function (s) { for (var i = 0; i < res.length; i++) if (res[i].test(s)) return true; return false; };
}

var STATE_HI = {
  'Andhra Pradesh': 'आंध्र प्रदेश', 'Arunachal Pradesh': 'अरुणाचल प्रदेश', 'Assam': 'असम', 'Bihar': 'बिहार', 'Chhattisgarh': 'छत्तीसगढ़',
  'Goa': 'गोवा', 'Gujarat': 'गुजरात', 'Haryana': 'हरियाणा', 'Himachal Pradesh': 'हिमाचल प्रदेश', 'Jharkhand': 'झारखंड', 'Karnataka': 'कर्नाटक',
  'Kerala': 'केरल', 'Madhya Pradesh': 'मध्य प्रदेश', 'Maharashtra': 'महाराष्ट्र', 'Manipur': 'मणिपुर', 'Meghalaya': 'मेघालय', 'Mizoram': 'मिज़ोरम',
  'Nagaland': 'नागालैंड', 'Odisha': 'ओडिशा', 'Punjab': 'पंजाब', 'Rajasthan': 'राजस्थान', 'Sikkim': 'सिक्किम', 'Tamil Nadu': 'तमिलनाडु',
  'Telangana': 'तेलंगाना', 'Tripura': 'त्रिपुरा', 'Uttar Pradesh': 'उत्तर प्रदेश', 'Uttarakhand': 'उत्तराखंड', 'West Bengal': 'पश्चिम बंगाल',
  'Delhi': 'दिल्ली', 'Jammu and Kashmir': 'जम्मू और कश्मीर', 'Ladakh': 'लद्दाख', 'Puducherry': 'पुदुचेरी', 'Chandigarh': 'चंडीगढ़'
};
/* other names a headline uses for a state: big cities, short forms (Hindi + English) */
var STATE_ALSO = {
  'Uttar Pradesh': ['UP', 'Lucknow', 'Varanasi', 'Kanpur', 'Prayagraj', 'Ayodhya', 'Gorakhpur', 'Noida', 'Ghaziabad', 'Meerut', 'Agra', 'यूपी', 'लखनऊ', 'वाराणसी', 'कानपुर', 'प्रयागराज', 'अयोध्या', 'गोरखपुर', 'नोएडा', 'गाजियाबाद', 'ग़ाज़ियाबाद', 'मेरठ', 'आगरा'],
  'Bihar': ['Patna', 'Muzaffarpur', 'Bhagalpur', 'पटना', 'मुजफ्फरपुर', 'भागलपुर'],
  'West Bengal': ['Bengal', 'Kolkata', 'Howrah', 'Siliguri', 'बंगाल', 'कोलकाता', 'हावड़ा'],
  'Maharashtra': ['Mumbai', 'Pune', 'Nagpur', 'Thane', 'मुंबई', 'पुणे', 'नागपुर'],
  'Tamil Nadu': ['Chennai', 'Madurai', 'Coimbatore', 'चेन्नई'],
  'Karnataka': ['Bengaluru', 'Bangalore', 'Mysuru', 'बेंगलुरु', 'कर्नाटका'],
  'Kerala': ['Thiruvananthapuram', 'Kochi', 'Kozhikode'],
  'Telangana': ['Hyderabad', 'हैदराबाद'],
  'Andhra Pradesh': ['Amaravati', 'Visakhapatnam', 'Vijayawada'],
  'Gujarat': ['Ahmedabad', 'Surat', 'Gandhinagar', 'Vadodara', 'अहमदाबाद', 'गांधीनगर'],
  'Rajasthan': ['Jaipur', 'Jodhpur', 'Udaipur', 'जयपुर', 'जोधपुर', 'उदयपुर'],
  'Madhya Pradesh': ['Bhopal', 'Indore', 'Gwalior', 'Jabalpur', 'Ujjain', 'भोपाल', 'इंदौर', 'ग्वालियर', 'जबलपुर', 'उज्जैन'],
  'Chhattisgarh': ['Raipur', 'Bilaspur', 'रायपुर'],
  'Jharkhand': ['Ranchi', 'Jamshedpur', 'Dhanbad', 'रांची', 'धनबाद'],
  'Odisha': ['Bhubaneswar', 'Cuttack', 'भुवनेश्वर', 'ओडिशा'],
  'Punjab': ['Amritsar', 'Ludhiana', 'Jalandhar', 'अमृतसर', 'लुधियाना'],
  'Haryana': ['Gurugram', 'Gurgaon', 'Faridabad', 'Rohtak', 'गुरुग्राम', 'फरीदाबाद'],
  'Himachal Pradesh': ['Shimla', 'शिमला'],
  'Uttarakhand': ['Dehradun', 'Haridwar', 'देहरादून', 'हरिद्वार'],
  'Assam': ['Guwahati', 'गुवाहाटी'],
  'Jammu and Kashmir': ['J&K', 'Srinagar', 'Kashmir', 'Jammu', 'श्रीनगर', 'कश्मीर', 'जम्मू'],
  'Goa': ['Panaji'], 'Manipur': ['Imphal', 'इंफाल'], 'Tripura': ['Agartala'], 'Meghalaya': ['Shillong'], 'Ladakh': ['Leh', 'लेह'],
  'Puducherry': ['Pondicherry'], 'Sikkim': ['Gangtok'], 'Mizoram': ['Aizawl'], 'Nagaland': ['Kohima'], 'Arunachal Pradesh': ['Itanagar'],
  'Delhi': ['New Delhi', 'नई दिल्ली']
};
var STATE_TEST = Object.keys(STATE_HI).map(function (s) { return [s, anyRe([s, STATE_HI[s]].concat(STATE_ALSO[s] || []))]; });
function statesIn(s) { var out = []; STATE_TEST.forEach(function (x) { if (x[1](s)) out.push(x[0]); }); return out; }

/* topics: every narrative in the config (on or off -- the page decides what to show).
   "politics" also covers items tagged elections / party / legislature / students. */
var POLITICS_TOO = ['elections', 'party', 'legislature', 'students', 'opprift'];

/* "Opposition: alliance & infighting" is not one word list but a rule (the lists are in the
   config; opposition names are grouped by party, so Akhilesh + सपा is ONE party):
     two opposition parties + a rift or a seat word        Congress asks SP for 200 seats
     two opposition parties + alliance talk or a jab,      Owaisi hits out at Congress, SP
       and no BJP / NDA name in the headline               ("SP and Congress attack BJP" is not)
     the alliance + a rift word, no BJP / NDA name         rift in the INDIA bloc
     one opposition party + rebels / factions, no BJP name  बगावत, गुटबाज़ी */
function oppositionRift(n) {
  var opp = n.opposition || {}, parties = Object.keys(opp).map(function (k) { return anyRe(opp[k]); });
  var alliance = anyRe(n.alliance), ruling = anyRe(n.ruling), rift = anyRe(n.rift), seats = anyRe(n.seats), soft = anyRe(n.soft), internal = anyRe(n.internal);
  return function (s) {
    var p = 0; parties.forEach(function (f) { if (f(s)) p++; });
    var al = alliance(s); if (!p && !al) return false;
    var r = ruling(s);
    if (p >= 2 && (rift(s) || seats(s))) return true;
    if (p >= 2 && !r && (soft(s) || al)) return true;
    if (al && !r && rift(s)) return true;
    return p === 1 && !r && internal(s);
  };
}
/* topics only the AI step can give (stance toward BJP): keywords never set them */
var RULES = { opposition_rift: oppositionRift, ai: function () { return function () { return false; }; } };

function makeTagger(cfg) {
  var tests = (cfg.narratives || []).map(function (n) { return { id: n.id, test: n.rule && RULES[n.rule] ? RULES[n.rule](n) : anyRe(n.words) }; });
  var groupOf = {}; (cfg.sources || []).forEach(function (s) { groupOf[s.id] = s.group; });
  return function (title, srcId) {
    var tags = [];
    tests.forEach(function (x) { if (x.test(title)) tags.push(x.id); });
    var g = groupOf[srcId];
    if ((g === 'students' || g === 'youth') && tags.indexOf('students') < 0) tags.push('students');   // their own posts and their coverage
    if (tags.indexOf('politics') < 0 && tags.some(function (t) { return POLITICS_TOO.indexOf(t) >= 0; })) tags.push('politics');
    return tags;
  };
}

/* --------------------------------------------------------------- clustering */
var STOP = ('the a an of to in on for and with at by from is are was were as after over says said amid his her its their new will be has have had not who what how why '
  + 'live updates update video watch news this that it into than more about up out off top today day year big latest breaking '
  + 'के की का में से पर को ने और है हैं था थी थे एक यह वह भी तो लिए कहा बोले साथ बाद तक नहीं क्या कैसे हुआ हुई हुए गया गई गए रहे रही रहा कर करने किया लेकर अब बड़ा बड़ी खबर ख़बर').split(' ');
var STOPSET = {}; STOP.forEach(function (w) { STOPSET[w] = 1; });
function tokens(s) {
  var seen = {}, out = [];
  String(s).toLowerCase().split(/[^a-z0-9ऀ-ॿ]+/).forEach(function (w) {
    if (w.length < 3 || STOPSET[w] || seen[w] || /^\d+$/.test(w)) return; seen[w] = 1; out.push(w);
  });
  return out;
}
/* greedy, oldest first: an item joins the group it shares most words with, if they
   share at least 3 and at least 60% of the shorter headline, within 18 hours */
function cluster(items) {
  var list = items.slice().sort(function (a, b) { return a.pub - b.pub; });
  var groups = [], index = {}, WIN = 18 * 3600000;
  list.forEach(function (it) {
    /* the AI's English words for the event (if any) join the headline's own words, so the
       Hindi and the English report of one event share enough words to become one story */
    var tk = tokens(it.title + (it.ai && it.ai.k ? ' ' + it.ai.k : '')), hits = {}, best = null, bestN = 0;
    tk.forEach(function (w) { (index[w] || []).forEach(function (gi) { hits[gi] = (hits[gi] || 0) + 1; }); });
    Object.keys(hits).forEach(function (gi) {
      var g = groups[gi], n = hits[gi];
      if (n < 3 || it.pub - g.last > WIN) return;
      if (n / Math.min(tk.length, g.size) < 0.6) return;
      if (n > bestN) { bestN = n; best = g; }
    });
    if (!best) {
      best = { i: groups.length, items: [], last: it.pub, size: tk.length };
      groups.push(best);
      tk.forEach(function (w) { (index[w] = index[w] || []).push(best.i); });
    }
    best.items.push(it); if (it.pub > best.last) best.last = it.pub;
  });
  return groups;
}

/* ------------------------------------------------------------------- views */
/* logoOf(item) -> image URL or null (the page then draws the source's initials) */
/* tag: on a topic screen the headline shown is one that carries that topic (an attack
   screen shows the copy the AI read as an attack, not a neutral copy of the same story) */
function card(g, logoOf, tag) {
  var its = g.items.slice().sort(function (a, b) { return b.pub - a.pub; });
  var pool = tag ? its.filter(function (x) { return x.tags && x.tags.indexOf(tag) >= 0; }) : its; if (!pool.length) pool = its;
  var off = pool.filter(function (x) { return x.kind === 'official'; })[0];
  var top = off || pool[0], names = {}, others = [];
  its.forEach(function (x) { if (x.srcName !== top.srcName && !names[x.srcName]) { names[x.srcName] = 1; others.push({ n: x.srcName, l: logoOf(x) }); } });
  return { t: top.title, u: top.url, s: top.srcName, lg: logoOf(top), k: top.kind, p: top.pub, d: istStr(top.pub), v: !!top.video, nd: !!top.noDate,
           n: others.length, o: others.slice(0, 3), f: top.seen,           // f = first seen: the page shows NEW for 30 minutes
           as: top.ai ? top.ai.s : null, ab: top.ai ? top.ai.b : null };   // the AI's stance and whose voice (for the attack / good-news screens)
}
/* any set of headlines as cards (copies of one story merged), newest first -- the Election Room's news */
function newsCards(items, logoOf, limit) {
  return cluster(items).map(function (g) { return card(g, logoOf); }).sort(function (a, b) { return b.p - a.p; }).slice(0, limit || 10);
}
function distinctSources(g) { var o = {}; g.items.forEach(function (x) { o[x.srcName] = 1; }); return Object.keys(o).length; }

/* opts: { items (already filtered to this area), topics: [ids], sources (configured, with status),
           bySource: bool, now } */
function buildView(opts) {
  var now = opts.now || Date.now(), DAY = now - 24 * 3600000, HOT = now - 6 * 3600000;
  var lo = opts.logoOf || function () { return null; }, cardOf = function (g) { return card(g, lo); };
  var items = opts.items.filter(function (x) { return x.pub >= DAY; });
  var groups = cluster(items).sort(function (a, b) { return b.last - a.last; });
  var lists = {};
  opts.topics.forEach(function (id) {
    lists[id] = groups.filter(function (g) { return g.items.some(function (x) { return x.tags.indexOf(id) >= 0; }); }).slice(0, 6).map(function (g) { return card(g, lo, id); });
  });
  lists.official = groups.filter(function (g) { return g.items.some(function (x) { return x.kind === 'official'; }); }).slice(0, 6).map(cardOf);
  /* hot: carried by 2+ different sources in the last 6 hours, and about one of the topics (no cricket or gadgets) */
  lists.hot = groups.filter(function (g) { return g.last >= HOT && distinctSources(g) >= 2 && g.items.some(function (x) { return x.tags.length; }); })
    .sort(function (a, b) { return distinctSources(b) - distinctSources(a) || b.last - a.last; }).slice(0, 6).map(cardOf);
  var view = { items: items.length, stories: groups.length, lists: lists, ticker: groups.slice(0, 20).map(cardOf) };
  if (opts.bySource) {
    view.bySource = opts.sources.filter(function (s) { return s.direct; }).map(function (s) {
      var mine = opts.items.filter(function (x) { return x.src === s.id && x.via !== 'gnews'; }).sort(function (a, b) { return b.pub - a.pub; }).slice(0, 5);
      return { id: s.id, name: s.name, nameHi: s.nameHi, kind: s.kind, lg: lo(mine[0] || { src: s.id, via: 'rss' }), latest: mine.map(function (x) { return { t: x.title, u: x.url, p: x.pub, d: istStr(x.pub), v: !!x.video, f: x.seen }; }) };
    }).filter(function (s) { return s.latest.length; });
  }
  return view;
}

module.exports = {
  parseFeed: parseFeed, parseDate: parseDate, decode: decode, canonical: canonical, idOf: idOf, isHindi: isHindi,
  makeTagger: makeTagger, statesIn: statesIn, anyRe: anyRe, STATE_HI: STATE_HI, tokens: tokens, cluster: cluster, buildView: buildView, istStr: istStr, newsCards: newsCards
};
