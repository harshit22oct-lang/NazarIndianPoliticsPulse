/* ==================================================================
 *  NAZAR (नज़र) -- standalone prototype
 *  ------------------------------------------------------------------
 *  The Nazar TV page from India Political Pulse, running on its own:
 *    * no MongoDB, no login, no npm install -- only Node.js (v16+)
 *    * data = every .csv file in ./data (PulseData export format,
 *      same columns as pulse_master.master_tweets), loaded into memory
 *    * the maths is the same live_lib.js as in Pulse (copied into ./app)
 *
 *      node server.js                 -> http://localhost:3300/live
 *      set PORT=4000 / set HOST=0.0.0.0 (to open it from a TV on the same Wi-Fi)
 *
 *  Pulse itself is not touched by this folder.
 * ================================================================== */
'use strict';
var http = require('http');
var fs = require('fs');
var path = require('path');
var urlm = require('url');
var zlib = require('zlib');

var APP = path.join(__dirname, 'app');
var DATA = path.join(__dirname, 'data');
var ASSETS = path.join(APP, 'live_assets');

/* Load .env file if present */
try {
  var envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(function (line) {
      var m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (m && process.env[m[1]] === undefined) {
        var val = (m[2] || '').trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        process.env[m[1]] = val;
      }
    });
  }
} catch (e) {}

var PORT = Number(process.env.PORT) || 3300;
var HOST = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');

var LIVE = require(path.join(APP, 'live_lib.js'));
var NEWS = require(path.join(APP, 'news_lib.js'));
var MAPL = require(path.join(APP, 'mapping_lib.js'));

var HA = require(path.join(APP, 'ha_lib.js'));

/* The connection strings (with their passwords) come ONLY from .env or the host's
   environment variables -- never from this file, which goes to GitHub. */
var MONGO_URI = process.env.MONGODB_URI || '';
var DB_NAME = process.env.DB_NAME || 'nazar';
var COLL_NAME = process.env.COLL_NAME || 'tweets';
/* Political Pulse's own data (pulse_feed.js): PULSE_MONGO_URL + USE_PULSE_DATA=1 */
var PULSE_URL = process.env.PULSE_MONGO_URL || '';
var USE_PULSE = !!PULSE_URL && /^(1|true|yes|on)$/i.test(String(process.env.USE_PULSE_DATA || '').trim());

/* An export covers a few days, not months. live_lib wants 14 days of history
   before it trusts its "usual volume" baseline; with a one-week file that would
   leave every screen empty. Use what the file has (at least 3 full days).
   With Pulse's data the daily totals go back months (nazar_daily), so the
   baseline is Pulse's own: 28 days, at least 14. */
if (!USE_PULSE) {
  LIVE.C.BASE_DAYS = 7;
  LIVE.C.BASE_MIN_DAYS = 3;
}
/* always the latest 24 / 48 / 72 h, ending at the newest post we have (so a pause in the
   source shows the last hours that do have data); a thin period is marked on screen */
LIVE.C.LATEST_MIN = 0;
LIVE.C.BREAK_BASE_DAYS = 6;        // raw posts in memory: Nazar's own history + Pulse's window
/* raw posts kept: a 72 h window + its previous 72 h + 6 days of "usual" before it fit in
   10 days; every count beyond that comes from Pulse's nazar_daily */
var KEEP_RAW_DAYS = 10;

/* ------------------------------------------------------------ Data loading (Mongo / CSV) */
var KEEP = ['Handle', 'Tweet URL', 'Tweet ID', 'Tweet Date', 'Tweet Text', 'Total Comments', 'Total Likes',
            'Total Retweets', 'Total Views', 'Sentiment', 'State', 'Candidate Name', 'Category', 'Party'];

/* RFC-4180 reader: quoted fields, "" escapes, line breaks inside quotes */
function readCsv(file, onRow) {
  return new Promise(function (resolve, reject) {
    var field = '', row = [], inQ = false, quoteSeen = false, first = true;
    var st = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 });
    st.on('data', function (chunk) {
      var i = 0, n = chunk.length;
      if (first) { first = false; if (chunk.charCodeAt(0) === 0xFEFF) i = 1; }
      for (; i < n; i++) {
        var c = chunk[i];
        if (inQ) {
          if (c === '"') { inQ = false; quoteSeen = true; }
          else field += c;
        } else if (c === '"') {
          if (quoteSeen) field += '"';              // "" inside a quoted field
          inQ = true; quoteSeen = false;
        } else if (c === ',') { row.push(field); field = ''; quoteSeen = false; }
        else if (c === '\n') { row.push(field); field = ''; quoteSeen = false; onRow(row); row = []; }
        else if (c !== '\r') { field += c; quoteSeen = false; }
      }
    });
    st.on('end', function () { if (field !== '' || row.length) { row.push(field); onRow(row); } resolve(); });
    st.on('error', reject);
  });
}

