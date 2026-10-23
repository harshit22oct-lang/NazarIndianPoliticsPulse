/*  fetch-photos.js  --  one-time / occasional download of leaders' X profile photos
 *
 *  Nazar never scrapes X while it runs: photos are files in app/live_assets/avatars
 *  (listed in app/live_assets/avatars_index.json) that the server just serves.
 *  This script fills that folder for every leader who posts in the CSV files in
 *  ./data (media houses / journalists left out), most-viewed leaders first.
 *
 *  Source: the public fxtwitter API (no X login, no account at risk).
 *  Size: 200x200 (enough for every place a face appears; keeps the repo small).
 *
 *      node fetch-photos.js            all leaders in the data that have no photo yet
 *      node fetch-photos.js --top 500  only the 500 most-viewed of them
 *
 *  Safe to stop (Ctrl+C) and re-run: existing photos are skipped, an account that
 *  failed is tried again after 7 days. Then commit app/live_assets and push, so
 *  Render gets the photos too.
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, 'app', 'live_assets');
var AV_DIR = path.join(ROOT, 'avatars');
var INDEX = path.join(ROOT, 'avatars_index.json');
var DATA = path.join(__dirname, 'data');
var DELAY_MS = 1500, RETRY_FAIL_MS = 7 * 86400000;
var ti = process.argv.indexOf('--top'), TOP = ti > 0 ? parseInt(process.argv[ti + 1], 10) || 0 : 0;
var FORCE = process.argv.indexOf('--force') > 0;

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function loadIndex() { try { return JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch (e) { return { avatars: {}, parties: {} }; } }
function saveIndex(ix) { fs.writeFileSync(INDEX + '.tmp', JSON.stringify(ix, null, 1)); fs.renameSync(INDEX + '.tmp', INDEX); }

/* same RFC-4180 reader as server.js */
function readCsv(file, onRow) {
  return new Promise(function (resolve, reject) {
    var field = '', row = [], inQ = false, quoteSeen = false, first = true;
    var st = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 });
    st.on('data', function (chunk) {
      var i = 0, n = chunk.length;
      if (first) { first = false; if (chunk.charCodeAt(0) === 0xFEFF) i = 1; }
      for (; i < n; i++) {
        var c = chunk[i];
        if (inQ) { if (c === '"') { inQ = false; quoteSeen = true; } else field += c; }
        else if (c === '"') { if (quoteSeen) field += '"'; inQ = true; quoteSeen = false; }
        else if (c === ',') { row.push(field); field = ''; quoteSeen = false; }
        else if (c === '\n') { row.push(field); field = ''; quoteSeen = false; onRow(row); row = []; }
        else if (c !== '\r') { field += c; quoteSeen = false; }
      }
    });
    st.on('end', function () { if (field !== '' || row.length) { row.push(field); onRow(row); } resolve(); });
    st.on('error', reject);
  });
}

/* leaders in the data, most-viewed first */
async function leaders() {
  var files = fs.readdirSync(DATA).filter(function (f) { return /\.csv$/i.test(f); }), views = {}, handle = {};
  for (var k = 0; k < files.length; k++) {
    var head = null, H, CAT, NAME, VIEWS;
    await readCsv(path.join(DATA, files[k]), function (r) {
      if (!head) { head = r.map(function (h) { return h.trim(); }); H = head.indexOf('Handle'); CAT = head.indexOf('Category'); NAME = head.indexOf('Candidate Name'); VIEWS = head.indexOf('Total Views'); return; }
      if (r.length < 4) return;
      if (/^(Media House|Journalist)$/.test(String(r[CAT] || '').trim())) return;
      var nm = String(r[NAME] || '').trim(); if (!nm || /^nan$/i.test(nm)) return;
      var h = String(r[H] || '').trim(); if (!h) return;
      var key = h.toLowerCase(); handle[key] = h; views[key] = (views[key] || 0) + (Number(r[VIEWS]) || 0) + 1;
    });
  }
  /* also include all remaining political leaders from handle_master.json */
  try {
    var hmPath = path.join(__dirname, 'app', 'data', 'handle_master.json');
    if (fs.existsSync(hmPath)) {
      var hm = JSON.parse(fs.readFileSync(hmPath, 'utf8'));
      Object.keys(hm).forEach(function (h) {
        var key = h.toLowerCase();
        if (!handle[key]) {
          handle[key] = h;
          views[key] = 0;
        }
      });
    }
  } catch (e) {}
  return Object.keys(views).sort(function (a, b) { return views[b] - views[a]; }).map(function (k) { return handle[k]; });
}

var GQL_URL = 'https://x.com/i/api/graphql/Yka-W8dz7RaEuQNkroPkYw/UserByScreenName';
var BEARER = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

function xCookies() {
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
        if (a && c && !/^PASTE/i.test(a) && !/^PASTE/i.test(c)) {
          return { cookie: 'auth_token=' + a + '; ct0=' + c + (t && !/^PASTE/i.test(t) ? '; twid=' + t : '') + '; lang=en', ct0: c };
        }
      }
    } catch (e) {}
  }
  return null;
}

