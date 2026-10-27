/* ==================================================================
 *  attacks.js -- runs the "आज के सबसे बड़े हमले" section for server.js
 *  (the rules and the ranking are in app/attack_lib.js)
 *
 *   * every 10 minutes: the candidate posts of the current 24-hour window
 *     that have no label yet go to the READER model, 10 per request
 *   * the posts leading the board are re-read by the CHECKER model
 *   * labels are saved (MongoDB collection attack_labels when MONGODB_URI
 *     is set, otherwise data/attack_labels.json), so a post is sent to an
 *     AI only once -- also across restarts and between laptop and Render
 *   * stays inside Groq's free tier: one request at a time, a pause after
 *     each request sized to the tokens-per-minute limit, and a daily token
 *     budget per model; when the reader is out of budget or refuses, the
 *     next model in its list takes over (Groq GPT-OSS 20B, then the free
 *     Gemma on OpenRouter). Nothing is invented when all of them fail: the
 *     board just keeps what is already labelled.
 * ================================================================== */
'use strict';
var fs = require('fs');
var path = require('path');
var AT = require('./app/attack_lib.js');
var LIVE = require('./app/live_lib.js');
var HA = require('./app/ha_lib.js');

var GROQ = 'https://api.groq.com/openai/v1/chat/completions';
var OPENR = 'https://openrouter.ai/api/v1/chat/completions';
var READERS = [
  { name: 'Qwen 3.8 27B', url: GROQ, key: 'GROQ_API_KEY', model: 'qwen/qwen3.8-27b', extra: { reasoning_effort: 'none' }, dayTokens: 180000 },
  /* 120K, not 180K: the Media Room's AI step uses this model too (70K a day), and the free tier is 200K a day for both */
  { name: 'GPT-OSS 20B', url: GROQ, key: 'GROQ_API_KEY', model: 'openai/gpt-oss-20b', extra: { reasoning_effort: 'low' }, dayTokens: 120000 },
  { name: 'Gemma 4 31B', url: OPENR, key: 'OPENROUTER_API_KEY', model: 'google/gemma-4-31b-it:free', extra: {}, dayTokens: 400000 }
];
var CHECKERS = [
  { name: 'GPT-OSS 120B', url: GROQ, key: 'GROQ_API_KEY', model: 'openai/gpt-oss-120b', extra: { reasoning_effort: 'low' }, dayTokens: 150000 },
  { name: 'Gemma 4 31B', url: OPENR, key: 'OPENROUTER_API_KEY', model: 'google/gemma-4-31b-it:free', extra: {}, dayTokens: 400000 }
];
/* Groq free tier (checked 23 Oct 2026): 1,000 requests a day, 8,000 tokens a minute and,
   for Qwen, 1,000 OUTPUT tokens a minute. So: 5 posts per request, answers capped at
   900 tokens, one request a minute (~300 posts an hour). */
var MAX_OUT = 900;
var GAP_MS = 62000;
var ROUND_MS = 10 * 60000;        // how often new posts are looked at
var MAX_CALLS_ROUND = 40;         // reader requests in one round (a fresh start catches up over a few rounds)

function istDay(ms) { return new Date(ms + 19800000).toISOString().slice(0, 10); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* ------------------------------------------------------------- storage */
function makeStore(dataDir) {
  var uri = process.env.MONGODB_URI || '', coll = null, boards = null, file = path.join(dataDir, 'attack_labels.json');
  return {
    kind: uri ? 'mongo' : 'file',
    load: async function () {
      if (uri) {
        var MC = require('mongodb').MongoClient, cli = new MC(uri);
        await cli.connect();
        var db = cli.db(process.env.DB_NAME || 'nazar');
        coll = db.collection('attack_labels'); boards = db.collection('attack_boards');
        var since = new Date(Date.now() - 10 * 86400000);
        var docs = await coll.find({ at: { $gte: since } }).toArray(), out = { labels: {}, boards: {} };
        docs.forEach(function (d) { out.labels[d._id] = { r: d.r || null, c: d.c || null }; });
        (await boards.find({}).toArray()).forEach(function (b) { out.boards[b._id] = { top: b.top || [] }; });
        return out;
      }
      try { var j = JSON.parse(fs.readFileSync(file, 'utf8')); return { labels: j.labels || {}, boards: j.boards || {} }; }
      catch (e) { return { labels: {}, boards: {} }; }
    },
    save: async function (state, changedKeys, boardKeys) {
      if (coll) {
        var ops = changedKeys.map(function (k) { var L = state.labels[k]; return { updateOne: { filter: { _id: k }, update: { $set: { r: L.r, c: L.c, at: new Date() } }, upsert: true } }; });
        if (ops.length) await coll.bulkWrite(ops, { ordered: false });
        for (var i = 0; i < (boardKeys || []).length; i++) {
          var b = boardKeys[i]; await boards.updateOne({ _id: b }, { $set: { top: state.boards[b].top, at: new Date() } }, { upsert: true });
        }
        return;
      }
      var tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ labels: state.labels, boards: state.boards }));
      fs.renameSync(tmp, file);
    }
  };
}

