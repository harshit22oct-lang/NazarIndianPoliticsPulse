# Prompt for Claude on the Political Pulse machine — status + number check for Nazar

> Paste everything below the line into Claude Code on the machine where **Political Pulse** runs.
> It does not need any password from here: it uses Pulse's own config (`db_config.local.json`).

---

## Who is asking and why

**Nazar** (`https://nazarindianpoliticspulse.onrender.com`) is a TV view of Political Pulse. It reads only what
Pulse publishes to MongoDB Atlas, database `pulse_hot`, and **never writes** there:

| Collection | What Nazar uses it for |
|---|---|
| `nazar_meta` (`_id: "info"`) | `window_start`, `updated_at`, `first_day`, `last_day` |
| `nazar_daily` | days **before** `window_start`: total posts, the 28-day "usual day" baseline, active accounts per party |
| `tweets` | days **from** `window_start`: every screen (24 / 48 / 72 h windows), polled every minute |
| `nazar_handles` | the number of political accounts tracked |

Some numbers on Nazar do not match what the user sees in Pulse. Your job:
1. **report the status** of the Pulse pipeline and of `pulse_hot`,
2. **check that the data is right and complete**, and
3. **recompute Nazar's numbers yourself** with Nazar's definitions (below) and compare them.

If the problem is on the **Pulse side**, fix it. If it is on the **Nazar side**, or just a difference in definitions,
do not change anything for it. Write it down with the evidence, and the user will fix Nazar.

**Rules**
- Do not break the data contract Nazar reads: the collection names, field names, `nazar_meta.info` and `schema: 1`.
  If a fix needs a contract change, stop and write it in the report instead.
- Don't drop or empty `pulse_hot` collections. Re-publishing them through Pulse's own normal publish step is fine.
- Never print passwords or connection strings.
- All days and times are **IST**. `Tweet Date` is a string `"YYYY-MM-DD HH:MM:SS IST"`.

---

## Part A — Pipeline status (report this first)

1. **Last scraper run and last push:** when did the scraper last run, and when did Pulse last push to Atlas?
   Show the last ~30 lines of the pipeline log and say whether it succeeded or what failed.
2. **Newest posts:** what is the newest `Tweet Date` in Pulse's master table, and in `pulse_hot.tweets`?
   - What Nazar sees: newest post is **2026-10-26 15:10:07 IST** (CNBC_Awaaz), but
     `nazar_meta.info.updated_at` keeps changing (e.g. 2026-10-27 07:58 UTC). So pushes happen with no new posts.
   - Why? Is the scraper stopped, is its source folder unreachable, are cookies or tokens expired, or are new rows
     not being picked up? **Fix it** so new posts flow again, then confirm that the newest post in `pulse_hot.tweets`
     is less than 1 hour old.
3. **Settings now in use:** the current `window_start`, `hot_days`, the TTL on `tweets.ts`, and the schedule
   (how often it runs).
4. **Days in the 3-day window:** are all of them in `pulse_hot.tweets` and complete? Compare the count per day in
   `pulse_hot.tweets` with the master table for those same days.

## Part B — Is the summary right and complete?

Nazar's own checks found **no missing day**: 207 days from 2026-04-01 to 2026-10-24 are present, with
28,95,810 posts in total. Please confirm or correct each of these:

1. **Per day, last 30 days before `window_start`:** do the sums of `nazar_daily` `tw`, `lk`, `vw`, `rt` equal the
   master table's count of rows and sums of Total Likes / Views / Retweets for the same IST day?
   - Does `tw` include retweets and media rows? Nazar assumes **yes, all rows**.
2. **24 Oct:** `nazar_daily` has **13,459** posts on 2026-10-24. Nazar's older copy had only 719 posts that day.
   Is 13,459 the true number in the master table?
3. **Low days:** these days have far fewer accounts than usual (about 500 instead of 1,500+). Was this a scraper
   outage? Can those days be re-scraped or rebuilt? If yes, do it and re-publish `nazar_daily`.
   - 2026-09-11, 09-12, 09-13, 09-14, 09-15, 09-20
4. **April–May:** these months are much smaller (5,039 and 7,762 posts a day, against ~24,000 in October).
   Is that only because fewer accounts were tracked then, or is data missing?
5. **Fields:** `nazar_daily` has 1,421 rows with no party (`pt`), 665 with no state (`st`) and 2 with no category.
   Is that expected?
