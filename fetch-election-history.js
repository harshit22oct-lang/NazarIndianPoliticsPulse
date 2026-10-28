/* ==================================================================
 *  fetch-election-history.js -- past results for the Election Room
 *
 *  ECI takes an election's result pages down once a newer election is on.
 *  The Internet Archive keeps ECI's own pages, so past results come from
 *  there: official numbers, an archived copy. Run it once (and after an
 *  election ends if Nazar missed it):
 *
 *      node fetch-election-history.js
 *
 *  Writes data/election_history.json (committed, so every server has it) and
 *  data/election_demo.json (Bihar 2025 counting day, for ?demo=1).
 *  A result is kept only when every seat in it is declared; a snapshot taken
 *  while counting was still on is skipped, never shown as final.
 *  Polite: one request at a time, 5 s apart, waits and retries when asked to.
 * ================================================================== */
'use strict';
var fs = require('fs');
var path = require('path');
var EL = require('./app/election_lib.js');

var OUT = path.join(__dirname, 'data', 'election_history.json');
var DEMO = path.join(__dirname, 'data', 'election_demo.json');
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
var ECI = 'https://results.eci.gov.in/';
/* the folders ECI used (newest first); type: ls = Lok Sabha, vs = Vidhan Sabha */
var ELECTIONS = [
  { folder: 'ResultAcGenMay2026', type: 'vs', date: '2026-05-04', en: 'Assembly elections, May 2026', hi: 'विधानसभा चुनाव, मई 2026' },
  { folder: 'ResultAcGenNov2025', type: 'vs', date: '2025-11-14', en: 'Bihar assembly election 2025', hi: 'बिहार विधानसभा चुनाव 2025' },
  { folder: 'ResultAcGenFeb2025', type: 'vs', date: '2025-02-08', en: 'Delhi assembly election 2025', hi: 'दिल्ली विधानसभा चुनाव 2025' },
  { folder: 'ResultAcGenNov2024', type: 'vs', date: '2024-11-23', en: 'Assembly elections, Nov 2024', hi: 'विधानसभा चुनाव, नवंबर 2024' },
  { folder: 'AcResultGenOct2024', type: 'vs', date: '2024-10-08', en: 'Assembly elections, Oct 2024', hi: 'विधानसभा चुनाव, अक्टूबर 2024' },
  { folder: 'AcResultGenJune2024', type: 'vs', date: '2024-06-04', en: 'Assembly elections, June 2024', hi: 'विधानसभा चुनाव, जून 2024' },
  { folder: 'PcResultGenJune2024', type: 'ls', date: '2024-06-04', en: 'Lok Sabha election 2024', hi: 'लोकसभा चुनाव 2024' }
];

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function get(url, tries) {
  tries = tries || 0;
  try {
    /* identity: the archive sometimes sends a broken compressed body */
    var r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Encoding': 'identity' }, redirect: 'follow', signal: AbortSignal.timeout(60000) });
    if ((r.status === 429 || r.status >= 500) && tries < 4) { console.log('    busy (' + r.status + '), waiting 30 s'); await sleep(30000); return get(url, tries + 1); }
    if (!r.ok) return null;
    return await r.text();
  } catch (e) { if (tries < 2) { await sleep(10000); return get(url, tries + 1); } return null; }
}
/* the archive's snapshots of one ECI page (timestamps, oldest first) */
async function snaps(page, from, to) {
  var u = 'https://web.archive.org/cdx/search/cdx?url=' + encodeURIComponent('results.eci.gov.in/' + page) + '&filter=statuscode:200&fl=timestamp'
    + (from ? '&from=' + from : '') + (to ? '&to=' + to : '');
  var x = await get(u); await sleep(5000);
  return x ? x.trim().split(/\s+/).filter(Boolean) : [];
}
async function archived(page, ts) {
  var x = await get('https://web.archive.org/web/' + ts + 'id_/' + ECI + page); await sleep(5000);
  return x;
}
/* the newest snapshot of a page in which every seat is declared */
async function finalTable(page) {
  var ts = (await snaps(page)).reverse();
  for (var i = 0; i < Math.min(ts.length, 4); i++) {
    var h = await archived(page, ts[i]); if (!h) continue;
    var t = EL.parsePartyTable(h);
    if (t && t.totals.total > 0 && t.totals.lead === 0) return { table: t, at: ts[i] };
    if (t) console.log('    ' + page + ' @' + ts[i] + ': still counting (' + t.totals.won + ' won, ' + t.totals.lead + ' leading) -- skipped');
  }
  return null;
}
function slim(t) { return t.parties.map(function (p) { return { name: p.name, abbr: p.abbr, won: p.won }; }); }