async function loadFromMongo() {
  if (!MONGO_URI) throw new Error('MONGODB_URI is not set -- put it in .env (see .env.example) or in the host\'s environment variables');
  var { MongoClient } = require('mongodb');
  console.log('  Connecting to MongoDB Atlas (' + DB_NAME + '.' + COLL_NAME + ')...');
  var client = new MongoClient(MONGO_URI);
  await client.connect();
  var coll = client.db(DB_NAME).collection(COLL_NAME);
  var t0 = Date.now();
  console.log('  Loading tweets from MongoDB Atlas (streaming)...');
  /* with Pulse's data only the last KEEP_RAW_DAYS are needed as raw posts */
  var since = USE_PULSE ? LIVE.addDays(LIVE.istDay(Date.now()), -KEEP_RAW_DAYS) : null;
  var cursor = coll.find(since ? { 'Tweet Date': { $gte: since } } : {}, {
    projection: {
      _id: 0, Handle: 1, 'Tweet Date': 1, 'Tweet Text': 1, 'Tweet URL': 1,
      'Total Views': 1, 'Total Likes': 1, 'Total Retweets': 1, 'Total Comments': 1,
      Sentiment: 1, State: 1, 'Candidate Name': 1, Category: 1, Party: 1
    }
  }).sort({ 'Tweet Date': 1 });

  var rows = [];
  while (await cursor.hasNext()) {
    var doc = await cursor.next();
    // Memory optimization: retweets only need 'RT' marker as their text is never displayed
    if (doc['Tweet Text'] && doc['Tweet Text'].startsWith('RT @')) {
      doc['Tweet Text'] = 'RT @';      // must still start with "RT @": that is how live_lib (HA.isRetweet) tells a re-post from an original
    }
    var cs = LIVE.stateOf(doc.State);
    if (cs) doc.State = cs;
    rows.push(doc);
  }
  console.log('  Loaded ' + rows.length.toLocaleString('en-IN') + ' posts from MongoDB in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
  await client.close();
  return rows;
}

async function loadFromCsv(files) {
  var byId = {}, rows = [], skipped = 0;
  for (var k = 0; k < files.length; k++) {
    var head = null, ix = null, t0 = Date.now(), n = 0;
    await readCsv(path.join(DATA, files[k]), function (r) {
      if (!head) { head = r.map(function (h) { return h.trim(); }); ix = KEEP.map(function (h) { return head.indexOf(h); }); return; }
      if (r.length < 4) return;
      var d = {};
      for (var j = 0; j < KEEP.length; j++) d[KEEP[j]] = ix[j] >= 0 && r[ix[j]] !== undefined ? r[ix[j]] : '';
      if (!/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/.test(d['Tweet Date']) || !d.Handle) { skipped++; return; }
      var cs = LIVE.stateOf(d.State); if (cs) d.State = cs;
      ['Total Views', 'Total Likes', 'Total Retweets', 'Total Comments'].forEach(function (f) { var v = Number(d[f]); d[f] = isFinite(v) ? v : 0; });
      var id = d['Tweet ID'] || d['Tweet URL'] || (d.Handle + '|' + d['Tweet Date']);
      d._id = id;
      if (byId[id]) { Object.assign(byId[id], d); return; }
      byId[id] = d; rows.push(d); n++;
    });
    console.log('  loaded ' + files[k] + ' -- ' + n.toLocaleString('en-IN') + ' posts in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
  }
  rows.sort(function (a, b) { return a['Tweet Date'] < b['Tweet Date'] ? -1 : a['Tweet Date'] > b['Tweet Date'] ? 1 : 0; });
  if (skipped) console.log('  skipped ' + skipped + ' rows without a valid date / handle');
  return rows;
}

async function loadData() {
  var files = [];
  try { files = fs.readdirSync(DATA).filter(function (f) { return /\.csv$/i.test(f); }); } catch (e) {}

  if (process.env.USE_MONGO === 'true' || !files.length) {
    if (files.length) console.log('  [Data Source] USE_MONGO set -> loading from MongoDB Atlas');
    else console.log('  [Data Source] No local CSV found -> loading from MongoDB Atlas');
    try {
      return await loadFromMongo();
    } catch (err) {
      if (files.length) {
        console.warn('  ⚠️ MongoDB connection failed (' + err.message + '). Falling back to local CSV...');
        return await loadFromCsv(files);
      }
      throw err;
    }
  }

  console.log('  [Data Source] Local CSV found -> loading from ' + DATA + ' (set USE_MONGO=true to use MongoDB Atlas)');
  return await loadFromCsv(files);
}

/* ------------------------------------------- an in-memory "collection" --
   Implements exactly the Mongo calls live_lib.js makes: find (+sort/limit),
   countDocuments, estimatedDocumentCount and the one distinct-handle aggregate. */
function Collection(rows) {
  var dates;
  /* rows is shared and grows while running (pulse_feed.js): index again after each change */
  this.reindex = function () { dates = rows.map(function (r) { return r['Tweet Date']; }); };
  this.reindex();
  function lower(v) { var lo = 0, hi = dates.length; while (lo < hi) { var m = (lo + hi) >> 1; if (dates[m] < v) lo = m + 1; else hi = m; } return lo; }
  function upper(v) { var lo = 0, hi = dates.length; while (lo < hi) { var m = (lo + hi) >> 1; if (dates[m] <= v) lo = m + 1; else hi = m; } return lo; }
  /* one test per field, built once per query ($in / $nin lists become Sets) */
  function pred(cond) {
    if (cond instanceof RegExp) return function (v) { return cond.test(String(v)); };
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      var t = [];
      Object.keys(cond).forEach(function (op) {
        var c = cond[op];
        if (op === '$gte') t.push(function (v) { return v >= c; });
        else if (op === '$gt') t.push(function (v) { return v > c; });
        else if (op === '$lte') t.push(function (v) { return v <= c; });
        else if (op === '$lt') t.push(function (v) { return v < c; });
        else if (op === '$in') { var si = new Set(c); t.push(function (v) { return si.has(v); }); }
        else if (op === '$nin') { var sn = new Set(c); t.push(function (v) { return !sn.has(v); }); }
      });
      return function (v) { for (var i = 0; i < t.length; i++) if (!t[i](v)) return false; return true; };
    }
    return function (v) { return v === cond; };
  }
  /* the rows matching q, walked in date order (dir 1) or newest first (dir -1); stops at
     limit. Rows are kept sorted by 'Tweet Date', so a date range is two binary searches. */
  function scan(q, dir, limit, countOnly) {
    q = q || {};
    var lo = 0, hi = rows.length, dq = q['Tweet Date'];
    if (dq && typeof dq === 'object' && !(dq instanceof RegExp)) {
      if (dq.$gte !== undefined) lo = lower(dq.$gte);
      if (dq.$gt !== undefined) lo = upper(dq.$gt);
      if (dq.$lte !== undefined) hi = upper(dq.$lte);
      if (dq.$lt !== undefined) hi = lower(dq.$lt);
    }
    var keys = Object.keys(q).filter(function (k) { return k !== 'Tweet Date' || typeof dq !== 'object' || dq instanceof RegExp; });
    var tests = keys.map(function (k) { return pred(q[k]); }), nk = keys.length;
    var out = countOnly ? 0 : [], n = 0, max = limit || Infinity;
    for (var s = 0, len = hi - lo; s < len && n < max; s++) {
      var r = rows[dir < 0 ? hi - 1 - s : lo + s], ok = true;
      for (var j = 0; j < nk && ok; j++) ok = tests[j](r[keys[j]]);
      if (!ok) continue;
      n++; if (countOnly) out++; else out.push(r);
    }
    return out;
  }
  /* lazy: nothing is read until toArray, so sort({'Tweet Date': -1}).limit(1) reads one row */
  function cursor(q) {
    var sortK = null, dir = 1, lim = 0;
    var c = {
      sort: function (spec) { sortK = Object.keys(spec)[0]; dir = spec[sortK]; return c; },
      limit: function (n) { lim = n; return c; },
      maxTimeMS: function () { return c; },
      toArray: function () {
        if (!sortK || sortK === 'Tweet Date') return Promise.resolve(scan(q, sortK ? dir : 1, lim));
        var list = scan(q, 1, 0).sort(function (a, b) { return (a[sortK] < b[sortK] ? -1 : a[sortK] > b[sortK] ? 1 : 0) * dir; });
        return Promise.resolve(lim ? list.slice(0, lim) : list);
      }
    };
    return c;
  }
  function select(q) { return scan(q, 1, 0); }
  function listCursor(list) {
    return { sort: function () { return this; }, limit: function () { return this; }, maxTimeMS: function () { return this; },
             toArray: function () { return Promise.resolve(list); } };
  }
  this.find = function (q) { return cursor(q); };
  this.countDocuments = function (q) { return Promise.resolve(scan(q, 1, 0, true)); };
  this.estimatedDocumentCount = function () { return Promise.resolve(rows.length); };
  /* only shape used: $match -> group by (Party, lower(Handle)) -> count per Party */
  this.aggregate = function (pipe) {
    var m = select(pipe[0] && pipe[0].$match), seen = {}, by = {};
    m.forEach(function (r) {
      var k = r.Party + '\u0001' + String(r.Handle).toLowerCase();
      if (seen[k]) return; seen[k] = 1; by[r.Party] = (by[r.Party] || 0) + 1;
    });
    return listCursor(Object.keys(by).map(function (p) { return { _id: p, n: by[p] }; }));
  };
}

/* ---------------------------------------------------------------- images */
var imgIx = { avatars: {}, parties: {} };
try { imgIx = JSON.parse(fs.readFileSync(path.join(ASSETS, 'avatars_index.json'), 'utf8')); } catch (e) {}
function partySlug(p) { return String(p).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, ''); }

/* Live on-demand avatar scraper using x_config.json cookies */
var inFlightScrapes = {};
var GQL_URL = 'https://x.com/i/api/graphql/Yka-W8dz7RaEuQNkroPkYw/UserByScreenName';
var BEARER = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

