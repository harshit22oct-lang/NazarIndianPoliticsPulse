/*  live_lib.js  --  Pulse Live (TV page) snapshot logic.
 *
 *  Same idea as news_lib.js / ha_lib.js: the maths lives here as plain
 *  functions, server.js only wires it to Express and Mongo. Everything that
 *  does not need Mongo is exported separately so live_lib.test.js can check
 *  it without a database.
 *
 *  Definitions (also shown to viewers in the "How we count" footer):
 *    post        = an ORIGINAL post: 'Tweet Text' does not start with "RT @"
 *    views       = sum of 'Total Views' of those original posts
 *    mapped      = unique handles in data/handle_master.json (the registry)
 *    collected   = distinct handles with >= 1 post in the trailing 28 days
 *                  (accounts we actually receive data from)
 *    active      = distinct handles with >= 1 original post in the window
 *    window      = IST posting time; 'Tweet Date' is a string
 *                  "YYYY-MM-DD HH:MM:SS IST" so string comparison is safe
 *
 *  Nothing here reads credentials, calls the network or scrapes avatars.
 */
'use strict';

var fs = require('fs');
var HA = require('./ha_lib.js');
var NEWS = require('./news_lib.js');

var C = {
  WIN_H: 24,              // length of a window (default)
  HOURS: [24, 48, 72],    // window lengths a viewer can choose
  FOCUS_PARTY: 'BJP',     // the party with its own "by category" screen
  COVER_MIN: 0.60,        // window must hold >= 60 % of the usual daily volume
  BASE_DAYS: 28,          // usual volume = 75th percentile of the last 28 days
  BASE_PCT: 0.75,
  BASE_MIN_DAYS: 14,      // fewer days of history than this -> no baseline
  LIVE_MIN: 180,          // same limit /healthz uses for the pipeline (hourly)
  STALE_MIN: 360,         // 8x the longest natural overnight gap seen (44 min)
  TOP_PARTIES: 5,
  LEADERS_PER_PARTY: 3,
  MIN_COLLECTED_PARTY: 30,   // fewer collected accounts -> "limited coverage"
  MIN_STATE_POSTS: 20,       // fewer original posts -> state not coloured
  MATURE_H: 6,               // views of posts younger than this are still growing
  BREAK_MIN_RECENT: 3,       // mature originals needed in the window
  BREAK_MIN_BASE: 10,        // originals needed in the 14-day baseline
  BREAK_BASE_DAYS: 14,
  BREAK_MIN_VIEWS: 1000,     // median views per post in the window
  BREAK_MIN_RATIO: 2,
  BREAK_CANDIDATES: 60,
  TICKER_ITEMS: 12,
  TTL_MS: 60000,
  STALE_OK_MS: 10 * 60000,  // an older copy is still served at once (and rebuilt behind it) up to this age
  SAME_DATA_MS: 5 * 60000,  // with env.version unchanged, a copy is rebuilt only after this long
  DAYCOUNT_TTL_MS: 3600000,
  COLLECTED_TTL_MS: 6 * 3600000,
  COLLECTED_WAIT_MS: 1500,
  COMPARE_TTL_MS: 3600000,
  IST_MS: 19800000
};

var SCOPE_Q = { all: {}, up: { State: 'Uttar Pradesh' } };
/* prototype: any state can be a scope -- 'st:Bihar', 'st:West Bengal' ...
   (rows carry the canonical state name, see stateOf; server.js normalises on load) */
/* a chosen window length, or the default */
function hoursOf(h) { var n = +h; return C.HOURS.indexOf(n) >= 0 ? n : C.WIN_H; }
function stateOfScope(scope) {
  if (scope === 'up') return 'Uttar Pradesh';
  var m = /^st:(.+)$/.exec(String(scope || ''));
  return m ? m[1] : null;
}
function scopeQOf(scope) {
  if (SCOPE_Q[scope]) return SCOPE_Q[scope];
  var s = stateOfScope(scope);
  return s ? { State: s } : SCOPE_Q.all;
}

/* State values seen in master_tweets (Oct 2026): real states, plus values that
   are not a place on the map. "Mumbai" is a city filed under State (2.9k posts
   in 8 days) -> Maharashtra. "nan" is a pandas leftover. */
var NO_STATE = { 'national': 1, '-': 1, '': 1, 'nan': 1, 'none': 1, 'null': 1, 'nominated': 1, 'unknown': 1 };
var STATE_ALIAS = {
  'mumbai': 'Maharashtra',
  'dadra nagar haveli & daman-diu': 'Dadra and Nagar Haveli and Daman and Diu',
  'andaman and nicobar islands': 'Andaman and Nicobar'
};

/* ------------------------------------------------------------------ time */

function parseIst(s) {
  var m = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)/.exec(String(s || ''));
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - C.IST_MS;
}
function fmtIst(ms) {
  return new Date(ms + C.IST_MS).toISOString().slice(0, 19).replace('T', ' ') + ' IST';
}
function istDay(ms) { return new Date(ms + C.IST_MS).toISOString().slice(0, 10); }
function addDays(day, n) {
  var t = Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}
function dayStart(day) { return day + ' 00:00:00 IST'; }
function dayEnd(day) { return day + ' 23:59:59 IST'; }

/* --------------------------------------------------------------- helpers */

function pctile(arr, p) {
  if (!arr.length) return null;
  var s = arr.slice().sort(function (a, b) { return a - b; });
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}
function median(arr) { return pctile(arr, 0.5); }
function round(n, d) { var k = Math.pow(10, d || 0); return Math.round(n * k) / k; }

function normParty(p) {
  var s = String(p == null ? '' : p).trim();
  /* "nan" / "none" are pandas leftovers that really occur in the Party column */
  if (!s || s === '-' || /^(unknown|nan|none|null)$/i.test(s) || /^ind(ependent)?$/i.test(s)) return null;
  return s;
}
function isMedia(cat) {
  var c = String(cat || '').trim().toLowerCase();
  return c === 'media house' || c === 'journalist';
}
/* canonical state name, or null when the value is not a place we can map */
function stateOf(st) {
  var s = String(st == null ? '' : st).trim(), k = s.toLowerCase();
  if (NO_STATE[k]) return null;
  return STATE_ALIAS[k] || s;
}
function validState(st) { return stateOf(st) !== null; }

/* account categories as Pulse files them (Category on the post, cat in nazar_handles)
   -> one key per group, shown in this order */
var CAT_ORDER = ['TOP', 'LS_MP', 'RS_MP', 'MLA', 'MLC', 'NOB', 'PAGE', 'MLA_C', 'OTHER'];
var CAT_KEY = { 'top leaders': 'TOP', 'ls_mp': 'LS_MP', 'rs_mp': 'RS_MP', 'mla': 'MLA', 'mlc': 'MLC', 'nob': 'NOB',
                'official page': 'PAGE', 'party page': 'PAGE', 'mla contestent': 'MLA_C', 'mla contestant': 'MLA_C' };
function catOf(cat) { return CAT_KEY[String(cat || '').trim().toLowerCase()] || 'OTHER'; }
function cleanText(t) {
  return String(t || '').replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim();
}

/* Party colours: the dashboard's own PCOLORS table (dashboard.template.html)
   so the TV page looks like the same product. */
var PCOLORS = {
  'BJP': '#E65100', 'INC': '#1565C0', 'TVK': '#7B1FA2', 'DMK': '#C62828', 'AAP': '#00838F',
  'JD(U)': '#1B5E20', 'JMM': '#2E7D32', 'JKNC': '#6A1B9A', 'CPI(M)': '#B71C1C', 'NPP': '#4527A0',
  'ZPM': '#00695C', 'SKM': '#558B2F', 'NDPP': '#607d8b', 'NCP': '#F57F17', 'TDP': '#FF8F00',
  'JSP': '#D4A000', 'TMC': '#0D47A1', 'SP': '#E41E24', 'BSP': '#3F51B5', 'RJD': '#2E7D32'
};
var FALLBACK_COLORS = ['#009688', '#8D6E63', '#5C6BC0', '#AD1457', '#6D4C41', '#0277BD'];
function partyColor(p, i) {
  return PCOLORS[p] || FALLBACK_COLORS[(i || 0) % FALLBACK_COLORS.length];
}