async function history(only) {
  var out = { builtAt: new Date().toISOString(), source: 'ECI results.eci.gov.in, archived copies (web.archive.org)', results: [] };
  /* one election only (node fetch-election-history.js history PcResultGenJune2024): merged into the file */
  if (only) { try { out.results = JSON.parse(fs.readFileSync(OUT, 'utf8')).results.filter(function (r) { return r.folder !== only; }); } catch (e) {} }
  for (var i = 0; i < ELECTIONS.length; i++) {
    var e = ELECTIONS[i]; if (only && e.folder !== only) continue;
    console.log('  ' + e.folder);
    var ts = (await snaps(e.folder + '/index.htm')).reverse()[0];
    if (!ts) { console.log('    no archived index'); continue; }
    var idx = EL.parseIndex(await archived(e.folder + '/index.htm', ts) || '', e.folder);
    /* Lok Sabha: the index's own table is All India */
    if (e.type === 'ls') {
      var all = await finalTable(e.folder + '/index.htm');
      if (all) { out.results.push({ folder: e.folder, type: e.type, date: e.date, en: e.en, hi: e.hi, state: null, seats: all.table.totals.total, parties: slim(all.table), at: all.at }); console.log('    All India: ' + all.table.totals.total + ' seats'); }
      continue;                                          // per-state Lok Sabha pages: later (36 more pages)
    }
    var states = idx.states.filter(function (s) { return s.page; });
    if (!states.length && idx.states.length && idx.table && e.type === 'vs') {          // one state on the index itself
      var one = await finalTable(e.folder + '/index.htm');
      if (one) { out.results.push({ folder: e.folder, type: e.type, date: e.date, en: e.en, hi: e.hi, state: idx.states[0].name, seats: one.table.totals.total, parties: slim(one.table), at: one.at }); console.log('    ' + idx.states[0].name + ': ' + one.table.totals.total + ' seats'); }
      continue;
    }
    for (var j = 0; j < states.length; j++) {
      var s = states[j], f = await finalTable(e.folder + '/partywiseresult-' + s.code + '.htm');
      if (f) { out.results.push({ folder: e.folder, type: e.type, date: e.date, en: e.en, hi: e.hi, state: s.name, seats: f.table.totals.total, parties: slim(f.table), at: f.at }); console.log('    ' + s.name + ': ' + f.table.totals.total + ' seats'); }
    }
  }
  return out;
}

/* demo: Bihar's counting day as the archive saw it -- the tally at each snapshot, and the seat list */
async function demo() {
  /* the index was saved both as .../index.htm and as the folder itself: both give tally frames */
  var F = 'ResultAcGenNov2025', frames = [], ts = [];
  (await snaps(F + '/index.htm', '20251114', '20251115')).forEach(function (x) { ts.push([x, F + '/index.htm']); });
  (await snaps(F + '/', '20251114', '20251115')).forEach(function (x) { ts.push([x, F + '/']); });
  ts.sort(function (a, b) { return a[0] < b[0] ? -1 : 1; });
  var pick = ts.filter(function (x, i) { return i % Math.max(1, Math.floor(ts.length / 14)) === 0; }).slice(0, 16);
  for (var i = 0; i < pick.length; i++) {
    var t = EL.parsePartyTable(await archived(pick[i][1], pick[i][0]) || '');
    pick[i] = pick[i][0];
    if (t && t.totals.total) { frames.push({ at: pick[i], updated: t.updated, totals: t.totals, parties: t.parties.map(function (p) { return { name: p.name, abbr: p.abbr, won: p.won, lead: p.lead }; }) }); console.log('    frame ' + pick[i] + ': ' + t.totals.won + ' won / ' + t.totals.lead + ' leading'); }
  }
  /* the seat list, from one moment mid-count (pages 1..N) */
  /* the seat list: every page, each from its snapshot nearest to mid-count (a missing page is
     skipped, not the end of the list) */
  var seats = [], seen = {}, mid = frames.length ? frames[Math.floor(frames.length / 2)].at : '20251114';
  for (var p = 1; p <= 13; p++) {
    var h = await archived(F + '/statewiseS04' + p + '.htm', mid), sw = h ? EL.parseStatewise(h) : null;
    if (!sw || !sw.seats.length) { console.log('    seats page ' + p + ': not archived'); continue; }
    sw.seats.forEach(function (s) { if (!seen[s.no]) { seen[s.no] = 1; seats.push(s); } }); console.log('    seats page ' + p + ': ' + sw.seats.length);
  }
  return { folder: F, state: 'Bihar', seats: 243, en: 'Bihar assembly election 2025', hi: 'बिहार विधानसभा चुनाव 2025', frames: frames, seatList: seats };
}

