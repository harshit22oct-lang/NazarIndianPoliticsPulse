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

/* An export covers a few days, not months. live_lib wants 14 days of history
   before it trusts its "usual volume" baseline; with a one-week file that would
   leave every screen empty. Use what the file has (at least 3 full days). */
LIVE.C.BASE_DAYS = 7;
LIVE.C.BASE_MIN_DAYS = 3;
LIVE.C.BREAK_BASE_DAYS = 6;

/* The connection string (with its password) comes ONLY from .env or the host's
   environment variables -- never from this file, which goes to GitHub. */
var MONGO_URI = process.env.MONGODB_URI || '';
var DB_NAME = process.env.DB_NAME || 'nazar';
var COLL_NAME = process.env.COLL_NAME || 'tweets';

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
  var cursor = coll.find({}, {
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
  var dates = rows.map(function (r) { return r['Tweet Date']; });
  function lower(v) { var lo = 0, hi = dates.length; while (lo < hi) { var m = (lo + hi) >> 1; if (dates[m] < v) lo = m + 1; else hi = m; } return lo; }
  function upper(v) { var lo = 0, hi = dates.length; while (lo < hi) { var m = (lo + hi) >> 1; if (dates[m] <= v) lo = m + 1; else hi = m; } return lo; }
  function test(v, cond) {
    if (cond instanceof RegExp) return cond.test(String(v));
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      for (var op in cond) {
        var c = cond[op];
        if (op === '$gte' && !(v >= c)) return false;
        if (op === '$gt' && !(v > c)) return false;
        if (op === '$lte' && !(v <= c)) return false;
        if (op === '$lt' && !(v < c)) return false;
        if (op === '$in' && c.indexOf(v) < 0) return false;
        if (op === '$nin' && c.indexOf(v) >= 0) return false;
      }
      return true;
    }
    return v === cond;
  }
  function select(q) {
    q = q || {};
    var lo = 0, hi = rows.length, dq = q['Tweet Date'];
    if (dq && typeof dq === 'object') {
      if (dq.$gte !== undefined) lo = lower(dq.$gte);
      if (dq.$gt !== undefined) lo = upper(dq.$gt);
      if (dq.$lte !== undefined) hi = upper(dq.$lte);
      if (dq.$lt !== undefined) hi = lower(dq.$lt);
    }
    var keys = Object.keys(q).filter(function (k) { return k !== 'Tweet Date' || typeof dq !== 'object'; });
    var out = [];
    for (var i = lo; i < hi; i++) {
      var r = rows[i], ok = true;
      for (var j = 0; j < keys.length && ok; j++) ok = test(r[keys[j]], q[keys[j]]);
      if (ok) out.push(r);
    }
    return out;
  }
  function cursor(list) {
    var c = {
      sort: function (spec) {
        var k = Object.keys(spec)[0], dir = spec[k];
        list = list.slice().sort(function (a, b) { return (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * dir; });
        return c;
      },
      limit: function (n) { list = list.slice(0, n); return c; },
      maxTimeMS: function () { return c; },
      toArray: function () { return Promise.resolve(list); }
    };
    return c;
  }
  this.find = function (q) { return cursor(select(q)); };
  this.countDocuments = function (q) { return Promise.resolve(select(q).length); };
  this.estimatedDocumentCount = function () { return Promise.resolve(rows.length); };
  /* only shape used: $match -> group by (Party, lower(Handle)) -> count per Party */
  this.aggregate = function (pipe) {
    var m = select(pipe[0] && pipe[0].$match), seen = {}, by = {};
    m.forEach(function (r) {
      var k = r.Party + '\u0001' + String(r.Handle).toLowerCase();
      if (seen[k]) return; seen[k] = 1; by[r.Party] = (by[r.Party] || 0) + 1;
    });
    return cursor(Object.keys(by).map(function (p) { return { _id: p, n: by[p] }; }));
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
var STATE_MIN_POSTS = 200;
var STATE_HI = {
  'Andhra Pradesh': 'आंध्र प्रदेश', 'Arunachal Pradesh': 'अरुणाचल प्रदेश', 'Assam': 'असम', 'Bihar': 'बिहार', 'Chhattisgarh': 'छत्तीसगढ़',
  'Goa': 'गोवा', 'Gujarat': 'गुजरात', 'Haryana': 'हरियाणा', 'Himachal Pradesh': 'हिमाचल प्रदेश', 'Jharkhand': 'झारखंड', 'Karnataka': 'कर्नाटक',
  'Kerala': 'केरल', 'Madhya Pradesh': 'मध्य प्रदेश', 'Maharashtra': 'महाराष्ट्र', 'Manipur': 'मणिपुर', 'Meghalaya': 'मेघालय', 'Mizoram': 'मिज़ोरम',
  'Nagaland': 'नागालैंड', 'Odisha': 'ओडिशा', 'Punjab': 'पंजाब', 'Rajasthan': 'राजस्थान', 'Sikkim': 'सिक्किम', 'Tamil Nadu': 'तमिलनाडु',
  'Telangana': 'तेलंगाना', 'Tripura': 'त्रिपुरा', 'Uttar Pradesh': 'उत्तर प्रदेश', 'Uttarakhand': 'उत्तराखंड', 'West Bengal': 'पश्चिम बंगाल',
  'Delhi': 'दिल्ली', 'Jammu and Kashmir': 'जम्मू और कश्मीर', 'Ladakh': 'लद्दाख', 'Puducherry': 'पुदुचेरी', 'Chandigarh': 'चंडीगढ़'
};
function stateList(rows) {
  var by = {};
  rows.forEach(function (r) {
    if (!LIVE.validState(r.State) || NEWS.MEDIA_CATS.indexOf(r.Category) >= 0) return;
    by[r.State] = (by[r.State] || 0) + 1;
  });
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
function headlines(rows) {
  var own = rows.filter(function (r) { return !/^RT @/.test(String(r.head || '')); });   // a re-post is not a headline
  return NEWS.dedupe(NEWS.sortRows(own, 'breaking'));
}

/* ------------------------------------------------------------- service */
function makeService(rows) {
  var coll = new Collection(rows), memo = {}, newsMemo = null, inDb = {};
  var media = function () {
    if (newsMemo) return Promise.resolve(newsMemo);
    var docs = rows.filter(function (r) { return NEWS.MEDIA_CATS.indexOf(r.Category) >= 0; }).slice(-4000).reverse();
    var items = NEWS.toItems(docs); NEWS.score(items);
    newsMemo = items;
    return Promise.resolve(items);
  };
  return LIVE.createService({
    coll: coll,
    now: Date.now,
    mapped: function (scope) {
      var m = MAPL.load(), st = LIVE.stateOfScope(scope), k = st || 'all';
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
    lastPush: function () { return Promise.resolve(''); },   // a file has no push time
    pipeline: function () { return null; },
    news: function (scope) {
      return media().then(function (all) {
        var st = LIVE.stateOfScope(scope), list;
        if (st) { var f = newsForState(all, st); list = headlines(f.mine).concat(headlines(f.nat)); }   // the state's own news first
        else list = headlines(NEWS.forScope(all.slice(), 'all').rows);
        return list.slice(0, LIVE.C.TICKER_ITEMS).map(function (r) {
          return { head: r.head, src: r.src, handle: r.h, date: r.date, views: r.vw, breaking: !!r.breaking,
                   topic: r.cat && r.cat !== 'Other' ? r.cat : null };
        });
      });
    },
    postsInDb: function (scope) {                            // posts in the file(s) for this scope
      var k = scope || 'all';
      if (inDb[k] === undefined) inDb[k] = k === 'all' ? rows.length : rows.filter(function (r) { return r.State === LIVE.stateOfScope(k); }).length;
      return Promise.resolve(inDb[k]);
    }
  });
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
function avatarFor(h) {
  var k = String(h || '').toLowerCase(), e = imgIx.avatars[k];
  if (e && e.file) return '/live/img/a/' + encodeURIComponent(k);
  if (k && k.length >= 2) return '/live/img/a/' + encodeURIComponent(k);
  return null;
}
/* the snapshot plus the "biggest attacks" board for the same scope and window */
function withAttacks(scope, snap) {
  var a = null;
  try { a = attacks ? attacks.forScope(scope, snap, avatarFor) : null; } catch (e) { console.log('  [attacks] ' + e.message); }
  /* breakBaseDays: how many earlier days the "usual" level of a leader uses (the page shows it) */
  var extra = { breakBaseDays: LIVE.C.BREAK_BASE_DAYS };
  if (snap && snap.topPost) extra.topPost = Object.assign({}, snap.topPost, { avatar: avatarFor(snap.topPost.handle) });   // the photo for the "most-viewed post" card
  return Object.assign({}, snap, a ? { attacks: a } : {}, extra);
}
function pageHtml() {
  var p = path.join(APP, 'nazar.html'), st = fs.statSync(p);
  if (st.mtimeMs !== page.mtime) page = { mtime: st.mtimeMs, body: fs.readFileSync(p, 'utf8') };
  /* tell the page it is showing a recorded file, not a live feed */
  return page.body.replace('<script>', '<script>window.NAZAR_PROTO=' + JSON.stringify(meta).replace(/</g, '\\u003c') + ';</script>\n<script>');
}

var server = http.createServer(function (req, res) {
  var u = urlm.parse(req.url, true), p = u.pathname, q = u.query, m;
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'GET only');
  if (p === '/robots.txt') return send(res, 200, 'text/plain; charset=utf-8', 'User-agent: *\nDisallow: /\n');
  if (p === '/' || p === '/up') { res.writeHead(302, { Location: '/live' + (p === '/up' ? '?scope=up' : '') }); return res.end(); }
  if (p === '/live' || p === '/tv') {
    if (!svc) return send(res, 503, 'text/html; charset=utf-8', '<meta http-equiv="refresh" content="3"><body style="background:#160602;color:#FFC857;font:24px sans-serif;padding:40px">Nazar is loading the data file... this page reloads by itself.</body>');
    return send(res, 200, 'text/html; charset=utf-8', pageHtml());
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
  if (p === '/api/live-states') {
    if (!svc) return json(res, 503, { error: 'Data is still loading.', code: 'server' });
    return json(res, 200, { states: STATES });
  }
  if (/^\/api\/live-/.test(p)) {
    var scope = String(q.scope || 'all');
    if (!svc) return json(res, 503, { error: 'Data is still loading.', code: 'server' });
    if (!validScope(scope)) return json(res, 400, { error: 'Unknown state.', code: 'scope' });
    var job;
    if (p === '/api/live-snapshot') job = svc.get(scope, {}).then(function (s) { return withAttacks(scope, s); });
    else if (p === '/api/live-search') job = Promise.resolve({ results: svc.search(scope, String(q.q || '').slice(0, 60)) });
    else if (p === '/api/live-person') job = svc.person(scope, String(q.h || '').slice(0, 60), {}).then(function (r) {
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
  loadData().then(function (rows) {
    meta = { from: rows.length ? rows[0]['Tweet Date'].slice(0, 16) : null, to: rows.length ? rows[rows.length - 1]['Tweet Date'].slice(0, 16) : null, posts: rows.length };
    STATES = stateList(rows); STATE_SET = {}; STATES.forEach(function (s) { STATE_SET[s.state] = 1; });
    svc = makeService(rows);
    console.log('  ready -- ' + rows.length.toLocaleString('en-IN') + ' posts, ' + meta.from + ' to ' + meta.to + ' IST\n');
    svc.warm('all').then(function () { return svc.warm('up'); }).catch(function () {});
    attacks = ATTACKS.createEngine({ rows: rows, svc: svc, master: function () { return MAPL.load(); }, dataDir: DATA });
    attacks.start();
  }).catch(function (e) { console.log('\n  ERROR: ' + e.message + '\n'); process.exit(1); });
});
server.on('error', function (e) {
  console.log('\n  ERROR: ' + (e.code === 'EADDRINUSE' ? 'port ' + PORT + ' is already in use -- close the other window or set PORT=...' : e.message) + '\n');
  process.exit(1);
});

module.exports = server;

