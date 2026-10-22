/* ===========================================================================
 *  news_lib.js  --  BREAKING NEWS ka poora dimaag.
 *  ---------------------------------------------------------------------------
 *  SOURCE: koi bahar ka news API NAHI. Sirf wahi data jo pehle se scrape hokar
 *  MongoDB me pada hai -- pulse_master.master_tweets me se wo tweets jinka
 *  Category 'Media House' ya 'Journalist' hai (~3.25 lakh tweets).
 *
 *  Ye tweets dashboard ke charts/KPI me jaan-boojh kar nahi ginte (EXCLUDE_CAT),
 *  isliye ab tak inka koi upyog nahi tha. News feed ke liye yahi sabse sahi
 *  source hai -- news channel aur patrakaar apni khabar wahin post karte hain.
 *
 *  KUCH BANAYA NAHI JAATA:
 *    - headline    = tweet ka apna text (pehla vaakya)
 *    - source      = handle ka apna naam
 *    - time        = tweet ki apni date
 *    - metrics     = tweet ke apne views/likes/retweets
 *    - category    = tweet ke text me maujood shabdon se (na mile to 'Other')
 *    - state       = handle ka apna State, warna text me aaye jagah ke naam se
 *    - BREAKING    = us window ki asli engagement + freshness se (neeche dekho)
 *  Kahin bhi koi mock/manual/fake khabar nahi hai.
 * =========================================================================== */
'use strict';

const MEDIA_CATS = ['Media House', 'Journalist'];

/* ---------------------------------------------------------------- category */
/* Har category ke apne shabd. Pehla match jeetta hai (upar wale zyada khaas).
   Kisi se match na ho to 'Other' -- zabardasti kisi khaane me nahi daalte. */
const CAT_RULES = [
  ['Elections', /\b(election|elections|poll|polls|voting|voter|byelection|by-election|nomination|candidate list|manifesto|ballot|counting|constituency)\b|चुनाव|मतदान|मतदाता|प्रत्याशी|घोषणापत्र|उपचुनाव/i],
  ['Crime', /\b(murder|killed|rape|assault|arrest|arrested|loot|robbery|theft|kidnap|abduct|shot dead|firing|encounter|accused|fir lodged|molest)\b|हत्या|रेप|दुष्कर्म|गिरफ्तार|लूट|चोरी|अपहरण|मुठभेड़|फायरिंग/i],
  ['Law & Order', /\b(court|high court|supreme court|verdict|judge|bail|petition|fir|police|sho|dgp|curfew|section 144|custody|chargesheet|summons)\b|अदालत|हाईकोर्ट|सुप्रीम कोर्ट|फैसला|जमानत|याचिका|पुलिस|हिरासत/i],
  ['Weather', /\b(rain|rainfall|monsoon|flood|heatwave|cyclone|storm|cold wave|imd|temperature|waterlogging|drought)\b|बारिश|मानसून|बाढ़|तूफान|शीतलहर|गर्मी|जलभराव|सूखा/i],
  ['Health', /\b(hospital|covid|dengue|virus|vaccine|patient|doctors|aiims|health department|outbreak|epidemic|medicine)\b|अस्पताल|कोरोना|डेंगू|टीका|मरीज|स्वास्थ्य|महामारी/i],
  ['Education', /\b(school|college|university|exam|result|neet|upsc|jee|board exam|student|admission|scholarship|teacher recruitment)\b|स्कूल|कॉलेज|विश्वविद्यालय|परीक्षा|रिजल्ट|छात्र|शिक्षक|दाखिला/i],
  ['Economy', /\b(gdp|inflation|rbi|repo rate|budget|tax|gst|rupee|fiscal|subsidy|msp|unemployment|price hike)\b|महंगाई|बजट|जीएसटी|रुपया|कर|सब्सिडी|बेरोजगारी/i],
  ['Business', /\b(company|startup|investment|investor|ipo|shares|stock|market cap|crore deal|mou|factory|plant|industry|adani|ambani|tata|reliance)\b|कंपनी|निवेश|शेयर|कारोबार|उद्योग|फैक्ट्री/i],
  ['Sports', /\b(cricket|match|wicket|goal|olympic|world cup|ipl|hockey|kabaddi|medal|tournament|innings|bcci)\b|क्रिकेट|मैच|विकेट|ओलंपिक|पदक|टूर्नामेंट/i],
  ['International', /\b(pakistan|china|usa|america|russia|ukraine|israel|un |united nations|bilateral|visa|embassy|foreign minister|border tension)\b|पाकिस्तान|चीन|अमेरिका|रूस|यूक्रेन|इजरायल|विदेश मंत्री/i],
  ['Government', /\b(government|cabinet|minister|ministry|scheme|yojana|policy|bill passed|ordinance|budget allocation|cm |chief minister|governor|secretariat|administration)\b|सरकार|कैबिनेट|मंत्री|मंत्रालय|योजना|नीति|मुख्यमंत्री|राज्यपाल|प्रशासन/i],
  ['Politics', /\b(bjp|congress|inc|sp |samajwadi|bsp|aap|akali|rjd|tmc|dmk|opposition|alliance|party|mla|mp |rally|protest|resign|joins party)\b|भाजपा|कांग्रेस|सपा|बसपा|विपक्ष|गठबंधन|रैली|प्रदर्शन|इस्तीफा/i]
];