/* demo head-to-heads: the archived candidate page (votes, ECI photos) of the seats the Election
   Room puts first -- big faces, BJP's tightest fights and biggest wins, other close fights */
async function demoCands() {
  var d = JSON.parse(fs.readFileSync(DEMO, 'utf8')), F = d.folder, cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'app', 'data', 'election_config.json'), 'utf8'));
  var faces = (cfg.faces[d.state] || []).map(function (n) { var w = n.toUpperCase().split(/[\s.]+/); return function (c) { var u = ' ' + String(c || '').toUpperCase().replace(/\./g, ' ') + ' '; return w.every(function (x) { return u.indexOf(' ' + x + ' ') >= 0; }); }; });
  var rows = d.seatList, pick = [], seen = {};
  function add(s) { if (s && !seen[s.no] && pick.length < 34) { seen[s.no] = 1; pick.push(s); } }
  var isB = function (p) { return /Bharatiya Janata Party/i.test(p || ''); };
  rows.forEach(function (s) { if (faces.some(function (f) { return f(s.lead.cand) || (s.trail && f(s.trail.cand)); })) add(s); });
  rows.filter(function (s) { return s.status !== 'won' && s.margin != null && (isB(s.lead.party) || (s.trail && isB(s.trail.party))); }).sort(function (a, b) { return a.margin - b.margin; }).slice(0, 12).forEach(add);
  rows.filter(function (s) { return s.status === 'won' && isB(s.lead.party); }).sort(function (a, b) { return b.margin - a.margin; }).slice(0, 5).forEach(add);
  rows.filter(function (s) { return s.status !== 'won' && s.margin != null; }).sort(function (a, b) { return a.margin - b.margin; }).slice(0, 10).forEach(add);
  rows.filter(function (s) { return s.status === 'won'; }).slice(0, 6).forEach(add);
  var mid = d.frames.length ? d.frames[Math.floor(d.frames.length / 2)].at : '20251114';
  d.cands = d.cands || {};
  for (var i = 0; i < pick.length; i++) {
    if (d.cands[pick[i].no]) continue;
    var h = await archived(F + '/candidateswise-S04' + pick[i].no + '.htm', mid), c = h ? EL.parseCandidate(h) : null;
    if (c && c.cands.length >= 2) { d.cands[pick[i].no] = { round: c.round, rounds: c.rounds, cands: c.cands.slice(0, 3) }; console.log('    ' + pick[i].seat + ': ' + c.cands[0].name + ' ' + c.cands[0].votes + ' vs ' + c.cands[1].name + ' ' + c.cands[1].votes); }
    else console.log('    ' + pick[i].seat + ': not archived');
  }
  fs.writeFileSync(DEMO, JSON.stringify(d));
  console.log('Done: ' + Object.keys(d.cands).length + ' candidate pages in the demo');
}

(async function () {
  var only = process.argv[2], folder = process.argv[3] || null;
  if (only === 'demo-cands') { await demoCands(); return; }
  if (only !== 'demo') {
    console.log('Past results (archived ECI pages):');
    var h = await history(folder);
    fs.writeFileSync(OUT, JSON.stringify(h, null, 1));
    console.log('Done: ' + h.results.length + ' results -> ' + OUT);
  }
  if (only !== 'history') {
    console.log('Demo (Bihar 2025 counting day):');
    var d = await demo();
    fs.writeFileSync(DEMO, JSON.stringify(d));
    console.log('Done: ' + d.frames.length + ' tally frames, ' + d.seatList.length + ' seats -> ' + DEMO);
  }
})().catch(function (e) { console.error(e); process.exit(1); });
