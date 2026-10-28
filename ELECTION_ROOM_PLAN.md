# Nazar Election Room: build plan

Draft, 28 Oct 2026. Research notes are at the end (section 10).

## 1. What it is
A new **channel** on the start screen, under Media Room: **चुनाव कक्ष / Election Room**. A TV can be left on it all day. It loops through 3–5 screens by itself, like a news channel on counting day:

- **When counting is on:** live seat tally that moves up and down, close fights, big faces, newly declared results, election news. Every screen says **LIVE** and "ECI · updated 1 min ago".
- **When nothing is being counted:** the latest final results (marked **पुराना / अंतिम नतीजे · date**) and election news. It never pretends to be live.

**Rule 1: only official numbers.** Seat counts, votes and margins come only from the **Election Commission of India (results.eci.gov.in)**, or from ECI's own pages as saved by the Internet Archive for past results. Nothing is estimated, and nothing comes from TV channels or exit polls.
**Rule 2: say where everything came from.** Each screen shows its source, the time of the last update, and LIVE / FINAL / OLD.

## 2. The screens (the loop)
| # | Screen | Shows | When |
|---|---|---|---|
| 1 | **सीटों का हाल** (seat tally) | Alliance bars (NDA / INDIA / others) and the top parties: won + leading, the majority line, a **▲ +3 / ▼ −2** change since the last update (news-channel style), "N of M seats known" | live, or the latest final result |
| 2 | **कड़ी टक्कर** (close fights) | Seats still counting with the smallest margins: leader vs runner-up, margin, round 14/22 | live only |
| 3 | **बड़े चेहरे** (big faces) | Key candidates: leading / trailing / won / lost, margin | live, or final |
| 4 | **ताज़ा नतीजे** (just declared) | The latest seats declared: winner, party, margin | live only |
| 5 | **पिछले नतीजे** (past results) | The last completed elections of the chosen type and state: tally and date, marked **पुराना** | always available; leads the loop when nothing is live |
| 6 | **चुनावी ख़बरें** (election news) | Election headlines from the Media Room feeds (official + media), plus local body / panchayat news | always |

With 2+ states counting at once (five states in May 2026), screens 1–4 repeat per state.

**Smart loop** (dynamic, like a news desk):
- A screen with nothing to show is skipped.
- **Movement decides the order and time.** After every update, the state or alliance with the biggest seat change goes next and stays longer (up to 1.5×). A close fight that just flipped leader gets a "पलटा!" badge and jumps ahead.
- When nothing is live, the loop is past results + news, and the subtitle says it is old data.
- It follows Nazar's speed control (धीमा / सामान्य / तेज़).

## 3. Control bar (same pattern as Media Room)
Opens on pause, or with the **"चुनाव चुनें"** button. Changes apply at once.
- **क्षेत्र (area):** सब (all) / a state / a city. A city filters the news screen and local-body results. The page's own state is chosen automatically (`?scope=st:UP`).
- **चुनाव का प्रकार (type):** सब (mix) · लोकसभा · विधानसभा · उपचुनाव · राज्यसभा / विधान परिषद · नगर निकाय · पंचायत. "सब" mixes whatever is live first, then the rest, by category.
- **गति (speed):** the same speed control as Media Room.
- The summary line: "5 screens · one round ≈ 2 min".
- **Back button (top-right):** `← वापस` goes back to the start screen. On a TV remote, Back does the same when the panel is closed.
- Settable by link for fixed TVs: `?mode=election&st=Uttar Pradesh&type=vs`.

