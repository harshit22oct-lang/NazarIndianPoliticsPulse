# Nazar — UI/UX Audit & Upgrade Plan

Audit date: 30 Oct 2026 · Build audited: `a341f1d` · Screens checked at 1280×720 (TV/laptop), 1280×900, and a real 375×812 phone frame.
Every screen of every mode was opened: intro → start screen → All India (13 scenes) → leader channel (8 scenes) → Media Room (topic loop) → Election Room (past, duel, news) → panels, search, state picker, loading/error states.

**Ground rule for every fix below:** the page must keep running on old smart-TV browsers (Chromium 68, ES5). No flex `gap`, no `clamp()`, no `aspect-ratio`, no `backdrop-filter`, no `color-mix`. All new motion uses only `transform` and `opacity` (cheap on TV chips), and every animation has a still version under `body.reduced`. Nothing may depend on an animation finishing.

Each finding has an ID (e.g. `G2`, `S7`) so we can tick them off one by one.

---

## 0. The ten changes that matter most

| # | Change | Why it matters | IDs |
|---|---|---|---|
| 1 | Stop the background leader photos from sitting behind data | On almost every screen Modi's photo shows through charts, numbers and the VS badge. It is the single biggest reason the screens look busy. | G1, G2, S1, E3 |
| 2 | A leader's channel shows **that leader**, not Modi | On Yogi Adityanath's channel the background is still the Modi photo pair. It looks like a template bug. | P0 |
| 3 | Raise the smallest text sizes for TV | Footer, tags, sub-lines and ticker sources are 14–19 px at 1080p. They can't be read from a sofa. | G3 |
| 4 | Real thumbnails on news cards | Media Room and Election news are all-text cards, and every card looks the same. Photos make it feel like a newsroom, not a feed reader. | M1 |
| 5 | Never cut a line of text in half | Election news headlines are sliced mid-line (the bottom half of "JDU" and "Netanyahu" is missing). Use proper "…" endings everywhere. | G5, E7 |
| 6 | Rebuild the 4 sparse screens | "Most-viewed post", "Breakout", the leader's "Where they stand", and "In simple words" have big empty boxes or generic bullet lists. | S8, S7, P4, S11 |
| 7 | The start screen gives Media and Election Rooms real cards | Today they are thin strips with cut-off text and stock line-icons, though they are two of the three products. | C4 |
| 8 | Clean what shows on screen | "Israel Election" in the election ticker, a Maserati launch under "Government & schemes", "NovemberTime:" run together in the ticker, a crowd photo as R. Ashok's avatar. | Q1–Q5 |
| 9 | A real motion language (not decoration) | Motion should tell the viewer something: what changed, what is live, how far through the loop we are. | Section 11 |
| 10 | A clear focus ring for TV remotes | Focus is only a thin border-colour change. With a D-pad you can't see where you are. | G6 |

---

## 1. Global / design-system level

### G1 — Background leader photos compete with the data *(high)*
**Found:** `#hero` (Modi centre + a second leader on the right) is fixed behind every screen. `hero-hi` (opacity 1) on the opening "एक नज़र में" puts Modi's body straight through the stat cards "86.8 लाख" and "2.7 लाख". On every other scene (`hero-lo`, opacity .26/.2) the photo still reads clearly through the cards, because the card glass is only 82% opaque (`--glass: rgba(26,8,3,.82)`). In the Election Room duel there is no card at all, so the VS badge sits on Modi's chest.
**Fix:**
- Give each scene a **hero mode**: `stage` (photo is the subject: intro, start screen, opening scene), `quiet` (all data scenes: opacity .07, pushed to the far edges), or `off` (dense scenes: bar charts, map, attacks, news grids, duel).
- On the opening scene, **reserve a column** for the leader (right 30%) and lay the cards out in the left 70%, so the photo and the numbers never overlap.
- Raise data-card glass to `rgba(24,7,3,.93)`. Blur would also work, but `backdrop-filter` is not on Chromium 68 and is slow on TVs.

### G2 — Glass cards look "generic dashboard" *(medium)*
**Found:** every block is the same rounded, dark, translucent card with a thin saffron border. The opening scene has 10+ identical cards, so nothing reads as more important.
**Fix:** three card levels.
- **Feature:** solid deep-maroon, top edge lit with a 2px saffron→gold bar. Used for #1 items.
- **Standard:** today's card at .93 opacity.
- **Inline:** no box, only a hairline divider. Used for lists inside a card.

The #1 card in "BJP में ट्रेंडिंग" already does this; make it the rule everywhere.

### G3 — Text too small for a TV *(high)*
**Found:** at 1080p, 1rem = 16px. Sizes in use: .85, .9, .95rem (5 rules); 1–1.2rem (~140 rules). The footer line `.honesty` is 1.05rem, the ticker tag `.tk-tag` is .95rem, the ticker source 1.15rem, the bar-row sub-lines ("885 सक्रिय · 28 दिन में…") ~1rem, and chart axis labels ~1rem. Devanagari needs more size than Latin for the same legibility, because its matras get tiny.
**Fix:** a type scale with a hard floor for TV.
- **Captions:** at least 1.3rem (21px at 1080p).
- **Body / secondary:** 1.6rem.
- **Card values:** 3.2–4.4rem.
- **Hero numbers:** 6–8rem.
- **Phone:** keep its own scale (already separate via `body.phone`).

Done as CSS custom properties (`--fs-cap`, `--fs-body`, …) so there is one place to tune. Audit every `font-size` under 1.3rem.