function getXCookies() {
  var paths = [
    path.join(__dirname, 'x_config.json'),
    path.join(__dirname, '..', 'Political Pulse', 'DASHBOARD', 'x_config.json'),
    'C:\\Users\\dell\\Desktop\\Political Pulse\\DASHBOARD\\x_config.json'
  ];
  for (var i = 0; i < paths.length; i++) {
    try {
      if (fs.existsSync(paths[i])) {
        var j = JSON.parse(fs.readFileSync(paths[i], 'utf8'));
        var a = String(j.auth_token || '').trim(), c = String(j.ct0 || '').trim(), t = String(j.twid || '').trim();
        if (a && c && !/^PASTE/i.test(a)) {
          return { cookie: 'auth_token=' + a + '; ct0=' + c + (t && !/^PASTE/i.test(t) ? '; twid=' + t : '') + '; lang=en', ct0: c };
        }
      }
    } catch (e) {}
  }
  return null;
}

function fetchOnDemand(handle, cb) {
  var k = String(handle || '').toLowerCase().trim();
  if (!k) return cb(false);
  var filePath = path.join(ASSETS, 'avatars', k + '.jpg');
  if (fs.existsSync(filePath)) {
    imgIx.avatars[k] = { file: 'avatars/' + k + '.jpg', handle: handle, at: Date.now() };
    return cb(true, filePath);
  }
  if (inFlightScrapes[k]) {
    inFlightScrapes[k].push(cb);
    return;
  }
  inFlightScrapes[k] = [cb];

  function done(ok, p) {
    var cbs = inFlightScrapes[k] || [];
    delete inFlightScrapes[k];
    cbs.forEach(function (f) { try { f(ok, p); } catch (e) {} });
  }

  (async function () {
    var ck = getXCookies();
    var imgUrl = null, name = '';
    if (ck) {
      try {
        var body = {
          variables: { screen_name: handle, withSafetyModeUserFields: true },
          features: { hidden_profile_likes_enabled: true, hidden_profile_subscriptions_enabled: true, rweb_tipjar_consumption_enabled: false,
            responsive_web_graphql_exclude_directive_enabled: true, verified_phone_label_enabled: true,
            subscriptions_verification_info_is_identity_verified_enabled: true, subscriptions_verification_info_verified_since_enabled: true,
            highlights_tweets_tab_ui_enabled: true, responsive_web_twitter_article_notes_tab_enabled: true,
            creator_subscriptions_tweet_preview_api_enabled: true, responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
            responsive_web_graphql_timeline_navigation_enabled: true },
          fieldToggles: { withAuxiliaryUserLabels: false }
        };
        var r = await fetch(GQL_URL, {
          method: 'POST', body: JSON.stringify(body),
          headers: {
            authorization: BEARER, cookie: ck.cookie, 'content-type': 'application/json', 'x-csrf-token': ck.ct0,
            'x-twitter-active-user': 'yes', 'x-twitter-auth-type': 'OAuth2Session', 'x-twitter-client-language': 'en',
            referer: 'https://x.com/' + handle,
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          signal: AbortSignal.timeout(10000)
        });
        if (r.ok) {
          var j = await r.json();
          var leg = j && j.data && j.data.user && j.data.user.result && j.data.user.result.legacy;
          if (leg && leg.profile_image_url_https && !/default_profile/.test(leg.profile_image_url_https)) {
            imgUrl = leg.profile_image_url_https.replace(/_(normal|bigger|400x400)\./, '_200x200.');
            name = leg.name || '';
          }
        }
      } catch (e) {}
    }
    if (!imgUrl) {
      try {
        var fb = await fetch('https://api.fxtwitter.com/' + encodeURIComponent(handle), {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(10000)
        });
        if (fb.ok) {
          var fj = await fb.json();
          var fu = fj && fj.user && (fj.user.avatar_url || fj.user.profile_image_url_https);
          if (fu && !/default_profile/.test(fu)) {
            imgUrl = fu.replace(/_(normal|bigger|400x400)\./, '_200x200.');
            name = fj.user.name || '';
          }
        }
      } catch (e) {}
    }
    if (!imgUrl) return done(false);

    try {
      var ir = await fetch(imgUrl, { signal: AbortSignal.timeout(10000) });
      if (!ir.ok) return done(false);
      var buf = Buffer.from(await ir.arrayBuffer());
      if (buf.length < 500) return done(false);
      fs.writeFileSync(filePath, buf);
      imgIx.avatars[k] = { file: 'avatars/' + k + '.jpg', handle: handle, name: name, at: Date.now(), live: true };
      try {
        var idxPath = path.join(ASSETS, 'avatars_index.json');
        fs.writeFile(idxPath, JSON.stringify(imgIx, null, 1), function () {});
      } catch (e) {}
      console.log('  [Live Scrape] Saved photo for @' + handle);
      return done(true, filePath);
    } catch (e) {
      return done(false);
    }
  })().catch(function () { done(false); });
}

/* -------------------------------------------- publisher icons (Media Room) */
/* A publisher found through Google News gets its website icon from Google's public
   icon service, once; it is kept in live_assets/sources. Icons smaller than 32 px look
   blurred on a TV, so they count as "no icon" and the page draws the initials. */
var SRC_DIR = path.join(ASSETS, 'sources'), iconMiss = {}, iconWait = {};
function siteIcon(dom, cb) {
  var exts = ['.png', '.jpg', '.webp', '.ico'];
  for (var i = 0; i < exts.length; i++) { var fp0 = path.join(SRC_DIR, dom + exts[i]); if (fs.existsSync(fp0)) return cb(fp0); }
  if (iconMiss[dom] && Date.now() - iconMiss[dom] < 86400000) return cb(null);
  if (iconWait[dom]) { iconWait[dom].push(cb); return; }
  iconWait[dom] = [cb];
  function done(fp) { var l = iconWait[dom] || []; delete iconWait[dom]; if (!fp) iconMiss[dom] = Date.now(); l.forEach(function (f) { try { f(fp); } catch (e) {} }); }
  fetch('https://www.google.com/s2/favicons?domain=' + encodeURIComponent(dom) + '&sz=128', { signal: AbortSignal.timeout(10000) })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); var ct = r.headers.get('content-type') || ''; return r.arrayBuffer().then(function (a) { return { b: Buffer.from(a), ct: ct }; }); })
    .then(function (x) {
      var b = x.b, ext = /png/.test(x.ct) ? '.png' : /jpe?g/.test(x.ct) ? '.jpg' : /webp/.test(x.ct) ? '.webp' : /icon/.test(x.ct) ? '.ico' : null;
      if (!ext || b.length < 600) return done(null);
      if (ext === '.png' && b.length > 24 && b.readUInt32BE(16) < 32) return done(null);      // a 16 px icon
      try { fs.mkdirSync(SRC_DIR, { recursive: true }); } catch (e) {}
      var fp = path.join(SRC_DIR, dom + ext); fs.writeFileSync(fp, b); done(fp);
    }).catch(function () { done(null); });
}

