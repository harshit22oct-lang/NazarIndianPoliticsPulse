/* ==================================================================
 *  media_ai.js -- the Media Room's AI step (free tier only)
 *
 *  For each political headline of the last 24 hours, once, the model says:
 *    t   who is judged: b = BJP / NDA / its governments or leaders, o = the opposition,
 *        g = another institution, x = nobody
 *    p   how: - criticism, + praise, 0 neutral
 *    v   whose voice: o = opposition party or leader, m = the outlet's own report,
 *        g = BJP or a government, x = someone else
 *  and from t + p this file sets the stance toward BJP, s: a (against: BJP judged, -),
 *  f (for: BJP judged, +), n (anything else); b = v.
 *    o   1 if it is about the opposition's own alliance / seat-sharing / disputes
 *    k   3-6 English words naming the event (the same words for the same event in
 *        Hindi or English -- that is how a Hindi and an English story become one card)
 *
 *  Staying free (Groq free tier, openai/gpt-oss-20b: 1,000 requests and 200K tokens
 *  a day, 8K tokens a minute -- the Attacks engine uses the same model as a reserve):
 *    * only headlines that already carry a topic, newest first, one per story
 *    * 20 headlines per request, at most one request a minute
 *    * a daily cap of its own (MEDIA_AI_DAY_TOKENS, default 60K) counted in IST days and
 *      saved, so a restart does not reset it; a 429 stops it until the next IST day
 *    * a label is kept with the headline and never asked again
 *  Nothing is invented: with no key, or once the cap is reached, the AI screens simply
 *  stay as they are and the keyword screens go on.
 * ================================================================== */
'use strict';
var GROQ = 'https://api.groq.com/openai/v1/chat/completions';
var MODEL = process.env.MEDIA_AI_MODEL || 'openai/gpt-oss-20b';
var DAY_TOKENS = Number(process.env.MEDIA_AI_DAY_TOKENS) || 60000;
var DAY_CALLS = 200;
var BATCH = 30;              // the instructions are paid once per request: more headlines per request, fewer tokens per headline
var MAX_OUT = 3200;

function istDay(ms) { return new Date(ms + 19800000).toISOString().slice(0, 10); }
function nextIstMidnight(ms) { var d = new Date(ms + 19800000); d.setUTCHours(24, 0, 0, 0); return d.getTime() - 19800000; }

/* The model is asked two things separately -- WHO is being judged (t) and HOW (p) -- and
   the stance toward BJP is worked out here: "Giriraj Singh slams Rahul Gandhi" is an attack,
   but on the opposition, not on BJP. Asking "is this against BJP?" directly made a small
   model read every "attack" headline as one. */
var SYSTEM = [
  'You read Indian news headlines (Hindi or English) for a BJP monitoring desk.',
  'For EVERY numbered headline return {"i":<number>,"t":"b|o|g|x","p":"+|-|0","v":"o|m|g|x","o":0|1,"k":"<3-6 lowercase english words>"}.',
  't = WHO the headline mainly judges (criticises, accuses, praises, credits):',
  '  "b" BJP, NDA, the Modi government, a BJP-run state government, or a BJP/NDA leader;',
  '  "o" an opposition party or leader (Congress, SP, TMC, AAP, RJD, DMK, BSP, AIMIM, Left ...);',
  '  "g" another government body, court, police or institution;  "x" nobody, or no judgement at all.',
  'p = how the headline treats that target: "-" criticism, attack, allegation, scandal, failure, protest against it; "+" praise, achievement, success, win, someone joining it; "0" a neutral report.',
  'v = whose voice it is: "o" opposition, "m" the outlet\'s own reporting or data, "g" BJP or a government, "x" anyone else.',
  'Examples: "Giriraj Singh slams Rahul Gandhi" -> t:"o",p:"-",v:"g". "Akhilesh attacks Yogi govt over jobs" -> t:"b",p:"-",v:"o".',
  '"PM Modi to visit Varanasi tomorrow" -> t:"b",p:"0",v:"m". "Cyber police stations in all 75 districts: Yogi" -> t:"b",p:"+",v:"g".',
  '"Paper leak exposes UP govt recruitment" -> t:"b",p:"-",v:"m". "Congress asks SP for 200 seats in UP" -> t:"o",p:"0",o:1.',
  'o = 1 only if it is about the opposition\'s own alliance or seat-sharing, or a dispute between opposition parties, or inside one (rebels, factions, a leader blaming his own party\'s members) -- INDIA bloc, SP, Congress, TMC, AAP, RJD, AIMIM, BSP ...; else 0.',
  'k = the event in 3-6 plain English words, the same words for the same event whatever the language (e.g. "congress sp up seat sharing").',
  'Judge only from the headline. Reply with JSON only: {"r":[ ...objects... ]}.'
].join('\n');

