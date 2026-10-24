/* ==================================================================
 *  media_room.js -- collects the news for Nazar's Media Room
 *  (the rules -- parsing, topics, states, duplicates -- are in app/media_lib.js;
 *   the sources and narratives are in app/data/media_room_config.json)
 *
 *   * free sources only, no keys: website RSS feeds, YouTube channel feeds,
 *     Google News search feeds (student / youth organisations, and one pair
 *     per state: "<state> politics" in English and Hindi)
 *   * every 15 minutes, one request at a time with a pause between them
 *     (longer for Google News), so no source is hammered
 *   * state feeds only for states someone is watching (opened in the last
 *     24 hours) plus the ALWAYS list -- not all 36 states round the clock
 *   * headlines only (no article text), kept 72 hours in memory; stored in
 *     MongoDB (media_items, removed after 60 days) when MONGODB_URI is set,
 *     otherwise in data/media_room.json
 *   * MEDIA_WORKER=off: this copy collects nothing and re-reads what another
 *     copy (e.g. Render) stored -- so the sources are not asked twice
 * ================================================================== */
'use strict';
var fs = require('fs');
var path = require('path');
var ML = require('./app/media_lib.js');
var MAI = require('./media_ai.js');

var CFG_FILE = path.join(__dirname, 'app', 'data', 'media_room_config.json');
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
var EVERY = 15 * 60000;            // each feed at most this often
var TICK_MS = 60000;               // how often due feeds are looked for
var KEEP_MS = 72 * 3600000;        // in memory (screens use the last 24 h)
var WATCH_MS = 24 * 3600000;       // a state stays "watched" this long after it was opened
var GAP_MS = 1500, GAP_GN_MS = 4000;
var TTL_DAYS = 60;
var ALWAYS = ['Uttar Pradesh'];

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function gnUrl(q, lang) {
  return 'https://news.google.com/rss/search?q=' + encodeURIComponent(q + ' when:1d') + (lang === 'hi' ? '&hl=hi&gl=IN&ceid=IN:hi' : '&hl=en-IN&gl=IN&ceid=IN:en');
}