/* ---------------------------------------------------------------- AI calls */
var usage = {};                   // model -> { day, tokens, off: day it refused for the rest of the day }
function budgetLeft(m) { var u = usage[m.model], d = istDay(Date.now()); if (!u || u.day !== d) return m.dayTokens; if (u.off === d) return 0; return m.dayTokens - u.tokens; }
function spend(m, n) { var d = istDay(Date.now()), u = usage[m.model]; if (!u || u.day !== d) u = usage[m.model] = { day: d, tokens: 0, off: null }; u.tokens += n; }
function switchOff(m) { spend(m, 0); usage[m.model].off = istDay(Date.now()); }

async function askOne(m, system, posts) {
  var body = Object.assign({ model: m.model, temperature: 0, max_tokens: MAX_OUT, response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: system }, { role: 'user', content: AT.userMessage(posts) }] }, m.extra);
  var res = await fetch(m.url, { method: 'POST', headers: { Authorization: 'Bearer ' + process.env[m.key], 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
  var j = await res.json().catch(function () { return {}; });
  if (!res.ok) {
    var msg = (j.error && (j.error.message || j.error.code)) || ('HTTP ' + res.status);
    var e = new Error(msg); e.status = res.status; e.daily = /per day|TPD|RPD|daily/i.test(msg); e.minute = /per minute|TPM|OTPM|RPM/i.test(msg); throw e;
  }
  spend(m, (j.usage && j.usage.total_tokens) || 3000);
  var labels = AT.parseLabels(j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content, posts.length);
  if (!labels) throw new Error('reply was not readable JSON');
  return labels;
}
/* first model of the list that has budget and answers */
async function ask(list, system, posts, log) {
  for (var i = 0; i < list.length; i++) {
    var m = list[i];
    if (!process.env[m.key] || budgetLeft(m) < 4000) continue;
    for (var tries = 0; tries < 2; tries++) {
      try { return { labels: await askOne(m, system, posts), model: m.name }; }
      catch (e) {
        log('  [attacks] ' + m.name + ': ' + String(e.message).slice(0, 160));
        if (e.daily) { switchOff(m); break; }
        if (e.minute || e.status === 429) { await sleep(65000); continue; }   // a per-minute limit: wait and try the same model once more
        break;
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------- the engine */
function createEngine(opts) {
  var rowsAll = opts.rows, svc = opts.svc, master = opts.master, log = opts.log || console.log;
  var store = makeStore(opts.dataDir);
  var st = { labels: {}, boards: {} }, ready = false, busy = false, lastRound = null, lastModel = { reader: null, checker: null };
  var on = !!(process.env.GROQ_API_KEY || process.env.OPENROUTER_API_KEY);
  var ruling = AT.rulingParties(master());

  /* rowsAll is sorted by 'Tweet Date': the window is a slice between two binary searches */
  function windowRows(win) {
    var from = win.from.slice(0, 19), to = win.to.slice(0, 19) + '~';
    function at(v) { var lo = 0, hi = rowsAll.length; while (lo < hi) { var m = (lo + hi) >> 1; if (String(rowsAll[m]['Tweet Date']) < v) lo = m + 1; else hi = m; } return lo; }
    return rowsAll.slice(at(from), at(to));
  }

  /* checker: the leading unchecked attacks of All India and of every state with a ruling party on record */
  async function checkLeaders(rows) {
    var need = {};
    [null].concat(Object.keys(ruling)).forEach(function (s) {
      var b = AT.board(rows, st.labels, { state: s, ruling: ruling });
      b.top.concat(b.rest).slice(0, s ? 3 : AT.C.CHECK_TOP).forEach(function (x) { if (!st.labels[x.key].c) need[x.key] = x.row; });
    });
    var chk = Object.keys(need).map(function (k) { return need[k]; }), n = 0;
    for (var c = 0; c < chk.length; c += AT.C.BATCH) {
      var cb = chk.slice(c, c + AT.C.BATCH), cg = await ask(CHECKERS, AT.CHECK_RULES, cb, log);
      if (!cg) break;
      lastModel.checker = cg.model;
      var ck = cb.map(function (r, j) { var k = AT.keyOf(r); st.labels[k].c = cg.labels[j + 1] || { attack: false }; return k; });
      await store.save(st, ck, []); n += ck.length;
      await sleep(GAP_MS);
    }
    return n;
  }

  async function round() {
    if (busy || !on) return; busy = true;
    try {
      /* the AI reads the longest window a viewer can choose (72 h), busiest posts first, so the
         24 / 48 / 72 h boards are all covered; media posts are never sent (AT.candidates) */
      var snap = await svc.get('all', { hours: Math.max.apply(null, LIVE.C.HOURS) });
      if (!snap.window) return;
      var rows = windowRows(snap.window), cand = AT.candidates(rows);
      /* busiest posts first, so the board fills with what matters most */
      cand.sort(function (a, b) { return HA.num(b['Total Views']) - HA.num(a['Total Views']); });
      var todo = cand.filter(function (r) { var L = st.labels[AT.keyOf(r)]; return !L || !L.r; });
      var calls = 0, checked = 0;
      for (var i = 0; i < todo.length && calls < MAX_CALLS_ROUND; i += AT.C.BATCH) {
        var batch = todo.slice(i, i + AT.C.BATCH), got = await ask(READERS, AT.RULES, batch, log); calls++;
        if (!got) break;
        lastModel.reader = got.model;
        var keys = batch.map(function (r, j) { var k = AT.keyOf(r); st.labels[k] = { r: got.labels[j + 1] || { attack: false }, c: null }; return k; });
        await store.save(st, keys, []);
        await sleep(GAP_MS);
        if (calls % 8 === 0) checked += await checkLeaders(rows);       // so the top two fill early on a fresh start
      }
      checked += await checkLeaders(rows);
      lastRound = new Date().toISOString();
      log('  [attacks] round done: ' + cand.length + ' candidates, ' + Math.min(todo.length, calls * AT.C.BATCH) + ' newly read, ' + checked + ' checked');
    } catch (e) { log('  [attacks] round failed: ' + (e && e.message || e)); }
    finally { busy = false; }
  }

  /* what the page shows for one scope (the sticky top two are remembered per scope) */
  /* key: where the sticky top two are kept (scope, plus the window length when not 24 h) */
  function forScope(scope, snap, avatarOf, key) {
    if (!snap || !snap.window) return null;
    var stName = LIVE.stateOfScope(scope), bs = key || scope;
    var rows = windowRows(snap.window), bk = bs + '|' + snap.window.to;
    var prevKey = Object.keys(st.boards).filter(function (k) { return k.indexOf(bs + '|') === 0; }).sort().pop();
    var b = AT.board(rows, st.labels, { state: stName, ruling: ruling, prev: prevKey ? st.boards[prevKey] : null });
    var oldTop = prevKey ? (st.boards[prevKey].top || []).join(',') : '';
    if (b.keys.join(',') !== oldTop || prevKey !== bk) {
      st.boards = Object.keys(st.boards).filter(function (k) { return k.indexOf(bs + '|') !== 0; }).reduce(function (o, k) { o[k] = st.boards[k]; return o; }, {});
      st.boards[bk] = { top: b.keys };
      store.save(st, [], [bk]).catch(function () {});
    }
    var cand = AT.candidates(rows), done = cand.filter(function (r) { var L = st.labels[AT.keyOf(r)]; return L && L.r; }).length;
    function item(x) {
      var r = x.row, p = LIVE.normParty(r.Party) || null;
      return { handle: r.Handle, name: String(r['Candidate Name'] || r.Handle), party: p, color: p ? LIVE.partyColor(p, 0) : '#546E7A',
        state: LIVE.stateOf(r.State), avatar: avatarOf(r.Handle), date: String(r['Tweet Date']).slice(0, 19), url: r['Tweet URL'] || null,
        text: String(r['Tweet Text'] || '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 320),
        views: HA.num(r['Total Views']), severity: x.sev, verified: x.verified,
        target: x.lab.target, targetState: x.lab.target_state, topic: x.lab.topic, summaryEn: x.lab.summary_en, summaryHi: x.lab.summary_hi };
    }
    return { on: on, top: b.top.map(item), list: b.rest.map(item), found: b.total,
      progress: { candidates: cand.length, read: done }, models: lastModel, updatedAt: lastRound };
  }

  return {
    start: async function () {
      try { st = await store.load(); } catch (e) { log('  [attacks] could not load saved labels: ' + e.message); }
      ready = true;
      /* ATTACKS_WORKER=off: this copy only shows what another copy (e.g. Render) has
         labelled -- it re-reads the shared store every 10 minutes and never calls an AI.
         Use it on the laptop when Render runs too, so the Groq quota is not spent twice. */
      var worker = on && String(process.env.ATTACKS_WORKER || 'on').toLowerCase() !== 'off';
      log('  [attacks] ' + (worker ? 'on' : on ? 'display only (ATTACKS_WORKER=off)' : 'off (no GROQ_API_KEY / OPENROUTER_API_KEY)') + ' -- ' + Object.keys(st.labels).length + ' saved labels, store: ' + store.kind);
      if (!worker) {
        if (store.kind === 'mongo') setInterval(function () { store.load().then(function (s) { st = s; }).catch(function () {}); }, ROUND_MS).unref();
        return;
      }
      setTimeout(round, 15000);
      setInterval(round, ROUND_MS).unref();
    },
    forScope: function (scope, snap, avatarOf, key) { return ready ? forScope(scope, snap, avatarOf, key) : null; }
  };
}

module.exports = { createEngine: createEngine };