/* ------------------------------------------------------ coverage / window */

/* Usual daily volume before `day`: 75th percentile of the previous 28 days.
   (A 7-day median is fooled by a multi-day outage: on 15 Sep 2026 it called a
   27 %-volume day healthy. See live_lib.test.js.) */
function baselineFor(dayCounts, day) {
  var vals = [];
  for (var i = 1; i <= C.BASE_DAYS; i++) {
    var v = dayCounts[addDays(day, -i)];
    if (typeof v === 'number') vals.push(v);
  }
  if (vals.length < C.BASE_MIN_DAYS) return { value: null, n: vals.length };
  return { value: pctile(vals, C.BASE_PCT), n: vals.length };
}

/* Decide which 24 h to show.
     rolling     : the 24 h ending at the newest post, if it holds enough posts
     lastFullDay : otherwise the latest complete IST day that does
   Coverage is count-based, so it is always an ESTIMATE. */
function planWindow(o) {
  var D = istDay(o.newestMs), H = o.hours || C.WIN_H;
  var base = baselineFor(o.dayCounts, D);
  var res = { mode: 'none', baseline: base.value, baselineDays: base.n, hours: H,
              coverage: null, estimated: true, window: null, prev: null, prevComparable: false };
  var latest = typeof C.LATEST_MIN === 'number';
  if ((base.value === null || base.value <= 0) && !latest) return res;

  /* a window of H hours usually holds H/24 of a usual day */
  var usual = base.value > 0 ? base.value * H / 24 : null;
  var cov = usual ? o.rollingCur / usual : null;
  /* C.LATEST_MIN (optional): keep the latest H hours even below COVER_MIN, marked thin,
     as long as they hold at least this share of the usual volume */
  var thin = latest && (cov === null || cov < C.COVER_MIN) && (cov === null || cov >= C.LATEST_MIN);
  if ((cov !== null && cov >= C.COVER_MIN) || thin) {
    var toMs = o.newestMs, fromMs = toMs - H * 3600000 + 1000;
    res.mode = 'rolling'; res.coverage = cov; res.thin = thin;
    res.window = { from: fmtIst(fromMs), to: fmtIst(toMs), fromMs: fromMs, toMs: toMs };
    var pTo = fromMs - 1000, pFrom = pTo - H * 3600000 + 1000;
    res.prev = { from: fmtIst(pFrom), to: fmtIst(pTo), fromMs: pFrom, toMs: pTo };
    /* growth is shown only when both periods are near-complete (a gap in the source is not a drop) */
    res.prevComparable = !thin && usual !== null && typeof o.rollingPrev === 'number' && (o.rollingPrev / usual) >= C.COVER_MIN;
    return res;
  }
  if (!usual) return res;
  for (var k = 1; k <= 7; k++) {
    var day = addDays(D, -k), n = o.dayCounts[day];
    var b = baselineFor(o.dayCounts, day);
    if (typeof n !== 'number' || b.value === null || b.value <= 0) continue;
    if (n / b.value >= C.COVER_MIN) {
      res.mode = 'lastFullDay'; res.coverage = n / b.value; res.baseline = b.value; res.baselineDays = b.n;
      res.window = { from: dayStart(day), to: dayEnd(day), fromMs: parseIst(dayStart(day)),
                     toMs: parseIst(dayEnd(day)), day: day };
      var pd = addDays(day, -1), pn = o.dayCounts[pd], pb = baselineFor(o.dayCounts, pd);
      res.prev = { from: dayStart(pd), to: dayEnd(pd), fromMs: parseIst(dayStart(pd)),
                   toMs: parseIst(dayEnd(pd)), day: pd };
      res.prevComparable = typeof pn === 'number' && pb.value > 0 && (pn / pb.value) >= C.COVER_MIN;
      res.rollingCoverage = cov;
      return res;
    }
  }
  res.rollingCoverage = cov;
  return res;
}

/* ---------------------------------------------------------------- status */

/* Reads the tail of pipeline.log (written by run_pipeline.py on the host that
   runs the hourly import). Returns null when the file is not there -- on any
   other host this is simply unknown, never guessed. */
function readPipelineState(file, nowMs) {
  var fd = null;
  try {
    var st = fs.statSync(file);
    var len = Math.min(st.size, 16384);
    fd = fs.openSync(file, 'r');
    var buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    return parsePipelineTail(buf.toString('utf8'), nowMs);
  } catch (e) {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (e2) {} }
  }
}
function parsePipelineTail(text, nowMs) {
  var lines = String(text).split(/\r?\n/);
  var lastAt = null, state = 'unknown';
  for (var i = lines.length - 1; i >= 0; i--) {
    var m = /^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\]\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (!lastAt) lastAt = m[1];
    var s = m[2];
    if (/network folder nahi mila/i.test(s)) { state = 'source_unreachable'; break; }
    if (/SCRAPER ne naya data nahi/i.test(s)) { state = 'source_idle'; break; }
    if (/Push poora|Build \+ push/i.test(s)) { state = 'pushed'; break; }
    if (/Naya data nahi/i.test(s)) { state = 'no_new_data'; break; }
  }
  if (!lastAt) return { state: 'unknown', lastAttemptAt: null };
  var ageMin = (nowMs - parseIst(lastAt)) / 60000;
  if (ageMin > C.LIVE_MIN) state = 'log_stale';
  return { state: state, lastAttemptAt: lastAt + ' IST' };
}

/* LIVE is claimed only when the pipeline itself has pushed recently AND the
   newest post is recent AND the source folder is reachable. A recent post
   alone never earns it (the post time is not the ingestion time). */
function chipOf(o) {
  if (o.newestAgeMin === null || o.newestAgeMin === undefined) return { level: 'nodata', label: 'nodata' };
  var recent = o.newestAgeMin <= C.LIVE_MIN;
  var pushed = o.lastPushAgeMin !== null && o.lastPushAgeMin !== undefined && o.lastPushAgeMin <= C.LIVE_MIN;
  var blocked = o.pipelineState === 'source_unreachable';
  if (recent && pushed && !blocked) return { level: 'live', label: 'live' };
  if (recent) return { level: 'recent', label: 'latest' };
  if (o.newestAgeMin <= C.STALE_MIN) return { level: 'delayed', label: 'latest' };
  return { level: 'stale', label: 'latest' };
}

/* --------------------------------------------------------------- metrics */

function dedupeKeyHandle(h) { return String(h || '').toLowerCase(); }

/* rows: window documents (Mongo field names). opts.collected / opts.mapped:
   { party: n } or null. opts.avatarOf(handle) -> url|null. */
