/* ==================================================================
 *  election_lib.js -- reads the Election Commission's result pages
 *  (results.eci.gov.in) into plain data. No network here: the engine
 *  (election_room.js) fetches, this file only parses.
 *
 *  Pages it understands:
 *    index.htm                 general election: party table (one state, or
 *                              All India for Lok Sabha) or the top-5 per state
 *                              with links to partywiseresult-Sxx.htm;
 *                              by-election: one card per seat
 *    partywiseresult-Sxx.htm   party | won | leading | total, for one state
 *    statewiseSxxN.htm         page N of the seats: leading / trailing
 *                              candidate and party, margin, round, status
 *  The parsers read the table headers ("Won", "Leading", "Margin"), not fixed
 *  positions, and return null when a page is not what they expect -- the
 *  room then says the data could not be read; it never guesses.
 * ================================================================== */
'use strict';

/* ECI's state codes (S = state, U = union territory) */
var CODES = {
  S01: 'Andhra Pradesh', S02: 'Arunachal Pradesh', S03: 'Assam', S04: 'Bihar', S05: 'Goa', S06: 'Gujarat', S07: 'Haryana',
  S08: 'Himachal Pradesh', S10: 'Karnataka', S11: 'Kerala', S12: 'Madhya Pradesh', S13: 'Maharashtra', S14: 'Manipur',
  S15: 'Meghalaya', S16: 'Mizoram', S17: 'Nagaland', S18: 'Odisha', S19: 'Punjab', S20: 'Rajasthan', S21: 'Sikkim',
  S22: 'Tamil Nadu', S23: 'Tripura', S24: 'Uttar Pradesh', S25: 'West Bengal', S26: 'Chhattisgarh', S27: 'Jharkhand',
  S28: 'Uttarakhand', S29: 'Telangana', U01: 'Andaman and Nicobar', U02: 'Chandigarh', U03: 'Dadra and Nagar Haveli and Daman and Diu',
  U05: 'Delhi', U06: 'Lakshadweep', U07: 'Puducherry', U08: 'Jammu and Kashmir', U09: 'Ladakh'
};
var BYNAME = {}; Object.keys(CODES).forEach(function (c) { BYNAME[CODES[c].toLowerCase()] = c; });
BYNAME['nct of delhi'] = 'U05'; BYNAME['jammu & kashmir'] = 'U08'; BYNAME['orissa'] = 'S18';

