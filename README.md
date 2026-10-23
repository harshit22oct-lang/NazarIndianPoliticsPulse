# Nazar (नज़र) — standalone prototype

The Nazar TV view from India Political Pulse, running on its own for showing.
It reads a **PulseData CSV export** instead of MongoDB. There is no login and nothing to install except Node.js.
The Pulse project is not touched by this folder.

## Run it
- Double-click **`START-NAZAR.bat`**. The browser opens at http://localhost:3300/live.
  - The data file takes about 10 seconds to load.
  - Close the black window to stop it.
- To show it on a TV or phone on the same Wi-Fi, use **`START-NAZAR-ON-WIFI.bat`**.
  - It prints this laptop's IP address. On the TV, open `http://<that IP>:3300/live`.
  - Windows may ask to allow Node.js through the firewall. Allow it for private networks.

## MongoDB & Cloud Deployment
- **MongoDB Atlas Integration**: Data is stored in MongoDB Atlas (`nazar.tweets`).
- When running without local CSV files (e.g., deployed to **Railway**, **Render**, or **Vercel**), `server.js` automatically connects to MongoDB Atlas.
- The connection string is read **only** from `.env` locally, or from the hosting site's environment variables. Never write it in a `.js` file, because those go to GitHub. `.env` is in `.gitignore`.
- Configure `.env` (copy `.env.example`) with:
  ```env
  MONGODB_URI=your_mongodb_connection_string
  USE_MONGO=true
  ```
- **To deploy on Railway or Render**:
  1. Link your GitHub repo: `https://github.com/harshit22oct-lang/NazarIndianPoliticsPulse`
  2. Set environment variable: `MONGODB_URI`
  3. Start command: `npm start`

## "BJP और सरकार पर सबसे बड़े हमले" (AI section)
- **What it shows:** attacks by tracked non-BJP leaders on the BJP, the Union government, or a BJP / NDA state government.
  - The state's ruling party comes from the Chief Minister records in `handle_master.json`.
  - The window is the same 24 hours as the rest of Nazar, and the state filter applies.
  - The top two are sticky: they change only when a new attack scores 15 % higher.
- **How:**
  1. A keyword filter picks the posts, without AI.
  2. **Qwen 3.8 27B** (Groq, free) reads them, 5 posts per request. It labels each post: attack?, target, severity 1-5, topic, and a short summary.
  3. **GPT-OSS 120B** (Groq, free) re-reads the leaders. A post is shown only if both models call it an attack, and their two severities are averaged.
  4. Backup: GPT-OSS 20B on Groq, then the free Gemma on OpenRouter.
  - The data's `Sentiment` column is not used, because it does not match the posts.
- **Free-tier limits:** Groq allows 1,000 requests a day, 8,000 tokens a minute, and 1,000 output tokens a minute for Qwen. So Nazar sends one request a minute, which is about 300 posts an hour.
  - Each post goes to the AI only once. Labels are saved in MongoDB (`attack_labels`), or in `data/attack_labels.json` without MongoDB.
- **Settings in `.env` / Render:**
  - `GROQ_API_KEY` (needed);
  - `OPENROUTER_API_KEY` (backup);
  - `ATTACKS_WORKER=off` on a copy that should only display the labels, so that the laptop and Render do not both spend the Groq quota.
- Code: `app/attack_lib.js` holds the rules, the prompt and the ranking; `attacks.js` holds the AI calls, the limits and the saving.

## Leader photos
- Nazar never contacts X while it runs. Photos are files in `app/live_assets/avatars/`, listed in `avatars_index.json`. A leader without a file shows initials.
- After new data with new leaders, run:
  ```
  node fetch-photos.js
  ```
  - It downloads the missing photos (200x200) of every leader who posts in the CSVs in `data/`, most-viewed first, through the public fxtwitter API (no X login).
  - It takes ~1.5 s per leader and is safe to stop and re-run.
  - Then commit `app/live_assets` and push, so Render gets the photos.

Useful links:

| Link | What it shows |
|---|---|
| `/live` | Start screen: choose All India, one state, or one leader |
| `/live?scope=st:Bihar` | A state show: every screen, the leader search and the news are about that state only |
| `/live?mode=all` | Goes straight to the All-India show |
| `/live?h=myogiadityanath` | A leader's personal channel (any handle) |
| `/live?kiosk=1` | Hides the buttons (for a TV that just plays) |
| `/live?intro=0` | Skips the lotus intro |
| `/live?scope=up` | Uttar Pradesh only |

Keys: ← → change screen · Space pauses · F goes full screen · L switches between Hindi and English.

## Data
- Every `.csv` in `data/` is loaded, so you can drop in a newer export, or several.
- The same post appearing in two files is counted once, with the newer numbers kept.
- Columns needed are the PulseData export columns:
  - Handle, Tweet URL, Tweet ID, Tweet Date (`YYYY-MM-DD HH:MM:SS IST`), Tweet Text
  - Total Views / Likes / Retweets / Comments
  - Sentiment, State, Candidate Name, Category, Party
- The current file is `PulseData_2026-10-15_to_2026-10-22.csv`: 1,69,179 posts, 15 Oct 00:00 to 22 Oct 10:48 IST.
- The screens show the **24 hours before the newest post in the file**.
  - A small banner at the top says the data is recorded, with its dates. Nothing is shown as "LIVE".
- "Usual" levels are worked out from the days in the file. Pulse uses 28 days; here it is at least 3 days. See `server.js`, top.

## What is in the folder
- `server.js` is the small web server. It loads the CSVs into memory and answers the page's three data calls.
- `app/nazar.html` is the Nazar page. It started as a copy of `DASHBOARD/live_monitor.html`. It has these additions:
  - the recorded-data banner (search for `PROTO`);
  - no "Back to dashboard" button;
  - the latest-post time shown as a date;
  - the **state filter** (search for `STATE`):
    - the state picker on the start screen and the all-states panel with search;
    - the state label in the header;
    - the state glowing on the intro map;
    - state wording in the titles;
  - brighter leader photos on the start screen.
- `app/ha_lib.js`, `news_lib.js` and `mapping_lib.js` are copied unchanged from Pulse.
  - `app/live_lib.js` is the same as Pulse, except that any state can be a scope (`st:<State>`), and the "most active state" sentence is skipped inside a state.
  - All the counting rules are the same as in Pulse.
- In `server.js`:
  - `/api/live-states` lists the states that have at least 200 posts in the data;
  - a state's news ticker shows that state's own media posts first, then national ones.
- `app/data/handle_master.json` is the leader list. Search, party, constituency and rivals come from it.
- `app/live_assets/` holds the photos and party logos. See `leaders/ATTRIBUTION.md`.
  - Several leader photos were supplied by the project owner. Their usage rights must be confirmed before any public showing.

Copied from Pulse on 22 Oct 2026. If Nazar changes in Pulse, do not overwrite `app/nazar.html`. Copy over only the change you need; the prototype's own additions are listed above.