/* --------------------------------------------------------------- states */
/* every state in the data with enough of its own posts to fill the screens */
var STATE_MIN_POSTS = 140;          // in STATE_DAYS (7) days -- about what 200 was over the ~10 days held before
var STATE_HI = {
  'Andhra Pradesh': 'आंध्र प्रदेश', 'Arunachal Pradesh': 'अरुणाचल प्रदेश', 'Assam': 'असम', 'Bihar': 'बिहार', 'Chhattisgarh': 'छत्तीसगढ़',
  'Goa': 'गोवा', 'Gujarat': 'गुजरात', 'Haryana': 'हरियाणा', 'Himachal Pradesh': 'हिमाचल प्रदेश', 'Jharkhand': 'झारखंड', 'Karnataka': 'कर्नाटक',
  'Kerala': 'केरल', 'Madhya Pradesh': 'मध्य प्रदेश', 'Maharashtra': 'महाराष्ट्र', 'Manipur': 'मणिपुर', 'Meghalaya': 'मेघालय', 'Mizoram': 'मिज़ोरम',
  'Nagaland': 'नागालैंड', 'Odisha': 'ओडिशा', 'Punjab': 'पंजाब', 'Rajasthan': 'राजस्थान', 'Sikkim': 'सिक्किम', 'Tamil Nadu': 'तमिलनाडु',
  'Telangana': 'तेलंगाना', 'Tripura': 'त्रिपुरा', 'Uttar Pradesh': 'उत्तर प्रदेश', 'Uttarakhand': 'उत्तराखंड', 'West Bengal': 'पश्चिम बंगाल',
  'Delhi': 'दिल्ली', 'Jammu and Kashmir': 'जम्मू और कश्मीर', 'Ladakh': 'लद्दाख', 'Puducherry': 'पुदुचेरी', 'Chandigarh': 'चंडीगढ़'
};
/* posts of leaders per state over the last STATE_DAYS days (said on the start screen); the
   number does not depend on how many days happen to be in memory */
var STATE_DAYS = 7;
function stateList(rows) {
  var by = {}, since = LIVE.addDays(LIVE.istDay(Date.now()), -(STATE_DAYS - 1)), lo = 0, hi = rows.length;
  while (lo < hi) { var m = (lo + hi) >> 1; if (rows[m]['Tweet Date'] < since) lo = m + 1; else hi = m; }
  for (var i = lo; i < rows.length; i++) {
    var r = rows[i];
    if (!LIVE.validState(r.State) || NEWS.MEDIA_CATS.indexOf(r.Category) >= 0) continue;
    by[r.State] = (by[r.State] || 0) + 1;
  }
  return Object.keys(by).filter(function (s) { return by[s] >= STATE_MIN_POSTS; })
    .sort(function (a, b) { return by[b] - by[a]; })
    .map(function (s) { return { state: s, posts: by[s] }; });
}
var STATES = [], STATE_SET = {};
function validScope(s) { return s === 'all' || s === 'up' || (/^st:/.test(s) && STATE_SET[s.slice(3)] === 1); }

/* media news for one state: its own items first (State column, or the state
   named in the text when the column is empty), then national news */
function newsForState(all, st) {
  var en = st.toLowerCase(), hi = STATE_HI[st] || null;
  /* media rows mostly carry State "National" -- only a real state counts as a tag */
  function tagged(r) { return LIVE.validState(r.st) ? LIVE.stateOf(r.st) : null; }
  var mine = all.filter(function (r) {
    var s = tagged(r); if (s) return s === st;
    var t = (String(r.head || '') + ' ' + String(r.sum || '')).toLowerCase();
    return t.indexOf(en) >= 0 || (hi && t.indexOf(hi) >= 0);
  });
  var nat = all.filter(function (r) { return !tagged(r) && mine.indexOf(r) < 0; });
  return { mine: mine, nat: nat };
}
/* how: 'breaking' (24 h: newest breaking first) or 'relevant' (48 / 72 h: the period's
   biggest stories first, fresher ones a little higher) */
function headlines(rows, how) {
  var own = rows.filter(function (r) { return !/^RT @/.test(String(r.head || '')); });   // a re-post is not a headline
  return NEWS.dedupe(NEWS.sortRows(own, how || 'breaking'));
}

/* --------------------------------------------- Political Pulse live feed */
/* a pulse_hot.tweets document -> a row like the ones loadFromMongo makes */
function cleanPulseDoc(doc) {
  var d = {};
  KEEP.forEach(function (f) { if (doc[f] !== undefined && doc[f] !== null) d[f] = doc[f]; });
  if (!/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/.test(String(d['Tweet Date'] || '')) || !d.Handle) return null;
  d._id = String(doc['Tweet ID'] || doc._id);
  ['Total Views', 'Total Likes', 'Total Retweets', 'Total Comments'].forEach(function (f) { d[f] = HA.num(d[f]); });
  if (d['Tweet Text'] && String(d['Tweet Text']).startsWith('RT @')) d['Tweet Text'] = 'RT @';    // see loadFromMongo
  var cs = LIVE.stateOf(d.State); if (cs) d.State = cs;
  d._p = 1;                                     // came from Pulse (see pulse_feed loadWindow)
  return d;
}

/* Pulse keeps raw posts for 3 days only. A copy of every post we receive goes to Nazar's
   own database (collection pulse_raw, removed by Mongo itself after KEEP_RAW_DAYS + 1),
   so after a restart the 48 / 72 h windows and their "previous period" still have them. */
