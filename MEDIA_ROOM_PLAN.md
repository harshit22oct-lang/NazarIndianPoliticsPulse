# Nazar Media Room: build plan

Draft, 24 Oct 2026. The source list and narrative list are in `MEDIA_ROOM_SETUP.md` and `app/data/media_room_config.json`.

## 1. What it is
A new **channel** inside Nazar, next to "All India" and the personal leader channels. A monitor at HQ can be set to the Media Room and left running 24×7. It loops through news screens by itself, and changes as soon as new news arrives.

## 2. Control bar
It's hidden while the loop runs. It appears in the corner when you **pause**, touch, or press a remote key. Any change applies at once (there is no Apply button), new news is fetched right away, and then the loop continues.

**Row 1: Area**
- `All India` | `State` | `Both`
- **State is picked automatically.** If Nazar is opened on a state (for example `?scope=st:UP`), State already means UP. If it's opened on All India, choosing State shows the state picker Nazar already has.
- `Both` alternates between All India screens and state screens. It's the default when a state is open.

**Row 2: Topic** (you can pick several)
- `Mix` (default): rotates through every topic that's switched on.
- `Politics` · `Elections` · `🔥 Hot right now` · `Attacks on BJP / सरकार पर हमले` · `Positive for BJP / BJP के पक्ष में` · `Student & youth` · `Official statements` · `By source`
- The topics come from the narrative list, so adding a narrative later adds a button.

**Remembered per screen.** Each TV remembers its own choice after a restart. A TV can also be set up by link, for example `?mode=media&scope=st:UP&area=both&t=elections,attack`, which suits fixed monitors.

**TV remote.** Arrow keys move between buttons, OK selects, and Back closes the bar. This uses the remote-key handling Nazar already has.

## 3. What one screen shows
- A heading with the topic and area, for example "चुनाव · उत्तर प्रदेश".
- 5–6 news cards, newest first. Each card has the headline, source logo/name and time ("12 min ago"). It also shows:
  - an **Official** or **Media** tag;
  - a **NEW** badge if it arrived since the last loop;
  - "**+4 sources**" when the same story came from several places. Duplicates are merged into one card, not shown 5 times.
- A footer: "Updated 3 min ago" and the next screen. If a source has gone quiet, it says so, for example "Aaj Tak: no update in 3 h". Nothing pretends to be live when it isn't.
- Phone: you can tap a card to open the original article. On TV it's display only.

**Loop timing.** About 20 s per screen, following Nazar's speed control. A topic with no news in the last 24 h is skipped rather than shown empty. A ticker of the newest headlines runs at the bottom.

## 4. How topics are decided
| Topic | How | Cost |
|---|---|---|
| Elections, Politics, Protests, Student & youth, Law & order… | Hindi and English keyword match from the narrative list | free, instant |
| State of a news item | state and major city names (Hindi and English) in the headline, plus which feed it came from | free |
| 🔥 Hot right now | stories that the most different sources carried in the last 6 h (from duplicate grouping) | free, no AI |
| Official statements | the source type in the config (ABVP, NSUI, PIB, IYC…) | free |
| **Attacks on BJP / Positive for BJP** | **needs AI**, because keywords can't judge stance. Marked "AI tagged". | Groq free |
| New narrative suggestions | AI groups recurring untagged topics; you choose Follow or Ignore | Groq free |

## 5. Where the news comes from (all free, no keys)
- **Website RSS feeds** of the 15 news sources in the setup file.
- **YouTube RSS** of the 10 channels.
- **Google News RSS** searches:
  - for the student and youth organisations;
  - **for each state** ("<state> politics / राजनीति", Hindi and English). This makes the State area work for all 36 states without a source list per state.
- **X posts:** only through the CSV import Nazar already uses. There is no X API.

**How often it fetches:**
- Every 15 min: the main feeds, and the states watched in the last 24 h (UP always).
- Every 3 h: the other states.
- This stays polite to Google News and light on the free Render server.

## 6. The free-limit plan for AI
Free limits, checked 24 Oct 2026:
- Groq free: **gpt-oss-20b** allows 30 requests/min, 1,000 requests/day, 8K tokens/min and 200K tokens/day. Limits are counted **per model**, so it doesn't touch the Qwen budget the Attacks section uses.
- OpenRouter free models: 20 requests/min, **50 requests/day** with no credit bought.

Rules:
1. **Keywords first, AI only where needed.** Only headlines about BJP, government, Modi, opposition parties or leaders go to AI for stance, roughly 30–40% of political news.
2. **Each headline is tagged once**, keyed by its URL hash and cached in Mongo. A loop that runs again or a server restart costs nothing.
3. **Batches of 20 headlines per call, at most 1 call per minute.**
4. **Hard daily cap at 70% of the free limit:** 600 calls and 140K tokens a day, counted in Mongo. When the cap is reached, Nazar keeps working on keywords only and shows "AI tagging paused till 5:30 AM". It never hits the limit.
5. **OpenRouter is a backup only**, when Groq returns an error. It's capped at 40 calls a day, under its 50.
6. Estimate: about 1,500 political headlines a day, of which about 600 need stance. That's around 30–40 calls and 50–80K tokens a day, well inside the cap.

## 7. Storage and server
- MongoDB Atlas, the same cluster. New collections:
  - `media_items`: headline, link, source, time, tags, state, story group;
  - `media_ai_usage`: the daily counters.
- No article bodies, only headlines, so each item is about 0.6 KB. At about 3,000 items a day, 60 days is about 110 MB. The storage limit is 512 MB, and older items are deleted automatically.
- The collector runs **inside the existing Render server**, with no new service. A copy with `MEDIA_WORKER=off` collects nothing and re-reads what Render stored, so two copies never fetch twice. UptimeRobot already keeps the server awake.
- **Archive:** a date picker in the control bar shows any day in the last 60 days.

## 8. Phases
- **Phase 1 (no AI):**
  - collector, storage and duplicate grouping;
  - keyword and state tagging, and Hot right now;
  - the Media Room channel with the Area and Topic rows;
  - the loop, freshness display, pause and the control bar.
- **Phase 2:** AI stance (Attacks on BJP / Positive for BJP) with budget guards, and new narrative suggestions.
- **Phase 3:**
  - archive by date and the By source screen;
  - an optional single "Top news" screen inside the main Nazar loop.

## 9. What you need to do (all free)
1. Confirm `MEDIA_ROOM_SETUP.md`: the 4 X handles and the YouTube links for ABP News and BJP.
2. Check Atlas storage: Atlas → your cluster → **Collections**, read "Storage size" and send me the number.
3. The collector is **on by default** (like the Attacks worker). On any copy that should only display what Render collected, for example the laptop, add `MEDIA_WORKER=off` to its `.env`. You don't need a new Groq key, because the existing one works on a different model. A second free Groq account is optional, if you want the Media Room fully separate.
4. Tell me which states must always be fresh (UP plus which others?), and any regional papers you trust for them.
5. Decide what "Attacks on BJP" includes: only statements by opposition leaders and parties, or also critical media reports?
6. Optional: add the 10 new X handles to the scraper list.