6. **Accounts:** `nazar_handles` has **3,757** handles. Nazar shows **3,669** political accounts: all handles except
   `cat` = Media House / Journalist, and **633** for Uttar Pradesh. Is that the right list of accounts Pulse tracks?
7. **Same account twice, different letter case:** `nazar_handles` has **27** accounts stored twice, 13 of them BJP.
   Examples: `Prupala` / `PRupala`, `BRNishadBJP` / `brnishadbjp`, `NayabSainiBJP` / `nayabsainibjp`. X handles are not
   case-sensitive, so each is one account. Nazar counts each account once, so it shows 1,965 tracked BJP accounts,
   not 1,978. **Fix on the Pulse side:** merge these by `lower(handle)` everywhere, in the master table, `nazar_daily.h`
   and `nazar_handles._id` (keep the row with the latest `last_day`), so that per-account totals are not split in two.

## Part C — Recompute Nazar's numbers with Nazar's definitions

**Nazar's definitions** (they can differ from the Pulse dashboard; that is fine, but say where they differ):

- **Original post:** a row whose `Tweet Text` does **not** start with `RT @`, **and** whose `Category`
  (trimmed, any case) is **not** `Media House` or `Journalist`.
- **Views:** the sum of `Total Views` over those original posts. Numbers are cleaned: remove commas, and anything
  invalid counts as 0.
- **Active accounts:** distinct `lower(Handle)` among those original posts.
- **Party:** `Party` trimmed. Empty, `-`, `nan`, `none`, `null`, `unknown`, `ind` or `independent` count as no party.
- **Window:** the latest **H hours** (H = 24, 48 or 72) **ending at the newest `Tweet Date`** in scope, both ends
  inclusive, compared as strings. It is **not** a calendar day.
- **UP scope:** `State` = `Uttar Pradesh`.
- **Total posts:** `nazar_daily` sum of `tw` for `d < window_start`, plus the `pulse_hot.tweets` count for
  `Tweet Date >= window_start`.
- **Usual day (baseline):** the 75th percentile of daily total posts (all rows) over the previous 28 days.
- **Growth arrows:** shown only when both this period and the previous period of the same length hold at least
  60% of the usual volume.

**Nazar's values to compare.** The 24 h window is **2026-10-25 15:10:08 IST → 2026-10-26 15:10:07 IST**
(for UP: 2026-10-25 15:06:33 → 2026-10-26 15:06:32).

| Check | All India (Nazar) | UP (Nazar) |
|---|---|---|
| Original posts (no media, no RT) | 6,252 | 955 |
| Views on them | 1,54,10,018 | 37,72,482 |
| Active accounts | 1,624 | 279 |
| BJP posts / views | 4,777 / 99,45,839 | 762 / 32,75,725 |
| Most-viewed post (views) | 15,97,669 | 4,82,736 |
| Total posts (summary + live) | 29,18,816 | 4,45,908 |
| Political accounts tracked | 3,669 | 633 |
| 48 h window (All India): original posts / views | 9,642 / 2,23,16,464 | — |
| 72 h window (All India): original posts / views | 13,290 / 3,15,53,071 | — |
| Narendra Modi, 24 h: posts / views / likes | 5 / 13,68,730 / 23,564 | — |

For each row, compute the number **from `pulse_hot`** and **from Pulse's master table** with the definitions above,
and also give the number the **Pulse dashboard** shows for the closest equivalent. Then explain every difference.

Note: the 48 h and 72 h windows reach back into 2026-10-24, before `window_start`. Nazar has only 719 raw posts for
that day, so those two rows are expected to be **lower** on Nazar. Confirm how much lower.

---

## What to send back (the user will paste it to Nazar's side)

1. **Status:** one short paragraph with the scraper and push state, the newest post time, and what you fixed.
2. **One table** with these columns:

   | Check | Pulse master | pulse_hot | Pulse dashboard | Nazar | Match? | Whose side | What was done |
   |---|---|---|---|---|---|---|---|

   "Whose side" is one of: **Pulse** (fixed here) / **Nazar** (user will fix) / **definition** (both are right, they
   just count differently).
3. **Changes:** every change you made on the Pulse side (files, collections re-published), with the time.
4. **For Nazar:** anything the user should change on Nazar, with the exact evidence.