function decode(s) {
  return String(s || '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, function (m, n) { return String.fromCharCode(+n); });
}
function text(h) { return decode(String(h || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(); }
function num(s) { var n = parseInt(String(s || '').replace(/[^\d-]/g, ''), 10); return isFinite(n) ? n : null; }
/* the page without scripts, styles and the "party trends" tooltips (they repeat numbers inside cells) */
function clean(html) {
  return String(html || '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<div class=['"]tooltip['"][\s\S]*?<\/div>/gi, '').replace(/<span class=['"]tooltip-icon['"][^>]*>[\s\S]*?<\/span>/gi, '');
}
/* "Last Updated at | 04:18 PM On 05/05/2026" -> ms (IST) */
function updatedAt(html) {
  var m = text(html).match(/Last Updated at\s*:?\s*(\d{1,2}):(\d{2})\s*(am|pm)\s*On\s*(\d{2})\/(\d{2})\/(\d{4})/i);
  if (!m) return null;
  var h = +m[1] % 12 + (/pm/i.test(m[3]) ? 12 : 0);
  return Date.UTC(+m[6], +m[5] - 1, +m[4], h, +m[2]) - 330 * 60000;
}
/* "General Election to Assembly Constituencies: Trends & Results November-2025" */
function titleOf(html) {
  var m = String(html).match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || String(html).match(/<h2[^>]*>([\s\S]*?(Election|Results)[\s\S]*?)<\/h2>/i);
  return m ? text(m[1]) : '';
}
/* what kind of election a folder / title is */
function kindOf(folder, title) {
  var f = String(folder || ''), t = String(title || '');
  var house = /Pc/i.test(f) || /Parliamentary|Lok Sabha/i.test(t) ? 'ls' : 'vs';
  var bye = /Bye/i.test(f) || /Bye/i.test(t);
  return bye ? (house === 'ls' ? 'bye-ls' : 'bye-vs') : house;
}
/* every row of every table, as lists of cell texts (nested tables flattened into the row) */
function rows(html) {
  var out = [];
  String(html).replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, function (m, inner) {
    var cells = [];
    inner.replace(/<t[dh][^>]*>([\s\S]*?)(?=<t[dh][^>]*>|<\/tr>|$)/gi, function (m2, c) { cells.push(text(c)); return ''; });
    out.push(cells);
    return '';
  });
  return out;
}

/* party | won | leading | total -- on index.htm (one state / All India) or partywiseresult-Sxx.htm */
function parsePartyTable(html) {
  var h = clean(html), at = h.search(/<th[^>]*>\s*Party\s*<\/th>/i);
  if (at < 0) return null;
  var end = h.indexOf('</table>', at), part = h.slice(at, end > at ? end : at + 60000);
  var heads = (part.match(/<th[^>]*>[\s\S]*?<\/th>/gi) || []).map(function (x) { return text(x).toLowerCase(); });
  var iWon = heads.indexOf('won'), iLead = heads.indexOf('leading'), iTot = heads.indexOf('total');
  if (iWon < 0 || iLead < 0) return null;
  var parties = [], totalRow = null;
  part.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, function (m, inner) {
    var c = (inner.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || []);
    if (c.length < 3) return '';
    var name = text(c[0]), won = num(text(c[iWon])), lead = num(text(c[iLead])), tot = iTot >= 0 ? num(text(c[iTot])) : (won || 0) + (lead || 0);
    if (won === null && lead === null) return '';
    if (/^total$/i.test(name)) { totalRow = { won: won || 0, lead: lead || 0, total: tot || 0 }; return ''; }
    var mm = name.match(/^(.*?)\s+-\s+([^-]+)$/), link = (c[iWon].match(/href=['"]([^'"]+)['"]/) || [])[1] || null;
    parties.push({ name: mm ? mm[1].trim() : name, abbr: mm ? mm[2].trim() : name, won: won || 0, lead: lead || 0, total: tot || 0, winLink: link });
    return '';
  });
  if (!parties.length) return null;
  var sum = parties.reduce(function (a, p) { return { won: a.won + p.won, lead: a.lead + p.lead, total: a.total + p.total }; }, { won: 0, lead: 0, total: 0 });
  return { parties: parties, totals: totalRow || sum, updated: updatedAt(html), title: titleOf(html) };
}

/* index.htm: what this election is and where its state pages are */
function parseIndex(html, folder) {
  var h = clean(html), title = titleOf(h), kind = kindOf(folder, title), t = text(h);
  var codes = {};
  String(html).replace(/partywiseresult-([SU]\d{2})\.htm/g, function (m, c) { codes[c] = 1; return m; });
  String(html).replace(/statewise([SU]\d{2})\d+\.htm/g, function (m, c) { codes[c] = codes[c] || 2; return m; });
  var out = { folder: folder || null, title: title, kind: kind, updated: updatedAt(html), states: [], table: null, cards: null };
  if (/Bye/i.test(kind)) {
    /* one card per seat: seat (no.), state, WON / LEADING / TRAILING, candidate, party */
    var cards = [];
    h.replace(/<a href=['"](candidateswise-([SU]\d{2})(\d+)\.htm)['"][^>]*>\s*<div class=['"]box-content['"]>([\s\S]*?)<\/div>/gi, function (m, link, code, no, inner) {
      var g = function (tag) { var x = inner.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i')); return x ? text(x[1]) : ''; };
      var seat = g('h3').replace(/\s*\(\d+\)\s*$/, ''), st = g('h4'), stat = g('h2').toLowerCase();
      cards.push({ code: code, no: +no, seat: seat, state: CODES[code] || st, status: /won/.test(stat) ? 'won' : /lead/.test(stat) ? 'lead' : /trail/.test(stat) ? 'trail' : stat,
                   cand: g('h5'), party: g('h6'), link: link });
      return m;
    });
    out.cards = cards;
    out.states = Object.keys(cards.reduce(function (a, c) { a[c.code] = 1; return a; }, {})).map(function (c) { return { code: c, name: CODES[c] || c }; });
    return out;
  }
  out.table = parsePartyTable(html);                                   // one state, or All India (Lok Sabha)
  /* states with their own party page; a lone constituency-list link (a by-election tucked into
     the same page) counts only when there is no party page at all */
  var withPage = Object.keys(codes).filter(function (c) { return codes[c] === 1; });
  out.states = (withPage.length ? withPage : Object.keys(codes)).sort().map(function (c) { return { code: c, name: CODES[c] || c, page: codes[c] === 1 }; });
  if (!out.states.length) {
    var m = t.match(/Results\s+\w+-\d{4}\s+([A-Za-z &]+?)\s+(BJP|INC|Party|Status)/);
    var c = m && BYNAME[m[1].trim().toLowerCase()];
    if (c) out.states = [{ code: c, name: CODES[c] }];
  }
  return out;
}

/* statewiseSxxN.htm: one page of seats. Rows end with a status cell. */
function parseStatewise(html) {
  var h = clean(html), t = text(h), m = t.match(/Status Known For\s+(\d+)\s+out of\s+(\d+)/i);
  var at = h.search(/Leading Candidate/i);
  if (at < 0) return null;
  var tokens = [];
  h.slice(at).replace(/<td[^>]*>([\s\S]*?)(?=<td|<\/td>|<\/tr>)/gi, function (x, c) { var v = text(c); if (v) tokens.push(v); return x; });
  var seats = [], cur = [];
  tokens.forEach(function (v) {
    cur.push(v);
    if (/^(Result in Progress|Result Declared|Uncontested|Countermanded|Postponed|Adjourned|Result Withheld)/i.test(v)) {
      if (cur.length >= 9) {
        var r = cur.slice(-9);
        seats.push({ seat: r[0], no: num(r[1]), lead: { cand: r[2], party: r[3] }, trail: { cand: r[4], party: r[5] },
                     margin: num(r[6]), round: r[7], status: /Declared|Uncontested/i.test(r[8]) ? 'won' : /Progress/i.test(r[8]) ? 'lead' : 'other', statusText: r[8] });
      } else if (cur.length >= 5) {                                       // no runner-up yet (counting just started)
        seats.push({ seat: cur[0], no: num(cur[1]), lead: { cand: cur[2], party: cur[3] }, trail: null, margin: null, round: cur.length > 5 ? cur[cur.length - 2] : '', status: 'lead', statusText: cur[cur.length - 1] });
      }
      cur = [];
    }
  });
  return { known: m ? +m[1] : null, of: m ? +m[2] : null, seats: seats, updated: updatedAt(html) };
}

/* candidateswise-Sxxnnn.htm: every candidate's votes and margin, and the round */
function parseCandidate(html) {
  var t = text(clean(html)), r = t.match(/Status of EVM Round:?\s*(\d+)\s*\/\s*(\d+)/i), seat = t.match(/(\d+)\s*-\s*([A-Z][A-Z .()\-]+?)\s*\(([^)]+)\)/);
  var cands = [];
  String(html).split(/<div class=['"]cand-box['"]>/i).slice(1).forEach(function (chunk) {
    var g = function (re) { var x = chunk.match(re); return x ? text(x[1]) : ''; };
    var st = g(/class=['"]captli['"][^>]*>([\s\S]*?)<\/div>/i).toLowerCase(), v = chunk.match(/<div>\s*(\d+)\s*<span>\s*\(\s*([+-]?)\s*(\d+)\s*\)/);
    var img = (chunk.match(/<img src=['"]([^'"]+)['"]/i) || [])[1] || null, name = g(/<h5[^>]*>([\s\S]*?)<\/h5>/i);
    if (!name) return;
    cands.push({ status: st, votes: v ? +v[1] : null, diff: v ? (v[2] === '-' ? -1 : 1) * +v[3] : null, name: name, party: g(/<h6[^>]*>([\s\S]*?)<\/h6>/i), photo: img });
  });
  return { round: r ? +r[1] : null, rounds: r ? +r[2] : null, no: seat ? +seat[1] : null, seat: seat ? seat[2].trim() : null, state: seat ? seat[3] : null, cands: cands, updated: updatedAt(html) };
}

/* ---------------------------------------------------------- Hindi names
   ECI publishes the same pages in Hindi under /hi/. They give the official Hindi name of every
   seat, and in a general election also the candidates' names (as the returning officer entered
   them -- where none was entered, ECI shows the English name, which is then not used).
   Each reader returns names keyed by seat number; nothing else is taken from these pages. */
var DEVA = /[ऀ-ॿ]/;
function hi(s) { s = String(s || '').trim(); return DEVA.test(s) ? s : null; }

/* hi/statewiseSxxN.htm: seat | no. | leading cand | party | trailing cand | party | margin | round | status.
   A row ends at the status, the cell right after the round ("29/29"). */
function parseStatewiseHi(html) {
  var h = clean(html), at = h.search(/<tbody/i);
  if (at < 0) return null;
  var tokens = [];
  h.slice(at).replace(/<td[^>]*>([\s\S]*?)(?=<td|<\/td>|<\/tr>)/gi, function (x, c) { var v = text(c); if (v) tokens.push(v); return x; });
  var out = {}, cur = [];
  for (var i = 0; i < tokens.length; i++) {
    cur.push(tokens[i]);
    if (/^\d+\s*\/\s*\d+$/.test(tokens[i]) && i + 1 < tokens.length) {     // the round; the next cell is the status
      cur.push(tokens[++i]);
      var r = cur.length >= 9 ? cur.slice(-9) : null;
      if (r && num(r[1]) && hi(r[0])) out[num(r[1])] = { seat: hi(r[0]), lead: hi(r[2]), trail: hi(r[4]), margin: num(r[6]) };
      cur = [];
    }
  }
  return Object.keys(out).length ? out : null;
}
/* hi/index.htm of a by-election: one card per seat -> { 'S25210': 'नन्दीग्राम' } */
function parseIndexHi(html) {
  var out = {};
  clean(html).replace(/<a href=['"]candidateswise-([SU]\d{2}\d+)\.htm['"][^>]*>\s*<div class=['"]box-content['"]>([\s\S]*?)<\/div>/gi, function (m, code, inner) {
    var x = inner.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i), s = x ? hi(text(x[1]).replace(/\s*\(\d+\)\s*$/, '')) : null;
    if (s) out[code] = s;
    return m;
  });
  return Object.keys(out).length ? out : null;
}

module.exports = { CODES: CODES, BYNAME: BYNAME, parseIndex: parseIndex, parsePartyTable: parsePartyTable, parseStatewise: parseStatewise,
                   parseCandidate: parseCandidate, kindOf: kindOf, updatedAt: updatedAt, text: text,
                   parseStatewiseHi: parseStatewiseHi, parseIndexHi: parseIndexHi };
