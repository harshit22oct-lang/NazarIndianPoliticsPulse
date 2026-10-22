/* ===========================================================================
   mapping_lib.js  --  handle_master.json padhta hai aur usse master_tweets ke
   attribute columns banata hai.

   ASLI MASTER: Mapping/Mapping.xlsx
     rebuild_mapping.py --apply  usse DASHBOARD aur UP-DASHBOARD dono ke
     data/handle_master.json banata hai, aur saaf likha hai:
     "Purani mapping ka koi data nahi uthaya jaata."
     Iska matlab -- sirf handle_master.json me likhna BEKAAR hai, agli
     rebuild par ud jaayega. Isliye naya handle Excel me jaata hai aur phir
     rebuild chalta hai (mapping_add.py dekho).

   Ye file sirf PADHTI hai. Likhne ka kaam Python ke paas hai, kyunki
   Mapping.xlsx aur rebuild dono wahan pehle se hain -- unhe JS me dobara
   likhna do jagah do niyam ban jaata.
   =========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const MAP_FILE = path.join(__dirname, 'data', 'handle_master.json');

/* master_tweets ka column  <->  mapping ki key.
   Ye hu-ba-hu phase2_push.py ke FILL se liya hai -- tracker ka row aur
   pipeline ka row bilkul ek jaisa dikhna chahiye. */
const FILL = [
  ['State',          'state'],
  ['Locations',      'locations'],
  ['AC/PC No',       'ac_pc_no'],
  ['AC Name',        'ac_name'],
  ['PC Name',        'pc_name'],
  ['Candidate Name', 'name'],
  ['Category',       'category'],
  ['Party',          'party'],
  ['Status',         'status'],
  /* nayi Mapping ke column. Gender aur Admin Designation abhi Excel me
     khaali hain -- columnsFor() khaali/'-' value chhodti hai, isliye ye
     abhi kuch nahi likhte. Excel bharte hi apne aap chalne lagenge. */
  ['Gender',             'gender'],
  ['Party Designation',  'party_designation'],
  ['Admin Designation',  'admin_designation']
];

/* panel ke form me jo 10 column dikhte hain (user ki list) */
const FORM_COLS = ['State', 'Locations', 'AC/PC No', 'AC Name', 'PC Name',
  'Designation', 'Candidate Name', 'Category', 'Categories', 'Party'];

/* Mapping.xlsx me sach me jo column hain -- form bharne par yahi jaate hain.
   'Locations' aur 'Categories' Excel me hain hi nahi: locations hamesha '-'
   hota hai (4,422/4,422) aur categories handle ki saari Excel rows ke
   Category se khud banta hai. Isliye wo do bharne ki cheez nahi, bante hain. */
const XLSX_COLS = ['State', 'AC/PC No', 'AC Name', 'PC Name', 'Candidate Name',
  'Designation', 'Category', 'Party', 'Twitter Account'];

/* dash-ok : form me sirf ye do sach me zaroori hain. Baaki har column me
   '-' bilkul theek hai -- handle_master.json ke asli aankde:
       Candidate Name  4422/4422 bhare   <- isliye zaroori
       Category        4422/4422 bhare   <- isliye zaroori
       State            156 handle '-'   (saare 40 Media House + 26 Journalist)
       Party             69 handle '-'
       Designation       83 handle '-'
       AC Name         1080 handle '-'   |  PC Name 3825 handle '-'
   Official page / media house ka na koi State hota hai, na seat, na party.
   Pehle State/Party/Designation bhi zaroori the, jिससे @PMOIndia jaisa
   handle kabhi save ho hi nahi sakta tha. */
const REQUIRED = ['Candidate Name', 'Category'];

const BLANK = ['', '-', '—', 'nan', 'none', 'null', '(blank)'];
function real(v) {
  const s = String(v === null || v === undefined ? '' : v).trim();
  return BLANK.indexOf(s.toLowerCase()) >= 0 ? '' : s;
}

/* ---------------- load (mtime par cache) ---------------- */
let _cache = null, _mtime = 0, _ci = null, _err = '';

function load(force) {
  let st = null;
  try { st = fs.statSync(MAP_FILE); }
  catch (e) { _err = 'handle_master.json nahi mila: ' + MAP_FILE; _cache = _cache || {}; return _cache; }
  if (!force && _cache && st.mtimeMs === _mtime) return _cache;
  try {
    const j = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'));
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('shakl galat hai');
    _cache = j; _mtime = st.mtimeMs; _err = '';
    /* case-insensitive index -- X par @Modi aur @modi ek hi account hai,
       par Excel/Mongo me case alag-alag pada hota hai. */
    _ci = {};
    Object.keys(j).forEach(function (k) { _ci[k.toLowerCase()] = k; });
  } catch (e) {
    /* Toota hua JSON par PURANI mapping pakde rehte hain. Khaali kar dena
       sabse bura hota: har handle "unmapped" ban jaata aur saara data
       staging me chala jaata. */
    _err = 'handle_master.json padha nahi gaya: ' + String(e.message || e);
    if (!_cache) { _cache = {}; _ci = {}; }
  }
  return _cache;
}