/* ------------------------------------------------------------- the feeds */
function nationalFeeds(cfg) {
  var out = [];
  cfg.sources.forEach(function (s) {
    (s.rss || []).forEach(function (u, i) { out.push({ key: s.id + ':rss:' + i, src: s.id, name: s.en, kind: s.type, via: 'rss', url: u }); });
    if (s.youtube) out.push({ key: s.id + ':yt', src: s.id, name: s.en, kind: s.type, via: 'youtube', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=' + s.youtube });
    /* a news search returns loose matches too: keep only headlines that name the organisation */
    if (s.coverage) ['en', 'hi'].forEach(function (l) {
      if (s.coverage[l]) out.push({ key: s.id + ':gn:' + l, src: s.id, name: s.en, kind: 'media', via: 'gnews', url: gnUrl(s.coverage[l], l), names: s.names ? ML.anyRe(s.names) : null });
    });
  });
  return out;
}
function stateFeeds(st) {
  var hi = ML.STATE_HI[st], f = [{ key: 'st:' + st + ':en', src: 'state', state: st, name: 'Google News', kind: 'media', via: 'gnews', url: gnUrl('"' + st + '" politics', 'en') }];
  if (hi) f.push({ key: 'st:' + st + ':hi', src: 'state', state: st, name: 'Google News', kind: 'media', via: 'gnews', url: gnUrl(hi + ' राजनीति', 'hi') });
  return f;
}
async function fetchFeed(f) {
  var r = await fetch(f.url, {
    headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5', 'Accept-Language': 'en-IN,en;q=0.9,hi;q=0.8' },
    redirect: 'follow', signal: AbortSignal.timeout(20000)
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  var x = await r.text();
  if (!/<(rss|feed|rdf)\b/i.test(x.slice(0, 3000))) throw new Error('not a feed');
  return ML.parseFeed(x);
}

/* ------------------------------------------------------------- storage */
function makeStore(dataDir, aiUsage) {
  var uri = process.env.MONGODB_URI || '', db = null, file = path.join(dataDir, 'media_room.json');
  async function conn() {
    if (db) return db;
    var MC = require('mongodb').MongoClient, cli = new MC(uri);
    await cli.connect();
    db = cli.db(process.env.DB_NAME || 'nazar');
    try {
      await db.collection('media_items').createIndex({ at: 1 }, { expireAfterSeconds: TTL_DAYS * 86400 });
      await db.collection('media_items').createIndex({ pub: -1 });
    } catch (e) {}
    return db;
  }
  return {
    kind: uri ? 'mongo' : 'file',
    load: async function () {
      var since = Date.now() - KEEP_MS;
      if (uri) {
        var d = await conn();
        var docs = await d.collection('media_items').find({ pub: { $gte: since } }, { projection: { at: 0 } }).toArray();
        var meta = await d.collection('media_meta').findOne({ _id: 'status' }), au = await d.collection('media_meta').findOne({ _id: 'ai_usage' });
        return { items: docs, status: (meta && meta.status) || {}, aiUsage: au && au.usage };
      }
      try { var j = JSON.parse(fs.readFileSync(file, 'utf8')); return { items: (j.items || []).filter(function (x) { return x.pub >= since; }), status: j.status || {}, aiUsage: j.aiUsage }; }
      catch (e) { return { items: [], status: {} }; }
    },
    /* AI labels go with their headlines; today's AI use is kept so a restart does not reset the cap */
    saveAi: async function (all, labelled, usage, status) {
      if (uri) {
        var d = await conn(), ops = labelled.map(function (x) { return { updateOne: { filter: { _id: x._id }, update: { $set: { ai: x.ai } } } }; });
        if (ops.length) await d.collection('media_items').bulkWrite(ops, { ordered: false });
        await d.collection('media_meta').updateOne({ _id: 'ai_usage' }, { $set: { usage: usage, at: new Date() } }, { upsert: true });
        return;
      }
      var tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ items: all, status: status, aiUsage: usage }));
      fs.renameSync(tmp, file);
    },
    save: async function (all, fresh, changed, status) {
      if (uri) {
        var d = await conn(), ops = fresh.map(function (x) { return { updateOne: { filter: { _id: x._id }, update: { $setOnInsert: Object.assign({}, x, { at: new Date(x.seen) }) }, upsert: true } }; })
          .concat(changed.map(function (x) { return { updateOne: { filter: { _id: x._id }, update: { $set: { states: x.states, nat: x.nat, dom: x.dom || null } } } }; }));
        if (ops.length) await d.collection('media_items').bulkWrite(ops, { ordered: false });
        await d.collection('media_meta').updateOne({ _id: 'status' }, { $set: { status: status, at: new Date() } }, { upsert: true });
        return;
      }
      var tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ items: all, status: status, aiUsage: aiUsage ? aiUsage() : undefined }));
      fs.renameSync(tmp, file);
    },
    /* which states display-only copies are showing, so the collecting copy fetches them */
    watched: async function () {
      if (!uri) return {};
      var d = await conn(), out = {};
      (await d.collection('media_watch').find({ at: { $gte: new Date(Date.now() - WATCH_MS) } }).toArray()).forEach(function (w) { out[w._id] = +w.at; });
      return out;
    },
    watch: async function (st) {
      if (!uri) return;
      var d = await conn(); await d.collection('media_watch').updateOne({ _id: st }, { $set: { at: new Date() } }, { upsert: true });
    }
  };
}

