/* ==================================================================
 *  election_room.js -- live and past election results for Nazar's
 *  Election Room (plan: ELECTION_ROOM_PLAN.md; page parsers: app/election_lib.js)
 *
 *   * official numbers only: results.eci.gov.in while counting; past results
 *     from ECI's own pages as archived (data/election_history.json) plus every
 *     final result this server has seen itself (kept for good)
 *   * which election is on: results.eci.gov.in/ redirects to the current
 *     folder; every 15 min while idle, every 60-90 s while counting is on
 *   * one request at a time, ~1 s apart; a failing fetch keeps the last good
 *     numbers (with their time) and is retried later
 *   * LIVE only when ECI still shows seats "leading" and updated in the last
 *     6 hours; FINAL when every seat is declared; older ones are PAST
 *   * MEDIA_WORKER=off (or ELECTION_WORKER=off): this copy fetches nothing and
 *     re-reads what the collecting copy stored (MongoDB)
 * ================================================================== */
'use strict';
var fs = require('fs');
var path = require('path');
var EL = require('./app/election_lib.js');

var CFG_FILE = path.join(__dirname, 'app', 'data', 'election_config.json');
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
var ECI = 'https://results.eci.gov.in/';
var IDLE_MS = 15 * 60000, LIVE_MS = 75000, GAP_MS = 1000;
var LIVE_FRESH_MS = 6 * 3600000;          // "leading" seats but no update for 6 h: not called live
var DELTA_MS = 10 * 60000;                 // the up / down arrows compare with 10 minutes ago
var FINAL_KEEP_MS = 7 * 86400000;          // a just-finished election stays "latest" for a week

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function get(url) {
  var r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-IN,en;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return await r.text();
}
function titleCase(s) { return String(s || '').toLowerCase().replace(/(^|[\s(.\-])([a-z])/g, function (m, a, b) { return a + b.toUpperCase(); }); }

/* ------------------------------------------------------------- storage */
function makeStore(dataDir) {
  var uri = process.env.MONGODB_URI || '', db = null, file = path.join(dataDir, 'election_room.json');
  async function conn() {
    if (db) return db;
    var MC = require('mongodb').MongoClient, cli = new MC(uri); await cli.connect();
    db = cli.db(process.env.DB_NAME || 'nazar'); return db;
  }
  return {
    kind: uri ? 'mongo' : 'file',
    load: async function () {
      if (uri) {
        var d = await conn(), live = await d.collection('election_meta').findOne({ _id: 'live' });
        var finals = await d.collection('election_results').find({}).toArray();
        return { live: live && live.v, finals: finals };
      }
      try { var j = JSON.parse(fs.readFileSync(file, 'utf8')); return { live: j.live, finals: j.finals || [] }; } catch (e) { return { live: null, finals: [] }; }
    },
    save: async function (live, finals, newFinals) {
      if (uri) {
        var d = await conn();
        await d.collection('election_meta').updateOne({ _id: 'live' }, { $set: { v: live, at: new Date() } }, { upsert: true });
        for (var i = 0; i < newFinals.length; i++) await d.collection('election_results').updateOne({ _id: newFinals[i]._id }, { $set: newFinals[i] }, { upsert: true });
        return;
      }
      var tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ live: live, finals: finals })); fs.renameSync(tmp, file);
    }
  };
}