function computeMetrics(rows, win, opts) {
  opts = opts || {};
  var collected = opts.collected || null, mapped = opts.mapped || null;
  var avatarOf = opts.avatarOf || function () { return null; };
  var toMs = win.toMs;

  var ex = { media: 0, retweets: 0, noParty: 0, noState: 0 };
  var party = {}, state = {}, handle = {};
  var origPosts = 0, origViews = 0, origLikes = 0, activeAll = {}, top = null;
  /* one party seen in depth (C.FOCUS_PARTY): its totals and its account categories */
  var FP = C.FOCUS_PARTY, fc = { posts: 0, views: 0, likes: 0, reposts: 0, handles: {}, cats: {} };

  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (isMedia(r.Category)) { ex.media++; continue; }
    if (HA.isRetweet(r)) { ex.retweets++; if (FP && normParty(r.Party) === FP) fc.reposts++; continue; }
    var views = HA.num(r['Total Views']), likes = HA.num(r['Total Likes']);
    var h = dedupeKeyHandle(r.Handle);
    var p = normParty(r.Party);
    origPosts++; origViews += views; origLikes += likes; activeAll[h] = 1;
    if (FP && p === FP) {
      fc.posts++; fc.views += views; fc.likes += likes; fc.handles[h] = 1;
      var ck = catOf(r.Category), cc = fc.cats[ck] || (fc.cats[ck] = { cat: ck, posts: 0, views: 0, likes: 0, handles: {}, by: {} });
      cc.posts++; cc.views += views; cc.likes += likes; cc.handles[h] = 1;
      var cb = cc.by[h] || (cc.by[h] = { handle: r.Handle, name: r['Candidate Name'] || r.Handle, state: stateOf(r.State), posts: 0, views: 0 });
      cb.posts++; cb.views += views;
    }

    var sn = stateOf(r.State);
    if (p === null) ex.noParty++;
    if (sn === null) ex.noState++;

    if (p !== null) {
      var pp = party[p] || (party[p] = { party: p, posts: 0, views: 0, likes: 0, handles: {} });
      pp.posts++; pp.views += views; pp.likes += likes; pp.handles[h] = 1;
    }
    if (sn !== null) {
      var ss = state[sn] || (state[sn] = { state: sn, posts: 0, views: 0, parties: {} });
      ss.posts++; ss.views += views;
      if (p !== null) ss.parties[p] = (ss.parties[p] || 0) + 1;
    }
    var hh = handle[h] || (handle[h] = {
      handle: r.Handle, name: r['Candidate Name'] || r.Handle, party: p, state: sn,
      posts: 0, views: 0, mature: [],
      org: /^(official page|party page)$/i.test(String(r.Category || '').trim())   // a party's own account, not a leader
    });
    hh.posts++; hh.views += views;
    var ts = parseIst(r['Tweet Date']);
    if (isFinite(ts) && (toMs - ts) >= C.MATURE_H * 3600000) hh.mature.push(views);

    if (!top || views > top.views) {
      top = { handle: r.Handle, name: r['Candidate Name'] || r.Handle, party: p, state: sn,
              views: views, likes: HA.num(r['Total Likes']), date: String(r['Tweet Date'] || '').slice(0, 19),
              text: cleanText(r['Tweet Text']).slice(0, 220), url: r['Tweet URL'] || '' };
    }
  }

  /* parties: top N by original posts, the rest folded into "Others" */
  var plist = Object.keys(party).map(function (k) { return party[k]; })
    .sort(function (a, b) { return b.posts - a.posts || b.views - a.views; });
  /* A party can be small in posts but big in reach, so "who is seen" needs its
     own top list: show the union of the top 5 by posts and the top 5 by views
     (the page sorts each chart by its own metric). */
  var byViews = plist.slice().sort(function (a, b) { return b.views - a.views; }).slice(0, C.TOP_PARTIES);
  var shown = plist.filter(function (x, i) { return i < C.TOP_PARTIES || byViews.indexOf(x) >= 0; });
  var rest = plist.filter(function (x) { return shown.indexOf(x) < 0; });
  var attributed = plist.reduce(function (a, x) { return a + x.posts; }, 0);
  var attributedViews = plist.reduce(function (a, x) { return a + x.views; }, 0);

  function partyRow(x, i) {
    var active = Object.keys(x.handles).length;
    var col = collected && typeof collected[x.party] === 'number' ? collected[x.party] : null;
    var mp = mapped && typeof mapped[x.party] === 'number' ? mapped[x.party] : null;
    return {
      party: x.party, color: partyColor(x.party, i), posts: x.posts, views: x.views, likes: x.likes || 0,
      postShare: attributed ? round(100 * x.posts / attributed, 1) : null,
      viewShare: attributedViews ? round(100 * x.views / attributedViews, 1) : null,
      accounts: { mapped: mp, collected: col, active: active },
      postsPerCollected: col ? round(x.posts / col, 2) : null,
      viewsPerCollected: col ? Math.round(x.views / col) : null,
      postsPerActive: active ? round(x.posts / active, 2) : null,
      limited: col === null ? null : col < C.MIN_COLLECTED_PARTY
    };
  }
  var parties = shown.map(partyRow);
  if (rest.length) {
    var o = { party: 'Others', posts: 0, views: 0, likes: 0, handles: {} };
    rest.forEach(function (x) { o.posts += x.posts; o.views += x.views; o.likes += x.likes; Object.keys(x.handles).forEach(function (k) { o.handles[k] = 1; }); });
    var orow = partyRow(o, 99);
    orow.color = '#546E7A'; orow.accounts.mapped = null; orow.accounts.collected = null;
    orow.postsPerCollected = null; orow.viewsPerCollected = null; orow.limited = null; orow.parts = rest.length;
    parties.push(orow);
  }

  /* leaders per shown party: most viewed handles in the window */
  var leadersByParty = {};
  shown.forEach(function (x) {
    var arr = Object.keys(handle).map(function (k) { return handle[k]; })
      .filter(function (hd) { return hd.party === x.party && !hd.org; })     // "trending leaders": people, not party pages
      .sort(function (a, b) { return b.views - a.views; })
      .slice(0, C.LEADERS_PER_PARTY);
    leadersByParty[x.party] = arr.map(function (hd) {
      return { handle: hd.handle, name: hd.name, state: hd.state, posts: hd.posts, views: hd.views,
               avatar: avatarOf(hd.handle) };
    });
  });

  var states = Object.keys(state).map(function (k) {
    var s = state[k], lp = null, lpn = 0;
    Object.keys(s.parties).forEach(function (p) { if (s.parties[p] > lpn) { lpn = s.parties[p]; lp = p; } });
    var limited = s.posts < C.MIN_STATE_POSTS;
    return { state: s.state, posts: s.posts, views: s.views, leadParty: limited ? null : lp,
             leadPosts: limited ? null : lpn, color: (!limited && lp) ? partyColor(lp, 0) : null, limited: limited };
  }).sort(function (a, b) { return b.posts - a.posts; });

  /* breakout candidates: highest viewed handles with enough mature posts */
  var cands = Object.keys(handle).map(function (k) { return handle[k]; })
    .filter(function (hd) { return hd.mature.length >= C.BREAK_MIN_RECENT; })
    .sort(function (a, b) { return b.views - a.views; })
    .slice(0, C.BREAK_CANDIDATES)
    .map(function (hd) { return { key: dedupeKeyHandle(hd.handle), handle: hd.handle, name: hd.name, party: hd.party,
                                  state: hd.state, posts: hd.posts, views: hd.views, recentMedian: median(hd.mature) }; });

  /* per-handle totals, kept server-side for the personal view's rankings */
  var handleTotals = {};
  Object.keys(handle).forEach(function (k) {
    var hd = handle[k];
    handleTotals[k] = { handle: hd.handle, name: hd.name, party: hd.party, state: hd.state, posts: hd.posts, views: hd.views };
  });

  /* the focus party: totals, then one row per account category in a fixed order
     (tracked = accounts of that category on the list; opts.trackedCats) */
  var focus = null;
  if (FP && fc.posts) {
    var tc = opts.trackedCats || {}, fpRow = party[FP];
    focus = {
      party: FP, color: partyColor(FP, 0), posts: fc.posts, views: fc.views, likes: fc.likes, reposts: fc.reposts,
      accounts: Object.keys(fc.handles).length, tracked: typeof tc.__total === 'number' ? tc.__total : null,
      postShare: attributed && fpRow ? round(100 * fpRow.posts / attributed, 1) : null,
      cats: CAT_ORDER.filter(function (k) { return fc.cats[k]; }).map(function (k) {
        var c = fc.cats[k], best = Object.keys(c.by).map(function (x) { return c.by[x]; }).sort(function (a, b) { return b.views - a.views; })[0];
        return { cat: k, posts: c.posts, views: c.views, likes: c.likes, accounts: Object.keys(c.handles).length,
                 tracked: typeof tc[k] === 'number' ? tc[k] : null,
                 top: best ? { handle: best.handle, name: best.name, state: best.state, posts: best.posts, views: best.views, avatar: avatarOf(best.handle) } : null };
      })
    };
  }

  return {
    kpis: { originalPosts: origPosts, views: origViews, likes: origLikes, accounts: Object.keys(activeAll).length,
            statesCovered: states.filter(function (s) { return !s.limited; }).length },
    focus: focus,
    excluded: ex,
    parties: parties,
    leadersByParty: leadersByParty,
    states: states,
    topPost: top,
    breakoutCandidates: cands,
    handleTotals: handleTotals
  };
}