## 4. Where the data comes from
| What | Source | Trust | How often |
|---|---|---|---|
| Live tally, constituency status | `results.eci.gov.in`: index → per-state `partywiseresult-Sxx.htm` → `statewiseSxx1..N.htm` | **Official** | every 60 s while live |
| Candidate votes, round (big faces) | `candidateswise-Sxxnnn.htm` | **Official** | every 2 min, only for big-face seats |
| Hindi party / seat names | ECI's own Hindi pages (`/hi/…`) | **Official** | once per election |
| Which election is on | `results.eci.gov.in/` redirects to the current election folder | **Official** | every 15 min when idle |
| Past results | ECI result pages as saved by the **Internet Archive**, plus every result Nazar collects itself (kept for good) | **Official (archived copy)** | once per election, then stored |
| Local body / panchayat / MLC / Rajya Sabha | No common official feed (each state's SEC differs) → **news only**, clearly marked "ख़बरों से — आधिकारिक आँकड़े नहीं" | news | with the Media Room feeds |
| Election news | Media Room items tagged "elections", plus Google News searches for local-body results | news | every 15 min |

Polite fetching: one request at a time, ~1 s apart, a desktop User-Agent, backing off on errors. Live means about 15 requests a minute for one state, well within normal browsing.

**Is it live?** Live = ECI's page has seats still "leading" (not all declared) **and** it was updated in the last 6 hours. Final = all seats declared. Old = a past election from the archive or the store. The page only ever says LIVE when this check passes.

## 5. Alliances and majority
- ECI gives parties, not alliances. An editable list, `app/data/election_config.json`, maps parties to alliances (NDA, INDIA, others), with per-state overrides (e.g. Kerala UDF/LDF, TN DMK+/ADMK+).
- Majority = seats / 2 + 1, shown as a line on the bars.
- Big faces: a config list per election (CM, party chiefs). Seats can also be added from a candidate page. Kept short (≤ 12).

## 6. Storage and server
- New module `election_room.js` inside the existing Render server (no new service), same pattern as `media_room.js`. `MEDIA_WORKER=off` copies only read what Render stored.
- MongoDB: `election_results` (one document per election and state: tally, seats, status, fetched at; kept for good), `election_meta` (status). No Mongo → `data/election_room.json`.
- Change history: the last 30 tally snapshots per state are kept in memory for the ▲▼ arrows and "biggest mover".
- API: `GET /api/election-room?st=<state>&type=<type>` → `{ live:[…], final:[…], past:[…], news:[…], status }`.

## 7. The page
- New mode `election` in `app/nazar.html`. Reuses the frame, ticker, speed, pause and remote keys. The ticker shows declared results while live, otherwise election headlines.
- Start screen: a "चुनाव कक्ष" strip under Media Room, with a red LIVE dot when counting is on.
- Old smart-TV browsers: ES5 only, rem sizes, no CSS `gap`, the same as the rest of the page.

## 8. Phases
1. **Now:**
   - collector: ECI live + discovery + past results from the archive
   - API
   - the channel with all six screens
   - control bar and back button
   - alliance and big-face config
   - "पलटा!" flips
   - **demo mode** (`?demo=1`): it replays the real archived Bihar 2025 counting snapshots, so the room can be tested and shown before the next election. Every screen says **DEMO · पुराने आँकड़ों से अभ्यास**, never LIVE.
2. **Next:** candidate pages (votes and round for big faces); Hindi seat names from ECI's `/hi/` pages; "vs last election" seat change.
3. **Later:** state election commission results where a state publishes a clean page (UP SEC for nagar nikay, for example).

### Refinements after review
- Big faces need no extra requests: the constituency list already names the leading and trailing candidate, so a config name list is enough. Moved to phase 1.
- Flips come from comparing two constituency snapshots. Moved to phase 1.
- Lok Sabha: the index's own party table is the All-India tally, and per-state pages are found by scanning the whole page for `partywiseresult-Sxx.htm` (links and dropdown values). The same parsers work for both.
- Past results are committed as `data/election_history.json` (built by `fetch-election-history.js`), so even a server with no Mongo has them from the first second.

## Status (28 Oct 2026): phase 1 built
- `app/election_lib.js`: ECI page readers, tested on real pages (by-election Oct 2026, Bihar 2025 mid-count, five states May 2026, candidate page).
- `election_room.js`: collector. It finds the current election from `results.eci.gov.in/`, reads it every 75 s while counting and every 15 min otherwise, and keeps final results for good. Locally run with `ELECTION_WORKER=on` (launch config `nazar-elections`).
- `fetch-election-history.js`: past results from archived ECI pages → `data/election_history.json`. It now holds 13 results:
  - Lok Sabha 2024
  - AP and Odisha 2024
  - Haryana and J&K 2024
  - Maharashtra and Jharkhand 2024
  - Bihar 2025
  - Assam, Kerala, Tamil Nadu, West Bengal and Puducherry 2026
  
  Delhi 2025 is not included: the archive only has mid-count copies. The demo replay is in `data/election_demo.json`.
- `GET /api/election-room?state=<name|->&type=all|ls|vs|bye|council|local&city=<en>&demo=1`
- Page: `?mode=election` (+ `est`, `etype`, `ecity`, `edemo=1`).
  - **Screens:** seat tally (half circle, alliances, party table with ▲▼), close fights, big faces, declared results, by-election seats with ECI photos, past results, news.
  - **Controls:** a "choose election" panel, and ← Back at the top right.
- Alliance totals checked against official counts: LS 2024 NDA 293; Bihar 2025 NDA 202 / MGB 34; Maharashtra 2024 NDA 230; Jharkhand 2024 INDIA 56.

## Update (28 Oct 2026): built for leaders at a glance
- **Headline first:** the seat tally opens with one sentence, such as "एनडीए बहुमत के पार — 201 सीटें" or "किसी को बहुमत नहीं — X सबसे बड़ा". Under it are the gap to the next alliance and BJP's own line: won / ahead / behind and its strike rate (won + ahead ÷ seats fought).
- **आमने-सामने (head to head):** a dedicated page that keeps changing, one seat about every 7 s. It shows both candidates with their **official ECI photo**, party, votes counting up, the margin in the middle, a bar of the two-way vote split, and the queue of seats coming next.
  - **Which seats, in order:**
    1. big faces
    2. seats where the lead just flipped
    3. BJP's tightest fights (BJP first or second)
    4. seats just declared
    5. BJP's biggest wins
    6. other close fights
    
    At most 8 on screen.
  - **When nothing is being counted:** the page shows the latest by-election results, marked पुराना (old).
- **More sources:**
  - Each priority seat's ECI candidate page (votes, round, photos) is read every 2.5 min while counting, at most 10 pages per poll.
  - When a state is counting, the Media Room adds Google News searches for that state's results and counting (Hindi + English).
  - The demo has the archived candidate pages of its priority seats (`node fetch-election-history.js demo-cands`).

## 9. Risks
- **ECI changes page layout between elections.** The parsers read table headers ("Won", "Leading", "Margin"), not fixed positions. If parsing fails, the screen says "ECI data could not be read" and does not guess.
- **ECI slow or blocking on counting day:** back off, keep showing the last good numbers with their time ("3 min old").
- **Internet Archive limits:** history is fetched once, gently, and stored for good. It is also committed as `data/election_history.json` so a fresh server has it.
- **Local-body results:** news only until a clean official source exists. Labelled so.

## 10. Research notes (28 Oct 2026)
- `results.eci.gov.in/` now redirects to `ResultAcByeOct2026/index.htm`: assembly by-elections, counted 9 Oct 2026, all declared. There is also `ResultPcByeOct2026`.
- By-election index: one card per seat (seat, state, WON/LEADING, candidate, party). `candidateswise-S25210.htm` shows the round (17/17), and votes and margin for every candidate.
- General election index (archived Bihar Nov 2025, mid-count): a party table "Party - ABBR | Won | Leading | Total", a constituency list `statewiseS041.htm` with "Status Known For 243 out of 243", and rows of seat | no. | leading candidate | party | trailing candidate | party | margin | round | status.
- Multi-state index (archived May 2026): the top five parties per state plus `partywiseresult-S03/S11/S22/S25/U07.htm`.
- ECI removes old folders (Bihar 2025 is 404 now). Internet Archive snapshots exist for PcResultGenJune2024, AcResultGenJune2024, AcResultGenOct2024, ResultAcGenNov2024, ResultAcGenFeb2025, ResultAcGenNov2025 and ResultAcGenMay2026. A snapshot is used only if every seat is declared in it; otherwise it is skipped, not shown as partial.
- Upcoming: UP, Punjab, Uttarakhand, Goa and Manipur assembly elections are due in early 2027. That is the first big live counting this feature will cover.
