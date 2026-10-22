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
- Configure `.env` with:
  ```env
  MONGODB_URI=your_mongodb_connection_string
  USE_MONGO=true
  ```
- **To deploy on Railway or Render**:
  1. Link your GitHub repo: `https://github.com/harshit22oct-lang/NazarIndianPoliticsPulse`
  2. Set environment variable: `MONGODB_URI`
  3. Start command: `npm start`

Useful links:

| Link | What it shows |
|---|---|
| `/live` | Start screen: choose All India or one leader |
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
- `app/nazar.html` is the Nazar page. It is a copy of `DASHBOARD/live_monitor.html` with three small additions:
  - the recorded-data banner;
  - no "Back to dashboard" button;
  - the latest-post time shown as a date.
- `app/live_lib.js`, `ha_lib.js`, `news_lib.js` and `mapping_lib.js` are copied unchanged from Pulse. All the counting rules are the same as in Pulse.
- `app/data/handle_master.json` is the leader list. Search, party, constituency and rivals come from it.
- `app/live_assets/` holds the photos and party logos. See `leaders/ATTRIBUTION.md`.
  - Several leader photos were supplied by the project owner. Their usage rights must be confirmed before any public showing.

Copied from Pulse on 22 Oct 2026. If Nazar changes in Pulse, copy `live_monitor.html` again as `app/nazar.html` and re-apply the three additions. Search for `PROTO` in the page.