/* Breakout = a handle's median views per (mature) post in the window divided by
   its own median over the previous 14 days. Fresh posts are left out because
   their views are still growing; tiny bases are left out because ratios on
   them are noise. baseRows: [{Handle, 'Tweet Text', 'Total Views'}]. */
function computeBreakout(cands, baseRows) {
  var by = {};
  for (var i = 0; i < baseRows.length; i++) {
    var r = baseRows[i];
    if (HA.isRetweet(r)) continue;
    var k = dedupeKeyHandle(r.Handle);
    (by[k] || (by[k] = [])).push(HA.num(r['Total Views']));
  }
  var out = [];
  cands.forEach(function (c) {
    var b = by[c.key];
    if (!b || b.length < C.BREAK_MIN_BASE) return;
    if (c.recentMedian === null || c.recentMedian < C.BREAK_MIN_VIEWS) return;
    var bm = Math.max(median(b), 1);
    var ratio = c.recentMedian / bm;
    if (ratio < C.BREAK_MIN_RATIO) return;
    out.push({ handle: c.handle, name: c.name, party: c.party, state: c.state, ratio: round(ratio, 1),
               recentMedian: Math.round(c.recentMedian), baseMedian: Math.round(bm),
               basePosts: b.length, posts: c.posts, views: c.views });
  });
  out.sort(function (a, b) { return b.ratio - a.ratio || b.views - a.views; });
  return out.slice(0, 5);
}

/* Plain-language facts, as DATA. The page turns them into English / Hindi
   sentences. A fact is only produced when its inputs are present and large
   enough; nothing is inferred about support, mood or who "is winning". */
function makeFacts(s) {
  var f = [];
  if (!s.window) return f;
  f.push({ type: 'window_posts', posts: s.kpis.originalPosts, accounts: s.kpis.accounts });

  var ranked = s.parties.filter(function (p) {
    return p.party !== 'Others' && p.accounts.collected !== null && p.accounts.collected >= C.MIN_COLLECTED_PARTY && p.postsPerCollected !== null;
  });
  if (ranked.length >= 2) {
    var a = ranked[0], b = ranked[1];
    f.push({ type: 'party_per_account', a: a.party, b: b.party, aPer: a.postsPerCollected, bPer: b.postsPerCollected,
             aAccounts: a.accounts.collected, bAccounts: b.accounts.collected });
  }
  var st = s.states.filter(function (x) { return !x.limited; })[0];
  if (st && !stateOfScope(s.scope)) f.push({ type: 'top_state', state: st.state, posts: st.posts });   // inside one state it says nothing
  if (s.topPost && s.topPost.views > 0) {
    f.push({ type: 'top_post', name: s.topPost.name, handle: s.topPost.handle, views: s.topPost.views });
  }
  if (s.breakout && s.breakout.length) {
    var br = s.breakout[0];
    f.push({ type: 'breakout', name: br.name, party: br.party, ratio: br.ratio });
  }
  if (s.excluded.media >= 20) f.push({ type: 'media_volume', posts: s.excluded.media });
  if (s.compare && s.compare.comparable && s.compare.prevPosts >= 500) {
    var pct = round(100 * (s.kpis.originalPosts - s.compare.prevPosts) / s.compare.prevPosts, 0);
    if (Math.abs(pct) >= 10) f.push({ type: 'vs_previous', cur: s.kpis.originalPosts, prev: s.compare.prevPosts, pct: pct });
  }
  return f;
}

/* ----------------------------------------------------- mapped / handles */

/* master: parsed data/handle_master.json (handle -> record). Non-media only,
   case-insensitive unique handles. onlyState (e.g. 'Uttar Pradesh') keeps the
   count comparable with a state-scoped dashboard. */
function countMapped(master, onlyState) {
  var seen = {}, by = {}, byCat = {}, total = 0;
  Object.keys(master || {}).forEach(function (k) {
    var r = master[k] || {};
    var h = String(r.handle || k).toLowerCase();
    if (!h || seen[h]) return;
    seen[h] = 1;
    if (isMedia(r.category)) return;
    if (onlyState && stateOf(r.state) !== onlyState) return;
    total++;
    var p = normParty(r.party);
    if (p) {
      by[p] = (by[p] || 0) + 1;
      var bc = byCat[p] || (byCat[p] = { __total: 0 }), ck = catOf(r.category);
      bc[ck] = (bc[ck] || 0) + 1; bc.__total++;
    }
  });
  /* byPartyCat: { party: { catKey: n, __total: n } } */
  return { byParty: by, byPartyCat: byCat, total: total };
}

/* ------------------------------------------------------------ Mongo side */

var PROJ = {
  _id: 0, Handle: 1, 'Candidate Name': 1, Party: 1, State: 1, Category: 1,
  'Tweet Date': 1, 'Tweet Text': 1, 'Tweet URL': 1, 'Total Views': 1, 'Total Likes': 1
};

async function newestPost(coll, scopeQ, asofMs, nowMs) {
  var cap = fmtIst(asofMs !== null ? asofMs : nowMs + 24 * 3600000);
  var q = Object.assign({}, scopeQ, { 'Tweet Date': { $lte: cap } });
  var d = await coll.find(q, { projection: { _id: 0, 'Tweet Date': 1 } })
    .sort({ 'Tweet Date': -1 }).limit(1).maxTimeMS(20000).toArray();
  return d.length ? parseIst(d[0]['Tweet Date']) : NaN;
}

async function rangeCount(coll, scopeQ, fromStr, toStr) {
  var q = Object.assign({}, scopeQ, { 'Tweet Date': { $gte: fromStr, $lte: toStr } });
  return coll.countDocuments(q, { maxTimeMS: 20000 });
}

/* daily totals for the 36 days ending at `day` (index range counts) */
async function fetchDayCounts(coll, scopeQ, day) {
  var days = [];
  for (var i = 0; i < C.BASE_DAYS + 8; i++) days.push(addDays(day, -i));
  var out = {};
  for (var j = 0; j < days.length; j += 6) {
    var chunk = days.slice(j, j + 6);
    var res = await Promise.all(chunk.map(function (d) { return rangeCount(coll, scopeQ, dayStart(d), dayEnd(d)); }));
    chunk.forEach(function (d, k) { out[d] = res[k]; });
  }
  return out;
}