const CATEGORIES = ['All', 'Politics', 'Government', 'Crime', 'Law & Order', 'Elections',
  'Economy', 'Business', 'Education', 'Health', 'Weather', 'Sports', 'International', 'Other'];

function categorise(text) {
  var t = String(text || '');
  for (var i = 0; i < CAT_RULES.length; i++) {
    if (CAT_RULES[i][1].test(t)) return CAT_RULES[i][0];
  }
  return 'Other';
}

/* ------------------------------------------------------------------- scope */
/* Media house / journalist handles ka State column aam taur par KHAALI hota
   hai (wo kisi ek state ke nahi hote). Isliye state ka pata do jagah se:
     1. handle ka apna State -- agar bhara hua hai (kai regional channel ka hai)
     2. warna tweet ke text me aaye jagah/naam
   Dono me kuch na mile -> 'national'. Yahi imaandaar jawab hai.               */
const UP_HINT = new RegExp([
  'uttar pradesh', 'lucknow', 'kanpur', 'varanasi', 'prayagraj', 'allahabad',
  'agra', 'meerut', 'ghaziabad', 'noida', 'gorakhpur', 'bareilly', 'aligarh', 'moradabad',
  'saharanpur', 'jhansi', 'ayodhya', 'mathura', 'firozabad', 'muzaffarnagar', 'rampur',
  'azamgarh', 'ballia', 'jaunpur', 'sultanpur', 'amethi', 'rae bareli', 'raebareli',
  'yogi adityanath', 'akhilesh yadav', 'mayawati', 'keshav prasad maurya', 'brajesh pathak',
  'उत्तर प्रदेश', 'लखनऊ', 'कानपुर', 'वाराणसी', 'प्रयागराज', 'आगरा', 'मेरठ', 'गाजियाबाद',
  'नोएडा', 'गोरखपुर', 'अयोध्या', 'मथुरा', 'योगी', 'अखिलेश', 'मायावती'
].join('|'), 'i');

const PB_HINT = new RegExp([
  '\\bpunjab\\b', 'chandigarh', 'amritsar', 'ludhiana', 'jalandhar', 'patiala',
  'bathinda', 'mohali', 'pathankot', 'hoshiarpur', 'moga', 'firozpur', 'ferozepur',
  'gurdaspur', 'kapurthala', 'sangrur', 'barnala', 'faridkot', 'muktsar', 'ropar',
  'fatehgarh sahib', 'tarn taran', 'khanna', 'phagwara', 'zirakpur',
  'bhagwant mann', 'sukhbir badal', 'charanjit channi', 'navjot sidhu', 'harpal cheema',
  'akali dal', 'sgpc', 'golden temple',
  'पंजाब', 'चंडीगढ़', 'अमृतसर', 'लुधियाना', 'जालंधर', 'पटियाला', 'भगवंत मान'
].join('|'), 'i');