function createLabeller(opts) {
  var key = process.env.GROQ_API_KEY || '', log = opts.log || console.log;
  var usage = { day: istDay(Date.now()), tokens: 0, calls: 0, stopUntil: 0, last: null };
  function roll() { var d = istDay(Date.now()); if (usage.day !== d) usage = { day: d, tokens: 0, calls: 0, stopUntil: 0, last: usage.last }; }
  function canCall() {
    roll();
    if (!key) return 'off';
    if (Date.now() < usage.stopUntil) return 'paused';
    if (usage.tokens >= DAY_TOKENS || usage.calls >= DAY_CALLS) return 'paused';
    return 'ok';
  }
  /* one request: up to 20 headlines -> { id: label } */
  async function ask(list) {
    var lines = list.map(function (x, i) { return (i + 1) + '. ' + String(x.title).slice(0, 220) + ' [' + x.srcName + ']'; }).join('\n');
    var r = await fetch(GROQ, {
      method: 'POST', signal: AbortSignal.timeout(60000),
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, temperature: 0, max_tokens: MAX_OUT, reasoning_effort: 'low', response_format: { type: 'json_object' },
                             messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: lines }] })
    });
    if (r.status === 429) {
      var ra = Number(r.headers.get('retry-after')) || 0;
      /* a per-minute limit clears in seconds; anything longer is the daily limit: stop till tomorrow (IST) */
      usage.stopUntil = ra && ra < 120 ? Date.now() + (ra + 5) * 1000 : nextIstMidnight(Date.now());
      throw new Error('429 (rate limit) -- AI paused' + (ra && ra < 120 ? ' for ' + ra + ' s' : ' until midnight IST'));
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    var j = await r.json(), used = (j.usage && j.usage.total_tokens) || 0;
    usage.tokens += used; usage.calls++; usage.last = Date.now();
    var txt = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '';
    var out = {}, arr = [];
    try { arr = JSON.parse(txt).r || []; } catch (e) { var m = /\{[\s\S]*\}/.exec(txt); try { arr = m ? JSON.parse(m[0]).r || [] : []; } catch (e2) { arr = []; } }
    arr.forEach(function (a) {
      var x = list[(a && a.i) - 1]; if (!x) return;
      var tg = /^[bogx]$/.test(a.t) ? a.t : 'x', p = a.p === '+' || a.p === '-' ? a.p : '0', b = /^[omgx]$/.test(a.v) ? a.v : 'x';
      var s = tg === 'b' && p === '-' ? 'a' : tg === 'b' && p === '+' ? 'f' : 'n';      // against / for BJP only when BJP is the one judged
      out[x._id] = { s: s, b: b, t: tg, p: p, o: a.o === 1 || a.o === '1' ? 1 : 0, k: String(a.k || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60), m: MODEL, at: Date.now() };
    });
    return { labels: out, tokens: used };
  }
  return {
    /* label the next batch; returns the labels (possibly none) */
    step: async function (candidates) {
      if (canCall() !== 'ok' || !candidates.length) return {};
      var batch = candidates.slice(0, BATCH);
      try {
        var res = await ask(batch);
        log('  [media-ai] ' + Object.keys(res.labels).length + '/' + batch.length + ' labelled, ' + res.tokens + ' tokens (today ' + usage.tokens + ' of ' + DAY_TOKENS + ')');
        return res.labels;
      } catch (e) { log('  [media-ai] ' + e.message); return {}; }
    },
    status: function () { var st = canCall(); return { state: st, model: MODEL, day: usage.day, tokens: usage.tokens, cap: DAY_TOKENS, calls: usage.calls, until: st === 'paused' ? usage.stopUntil || nextIstMidnight(Date.now()) : null }; },
    usage: function () { return usage; },
    restore: function (u) { if (u && u.day === istDay(Date.now())) usage = { day: u.day, tokens: u.tokens || 0, calls: u.calls || 0, stopUntil: u.stopUntil || 0, last: u.last || null }; },
    on: !!key
  };
}

module.exports = { createLabeller: createLabeller };