function lookup(handle) {
  const mp = load();
  const h = String(handle || '').trim().replace(/^@+/, '');
  if (!h) return null;
  if (Object.prototype.hasOwnProperty.call(mp, h)) return mp[h];
  const k = _ci && _ci[h.toLowerCase()];
  return k ? mp[k] : null;
}

function has(handle) { return !!lookup(handle); }

/* mapping entry -> master_tweets ke attribute columns.
   Sirf ASLI value lautate hain: '-' / khaali par column chhodte hi nahi,
   warna $set purana sahi value mita deta (yahi galti pehle AC/PC No ud
   jaane ki wajah thi -- push_mapping_to_mongo.py me likha hai). */
function columnsFor(handle) {
  const e = lookup(handle);
  if (!e) return null;
  const out = {};
  FILL.forEach(function (p) {
    const v = real(e[p[1]]);
    if (v) out[p[0]] = v;
  });
  /* Designation: phase2_push.desig_for() -- designations[0], warna raw */
  const ds = Array.isArray(e.designations) ? e.designations.filter(Boolean) : [];
  const dg = real(ds.length ? ds[0] : e.designation_raw);
  if (dg) out['Designation'] = dg;
  /* Categories Mongo me ARRAY hai (master_to_mongo.py), string nahi */
  let cl = Array.isArray(e.categories) ? e.categories : (e.category ? [e.category] : []);
  cl = cl.map(real).filter(Boolean);
  if (cl.length) out['Categories'] = cl.slice().sort();
  return out;
}

/* form/CSV ki ek row dekho -- kya kami hai */
function validateRow(row) {
  const miss = [];
  REQUIRED.forEach(function (c) { if (!real(row[c])) miss.push(c); });
  return miss;
}

function stats() {
  const mp = load();
  return { file: MAP_FILE, handles: Object.keys(mp).length, error: _err,
           loadedAt: _mtime ? new Date(_mtime).toISOString() : null };
}

function _reset() { _cache = null; _mtime = 0; _ci = null; _err = ''; }

/* ---------------- CSV ----------------
   Chhota par poora parser: quote ke andar comma aur newline dono chalte
   hain, "" ka matlab ek quote. Candidate Name me comma aam baat hai,
   isliye seedha split(',') yahan kaam nahi karta. */
function parseCsv(text) {
  const s = String(text || '').replace(/^\uFEFF/, '');   /* Excel ka BOM */
  const rows = [];
  let row = [], cell = '', q = false, i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (q) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i += 2; continue; }
        q = false; i++; continue;
      }
      cell += ch; i++; continue;
    }
    if (ch === '"') { q = true; i++; continue; }
    if (ch === ',') { row.push(cell); cell = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; continue; }
    cell += ch; i++;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  /* poori tarah khaali line hata do */
  return rows.filter(function (r) { return r.some(function (x) { return String(x).trim() !== ''; }); });
}

/* CSV -> [{header: value}] ; header ka bada-chhota aur extra space maaf */
function csvObjects(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { rows: [], headers: [] };
  const headers = rows[0].map(function (h) { return String(h).trim(); });
  const key = {};
  headers.forEach(function (h, i) { key[h.toLowerCase().replace(/\s+/g, ' ')] = i; });
  const out = rows.slice(1).map(function (r) {
    const o = {};
    headers.forEach(function (h, i) { o[h] = r[i] === undefined ? '' : String(r[i]).trim(); });
    o.__get = function (name) {
      const i = key[String(name).toLowerCase().replace(/\s+/g, ' ')];
      return i === undefined ? '' : String(r[i] === undefined ? '' : r[i]).trim();
    };
    return o;
  });
  return { rows: out, headers: headers };
}

function csvCell(v) {
  let t = (v === null || v === undefined) ? '' : String(v);
  if (/^[=+\-@]/.test(t)) t = "'" + t;          /* Excel formula na ban jaaye */
  return '"' + t.replace(/"/g, '""').replace(/[\r\n]+/g, ' ') + '"';
}

module.exports = {
  load, lookup, has, columnsFor, validateRow, stats, real, _reset,
  parseCsv, csvObjects, csvCell,
  MAP_FILE, FILL, FORM_COLS, XLSX_COLS, REQUIRED
};