var rawP = null;
function rawColl() {
  if (!MONGO_URI) return Promise.reject(new Error('MONGODB_URI is not set'));
  if (!rawP) {
    rawP = (async function () {
      var MC = require('mongodb').MongoClient, cli = new MC(MONGO_URI, { maxPoolSize: 3 });
      await cli.connect();
      var c = cli.db(DB_NAME).collection('pulse_raw');
      await c.createIndex({ ts: 1 }, { expireAfterSeconds: (KEEP_RAW_DAYS + 1) * 86400 });
      await c.createIndex({ 'Tweet Date': 1 });
      return c;
    })();
    rawP.catch(function () { rawP = null; });
  }
  return rawP;
}
async function saveRaw(list) {
  var c = await rawColl();
  var ops = list.map(function (r) {
    var set = { ts: new Date(LIVE.parseIst(r['Tweet Date'])) };
    Object.keys(r).forEach(function (k) { if (k.charAt(0) !== '_') set[k] = r[k]; });   // not _id, not helper fields (_t)
    return { updateOne: { filter: { _id: r._id }, update: { $set: set }, upsert: true } };
  });
  for (var i = 0; i < ops.length; i += 1000) await c.bulkWrite(ops.slice(i, i + 1000), { ordered: false });
}
async function loadRaw(since) {
  var c = await rawColl(), t0 = Date.now();
  var list = await c.find({ 'Tweet Date': { $gte: since } }, { projection: { ts: 0 } }).toArray();
  list.forEach(function (r) { r._id = String(r._id); r._p = 1; });
  console.log('  [pulse] ' + list.length.toLocaleString('en-IN') + ' saved Pulse posts from ' + since + ' (pulse_raw) in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
  return list;
}

var ROWS = null, COLL = null, PULSE = null, dataVer = 0;
function rangeMeta(rows) {
  return { from: rows.length ? rows[0]['Tweet Date'].slice(0, 16) : null, to: rows.length ? rows[rows.length - 1]['Tweet Date'].slice(0, 16) : null,
           posts: rows.length, live: !!(PULSE && PULSE.ready()) };
}
/* new or changed posts from Pulse: drop raw posts older than KEEP_RAW_DAYS, index again,
   and let every cache that was built from the old rows go */
function onPulseChange() {
  if (!ROWS) return;
  var cutDay = LIVE.addDays(LIVE.istDay(Date.now()), -KEEP_RAW_DAYS), lo = 0, hi = ROWS.length;
  while (lo < hi) { var m = (lo + hi) >> 1; if (ROWS[m]['Tweet Date'] < cutDay) lo = m + 1; else hi = m; }
  if (lo) ROWS.splice(0, lo);
  if (COLL) COLL.reindex();
  dataVer++;
  meta = rangeMeta(ROWS);
  STATES = stateList(ROWS); STATE_SET = {}; STATES.forEach(function (s) { STATE_SET[s.state] = 1; });
}

/* ------------------------------------------------------------- service */
function makeService(rows) {
  var coll = COLL = new Collection(rows), memo = {}, newsMemo = {}, inDb = {};
  /* media posts (news) of the window on screen -- the ticker and "in the news" follow the
     chosen 24 / 48 / 72 h; without a window, the newest ones */
  var media = function (win) {
    var k = win ? win.from + '|' + win.to : 'newest', h = newsMemo[k];
    if (h && h.ver === dataVer) return Promise.resolve(h.v);
    var docs = win
      ? rows.slice(lowerIx(win.from), lowerIx(win.to + '~')).filter(function (r) { return NEWS.MEDIA_CATS.indexOf(r.Category) >= 0; })
      : rows.filter(function (r) { return NEWS.MEDIA_CATS.indexOf(r.Category) >= 0; });
    docs = docs.slice(-4000).reverse();
    var items = NEWS.toItems(docs); NEWS.score(items);
    if (Object.keys(newsMemo).length > 12) newsMemo = {};
    newsMemo[k] = { ver: dataVer, v: items };
    return Promise.resolve(items);
  };
  function lowerIx(v) {
    var lo = 0, hi = rows.length;
    while (lo < hi) { var m = (lo + hi) >> 1; if (rows[m]['Tweet Date'] < v) lo = m + 1; else hi = m; }
    return lo;
  }
  /* everything Pulse has, for a scope: nazar_daily (all posts, every account) before window_start
     + the raw posts from window_start on, counted the same way (retweets and media included).
     { posts, views, likes, since } or null without Pulse's summary */
  function allTime(scope) {
    var k = scope || 'all', h = inDb[k];
    if (h && h.ver === dataVer && h.key === (PULSE && PULSE.summaryNow() ? PULSE.summaryNow().ws : null)) return Promise.resolve(h.v);
    if (!PULSE) return Promise.resolve(null);
    return PULSE.summary().then(function (s) {
      if (!s) return null;
      var st = LIVE.stateOfScope(k), out = { posts: 0, views: 0, likes: 0, since: s.firstDay };
      Object.keys(s.allTime).forEach(function (x) {
        if (st && LIVE.stateOf(x) !== st) return;
        var a = s.allTime[x]; out.posts += a.n; out.views += a.v; out.likes += a.l;
      });
      for (var i = lowerIx(s.ws); i < rows.length; i++) {
        var r = rows[i];
        if (st && r.State !== st) continue;
        out.posts++; out.views += HA.num(r['Total Views']); out.likes += HA.num(r['Total Likes']);
      }
      inDb[k] = { ver: dataVer, key: s.ws, v: out };
      return out;
    });
  }
  /* posts of one IST day held as raw rows, for a scope (state name or null = all India) */
  function rawDay(day, st) {
    var q = { 'Tweet Date': { $gte: day + ' 00:00:00 IST', $lte: day + ' 23:59:59 IST' } };
    if (st) q.State = st;
    return coll.countDocuments(q);
  }
  /* Pulse: day < window_start from nazar_daily, day >= window_start from the raw posts.
     null (no summary yet) -> live_lib counts the rows it has. */
  var gapMemo = { k: null, v: null };
  var pulseHooks = !PULSE ? {} : {
    /* days before window_start whose raw posts here are under 60 % of Pulse's own count for the
       day (e.g. 24 Oct: Nazar's old copy stopped at 07:04) -- a leader's chart says "no data" */
    rawGaps: function () {
      var s = PULSE.summaryNow(); if (!s) return Promise.resolve({});
      var k = dataVer + '|' + s.ws; if (gapMemo.k === k) return Promise.resolve(gapMemo.v);
      var from = LIVE.addDays(s.ws, -(KEEP_RAW_DAYS + 1)), days = Object.keys(s.daily).filter(function (d) { return d >= from && d < s.ws; }), out = {};
      return Promise.all(days.map(function (d) {
        var tot = 0; Object.keys(s.daily[d]).forEach(function (x) { tot += s.daily[d][x]; });
        return rawDay(d, null).then(function (n) { if (tot > 0 && n < 0.6 * tot) out[d] = 1; });
      })).then(function () { gapMemo = { k: k, v: out }; return out; });
    },
    dayCounts: function (scope, days) {
      return PULSE.summary().then(function (s) {
        if (!s) return null;
        var st = LIVE.stateOfScope(scope), out = {};
        return Promise.all(days.map(function (day) {
          if (day >= s.ws) return rawDay(day, st).then(function (n) { out[day] = n; });
          if (day < s.from || (s.firstDay && day < s.firstDay)) return null;
          var by = s.daily[day] || {}, n = 0;
          Object.keys(by).forEach(function (k) { if (!st || LIVE.stateOf(k) === st) n += by[k]; });
          out[day] = n;
          return null;
        })).then(function () { return out; });
      });
    },
    /* accounts with >= 1 post in 28 days, per party (politicians only) */
    collected: function (scope, toMs) {
      return PULSE.summary().then(function (s) {
        if (!s) return null;
        var st = LIVE.stateOfScope(scope), seen = {}, by = {};
        function add(p, h) {
          var k = String(p) + '\u0001' + h; if (seen[k]) return; seen[k] = 1;
          var np = LIVE.normParty(p); if (np) by[np] = (by[np] || 0) + 1;
        }
        s.collected.forEach(function (e) { if (!st || LIVE.stateOf(e.s) === st) add(e.p, e.h); });
        return coll.find({ 'Tweet Date': { $gte: s.ws, $lte: LIVE.fmtIst(toMs) } }).toArray().then(function (list) {
          list.forEach(function (r) {
            if (LIVE.isMedia(r.Category) || (st && r.State !== st)) return;
            add(r.Party, String(r.Handle).toLowerCase());
          });
          return by;
        });
      });
    }
  };
  return LIVE.createService(Object.assign({
    coll: coll,
    now: Date.now,
    /* changes when posts change (dataVer) or Pulse pushes (the LIVE chip) -- else no rebuild */
    version: function () { return dataVer + '|' + (PULSE ? PULSE.lastPushIst() : ''); },
    /* "N political accounts tracked": with Pulse, the accounts Pulse actually tracks
       (nazar_handles, media left out); otherwise Nazar's own list (handle_master.json) */
    mapped: function (scope) {
      var ps = PULSE ? PULSE.summaryNow() : null;
      var m = ps && ps.handles ? ps.handles : MAPL.load(), st = LIVE.stateOfScope(scope), k = st || 'all';
      if (memo.src !== m) memo = { src: m };
      if (!memo[k]) memo[k] = st ? LIVE.countMapped(m, st) : LIVE.countMapped(m);
      return memo[k];
    },
    avatarOf: function (h) {
      var k = String(h || '').toLowerCase(), e = imgIx.avatars[k];
      if (e && e.file) return '/live/img/a/' + encodeURIComponent(k);
      var pk = Object.keys(imgIx.parties).filter(function (p) {
        return imgIx.parties[p].file && String(imgIx.parties[p].handle || '').toLowerCase() === k;
      })[0];
      if (pk) return '/live/img/p/' + partySlug(pk);
      if (k && k.length >= 2 && !/^(media|journalist)/i.test(k)) {
        return '/live/img/a/' + encodeURIComponent(k);
      }
      return null;
    },
    partyLogo: function (p) { var e = imgIx.parties[p]; return e && e.file ? '/live/img/p/' + partySlug(p) : null; },
    master: function () { return MAPL.load(); },
    media: media,
    /* a file has no push time; Pulse's is nazar_meta.updated_at (lets the chip say LIVE) */
    lastPush: function () { return Promise.resolve(PULSE ? PULSE.lastPushIst() : ''); },
    pipeline: function () { return null; },
    news: function (scope, win) {
      var how = win && win.toMs - win.fromMs > 25 * 3600000 ? 'relevant' : 'breaking';
      return media(win).then(function (all) {
        var st = LIVE.stateOfScope(scope), list;
        if (st) { var f = newsForState(all, st); list = headlines(f.mine, how).concat(headlines(f.nat, how)); }   // the state's own news first
        else list = headlines(NEWS.forScope(all.slice(), 'all').rows, how);
        return list.slice(0, LIVE.C.TICKER_ITEMS).map(function (r) {
          return { head: r.head, src: r.src, handle: r.h, date: r.date, views: r.vw, breaking: !!r.breaking,
                   topic: r.cat && r.cat !== 'Other' ? r.cat : null };
        });
      });
    },
    /* posts in the file(s) for this scope; with Pulse: all of Pulse's history (nazar_daily
       before window_start) + the raw posts from window_start on */
    postsInDb: function (scope) {
      return allTime(scope).then(function (a) {
        if (a) return a.posts;
        var st = LIVE.stateOfScope(scope);
        return st ? rows.filter(function (r) { return r.State === st; }).length : rows.length;
      });
    },
    allTime: allTime
  }, pulseHooks));
}

/* ------------------------------------------------------------------ http */
var TYPES = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json' };
function send(res, code, type, body, extra) {
  var h = {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet'
  };
  Object.keys(extra || {}).forEach(function (k) { h[k] = extra[k]; });
  /* text (the page, JSON, the map) goes gzipped when the browser takes it: 5-10x smaller,
     which is most of the waiting on a slow line */
  var ae = res.req && res.req.headers['accept-encoding'] || '';
  if (/gzip/.test(ae) && /^(text\/|application\/json)/.test(type) && body && body.length > 1024) {
    try { body = zlib.gzipSync(typeof body === 'string' ? Buffer.from(body) : body, { level: 6 }); h['Content-Encoding'] = 'gzip'; h.Vary = 'Accept-Encoding'; } catch (e) {}
  }
  res.writeHead(code, h); res.end(body);
}
function json(res, code, obj) { send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj)); }
function file(res, p) {
  fs.readFile(p, function (err, buf) {
    if (err) return send(res, 404, 'text/plain', 'Not found');
    send(res, 200, TYPES[path.extname(p).toLowerCase()] || 'application/octet-stream', buf, { 'Cache-Control': 'public, max-age=86400' });
  });
}