### G4 — Colour carries too many meanings *(medium)*
**Found:** saffron is the brand, BJP's party colour, the "selected" state, the progress bar, the ticker label and the CTA. Green is "good", "won", and the "आगे चलाएँ" button. Amber is a warning and also the latest-post pill.
**Fix:** separate the roles in `:root`.
- **Brand saffron:** chrome only.
- **Party colours:** only where a party is meant.
- **Selection:** a gold ring, not a saffron fill.
- **Status:** green = up/won, red = down/lost, amber = stale/attention.
- **Buttons:** primary CTA in brand saffron, never green.

### G5 — Text cut inconsistently *(high)*
**Found:** three different cuts are in use:
- `…` on one line (good);
- 3-line clamp with `…` (good);
- a fixed height with `overflow:hidden`, which slices a line horizontally (Election news cards, the lead card "…| Mokama | Niraj Kumar | JDU").

On phone, names become "Shri…" and numbers "4.5 ला…".
**Fix:** one helper class `.clamp-1/.clamp-2/.clamp-3` using `-webkit-line-clamp` (works on Chromium 68). Never a fixed-height cut. Numbers are never cut: shrink-to-fit (`fitScene` already exists) or drop the unit. On phone, names wrap to two lines rather than cut.

### G6 — Focus for a TV remote is nearly invisible *(high for TVs)*
**Found:** `:focus` = border turns gold, `outline:none`. On a TV at 3 m this is invisible.
**Fix:** a `focus` style shared by all buttons and chips: a 3px gold ring with a soft outer glow (`box-shadow:0 0 0 .3rem var(--gold), 0 0 2rem rgba(255,200,87,.45)`) plus `scale(1.04)`. Arrow keys move between panels in a predictable grid order. Test with keyboard only.

### G7 — Names and honorifics are inconsistent *(low, visible everywhere)*
**Found:** "Shri Yogi Adityanath", "Smt Priyanka Gandhi Vadra", "Pawan Khera" (no honorific), "Mayawati" (none), "Dr. S. Jaishankar". All names are in English even in Hindi mode.
**Fix:** one rule. Either always the honorific (from the master sheet) or never on tiles, keeping honorifics only on profile screens. Show Hindi names in Hindi mode where the master has them (`handle_master.json` can carry `name_hi`).

### G8 — Icons *(medium)*
**Found:** the chooser uses stock line icons (a monitor for Media Room, a briefcase-like box for Election Room). Party marks are tiny 14px logos and "अन्य" has a grey dot.
**Fix:** no stock icon set. Use the brand's own visual vocabulary:
- **Media Room:** live headline preview.
- **Election Room:** mini seat bar / ballot.
- **Party marks:** 2.4rem minimum.
- **"अन्य" (others):** a stacked mini-logo cluster of the next 3 parties.

---

## 2. Top bar, header, footer, ticker, controls (seen on every screen)

### C1 — Top bar is crowded *(medium)*
**Found (1280×720):** status pill, clock + date, a 24/48/72 h toggle, a speed toggle (धीमा/सामान्य/तेज़), "नज़र बदलें" and "English" all sit in one row. In the Election Room "चुनाव चुनें" and "← वापस" are added as well: 8 controls. The two segmented toggles look identical, though one changes data and the other only the pace. "नज़र बदलें" and "← वापस" both lead back to the start screen.
**Fix:**
- Group into **left: brand**, **centre: what you're watching** (scope + period as one control: "पूरा भारत · 24 घंटे ▾"), **right: clock + one "⚙" menu** (speed, language, room options).
- Remove the duplicate back button.
- On TV kiosk the bar shows only brand, scope and clock (already partly so).

### C2 — Status pill "ताज़ा पोस्ट · 3 दिन पहले" *(medium)*
**Found:** a grey dot with small text. When data is 3 days old that's a serious state, but it looks like a neutral label.
**Fix:**
- Fresh: green pulsing dot "LIVE".
- Delayed: amber "देरी · 25 मिनट".
- Stale: red, with the age in bold.

The pulse runs only when actually live, so it means something.

### C3 — Scene header *(low)*
**Found:** a big title, a tiny grey sub-line, and the counter "3 / 13" alone at the far right in tiny grey. The "आगे: …" (up next) hint in the rooms is good but tiny.
**Fix:** move the counter next to the progress (C5). Sub-line at the caption floor (G3). Put "आगे" in all modes, as a small card at bottom-right that slides in for the last 5 s of each scene. This is TV-news grammar ("coming up").

### C4 — see Start screen.

### C5 — Progress: dots + thin line *(medium)*
**Found:** 13 tiny dots inside the floating control bar (only visible on hover), plus a thin saffron line above the ticker. On a TV the viewer can't tell how long a screen stays.
**Fix:** one **segmented progress rail** under the header: one segment per scene, the current one filling over its duration. It is always visible (not hover-only) and the counter sits at its end. It replaces the dots.

