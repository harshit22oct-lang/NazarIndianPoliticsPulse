/* ============================================================================
 * ha_lib.js  --  Handle Analytics ka dimaag (pure functions, koi Mongo nahi)
 * ----------------------------------------------------------------------------
 * server.js sirf master_tweets se rows laata hai aur yahan de deta hai.
 * Mongo yahan se chhua nahi jaata -- isliye ye poora module bina database ke
 * test ho sakta hai (test_ha_lib.js dekho).
 *
 * Ek tweet row wahi shakl me aati hai jo master_tweets me hai:
 *   Handle, Tweet URL, Tweet ID, Tweet Date, Tweet Text,
 *   Followers, Followings, Total Posts, Total Comments, Total Likes,
 *   Total Retweets, Total Views, Sentiment, Category, Party, State
 *
 * Tweet Date ka roop: "2026-09-25 14:05:28 IST"  (pehle 10 akshar = date)
 * ========================================================================== */
'use strict';

var SENT_KEYS = ['probjp', 'antigovt', 'progovt', 'pos', 'neu', 'antibjp', 'neg', 'none'];

function num(v) {
  var n = Number(String(v === undefined || v === null ? '' : v).replace(/,/g, '').trim());
  return isFinite(n) ? n : 0;
}

/* "2026-09-25 14:05:28 IST" -> "2026-09-25". Kuch aur mila to '' */
function dayOf(v) {
  var s = String(v || '').trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
}

/* days = 7 | 30 | 'all'. Sabse NAYE tweet se peeche ginte hain, aaj se nahi --
   warna purana data wale handle par har chart khaali dikhta. */