/* distinct handles per party over the trailing 28 days (non-media) */
async function fetchCollected(coll, scopeQ, toMs) {
  var from = fmtIst(toMs - C.BASE_DAYS * 86400000 + 1000), to = fmtIst(toMs);
  var q = Object.assign({}, scopeQ, { 'Tweet Date': { $gte: from, $lte: to },
                                      Category: { $nin: NEWS.MEDIA_CATS } });
  var rows = await coll.aggregate([
    { $match: q },
    { $group: { _id: { p: '$Party', h: { $toLower: '$Handle' } } } },
    { $group: { _id: '$_id.p', n: { $sum: 1 } } }
  ], { maxTimeMS: 120000, allowDiskUse: true }).toArray();
  var by = {};
  rows.forEach(function (r) {
    var p = normParty(r._id);
    if (p) by[p] = (by[p] || 0) + r.n;
  });
  return by;
}

async function fetchBaselineRows(coll, handles, fromMs, toMs) {
  if (!handles.length) return [];
  var q = { Handle: { $in: handles }, 'Tweet Date': { $gte: fmtIst(fromMs), $lt: fmtIst(toMs) } };
  return coll.find(q, { projection: { _id: 0, Handle: 1, 'Tweet Text': 1, 'Total Views': 1 } })
    .maxTimeMS(60000).toArray();
}

/* ----------------------------------------------------- personal view (pure) */

var HONORIFIC = /^(shri|smt|dr|sri|km|kumari|mr|mrs|ms|sardar|adv|prof|capt|col)\.?\s+/i;
function plainName(n) { return String(n || '').replace(HONORIFIC, '').replace(HONORIFIC, '').trim(); }
function keyOf(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9ऀ-ॿ]+/g, ' ').trim(); }
function realAc(ac) { var a = String(ac || '').trim(); return a && a !== '-' && !/^(nan|none|null)$/i.test(a) ? a : null; }

/* master (handle_master.json) -> searchable list, non-media accounts only */
function buildPeople(master) {
  var seen = {}, out = [];
  Object.keys(master || {}).forEach(function (k) {
    var r = master[k] || {}, h = String(r.handle || k);
    var lk = h.toLowerCase();
    if (!h || seen[lk] || isMedia(r.category)) return;
    seen[lk] = 1;
    var desig = (r.designations && r.designations[0]) || (r.levels && r.levels[0]) || r.category || '';
    out.push({ handle: h, key: lk, name: r.name || h, nameKey: keyOf(plainName(r.name)), party: normParty(r.party),
               state: stateOf(r.state), ac: realAc(r.ac_name), pc: realAc(r.pc_name), designation: String(desig).replace(/_/g, ' ') });
  });
  return out;
}

/* ranked suggestions: exact handle > handle prefix > name word prefix > contains */
function searchPeople(people, q, onlyState, limit) {
  var k = keyOf(String(q || '').replace(/^@/, '')), hk = String(q || '').replace(/^@/, '').trim().toLowerCase();
  if (k.length < 2) return [];
  var res = [];
  for (var i = 0; i < people.length; i++) {
    var p = people[i];
    if (onlyState && p.state !== onlyState) continue;
    /* people type names more often than handles, so a name match counts at
       least as much as a handle prefix */
    var s = 0;
    if (p.key === hk) s = 100;
    if ((' ' + p.nameKey).indexOf(' ' + k) >= 0) s = Math.max(s, 70 + (p.nameKey.indexOf(k) === 0 ? 10 : 0));
    if (p.key.indexOf(hk) === 0) s = Math.max(s, 70);
    if (!s && (p.nameKey.indexOf(k) >= 0 || p.key.indexOf(hk) >= 0)) s = 30;
    if (!s) continue;
    if (p.party === 'BJP') s += 1;                               // tie-break only
    res.push({ s: s, p: p });
  }
  res.sort(function (a, b) { return b.s - a.s || a.p.name.length - b.p.name.length; });
  return res.slice(0, limit || 10).map(function (x) { return x.p; });
}

function rankIn(totals, key, filter) {
  var arr = Object.keys(totals).filter(function (k) { return !filter || filter(totals[k]); })
    .sort(function (a, b) { return totals[b].views - totals[a].views; });
  var i = arr.indexOf(key);
  return i < 0 ? null : { rank: i + 1, of: arr.length };
}

/* rows: this handle's posts from 14 days before the window to its end */
function computePerson(rec, rows, win) {
  var inWin = [], base = [];
  rows.forEach(function (r) {
    var t = parseIst(r['Tweet Date']);
    if (!isFinite(t)) return;
    r._t = t;
    if (t >= win.fromMs && t <= win.toMs) inWin.push(r); else if (t < win.fromMs) base.push(r);
  });
  var orig = inWin.filter(function (r) { return !HA.isRetweet(r); });
  var hourly = []; for (var i = 0; i < 24; i++) hourly.push(0);
  inWin.forEach(function (r) { hourly[new Date(r._t + C.IST_MS).getUTCHours()]++; });

  var endDay = istDay(win.toMs), daily = [];
  for (var d = 6; d >= 0; d--) daily.push({ day: addDays(endDay, -d), posts: 0 });
  var dayIx = {}; daily.forEach(function (x, j) { dayIx[x.day] = j; });
  rows.forEach(function (r) { var j = dayIx[istDay(r._t)]; if (j !== undefined && !HA.isRetweet(r)) daily[j].posts++; });

  var views = 0, likes = 0, top = null, latest = null;
  orig.forEach(function (r) {
    var v = HA.num(r['Total Views']); views += v; likes += HA.num(r['Total Likes']);
    if (!top || v > top.views) top = slimPost(r, v);
    if (!latest || r._t > latest._t) latest = r;
  });
  var mature = orig.filter(function (r) { return win.toMs - r._t >= C.MATURE_H * 3600000; })
    .map(function (r) { return HA.num(r['Total Views']); });
  var baseOrig = base.filter(function (r) { return !HA.isRetweet(r); });
  var baseDays = Math.max(1, Math.round((win.fromMs - (win.fromMs - C.BREAK_BASE_DAYS * 86400000)) / 86400000));
  var winDays = Math.max(1 / 24, (win.toMs - win.fromMs) / 86400000);
  var usualPerDay = baseOrig.length / baseDays;
  var baseMed = median(baseOrig.map(function (r) { return HA.num(r['Total Views']); }));
  var recMed = median(mature);
  return {
    kpis: { posts: orig.length, reposts: inWin.length - orig.length, views: views, likes: likes,
            avgViews: orig.length ? Math.round(views / orig.length) : null },
    usual: {
      postsPerDay: baseOrig.length >= 5 ? round(usualPerDay, 1) : null,
      postsVsUsual: baseOrig.length >= 5 && usualPerDay > 0 ? round((orig.length / winDays) / usualPerDay, 1) : null,
      viewsPerPost: baseOrig.length >= 5 ? Math.round(baseMed) : null,
      viewsVsUsual: baseOrig.length >= 5 && mature.length >= 2 && baseMed > 0 ? round(recMed / baseMed, 1) : null
    },
    hourly: hourly, daily: daily, topPost: top, latestPost: latest ? slimPost(latest, HA.num(latest['Total Views'])) : null
  };
}
function slimPost(r, v) {
  return { text: cleanText(r['Tweet Text']).slice(0, 220), views: v, likes: HA.num(r['Total Likes']),
           date: String(r['Tweet Date'] || '').slice(0, 19), url: r['Tweet URL'] || '' };
}

/* rival-party accounts: same constituency first, else the busiest rivals in the state */
function rivalsFor(rec, people, totals) {
  if (!rec.party) return { mode: 'none', list: [] };
  if (rec.ac && rec.state) {
    var acK = keyOf(rec.ac);
    var ac = people.filter(function (p) {
      return p.key !== rec.key && p.state === rec.state && p.ac && keyOf(p.ac) === acK && p.party && p.party !== rec.party;
    });
    if (ac.length) return { mode: 'constituency', place: rec.ac, list: ac.slice(0, 4) };
  }
  if (!rec.state) return { mode: 'none', list: [] };
  var st = Object.keys(totals).filter(function (k) {
    var t = totals[k]; return t.state === rec.state && t.party && t.party !== rec.party;
  }).sort(function (a, b) { return totals[b].views - totals[a].views; }).slice(0, 4);
  var byKey = {}; people.forEach(function (p) { byKey[p.key] = p; });
  return { mode: 'state', place: rec.state, list: st.map(function (k) { return byKey[k] || { handle: totals[k].handle, key: k, name: totals[k].name, party: totals[k].party, state: totals[k].state }; }) };
}