/* ------------------------------------------------------------- the engine */
function createMediaRoom(opts) {
  var log = opts.log || console.log, AI = MAI.createLabeller({ log: log }), store = makeStore(opts.dataDir, AI.usage);
  var cfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')), tagger = ML.makeTagger(cfg), NAT = nationalFeeds(cfg);
  var items = {}, status = {}, nextAt = {}, watch = {}, watchSaved = {}, cache = {}, busy = false, worker = false, firstPass = true, lastRun = 0;
  /* weight: how much longer a topic's screen stays up (important ones longer); from the
     config, otherwise by priority */
  var topics = cfg.narratives.slice().map(function (n, i) {
    var p = n.priority || 9;
    return { id: n.id, en: n.en, hi: n.hi, on: n.on !== false, priority: p, weight: n.weight || (p === 1 ? 1.25 : p === 2 ? 1.1 : 1), i: i };
  })
    .sort(function (a, b) { return a.priority - b.priority || a.i - b.i; });
  var BJPSIDE = ML.anyRe(cfg.bjp_side || []);
  var BLOCK = {}; (cfg.block_publishers || []).forEach(function (p) { BLOCK[String(p).toLowerCase()] = 1; });   // copy-paste sites
  var SRC = cfg.sources.map(function (s) { return { id: s.id, name: s.en, nameHi: s.hi, kind: s.type, group: s.group, direct: !!((s.rss && s.rss.length) || s.youtube) }; });

  function toItem(f, e, now) {
    var title = e.title, srcName = f.name;
    if (f.via === 'gnews') {                    // "Headline - Publisher": the publisher is the real source
      if (e.publisher) { srcName = e.publisher; title = title.replace(new RegExp('\\s+[-–—|]\\s+' + escRe(e.publisher) + '\\s*$'), ''); }
      else title = title.replace(/\s+-\s+[^-]{2,40}$/, '');
      srcName = srcName.replace(/^www\./i, '');
      if (srcName.length > 26) srcName = srcName.split(/\s*[,|]\s*/)[0];      // "Deshbandhu MP, Deshbandhu, Madhya Pradesh, ..." -> "Deshbandhu MP"
    }
    /* some results carry the page's address slug as the headline ("jamia-hunger-strike-day-13"):
       turn it back into words */
    if (!/\s/.test(title) && /-/.test(title)) title = title.replace(/-+/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); });
    var pub = isFinite(e.date) ? Math.min(e.date, now) : now, states = ML.statesIn(title);
    if (f.state && states.indexOf(f.state) < 0) states.push(f.state);
    return { _id: ML.idOf(e.link), url: e.link, title: title, src: f.src, srcName: srcName, kind: f.kind, via: f.via, pub: pub, seen: now,
             noDate: !isFinite(e.date), video: !!e.video, hi: ML.isHindi(title), states: states, nat: !f.state, tags: tagger(title, f.src),
             dom: f.via === 'gnews' ? e.domain || null : null };
  }
  /* a source's logo: our own sources (and a news search result from one of them) use the
     source's X profile photo; any other publisher its website icon, fetched once and kept */
  var XOF = {}, XBYNAME = {}, NAMEOF = {};
  cfg.sources.forEach(function (s) { NAMEOF[s.id] = s.en; });
  cfg.sources.forEach(function (s) { if (s.x) { XOF[s.id] = s.x.toLowerCase(); XBYNAME[s.en.toLowerCase()] = s.x.toLowerCase(); } });
  /* other publishers: the config's publisher_x list (by website, sub-domains included, or by
     name) gives an X handle -- sharper than a website icon; the icon is the last resort */
  var PUBX = {}; Object.keys(cfg.publisher_x || {}).forEach(function (k) { PUBX[k.toLowerCase()] = String(cfg.publisher_x[k]).toLowerCase(); });
  function pubHandle(it) {
    var d = String(it.dom || '');
    while (d && d.indexOf('.') > 0) { if (PUBX[d]) return PUBX[d]; d = d.slice(d.indexOf('.') + 1); }   // up.punjabkesari.in -> punjabkesari.in
    return PUBX[String(it.srcName || '').toLowerCase()] || null;
  }
  function logoOf(it) {
    var x = it.via !== 'gnews' ? XOF[it.src] : (XBYNAME[String(it.srcName || '').toLowerCase()] || pubHandle(it));
    if (x) return '/live/img/a/' + encodeURIComponent(x);
    return it.dom ? '/live/img/src/' + encodeURIComponent(it.dom) : null;
  }
  function dueFeeds(now) {
    var list = NAT.slice();
    Object.keys(watch).concat(ALWAYS).forEach(function (st, i, a) {
      if (a.indexOf(st) !== i) return;
      if (ALWAYS.indexOf(st) < 0 && now - watch[st] > WATCH_MS) return;
      list = list.concat(stateFeeds(st));
    });
    return list.filter(function (f) { return (nextAt[f.key] || 0) <= now; });
  }
  async function run() {
    if (busy) return; busy = true;
    try {
      try { var w = await store.watched(); Object.keys(w).forEach(function (s) { if (!watch[s] || w[s] > watch[s]) watch[s] = w[s]; }); } catch (e) {}
      var feeds = dueFeeds(Date.now()), fresh = [], changed = [];
      for (var i = 0; i < feeds.length; i++) {
        var f = feeds[i], now = Date.now(), s = status[f.key] || (status[f.key] = {});
        nextAt[f.key] = now + EVERY; s.lastTry = now;
        try {
          var got = await fetchFeed(f), n = 0, newest = 0;
          got.forEach(function (e) {
            var it = toItem(f, e, now);
            if (it.pub < now - KEEP_MS || BLOCK[it.srcName.toLowerCase()]) return;
            if (f.names && !f.names(it.title)) return;
            if (it.pub > newest) newest = it.pub;
            var old = items[it._id];
            if (!old) { items[it._id] = it; fresh.push(it); n++; return; }
            var more = it.states.filter(function (x) { return old.states.indexOf(x) < 0; });   // the same article found again through a state feed
            if (more.length || (it.nat && !old.nat) || (it.dom && !old.dom)) {
              old.states = old.states.concat(more); old.nat = old.nat || it.nat; old.dom = old.dom || it.dom; changed.push(old);
            }
          });
          s.lastOk = now; s.items = got.length; s.error = null; s.fails = 0; if (newest) s.newest = Math.max(s.newest || 0, newest); if (n) s.lastNew = now;
        } catch (e) {
          /* a failing feed is asked less and less often (15, 30, 60 min ... at most every 4 h) */
          s.error = String(e && e.message || e).slice(0, 80); s.fails = (s.fails || 0) + 1;
          nextAt[f.key] = now + Math.min(EVERY * Math.pow(2, s.fails - 1), 4 * 3600000);
        }
        await sleep(f.via === 'gnews' ? GAP_GN_MS : GAP_MS);
      }
      var cut = Date.now() - KEEP_MS;
      Object.keys(items).forEach(function (k) { if (items[k].pub < cut) delete items[k]; });
      if (feeds.length) { lastRun = Date.now(); firstPass = false; }
      if (fresh.length || changed.length) cache = {};
      if (feeds.length) {
        log('  [media] ' + feeds.length + ' feeds read, ' + fresh.length + ' new headlines, ' + Object.keys(items).length + ' in the last 72 h'
          + (feeds.filter(function (f) { return status[f.key].error; }).length ? ' (' + feeds.filter(function (f) { return status[f.key].error; }).length + ' failed)' : ''));
        try { await store.save(Object.keys(items).map(function (k) { return items[k]; }), fresh, changed, status); } catch (e) { log('  [media] could not save: ' + e.message); }
      }
    } finally { busy = false; }
  }
  async function reload() {
    var s = await store.load(); items = {}; s.items.forEach(function (x) { items[x._id] = x; }); status = s.status || {};
    var newest = 0; Object.keys(status).forEach(function (k) { if ((status[k].lastTry || 0) > newest) newest = status[k].lastTry; });
    if (newest) { lastRun = newest; firstPass = false; }
    AI.restore(s.aiUsage);
    cache = {};
  }

  /* the AI step, once a minute: the newest political headlines without a label, one per
     story (the newest headline of a story speaks for all its copies), 20 per request */
  var aiBusy = false;
  async function aiStep() {
    if (aiBusy || !AI.on) return; aiBusy = true;
    try {
      var since = Date.now() - 24 * 3600000, all = Object.keys(items).map(function (k) { return items[k]; });
      var cands = all.filter(function (x) { return x.pub >= since && (!x.ai || x.ai.ver !== MAI.VER); });   // unread, or read before the AI chose topics
      cands.forEach(function (x) { x.tags = tagger(x.title, x.src); });
      /* not worth a token: news bulletins ("Top Headlines | BJP | Rahul | ...") and #shorts clips */
      cands = cands.filter(function (x) { return x.tags.length && !/#shorts|top headlines|morning brief|evening brief|news bulletin/i.test(x.title) && (x.title.split('|').length < 4); });
      if (!cands.length) return;
      var groups = ML.cluster(cands).map(function (g) { return g.items.slice().sort(function (a, b) { return b.pub - a.pub; }); })
        .sort(function (a, b) { return b[0].pub - a[0].pub; });
      var callsBefore = AI.usage().calls;
      var labels = await AI.step(groups.map(function (g) { return g[0]; })), done = [];
      groups.forEach(function (g) { var L = labels[g[0]._id]; if (L) g.forEach(function (x) { x.ai = L; done.push(x); }); });
      if (done.length) cache = {};
      if (AI.usage().calls !== callsBefore) {
        try { await store.saveAi(all, done, AI.usage(), status); } catch (e) { log('  [media-ai] could not save: ' + e.message); }
      }
    } finally { aiBusy = false; }
  }

  /* per source: is it answering, and when was its newest headline (for the honest footer) */
  function sourceStatus() {
    return SRC.map(function (s) {
      var keys = Object.keys(status).filter(function (k) { return k.indexOf(s.id + ':') === 0 && k.indexOf(':gn:') < 0; });
      if (!keys.length) return null;
      var ok = keys.some(function (k) { return !status[k].error && status[k].lastOk; }), newest = 0;
      keys.forEach(function (k) { if ((status[k].newest || 0) > newest) newest = status[k].newest; });
      return { id: s.id, name: s.name, nameHi: s.nameHi, kind: s.kind, ok: ok, newest: newest || null };
    }).filter(Boolean);
  }
  function view(key) {
    /* rebuilt when new headlines arrive, and every 10 minutes (the 24-hour and "hot" windows move on) */
    if (cache[key] && Date.now() - cache[key].at < 10 * 60000) return cache[key].v;
    var all = Object.keys(items).map(function (k) { return items[k]; }), st = key === 'all' ? null : key.slice(3);
    all.forEach(function (x) {
      x.tags = tagger(x.title, x.src);                                        // today's rules, also for headlines saved before a rule changed
      /* the AI picks the topics once it has read a headline (keywords alone put a Jio deal under
         "party announcements" for the word "joins"); keywords only until then */
      if (x.ai && x.ai.c) x.tags = x.ai.c.slice();
      if (x.ai) {                                                             // the AI's reading, where there is one
        /* the AI's "against / for BJP" counts only when the headline names BJP's side (a small
           model sometimes reads any scandal or success as BJP's); "good news" is others reporting
           it -- a government's own release is already on "official statements" */
        var side = BJPSIDE(x.title);
        if (x.ai.s === 'a' && side) x.tags.push('atk'); else if (x.ai.s === 'f' && side && x.kind !== 'official') x.tags.push('pro');
        var r = x.tags.indexOf('opprift');                                    // and it has the last word on "opposition"
        if (x.ai.o && r < 0) x.tags.push('opprift'); else if (!x.ai.o && r >= 0) x.tags.splice(r, 1);
        var pol = x.ai.s !== 'n' || x.ai.o || (x.ai.c || []).some(function (c) { return /^(elections|party|students|legislature|controversy|protests)$/.test(c); });
        if (pol && x.tags.indexOf('politics') < 0) x.tags.push('politics');
      }
      if (x.via !== 'gnews' && NAMEOF[x.src]) x.srcName = NAMEOF[x.src];     // a source renamed in the config
      if (!/\s/.test(x.title) && /-/.test(x.title)) x.title = x.title.replace(/-+/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); });   // saved before the slug fix
    });
    /* social-media clips ("... #shorts #viralvideo") are not news for this room */
    var mine = all.filter(function (x) { return (st ? x.states.indexOf(st) >= 0 : x.nat) && !/#shorts|#viral/i.test(x.title); });
    cache[key] = { at: Date.now(), v: ML.buildView({ items: mine, topics: topics.map(function (t) { return t.id; }), sources: SRC, bySource: !st, logoOf: logoOf, now: Date.now() }) };
    return cache[key].v;
  }
  /* for the page: is the AI working, and how much of the last 24 hours it has read. A
     display-only copy has no labeller of its own: it reports what the stored labels show. */
  function aiInfo() {
    var since = Date.now() - 24 * 3600000, n = 0, last = 0;
    Object.keys(items).forEach(function (k) { var x = items[k]; if (x.ai && x.pub >= since) { n++; if (x.ai.at > last) last = x.ai.at; } });
    var s = AI.status();
    return { state: worker ? s.state : (n ? 'ok' : 'off'), labelled: n, last: last || null, until: s.until, used: worker ? Math.round(100 * s.tokens / s.cap) : null };
  }
  function touch(st) {
    var now = Date.now(), isNew = !watch[st] || now - watch[st] > WATCH_MS;
    watch[st] = now;
    if (!watchSaved[st] || now - watchSaved[st] > 10 * 60000) { watchSaved[st] = now; store.watch(st).catch(function () {}); }
    if (isNew && worker) setTimeout(function () { run().catch(function () {}); }, 500);      // a newly opened state: fetch it now
  }

  return {
    start: async function () {
      try { await reload(); } catch (e) { log('  [media] could not load saved headlines: ' + e.message); }
      worker = String(process.env.MEDIA_WORKER || 'on').toLowerCase() !== 'off';
      log('  [media] ' + (worker ? 'collecting' : 'display only (MEDIA_WORKER=off)') + ' -- ' + Object.keys(items).length + ' saved headlines, ' + NAT.length + ' feeds, store: ' + store.kind);
      if (!worker) {
        if (store.kind === 'mongo') setInterval(function () { reload().catch(function () {}); }, 3 * 60000).unref();
        return;
      }
      setTimeout(function () { run().catch(function (e) { log('  [media] ' + e.message); }); }, 3000);
      setInterval(function () { run().catch(function (e) { log('  [media] ' + e.message); }); }, TICK_MS).unref();
      log('  [media-ai] ' + (AI.on ? 'on -- ' + AI.status().model + ', at most ' + AI.status().cap + ' tokens a day' : 'off (no GROQ_API_KEY)'));
      if (AI.on) setInterval(function () { aiStep().catch(function (e) { log('  [media-ai] ' + e.message); }); }, 60000).unref();
    },
    /* everything the page needs: All India, plus one state (the page's scope, or the
       state picked in the Media Room's own bar) when st is given */
    get: function (st) {
      if (st && !ML.STATE_HI[st]) st = null;
      if (st) touch(st);
      return {
        generatedAt: new Date().toISOString(), lastRun: lastRun || null, collecting: firstPass, worker: worker,
        everyMin: EVERY / 60000, topics: topics, state: st || null,
        all: view('all'), local: st ? view('st:' + st) : null, sources: sourceStatus(), ai: aiInfo()
      };
    },
    states: Object.keys(ML.STATE_HI)
  };
}

module.exports = { createMediaRoom: createMediaRoom };