function cutoffDay(rows, days) {
  if (!days || days === 'all') return '';
  var n = Number(days);
  if (!n || n <= 0) return '';
  var maxDay = '';
  for (var i = 0; i < rows.length; i++) {
    var d = dayOf(rows[i]['Tweet Date']);
    if (d > maxDay) maxDay = d;
  }
  if (!maxDay) return '';
  var t = new Date(maxDay + 'T00:00:00Z').getTime() - (n - 1) * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

/* Retweet ka counts asli tweet ka hota hai -- "Top Tweet" me usse bahar rakhte
   hain, warna har baar koi RT hi top par aa jaata hai. */
function isRetweet(r) {
  return /^RT @/.test(String(r['Tweet Text'] || ''));
}

/* ---------------------------------------------------------------------------
 * daily breakdown + summary + top tweet
 * ------------------------------------------------------------------------- */
/* er-fix v2 : engagement rate.
   eng / views * 100, 2 decimal tak, aur 0..100 ke beech capped.
   100% se upar ka matlab hai engagement views se zyada -- wo ho hi nahi
   sakta, isliye wahan data galat hai; rokna hi theek hai. */
function rate(eng, views) {
  if (!(views > 0)) return null;
  var v = (eng / views) * 100;
  if (!isFinite(v) || v < 0) return null;
  if (v > 100) v = 100;
  return Math.round(v * 100) / 100;
}

/* bina cap ke asli value -- sirf batane ke liye ki data kitna bigda hua hai */
function rawRate(eng, views) {
  if (!(views > 0)) return null;
  var v = (eng / views) * 100;
  return isFinite(v) ? Math.round(v * 100) / 100 : null;
}

function analyse(rows, days) {
  rows = rows || [];
  var from = cutoffDay(rows, days);

  var byDay = {};        // date -> counts
  var folByDay = {};     // date -> aakhri dekha gaya followers/following
  var top = null, topScore = -1;
  var used = 0;

  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var d = dayOf(r['Tweet Date']);
    if (!d) continue;
    if (from && d < from) continue;
    used++;

    var m = byDay[d];
    if (!m) m = byDay[d] = { posts: 0, likes: 0, comments: 0, views: 0, shares: 0,
                             vPosts: 0, vViews: 0, vLikes: 0, vComments: 0, vShares: 0,
                             badPosts: 0, badShares: 0, badLikes: 0, badComments: 0 };
    m.posts += 1;
    m.likes += num(r['Total Likes']);
    m.comments += num(r['Total Comments']);
    m.views += num(r['Total Views']);
    m.shares += num(r['Total Retweets']);

    /* er-fix v2 : engagement rate ke liye alag jod.
       Rate = engagement / views. Agar kisi tweet ke VIEWS scrape hi nahi
       hue (0) par uske likes/shares bhare hain, to wo tweet upar to ginta
       hai neeche nahi -- aur rate 990% jaisa bekaar ho jaata hai.
       Isliye rate SIRF un tweets se banta hai jinke views maujood hain. */
    /* er-fix v3 : har tweet ki apni jaanch.
       Ek tweet ko utne hi log like/retweet kar sakte hain jitno ne use
       DEKHA ho. Isliye engagement > views wala tweet TOOTA hua data hai
       (is project me aksar 'Total Retweets' column galat bhara hota hai).
       Aise tweet rate ke hisaab se bahar, par ginti rakhte hain taaki
       dashboard saaf bata sake. */
    var _v = num(r['Total Views']);
    if (_v > 0) {
      var _e = num(r['Total Likes']) + num(r['Total Comments']) + num(r['Total Retweets']);
      if (_e <= _v) {
        m.vPosts += 1;
        m.vViews += _v;
        m.vLikes += num(r['Total Likes']);
        m.vComments += num(r['Total Comments']);
        m.vShares += num(r['Total Retweets']);
      } else {
        m.badPosts += 1;
        /* kaun sa column akela hi views se bada hai -- wahi mujrim hai */
        if (num(r['Total Retweets']) > _v) m.badShares += 1;
        if (num(r['Total Likes']) > _v) m.badLikes += 1;
        if (num(r['Total Comments']) > _v) m.badComments += 1;
      }
    }

    /* Followers us din ka -- har tweet row me scrape ke waqt ka count hota hai.
       Ek din ke kai tweets me sabse bada le lete hain (sabse naya scrape). */
    var f = num(r['Followers']), g = num(r['Followings']);
    if (f > 0 || g > 0) {
      var cur = folByDay[d];
      if (!cur) folByDay[d] = { followers: f, following: g };
      else { if (f > cur.followers) cur.followers = f; if (g > cur.following) cur.following = g; }
    }

    if (!isRetweet(r)) {
      var score = num(r['Total Likes']) + num(r['Total Comments']) + num(r['Total Retweets']);
      if (score > topScore) { topScore = score; top = r; }
    }
  }

  var dates = Object.keys(byDay).concat(Object.keys(folByDay))
    .filter(function (v, i, a) { return a.indexOf(v) === i; })
    .sort();

  /* Jis din ka apna followers-count nahi mila, us din pichhle din wala hi
     chalta rehta hai (line toot kar zero par nahi girti). */
  var runF = null, runG = null;
  var daily = dates.map(function (d) {
    if (folByDay[d]) { runF = folByDay[d].followers; runG = folByDay[d].following; }
    var m = byDay[d] || { posts: 0, likes: 0, comments: 0, views: 0, shares: 0,
                          vPosts: 0, vViews: 0, vLikes: 0, vComments: 0, vShares: 0,
                          badPosts: 0, badShares: 0, badLikes: 0, badComments: 0 };
    var eng = m.likes + m.comments + m.shares;
    /* er-fix v3 : sirf un tweets se jinka data theek hai.
       Denominator bhi wahi tweets ke views -- isliye kabhi 100% se upar
       ja hi nahi sakta, cap lagane ki zaroorat hi nahi. */
    var vEng = (m.vLikes || 0) + (m.vComments || 0) + (m.vShares || 0);
    return {
      date: d, posts: m.posts, likes: m.likes, comments: m.comments,
      views: m.views, shares: m.shares, engagement: eng,
      engagementRate: (m.vViews > 0) ? rate(vEng, m.vViews) : null,
      followers: runF, following: runG
    };
  });

  var sum = function (k) { return daily.reduce(function (a, d) { return a + d[k]; }, 0); };
  var posts = sum('posts'), likes = sum('likes'), comments = sum('comments');
  var views = sum('views'), shares = sum('shares');
  var eng = likes + comments + shares;

  /* er-fix v2 : rate ke liye sirf wahi tweets jinke views hain */
  var vSum = function (k) {
    var t = 0;
    for (var dd in byDay) t += (byDay[dd][k] || 0);
    return t;
  };
  var vPosts = vSum('vPosts'),
      vViews = vSum('vViews'),
      vEng = vSum('vLikes') + vSum('vComments') + vSum('vShares');

  /* er-fix v3 : kitne tweets ka data toota hua mila, aur kis column me */
  var badPosts = vSum('badPosts'),
      badShares = vSum('badShares'),
      badLikes = vSum('badLikes'),
      badComments = vSum('badComments');
  var withViews = vPosts + badPosts;                  // jinke views the
  /* aadhe se zyada toote hue -> rate ka koi matlab nahi */
  var erTrust = withViews > 0 && (vPosts / withViews) >= 0.5;
  var culprit = '';
  if (badShares >= badLikes && badShares >= badComments && badShares > 0) culprit = 'Shares (Total Retweets)';
  else if (badLikes >= badComments && badLikes > 0) culprit = 'Likes';
  else if (badComments > 0) culprit = 'Comments';
  var nDays = daily.length || 1;

  /* Kaun sa column database me asli me bhara hua hai -- kitni row me non-zero.
     Agar koi column khaali hai to dashboard uska "avg 0" dikhane ke bajaye
     saaf bata deta hai ki ye data scrape hi nahi hua. Isse "Avg Likes 0" jaisa
     bharam nahi hota. */
  /* avg-fix
     Pehle ye "value 0 se badi hai?" ginta tha. Ab "column bhara hua hai?"
     ginta hai -- scraper jab value nahi deta to field Mongo me aati hi
     nahi (master_to_mongo khaali value $set nahi karta), isliye
     "nahi aayi" aur "sach me 0 thi" me farak kiya ja sakta hai.
     Ye ginti hi aage aausat ka DENOMINATOR banti hai. */
  function has(v) {
    return v !== undefined && v !== null && String(v).trim() !== '';
  }
  var cov = { rows: used, likes: 0, comments: 0, views: 0, shares: 0, followers: 0 };
  var sumL = 0, sumC = 0, sumV = 0, sumS = 0;
  for (var ci = 0; ci < rows.length; ci++) {
    var rr = rows[ci];
    var dd2 = dayOf(rr['Tweet Date']);
    if (!dd2 || (from && dd2 < from)) continue;
    if (has(rr['Total Likes']))    { cov.likes++;    sumL += num(rr['Total Likes']); }
    if (has(rr['Total Comments'])) { cov.comments++; sumC += num(rr['Total Comments']); }
    if (has(rr['Total Views']))    { cov.views++;    sumV += num(rr['Total Views']); }
    if (has(rr['Total Retweets'])) { cov.shares++;   sumS += num(rr['Total Retweets']); }
    if (has(rr['Followers']))      { cov.followers++; }
  }

  /* profile ke numbers = sabse naya non-zero value */
  var followers = 0, following = 0, totalPosts = 0;
  for (var j = daily.length - 1; j >= 0; j--) {
    if (daily[j].followers) { followers = daily[j].followers; following = daily[j].following || 0; break; }
  }
  for (var k = rows.length - 1; k >= 0; k--) {
    var tp = num(rows[k]['Total Posts']);
    if (tp > totalPosts) totalPosts = tp;
  }

  return {
    daily: daily,
    summary: {
      tweets: posts,
      postsPerDay: Math.round((posts / nDays) * 10) / 10,
      /* avg-fix
         Aausat ab SIRF un tweets par jinme wo column asli me maujood hai.
         Pehle jin tweets ka data hi nahi aaya tha unhe bhi 0 maan kar
         aausat nikalta tha -- isliye adhoore data wale handle par
         "AVG LIKES 0" dikhta tha.
         Poore data wale handle (Modi, Yogi) par koi farak nahi padega.
         Column bilkul khaali ho to null -> dashboard "--" dikhata hai. */
      avgLikes:    cov.likes    ? Math.round(sumL / cov.likes)    : null,
      avgComments: cov.comments ? Math.round(sumC / cov.comments) : null,
      avgViews:    cov.views    ? Math.round(sumV / cov.views)    : null,
      avgShares:   cov.shares   ? Math.round(sumS / cov.shares)   : null,
      totalLikes: likes, totalComments: comments, totalViews: views, totalShares: shares,
      totalEngagement: eng,
      /* er-fix v2
         Engagement rate tabhi matlab rakhta hai jab VIEWS ka data ho.
         Views na hon to null -- dashboard "--" dikha deta hai.
         Jin tweets ke views nahi mile, wo rate ke hisaab se BAAHAR hain
         (warna 990% jaisa bekaar number aata hai).
         erRaw  = bina cap ke asli value (sirf batane ke liye)
         erCap  = kya 100% par roka gaya
         erRows = kitne tweets par ye rate bana (jinke views the)
         erMiss = kitne tweets ke views missing the */
      /* er-fix v3
         Rate sirf un tweets par jinka data theek hai (engagement <= views).
         Numerator aur denominator dono wahi tweets ke -- isliye 100% se
         upar ja hi nahi sakta.
         erTrust  = bharosa karne laayak hai ya nahi (aadhe se zyada theek?)
         erRows   = kitne tweets par bana
         erBad    = kitne tweets ka data toota hua mila
         erMiss   = kitne tweets ke Views hi nahi the
         erCulprit= kaun sa column galat lag raha hai */
      engagementRate: (erTrust && vViews > 0) ? rate(vEng, vViews) : null,
      erRaw: (views > 0) ? rawRate(eng, views) : null,
      erCap: false,
      erTrust: !!erTrust,
      erRows: vPosts,
      erBad: badPosts,
      erCulprit: culprit,
      erMiss: Math.max(0, posts - withViews),
      coverage: cov,
      followers: followers, following: following, totalPosts: totalPosts,
      days: daily.length, rowsUsed: used
    },
    topTweet: top ? slimTweet(top) : null
  };
}

