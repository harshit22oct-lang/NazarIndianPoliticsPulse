// import-csv-to-mongo.js
// CSV data ko MongoDB Atlas mein import karta hai
'use strict';

var fs = require('fs');
var path = require('path');
var { MongoClient } = require('mongodb');

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

// password sirf .env se aata hai -- is file me kabhi mat likho (ye GitHub par jaati hai)
var MONGO_URI = process.env.MONGODB_URI || '';
if (!MONGO_URI) { console.error('MONGODB_URI .env me nahi mila -- .env.example dekho.'); process.exit(1); }
var DB_NAME   = process.env.DB_NAME || 'nazar';
var COLL_NAME = process.env.COLL_NAME || 'tweets';
var DATA      = path.join(__dirname, 'data');

var KEEP = ['Handle','Tweet URL','Tweet ID','Tweet Date','Tweet Text',
            'Total Comments','Total Likes','Total Retweets','Total Views',
            'Sentiment','State','Candidate Name','Category','Party'];

/* ---- same RFC-4180 CSV reader as server.js ---- */
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
          if (quoteSeen) field += '"';
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

async function main() {
  // CSV files dhundo
  var files = [];
  try { files = fs.readdirSync(DATA).filter(function(f){ return /\.csv$/i.test(f); }); } catch(e){}
  if (!files.length) {
    console.error('❌ data/ folder mein koi CSV nahi mili!');
    process.exit(1);
  }

  console.log('\n🔌 MongoDB Atlas se connect ho raha hoon...');
  var client = new MongoClient(MONGO_URI);
  await client.connect();
  console.log('✅ Connected!');

  var db   = client.db(DB_NAME);
  var coll = db.collection(COLL_NAME);

  // Purana data saaf karo
  console.log('🗑️  Purana data clear kar raha hoon...');
  await coll.deleteMany({});

  // Index banao fast queries ke liye
  await coll.createIndex({ 'Tweet Date': 1 });
  await coll.createIndex({ Handle: 1 });
  await coll.createIndex({ Party: 1 });
  await coll.createIndex({ State: 1 });
  console.log('📌 Indexes bana diye');

  var totalInserted = 0;
  var BATCH = 500; // ek baar mein 500 rows insert

  for (var k = 0; k < files.length; k++) {
    var file = path.join(DATA, files[k]);
    console.log('\n📂 File: ' + files[k]);
    var head = null, ix = null, batch = [], byId = {}, skipped = 0, n = 0;

    await readCsv(file, function(r) {
      if (!head) {
        head = r.map(function(h){ return h.trim(); });
        ix   = KEEP.map(function(h){ return head.indexOf(h); });
        return;
      }
      if (r.length < 4) return;
      var d = {};
      for (var j = 0; j < KEEP.length; j++)
        d[KEEP[j]] = ix[j] >= 0 && r[ix[j]] !== undefined ? r[ix[j]] : '';

      if (!/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/.test(d['Tweet Date']) || !d.Handle) { skipped++; return; }

      ['Total Views','Total Likes','Total Retweets','Total Comments'].forEach(function(f){
        var v = Number(d[f]); d[f] = isFinite(v) ? v : 0;
      });

      var id = d['Tweet ID'] || d['Tweet URL'] || (d.Handle + '|' + d['Tweet Date']);
      if (byId[id]) return; // duplicate skip
      byId[id] = 1;
      d._id = id;
      batch.push(d);
      n++;
    });

    // Batch mein insert karo
    console.log('  ' + n.toLocaleString('en-IN') + ' rows padhein, insert ho rahe hain...');
    var inserted = 0;
    for (var i = 0; i < batch.length; i += BATCH) {
      var chunk = batch.slice(i, i + BATCH);
      try {
        await coll.insertMany(chunk, { ordered: false });
      } catch(e) {
        // duplicate key errors ignore karo
      }
      inserted += chunk.length;
      process.stdout.write('\r  Insert progress: ' + inserted.toLocaleString('en-IN') + '/' + n.toLocaleString('en-IN'));
    }
    totalInserted += inserted;
    console.log('\n  ✅ Done! Skipped: ' + skipped);
  }

  console.log('\n🎉 IMPORT COMPLETE!');
  console.log('   Total documents: ' + totalInserted.toLocaleString('en-IN'));
  console.log('   Database: ' + DB_NAME + ' | Collection: ' + COLL_NAME);
  await client.close();
  console.log('\n✅ Connection closed. Ab server.js update karo!\n');
}

main().catch(function(e){ console.error('❌ Error:', e.message); process.exit(1); });
