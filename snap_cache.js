/* ==================================================================
 *  snap_cache.js -- the last good screens, kept so a restarted server can
 *  show them at once instead of "loading..."
 *
 *  Loading every post into memory takes minutes after a restart (a deploy,
 *  or Render recycling the server). Meanwhile the page is served from these
 *  saved answers: the All-India / state snapshots, the state list and the
 *  data range. They are refreshed at most every 10 minutes per key, in
 *  MongoDB (collection snap_cache) when MONGODB_URI is set, otherwise in
 *  data/snap_cache.json. The page marks them as saved data until the fresh
 *  data is ready.
 * ================================================================== */
'use strict';
var fs = require('fs');
var path = require('path');

var GAP_MS = 10 * 60000;

function createSnapCache(dataDir) {
  var uri = process.env.MONGODB_URI || '', db = null, mem = {}, savedAt = {}, file = path.join(dataDir, 'snap_cache.json');
  async function conn() {
    if (db) return db;
    var MC = require('mongodb').MongoClient, cli = new MC(uri);
    await cli.connect();
    db = cli.db(process.env.DB_NAME || 'nazar');
    return db;
  }
  return {
    kind: uri ? 'mongo' : 'file',
    load: async function () {
      if (uri) {
        var d = await conn();
        (await d.collection('snap_cache').find({}).toArray()).forEach(function (x) { mem[x._id] = { at: x.at, v: x.v }; });
      } else {
        try { mem = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { mem = {}; }
      }
      return Object.keys(mem).length;
    },
    get: function (k) { return mem[k] || null; },
    /* keep a copy (not more often than every 10 minutes per key) */
    put: function (k, v) {
      var now = Date.now();
      if (savedAt[k] && now - savedAt[k] < GAP_MS) return;
      savedAt[k] = now; mem[k] = { at: now, v: v };
      if (uri) {
        conn().then(function (d) { return d.collection('snap_cache').updateOne({ _id: k }, { $set: { at: now, v: v } }, { upsert: true }); })
          .catch(function (e) { console.log('  [snap-cache] could not save ' + k + ': ' + e.message); });
      } else {
        try { fs.writeFileSync(file, JSON.stringify(mem)); } catch (e) {}
      }
    }
  };
}

module.exports = { createSnapCache: createSnapCache };