/* bhejne ke liye chhota tweet object (poora row bhejne ka fayda nahi) */
function slimTweet(r) {
  return {
    id: String(r['Tweet ID'] || ''),
    url: String(r['Tweet URL'] || ''),
    text: String(r['Tweet Text'] || ''),
    date: String(r['Tweet Date'] || ''),
    likes: num(r['Total Likes']),
    comments: num(r['Total Comments']),
    views: num(r['Total Views']),
    shares: num(r['Total Retweets']),
    sent: String(r['Sentiment'] || '')
  };
}

/* newest-first, phir ek page */
function tweetPage(rows, offset, limit) {
  offset = Math.max(0, Number(offset) || 0);
  limit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  var sorted = (rows || []).slice().sort(function (a, b) {
    var x = String(a['Tweet Date'] || ''), y = String(b['Tweet Date'] || '');
    return x < y ? 1 : (x > y ? -1 : 0);
  });
  return {
    items: sorted.slice(offset, offset + limit).map(slimTweet),
    total: sorted.length, offset: offset, pageSize: limit
  };
}

module.exports = {
  SENT_KEYS: SENT_KEYS,
  num: num, dayOf: dayOf, cutoffDay: cutoffDay, isRetweet: isRetweet,
  analyse: analyse, tweetPage: tweetPage, slimTweet: slimTweet
};
