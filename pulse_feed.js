/* ==================================================================
 *  pulse_feed.js -- Nazar's numbers straight from Political Pulse
 *  ------------------------------------------------------------------
 *  Political Pulse publishes to MongoDB Atlas, database pulse_hot, and
 *  keeps it current every hour:
 *    tweets        raw posts from nazar_meta.window_start (IST day) to now
 *    nazar_daily   one row per handle x day, for every day BEFORE window_start
 *    nazar_meta    { _id: 'info', window_start, updated_at, first_day, ... }
 *
 *  The one rule (the same one Pulse builds its dashboard with):
 *    day <  window_start  -> nazar_daily (counts)
 *    day >= window_start  -> tweets      (raw posts)
 *  so no day is ever counted twice.
 *
 *  What this module does:
 *    * start: loads the raw window into Nazar's shared in-memory rows (the
 *      rows the screens are computed from) and drops Nazar's own copies of
 *      those days, so Pulse is the only source for them
 *    * every minute: reads nazar_meta and only the newest posts (by ts)
 *    * when Pulse pushes (updated_at / window_start changes, ~hourly): a light
 *      sweep of the window (ids + view/like counts only) refreshes the numbers
 *      of every post and fetches any post that arrived late
 *    * summary(): daily totals, 28-day accounts and all-time totals from
 *      nazar_daily, cached until Pulse pushes again
 *
 *  Read-only: never writes to Atlas. The connection string comes only from
 *  PULSE_MONGO_URL and never appears in logs or answers (see cleanErr).
 *  If Atlas cannot be reached, the last good data stays in use.
 *  Free Atlas tier limits (10 GB out per week): every query is indexed,
 *  projected, and the heavy reads run only when Pulse has new data.
 * ================================================================== */
'use strict';

var MEDIA = ['Media House', 'Journalist'];
var POLL_MS = 60000;
var OVERLAP_MS = 15 * 60000;       // re-read the last 15 min each poll: posts can land a little out of order
var SUMMARY_DAYS = 40;             // daily totals kept for the coverage baseline (live_lib needs 36)
var COLLECTED_DAYS = 28;           // = live_lib C.BASE_DAYS
var PROJ = {
  Handle: 1, 'Candidate Name': 1, 'Tweet ID': 1, 'Tweet URL': 1, 'Tweet Date': 1, 'Tweet Text': 1,
  'Total Views': 1, 'Total Likes': 1, 'Total Retweets': 1, 'Total Comments': 1,
  Sentiment: 1, State: 1, Category: 1, Party: 1, ts: 1
};
var METRICS = ['Total Views', 'Total Likes', 'Total Retweets', 'Total Comments'];

function cleanErr(e) {
  return String(e && e.message || e).replace(/mongodb(\+srv)?:\/\/[^\s@]*@/g, 'mongodb://***@').slice(0, 240);
}
function addDays(day, n) {
  var t = Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}
function byDate(a, b) { return a['Tweet Date'] < b['Tweet Date'] ? -1 : a['Tweet Date'] > b['Tweet Date'] ? 1 : 0; }

/* o: { url, rows (Nazar's shared array, sorted by 'Tweet Date'), clean(doc) -> row | null,
        num(v) -> number, onChange({added, changed}), persist(rows) -> Promise (optional:
        keeps a copy of new / changed posts beyond Pulse's 3 days), log } */