function personFacts(p) {
  var f = [];
  if (!p.window) return f;
  f.push({ type: 'p_posts', posts: p.kpis.posts, reposts: p.kpis.reposts });
  if (p.usual.postsVsUsual !== null && p.kpis.posts > 0) f.push({ type: 'p_vs_usual', x: p.usual.postsVsUsual, perDay: p.usual.postsPerDay });
  if (p.rank && p.rank.state) f.push({ type: 'p_rank_state', rank: p.rank.state.rank, of: p.rank.state.of, state: p.person.state });
  if (p.rank && p.rank.party) f.push({ type: 'p_rank_party', rank: p.rank.party.rank, of: p.rank.party.of, party: p.person.party });
  if (p.topPost && p.topPost.views > 0) f.push({ type: 'p_top', views: p.topPost.views });
  if (p.rivals && p.rivals.mode === 'constituency' && p.rivals.list.length) {
    var busier = p.rivals.list.filter(function (r) { return r.posts > p.kpis.posts; }).length;
    f.push({ type: 'p_rivals', place: p.rivals.place, n: p.rivals.list.length, busier: busier });
  }
  if (p.mentions && p.mentions.length) f.push({ type: 'p_mentions', n: p.mentions.length });
  return f;
}

/* ----------------------------------------------------------- the service */

/* env: { coll, now(), mapped() -> {byParty,total}, avatarOf(handle),
          lastPush(scope) -> Promise<string|''>, pipeline() -> state|null,
          news(scope) -> Promise<rows[]>, postsInDb() -> Promise<number> }  */