/* 'UP' / 'PB' sirf BADE akshar me hi state ka short naam hote hain.
   Chhote me "up" ek aam angrezi shabd hai -- "business is up sharply" ko
   Uttar Pradesh maan lena bilkul galat hoga (aur ek baar hua bhi tha). */
const UP_ABBR = /\bU\.?P\.?\b/;      // jaan-boojh kar bina /i
const PB_ABBR = /\bPB\b/;

function scopeOf(stateCol, text) {
  var st = String(stateCol || '').trim().toLowerCase();
  /* 1) State column bhara hai to WAHI sach hai -- text ka andaza uspar
        haavi nahi hona chahiye. (Gujarat ki khabar Gujarat ki hai, chahe
        usme Lucknow ka zikr ho.) */
  if (st) {
    if (st === 'uttar pradesh' || st === 'up') return 'up';
    if (st === 'punjab' || st === 'pb') return 'punjab';
    return 'other';
  }
  /* 2) State khaali (media house / journalist ka aam mamla) -> text se */
  var t = String(text || '');
  if (UP_HINT.test(t) || UP_ABBR.test(t)) return 'up';
  if (PB_HINT.test(t) || PB_ABBR.test(t)) return 'punjab';
  return 'national';
}

/* ------------------------------------------------------------------ shakl */
/* Tweet ka text -> headline + summary. Kuch likha nahi jaata, sirf kaata jaata:
   pehla vaakya headline, baaki summary. URL/hashtag ka kachra hata dete hain. */