/* ------------------------------------------------------------- the engine */
function createElectionRoom(opts) {
  var log = opts.log || console.log, dataDir = opts.dataDir, store = makeStore(dataDir);
  var cfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
  var history = []; try { history = JSON.parse(fs.readFileSync(path.join(dataDir, 'election_history.json'), 'utf8')).results || []; } catch (e) {}
  var demoData = null; try { demoData = JSON.parse(fs.readFileSync(path.join(dataDir, 'election_demo.json'), 'utf8')); } catch (e) {}
  /* live: folder -> { folder, kind, title, updated, checkedAt, error, contests: { key: contest } } */
  var live = {}, finals = [], worker = false, busy = false, nextAt = 0, lastCheck = 0, lastError = null;
  var trail = {};                                                     // contest key -> [{t, by party total}] for the arrows
  var seatPrev = {};                                                  // contest key -> { seatNo: {party, status} } for flips / declared

  /* ---- alliances, names, colours (config) ---- */
  function alliancesFor(state) { return (state && cfg.alliances_by_state[state]) || cfg.alliances; }
  function allianceOf(abbr, state) {
    var A = alliancesFor(state), k;
    for (k in A) if (A[k].parties.indexOf(abbr) >= 0) return k;
    return null;
  }
  function partyOut(p, state) {
    return { abbr: p.abbr, name: p.name, hi: cfg.party_hi[p.abbr] || null, color: cfg.party_color[p.abbr] || null,
             won: p.won || 0, lead: p.lead || 0, total: (p.total != null ? p.total : (p.won || 0) + (p.lead || 0)), alliance: allianceOf(p.abbr, state) };
  }
  function allianceTotals(parties, state) {
    var A = alliancesFor(state), out = {}, other = { id: 'OTH', en: 'Others', hi: 'अन्य', color: '#757575', won: 0, lead: 0, total: 0 };
    Object.keys(A).forEach(function (k) { out[k] = { id: k, en: A[k].en, hi: A[k].hi, color: A[k].color, won: 0, lead: 0, total: 0 }; });
    parties.forEach(function (p) { var o = p.alliance ? out[p.alliance] : other; o.won += p.won; o.lead += p.lead; o.total += p.total; });
    return Object.keys(out).map(function (k) { return out[k]; }).filter(function (a) { return a.total > 0; }).concat(other.total ? [other] : [])
      .sort(function (a, b) { return b.total - a.total; });
  }
  /* "TEJASHWI PRASAD YADAV" matches a candidate when every word of it is in the candidate's name */
  function faceRe(name) { var w = String(name).toUpperCase().split(/[\s.]+/).filter(Boolean); return function (c) { var u = ' ' + String(c || '').toUpperCase().replace(/[.]/g, ' ') + ' '; return w.every(function (x) { return u.indexOf(' ' + x + ' ') >= 0; }); }; }

  /* ---- one state (or All India) of a general election ---- */
  function buildContest(key, meta, table, seatList, now) {
    var state = meta.state, parties = table.parties.map(function (p) { return partyOut(p, state); }).sort(function (a, b) { return b.total - a.total || b.won - a.won; });
    /* the arrows: seats now vs ~10 minutes ago (the oldest kept snapshot if younger) */
    var tr = trail[key] || (trail[key] = []), cur = {};
    parties.forEach(function (p) { cur[p.abbr] = p.total; });
    var last = tr[tr.length - 1];
    if (!last || JSON.stringify(last.v) !== JSON.stringify(cur)) tr.push({ t: now, v: cur });
    while (tr.length > 2 && tr[1].t <= now - DELTA_MS) tr.shift();
    var base = tr[0].t <= now - 60000 ? tr[0].v : null;
    parties.forEach(function (p) { p.delta = base ? p.total - (base[p.abbr] || 0) : 0; });
    var alliances = allianceTotals(parties, state);
    if (base) alliances.forEach(function (a) {
      var was = 0; Object.keys(base).forEach(function (ab) { var al = allianceOf(ab, state) || 'OTH'; if (al === a.id) was += base[ab]; }); a.delta = a.total - was;
    });
    /* the house size: ECI's party table counts only seats with a trend so far (166 early on
       counting day), so the constituency list's "out of 243" (or a size seen before) wins */
    var seats = Math.max(meta.seats || 0, table.totals.total || parties.reduce(function (s, p) { return s + p.total; }, 0));
    var c = { key: key, folder: meta.folder, kind: meta.kind, en: meta.en, hi: meta.hi, state: state, title: meta.title,
              status: table.totals.lead > 0 ? 'live' : 'final', updated: table.updated || meta.updated || null, checkedAt: now,
              seats: seats, majority: Math.floor(seats / 2) + 1, won: table.totals.won, lead: table.totals.lead,
              parties: parties, alliances: alliances, close: [], declared: [], flips: [], faces: [] };
    if (c.status === 'live' && c.updated && now - c.updated > LIVE_FRESH_MS) c.status = 'stalled';
    if (seatList && seatList.length) {
      var prev = seatPrev[key] || {}, next = {}, firstLook = !seatPrev[key];
      var abbrOf = {}; table.parties.forEach(function (p) { abbrOf[p.name.toLowerCase()] = p.abbr; });
      var ab = function (name) { return abbrOf[String(name || '').toLowerCase()] || name; };
      seatList.forEach(function (s) {
        var row = { seat: titleCase(s.seat), no: s.no, cand: titleCase(s.lead.cand), party: ab(s.lead.party), vs: s.trail ? titleCase(s.trail.cand) : null,
                    vsParty: s.trail ? ab(s.trail.party) : null, margin: s.margin, round: s.round, status: s.status };
        next[s.no] = { party: row.party, status: row.status };
        var p = prev[s.no];
        if (!firstLook && p && p.status !== 'won' && row.status === 'won') c.declaredNew = (c.declaredNew || []).concat([Object.assign({ at: now }, row)]);
        if (!firstLook && p && row.status !== 'won' && p.party !== row.party) c.flipsNew = (c.flipsNew || []).concat([Object.assign({ at: now, from: p.party }, row)]);
        if (row.status === 'lead' && row.margin != null) c.close.push(row);
        if (row.status === 'won') c.declared.push(row);
        var A = (cfg.faces[state] || []).filter(function (n) { return n.charAt(0) !== '_'; });
        A.forEach(function (n) {
          var m = faceRe(n);
          if (m(s.lead.cand)) c.faces.push(Object.assign({}, row, { face: titleCase(s.lead.cand), facing: row.status === 'won' ? 'won' : 'lead' }));
          else if (s.trail && m(s.trail.cand)) c.faces.push(Object.assign({}, row, { face: titleCase(s.trail.cand), facing: row.status === 'won' ? 'lost' : 'trail', party: row.vsParty, vs: row.cand, vsParty: row.party }));
        });
      });
      seatPrev[key] = next;
      c.close.sort(function (a, b) { return a.margin - b.margin; }); c.close = c.close.slice(0, 10);
      c.known = seatList.length;
    }
    return c;
  }
  /* a contest keeps its recent "just declared" and "flipped" events across polls */
  function carry(oldC, c) {
    var cut = Date.now() - 45 * 60000;
    c.recentDeclared = ((c.declaredNew || []).concat(oldC && oldC.recentDeclared || [])).filter(function (x) { return x.at >= cut; }).slice(0, 20);
    c.recentFlips = ((c.flipsNew || []).concat(oldC && oldC.recentFlips || [])).filter(function (x) { return x.at >= cut; }).slice(0, 12);
    delete c.declaredNew; delete c.flipsNew;
    /* while counting, the declared list is newest first where we saw it happen */
    var seen = {}; c.recentDeclared.forEach(function (x) { seen[x.no] = 1; });
    c.declared = c.recentDeclared.concat(c.declared.filter(function (x) { return !seen[x.no]; })).slice(0, 30);
    return c;
  }

  /* ---- read one ECI folder ---- */
  async function pollFolder(folder) {
    var now = Date.now(), idx = EL.parseIndex(await get(ECI + folder + '/index.htm'), folder), F = live[folder] || (live[folder] = { folder: folder, contests: {} });
    F.kind = idx.kind; F.title = idx.title; F.updated = idx.updated; F.checkedAt = now; F.error = null;
    var name = { 'vs': ['Assembly election', 'विधानसभा चुनाव'], 'ls': ['Lok Sabha election', 'लोकसभा चुनाव'], 'bye-vs': ['Assembly by-elections', 'विधानसभा उपचुनाव'], 'bye-ls': ['Lok Sabha by-elections', 'लोकसभा उपचुनाव'] }[idx.kind];
    var when = (idx.title.match(/(\w+)-(\d{4})\s*$/) || []);
    var meta = function (st) { return { folder: folder, kind: idx.kind, title: idx.title, updated: idx.updated, state: st, en: (st ? st + ' · ' : '') + name[0] + (when[0] ? ' ' + when[1] + ' ' + when[2] : ''), hi: (st ? st + ' · ' : '') + name[1] + (when[2] ? ' ' + when[2] : '') }; };
    if (/^bye/.test(idx.kind)) {
      /* by-elections: each seat's card, plus its candidate page (votes, margin, round) */
      var seats = [];
      for (var i = 0; i < idx.cards.length; i++) {
        var cd = idx.cards[i], det = null;
        try { await sleep(GAP_MS); det = EL.parseCandidate(await get(ECI + folder + '/' + cd.link)); } catch (e) {}
        var top = det && det.cands[0], second = det && det.cands[1];
        seats.push({ seat: titleCase(cd.seat), no: cd.no, state: cd.state, status: cd.status, cand: titleCase(cd.cand), party: cd.party, abbr: abbrGuess(cd.party),
                     votes: top ? top.votes : null, margin: top && second ? top.votes - second.votes : null, vs: second ? titleCase(second.name) : null, vsParty: second ? second.party : null,
                     round: det && det.round ? det.round + '/' + det.rounds : null, photo: top ? top.photo : null });
      }
      var anyLead = seats.some(function (s) { return s.status !== 'won'; });
      F.contests = { bye: { key: folder + ':bye', folder: folder, kind: idx.kind, en: meta(null).en, hi: meta(null).hi, state: null, title: idx.title,
                            status: anyLead ? (idx.updated && now - idx.updated > LIVE_FRESH_MS ? 'stalled' : 'live') : 'final', updated: idx.updated, checkedAt: now, byeSeats: seats } };
      return F;
    }
    /* general: one contest per state (and All India for Lok Sabha) */
    var list = [];
    if (idx.kind === 'ls' && idx.table) list.push({ key: folder + ':IN', st: null, table: idx.table, sw: null });
    var states = idx.states.filter(function (s) { return s.page; });
    if (!states.length && idx.states.length && idx.table) list.push({ key: folder + ':' + idx.states[0].code, st: idx.states[0].name, table: idx.table, code: idx.states[0].code });
    for (var j = 0; j < states.length; j++) {
      await sleep(GAP_MS);
      try { var tb = EL.parsePartyTable(await get(ECI + folder + '/partywiseresult-' + states[j].code + '.htm')); if (tb) list.push({ key: folder + ':' + states[j].code, st: states[j].name, table: tb, code: states[j].code }); }
      catch (e) { lastError = states[j].code + ': ' + e.message; }
    }
    for (var k = 0; k < list.length; k++) {
      var L = list[k], seatList = null, old = F.contests[L.key];
      /* the seat list (close fights, declared, flips, big faces): every poll while live, once when final */
      var houseSize = old && old.seats || 0;
      if (L.code && (L.table.totals.lead > 0 || !old || !old.known)) {
        seatList = [];
        for (var p = 1; p <= 40; p++) {
          await sleep(GAP_MS);
          var sw = null; try { sw = EL.parseStatewise(await get(ECI + folder + '/statewise' + L.code + p + '.htm')); } catch (e) { break; }
          if (!sw || !sw.seats.length) break;
          if (sw.of) houseSize = Math.max(houseSize, sw.of);
          seatList = seatList.concat(sw.seats);
          if (sw.of && seatList.length >= sw.of) break;
        }
      }
      var cm = meta(L.st); cm.seats = houseSize;
      var c = buildContest(L.key, cm, L.table, seatList, now);
      if (!seatList && old) { ['close', 'declared', 'faces', 'known'].forEach(function (f) { c[f] = old[f]; }); }
      F.contests[L.key] = carry(old, c);
    }
    return F;
  }
  function abbrGuess(name) {
    var n = String(name || '').toLowerCase(), m = { 'bharatiya janata party': 'BJP', 'indian national congress': 'INC', 'samajwadi party': 'SP', 'bahujan samaj party': 'BSP',
      'all india trinamool congress': 'AITC', 'dravida munnetra kazhagam': 'DMK', 'all india anna dravida munnetra kazhagam': 'ADMK', 'tamilaga vettri kazhagam': 'TVK',
      'aam aadmi party': 'AAP', 'rashtriya janata dal': 'RJD', 'janata dal (united)': 'JD(U)', 'all india n.r. congress': 'AINRC', 'independent': 'IND',
      'communist party of india (marxist)': 'CPI(M)', 'communist party of india': 'CPI' };
    return m[n] || null;
  }

  /* ---- which elections are on ---- */
  async function discover() {
    var html = await get(ECI), m = html.match(/url\s*=\s*https?:\/\/results\.eci\.gov\.in\/([^\/"'\s]+)\/index\.htm/i);
    var folders = m ? [m[1]] : [];
    if (folders[0]) {
      /* sister folders linked from the current one (Assembly <-> Lok Sabha by-elections, general <-> bye) */
      try {
        var ih = await get(ECI + folders[0] + '/index.htm');
        ih.replace(/results\.eci\.gov\.in\/([A-Za-z0-9]+)\/index\.htm/g, function (x, f) { if (folders.indexOf(f) < 0 && folders.length < 3 && /20(2[5-9]|3\d)/.test(f) && f !== folders[0]) folders.push(f); return x; });
      } catch (e) {}
    }
    return folders;
  }
  var known = [];
  async function run() {
    if (busy || Date.now() < nextAt) return; busy = true;
    try {
      if (!known.length || Date.now() - lastCheck > IDLE_MS) { known = await discover(); lastCheck = Date.now(); }
      var anyLive = false, newFinals = [];
      for (var i = 0; i < known.length; i++) {
        var f = known[i], wasLive = live[f] && Object.keys(live[f].contests).some(function (k) { return live[f].contests[k].status === 'live'; });
        /* a finished folder is read again only every 15 min (in case of a recount) */
        if (live[f] && !wasLive && Date.now() - (live[f].checkedAt || 0) < IDLE_MS) continue;
        try { await pollFolder(f); } catch (e) { lastError = f + ': ' + e.message; if (live[f]) live[f].error = e.message; continue; }
        Object.keys(live[f].contests).forEach(function (k) {
          var c = live[f].contests[k];
          if (c.status === 'live') anyLive = true;
          if (c.status === 'final' && !finals.some(function (x) { return x._id === c.key && x.seats === c.seats && x.updated === c.updated; })) {
            var fin = finalRecord(c); finals = finals.filter(function (x) { return x._id !== fin._id; }).concat([fin]); newFinals.push(fin);
          }
        });
        await sleep(GAP_MS);
      }
      Object.keys(live).forEach(function (f) { if (known.indexOf(f) < 0 && Date.now() - (live[f].checkedAt || 0) > FINAL_KEEP_MS) delete live[f]; });
      nextAt = Date.now() + (anyLive ? LIVE_MS : 60000);
      try { await store.save(live, finals, newFinals); } catch (e) { log('  [election] could not save: ' + e.message); }
      log('  [election] ' + known.join(', ') + (anyLive ? ' -- COUNTING LIVE' : ' -- nothing being counted') + (lastError ? ' (last error: ' + lastError + ')' : ''));
      lastError = null;
    } finally { busy = false; }
  }
  /* a finished result, in the same shape as the archived history */
  function finalRecord(c) {
    var type = c.kind === 'ls' ? 'ls' : c.kind === 'vs' ? 'vs' : 'bye';
    var date = c.updated ? new Date(c.updated + 330 * 60000).toISOString().slice(0, 10) : null;
    return { _id: c.key, folder: c.folder, type: type, kind: c.kind, date: date, en: c.en, hi: c.hi, state: c.state, seats: c.seats || (c.byeSeats || []).length, updated: c.updated,
             parties: c.parties ? c.parties.map(function (p) { return { name: p.name, abbr: p.abbr, won: p.won }; }) : null, byeSeats: c.byeSeats || null, source: 'eci' };
  }

  /* ---- what the page gets ---- */
  function typeOf(kind) { return kind === 'ls' ? 'ls' : kind === 'vs' ? 'vs' : 'bye'; }
  function okState(c, st) { return !st || !c.state || c.state === st || (c.byeSeats && c.byeSeats.some(function (s) { return s.state === st; })); }
  function filterBye(c, st) { if (!c.byeSeats || !st) return c; var o = Object.assign({}, c); o.byeSeats = c.byeSeats.filter(function (s) { return s.state === st; }); return o; }
  function pastOut(r) {
    var parties = (r.parties || []).map(function (p) { return partyOut(p, r.state); }).sort(function (a, b) { return b.won - a.won; });
    return { key: r._id || (r.folder + ':' + (r.state || 'IN')), type: r.type, kind: r.kind || (r.type === 'bye' ? (/Pc/i.test(r.folder || '') ? 'bye-ls' : 'bye-vs') : r.type), date: r.date, en: r.en, hi: r.hi, state: r.state, seats: r.seats, majority: Math.floor(r.seats / 2) + 1,
             parties: parties, alliances: parties.length ? allianceTotals(parties.map(function (p) { return Object.assign({}, p, { lead: 0, total: p.won }); }), r.state) : null,
             byeSeats: r.byeSeats || null, source: r.source === 'eci' ? 'eci' : 'archive' };
  }
  function demoView(now) {
    if (!demoData || !demoData.frames.length) return null;
    var fr = demoData.frames, i = Math.floor(now / 20000) % fr.length, f = fr[i];
    var table = { parties: f.parties.map(function (p) { return { name: p.name, abbr: p.abbr, won: p.won, lead: p.lead, total: p.won + p.lead }; }), totals: { won: f.totals.won, lead: f.totals.lead, total: f.totals.total }, updated: now };
    /* a fresh trail per frame cycle, so the arrows show the step from the previous frame */
    /* the arrows: the step from the previous frame (none on the first frame -- the replay starting
       again is not a swing of 80 seats) */
    var key = 'demo:' + i; trail[key] = i === 0 ? [{ t: now - DELTA_MS, v: (function () { var v = {}; f.parties.forEach(function (p) { v[p.abbr] = p.won + p.lead; }); return v; })() }]
      : [{ t: now - DELTA_MS, v: (function () { var v = {}; fr[i - 1].parties.forEach(function (p) { v[p.abbr] = p.won + p.lead; }); return v; })() }];
    seatPrev[key] = null;
    var c = buildContest(key, { folder: demoData.folder, kind: 'vs', title: demoData.en, state: demoData.state, en: demoData.en, hi: demoData.hi, seats: demoData.seats }, table, demoData.seatList, now);
    c.key = 'demo';                                      // one id for the replay, so the page keeps its place between frames
    delete trail[key]; delete seatPrev[key];
    c.status = 'demo'; c.frame = i + 1; c.frames = fr.length; c.archivedAt = f.at;
    return carry(null, c);
  }
  return {
    start: async function () {
      try { var s = await store.load(); if (s.live) live = s.live; finals = (s.finals || []).filter(function (x) { return x && x._id; }); } catch (e) { log('  [election] could not load saved results: ' + e.message); }
      /* ELECTION_WORKER=on|off overrides MEDIA_WORKER for this room alone */
      worker = String(process.env.ELECTION_WORKER || process.env.MEDIA_WORKER || 'on').toLowerCase() !== 'off';
      log('  [election] ' + (worker ? 'watching results.eci.gov.in' : 'display only (MEDIA_WORKER=off)') + ' -- ' + history.length + ' archived results, ' + finals.length + ' saved, demo: ' + (demoData ? demoData.frames.length + ' frames' : 'none'));
      if (!worker) {
        if (store.kind === 'mongo') setInterval(function () { store.load().then(function (s) { if (s.live) live = s.live; finals = s.finals || finals; }).catch(function () {}); }, 60000).unref();
        return;
      }
      setTimeout(function () { run().catch(function (e) { log('  [election] ' + e.message); }); }, 8000);
      setInterval(function () { run().catch(function (e) { log('  [election] ' + e.message); }); }, 15000).unref();
    },
    /* st: a state name or null; type: all | ls | vs | bye | local; demo: replay Bihar 2025 */
    get: function (st, type, demo) {
      var now = Date.now(), want = function (k) { return !type || type === 'all' || type === k; };
      var contests = [];
      Object.keys(live).forEach(function (f) {
        Object.keys(live[f].contests).forEach(function (k) {
          var c = live[f].contests[k];
          if (!want(typeOf(c.kind)) || !okState(c, st)) return;
          if (c.status !== 'live' && now - (c.updated || c.checkedAt || 0) > FINAL_KEEP_MS) return;        // an old final belongs in "past"
          contests.push(filterBye(c, st));
        });
      });
      if (demo) { var d = demoView(now); if (d && want('vs') && okState(d, st)) contests = [d]; }
      contests.sort(function (a, b) { return (b.status === 'live' || b.status === 'demo') - (a.status === 'live' || a.status === 'demo') || (b.seats || 0) - (a.seats || 0); });
      /* past: what this server saw itself, then the archive -- newest first, one per (election, state) */
      var seen = {}, past = finals.map(pastOut).concat(history.map(pastOut)).filter(function (r) {
        var k = r.key; if (seen[k]) return false; seen[k] = 1;
        if (!want(r.type)) return false;
        if (r.byeSeats) { if (st && !r.byeSeats.some(function (s) { return s.state === st; })) return false; }
        else if (st && r.state && r.state !== st) return false;
        return !contests.some(function (c) { return c.key === r.key; });
      }).sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); }).slice(0, 8)
        .map(function (r) { return r.byeSeats && st ? Object.assign({}, r, { byeSeats: r.byeSeats.filter(function (s) { return s.state === st; }) }) : r; });
      var anyLive = contests.some(function (c) { return c.status === 'live'; });
      return { generatedAt: new Date(now).toISOString(), mode: demo ? 'demo' : anyLive ? 'live' : contests.length ? 'final' : 'past', worker: worker,
               checkedAt: lastCheck || null, folders: known, contests: contests, past: past, state: st || null, type: type || 'all',
               alliancesNote: true, majorityNote: true };
    },
    hasDemo: function () { return !!demoData; }
  };
}

module.exports = { createElectionRoom: createElectionRoom };
