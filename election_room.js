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
var DISCOVER_MS = 5 * 60000;               // how often results.eci.gov.in/ is asked which election is current
var WAIT_MS = 2 * 60000;                   // a folder with no trends yet (counting about to start) is re-read this often
var START_SHOW_MS = 60 * 60000;            // "counting has started" is said for an hour after we saw it start
/* "can still flip": the margin divided by the rounds still to count is under this many votes.
   A definition shown on screen, not a forecast: ECI's EVM rounds (postal votes are counted apart). */
var FLIP_NEED = 500;
/* "12/29" -> rounds still to count (17); null when ECI gave no round */
function roundsLeft(r) { var m = String(r || '').match(/(\d+)\s*\/\s*(\d+)/); return m && +m[2] >= +m[1] ? +m[2] - +m[1] : null; }
/* the average votes a round the trailing candidate must gain on the leader to catch up */
function needOf(status, margin, left) { return status !== 'won' && margin != null && left > 0 ? Math.ceil(margin / left) : null; }
function nf(n) { return Number(n).toLocaleString('en-IN'); }

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
  var DEMO_CODE = demoData && demoData.state ? EL.BYNAME[String(demoData.state).toLowerCase()] || null : null;
  /* live: folder -> { folder, kind, title, updated, checkedAt, error, contests: { key: contest } } */
  var live = {}, finals = [], worker = false, busy = false, nextAt = 0, lastCheck = 0, lastError = null;
  var trail = {};                                                     // contest key -> [{t, by party total}] for the arrows
  var candCache = {};                                                 // folder:code:no -> { at, status, det } (candidate pages)
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
  /* ---- Hindi names (ECI's /hi/ pages) ----
     folder:code -> { at, done, seat: { no: 'अलीनगर' }, cand: { 'MAITHILI THAKUR': 'मैथिली ठाकुर' } }.
     A Hindi candidate name is learned from the Hindi seat list only when that row has the same
     margin as the English row of the same seat (both pages from the same moment, so the leading
     and trailing names line up). cfg.face_hi, checked by hand, covers the big faces. */
  var hiCache = {};
  function hiKey(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim(); }
  var FACE_HI = {}; Object.keys(cfg.face_hi || {}).forEach(function (k) { if (k.charAt(0) !== '_') FACE_HI[hiKey(k)] = cfg.face_hi[k]; });
  function hiFor(folder, code) {
    var H = hiCache[folder + ':' + code] || { seat: {}, cand: {} };
    return { seat: function (no) { return H.seat[no] || null; }, cand: function (en) { var k = hiKey(en); return H.cand[k] || FACE_HI[k] || null; } };
  }
  function learnHi(folder, code, hiRows, enRows) {
    var H = hiCache[folder + ':' + code] || (hiCache[folder + ':' + code] = { at: 0, seat: {}, cand: {} }), en = {};
    (enRows || []).forEach(function (s) { en[s.no] = s; });
    Object.keys(hiRows || {}).forEach(function (no) {
      var h = hiRows[no], e = en[no];
      if (h.seat) H.seat[no] = h.seat;
      if (e && h.margin != null && e.margin === h.margin) {
        if (h.lead && e.lead) H.cand[hiKey(e.lead.cand)] = h.lead;
        if (h.trail && e.trail) H.cand[hiKey(e.trail.cand)] = h.trail;
      }
    });
    H.at = Date.now();
    return H;
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
              /* no seat won or ahead yet: ECI has put the page up, counting has not begun -- never "final" */
              status: table.totals.lead > 0 ? 'live' : table.totals.won > 0 ? 'final' : 'waiting', updated: table.updated || meta.updated || null, checkedAt: now,
              seats: seats, majority: Math.floor(seats / 2) + 1, won: table.totals.won, lead: table.totals.lead,
              /* the house size is sure only when ECI's seat list said "out of N" (or the demo's own) */
              seatsSure: !!meta.seats, flipNeed: FLIP_NEED,
              parties: parties, alliances: alliances, close: [], declared: [], flips: [], faces: [] };
    if (c.status === 'live' && c.updated && now - c.updated > LIVE_FRESH_MS) c.status = 'stalled';
    if (seatList && seatList.length) {
      var prev = seatPrev[key] || {}, next = {}, firstLook = !seatPrev[key];
      var abbrOf = {}; table.parties.forEach(function (p) { abbrOf[p.name.toLowerCase()] = p.abbr; });
      var ab = function (name) { return abbrOf[String(name || '').toLowerCase()] || name; };
      var H = hiFor(meta.folder, meta.code);
      /* one seat row, with the Hindi names where ECI gave them */
      var rowOf = function (s) {
        var left = roundsLeft(s.round);
        return { seat: titleCase(s.seat), seatHi: H.seat(s.no), no: s.no, cand: titleCase(s.lead.cand), candHi: H.cand(s.lead.cand), party: ab(s.lead.party),
                 vs: s.trail ? titleCase(s.trail.cand) : null, vsHi: s.trail ? H.cand(s.trail.cand) : null,
                 vsParty: s.trail ? ab(s.trail.party) : null, margin: s.margin, round: s.round, status: s.status,
                 left: s.status === 'won' ? null : left, need: needOf(s.status, s.margin, left) };
      };
      seatList.forEach(function (s) {
        var row = rowOf(s);
        next[s.no] = { party: row.party, status: row.status };
        var p = prev[s.no];
        if (!firstLook && p && p.status !== 'won' && row.status === 'won') c.declaredNew = (c.declaredNew || []).concat([Object.assign({ at: now }, row)]);
        if (!firstLook && p && row.status !== 'won' && p.party !== row.party) c.flipsNew = (c.flipsNew || []).concat([Object.assign({ at: now, from: p.party }, row)]);
        if (row.status === 'lead' && row.margin != null) c.close.push(row);
        if (row.status === 'won') c.declared.push(row);
        var A = (cfg.faces[state] || []).filter(function (n) { return n.charAt(0) !== '_'; });
        A.forEach(function (n) {
          var m = faceRe(n);
          /* a big face's Hindi name: ECI's, else the hand-checked one of the config name that matched */
          if (m(s.lead.cand)) c.faces.push(Object.assign({}, row, { face: titleCase(s.lead.cand), faceHi: row.candHi || FACE_HI[hiKey(n)] || null, facing: row.status === 'won' ? 'won' : 'lead' }));
          else if (s.trail && m(s.trail.cand)) c.faces.push(Object.assign({}, row, { face: titleCase(s.trail.cand), faceHi: row.vsHi || FACE_HI[hiKey(n)] || null, facing: row.status === 'won' ? 'lost' : 'trail', party: row.vsParty, vs: row.cand, vsHi: row.candHi, vsParty: row.party }));
        });
      });
      seatPrev[key] = next;
      /* close fights: the seats that need the smallest catch-up a round first, then those with every
         round counted but not yet declared, then any without a round, each by margin */
      var rank = function (r) { return r.need != null ? 0 : r.left === 0 ? 1 : 2; };
      c.close.sort(function (a, b) { return rank(a) - rank(b) || (rank(a) === 0 ? a.need - b.need : 0) || a.margin - b.margin; }); c.close = c.close.slice(0, 10);
      c.canFlip = seatList.filter(function (s) { var n = needOf(s.status, s.margin, roundsLeft(s.round)); return n != null && n < FLIP_NEED; }).length;
      c.known = seatList.length;
      /* trailing per party (the party is second where counting is on, lost where declared) --
         for the "BJP: won / ahead / behind" line a leader reads first */
      c.trailing = {}; c.lost = {};
      seatList.forEach(function (s) { if (!s.trail) return; var p = ab(s.trail.party); if (s.status === 'won') c.lost[p] = (c.lost[p] || 0) + 1; else c.trailing[p] = (c.trailing[p] || 0) + 1; });
      rowsOf[key] = seatList.map(rowOf);
      c.abbrOf = abbrOf;
    }
    return c;
  }
  /* ---- the head-to-head page: which seats, in what order ----
     1 big faces  2 seats that just flipped  3 BJP's tightest fights (BJP first or second)
     4 just declared  5 BJP's biggest wins  6 other tight fights. At most 16. */
  var rowsOf = {};
  var FOCUS = (cfg.focus_party || 'BJP');
  function duelPicks(c) {
    var rows = rowsOf[c.key] || [], byNo = {}, out = [], seen = {};
    rows.forEach(function (r) { byNo[r.no] = r; });
    function add(no, why) { if (out.length >= 16 || seen[no] || !byNo[no]) return; seen[no] = 1; out.push({ no: no, why: why }); }
    (c.faces || []).forEach(function (f) { add(f.no, 'face'); });
    (c.recentFlips || []).forEach(function (f) { add(f.no, 'flip'); });
    rows.filter(function (r) { return r.status !== 'won' && r.margin != null && (r.party === FOCUS || r.vsParty === FOCUS); })
      .sort(function (a, b) { return a.margin - b.margin; }).slice(0, 6).forEach(function (r) { add(r.no, 'bjpclose'); });
    (c.recentDeclared || []).slice(0, 4).forEach(function (r) { add(r.no, 'won'); });
    rows.filter(function (r) { return r.status === 'won' && r.party === FOCUS && r.margin != null; })
      .sort(function (a, b) { return b.margin - a.margin; }).slice(0, 3).forEach(function (r) { add(r.no, 'bjpbig'); });
    rows.filter(function (r) { return r.status !== 'won' && r.margin != null; }).sort(function (a, b) { return a.margin - b.margin; }).slice(0, 4).forEach(function (r) { add(r.no, 'close'); });
    return out.map(function (p) { return { row: byNo[p.no], why: p.why }; });
  }
  /* one head-to-head: the seat row, plus votes and ECI photos when the candidate page was read.
     The candidate page is read less often than the seat list (every 2.5 min, or an archived copy
     in the demo), so it can be from an earlier moment: its votes are used only when it agrees with
     the list (same leader, same margin). Otherwise the list's leader and margin are shown, without
     vote counts -- one seat never shows two different margins on two screens. Photos are always
     taken from the page, by name. */
  function sameName(x, y) { var n = function (s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }; return n(x) === n(y); }
  function duelOf(c, pick, det) {
    var r = pick.row, ab = function (n) { return (c.abbrOf && c.abbrOf[String(n || '').toLowerCase()]) || abbrGuess(n) || n; };
    var a = det && det.cands[0], b = det && det.cands[1];
    var agrees = a && b && a.votes != null && b.votes != null && sameName(a.name, r.cand) && (r.margin == null || a.votes - b.votes === r.margin);
    /* the Hindi name of a candidate on this seat (the row's, or a big face's) */
    var hiOf = function (name) { return sameName(name, r.cand) ? r.candHi : sameName(name, r.vs) ? r.vsHi : (FACE_HI[hiKey(name)] || null); };
    if (!agrees) {
      var photo = function (name) { var x = det && det.cands.filter(function (k) { return sameName(k.name, name); })[0]; return x ? x.photo : null; };
      return { seat: r.seat, seatHi: r.seatHi || null, no: r.no, status: r.status, round: r.round, why: pick.why, margin: r.margin,
               a: { name: r.cand, nameHi: r.candHi || null, party: r.party, votes: null, photo: photo(r.cand) },
               b: { name: r.vs, nameHi: r.vsHi || null, party: r.vsParty, votes: null, photo: photo(r.vs) } };
    }
    return { seat: r.seat, seatHi: r.seatHi || null, no: r.no, status: r.status, round: det.round ? det.round + '/' + det.rounds : r.round, why: pick.why, margin: r.margin != null ? r.margin : a.votes - b.votes,
             a: { name: titleCase(a.name), nameHi: hiOf(a.name), party: ab(a.party), votes: a.votes, photo: a.photo },
             b: { name: titleCase(b.name), nameHi: hiOf(b.name), party: ab(b.party), votes: b.votes, photo: b.photo } };
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

  /* ---- "counting has started": only when this server saw it start -- the contest was waiting
     (page up, no trends) or its folder appeared on ECI after this server was already watching.
     A server that starts mid-count says nothing about when counting began. ---- */
  var freshFolder = {};
  function startedAt(old, c, folder, now) {
    if (old && old.startedAt) return old.startedAt;
    if (c.status !== 'live') return null;
    return (old ? old.status === 'waiting' : !!freshFolder[folder]) ? now : null;
  }

  /* ---- the headlines: fixed sentences filled with ECI's numbers. Each one says only what the
     numbers show: "won" only for seats ECI declared, "in trends" for won + ahead, "so far" while
     counting is on. Every line in English and Hindi (ECI's Hindi names where known). ---- */
  function pHi(abbr) { return cfg.party_hi[abbr] || abbr; }
  /* opt.seats false: no per-seat lines; opt.whole false: no lines about every seat at once
     ("narrowest so far", "n seats can flip") -- the demo, whose seat list is one archived moment
     with 160 of the 243 seats, uses both (see demoView) */
  function flashOf(c, rows, opt) {
    opt = opt || {};
    var perSeat = opt.seats !== false, whole = opt.whole !== false;
    var out = [], add = function (k, en, hi, no) { if (out.length < 14 && (k === 'maj' || k === 'big' || perSeat)) out.push({ k: k, en: en, hi: hi, no: no == null ? null : no }); };
    var hot = c.status === 'live' || c.status === 'demo' || c.status === 'stalled';
    if (c.status === 'waiting') return out;
    var sh = function (r) { return r.seatHi || r.seat; }, chi = function (r) { return r.candHi || r.cand; };
    if (c.byeSeats) {
      c.byeSeats.forEach(function (s) {
        if (s.margin == null || !s.cand) return;
        var p = s.abbr || s.party, ph = s.abbr ? pHi(s.abbr) : s.party;
        if (s.status === 'won') add('won', s.seat + ' by-election: ' + s.cand + ' (' + p + ') wins by ' + nf(s.margin) + ' votes',
                                     sh(s) + ' उपचुनाव: ' + chi(s) + ' (' + ph + ') की जीत, ' + nf(s.margin) + ' वोट से', s.no);
        else add(s.need != null && s.need < FLIP_NEED ? 'flip' : 'lead', s.seat + ': ' + s.cand + ' (' + p + ') ahead by ' + nf(s.margin) + ' votes' + (s.left != null ? ', ' + s.left + ' rounds to go' : ''),
                 sh(s) + ': ' + chi(s) + ' (' + ph + ') ' + nf(s.margin) + ' वोट से आगे' + (s.left != null ? ', ' + s.left + ' राउंड बाक़ी' : ''), s.no);
      });
      return out;
    }
    var M = c.majority, a = (c.alliances || [])[0], p0 = (c.parties || [])[0], p1 = (c.parties || [])[1];
    /* majority: the alliance first, then a party on its own -- only when the house size is ECI's */
    if (c.seatsSure && a && a.id !== 'OTH') {
      if (a.won >= M) add('maj', a.en + ' wins a majority: ' + a.won + ' seats declared (majority ' + M + ')', a.hi + ' को बहुमत: ' + a.won + ' सीटें घोषित (बहुमत ' + M + ')');
      else if (hot && a.total >= M) add('maj', a.en + ' past the majority mark in trends: ' + a.total + ' of ' + c.seats + ' (majority ' + M + ')', a.hi + ' रुझानों में बहुमत के पार: ' + c.seats + ' में से ' + a.total + ' (बहुमत ' + M + ')');
    }
    if (c.seatsSure && p0) {
      if (p0.won >= M) add('maj', p0.abbr + ' wins a majority on its own: ' + p0.won + ' seats declared', pHi(p0.abbr) + ' को अकेले बहुमत: ' + p0.won + ' सीटें घोषित');
      else if (hot && p0.total >= M) add('maj', p0.abbr + ' alone past the majority mark in trends: ' + p0.total, pHi(p0.abbr) + ' रुझानों में अकेले बहुमत के पार: ' + p0.total);
    }
    if (p0 && p1 && p0.total > p1.total) add('big', p0.abbr + ' the largest party: ' + p0.total + (c.lead > 0 ? ' seats (won + ahead)' : ' seats'),
                                             pHi(p0.abbr) + ' सबसे बड़ी पार्टी: ' + p0.total + (c.lead > 0 ? ' सीटें (जीत + बढ़त)' : ' सीटें'));
    /* leads that changed hands in the last 45 minutes (seen by this server between two reads) */
    (c.recentFlips || []).slice(0, 4).forEach(function (f) {
      add('flip', f.seat + ': the lead passes from ' + f.from + ' to ' + f.party, sh(f) + ': बढ़त ' + pHi(f.from) + ' से ' + pHi(f.party) + ' के पास', f.no);
    });
    /* big faces: lost, behind, won (ahead is not news) */
    var fo = { lost: 0, trail: 1, won: 2 };
    (c.faces || []).filter(function (f) { return f.facing in fo; }).sort(function (x, y) { return fo[x.facing] - fo[y.facing]; }).forEach(function (f) {
      var by = f.margin != null ? f.margin : null, fh = f.faceHi || f.face, ph = pHi(f.party);
      if (f.facing === 'lost') add('face', f.face + ' (' + f.party + ') loses ' + f.seat + (by != null ? ' by ' + nf(by) + ' votes' : ''), sh(f) + ' में ' + fh + ' (' + ph + ') की हार' + (by != null ? ', ' + nf(by) + ' वोट से' : ''), f.no);
      else if (f.facing === 'trail') add('face', f.face + ' (' + f.party + ') behind in ' + f.seat + (by != null ? ' by ' + nf(by) + ' votes' : ''), fh + ' (' + ph + ') ' + sh(f) + ' में' + (by != null ? ' ' + nf(by) + ' वोट से' : '') + ' पीछे', f.no);
      else add('face', f.face + ' (' + f.party + ') wins ' + f.seat + (by != null ? ' by ' + nf(by) + ' votes' : ''), sh(f) + ' से ' + fh + ' (' + ph + ') की जीत' + (by != null ? ', ' + nf(by) + ' वोट से' : ''), f.no);
    });
    rows = whole ? rows || [] : [];
    if (hot) {
      var flip = rows.filter(function (r) { return r.need != null && r.need < FLIP_NEED; });
      if (flip.length) add('flip', flip.length + (flip.length === 1 ? ' seat' : ' seats') + ' can still flip: under ' + FLIP_NEED + ' votes a remaining round to catch up',
                           flip.length + (flip.length === 1 ? ' सीट अभी पलट सकती है' : ' सीटें अभी पलट सकती हैं') + ': बचे हर राउंड में ' + FLIP_NEED + ' से कम वोट का अंतर पाटना है');
      var tight = rows.filter(function (r) { return r.need != null; }).sort(function (x, y) { return x.need - y.need; })[0];
      if (tight) add('close', 'Tightest: ' + tight.seat + ' -- ' + tight.cand + ' (' + tight.party + ') ahead by only ' + nf(tight.margin) + ' votes, ' + tight.left + ' rounds to go',
                     'सबसे कड़ी टक्कर: ' + sh(tight) + ' — ' + chi(tight) + ' (' + pHi(tight.party) + ') सिर्फ़ ' + nf(tight.margin) + ' वोट से आगे, ' + tight.left + ' राउंड बाक़ी', tight.no);
    }
    /* declared seats: the closest and the biggest win (at least two declared, else there is no "closest") */
    var dec = rows.filter(function (r) { return r.status === 'won' && r.margin != null; });
    if (dec.length >= 2) {
      var lo = dec.reduce(function (x, y) { return y.margin < x.margin ? y : x; }), hiR = dec.reduce(function (x, y) { return y.margin > x.margin ? y : x; });
      var so = c.lead > 0 ? [' so far: ', 'अब तक '] : [': ', ''];
      add('won', 'Narrowest win' + so[0] + lo.seat + ' -- ' + lo.cand + ' (' + lo.party + ') by ' + nf(lo.margin) + ' votes',
          so[1] + 'सबसे कम अंतर की जीत: ' + sh(lo) + ' — ' + chi(lo) + ' (' + pHi(lo.party) + '), ' + nf(lo.margin) + ' वोट से', lo.no);
      add('won', 'Biggest win' + so[0] + hiR.seat + ' -- ' + hiR.cand + ' (' + hiR.party + ') by ' + nf(hiR.margin) + ' votes',
          so[1] + 'सबसे बड़ी जीत: ' + sh(hiR) + ' — ' + chi(hiR) + ' (' + pHi(hiR.party) + '), ' + nf(hiR.margin) + ' वोट से', hiR.no);
    }
    return out;
  }

  /* ---- read one ECI folder ---- */
  async function pollFolder(folder) {
    var now = Date.now(), idx = EL.parseIndex(await get(ECI + folder + '/index.htm'), folder), F = live[folder] || (live[folder] = { folder: folder, contests: {} });
    F.kind = idx.kind; F.title = idx.title; F.updated = idx.updated; F.checkedAt = now; F.error = null;
    var name = { 'vs': ['Assembly election', 'विधानसभा चुनाव'], 'ls': ['Lok Sabha election', 'लोकसभा चुनाव'], 'bye-vs': ['Assembly by-elections', 'विधानसभा उपचुनाव'], 'bye-ls': ['Lok Sabha by-elections', 'लोकसभा उपचुनाव'] }[idx.kind];
    var when = (idx.title.match(/(\w+)-(\d{4})\s*$/) || []);
    var meta = function (st) { return { folder: folder, kind: idx.kind, title: idx.title, updated: idx.updated, state: st, en: (st ? st + ' · ' : '') + name[0] + (when[0] ? ' ' + when[1] + ' ' + when[2] : ''), hi: (st ? st + ' · ' : '') + name[1] + (when[2] ? ' ' + when[2] : '') }; };
    if (/^bye/.test(idx.kind)) {
      /* Hindi seat names: the Hindi index once, again every 6 hours */
      var hk = folder + ':bye', HC = hiCache[hk];
      if (!HC || now - HC.at > 6 * 3600000) {
        try { await sleep(GAP_MS); var hix = EL.parseIndexHi(await get(ECI + folder + '/hi/index.htm')); if (hix) hiCache[hk] = HC = { at: now, seat: hix, cand: {} }; } catch (e) {}
      }
      /* by-elections: each seat's card, plus its candidate page (votes, margin, round) */
      var seats = [];
      for (var i = 0; i < idx.cards.length; i++) {
        var cd = idx.cards[i], det = null;
        try { await sleep(GAP_MS); det = EL.parseCandidate(await get(ECI + folder + '/' + cd.link)); } catch (e) {}
        var top = det && det.cands[0], second = det && det.cands[1];
        seats.push({ seat: titleCase(cd.seat), seatHi: HC && HC.seat[cd.code + cd.no] || null, no: cd.no, state: cd.state, status: cd.status,
                     cand: titleCase(cd.cand), candHi: FACE_HI[hiKey(cd.cand)] || null, party: cd.party, abbr: abbrGuess(cd.party),
                     votes: top ? top.votes : null, margin: top && second ? top.votes - second.votes : null, vs: second ? titleCase(second.name) : null, vsParty: second ? second.party : null,
                     round: det && det.round ? det.round + '/' + det.rounds : null, photo: top ? top.photo : null,
                     vsVotes: second ? second.votes : null, vsPhoto: second ? second.photo : null, vsAbbr: second ? abbrGuess(second.party) : null,
                     vsHi: second ? FACE_HI[hiKey(second.name)] || null : null });
        var sl = seats[seats.length - 1]; sl.left = sl.status === 'won' ? null : roundsLeft(sl.round); sl.need = needOf(sl.status, sl.margin, sl.left);
      }
      var anyLead = seats.some(function (s) { return s.status !== 'won'; });
      /* no seat with a trend yet (no cards, or none won / leading): counting has not begun */
      var begun = seats.some(function (s) { return /^(won|lead|trail)$/.test(s.status); });
      var oldB = F.contests && F.contests.bye;
      var bye = { key: folder + ':bye', folder: folder, kind: idx.kind, en: meta(null).en, hi: meta(null).hi, state: null, title: idx.title,
                  status: !begun ? 'waiting' : anyLead ? (idx.updated && now - idx.updated > LIVE_FRESH_MS ? 'stalled' : 'live') : 'final', updated: idx.updated, checkedAt: now, byeSeats: seats, flipNeed: FLIP_NEED };
      bye.startedAt = startedAt(oldB, bye, folder, now);
      bye.flash = flashOf(bye, null);
      F.contests = { bye: bye };
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
      var begunG = L.table.totals.lead + L.table.totals.won > 0;            // before counting: no seat list to read
      if (L.code && begunG && (L.table.totals.lead > 0 || !old || !old.known)) {
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
      /* Hindi names (hi/statewise pages, the same pages as the English list): on the first look,
         every 15 min while counting (new candidates reach first or second place), once when final */
      if (L.code && seatList && seatList.length) {
        var hk2 = folder + ':' + L.code, hc = hiCache[hk2];
        if (!hc || (L.table.totals.lead > 0 && now - hc.at > 15 * 60000)) {
          var hiRows = {};
          for (var hp = 1; hp <= 40; hp++) {
            await sleep(GAP_MS);
            var hr = null; try { hr = EL.parseStatewiseHi(await get(ECI + folder + '/hi/statewise' + L.code + hp + '.htm')); } catch (e) { break; }
            if (!hr) break;
            Object.keys(hr).forEach(function (no) { hiRows[no] = hr[no]; });
            if (Object.keys(hiRows).length >= seatList.length) break;
          }
          learnHi(folder, L.code, hiRows, seatList);
        }
      }
      var cm = meta(L.st); cm.seats = houseSize; cm.code = L.code || null;
      var c = buildContest(L.key, cm, L.table, seatList, now);
      if (!seatList && old) { ['close', 'declared', 'faces', 'known', 'trailing', 'lost', 'abbrOf', 'duels', 'canFlip'].forEach(function (f) { c[f] = old[f]; }); }
      c.startedAt = startedAt(old, c, folder, now);
      c = carry(old, c);
      /* head-to-heads: the candidate page of each priority seat (votes, round, ECI photos);
         at most 10 pages a poll, a seat still counting re-read after 2.5 min, a declared one once */
      if (L.code && rowsOf[L.key]) {
        var picks = duelPicks(c), reads = 0;
        for (var d = 0; d < picks.length && reads < 10; d++) {
          var ck = folder + ':' + L.code + ':' + picks[d].row.no, hit = candCache[ck];
          var stale = !hit || (hit.status !== 'won' && now - hit.at > 150000) || (hit.status !== 'won' && picks[d].row.status === 'won');
          if (!stale) continue;
          reads++; await sleep(GAP_MS);
          try { var det = EL.parseCandidate(await get(ECI + folder + '/candidateswise-' + L.code + picks[d].row.no + '.htm')); if (det && det.cands.length) candCache[ck] = { at: now, status: picks[d].row.status, det: det }; } catch (e) {}
        }
        c.duels = picks.map(function (p) { var h = candCache[folder + ':' + L.code + ':' + p.row.no]; return duelOf(c, p, h && h.det); });
      }
      c.flash = flashOf(c, rowsOf[L.key]);
      F.contests[L.key] = c;
    }
    return F;
  }
  function abbrGuess(name) {
    var n = String(name || '').toLowerCase(), m = { 'bharatiya janata party': 'BJP', 'indian national congress': 'INC', 'samajwadi party': 'SP', 'bahujan samaj party': 'BSP',
      'all india trinamool congress': 'AITC', 'dravida munnetra kazhagam': 'DMK', 'all india anna dravida munnetra kazhagam': 'ADMK', 'tamilaga vettri kazhagam': 'TVK',
      'aam aadmi party': 'AAP', 'rashtriya janata dal': 'RJD', 'janata dal (united)': 'JD(U)', 'all india n.r. congress': 'AINRC', 'independent': 'IND',
      'communist party of india (marxist)': 'CPI(M)', 'communist party of india': 'CPI', 'communist party of india (marxist-leninist) (liberation)': 'CPI(ML)(L)',
      'lok janshakti party(ram vilas)': 'LJPRV', 'lok janshakti party (ram vilas)': 'LJPRV', 'all india majlis-e-ittehadul muslimeen': 'AIMIM', 'jharkhand mukti morcha': 'JMM',
      'shiv sena': 'SHS', 'shiv sena (uddhav balasaheb thackrey)': 'SHSUBT', 'nationalist congress party': 'NCP', 'nationalist congress party – sharadchandra pawar': 'NCPSP',
      'telugu desam': 'TDP', 'yuvajana sramika rythu congress party': 'YSRCP', 'biju janata dal': 'BJD', 'bharat rashtra samithi': 'BRS', 'asom gana parishad': 'AGP',
      'indian union muslim league': 'IUML', 'hindustani awam morcha (secular)': 'HAMS', 'rashtriya lok morcha': 'RSHTLKM', 'vikassheel insaan party': 'VIP',
      'rashtriya lok dal': 'RLD', 'apna dal (soneylal)': 'ADAL', 'jana sena party': 'JSP', 'janata dal (secular)': 'JD(S)', 'pattali makkal katchi': 'PMK',
      'jammu & kashmir national conference': 'JKN', 'shiromani akali dal': 'SAD', 'all india united democratic front': 'AIUDF', 'jan suraaj party': 'JSP(B)' };
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
      if (!known.length || Date.now() - lastCheck > DISCOVER_MS) {
        var was = known, first = !lastCheck; known = await discover(); lastCheck = Date.now();
        /* a folder ECI put up while we were already watching: its counting starts now (startedAt) */
        if (!first) known.forEach(function (f) { if (was.indexOf(f) < 0 && !live[f]) freshFolder[f] = 1; });
      }
      var anyLive = false, newFinals = [];
      for (var i = 0; i < known.length; i++) {
        var f = known[i], stOf = function (s) { return live[f] && Object.keys(live[f].contests).some(function (k) { return live[f].contests[k].status === s; }); };
        var wasLive = stOf('live'), waiting = stOf('waiting');
        /* a finished folder is read again only every 15 min (in case of a recount); one waiting
           for counting to start, every 2 min */
        if (live[f] && !wasLive && Date.now() - (live[f].checkedAt || 0) < (waiting ? WAIT_MS : IDLE_MS)) continue;
        try { await pollFolder(f); } catch (e) { lastError = f + ': ' + e.message; if (live[f]) live[f].error = e.message; continue; }
        Object.keys(live[f].contests).forEach(function (k) {
          var c = live[f].contests[k];
          if (c.status === 'live') anyLive = true;
          if (c.status === 'final' && !finals.some(function (x) { return x._id === c.key && x.seats === c.seats && x.updated === c.updated && JSON.stringify(x.byeSeats || null) === JSON.stringify(c.byeSeats || null); })) {
            var fin = finalRecord(c); finals = finals.filter(function (x) { return x._id !== fin._id; }).concat([fin]); newFinals.push(fin);
          }
        });
        await sleep(GAP_MS);
      }
      Object.keys(live).forEach(function (f) { if (known.indexOf(f) < 0 && Date.now() - (live[f].checkedAt || 0) > FINAL_KEEP_MS) delete live[f]; });
      /* more news for the states being counted (the Media Room adds searches for them) */
      if (anyLive && opts.onLiveStates) {
        var sts = []; Object.keys(live).forEach(function (f) { Object.keys(live[f].contests).forEach(function (k) { var c = live[f].contests[k]; if (c.status === 'live' && c.state) sts.push(c.state); }); });
        try { opts.onLiveStates(sts); } catch (e) {}
      }
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
    var c = buildContest(key, { folder: demoData.folder, code: DEMO_CODE, kind: 'vs', title: demoData.en, state: demoData.state, en: demoData.en, hi: demoData.hi, seats: demoData.seats }, table, demoData.seatList, now);
    c.key = 'demo';                                      // one id for the replay, so the page keeps its place between frames
    rowsOf.demo = rowsOf[key]; delete rowsOf[key];
    delete trail[key]; delete seatPrev[key];
    c.status = 'demo'; c.frame = i + 1; c.frames = fr.length; c.archivedAt = f.at;
    c = carry(null, c);
    /* head-to-heads from the archived candidate pages (fetch-election-history.js demo-cands) */
    /* the archive kept only some candidate pages: seats with real votes and photos first */
    var dc = demoData.cands || {}, picks = duelPicks(c), have = picks.filter(function (p) { return dc[p.row.no]; });
    if (have.length < 6) (rowsOf.demo || []).forEach(function (r) {
      if (have.length < 10 && dc[r.no] && !have.some(function (p) { return p.row.no === r.no; })) have.push({ row: r, why: r.status === 'won' ? (r.party === FOCUS ? 'bjpbig' : 'won') : (r.party === FOCUS || r.vsParty === FOCUS ? 'bjpclose' : 'close') });
    });
    c.duels = (have.length >= 4 ? have : picks).map(function (p) { return duelOf(c, p, dc[p.row.no]); });
    /* the seat list is one archived moment (39 declared, counting on): per-seat lines only on the
       steps after it that are still counting; never lines about all seats (it has 160 of 243) */
    var listWon = demoData.seatList.filter(function (s) { return s.status === 'won'; }).length;
    c.flash = flashOf(c, rowsOf.demo, { seats: f.totals.won >= listWon && f.totals.lead > 0, whole: false });
    c.canFlip = null;
    if (!f.totals.lead) c.close = [];                    // the last step has every seat declared: no seat is still "close"
    return c;
  }
  return {
    start: async function () {
      /* the demo's Hindi names (archived ECI Hindi pages, fetch-election-history.js demo-hi) */
      if (demoData && demoData.hi && DEMO_CODE) learnHi(demoData.folder, DEMO_CODE, demoData.hi, demoData.seatList);
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
          if (c.status !== 'live' && c.status !== 'waiting' && now - (c.updated || c.checkedAt || 0) > FINAL_KEEP_MS) return;        // an old final belongs in "past"
          contests.push(filterBye(c, st));
        });
      });
      /* the practice replay never hides real counting: while ECI shows live trends the demo is skipped */
      var realLive = contests.some(function (c) { return c.status === 'live'; }), demoSkipped = false;
      if (demo && realLive) { demo = false; demoSkipped = true; }
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
      var anyFinal = contests.some(function (c) { return c.status !== 'waiting'; });
      return { generatedAt: new Date(now).toISOString(), mode: demo ? 'demo' : anyLive ? 'live' : anyFinal ? 'final' : contests.length ? 'waiting' : 'past', worker: worker, demoSkipped: demoSkipped,
               checkedAt: lastCheck || null, folders: known, contests: contests, past: past, state: st || null, type: type || 'all',
               alliancesNote: true, majorityNote: true, partyHi: cfg.party_hi, partyColor: cfg.party_color };
    },
    hasDemo: function () { return !!demoData; },
    /* for every screen's watch (a few bytes, every few minutes): what is being counted, and what
       started in the last hour (startedAt: when this server saw it start) */
    watch: function () {
      var now = Date.now(), out = [];
      Object.keys(live).forEach(function (f) {
        Object.keys(live[f].contests).forEach(function (k) {
          var c = live[f].contests[k];
          if (c.status !== 'live') return;
          out.push({ key: c.key, kind: c.kind, state: c.state, title: c.title, en: c.en, hi: c.hi,
                     startedAt: c.startedAt && now - c.startedAt < START_SHOW_MS ? c.startedAt : null });
        });
      });
      return { live: out, at: new Date(now).toISOString() };
    }
  };
}

module.exports = { createElectionRoom: createElectionRoom };