var svc = null, meta = null, page = { mtime: 0, body: '' }, attacks = null;
var ATTACKS = require('./attacks.js');
/* Media Room: live news from free feeds, independent of the CSV (starts with the server) */
var mediaRoom = require('./media_room.js').createMediaRoom({ dataDir: DATA });
/* Election Room: official results from results.eci.gov.in (live and past) + election news from the Media Room */
var electionRoom = require('./election_room.js').createElectionRoom({ dataDir: DATA });
var ELEC_CFG = {}; try { ELEC_CFG = JSON.parse(fs.readFileSync(path.join(APP, 'data', 'election_config.json'), 'utf8')); } catch (e) {}
/* election headlines by type (Hindi + English words); "all" = any election word */
var ELEC_NEWS = {
  all: /चुनाव|मतगणना|मतदान|नतीजे|परिणाम|उपचुनाव|निकाय|पंचायत|election|poll|bypoll|by-election|counting|vote|result|ballot|civic|panchayat|municipal|mayor|MLC/i,
  ls: /लोकसभा|Lok Sabha|parliamentary|\bMP\b seat/i,
  vs: /विधानसभा|assembly|vidhan sabha|\bMLA\b/i,
  bye: /उपचुनाव|bypoll|by-poll|by-election|bye-election/i,
  council: /राज्यसभा|Rajya Sabha|विधान परिषद|\bMLC\b|legislative council/i,
  local: /नगर निगम|नगर निकाय|नगर पालिका|नगर पंचायत|निकाय चुनाव|पंचायत|प्रधान|पार्षद|मेयर|महापौर|वार्ड|जिला परिषद|ज़िला परिषद|municipal|civic|corporation poll|mayor|panchayat|zila parishad|ward|councillor|BMC|GHMC/i
};
var ELEC_WORD = /चुनाव|मतगणना|मतदान|नतीजे|परिणाम|election|poll|counting|vote|result/i;
function electionNews(st, type, city) {
  var re = ELEC_NEWS[type] || ELEC_NEWS.all, cre = null;
  if (city && st && ELEC_CFG.cities && ELEC_CFG.cities[st]) {
    var pair = ELEC_CFG.cities[st].filter(function (c) { return c[0] === city; })[0];
    if (pair) cre = new RegExp(pair.map(function (x) { return x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|'), 'i');
  }
  var test = function (t) { return re.test(t) && (type === 'all' || type === 'local' || type === 'council' || ELEC_WORD.test(t)) && (!cre || cre.test(t)); };
  try { return mediaRoom.find(test, st || null, 48, 12); } catch (e) { return []; }
}
/* the last good screens: served at once after a restart while the posts load (snap_cache.js) */
var snapCache = require('./snap_cache.js').createSnapCache(DATA);
/* saved screens: 'snap:<scope>' for 24 h (as before), 'snap:<scope>:<hours>' for 48 / 72 h */
function snapKey(scope, hours) { return 'snap:' + scope + (hours && hours !== LIVE.C.WIN_H ? ':' + hours : ''); }
function cachedSnap(scope, hours) {
  var c = snapCache.get(snapKey(scope, hours)) || snapCache.get(snapKey(scope)); if (!c) return null;
  /* "degraded" makes the page's footer say it is showing saved data from that time */
  return Object.assign({}, c.v, { degraded: { generatedAt: new Date(c.at).toISOString() } });
}
/* shown only when there is not even a saved copy (the very first start) */
var LOADING_PAGE = '<!DOCTYPE html><html lang="hi"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
  + '<meta name="robots" content="noindex, nofollow"><meta http-equiv="refresh" content="5"><title>Nazar · India Political Pulse</title>'
  + '<style>html,body{height:100%;margin:0}body{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:#FFF7EE;'
  + 'font-family:"Noto Sans Devanagari","Segoe UI",sans-serif;background:radial-gradient(ellipse 60% 55% at 50% 45%,#5a1a05 0%,#2a0a03 55%,#140502 100%)}'
  + '.lg{width:120px;height:120px;border-radius:50%;overflow:hidden;box-shadow:0 0 0 4px rgba(255,200,87,.8),0 0 60px rgba(255,153,51,.6);background:#E65100}'
  + '.lg img{width:100%;height:100%;object-fit:cover;display:block}h1{font-size:44px;margin:26px 0 4px;font-weight:800}'
  + 'p{margin:6px 0;color:rgba(255,247,238,.75);font-size:18px}.bar{width:220px;height:4px;border-radius:4px;margin:26px auto 0;overflow:hidden;background:rgba(255,255,255,.12)}'
  + '.bar i{display:block;width:40%;height:100%;background:linear-gradient(90deg,#E65100,#FFC857);animation:m 1.4s ease-in-out infinite}'
  + '@keyframes m{0%{margin-left:-40%}100%{margin-left:100%}}</style></head><body>'
  + '<div class="lg"><img src="/live/img/p/BJP" alt="" onerror="this.remove()"></div><h1>नज़र</h1>'
  + '<p>तैयार हो रहा है — कुछ ही पलों में शुरू</p><p style="font-size:15px">Nazar is getting ready — starting in a moment</p><div class="bar"><i></i></div></body></html>';
function avatarFor(h) {
  var k = String(h || '').toLowerCase(), e = imgIx.avatars[k];
  if (e && e.file) return '/live/img/a/' + encodeURIComponent(k);
  if (k && k.length >= 2) return '/live/img/a/' + encodeURIComponent(k);
  return null;
}
/* the snapshot plus the "biggest attacks" board for the same scope and window */
function withAttacks(scope, snap) {
  var a = null;
  /* the board is remembered per scope and window length (its sticky top two differ by period) */
  var bkey = scope + (snap && snap.hours && snap.hours !== LIVE.C.WIN_H ? '@' + snap.hours : '');
  try { a = attacks ? attacks.forScope(scope, snap, avatarFor, bkey) : null; } catch (e) { console.log('  [attacks] ' + e.message); }
  /* breakBaseDays: how many earlier days the "usual" level of a leader uses (the page shows it) */
  var extra = { breakBaseDays: LIVE.C.BREAK_BASE_DAYS };
  if (snap && snap.topPost) extra.topPost = Object.assign({}, snap.topPost, { avatar: avatarFor(snap.topPost.handle) });   // the photo for the "most-viewed post" card
  return Object.assign({}, snap, a ? { attacks: a } : {}, extra);
}
function pageHtml(m) {
  var p = path.join(APP, 'nazar.html'), st = fs.statSync(p);
  if (st.mtimeMs !== page.mtime) page = { mtime: st.mtimeMs, body: fs.readFileSync(p, 'utf8') };
  /* tell the page it is showing a recorded file, not a live feed */
  return page.body.replace('<script>', '<script>window.NAZAR_PROTO=' + JSON.stringify(m || meta).replace(/</g, '\\u003c') + ';</script>\n<script>');
}

var server = http.createServer(function (req, res) {
  var u = urlm.parse(req.url, true), p = u.pathname, q = u.query, m;
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'GET only');
  if (p === '/robots.txt') return send(res, 200, 'text/plain; charset=utf-8', 'User-agent: *\nDisallow: /\n');
  if (p === '/' || p === '/up') { res.writeHead(302, { Location: '/live' + (p === '/up' ? '?scope=up' : '') }); return res.end(); }
  /* for Render's health check: "ready" only once the posts are loaded, so a deploy switches
     over to the new server only then (Settings -> Health Check Path: /healthz) */
  if (p === '/healthz') return svc ? send(res, 200, 'text/plain', 'ok') : send(res, 503, 'text/plain', 'loading');
  /* Political Pulse feed: window, last push, last poll, errors -- never the connection string */
  if (p === '/health/pulse') {
    if (!PULSE) return json(res, 200, { enabled: false, reason: PULSE_URL ? 'USE_PULSE_DATA is not 1' : 'PULSE_MONGO_URL is not set' });
    return json(res, 200, Object.assign({ enabled: true, dataReady: !!svc, postsInMemory: ROWS ? ROWS.length : 0, range: meta }, PULSE.health()));
  }
  if (p === '/live' || p === '/tv') {
    if (svc) return send(res, 200, 'text/html; charset=utf-8', pageHtml());
    /* still loading the posts: the full page from the saved screens if there are any, else the branded wait */
    var cm = snapCache.get('meta');
    if (cm && snapCache.get('snap:all')) return send(res, 200, 'text/html; charset=utf-8', pageHtml(cm.v));
    return send(res, 503, 'text/html; charset=utf-8', LOADING_PAGE, { 'Retry-After': '5' });
  }
  if (p === '/live/india-states.json') return file(res, path.join(APP, 'live_india_states.json'));
  if ((m = /^\/live\/img\/a\/([^\/]+)$/.exec(p))) {
    var rawH = decodeURIComponent(m[1]).toLowerCase();
    var e = imgIx.avatars[rawH];
    if (e && e.file && /^avatars\/[^\/\\]+\.jpg$/.test(e.file) && fs.existsSync(path.join(ASSETS, e.file))) {
      return file(res, path.join(ASSETS, e.file));
    }
    if (fs.existsSync(path.join(ASSETS, 'avatars', rawH + '.jpg'))) {
      imgIx.avatars[rawH] = { file: 'avatars/' + rawH + '.jpg', handle: rawH, at: Date.now() };
      return file(res, path.join(ASSETS, 'avatars', rawH + '.jpg'));
    }
    return fetchOnDemand(rawH, function (ok, fp) {
      if (ok && fp) return file(res, fp);
      send(res, 404, 'text/plain', 'Not found');
    });
  }
  if ((m = /^\/live\/img\/p\/([A-Za-z0-9_]+)$/.exec(p))) {
    var hit = null;
    Object.keys(imgIx.parties).forEach(function (k) { if (partySlug(k) === m[1] && imgIx.parties[k].file) hit = imgIx.parties[k].file; });
    if (!hit || !/^parties\/[^\/\\]+\.jpg$/.test(hit)) return send(res, 404, 'text/plain', 'Not found');
    return file(res, path.join(ASSETS, hit));
  }
  if ((m = /^\/live\/img\/leaders\/([a-z0-9-]+\.(jpg|png|webp))$/.exec(p))) return file(res, path.join(ASSETS, 'leaders', m[1]));
  if ((m = /^\/live\/img\/src\/([a-z0-9.-]+\.[a-z]{2,})$/.exec(p))) {       // a news publisher's website icon (Media Room)
    return siteIcon(m[1], function (fp) { if (fp) return file(res, fp); send(res, 404, 'text/plain', 'Not found'); });
  }
  if (p === '/api/media-room') {
    /* ?state=<name> (the Media Room's own pick) wins over the page's scope */
    var mrSt = q.state ? String(q.state).slice(0, 60) : LIVE.stateOfScope(String(q.scope || 'all'));
    try { return json(res, 200, mediaRoom.get(mrSt || null)); }
    catch (err) { console.log('  [media] ' + err.message); return json(res, 500, { error: 'News is not available right now.', code: 'server' }); }
  }
  if (p === '/api/election-room') {
    /* ?state=<name>&type=all|ls|vs|bye|council|local&city=<en name>&demo=1 */
    /* state=- : All India chosen on the page (even on a state's page) */
    var erSt = q.state === '-' ? null : q.state ? String(q.state).slice(0, 60) : LIVE.stateOfScope(String(q.scope || 'all'));
    var erType = /^(all|ls|vs|bye|council|local)$/.test(String(q.type || '')) ? String(q.type) : 'all';
    try {
      if (erSt) mediaRoom.get(erSt);                                     // the Media Room starts collecting this state's news too
      var er = electionRoom.get(erSt || null, erType === 'council' || erType === 'local' ? 'none' : erType, q.demo === '1');
      er.news = electionNews(erSt || null, erType, q.city ? String(q.city).slice(0, 40) : null);
      er.cities = erSt && ELEC_CFG.cities ? ELEC_CFG.cities[erSt] || [] : [];
      er.hasDemo = electionRoom.hasDemo();
      return json(res, 200, er);
    } catch (err) { console.log('  [election] ' + err.message); return json(res, 500, { error: 'Results are not available right now.', code: 'server' }); }
  }
  if (p === '/api/live-states') {
    if (!svc) { var cs = snapCache.get('states'); return cs ? json(res, 200, { states: cs.v }) : json(res, 503, { error: 'Data is still loading.', code: 'server' }); }
    return json(res, 200, { states: STATES });
  }
  if (/^\/api\/live-/.test(p)) {
    var scope = String(q.scope || 'all'), hrs = LIVE.hoursOf(q.hrs);     // ?hrs=24|48|72 (anything else: 24)
    if (!svc) {
      /* while loading: the saved snapshot for this scope; the page fetches again every minute and gets the fresh one when ready */
      var cached = p === '/api/live-snapshot' ? cachedSnap(scope, hrs) : null;
      return cached ? json(res, 200, cached) : json(res, 503, { error: 'Data is still loading.', code: 'server' });
    }
    if (!validScope(scope)) return json(res, 400, { error: 'Unknown state.', code: 'scope' });
    var job;
    if (p === '/api/live-snapshot') job = svc.get(scope, { hours: hrs }).then(function (s) { var r = withAttacks(scope, s); snapCache.put(snapKey(scope, hrs), r); return r; });
    else if (p === '/api/live-search') job = Promise.resolve({ results: svc.search(scope, String(q.q || '').slice(0, 60)) });
    else if (p === '/api/live-person') job = svc.person(scope, String(q.h || '').slice(0, 60), { hours: hrs }).then(function (r) {
      return r || { __status: 404, error: 'This leader is not in the list.', code: 'notfound' };
    });
    else return json(res, 404, { error: 'Not found' });
    return job.then(function (r) { if (r && r.__status) return json(res, r.__status, { error: r.error, code: r.code }); json(res, 200, r); })
      .catch(function (err) { console.log('  [' + p + '] ' + (err && err.message || err)); json(res, 500, { error: 'Data is not available right now.', code: 'server' }); });
  }
  send(res, 404, 'text/plain', 'Not found');
});

server.listen(PORT, HOST, function () {
  console.log('\n  NAZAR prototype');
  console.log('  open:  http://localhost:' + PORT + '/live' + (HOST === '0.0.0.0' ? '   (also from other devices on this network)' : ''));
  console.log('  loading data from ' + DATA + ' ...');
  mediaRoom.start().catch(function (e) { console.log('  [media] ' + e.message); });
  electionRoom.start().catch(function (e) { console.log('  [election] ' + e.message); });
  /* the saved screens first (seconds), so the page works while the posts load (minutes) */
  snapCache.load().then(function (n) { console.log('  [snap-cache] ' + n + ' saved screens ready for the loading time (' + snapCache.kind + ')'); })
    .catch(function (e) { console.log('  [snap-cache] none: ' + e.message); });
  loadData().then(async function (rows) {
    ROWS = rows;
    if (USE_PULSE) {
      /* Pulse posts saved by earlier runs (beyond Pulse's own 3 days) join first; a post that
         Nazar's own data also has is kept once (same Tweet URL) */
      if (MONGO_URI) {
        try {
          var saved = await loadRaw(LIVE.addDays(LIVE.istDay(Date.now()), -KEEP_RAW_DAYS));
          if (saved.length) {
            var urls = {}; saved.forEach(function (r) { if (r['Tweet URL']) urls[r['Tweet URL']] = 1; });
            /* in place, one by one (a 1.5-lakh-item push.apply overflows the stack) */
            var w = 0;
            for (var i = 0; i < rows.length; i++) if (!rows[i]['Tweet URL'] || !urls[rows[i]['Tweet URL']]) rows[w++] = rows[i];
            rows.length = w;
            for (var j = 0; j < saved.length; j++) rows.push(saved[j]);
            rows.sort(function (a, b) { return a['Tweet Date'] < b['Tweet Date'] ? -1 : a['Tweet Date'] > b['Tweet Date'] ? 1 : 0; });
          }
        } catch (e) { console.log('  [pulse] saved posts not loaded: ' + String(e && e.message || e).replace(/mongodb(\+srv)?:\/\/[^\s@]*@/g, 'mongodb://***@')); }
      }
      /* Pulse's raw window joins the rows; it keeps polling even if Atlas is down right now */
      PULSE = require('./pulse_feed.js').createPulseFeed({ url: PULSE_URL, rows: rows, clean: cleanPulseDoc, num: HA.num, onChange: onPulseChange,
                                                         persist: MONGO_URI ? saveRaw : null });
      try { console.log('  [pulse] ' + (await PULSE.start() ? 'live from Political Pulse (pulse_hot)' : 'not reachable yet -- retrying every minute')); }
      catch (e) { console.log('  [pulse] could not start: ' + PULSE.health().lastError); }
    } else if (PULSE_URL) console.log('  [pulse] PULSE_MONGO_URL is set but USE_PULSE_DATA is not 1 -- using Nazar\'s own data only');
    meta = rangeMeta(rows);
    STATES = stateList(rows); STATE_SET = {}; STATES.forEach(function (s) { STATE_SET[s.state] = 1; });
    svc = makeService(rows);
    console.log('  ready -- ' + rows.length.toLocaleString('en-IN') + ' posts, ' + meta.from + ' to ' + meta.to + ' IST\n');
    svc.warm('all').then(function () { return svc.warm('up'); }).catch(function () {});
    attacks = ATTACKS.createEngine({ rows: rows, svc: svc, master: function () { return MAPL.load(); }, dataDir: DATA });
    /* keep the saved screens fresh even when nobody is watching: All India and UP every 10 minutes
       (other states are saved when someone opens them) */
    function saveMain() {
      snapCache.put('meta', meta); snapCache.put('states', STATES);
      ['all', 'up'].forEach(function (sc) {
        LIVE.C.HOURS.forEach(function (h) { svc.get(sc, { hours: h }).then(function (s) { snapCache.put(snapKey(sc, h), withAttacks(sc, s)); }).catch(function () {}); });
      });
    }
    Promise.resolve(attacks.start()).catch(function () {}).then(function () { saveMain(); setInterval(saveMain, 10 * 60000).unref(); });
    /* the screens most people open -- All India and UP, 24 / 48 / 72 h -- are rebuilt every minute
       one after another, so a visitor always gets a ready answer (live_lib serves the last copy
       while the next one is built) */
    var WARM = []; ['all', 'up'].forEach(function (sc) { LIVE.C.HOURS.forEach(function (h) { WARM.push([sc, h]); }); });
    function warmAll() {
      WARM.reduce(function (p, x) { return p.then(function () { return svc.get(x[0], { hours: x[1] }); }).catch(function () {}); }, Promise.resolve());
    }
    warmAll(); setInterval(warmAll, 60000).unref();
  }).catch(function (e) { console.log('\n  ERROR: ' + e.message + '\n'); process.exit(1); });
});
server.on('error', function (e) {
  console.log('\n  ERROR: ' + (e.code === 'EADDRINUSE' ? 'port ' + PORT + ' is already in use -- close the other window or set PORT=...' : e.message) + '\n');
  process.exit(1);
});

module.exports = server;