function createService(env) {
  var snaps = {};              // key -> { at, p, v, pending }
  var dayCache = {};           // key -> { at, v }
  var collCache = {};          // key -> { at, p, v }
  var cmpCache = {};           // previous-window totals
  var order = [];

  function touch(k) {
    var i = order.indexOf(k); if (i >= 0) order.splice(i, 1);
    order.push(k);
    while (order.length > 24) { var old = order.shift(); delete snaps[old]; }   // scopes x window lengths
  }

  async function cachedDayCounts(scope, scopeQ, day) {
    var k = scope + '|' + day, h = dayCache[k], now = env.now();
    if (h && now - h.at < C.DAYCOUNT_TTL_MS) return h.v;
    /* env.dayCounts (optional): daily totals from a summary table (Pulse's nazar_daily),
       so days that are not held as raw posts still count. null -> count the posts here. */
    var v = null;
    if (env.dayCounts) {
      var days = [];
      for (var i = 0; i < C.BASE_DAYS + 8; i++) days.push(addDays(day, -i));
      try { v = await env.dayCounts(scope, days); } catch (e) { v = null; }
    }
    if (!v) v = await fetchDayCounts(env.coll, scopeQ, day);
    dayCache[k] = { at: now, v: v };
    return v;
  }
  /* collected handles are slow to compute and slow-moving: one shared promise */
  function cachedCollected(scope, scopeQ, toMs) {
    var k = scope, h = collCache[k], now = env.now();
    if (h && (h.pending || now - h.at < C.COLLECTED_TTL_MS)) return h.p;
    var e = { at: now, pending: true, p: null, v: null };
    /* env.collected (optional): same count from a summary table; null -> count the posts here */
    var job = env.collected ? Promise.resolve(env.collected(scope, toMs)).catch(function () { return null; }) : Promise.resolve(null);
    e.p = job.then(function (v) { return v || fetchCollected(env.coll, scopeQ, toMs); }).then(function (v) { e.v = v; e.pending = false; e.at = env.now(); return v; },
      function () { e.pending = false; e.at = 0; return h && h.v ? h.v : null; });
    collCache[k] = e;
    return e.p;
  }

  async function build(scope, asofMs, hours) {
    var nowMs = env.now(), scopeQ = scopeQOf(scope), coll = env.coll, H = hours || C.WIN_H;
    var newestMs = await newestPost(coll, scopeQ, asofMs, nowMs);
    var out = { scope: scope, generatedAt: new Date(nowMs).toISOString(), mode: asofMs !== null ? 'historical' : 'current' };
    if (asofMs !== null) out.asof = fmtIst(asofMs);

    /* push time and pipeline state describe NOW; a historical test must not
       inherit them. */
    var push = '';
    if (asofMs === null) { try { push = await env.lastPush(scope); } catch (e) { push = ''; } }
    var pushMs = push ? parseIst(push) : NaN;
    var pipe = null;
    if (asofMs === null) { try { pipe = env.pipeline(); } catch (e) { pipe = null; } }
    var refMs = asofMs !== null ? asofMs : nowMs;
    var newestAge = isFinite(newestMs) ? Math.max(0, Math.round((refMs - newestMs) / 60000)) : null;
    var pushAge = isFinite(pushMs) ? Math.max(0, Math.round((refMs - pushMs) / 60000)) : null;
    var chip = chipOf({ newestAgeMin: newestAge, lastPushAgeMin: asofMs !== null ? null : pushAge,
                        pipelineState: pipe ? pipe.state : null });
    out.status = {
      level: chip.level, label: chip.label,
      newestPostAt: isFinite(newestMs) ? fmtIst(newestMs) : null, newestAgeMin: newestAge,
      lastPushAt: isFinite(pushMs) ? push + ' IST' : null, lastPushAgeMin: pushAge,
      pipeline: pipe || null
    };
    if (!isFinite(newestMs)) { out.window = null; out.coverage = { estimated: true, ratio: null, mode: 'none' }; out.facts = []; return out; }

    var D = istDay(newestMs);
    var dayCounts = await cachedDayCounts(scope, scopeQ, D);
    var rollTo = fmtIst(newestMs), rollFrom = fmtIst(newestMs - H * 3600000 + 1000);
    var rollPFrom = fmtIst(newestMs - 2 * H * 3600000 + 1000), rollPTo = fmtIst(newestMs - H * 3600000);
    var counts = await Promise.all([rangeCount(coll, scopeQ, rollFrom, rollTo), rangeCount(coll, scopeQ, rollPFrom, rollPTo)]);
    var plan = planWindow({ newestMs: newestMs, dayCounts: dayCounts, rollingCur: counts[0], rollingPrev: counts[1], hours: H });
    out.hours = H;

    var partial = plan.mode === 'lastFullDay' || plan.mode === 'none' || plan.thin ||
                  (pipe && (pipe.state === 'source_unreachable' || pipe.state === 'log_stale'));
    var rr = plan.rollingCoverage !== undefined ? plan.rollingCoverage : plan.coverage;
    out.coverage = { estimated: true, ratio: plan.coverage === null ? null : round(plan.coverage, 2),
                     rollingRatio: rr === null || rr === undefined ? null : round(rr, 2),
                     baseline: plan.baseline === null ? null : Math.round(plan.baseline), baselineDays: plan.baselineDays,
                     mode: plan.mode, partial: !!partial,
                     partialReason: plan.mode === 'lastFullDay' ? 'rolling-window-incomplete'
                       : plan.mode === 'none' ? 'no-complete-window'
                       : plan.thin ? 'rolling-window-thin'
                       : (partial ? 'pipeline-' + pipe.state : null) };
    out.window = plan.window ? { mode: plan.mode, from: plan.window.from, to: plan.window.to, day: plan.window.day || null, thin: !!plan.thin } : null;
    out.prevWindow = plan.prev ? { from: plan.prev.from, to: plan.prev.to, comparable: !!plan.prevComparable } : null;
    if (!plan.window) { out.facts = []; return out; }

    var win = plan.window;
    var q = Object.assign({}, scopeQ, { 'Tweet Date': { $gte: win.from, $lte: win.to } });
    var rows = await coll.find(q, { projection: PROJ }).maxTimeMS(30000).toArray();
    /* the 28-day distinct-handle count is slow (~2 s on 770k docs) and slow
       moving: wait for it only briefly. If it is not ready this minute the
       per-account lines say "not enough data" and fill in on the next refresh. */
    var collected = await Promise.race([
      cachedCollected(scope, scopeQ, newestMs),
      new Promise(function (res) { setTimeout(function () { res(null); }, C.COLLECTED_WAIT_MS); })
    ]);
    var mp = env.mapped(scope);
    var m = computeMetrics(rows, win, { collected: collected, mapped: mp ? mp.byParty : null, avatarOf: env.avatarOf,
                                        trackedCats: mp && mp.byPartyCat ? mp.byPartyCat[C.FOCUS_PARTY] : null });

    var baseFrom = win.fromMs - C.BREAK_BASE_DAYS * 86400000;
    var baseRows = await fetchBaselineRows(coll, m.breakoutCandidates.map(function (c) { return c.handle; }), baseFrom, win.fromMs);
    var breakout = computeBreakout(m.breakoutCandidates, baseRows).map(function (b) { b.avatar = env.avatarOf(b.handle); return b; });

    /* previous-window totals only change when new data lands, so keep them */
    var compare = { comparable: false };
    if (plan.prevComparable && plan.prev) {
      var ck = scope + '|' + plan.prev.from + '|' + plan.prev.to, ch = cmpCache[ck];
      if (ch && env.now() - ch.at < C.COMPARE_TTL_MS) compare = ch.v;
      else {
        var pq = Object.assign({}, scopeQ, { 'Tweet Date': { $gte: plan.prev.from, $lte: plan.prev.to } });
        var prow = await coll.find(pq, { projection: PROJ }).maxTimeMS(30000).toArray();
        var pm = computeMetrics(prow, plan.prev, {});
        /* per party too (all parties, not only the ones shown), so every bar can show its growth */
        var pp = {};
        prow.forEach(function (r) {
          if (isMedia(r.Category) || HA.isRetweet(r)) return;
          var p = normParty(r.Party); if (!p) return;
          var x = pp[p] || (pp[p] = { posts: 0, views: 0, likes: 0 });
          x.posts++; x.views += HA.num(r['Total Views']); x.likes += HA.num(r['Total Likes']);
        });
        /* the focus party's previous period, per category too */
        var pf = null;
        if (pm.focus) {
          pf = { posts: pm.focus.posts, views: pm.focus.views, likes: pm.focus.likes, accounts: pm.focus.accounts, cats: {} };
          pm.focus.cats.forEach(function (c) { pf.cats[c.cat] = { posts: c.posts, views: c.views, likes: c.likes }; });
        }
        compare = { comparable: true, prevPosts: pm.kpis.originalPosts, prevViews: pm.kpis.views, prevLikes: pm.kpis.likes,
                    parties: pp, focus: pf, prevFrom: plan.prev.from, prevTo: plan.prev.to };
        cmpCache[ck] = { at: env.now(), v: compare };
      }
    }

    var ticker = [];
    try { ticker = await env.news(scope, win); } catch (e) { ticker = []; }     // news of the same period
    var pidb = null, allTime = null;
    try { pidb = await env.postsInDb(scope); } catch (e) { pidb = null; }
    /* env.allTime (optional): { posts, views, likes, since } over every day we have */
    try { allTime = env.allTime ? await env.allTime(scope) : null; } catch (e) { allTime = null; }

    out.kpis = m.kpis; out.excluded = m.excluded; out.parties = m.parties; out.focus = m.focus;
    out.leadersByParty = m.leadersByParty; out.states = m.states; out.topPost = m.topPost;
    out.breakout = breakout; out.compare = compare; out.ticker = ticker;
    out.coverageStats = { handlesMapped: mp ? mp.total : null, postsInDatabase: pidb, allTime: allTime };
    out.parties.forEach(function (p) { p.logo = env.partyLogo ? env.partyLogo(p.party) : null; });
    out.facts = makeFacts(out);
    /* not sent to the browser (non-enumerable), used by the personal view */
    Object.defineProperty(out, '_handles', { value: m.handleTotals, enumerable: false });
    Object.defineProperty(out, '_win', { value: win, enumerable: false });
    return out;
  }

  /* opts.asofMs: historical anchor (admin / localhost only, checked by the
     route). Historical requests never touch the shared cache. */
  function get(scope, opts) {
    opts = opts || {};
    var asofMs = typeof opts.asofMs === 'number' && isFinite(opts.asofMs) ? opts.asofMs : null;
    var H = hoursOf(opts.hours);
    if (asofMs !== null) return build(scope, asofMs, H);

    var k = scope + '|auto|' + H, e = snaps[k], now = env.now();
    /* env.version (optional): changes whenever the data does. Same data -> the copy stays
       good for C.SAME_DATA_MS (only "minutes ago" texts age), no rebuild every minute */
    var ver = env.version ? env.version() : null;
    if (e && !e.pending && e.v && ver !== null && e.ver === ver && now - e.v.__at < C.SAME_DATA_MS) { touch(k); return Promise.resolve(e.v); }
    if (e && (e.pending || now - e.at < C.TTL_MS) && e.p) {
      touch(k);
      /* a rebuild is running: answer with the last good copy instead of waiting for it */
      return e.pending && e.v && now - e.v.__at < C.STALE_OK_MS ? Promise.resolve(e.v) : e.p;
    }
    /* stale but recent: answer at once with it and rebuild in the background
       (stale-while-revalidate) -- nobody waits for the maths after the first build */
    var serveOld = e && e.v && now - e.v.__at < C.STALE_OK_MS;
    var ne = { at: now, pending: true, p: null, v: e ? e.v : null, ver: e ? e.ver : null };
    ne.p = build(scope, null, H).then(function (v) {
      ne.ver = ver;
      Object.defineProperty(v, '__at', { value: env.now(), enumerable: false });   // when it was built (not sent)
      ne.v = v; ne.pending = false; ne.at = env.now(); return v;
    }, function (err) {
      ne.pending = false; ne.at = 0;                       // failed promise is not cached
      try { console.log('  [live-snapshot] build failed: ' + (err && err.message || err)); } catch (e) {}
      if (ne.v) {
        var c = Object.assign({}, ne.v);
        /* the reason stays in the server log; viewers only learn that this is old data */
        c.degraded = { servedLastGood: true, generatedAt: ne.v.generatedAt };
        return c;
      }
      throw err;
    });
    snaps[k] = ne; touch(k);
    return serveOld ? Promise.resolve(e.v) : ne.p;
  }

  /* ---------------- personal view ---------------- */
  var peopleMemo = { src: null, list: [] };
  function people() {
    var m = env.master ? env.master() : null;
    if (m && peopleMemo.src !== m) peopleMemo = { src: m, list: buildPeople(m) };
    return peopleMemo.list;
  }
  function onlyStateFor(scope) { return stateOfScope(scope); }
  function card(p) {
    return { handle: p.handle, name: p.name, party: p.party, state: p.state, ac: p.ac, designation: p.designation,
             avatar: env.avatarOf(p.handle), color: p.party ? partyColor(p.party, 0) : '#546E7A' };
  }
  function search(scope, q) { return searchPeople(people(), q, onlyStateFor(scope), 10).map(card); }
  function findPerson(scope, h) {
    var k = String(h || '').replace(/^@/, '').trim().toLowerCase(), list = people();
    for (var i = 0; i < list.length; i++) {
      if (list[i].key === k) return onlyStateFor(scope) && list[i].state !== onlyStateFor(scope) ? null : list[i];
    }
    return null;
  }

  var personCache = {}, personOrder = [];
  async function buildPerson(scope, rec, opts) {
    var snap = await get(scope, opts);
    var out = { scope: scope, generatedAt: new Date(env.now()).toISOString(), mode: snap.mode, asof: snap.asof,
                status: snap.status, coverage: snap.coverage, window: snap.window, person: card(rec) };
    out.person.ac = rec.ac; out.person.pc = rec.pc;
    out.person.partyLogo = env.partyLogo && rec.party ? env.partyLogo(rec.party) : null;
    if (snap.degraded) out.degraded = snap.degraded;
    if (!snap.window) { out.facts = []; return out; }
    var win = snap._win || { from: snap.window.from, to: snap.window.to, fromMs: parseIst(snap.window.from), toMs: parseIst(snap.window.to) };
    var coll = env.coll;
    var q = { Handle: rec.handle, 'Tweet Date': { $gte: fmtIst(win.fromMs - C.BREAK_BASE_DAYS * 86400000), $lte: win.to } };
    var rows = await coll.find(q, { projection: PROJ }).maxTimeMS(30000).toArray();
    if (!rows.length) {                                   // the tweet data may spell the handle differently
      var rx = new RegExp('^' + rec.handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
      q.Handle = rx;
      rows = await coll.find(q, { projection: PROJ }).maxTimeMS(30000).toArray();
    }
    var m = computePerson(rec, rows, win);
    out.kpis = m.kpis; out.usual = m.usual; out.hourly = m.hourly; out.daily = m.daily;
    out.topPost = m.topPost; out.latestPost = m.latestPost;
    if (!rows.length) {
      var last = await coll.find({ Handle: q.Handle }, { projection: { _id: 0, 'Tweet Date': 1 } })
        .sort({ 'Tweet Date': -1 }).limit(1).maxTimeMS(20000).toArray();
      out.lastPostEver = last.length ? String(last[0]['Tweet Date']).slice(0, 19) : null;
    }

    var totals = snap._handles || null;
    out.rank = null;
    if (totals && totals[rec.key]) {
      out.rank = {
        all: rankIn(totals, rec.key),
        party: rec.party ? rankIn(totals, rec.key, function (t) { return t.party === rec.party; }) : null,
        state: rec.state ? rankIn(totals, rec.key, function (t) { return t.state === rec.state; }) : null
      };
    }
    out.colleagues = !totals ? [] : Object.keys(totals).filter(function (k) {
      var t = totals[k]; return k !== rec.key && rec.party && t.party === rec.party && rec.state && t.state === rec.state;
    }).sort(function (a, b) { return totals[b].views - totals[a].views; }).slice(0, 3)
      .map(function (k) { var t = totals[k]; return { handle: t.handle, name: t.name, posts: t.posts, views: t.views, avatar: env.avatarOf(t.handle) }; });

    var riv = rivalsFor(rec, people(), totals || {});
    var rh = riv.list.map(function (p) { return p.handle; });
    var rrows = rh.length ? await coll.find({ Handle: { $in: rh }, 'Tweet Date': { $gte: win.from, $lte: win.to } }, { projection: PROJ })
      .sort({ 'Tweet Date': -1 }).limit(400).maxTimeMS(30000).toArray() : [];
    out.rivals = { mode: riv.mode, place: riv.place || null, list: riv.list.map(function (p) {
      var mine = rrows.filter(function (r) { return String(r.Handle).toLowerCase() === p.key && !HA.isRetweet(r); });
      var v = 0; mine.forEach(function (r) { v += HA.num(r['Total Views']); });
      return { handle: p.handle, name: p.name, party: p.party, color: p.party ? partyColor(p.party, 0) : '#546E7A',
               avatar: env.avatarOf(p.handle), posts: mine.length, views: v,
               latest: mine.length ? slimPost(mine[0], HA.num(mine[0]['Total Views'])) : null };
    }) };

    /* media posts that name this leader, then ones about their constituency / state */
    var media = [];
    try { media = env.media ? await env.media(win) : []; } catch (e) { media = []; }
    var nm = plainName(rec.name).toLowerCase(), hk = '@' + rec.key;
    var nameOk = nm.split(' ').length >= 2 && nm.length >= 8;
    var placeK = rec.ac && rec.ac.length >= 5 ? rec.ac.toLowerCase() : null;
    var stK = rec.state ? rec.state.toLowerCase() : null;
    function txt(it) { return (String(it.head || '') + ' ' + String(it.sum || '')).toLowerCase(); }
    var mentions = media.filter(function (it) { var t = txt(it); return t.indexOf(hk) >= 0 || (nameOk && t.indexOf(nm) >= 0); });
    var local = media.filter(function (it) { var t = txt(it); return mentions.indexOf(it) < 0 && ((placeK && t.indexOf(placeK) >= 0) || (stK && t.indexOf(stK) >= 0)); });
    function slimNews(it) { return { head: it.head, src: it.src, date: it.date, topic: it.cat && it.cat !== 'Other' ? it.cat : null }; }
    out.mentions = mentions.slice(0, 6).map(slimNews);
    out.localNews = local.slice(0, 6).map(slimNews);
    out.facts = personFacts(out);
    return out;
  }
  function person(scope, h, opts) {
    opts = opts || {};
    var rec = findPerson(scope, h);
    if (!rec) return Promise.resolve(null);
    if (typeof opts.asofMs === 'number') return buildPerson(scope, rec, opts);
    var H = hoursOf(opts.hours);
    var k = scope + '|' + rec.key + '|' + H, e = personCache[k], now = env.now();
    if (e && (e.pending || now - e.at < C.TTL_MS)) return e.p;
    var ne = { at: now, pending: true, p: null };
    ne.p = buildPerson(scope, rec, { hours: H }).then(function (v) { ne.pending = false; ne.at = env.now(); return v; },
      function (err) { ne.pending = false; ne.at = 0; delete personCache[k]; throw err; });
    personCache[k] = ne;
    personOrder = personOrder.filter(function (x) { return x !== k; }); personOrder.push(k);
    while (personOrder.length > 50) delete personCache[personOrder.shift()];
    return ne.p;
  }

  /* Called once after start-up so the first TV already has the slow 28-day
     account counts. Never throws. */
  function warm(scope) {
    var scopeQ = scopeQOf(scope);
    return newestPost(env.coll, scopeQ, null, env.now())
      .then(function (ms) { if (isFinite(ms)) return cachedCollected(scope, scopeQ, ms); })
      .catch(function () {});
  }

  return { get: get, warm: warm, search: search, person: person };
}

module.exports = {
  C: C, SCOPE_Q: SCOPE_Q, stateOfScope: stateOfScope, scopeQOf: scopeQOf, hoursOf: hoursOf,
  parseIst: parseIst, fmtIst: fmtIst, istDay: istDay, addDays: addDays,
  normParty: normParty, isMedia: isMedia, validState: validState, stateOf: stateOf, partyColor: partyColor,
  baselineFor: baselineFor, planWindow: planWindow,
  parsePipelineTail: parsePipelineTail, readPipelineState: readPipelineState, chipOf: chipOf,
  computeMetrics: computeMetrics, computeBreakout: computeBreakout, makeFacts: makeFacts,
  countMapped: countMapped, createService: createService, catOf: catOf, CAT_ORDER: CAT_ORDER,
  buildPeople: buildPeople, searchPeople: searchPeople, computePerson: computePerson,
  rivalsFor: rivalsFor, personFacts: personFacts, plainName: plainName
};