### C6 — Floating playback controls *(medium)*
**Found:** the prev / pause / next / dots / fullscreen pill appears over the content and covers the bottom row of lists (e.g. "अन्य (राष्ट्रीय पदाधिका…" row, the attack board's #3 row).
**Fix:** dock it into the footer row on desktop (show on mouse move, fade after 3 s). On TV kiosk it is hidden. Never overlap content: reserve its height.

### C7 — Footer "honesty" line *(medium)*
**Found:** one amber line, 1.05rem, cut with `…`, stating data caveats ("दिखाया जा रहा है: 27 अक्टूबर…"). It is important but reads like small print.
**Fix:** split it in two.
1. A compact **data-age badge** inside the status pill (C2).
2. Caveats as an "ⓘ" chip that expands when focused.

Saved-copy notes ("सहेजा डेटा — अपडेट हो रहा है") get their own amber chip so they're noticed.

### C8 — Ticker *(medium)*
**Found:**
- The text slides under the orange label with a hard edge.
- The tags (राजनीति, चुनाव, सरकार) are .95rem.
- The source "— Times Now · 27 अक्टूबर, 15:25" sits on the same line, at the same weight as the headline.
- Raw feed text appears ("Date: 1st NovemberTime: 12:00 PM Where: Minto Road…").
- The label text differs per room (मीडिया से ताज़ा / ताज़ा सुर्ख़ियाँ / चुनाव · ताज़ा / ख़बरों में).

**Fix:**
- Fade masks at both edges of the track.
- Tag pill at the caption floor.
- Source in muted 85% size.
- A saffron "◆" separator between items.
- One label pattern: "LIVE · ताज़ा" with a pulsing dot (only when the news is under 1 h old).
- Clean the text (Q3).

---

## 3. Intro

### I1 — 1.5 s of near-black screen *(medium)*
**Found:** the first frame is a dark gradient with one tiny dot. The lotus/map animation only starts after that. On a slow TV it feels like the page is broken.
**Fix:** the brand mark (नज़र wordmark + BJP disc) is visible from frame 0 at 30% opacity and *builds* from there. The animation starts from something, not from nothing.

### I2 — Layers overlap during the hand-over *(low)*
**Found:** the stats row ("3,671 · 24 · 29.3 लाख") is still faintly visible behind the logo burst in the next phase.
**Fix:** fade the stats fully out (opacity 0 over 300 ms) before the burst.

### I3 — Stat labels tiny, skip hint tiny *(low)*
**Found:** the labels under the intro numbers and the bottom-right "skip" hint are ~10px at 720p.
**Fix:** labels at the caption floor. Skip hint as a visible key-cap chip "OK / Enter ⏎ छोड़ें" for 3 s, then dim.

### I4 — Total length ~9.5 s, every load *(medium)*
**Found:** the intro runs on every visit, including the 6-hourly soft reload.
**Fix:** full intro on the first visit of the day. After that, a 1.5 s **short sting** (wordmark + ring). The soft reload skips it (it already uses `nazar_skip_intro`; extend that to "seen today").

---

## 4. Start screen (नज़र बदलें)

### C4 — Media Room and Election Room are demoted to thin strips *(high)*
**Found:** two 1-line bars at the bottom with stock icons. Their descriptions are cut ("…विषय के हिसाब से, पू…", "…बाक़ी दिन पिछले नतीजे…").
**Fix:** a 2×2 grid of equal cards:

| Card | Shows |
|---|---|
| पूरा भारत | mini map + top state chips |
| एक नेता | search + photo row of 6 most-viewed leaders right now (from the snapshot) |
| मीडिया रूम | live preview: the newest 2 headlines cycling, source logos, "अपडेट 4 मिनट पहले" |
| चुनाव कक्ष | live state: "अभी कोई मतगणना नहीं · पिछला: उपचुनाव 9 अक्टूबर", or a red LIVE seat bar on counting day |

Real data in every card, no stock icons.

### C9 — Leader card mostly empty *(medium)*
**Found:** a search box, one "@myogiadityanath" chip (the handle, not the name or photo), and a large empty area.
**Fix:**
- Recent picks as photo + name chips.
- Below them, "अभी चर्चा में" with 6 avatars from the snapshot's trending leaders. One tap opens their channel.

### C10 — Search results *(low)*
**Found:** good structure, but the matched text isn't highlighted, the scrollbar is the white native one, initials avatars ("Y", "YS") are flat orange circles, and the party badge is far right.
**Fix:**
- Bold the matched part.
- Thin saffron scrollbar (`::-webkit-scrollbar`).
- Initials avatars tinted in the party colour.
- Party badge next to the name.

### C11 — State picker modal *(low)*
**Found:** a clean grid with activity bars. Lone last tile (J&K). No map. Bars are very thin.
**Fix:**
- Add a small map on the left, with hover/focus linking map ⇄ tile.
- Bars 2× thicker.
- Fill the last row (or centre it).
- Each tile shows the state's top party mark.

### C12 — Auto-start countdown ring *(low)*
**Found:** "20 सेकंड में अपने आप शुरू" with an empty ring. Good idea, weak visual.
**Fix:** the ring fills as a progress arc (SVG stroke-dashoffset), with the number inside it.

---

## 5. All India scenes (13)

| ID | Scene | Found | Fix |
|---|---|---|---|
| S1 | **एक नज़र में** (glance) | Leader photo at full strength through the cards (G1). A small 2-person card top-left with tiny avatars. 5 stat cards + a 5-figure "पूरा डेटा" strip, all the same weight. | A reserved leader column (G1). One **lead number** big (posts in 24 h), with the other 4 as a supporting row. The "पूरा डेटा" (all-time) strip becomes a quieter band. Leader highlights get 4rem avatars. |
| S2 | **भाजपा · पूरी तस्वीर** (focus) | Dense but good. Row labels ("विधायक", "लोकसभा सांसद") strong. The last row is cut ("अन्य (राष्ट्रीय पदाधिका…") and hidden under the controls (C6). Leader avatars at the right are tiny. | Fix overlap (C6). Let the row name wrap to 2 lines. Avatars at 3.6rem. Add a thin per-row share bar behind the numbers. |
| S3 | **कौन पोस्ट कर रहा है?** (posts) | The bars work, but logos are 14px, sub-lines are tiny, there's no rank number, "अन्य" has a grey dot, and the footnote is under the controls. | Rank numerals at left, party marks at 2.4rem, bar label inside the bar for the leader, sub-line at the caption floor, footnote above the controls. |
| S4 | **किसके पोस्ट सबसे ज़्यादा देखे गए?** (views) | Same template as S3, so the two read as the same screen. | Different form: a stacked 100% bar ("share of all views") at the top + the ranked list. That makes "share" visible, not just the rank. |
| S5 | **<party> में ट्रेंडिंग** (trend) | Nice podium cards. #1 card highlighted. The photo shows through cards #2/#3. Big empty space above the avatars. | Podium heights (#1 tallest), avatars bigger, and the views number with a small 24 h sparkline. Hero `off`. |
| S6 | (trend, other parties) | Same. Priyanka's avatar is a crowd photo. | See Q4 (avatars). |
| S7 | **सामान्य से कहीं बेहतर** (breakout) | A huge card with "3.2×" and a small crowd photo as R. Ashok's avatar. Big empty area. 3 runner-ups float with space above/below. | A **meter visual**: a horizontal track from "usual" (446) to "now" (1.4 हज़ार) with the multiplier as a badge. 4 runner-ups as compact rows with mini meters. The empty area is gone. |
| S8 | **सबसे ज़्यादा देखा गया पोस्ट** (top post) | A huge card holding one short quote ("सत्यम् शिवम् सुन्दरम्") + a number. Very empty. | A tweet-style card: large avatar, name, handle, time, the post text, the media thumbnail if the post had one, plus likes/reposts/views as three counters. Side: "इसी नेता की बाक़ी पोस्ट" (2 more) and the views pace. |
| S9 | **BJP और सरकार पर सबसे बड़े हमले** (attacks) | The strongest scene. Small issues: severity "5 /5 गंभीरता" is plain text, the "AI सार:" bar is small, the #3 row is cut at the bottom, "इसके बाद" (next) is tiny. | Severity as 5 pips that fill (red for 5). AI summary at body size. Fit #3 fully, or move it to a "next" strip. |
| S10 | **नेता कहाँ से पोस्ट कर रहे हैं?** (map) | The map is small in the left half with empty margins. No state labels. The legend is tiny. Only 6 states listed. The photo shows through. | The map fills 55% of the width. The top 6 states get callout labels on the map. The list ⇄ map highlight is linked (already), with a connecting leader line. Legend at the caption floor. Hero `off`. |
| S11 | **आसान शब्दों में** (facts) | A plain dot-bullet list: the most "AI-generated" looking screen. | "Front page" layout. Each fact is one row with its key number large in a left column (4,147 / 1.65 / 736 / 7.7 लाख / 3.2×) and the sentence on the right, divided by rules. Rows reveal one by one (stagger), TV-anchor style. |
| S12 | trending (INC etc.) | Same as S5. | Same as S5. |
| S13 | **empty** | The "no data yet" state. Not seen live. Plain message. | Use the loading card style (brand bar), plus "आख़िरी डेटा: <time>". |

---

## 6. Leader channel (8 scenes)

| ID | Scene | Found | Fix |
|---|---|---|---|
| P0 | **All scenes** | The background is the Modi + second-leader photo pair, even on Yogi Adityanath's channel. | In person mode the hero becomes the **leader's own photo** (the large avatar, cut circular, blurred bokeh-style via a pre-scaled image, not CSS blur), or `off` if no good photo. Never another leader. |
| P1 | **आज का हाल** (profile) | The top half is good. The lower ~40% of the card is empty. Stat tiles are plain. "0 रीपोस्ट" shown as a stat. Chips are tiny. | Fill with "today vs usual" mini bars per stat. Hide zero stats or soften them. Chips at the caption floor with icons (▲ ▼). |
| P2 | **कब पोस्ट किया?** (rhythm) | Two charts, readable. The hour chart is mostly empty lines. Axis labels tiny. The "–" for a missing day looks like a glitch. | A 24-hour **clock ring** (posts as ticks around a dial) instead of a mostly-empty bar row. Missing day: a hatched bar labelled "डेटा नहीं". |
| P3 | **उनका सबसे ज़्यादा देखा गया पोस्ट** | Same emptiness as S8. | Same fix as S8. |
| P4 | **वे कहाँ खड़े हैं** (rank) | Three hollow cards, each with a giant "#2 885 में से" (#2 of 885). 60% empty. | A **rank ladder** per context: the leader's row highlighted, with the person above and below shown (avatar + views). It shows the gap to #1. |
| P5 | **विरोधी दल** (rivals) | 4 cards. Quotes cut mid-sentence. Labels "पोस्ट / व्यूज़" tiny. Uneven text lengths make the cards unbalanced. | 2-line clamp for the quote. Stats as a pair of bold numbers with clear labels. Party colour edge on each card. |
| P6 | **BJP के साथी** (allies) | Identical to the trending template. | Fine to reuse; add podium heights as in S5. |
| P7 | **ख़बरों में** (news) | Two text columns of headlines. Section labels tiny. No logos or thumbnails. | Reuse the Media Room card style (M1) with thumbnails. Section labels as proper sub-headers. |
| P8 | **आसान शब्दों में** | Bullet list (as S11). | Same as S11. |

---

## 7. Media Room

### M1 — No images *(high)*
**Found:** 5 cards per screen, all text, each with a publisher logo + "समाचार माध्यम". The feeds (RSS / YouTube) usually carry a thumbnail (`media:thumbnail`, `enclosure`, YouTube `hqdefault`).
**Fix:** collect `img` in `media_room.js` when the feed has it. The lead card gets a 16:9 image on top, the small cards a left thumbnail. If there's no image, a typographic card tinted in the publisher's colour (not a grey placeholder). Images go through the existing site-icon proxy style (cached, size-capped).

### M2 — Headlines cut mid-word *(medium)*
**Found:** small cards cut at 3 lines ("…Missing People Ar…", "…his ba…").
**Fix:** small cards get 4 lines, with the font one step down. The lead card fits its full headline (`fitScene`).

### M3 — Card header noise *(low)*
**Found:** "समाचार माध्यम" ("news outlet") under every publisher is redundant. "The Times of I…" is cut because the "अभी आई" badge shares the line.
**Fix:** drop the redundant label. The "अभी आई" (just in) badge moves to the card's top-right corner as a red ribbon.

### M4 — Wrong topic shown *(medium, content)*
**Found:** "Maserati launches new Grecale…" under सरकार और योजनाएँ (Government & schemes).
**Fix:** see Q2.

### M5 — Source pages (`mr-src`) not reached in the loop at 1280×720 *(to verify)*
Check they appear on All India and look consistent with the cards.

### M6 — Settings panel *(medium)*
**Found (both rooms):** it opens over the live content with no dimming. The radio pills are good. The green "✓ आगे चलाएँ" button is off-brand (G4).
**Fix:** dim the backdrop (`rgba(10,3,1,.6)`), slide the panel in from the right (240 ms), make the CTA brand saffron, and add focus trap + remote navigation.

---

## 8. Election Room

### E1 — Past results cards *(medium)*
**Found:** 4 cards with party bars. Rows are dense and tiny. No majority marker on the bars. The winner isn't visually marked. Party names only as Hindi transliterations with a colour.
**Fix:**
- A **majority line** drawn across each card's bars (e.g. 64 of 126).
- The winning party row gets a gold check + bold.
- Party marks before the names.
- Values at body size.

### E2 — Bye-poll list card *(low)*
**Found:** "थट्टानचावाडी · Ashok Anand … एनआर कांग्रेस". The coloured dot is the only party cue, and the title is cut on phone ("विधानसभा उप…").
**Fix:** a party chip instead of a dot. The date chip wraps under the title on phone.

### E3 — Head-to-head (आमने-सामने) floats on the photo *(high)*
**Found:** no card behind it. The VS badge sits on the Modi photo. Candidates float on the background.
**Fix:**
- Put it on a card with hero `off`.
- Winner side with a soft party-colour glow and a "जीते" stamp. Loser desaturated 40%.
- The vote bar grows from the centre outward.
- The seat tabs at the bottom become larger chips with focus states.

### E4 — Live counting visuals *(to design before the next counting day)*
Today there is a replay demo only (Bihar 2025).
**Fix:**
- A **seat tally race**: bars moving toward the majority line, with the leading party's number pulsing when it changes.
- A "flip" toast when a seat changes leader ("⇄ सीट बदली").
- LIVE red dot + last-update time always visible.

### E5 — Election news *(high)*
**Found:** headlines sliced mid-line (G5). "Israel Elections 2026" included.
**Fix:** G5 + Q1.

### E6 — Top bar in the room has duplicate back buttons — see C1.

### E7 — Footer note "अभी कहीं मतगणना नहीं चल रही — पिछले नतीजे…" *(low)*
**Fix:** this is the key status of the room. Show it as the status pill (C2), not small print.

---

## 9. Phone & portrait (checked in a real 375×812 frame)

No horizontal scroll, and the layout holds.

| ID | Found | Fix |
|---|---|---|
| F1 | The top bar wraps to 3 rows (status, 24/48/72, speed) before any content. | On phone, one row: brand + "⚙" menu. Period and scope in a sticky chip under the header. Speed makes no sense on a scrolled phone page: hide it. |
| F2 | The leader photo still sits behind the cards while scrolling. | Hero `off` on phone below the first screen. |
| F3 | Election card titles cut ("विधानसभा उप…"), seat names cut. | Date chip on its own line. 2-line names. |
| F4 | The ticker label takes ~25% of the width. | Short label "ताज़ा" + dot on phone. |
| F5 | The floating controls overlap content when scrolling. | A bottom dock (safe-area aware) with prev / pause / next only. |

---

## 10. Loading, error, empty states

Partly done in `a341f1d`.

| ID | Found | Fix |
|---|---|---|
| L1 | The new loading card is plain (title + bar). | Use a **skeleton of the coming screen** for the rooms (card outlines with a slow saffron sheen), so the layout doesn't jump when data arrives. Keep the plain card for the main loop. |
| L2 | The "cannot reach server" overlay is a generic dark box with a button. | Brand it like the server's own "getting ready" page (logo disc, two lines Hindi/English, retry countdown "15 सेकंड में फिर कोशिश"). |
| L3 | "Leader not found" (nfT) and "no news" (mrNone) are plain text. | One empty-state component: an illustration-free typographic card with an action button. |

---

## 11. Motion plan (each animation must say something)

All are `transform`/`opacity` only, ≤ 600 ms, ease `cubic-bezier(.2,.7,.2,1)`, and off under `body.reduced`.

| Where | Today | Planned | What it tells the viewer |
|---|---|---|---|
| Scene change | The whole scene fades out 420 ms, cards rise. | The title wipes in (saffron underline draws left→right, 400 ms). Cards stagger in 60 ms apart. The progress rail segment advances. | "New topic now" |
| Bars (S3, S4, S2, E1) | All grow at once over 1.4 s. | Stagger 70 ms per row; numbers count up in sync with their bar. | Ranking order |
| Live number change | `tween` counts to the new value. | Plus a 600 ms gold flash behind the number and a ▲/▼ chip for 10 s. | "This just changed" |
| Rank moves (trending, S3) | None. | Rows re-order with a FLIP slide, and the moved row gets ▲2 / ▼1. | Who rose / fell |
| Breakout meter (S7) | None. | A marker slides from "usual" to "now". | How far above normal |
| Map (S10) | Fade-in. | States fill in rank order (1→6, 80 ms apart). The highlighted state's outline pulses once. | Where activity is |
| Attacks severity (S9) | None. | Pips fill left→right. | How serious |
| Duel bar (E3) | Static bar. | Grows from the centre to both sides. | Margin |
| Seat race (E4) | — | Bars glide toward the majority line. The line flashes when crossed. | Who wins |
| Status pill (C2) | Static dot. | Pulsing dot only when LIVE. | Is this live? |
| "आगे" card (C3) | Static text. | Slides in for the last 5 s. | What's next |
| Ticker (C8) | Linear scroll. | The same, plus edge fade masks. A new "BREAKING" item flashes the label red once. | Breaking news |
| Panels (M6) | Instant. | Slide from the right + backdrop dim. | Context kept |
| Intro (I1, I4) | 9.5 s every load. | Starts from the visible wordmark. A 1.5 s sting after the first visit of the day. | Brand, without the wait |

---

## 12. Content problems visible on screen

Data fixes, but they look like UI bugs.

| ID | Found | Fix |
|---|---|---|
| Q1 | "Israel Elections 2026", "Israel Election Result" in Election Room news and ticker, despite the "no foreign elections" filter. | Extend `ELEC_ABROAD` in `server.js` to cover Israel/Netanyahu and the other country names in current headlines. Add a test list. |
| Q2 | Maserati car launch under सरकार और योजनाएँ (Government & schemes). | The keyword tagger in `media_lib.js` matches "launches". Require a government actor (मंत्रालय, सरकार, PIB, Minister…) for that topic. |
| Q3 | Ticker shows "Date: 1st NovemberTime: 12:00 PM Where: Minto Road…". | When cleaning feed text, turn line breaks into " · " instead of nothing. |
| Q4 | R. Ashok's avatar is a crowd photo with several people; Priyanka's is a crowd shot. | An avatar quality pass: flag images where face detection fails or there are several faces, and prefer the leaders/ folder. A manual override list in `avatars_index.json`. |
| Q5 | "CJP" party in the views chart (5 accounts). | Check the master sheet for a typo'd party code. |

---

## 13. Product issues found along the way

| ID | Found | Fix |
|---|---|---|
| X1 | Shared links like `/live?h=myogiadityanath` or `?mode=media` silently open All India. Only `kiosk=1` keeps them (by design, to always start fresh). | Keep "fresh start" for bare `/live`, but let explicit share links work: e.g. `/live/n/<handle>`, `/live/media`, `/live/election` paths that always open that view. |
| X2 | The chooser auto-starts All India after 20 s even while someone is reading the state list. | Pause the countdown while the state list or the search is open (to verify how `tickChooser` handles it today). |

---

## 14. What I'm deliberately NOT adding

These would make it look more "AI template", not more like a product:

- No glowing gradient blobs, glassmorphism with heavy blur, or neon outlines.
- No gradient-filled text on headings.
- No emoji or generic icon packs (Lucide/Feather) as decoration.
- No confetti, particle bursts or 3D tilt cards on data screens. The intro keeps its existing lotus/rays; that is the brand moment.
- No parallax or scroll-jacking on phone.
- No shimmer skeletons on the main loop (only for room first loads, L1).
- No new fonts. Rajdhani + DM Sans + Noto Devanagari are a good set; the fix is size and weight discipline, not more faces.
- No animated backgrounds behind numbers.

---

## 15. Order of work

Each phase ends with screenshots at 1920×1080, 1280×720, 3840×2160, the 375 phone, and a keyboard-only pass.

| Phase | Contents | Size |
|---|---|---|
| **1. Foundations** ✅ done 30 Oct | G1 hero modes, G2 card levels, G3 type scale, G4 colour roles, G5 clamp helpers, G6 focus ring | Large: touches all CSS, ~1 day |

**Phase 1 — what was done (30 Oct):**
- **G1 photo levels.** `stage` (opening screen, start screen, message screens) / `quiet` at 10% (all data screens; it was 26–55%) / `off` (head-to-head duel). A leader's own channel never shows another leader's photo (P0, done early).
- **G2 cards.** Near-solid at 94% (from 82–86%). The #1 card of a screen (trending #1, party focus, breakout, lead news) has a lit top edge (green for breakout). Attack and official-news cards keep their own meaning-carrying top bars.
- **G3 type.** 107 TV/laptop sizes raised: ≤1rem → 1.2rem, 1.05–1.15 → 1.3rem, 1.2–1.25 → 1.35rem. Phone-only rules untouched. The posts chart and the map now fit at 93% scale.
- **G4 colour.** Role tokens `--cta / --cta-glow / --edge` added. The panel's main button is brand saffron (was green). Segmented toggles keep their saffron fill for now; the gold ring is used for focus (G6), not selection.
- **G5 clamping.** `fitClamps()` runs after every screen is fitted: text whose box is squeezed gets whole lines and ends in "…" (fixed 2 headlines in Election news and 4 in the Media Room at 1280×720). `.clamp-1/2/3` helpers added.
- **G6 focus.** A gold ring with glow while a remote/keyboard is in use (`body.kbd`, always on in kiosk); a mouse click or touch hides it.
| **2. Chrome** ✅ done 30 Oct | C1 top bar, C2 status pill, C3 "आगे", C5 progress rail, C6 controls dock, C7 footer, C8 ticker | Medium |

**Phase 2 — what was done (30 Oct):**
- **C1 top bar.** One settings button showing the period ("24 घंटे ⌄"; "सेटिंग" in the rooms) opens period · speed · language. Remote: arrows move inside it, OK chooses, Back closes. The duplicate "← वापस" in the rooms is gone. Phone top bar: 2 rows instead of 3.
- **C2 status pill.** Live pulses, fresh green, late amber, old red. A saved copy on screen shows "सहेजा · 15:34" in amber. "No counting now" in the Election Room stays neutral grey (normal, not a warning).
- **C3 next.** "आगे · <next screen>" in every mode; it lights up for the last 5 s of a screen.
- **C5 rail.** One segment per screen (one bar past 30 screens), the one on now fills, done ones gold. "2 / 13" at the right end of the footer row.
- **C6 controls.** Prev / pause / next / full screen are docked at the right of the footer row with space kept, so they no longer cover content. Hidden on TV kiosk; phone keeps the floating dock.
- **C7 footer.** Caveats are amber tags; the full text is in the row's tooltip.
- **C8 ticker.** Soft fade at both edges, ◆ between items, the source quieter than the headline, and a label dot that pulses only when the news is fresh.
- **G5 follow-up.** `fitClamps` now picks the most whole lines the box really holds (small news cards: 2 clean lines, before 2.4 sliced).
- **Found, not fixed:** `.er-alert` (the counting alert toast) uses flex `gap`, which Chromium 68 ignores. Fix with margins in phase 5.
| **3. Content fixes** ✅ done 30 Oct | Q1–Q5, X1, X2 | Small–medium (server + data) |

**Phase 3 — what was done (30 Oct):**
- **Q1 foreign elections.** `ELEC_ABROAD` in `server.js` now covers Israel/Netanyahu/Knesset, Iran, Russia, Ukraine, Turkey, Brazil, New York/Mamdani and more, with Hindi spellings. News digests ("Morning Brief", "Top Headlines") are dropped from election news (`ELEC_DIGEST`). Across all states × types: 296 headlines, 0 foreign or digest (it was 4).
- **Q2 wrong topic.** A topic can list `need` words (`media_lib.js` `makeTagger`). "Governance & schemes" now needs a government actor (सरकार, मंत्री, CM, cabinet, scheme…), so car and phone launches are out. AI labels still win where present.
- **Q3 run-together ticker text.** It came from YouTube **Shorts** titles. Shorts links are now treated as clips, like #shorts, and kept out of the Media Room and Election news (`isClip` in `media_room.js`). Labels run together in titles ("NovemberTime:") are split.
- **Q4 avatars.** The two flagged photos are the leaders' own X photos, so they aren't wrong files. Added `app/live_assets/avatars_override/` (a `<handle>.jpg` there wins) with a README listing the flagged handles; the team adds headshots with a known source. The avatar route now accepts only real handles, which also fixes a malformed `%`-escape that could have crashed the server.
- **Q5 "CJP".** Not a typo: the Cockroach Janta Party, with its own accounts. Journalist Rajdeep Sardesai is marked CJP in the master sheet, but he is already excluded as a journalist; the sheet entry could be cleaned at the source.
- **X1 share links.** `/live/media`, `/live/election`, `/live/n/<handle>`, `/live/s/<State>` (spaces or hyphens) open their view. A bare `/live` still starts on All India.
- **X2 chooser countdown.** Already worked: opening the state list or typing in search holds it. The audit note was wrong; no change.
| **4. Weak scenes** ✅ done 30 Oct | S7, S8/P3, S11/P8, P4, P0, P1, P2, S10 | Large |

**Phase 4 — what was done (30 Oct):**
- **S7 breakout.** The multiplier sits above a meter from usual views per post (grey, e.g. 446) to now (green, 1.4 हज़ार), with the green part growing in. Runner-ups (up to 4) each carry a small meter. A note says what "usual" means.
- **S8 / P3 top post.** A post card: author line, the post sized by length (a short line like "सत्यम् शिवम् सुन्दरम्" large), a soft quote mark. Beside it: views, likes, likes per 100 views. All India adds the post's share of all views ("8.9% of 4,147 posts"); a leader's channel adds their latest post when it is a different one.
- **S11 / P8 in simple words.** A front-page layout: each fact's number large in its own column (up green, down amber), the sentence beside it, rows coming in one by one.
- **P4 rank.** Three ladders (party, state, All India): #1, the one above, the leader (highlighted), the one below, "⋮" for the gap, and "N views behind #1" (or "ahead of #2"). The server now sends these neighbours (`rankIn` in `live_lib.js`).
- **P1 profile.** A "last 24 h vs a usual day" panel with paired bars for posts and views per post fills the empty lower half; zero stats are dimmed.
- **P2 rhythm.** A 24-hour dial (one spoke per hour, busiest hour in gold and named in the middle: "07–08 बजे"). Missing days are hatched "डेटा नहीं" instead of "–".
- **S10 map.** Numbered badges on the top 6 states, matching the list; the lit state's badge turns white. (A wider map column did not help: the map is height-bound.)
- Checked at 1280×720 (all fit; the profile and map need 92–94%) and on a 375 px phone (no sideways scroll).
| **5. Rooms** ✅ done 30 Oct | M1 thumbnails, M2–M6, E1–E7 | Large (M1 needs server work) |

**Phase 5 — what was done (30 Oct):**
- **M1 pictures.** `parseFeed` keeps each article's picture (`media:content` when it is an image, `media:thumbnail`, an image enclosure, an `<img>` in the description, or a YouTube thumbnail), https only, no tracking pixels. Tested on the live feeds: India Today, NDTV, ABP, News18, Indian Express, The Hindu, HT, TOI, Bhaskar and YouTube give pictures; Aaj Tak, Zee, Amar Ujala, PIB and Google News results do not. Pictures are saved for new headlines and added to known ones when they turn up again. Saved YouTube headlines get a thumbnail from their link right away. The lead card shows a picture band; small cards a faded picture behind the top. A picture that fails to load is removed and the card is text-only. **Render collects the news (`MEDIA_WORKER` on), so publisher pictures fill in as it collects after the deploy.**
- **M2.** Small cards may use 4 lines (`fitClamps` trims to the room there is).
- **M3.** "समाचार माध्यम" under every publisher is gone (stance labels and "official" stay). "अभी आई" is a red ribbon on the card's top edge.
- **M6.** The "what to show" panel dims the screen behind it and slides in.
- **E1 past results.** A colour mark before each party, a dashed majority line across every bar, the winning parties ticked, "बहुमत N" in the footer.
- **E2 bye-polls.** The winning party is a coloured chip.
- **E3 head-to-head.** It stands on a card now (the vote bar already grew from the middle; the winner glow and greyed loser already existed).
- **E4 counting day.** The tally (seat arc with majority mark, alliances, "past majority" headline, party table, flips) already covers it; checked with the Bihar 2025 replay. No change.
- **E7.** "No counting now" / "news only" notes are neutral grey tags, not amber warnings.
- **`.er-alert`** no longer uses flex `gap` (old TVs).
- The map badges were renamed `.mapb` (they shared `.mb` with the Election Room's party rows).
| **6. Start screen + intro** ✅ done 30 Oct | C4, C9–C12, I1–I4 | Medium |

**Phase 6 — what was done (30 Oct):**
- **C4 rooms.** The two room strips are live cards. Media Room: its 3 latest publishers' logos and the newest headlines one at a time (a green dot when the news is under 30 min old, amber when older). Election Room: what is being counted, or "पिछला नतीजा: <contest> · <date>" with that result as a seat bar and its majority mark. The stock icons stay as the fallback when there is no data. A full 2×2 grid did not fit at 720p, so the rooms stay a row of two (they now fit with the screen's bottom margin).
- **C9 leader card.** "अभी चर्चा में": the 5 most-viewed leaders as photo buttons (one press opens the channel), hidden while typing. Recent picks show face + name when known.
- **C10 search.** The typed part is gold in each result; slim saffron scrollbars (search, state list, room panel).
- **C11 state picker.** Activity bars almost twice as thick. (The state list has only post counts, so there is no lead-party chip.)
- **C12 countdown.** The seconds sit inside the filling ring.
- **I1.** The map's outline is drawn thicker and starts at once (the first 1.5 s were near-black).
- **I2.** The numbers came in as soon as the data arrived (~1 s), under the half-drawn lotus; they now wait for their moment (6 s, after the wordmark).
- **I3.** The skip hint is a visible key chip that dims after 4 s.
- **I4.** The full intro plays once a day per device; later opens get a 2-second sting (disc, ring, wordmark, tagline). `?intro=1` forces the full one, and a soft reload skips it as before.
- On phone: older `.ch-media` rules hid the new seat bar and shrank the Election Room title; both fixed. The All-India map on the start screen is 2rem shorter so everything fits at 720p.
| **7. Motion pass** ✅ done 30 Oct | Section 11, as one consistent layer | Medium |

**Phase 7 — what was done (30 Oct):**
- **Already there before this phase (checked, not changed):** live numbers count to the new value glowing gold, with the card pulsing ("bump") and a ▲ badge for rises; the duel bar grows from the middle; the LIVE dot pulses only when live. Phases 2–5 added the panel slide, the "next" highlight, the breakout meter and the intro.
- **New screen:** a short saffron line draws in under the title, and the time line fades in.
- **Bars:** party bars grow one after another, 70 ms apart, so the order reads as the ranking.
- **Rank moves:** "▲2" / "▼1" beside the rank on the trending cards and party bars when the order changed since the last loop. It stays 10 minutes and is kept per state and period (`rankMoves`, unit-tested).
- **Attacks:** severity is five dots filling left to right (the number stays in the tooltip and on the rows).
- **Map:** the numbered badges arrive in rank order (90 ms apart); the lit state's outline pulses.
- **Ticker:** the label flashes red twice when a BREAKING item appears that has not been shown before.
- Everything is `transform`/`opacity` (the map pulse uses stroke width), and all of it is off under `body.reduced`. No screen's fit changed.
| **8. Phone** | F1–F5, L1–L3 | Medium |

**How each change is checked:**
- Screenshot before/after per scene ID.
- An old-Chromium check (no flex `gap`/`clamp`, via a lint grep).
- `?scene=<id>&intro=0&kiosk=1` to open each scene directly.
- `body.reduced` check for every animation.