function createPulseFeed(o) {
  var log = o.log || console.log, rows = o.rows;
  var MC = require('mongodb').MongoClient;
  var client = new MC(o.url, { maxPoolSize: 5, serverSelectionTimeoutMS: 8000, socketTimeoutMS: 60000 });
  var db = null, info = null, byId = {}, maxTs = 0, timer = null, busy = false, ready = false, dirty = {};
  var st = { startedAt: null, lastPollAt: null, lastOkAt: null, lastPushSeen: null, lastError: null, lastErrorAt: null,
             polls: 0, sweeps: 0, added: 0, updated: 0, droppedOwn: 0, saved: 0 };
  var sum = { key: null, v: null, p: null, at: null };

  async function conn() {
    if (!db) { await client.connect(); db = client.db('pulse_hot'); }
    return db;
  }
  async function readInfo() {
    var d = await conn();
    var i = await d.collection('nazar_meta').findOne({ _id: 'info' });
    if (!i || !/^\d{4}-\d\d-\d\d$/.test(String(i.window_start || ''))) throw new Error('pulse_hot.nazar_meta has no window_start');
    return i;
  }
  function pushKey(i) { return i ? String(i.window_start) + '|' + new Date(i.updated_at).getTime() : null; }
  function fail(where, e) {
    st.lastError = where + ': ' + cleanErr(e); st.lastErrorAt = new Date().toISOString();
    log('  [pulse] ' + st.lastError);
  }

  /* first index in rows with 'Tweet Date' >= v (rows are sorted) */
  function lowerBound(v) {
    var lo = 0, hi = rows.length;
    while (lo < hi) { var m = (lo + hi) >> 1; if (rows[m]['Tweet Date'] < v) lo = m + 1; else hi = m; }
    return lo;
  }

  /* docs -> shared rows. Returns how many were new / changed. */
  function merge(docs) {
    var added = 0, changed = 0;
    docs.forEach(function (doc) {
      var t = doc.ts instanceof Date ? doc.ts.getTime() : Date.parse(doc.ts);
      if (isFinite(t) && t > maxTs) maxTs = t;
      var row = o.clean(doc);
      if (!row) return;
      var have = byId[row._id];
      if (have) {
        var diff = METRICS.some(function (f) { return have[f] !== row[f]; }) || have['Tweet Text'] !== row['Tweet Text'];
        if (diff) { Object.assign(have, row); changed++; dirty[row._id] = have; }
        return;
      }
      byId[row._id] = row; rows.push(row); added++; dirty[row._id] = row;
    });
    if (added) rows.sort(byDate);
    st.added += added; st.updated += changed;
    /* at once, before any await: the server must index the re-sorted rows before a request reads them */
    if (added || changed) o.onChange({ added: added, changed: changed });
    return { added: added, changed: changed };
  }

  /* the whole raw window -- once at start */
  async function loadWindow() {
    var d = await conn(), t0 = Date.now();
    var docs = await d.collection('tweets').find({ 'Tweet Date': { $gte: info.window_start } }, { projection: PROJ }).toArray();
    /* Pulse owns every day from window_start on: drop Nazar's own copies of those days first */
    /* posts from Pulse already in rows (r._p: Nazar's saved copy, pulse_raw) are kept and only
       updated -- so they are not saved again -- Nazar's own posts of those days go */
    var cut = lowerBound(info.window_start), tail = rows.splice(cut, rows.length - cut), mine = 0;
    tail.forEach(function (r) { if (r._p) { byId[r._id] = r; rows.push(r); } else mine++; });
    st.droppedOwn += mine;
    var r = merge(docs);
    if (mine && !r.added && !r.changed) o.onChange(r);
    log('  [pulse] live window from ' + info.window_start + ': ' + docs.length.toLocaleString('en-IN') + ' posts in '
      + ((Date.now() - t0) / 1000).toFixed(1) + ' s' + (mine ? ' (replaced ' + mine.toLocaleString('en-IN') + ' of Nazar\'s own posts for those days)' : ''));
    return r;
  }

  /* after a Pulse push: fresh view/like counts for every post in the window (ids + numbers
     only, a few MB) and the full post for any id we have not seen */
  async function sweep() {
    var d = await conn(), coll = d.collection('tweets');
    var lite = await coll.find({ 'Tweet Date': { $gte: info.window_start } },
      { projection: { _id: 1, 'Total Views': 1, 'Total Likes': 1, 'Total Retweets': 1, 'Total Comments': 1 } }).toArray();
    var missing = [], changed = 0;
    lite.forEach(function (x) {
      var have = byId[String(x._id)];
      if (!have) { missing.push(x._id); return; }
      var diff = false;
      METRICS.forEach(function (f) { var v = o.num(x[f]); if (have[f] !== v) { have[f] = v; diff = true; } });
      if (diff) { changed++; dirty[have._id] = have; }
    });
    var added = 0;
    for (var i = 0; i < missing.length; i += 500) {
      var docs = await coll.find({ _id: { $in: missing.slice(i, i + 500) } }, { projection: PROJ }).toArray();
      added += merge(docs).added;
    }
    st.sweeps++; st.updated += changed;
    if (changed && !added) o.onChange({ added: 0, changed: changed });
    return { added: added, changed: changed };
  }

  async function poll() {
    if (busy) return;
    busy = true; st.polls++; st.lastPollAt = new Date().toISOString();
    try {
      var prevKey = pushKey(info);
      info = await readInfo();
      var r = { added: 0, changed: 0 };
      if (!ready) {
        r = await loadWindow(); ready = true;
      } else {
        var docs = await db.collection('tweets').find({ ts: { $gt: new Date(maxTs - OVERLAP_MS) }, 'Tweet Date': { $gte: info.window_start } },
          { projection: PROJ }).sort({ ts: 1 }).limit(5000).toArray();
        r = merge(docs);
      }
      if (pushKey(info) !== prevKey) {
        st.lastPushSeen = new Date().toISOString();
        if (prevKey !== null) {                    // the first push key is the load itself
          var s = await sweep();
          r.added += s.added; r.changed += s.changed;
        }
        summary().catch(function () {});          // warm the new summaries in the background
      }
      st.lastOkAt = new Date().toISOString();
    } catch (e) {
      fail('poll', e);
    } finally {
      busy = false;
    }
    saveDirty();                       // in the background: the screens never wait for it
  }
  /* new / changed posts -> o.persist; on failure they stay queued for the next poll */
  var saving = false;
  async function saveDirty() {
    var ids = Object.keys(dirty);
    if (!o.persist || !ids.length || saving) return;
    saving = true;
    var list = ids.map(function (k) { return dirty[k]; });
    dirty = {};
    try { await o.persist(list); st.saved += list.length; }
    catch (e) { list.forEach(function (r) { if (!dirty[r._id]) dirty[r._id] = r; }); fail('save', e); }
    finally { saving = false; }
  }

  /* ------------------------------------------------ nazar_daily summaries */
  /* {ws, firstDay, daily: {day: {state: posts}}, collected: [{p, h, s}], allTime: {state: posts}}
     cached until Pulse pushes; on failure the last good copy stays */
  async function fetchSummary(i) {
    var d = await conn(), coll = d.collection('nazar_daily'), ws = i.window_start;
    var from = addDays(ws, -SUMMARY_DAYS), cFrom = addDays(ws, -COLLECTED_DAYS);
    var res = await Promise.all([
      coll.aggregate([{ $match: { d: { $gte: from, $lt: ws } } },
        { $group: { _id: { d: '$d', s: '$st' }, n: { $sum: '$tw' } } }]).toArray(),
      coll.aggregate([{ $match: { d: { $gte: cFrom, $lt: ws }, cat: { $nin: MEDIA } } },
        { $group: { _id: { p: '$pt', h: { $toLower: '$h' }, s: '$st' } } }]).toArray(),
      coll.aggregate([{ $match: { d: { $lt: ws } } },
        { $group: { _id: '$st', n: { $sum: '$tw' } } }]).toArray()
    ]);
    var daily = {}, allTime = {};
    res[0].forEach(function (x) { var k = x._id.d; (daily[k] = daily[k] || {})[x._id.s || ''] = x.n; });
    res[2].forEach(function (x) { allTime[x._id || ''] = x.n; });
    return { ws: ws, from: from, firstDay: i.first_day || null, daily: daily, allTime: allTime,
             collected: res[1].map(function (x) { return { p: x._id.p, h: x._id.h, s: x._id.s }; }) };
  }
  function summary() {
    if (!info) return Promise.resolve(sum.v);
    var k = pushKey(info);
    if (sum.key === k && sum.v) return Promise.resolve(sum.v);
    if (sum.p && sum.pk === k) return sum.p;
    sum.pk = k;
    sum.p = fetchSummary(info).then(function (v) { sum.key = k; sum.v = v; sum.at = new Date().toISOString(); sum.p = null; return v; },
      function (e) { fail('summary', e); sum.p = null; return sum.v; });
    return sum.p;
  }

  return {
    start: async function () {
      st.startedAt = new Date().toISOString();
      await poll();
      timer = setInterval(poll, POLL_MS); timer.unref();
      if (ready) await summary();
      return ready;
    },
    ready: function () { return ready; },
    info: function () { return info; },
    summary: summary,
    /* Pulse's last push time, IST 'YYYY-MM-DD HH:MM:SS' (live_lib's status chip) */
    lastPushIst: function () {
      var t = info ? new Date(info.updated_at).getTime() : NaN;
      return isFinite(t) ? new Date(t + 19800000).toISOString().slice(0, 19).replace('T', ' ') : '';
    },
    /* for /health/pulse -- no secrets */
    health: function () {
      return {
        ready: ready, windowStart: info ? info.window_start : null, updatedAt: info ? info.updated_at : null,
        firstDay: info ? info.first_day : null, lastDay: info ? info.last_day : null,
        liveRows: Object.keys(byId).length,
        newestTs: maxTs ? new Date(maxTs + 19800000).toISOString().slice(0, 19).replace('T', ' ') + ' IST' : null,
        summaryAt: sum.at, summaryWindowStart: sum.v ? sum.v.ws : null,
        startedAt: st.startedAt, lastPollAt: st.lastPollAt, lastOkAt: st.lastOkAt, lastPushSeen: st.lastPushSeen,
        polls: st.polls, sweeps: st.sweeps, added: st.added, updated: st.updated, droppedOwn: st.droppedOwn,
        saved: st.saved, savePending: Object.keys(dirty).length,
        lastError: st.lastError, lastErrorAt: st.lastErrorAt
      };
    }
  };
}

module.exports = { createPulseFeed: createPulseFeed, MEDIA: MEDIA };