function clean(t) {
  return String(t || '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function split(text) {
  var t = clean(text);
  if (!t) return { head: '', sum: '' };
  var m = t.match(/^(.{20,150}?)([.!?।]|\s[-–—|]\s)\s+/);
  var head = m ? m[1].trim() : t.slice(0, 130).trim();
  var sum = t.slice(head.length).replace(/^[\s.!?।\-–—|]+/, '').trim();
  if (!sum && t.length > head.length) sum = t.slice(head.length).trim();
  return { head: head, sum: sum.slice(0, 260) };
}

/* Ek hi khabar kai channel deti hain. Duplicate tabhi maante hain jab
   USI DIN ki ho aur shuruaat ke 8 shabd hu-ba-hu ek jaise hon.
   Din shaamil karna zaroori hai -- warna roz aane wali ek jaisi shuruaat
   ("Chief Minister said that...") alag-alag din ki alag khabrein bhi ek
   maan li jaati hain. Aur bahut chhoti shuruaat par dedupe nahi karte. */
function dupKey(head, day) {
  var w = clean(head).toLowerCase().replace(/[^a-z0-9ऀ-ॿ ]+/g, '')
    .split(' ').filter(Boolean).slice(0, 8).join(' ');
  return w.length >= 25 ? (String(day || '').slice(0, 10) + '|' + w) : '';
}

/* --------------------------------------------------------------- BREAKING */
/* "BREAKING" hum apne man se nahi lagate. Do shart, dono is window ke ASLI
   numbers se:
     1. TAAZA  -- data me jo sabse nayi khabar hai, uske 24 ghante ke andar ki ho
     2. TEZ    -- engagement (like+RT+comment) is window ke 90th percentile se upar
   Data purana ho to shart 1 apne aap fail ho jaati hai aur koi badge nahi lagta --
   yahi sahi hai, warna 3 din purani khabar par "BREAKING" jhooth hoga.         */
function pct(sorted, p) {
  if (!sorted.length) return 0;
  var i = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[i];
}

function score(rows) {
  var engs = rows.map(function (r) { return r.eng; }).sort(function (a, b) { return a - b; });
  var p90 = pct(engs, 0.90);
  var newest = rows.reduce(function (m, r) { return r.ts > m ? r.ts : m; }, 0);
  var cut = newest - 24 * 3600 * 1000;
  rows.forEach(function (r) {
    r.breaking = (r.ts >= cut) && (r.eng >= p90) && p90 > 0;
    // "relevance" = engagement, par taaza cheez ko halka sa upar (24h me 1.0 -> 0)
    var ageH = Math.max(0, (newest - r.ts) / 3600000);
    r.rel = r.eng * (1 + Math.max(0, 1 - ageH / 168));   // 7 din me asar khatam
  });
  return { p90: p90, newest: newest };
}

/* ------------------------------------------------------------------ build */
/* rows: Mongo se aaye kachche documents. Yahan se saaf news items bante hain. */
function toItems(docs) {
  var out = [];
  for (var i = 0; i < docs.length; i++) {
    var d = docs[i];
    var txt = d['Tweet Text'] || '';
    var s = split(txt);
    if (!s.head || s.head.length < 15) continue;      // itna chhota text khabar nahi hai
    var dt = String(d['Tweet Date'] || '');
    var ts = Date.parse(dt.replace(' ', 'T')) || Date.parse(dt.slice(0, 10)) || 0;
    var lk = +d['Total Likes'] || 0, rt = +d['Total Retweets'] || 0, cm = +d['Total Comments'] || 0;
    out.push({
      id: String(d._id || ''),
      head: s.head,
      sum: s.sum,
      src: (d['Candidate Name'] || d.Handle || '').trim(),
      h: d.Handle || '',
      kind: d.Category || '',                         // Media House / Journalist
      date: dt.slice(0, 19),
      ts: ts,
      cat: categorise(txt),
      scope: scopeOf(d.State, txt),
      st: (d.State || '').trim(),
      vw: +d['Total Views'] || 0, lk: lk, rt: rt, cm: cm,
      eng: lk + rt + cm,
      sn: d.Sentiment || '',
      url: d['Tweet URL'] || ''
    });
  }
  return out;
}

/* scope ke hisaab se chhaanto.
   UP/Punjab: pehle us state ki khabar, phir national (spec: "important national
   news bhi dikhao"). Kisi DUSRE state ki khabar UP/Punjab me nahi aati. */
function forScope(items, scope) {
  if (scope === 'up' || scope === 'punjab') {
    var mine = items.filter(function (r) { return r.scope === scope; });
    var nat = items.filter(function (r) { return r.scope === 'national'; });
    mine.forEach(function (r) { r.local = true; });
    nat.forEach(function (r) { r.local = false; });
    return { rows: mine.concat(nat), local: mine.length, national: nat.length };
  }
  // All India: sab kuch, par doosre state ki khabar bhi chalegi
  items.forEach(function (r) { r.local = (r.scope !== 'national'); });
  return { rows: items, local: items.length, national: 0 };
}

function dedupe(rows) {
  var seen = new Set(), out = [];
  for (var i = 0; i < rows.length; i++) {
    var k = dupKey(rows[i].head, rows[i].date);
    if (k && seen.has(k)) continue;
    if (k) seen.add(k);
    out.push(rows[i]);
  }
  return out;
}

function sortRows(rows, how) {
  if (how === 'breaking') {
    return rows.sort(function (a, b) {
      if (a.breaking !== b.breaking) return a.breaking ? -1 : 1;
      return b.ts - a.ts || b.eng - a.eng;
    });
  }
  if (how === 'relevant') {
    return rows.sort(function (a, b) { return b.rel - a.rel; });
  }
  return rows.sort(function (a, b) { return b.ts - a.ts || b.eng - a.eng; });   // latest
}

module.exports = {
  MEDIA_CATS: MEDIA_CATS,
  CATEGORIES: CATEGORIES,
  categorise: categorise,
  scopeOf: scopeOf,
  split: split,
  toItems: toItems,
  forScope: forScope,
  dedupe: dedupe,
  score: score,
  sortRows: sortRows
};
