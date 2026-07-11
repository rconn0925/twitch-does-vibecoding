# Stream Frame — Layout Spec & OBS Wiring
### "Twitch Does Vibecoding" · 1920×1080 · OBS (Chromium/CEF)
**Style:** *barely-there* — faint corner ticks + small section labels, nothing heavy.

`stream-frame.html` is a single self-contained file (inline CSS, no external requests, no JS).
The page background is fully transparent; it draws only faint corner ticks and four labels.

---

## 1. Final source rectangles (x, y, w, h)

The **AI terminal is widened** to line up under the app preview (was 760 wide → now 900),
so the center-left column reads as one block instead of leaving a gap. Everything else is as
handed off.

| Zone | Source | Rect (x, y, w, h) | Frame treatment |
|---|---|---|---|
| **App preview** (star) | browser source `:4902` | `620, 150, 900, 540` | 4 faint corner ticks + label `LIVE BUILD` |
| **AI terminal** | window capture | `620, 710, 900, 300`  *(widened)* | 3 ticks (TL/TR/BL) + label `THE AI` |
| **Twitch chat** | StreamElements chat widget | `1550, 150, 360, 780` | 1 tick (TL) + label `CHAT` |
| **What's coming** (queue) | browser source `:4901/queue` | `48, 150, 550, 420` | 2 top ticks + label `UP NEXT`, open bottom |
| Top band | live-data overlay only | full width, `y 0–140` | not decorated |
| Bottom-left | live-data vote panel (≤560w, grows up from y=1032) | — | kept clear |
| Bottom-right | live-data "NEXT UP" strip (right-anchored, 48px margin) | — | kept clear |

**One consequence of widening the terminal:** its right edge is now 1520, so the bottom-right
**NEXT UP** strip floats over the terminal's bottom-right corner (~110×70px) when it's on screen.
That's intentional and cosmetic — the terminal's live output (prompt + newest lines + cursor)
sits at the bottom-**left**, which is never covered. The frame therefore omits the terminal's
bottom-right tick (that corner is inside the NEXT UP zone). Keep the NEXT UP strip's left edge at
**x ≥ 1412** (its default at a 48px right margin) so the frame and strip stay consistent.

---

## 2. OBS layer order (top → bottom)

```
1. live-data overlay        (browser source — votes, countdown, pills, NEXT UP)   ← TOP
2. stream-frame.html        (this file — Local file browser source, 1920×1080)
3. Twitch chat              (StreamElements chat widget)
4. What's coming / queue    (browser source :4901/queue)
5. webcam                   (if any)
6. AI terminal              (window capture — now 620,710,900,300)
7. App preview              (browser source :4902 — the star)
8. background                                                                       ← BOTTOM
```

The frame sits **above** the content sources but **below** the live-data overlay, so vote
tallies, the countdown, the top pills, and NEXT UP always render on top.

### Adding the frame in OBS
1. **Sources → + → Browser → Create new**, name it `stream-frame`.
2. Check **Local file**, browse to `stream-frame.html`.
3. Set **Width 1920, Height 1080**; leave custom CSS empty.
4. Drag to layer position #2 (just under the live-data overlay).
5. Transform → Edit Transform → Position 0,0, Size 1920×1080, no scaling.

---

## 3. Reserved-zone verification

Rendered at exactly 1920×1080 on a transparent page, then every pixel inside each reserved
rectangle was scanned for any drawn (non-transparent) pixel:

| Reserved zone | Rect scanned | Drawn pixels |
|---|---|---|
| R1 top band | `0,0 → 1920,140` | **0** |
| R2 vote panel (max extent) | `48,500 → 608,1032` | **0** |
| R3 NEXT UP (at x ≥ 1412) | `1412,940 → 1872,1032` | **0** |
| Left safe margin | `0,140 → 48,1080` | **0** |
| Bottom safe margin | `0,1032 → 1920,1080` | **0** |

The frame draws nothing that assumes a live-data panel is present or absent: the queue is
**open-bottom** (ticks only at its top, so it never enters the vote-panel band that climbs to
y≈500), and no tick sits in the bottom-right NEXT UP band.

## 4. Design compliance
- Only faint neutral ticks `rgba(226,232,240,0.42)` + Dominant-backed labels (`#94A3B8`, 20px/600).
- **Violet `#8B5CF6` and red are not used** — violet stays reserved for the paid-control semantic.
- No amber/green either, so nothing competes with the live-data urgency/winner colors.
- 48px safe margins respected on every edge the frame draws to.
- No motion at all in this style (calmest option).

## Files
- `stream-frame.html` — the overlay (deliverable).
- `preview_final.png` — reference render over a full, populated scene (widened terminal).