async function profilePhotoX(handle, ck) {
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
    signal: AbortSignal.timeout(15000)
  });
  if (r.status === 429) return { rate: true };
  if (r.status === 401 || r.status === 403) return { auth: true };
  if (!r.ok) return { err: 'X HTTP ' + r.status };
  var j = await r.json();
  var leg = j && j.data && j.data.user && j.data.user.result && j.data.user.result.legacy;
  var url = leg && leg.profile_image_url_https;
  if (!url || /default_profile/.test(url)) return { err: 'no photo' };
  return { url: url.replace(/_(normal|bigger|400x400)\./, '_200x200.'), name: leg.name || '', via: 'x' };
}

async function profilePhoto(h, ck) {
  if (ck) {
    try {
      var px = await profilePhotoX(h, ck);
      if (!px.err && !px.rate && !px.auth) return px;
      if (px.rate) return px;
      if (px.auth) console.log('  ⚠️ X cookie refused, using bridge fallback');
    } catch (e) {}
  }
  var r = await fetch('https://api.fxtwitter.com/' + encodeURIComponent(h), { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
  if (r.status === 429) return { rate: true };
  if (!r.ok) return { err: 'HTTP ' + r.status };
  var j = await r.json(), u = j && j.user, url = u && (u.avatar_url || u.profile_image_url_https);
  if (!url || /default_profile/.test(url)) return { err: 'no photo' };
  return { url: url.replace(/_(normal|bigger|400x400)\./, '_200x200.'), name: u.name || '', via: 'bridge' };
}

async function download(url, file) {
  var r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('image HTTP ' + r.status);
  var b = Buffer.from(await r.arrayBuffer());
  if (b.length < 500) throw new Error('image too small');
  fs.writeFileSync(file, b); return b.length;
}

async function main() {
  fs.mkdirSync(AV_DIR, { recursive: true });
  var ix = loadIndex(); ix.avatars = ix.avatars || {};
  var ck = xCookies();
  console.log(ck ? '  [X Live Scraper] Active with x_config.json cookies (direct X GraphQL)' : '  [Bridge] Using public API');
  var all = await leaders(), todo = all.filter(function (h) {
    var k = h.toLowerCase(), e = ix.avatars[k];
    if (!FORCE && e && e.file && fs.existsSync(path.join(ROOT, e.file))) return false;
    /* "no photo" waits 7 days; an HTTP error from the API is usually a passing hiccup: always retried */
    if (!FORCE && e && e.fail && !/^HTTP |timeout|aborted|fetch failed/i.test(e.fail) && Date.now() - e.at < RETRY_FAIL_MS) return false;
    return true;
  });
  if (TOP) todo = todo.slice(0, TOP);
  console.log('Leaders in the data: ' + all.length + ' | photos to fetch now: ' + todo.length + ' (about ' + Math.ceil(todo.length * 1.8 / 60) + ' min)');
  var ok = 0, fail = 0, rate = 0, stopped = false;
  /* one pass over a list; returns the accounts the API refused with an HTTP error */
  async function run(list, label) {
    var again = [];
    for (var i = 0; i < list.length && !stopped; i++) {
      var h = list[i], k = h.toLowerCase(), file = path.join(AV_DIR, k + '.jpg');
      try {
        var p = await profilePhoto(h, ck);
        if (p.err && /^HTTP /.test(p.err)) { await sleep(2000); p = await profilePhoto(h, ck); }
        if (p.rate) {
          rate++; console.log('  busy (rate limit) -- waiting 60 s');
          if (rate >= 5) { console.log('  stopped after 5 rate limits. Run again later; nothing is lost.'); stopped = true; break; }
          await sleep(60000); i--; continue;
        }
        if (p.err) { fail++; ix.avatars[k] = { fail: p.err, at: Date.now(), handle: h }; if (/^HTTP /.test(p.err)) again.push(h); }
        else { await download(p.url, file); ix.avatars[k] = { file: 'avatars/' + k + '.jpg', handle: h, name: p.name, at: Date.now(), via: p.via || 'x' }; ok++; }
      } catch (e) { fail++; ix.avatars[k] = { fail: e.message, at: Date.now(), handle: h }; again.push(h); }
      if ((i + 1) % 20 === 0) { saveIndex(ix); console.log('  ' + label + (i + 1) + '/' + list.length + ' -- ' + ok + ' photos, ' + fail + ' without'); }
      await sleep(DELAY_MS);
    }
    saveIndex(ix);
    return again;
  }
  var again = await run(todo, '');
  /* second pass: the accounts the API refused the first time, after a pause */
  if (again.length && !stopped) {
    console.log('  second try for ' + again.length + ' accounts in 60 s...'); await sleep(60000);
    fail -= again.length; await run(again, 'second try ');
  }
  console.log('Done: ' + ok + ' photos downloaded, ' + fail + ' accounts without a photo.');
}
main().catch(function (e) { console.log('ERROR ' + e.message); process.exit(1); });
