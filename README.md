# YouTube Highlight Player

A Manifest V3 Chrome extension that plays only the most useful or most-replayed
sections of a YouTube video. It's a **virtual trim**: nothing is downloaded,
edited, or re-uploaded. The extension controls YouTube's existing `<video>`
element and skips over unwanted time ranges during normal playback.

## Install (unpacked, for development/testing)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this folder
   (`youtube-highlight-player/`).
4. Open any `https://www.youtube.com/watch?v=...` page. A panel titled
   **YouTube Highlight Player** appears just above the video description.

## How it works

```
 detection strategies                     playback engine
┌─────────────────────┐   ranges   ┌──────────────────────────┐
│ heatmapStrategy      │──────────▶│ playerController          │
│ ("most replayed")    │           │ (listens to timeupdate,   │
│         ↓ fallback   │           │  seeks at range boundaries)│
│ chapterStrategy      │           └──────────────────────────┘
└─────────────────────┘                        ▲
         ▲                                      │
         │ raw page data                        │ activate/deactivate,
┌─────────────────────┐                         │ setRanges
│ pageBridge (MAIN)    │              ┌──────────────────────────┐
│  ↕ postMessage       │              │ content.js (orchestrator) │
│ dataBridge (isolated)│─────────────▶│  + panel.js (UI)          │
└─────────────────────┘              └──────────────────────────┘
```

- **`src/utils/rangeUtils.js`** — pure functions for interval math (select,
  sort, merge, pad, clamp, complement, find current/next). No DOM, no
  chrome.\*. Fully unit-tested (see below) since this is where a bug would
  silently produce wrong highlight ranges.
- **`src/utils/deepFind.js`** — bounded, cycle-safe structural search over an
  object graph. Used instead of hardcoded field paths so detection survives
  YouTube changing its internal data shape.
- **`src/detection/heatmapStrategy.js`** (Strategy 1) — parses YouTube's
  "Most replayed" heatmap into `{startTime, endTime, score}` samples by
  reading the SVG curve YouTube actually renders on the progress bar
  (`.ytp-heat-map-container` → `path.ytp-modern-heat-map`), **not** a JSON
  data object. An earlier version tried deep-searching `ytInitialData` /
  `getPlayerResponse()` for the heatmap and came up empty on a real video —
  verified by hand against a live page, it turns out YouTube resolves that
  data through an internal async "entity" system that never lands back in
  a plain object reachable from either of those. The rendered SVG, by
  contrast, is plain DOM and can't drift from what's on screen. Path
  parsing and coordinate math are pure functions tested against a real
  captured `d` string; only the "find the element" part touches `document`.
- **`src/detection/chapterStrategy.js`** (Strategy 2) — parses creator or
  auto-generated chapters (from `ytInitialData`) as a fallback when no
  heatmap exists. Unlike the heatmap, this data path hasn't been verified
  by hand against a live page — see Known limitations.
- **`src/detection/detectionManager.js`** — runs both strategies
  independently (`fetchRawSignals` returns `{heatmapSamples, chapters}`,
  never an exclusive "source" — see "Highlights + chapters together"
  below for why), and turns raw samples/chapters into playable ranges per
  the user's mode/percentage.
- **`src/content/pageBridge.js`** — runs in the page's own JS context
  (`"world": "MAIN"`) because chapter data and duration/video-id
  cross-checks come from YouTube's in-page objects (`ytInitialData`, the
  player's `getPlayerResponse()`); an isolated-world content script can't
  reach those directly. (The heatmap no longer needs this bridge at all —
  see above.) Only fetches raw data — no parsing logic here.
- **`src/content/dataBridge.js`** — isolated-world side of that
  `postMessage` handshake, with a timeout so a broken/absent bridge just
  looks like "no data" rather than hanging.
- **`src/player/playerController.js`** — the actual virtual-trim engine.
  Seeks to the next retained range's start when the current one ends (or
  when the user seeks into a skipped gap). Uses a seek-tolerance + cooldown
  to avoid seek loops, and never forces play/pause state. `jumpToNext()` /
  `jumpToPrevious()` (for the panel's nav chevrons + arrow keys) navigate
  by range index and work regardless of whether highlight mode is active —
  a manual jump, not tied to the auto-skip toggle.
- **`src/player/videoWatcher.js`** — waits for the `<video>` element and
  detects YouTube's SPA navigation (`yt-navigate-finish`, plus a 1s URL-poll
  fallback in case that event is ever renamed).
- **`src/ui/panel.js`** / **`panel.css`** — the control panel, redesigned as
  a glassmorphic HUD (fixed dark-glass look in both site themes — same
  reasoning as the timeline track and skip indicator: it's video-surface
  chrome, not page chrome, so it doesn't switch with YouTube's light/dark
  toggle). Circular gradient play/pause badge synced to the *real* video
  (via its own `play`/`pause` events, so it stays correct if you use
  YouTube's native controls or spacebar instead of ours); prev/next
  chevrons flanking it (labeled "chapter" or "highlight" depending on the
  *active source* — see "Highlights + chapters together" below — same
  jump-by-range-index mechanism either way, since `ranges` is already
  chapter- or heatmap-derived), plus `←`/`→` when the panel has focus; the
  "Play Selection Only" toggle (generic wording — covers both heatmap
  highlights and picked chapters); a collapse-to-pill button (click-based —
  see Known limitations for what a fancier drag-to-corner version would
  need); a compact footer (a "Highlight N/M" / "Chapter N of M" pill,
  whichever matches the active source, with mini progress dots, and a
  mint-tinted time-saved chip with a small progress ring) in place of the
  old plain status text, still falling back to plain text for the
  "highlights off" / "no segments selected" cases dots and rings don't
  apply to. The no-data case (neither a heatmap nor chapters ever showed
  up) gets its own footer content instead of that plain text — a "Check
  again" /
  "Dismiss" action pair, not a second, shorter copy of the empty-state
  message already shown above it (an earlier version repeated it, which
  read as the panel restating itself). "Check again" re-runs the whole
  per-video detection pipeline (`init(videoId)`, the same path a real
  navigation or a corrected duration already triggers) — useful because
  "no data *yet*" usually means YouTube's own "most replayed" data hasn't
  populated for a brand-new upload rather than never will. "Dismiss"
  collapses the panel the same as the header's own minimize button, since
  there's no timeline/chapters to interact with for this video regardless.
  No settings (gear) affordance — mode/amount are fixed
  (`FIXED_MODE`/`FIXED_PERCENTAGE`), nothing to configure yet. The timeline
  row only mounts when a heatmap exists — no-data (and a chapters-only
  video, until/unless a heatmap later arrives — see below) doesn't have a
  curve to show, so it's omitted rather than rendering as an empty
  rectangle. The chapter picker matches that same
  visual language: custom gradient checkboxes (not OS-default squares) in
  a glass-surfaced list; unchecked chapters dim their title/timestamp so
  included-vs-excluded reads at a glance; each row is two separate hit
  targets — the checkbox toggles inclusion, the rest of the row (title +
  monospace timestamp) seeks there, deliberately not one shared `<label>`
  wrapping both, which would make clicking the title also toggle the
  checkbox; whichever chapter's own time range currently contains the
  playhead gets a violet→magenta left accent bar + brighter/bolder text,
  live on every tick, independent of which chapters are checked
  (`updateActiveChapterRow`, reusing `RangeOverlay.findRangeAt` since a
  chapter is just another `{startTime, endTime}` span). One real bug fixed
  along the way: `rangesFromChapterSelection` (detectionManager.js) used to
  fuse two adjacent *selected* chapters into a single range whenever they
  touched at a shared boundary (the normal case — one chapter's `endTime`
  equals the next one's `startTime`), which would silently undercount the
  "Chapter N of M" pill and skip a step in prev/next nav; the merge gap is
  now floored just below zero so a shared boundary alone never merges,
  only genuine overlap (e.g. from nonzero padding) still does.
- **`src/ui/rangeOverlay.js`** — draws the intensity-curve timeline and
  owns all of its interaction. The curve fill/stroke use a violet
  (`#7B5CF0`) → magenta (`#D24FC8`) gradient positioned by score, so
  density peaks read as magenta against a violet baseline — a deliberate
  return to color after two earlier passes (cold-to-warm blue/red, then a
  four-stop rainbow) had both been tried and dropped in favor of
  monochrome; this pass reinstates color on request. Every *retained*
  segment is guaranteed a minimum visible bump — `floorScore()` remaps
  its real score onto `[HIGHLIGHT_FLOOR, 1]` before the curve is built
  (`buildCurvePoints()`), so a weak-but-real highlight still reads as a
  small, clickable peak instead of flattening into the baseline; a
  skipped gap is never floored, since there's genuinely nothing there.
  Stronger highlights still scale above that floor by their actual score,
  so intensity differences stay legible. Of the *retained* segments, the
  one currently playing is called out by `paintActiveOverlays()`, which
  gives a pulsing drop-shadow glow to `buildActiveGlowPathD()`'s output —
  since every peak is now visible on its own, this is a highlight *on* the
  curve rather than a separate filled shape behind it, so there's no
  background rectangle competing with the playhead. That glow path is the
  real curve, *trimmed* to the active range's exact time bounds via De
  Casteljau bezier splitting (`trimCurveToXRange`) — deliberately not a
  fresh curve re-fit from just the points inside that range (an earlier
  version's bug: a short highlight with only 1-2 points inside it starves
  Catmull-Rom of tangent context from its neighbors, so it degenerates
  into a near-straight line even though the real curve there isn't flat at
  all — a short highlight's glow looked like a flat pill instead of a
  peak), and deliberately not a clip-path'd copy of the whole curve either
  (clip-path clips an element's already-filtered output, so it sliced the
  drop-shadow's blur off in a hard rectangle right at the segment's
  boundary — a visible straight edge against the dark track instead of a
  taper). Trimming the real, already-correctly-shaped curve fixes both:
  it matches the visible curve exactly regardless of how few raw samples
  fall inside a short range (even zero), and its own two round-linecap
  ends are simply where the glow radiates from, with no boundary to clip.
  A live playhead (vertical line + handle) tracks real playback position
  continuously, independent of highlight mode being on.
  The whole track is one pointer-drag target (not just a thin handle):
  while "Play Selection Only" is on, any point resolves to the *nearest
  retained range's start* (`snapToNearestRange`) rather than a raw gap
  position — there's nothing to play in a gap, so it snaps instead of
  doing nothing; with the toggle off, every point is used as-is (free
  scrub, like a normal seekbar) — gaps only mean something while the tool
  is actually skipping them. (An earlier version also best-effort drew
  onto YouTube's own native progress bar; that's been removed — the
  panel's own timeline is the only visualization now.)
- **`src/ui/skipIndicator.js`** — a "+N ›" overlay centered directly on the
  video player (not the panel), shown for about a second whenever
  `playerController` performs an automatic skip. Deliberately mirrors
  YouTube's own double-tap seek indicator (big plain text + chevron, no
  background box) rather than a corner badge — same place viewers already
  expect this kind of feedback.
- **`src/ui/nativeToggleButton.js`** — a second entry point for the same
  "Play Selection Only" toggle, injected into YouTube's own right-hand
  control cluster (alongside CC/settings/theater/fullscreen) rather than
  only living in the panel. Verified against a live page's current
  "Delhi" player redesign — see the file's own header comment for the
  real DOM shape and a since-fixed insertion bug found that way.
- **`src/content/content.js`** — orchestrator. On every video-id change:
  tears down the previous video's listeners/UI, waits for the new
  `<video>`, and mounts the real panel shell immediately — before page
  data, duration, or detection have even started (see "The widget shell
  renders before any of this" below). Detects chapters and the heatmap
  independently (see "Highlights + chapters together" below) and reveals
  real content the moment either is known, rather than waiting for both.
  Separately, it listens for the video's own
  `durationchange` event and fully reinitializes if the duration actually
  changes — some videos report an initial/estimated duration that gets
  refined once more of the manifest loads, and everything computed against
  the stale value (range boundaries, the timeline's x-axis mapping) would
  otherwise quietly drift out of sync with the real video length. Set
  `localStorage.setItem("yhp_debug", "1")` and refresh to see step-by-step
  `[YHP]`-prefixed logging of this whole sequence. Also wires the play
  badge and live playhead to the video's own `play`/`pause`/`timeupdate`
  events (always-on, independent of `playerController`'s active state —
  the playhead needs to track real playback even with highlight mode off)
  and forwards the panel's `previous`/`next`/`playPause`/`collapsedChange`
  events to the controller / real `<video>` / `Store` respectively.

### Highlights + chapters together

A video can have both a heatmap and chapters at once — they answer
different questions (topic structure vs. "what's worth watching") and
their boundaries rarely align, so rather than merging them into one
visualization with two competing selection states, the panel shows a
small "Highlights" / "Chapters" tab switcher (`yhp-source-tabs`) and
reuses the existing timeline and chapter-list components as-is, just
toggling which one is visible. Neither is ever rebuilt when switching —
both exist in the DOM at once whenever both sources do.

This needed a real data-layer fix, not just a UI one:
`DetectionManager.fetchRawSignals` used to return an *exclusive*
`source: 'heatmap'|'chapters'|'none'` — it only parsed chapters at all as
a fallback when the heatmap came back empty, so there was no way to even
detect "this video has both." It now runs both strategies independently
every time and returns `{heatmapSamples, chapters}` — both are just
independent facts about the video, and it's up to the caller (now
content.js + panel.js, not detectionManager.js) to decide what to do when
both are true.

That mattered for a second reason, not just the tab switcher: chapters
come straight from page data already fetched in full before detection
starts — there's nothing to wait for, a video's chapter list (or lack of
one) is known for certain on the very first check. The heatmap needs a DOM
element YouTube populates asynchronously, observed taking several seconds.
An earlier version of this file waited for the *slower* one (heatmap, up
to 8s) before rendering anything at all, even when chapters were ready
almost instantly. Fixed by kicking off both independently and revealing
the moment either resolves:

- **Both known already, or heatmap resolves first** (rare — chapters are
  essentially always faster): reveals with the tab switcher immediately,
  defaulting to the Highlights tab.
- **Chapters resolve first, heatmap still pending** (the common case): the
  panel reveals chapters alone, no tab switcher yet (there's nothing to
  switch to), while the heatmap keeps polling quietly in the background
  for the full budget. If it does arrive, `panelApi.upgradeToHeatmap()`
  reveals the tab switcher and — this is the one auto-switch heuristic
  worth knowing about — auto-selects Highlights *unless* the viewer has
  already interacted with the chapters view (checked/unchecked a chapter,
  pressed play, navigated prev/next, toggled "Play Selection Only", or
  clicked a chapter to seek — tracked as `chaptersInteracted` in panel.js).
  If they have, it just surfaces a small "new" dot on the Highlights tab
  instead of yanking away something actively in use. Heatmap wins by
  default; it never wins by surprise.
- **Heatmap never arrives, chapters already showing**: no change — chapters
  stays the final view, exactly as if the heatmap never existed.
- **Neither ever resolves**: the existing empty state, reached through the
  same `reveal()` call site as everything else, just with two empty arrays.
- **A `addChapters()` counterpart to `upgradeToHeatmap()` does not exist,
  deliberately** — chapters are always fully known the moment detection
  starts (see above), so there is no "chapters arrive later" case to
  support; adding one would be dead code.

### The widget shell renders before any of this — always

A version of the fix above still had a real bug: `Panel.mount()` itself
wasn't called at all until *something* — chapters, a heatmap, or a
confirmed "neither" — was already known, via a separate, reduced
placeholder element content.js swapped out afterward. That placeholder
only had a bare title, not the real header — so the actual interactive
shell (nav arrows, play badge, toggle, collapse icon) still didn't appear
until detection did, which defeated the entire point of rendering early:
up to 8 seconds of a widget that doesn't look or behave like the real
thing yet.

Fixed by inverting which side owns "pending": `Panel.mount()` itself now
always starts in a pending state and content.js mounts it immediately,
right after the `<video>` element and stored settings are available —
before page data, duration, or any detection has even started. The
header and footer are the real, fully interactive ones from that first
frame; only the content area (where the timeline, chapter list, or tabs
would go) shows a neutral shimmer skeleton (three thin, varied-width
lines — `.yhp-skeleton-bar` in panel.css — not a shape that commits to
being a timeline or a chapter list, since which one, if either, is coming
isn't known yet). `panelApi.revealSignals(signals, duration)` is the one
way out of pending, called by content.js exactly once, whenever it first
has anything to show — real data, or the confirmed-empty case. Everything
above (the tab switcher, the four reveal scenarios) is what `revealSignals`
and `upgradeToHeatmap` actually build once called; they no longer decide
*whether* the panel exists, only what's inside it.

### Adding a new strategy later (transcript analysis, SponsorBlock, ...)

Add a module with the same shape as `heatmapStrategy`/`chapterStrategy`
(`parseX(pageData) -> samples`, `isAvailable(pageData) -> bool`) and slot it
into `detectionManager.fetchRawSignals`'s fallback chain. Nothing else needs
to change — `playerController`, `panel.js`, and `rangeUtils` are all
strategy-agnostic.

## Modes

Mode and highlight amount are fixed, not user-configurable: always **most
replayed** (keep the top-scoring heatmap segments), always the **top 30%**.
(`detectionManager.computeHeatmapRanges` still supports a `skip-filler` mode
and an arbitrary percentage — those were user-facing controls originally,
removed for simplicity — so re-exposing them later is just UI work, not a
detection-logic change.)

The chapters view (used automatically when a video has no heatmap, or
alongside one via the tab switcher — see "Highlights + chapters together"
above) lets you check/uncheck individual chapters instead.

## Default state on a fresh install

`highlightsEnabled` (`src/state/store.js`'s `DEFAULTS`, seeded on install by
`src/background/background.js`) defaults to **on**, not off. That's a
deliberate reversal of the original default: with it off, a first-time
install looked identical to plain YouTube until the viewer happened to
notice a toggle sitting below the player — a low-attention part of the
page — and flipped it themselves. Nothing about the extension's actual
*value* is visible until that happens, which is a real activation risk for
something meant to grow through cold installs off a Store listing rather
than word-of-mouth from someone walking a friend through it.

Flipping the default alone would trade one problem for another — playback
suddenly skipping around with zero explanation reads as broken, not
helpful — so it's paired with a one-time onboarding moment
(`panel.js`'s `onboardingCard`, gated on a stored `introSeen` flag,
persisted through the same `Store`/`chrome.storage.sync` every other
setting here already goes through) the first time a heatmap is the
*active* view. Gated specifically to heatmap, not chapters: chapters mode
starts with every chapter checked, so turning the toggle on there doesn't
skip anything yet — claiming "now skipping to the best parts" would be
false in that case. Scoped to mount time only, deliberately not
retroactive: if a heatmap arrives *after* the panel already mounted on
chapters alone (see "Highlights + chapters together" above) and
auto-upgrades the active view, this doesn't retroactively fire — one
"first-run" moment is enough; layering it onto a mid-session tab upgrade
too would be a second surprise, not a clarification of the first.

That onboarding is a **spotlight**, not a floating label: a
`.yhp-panel--onboarding` class dims everything else in the panel (title,
timeline, footer stats, the collapse icon) to ~30% opacity while the
toggle stays at full brightness and gets a soft pulsing glow ring — the
same ambient-glow language as the header's own play badge — so the
control being described visually pops forward on its own, rather than a
separate text bubble having to do that job for it. A small "Tip" card
(sparkle icon + one line of copy + a gradient "Got it" button, matching
the toggle's own gradient) sits in the open space below the header. A
first version used a text bubble with a connector pointing at the toggle,
an 8-second auto-dismiss timer, and a small close icon; dropped for three
concrete problems: the connector didn't read as clearly pointing at
anything, the bubble overlapped the footer's live stats row (hiding the
exact content it was explaining), and the toggle itself carried no visual
emphasis of its own. Dismissal is now only ever explicit — the "Got it"
button, or directly interacting with the toggle through either entry
point (the panel's own switch or the native control-bar button, both of
which count as "got it") — never a timer.
`@media (prefers-reduced-motion: reduce)` keeps the dimming and the card
(this is still a one-time moment worth surfacing) but drops the pulse and
entrance-slide in favor of a static glow and an instant appearance.

This only affects genuinely fresh installs: `chrome.storage.sync`'s own
get-with-defaults semantics mean an existing install's already-stored
`highlightsEnabled` value is never overwritten by a `DEFAULTS` change.

## Tests

The interval-math core, the object-graph search, both detection strategies'
parsing logic, the `ytInitialData` HTML-extraction helper (see the fifth
"Known limitations" finding below), the error reporter's DSN-parsing/
scrubbing/id-generation helpers, the analytics module's id-generation and
init-gating logic, and the player controller's skip/anti-loop behavior are
covered with `node:test` (no browser needed):

```bash
npm test
```

128 tests, all passing as of this build.

## Icons

`manifest.json` references four sizes — `icons.16/32/48/128` and
`action.default_icon.16/32/48/128`, the same four both places. The 32px
one exists specifically for the toolbar action icon on HiDPI/Retina
displays: Chrome renders that icon at 16 CSS px, but a 2x-density screen
needs a real 32px source to stay sharp there — without one (an earlier
build shipped without it), Chrome upscales the 16px PNG and the icon
visibly blurs in the toolbar on any Retina screen. Source of truth is
SVG, not hand-produced PNGs:

Four attempts at a "highlight" motif on top of the triangle were tried and
dropped before landing on the current, much simpler design:

1. An arc + two corner "ticks" — read as a smile or a cup/bowl.
2. Three uniform, evenly-spaced scallop bumps — read as decorative
   ornamentation rather than "highlights," precisely *because* they were
   identical and repeated; also too low-contrast to survive shrinking.
3. A single glowing, asymmetric peak (steep rise, gentle fall) reusing the
   timeline's own active-highlight stroke+glow treatment, mostly hidden
   behind the triangle — better than 1-2, but still a second motif for a
   toolbar-sized mark to resolve at a glance.
4. **(current)** No second motif at all: a solid rounded-corner triangle,
   with a soft ambient glow sitting *behind* it as atmosphere rather than
   drawn as an outline/highlight shape in its own right — the same pattern
   the redesigned overlay's own play badge already uses (solid shape,
   glow behind it, glow never load-bearing). Simplest option tried, and
   the lowest-risk: the glow is honestly decorative — cover it and the
   triangle alone is still perfectly legible, unlike every earlier attempt
   where the "highlight" detail carried real meaning that would be lost
   without it.

- `icons/src/icon-simple.svg` — toolbar-size variant (16px): the solid
  triangle, no glow. Needs no separate fallback logic beyond that — the
  triangle itself doesn't change across sizes, only whether the (already
  subtle) glow layer is present, and a glow this soft doesn't register at
  16px anyway. Confirmed by rendering the actual 16×16 output directly
  (crisp, high-contrast, no artifacts) and a temporary 32×32 render (the
  rounded corners are clearly visible at that size, confirming the
  rounding survives scaling down, not just up from 128).
- `icons/src/icon-detailed.svg` — 48px and the 128px Web Store listing
  icon: the same triangle, plus a soft radial-gradient glow behind it
  (`#ffffff` fading to fully transparent well inside the canvas edge —
  same reasoning as every other soft edge in this project: an SVG
  filter/blur needs real margin inside its own filter region or the edge
  gets clipped into a hard boundary, the exact bug fixed on the
  in-product timeline glow; see `buildActiveGlowPathD`'s comment in
  `rangeOverlay.js`). A gradient's outer stop is already fully
  transparent, so it tapers to nothing by construction, no filter needed.

Both variants build the triangle's rounded corners the same way: a filled
path stroked with its own fill color at `stroke-linejoin: round` (a
standard "rounded polygon" technique) rather than hand-built arc-cornered
path geometry. The triangle itself went through two size passes, both
shrinking it further — first sized closer to YouTube's own icon (a
compact glyph with real breathing room around it on the chip, not a
shape that fills most of the canvas), then trimmed a little smaller still
— rather than the much larger proportions carried over from the first
icon pass.

Contrast checked by compositing the rendered icon over both a light
(`#F1F3F4`) and dark (`#35363A`) neutral toolbar background — the icon is
fully opaque (not a theme-adapted mask icon), so it renders identically
either way; the saturated violet→magenta chip and near-white
(`#FDFBFF`) triangle both read cleanly against either.

Both source SVGs render to PNG via:

```bash
npm run build:icons
```

This didn't exist before this pass — the three `icons/*.png` files were
previously hand-produced raster images with no source to regenerate them
from. `scripts/build-icons.js` uses `@resvg/resvg-js` (a Rust SVG renderer
with prebuilt native bindings, added as a devDependency) rather than
shelling out to a system tool (`rsvg-convert`/Inkscape/ImageMagick, none
guaranteed installed) or a headless-browser screenshot (heavier than this
deterministic a step needs) — `npm install` alone is enough to reproduce
every PNG on any machine.

## Packaging for the Chrome Web Store

```bash
npm run package
```

Rebuilds the icons, then stages exactly the files `manifest.json` itself
references — `manifest.json`, the three `icons/*.png`, and every file
listed under `background`/`content_scripts` — into `dist/package/`, and
zips that into `dist/<name>-<version>.zip`. That zip is what you upload to
the [Developer Dashboard](https://chrome.google.com/webstore/devconsole);
nothing else in the repo (`node_modules`, `icons/src`, `scripts/`,
`tests/`) ships, and none of it needs deleting from the working tree to
get there — the packaging step builds a clean copy elsewhere instead of
requiring the repo itself to only contain what ships.

`scripts/build-package.js` reads the shipped file list *from*
`manifest.json` at run time rather than hardcoding a second copy of that
list — a hardcoded list would silently go stale the moment a new content
script or icon size is added to the manifest without a matching update
here. Zips via the system `zip` CLI (`-X`, so the archive doesn't embed
uid/gid/timestamps and stays reproducible regardless of which machine
built it); if `zip` isn't installed, it says so and leaves the staged,
ready-to-zip files at `dist/package/` for a manual zip instead of failing
silently.

Remember to bump `manifest.json`'s `version` before packaging a real
release — the Chrome Web Store rejects a re-upload with an unchanged
version number.

## Error reporting

`src/telemetry/errorReporter.js` sends genuinely uncaught exceptions and
unhandled promise rejections to Sentry — on by default, disclosed in the
store listing's privacy section (no separate settings toggle exists yet;
that's straightforward to add later if wanted). Hand-rolled against
Sentry's plain HTTP "store" ingest API rather than their SDK, to keep the
project's no-build-step, vanilla-JS architecture intact — verified for
real against a live Sentry project during development (endpoint, the
`X-Sentry-Auth` header, CORS preflight behavior for a browser `fetch()`,
and the exception/stacktrace JSON shape were all confirmed with real
requests before being wired in, not assumed from docs).

Deliberately narrow in *what* gets reported: YouTube's DOM/data being
unstable — no heatmap container, no chapters, a bridge timeout — is
expected and already handled with graceful fallbacks throughout the
detection code, and none of that should ever show up as an "error" here.
`installGlobalHandlers(target, context)` is called once each in
`content.js` (on `window`, `context: "content"`) and `background.js` (on
`self`, `context: "background"`, loaded via `importScripts` since the
service worker isn't part of the content-script bundle) — this catches
real bugs (a thrown `TypeError`, `init()` failing past all its own guards)
without needing to instrument every existing `try/catch` individually,
most of which are intentional fallbacks rather than bugs.

Privacy: never sends video IDs, titles, URLs, or page content — only the
error's own message/stack, the extension version, and which context
(content script vs. background) it came from. `scrubText` strips anything
shaped like a YouTube video id or a youtube.com URL from error text/stacks
as a defensive second layer, in case a future error message ever happens
to include one (none currently do — checked by hand across the codebase's
existing `throw`/error-message call sites, and covered going forward by
`errorReporter.test.js`'s scrubbing tests). Also rate-limited
(`MAX_REPORTS_PER_SESSION`, 10) and deduplicated per session (by error
type + message + first stack frame) so one repeating bug can't blow
through Sentry's free-tier quota.

## Analytics

`src/telemetry/analytics.js` sends a short, curated list of feature-usage
events to PostHog — same hand-rolled-against-the-plain-HTTP-API approach
as error reporting (no SDK, no build step), same verification discipline
(the `/capture/` endpoint, CORS preflight behavior, and the event JSON
shape were all confirmed with real curl requests against a real PostHog
project — including that `$process_person_profile: false` still counts
an event toward trends/uniques without building a full identity-resolution
"Person" profile — before this was wired in).

Unlike error reporting, this one ships with a **visible opt-out**: the
gear icon in the panel header (`panel.js`'s settings popover) toggles
`analyticsEnabled` (see `store.js`'s `DEFAULTS`), on by default but a real
control, not a technicality — tracking *what people do* is exactly the
case users and reviewers expect one for, unlike incidental crash data.
Flipping it takes effect immediately in the current tab (`content.js`'s
`analyticsToggle` case calls `Analytics.init()` again on the spot, not
just on the next navigation).

The event list, deliberately short:

| Event | Fired when | Properties |
|---|---|---|
| `extension_installed` | `background.js`'s `onInstalled` (fresh installs only) | — |
| `detection_result` | `content.js`'s `reveal()`, once per video | `has_heatmap`, `has_chapters` |
| `highlights_toggled` | The panel toggle or native control-bar button — real user actions only, never a programmatic set | `enabled` |
| `check_again_clicked` | The empty-state "Check again" button | — |
| `onboarding_shown` / `onboarding_dismissed` | The first-run tip card (see "Default state" below) | — |
| `source_tab_clicked` | Highlights/Chapters tab click (videos with both — see "Highlights + chapters together") | `to` |
| `support_link_clicked` | The "Send a tip" link in the settings popover's "Support" section (see "Support links" below) | `platform` |

Same privacy discipline as error reporting: never a video ID, title, URL,
or anything else about what someone is watching — every property above is
the entire list, nothing else rides along. The anonymous `distinct_id`
lives in `chrome.storage.local` (not `chrome.storage.sync`, deliberately —
an anonymous per-install id has no reason to follow the user's Google
account across devices the way real settings do), generated once by
`background.js` at install and lazily by `analytics.js` itself for
installs that predate this feature (an *upgrade*, unlike a fresh install,
never fires `onInstalled` with `reason: "install"`, so there's no single
reliable moment to seed it for those).

One real bug this caught during development, worth recording: the
settings popover and the onboarding tip card (see "Default state on a
fresh install" above) both anchor to the exact same spot below the
header — a real screenshot of the actual panel showed them rendering on
top of each other, since a first-time viewer can click the new gear icon
before ever dismissing the tip. Fixed by having `setSettingsOpen(true)`
call `acknowledgeOnboarding()` — opening settings is itself deliberate
engagement with the panel, so it counts as "got it" the same way the
toggle already does.

Also worth noting: an earlier version of `iconGear()` used a circle plus
eight thin radiating lines, which rendered as a sun/brightness icon
rather than a gear — caught from a real screenshot (a user's, not a
mockup), not by re-reading the SVG path and assuming it was right.
Rebuilt as an actual ring + six rotated-rect teeth + a center hub.

### Support links

The same settings popover has a "Support" section — `SUPPORT_LINKS` in
`panel.js`, currently a single Ko-fi link — entirely optional, no feature
is gated behind it. Its label deliberately says "Send a tip," not the
platform name — the point is what the link *does*, not which payment
processor happens to be behind it. Still a list, not a single hardcoded
URL, even with one entry: adding a second platform later (GitHub
Sponsors was considered, deliberately left out for now) stays a one-line
addition, not a UI change. Each link is a real `<a>` (native new-tab/
middle-click behavior, no JS navigation) with a `supportLinkClicked` →
`Analytics.track("support_link_clicked", {platform})` side-effect
layered on top, so there's real signal on whether anyone actually clicks
through — without that being a condition of the link working at all.

## Known limitations / what to verify manually

- **Heatmap detection has been verified against a live page.** The DOM
  shape (`.ytp-heat-map-container` → `.ytp-heat-map-chapter` →
  `path.ytp-modern-heat-map`) and the parsing/coordinate math were checked
  by hand against a real YouTube video with "most replayed" data — the
  initial JSON-object-based approach was found to be wrong this way (it
  silently found nothing) and was replaced with the SVG-reading approach
  described above. Still worth spot-checking on a few more videos, since
  this is unofficial DOM structure YouTube could change without notice —
  if `.ytp-heat-map-container` ever gets renamed, detection degrades to
  "no data" rather than breaking, but silently loses heatmap support until
  updated.
  A second live finding, from a real "works on 'Check again' but not on
  first cold load" report: `.ytp-heat-map-container` reliably appears in
  the DOM almost immediately, but as an *empty shell* — YouTube populates
  the actual `<path d="...">` curve data inside it a few seconds later,
  confirmed via a captured debug log (container present with 0 parsed
  samples, then real samples ~3s after). `content.js`'s `detectWithRetries`
  used to treat the container's mere existence as "ready" (a single fixed
  retry after a fixed delay), which only worked when that delay happened
  to be long enough — racy by construction. Fixed by polling
  `fetchRawSignals` itself on a short interval for several seconds after
  the container appears, rather than trying to catch the DOM mutation that
  fills the path in (which `waitForElement`'s `childList`-only
  `MutationObserver` might miss entirely if YouTube sets the attribute on
  an existing node rather than swapping it) — see that function's comment
  for the exact numbers and reasoning.

  A third live finding, from a chapters-but-no-heatmap video: an earlier
  version of this polling loop had no way to know a video would *never*
  produce a heatmap — it just burned the full 8s budget every time before
  ever *rendering* chapters, even though the chapters themselves (read
  straight from the already-fetched `pageData`, no DOM wait needed) were
  known for certain on the very first check, elapsed 0ms. Confirmed via a
  captured debug log showing chapters resolved at every single poll from
  0ms to 8000ms, with `heatmapSamples: 0` throughout — an 8-second wait
  before showing a signal that logging proved was ready the whole time. A
  first fix shortened the heatmap-wait budget once chapters were known to
  exist, trading some heatmap patience for a faster chapters fallback.
  That's since been superseded by a better fix in the same direction taken
  further: content.js now renders chapters *immediately* the moment
  they're known, full stop, and lets the heatmap keep polling for its full
  budget (`HEATMAP_POLL_BUDGET_MS`, currently 4s) quietly in the
  background regardless — there's no longer a wait to shorten, since
  nothing is blocked on it anymore. See "Highlights + chapters together"
  above for the current architecture.

  A fourth live finding, from a real "navigate to a different video and
  the previous one's chapters stick around" report: `pageBridge.js`'s own
  `videoId` field is URL-derived (`window.location.search`'s `v` param),
  which updates essentially the instant a SPA navigation starts — but
  `playerResponse` (`getPlayerResponse()`, a live call into the actual
  player instance) is refreshed by YouTube's own internal async process
  shortly after. Landing in that gap meant a freshly-fetched `pageData`
  snapshot could still describe the *previous* video's duration/id.
  `pageData.videoId` itself couldn't catch this (it's the exact field that
  updates too early to be a useful check). Fixed by validating against a
  field genuinely *inside* the response instead —
  `playerResponse.videoDetails.videoId` — and retrying
  (`fetchFreshPageData()`, budgeted at `PAGE_DATA_FRESHNESS_BUDGET_MS`,
  1.5s) until it actually matches the video being initialized for. This
  fixed duration/id staleness but, per a follow-up report on the *exact
  same* scenario, did **not** fix the original chapters symptom — the fifth
  finding below explains why, and is the real fix for that report.

  A fifth live finding, on the very same report: even after the fourth
  finding's fix shipped, chapters from the previous video kept appearing —
  confirmed via a debug log showing `playerResponse.videoDetails.videoId`
  correctly matching the new video (and duration correctly resolved) while
  the parsed chapter start times were still identical to the *previous*
  video's, unchanged across three consecutive re-inits over 570ms+. Root
  cause: chapters actually come from `ytInitialData` (`chapterStrategy.js`
  searches both `ytInitialData` and `playerResponse`, but only
  `ytInitialData` has ever actually contained chapter nodes in practice),
  and `pageBridge.js`'s `getYtInitialData()` reads `window.ytInitialData` —
  which, unlike `playerResponse`, is not a live API call but a **load-once
  global**: YouTube's own client-side navigation never reassigns it, so it
  keeps describing whichever video was on the page at the very first full
  load, for the entire lifetime of the tab. Retrying (the fourth finding's
  fix, and the obvious next thing to try) cannot fix this — the value
  genuinely never changes, so a longer or repeated wait just wastes time
  waiting for something that isn't coming. Confirmed by fetching real
  YouTube watch pages directly (`curl`) during development and inspecting
  their embedded `ytInitialData`: real chapter data (verified against a
  video known to have creator-defined chapters) and a `currentVideoEndpoint.watchEndpoint.videoId`
  field are both present and correct in that fresh HTML — they're just
  never reflected back into the *already-loaded* page's global. Fixed by
  routing around the global entirely rather than trying to freshen it:
  `pageBridge.js` now also reports `pageData.ytInitialDataVideoId` (read
  from `currentVideoEndpoint`, the one field in `ytInitialData` that names
  the page's own video specifically, as opposed to any of the dozens of
  related-video `videoId`s also present); if it doesn't match the video
  content.js is initializing, `ytInitialData` is treated as untrustworthy
  for chapters — not "not yet fresh," just unusable — and
  `fetchFreshChapters()` re-fetches that exact video's own watch page over
  the network (`fetch("https://www.youtube.com/watch?v=" + videoId)`) and
  re-parses `ytInitialData` straight out of that response instead, correct
  by construction since it's scoped to the target video by URL rather than
  any shared page state. This runs in parallel with the existing heatmap
  poll (see `content.js`'s two-branch `chaptersTrustworthy` split), so a
  video with neither still resolves in roughly the existing heatmap budget,
  not the sum of both waits. Same general technique (and the same
  `currentVideoEndpoint.watchEndpoint.videoId` field) used by other
  established YouTube-chapter-reading browser extensions.
- **Chapter parsing (the fallback strategy) is unverified.** It was
  written defensively (structural search, fails to `[]` rather than
  throwing) but, unlike the heatmap, hasn't been checked against a live
  page's actual `ytInitialData` shape. Test it on a video that has
  chapters but no heatmap (shortish/lower-view-count videos are more
  likely to lack a heatmap) to confirm the chapter picker actually
  populates; if it doesn't, the panel should still show the "no data"
  message rather than break, but the chapter feature itself won't work
  until that's fixed the same way the heatmap was.
- Try a few more videos generally: one with a big, obvious heatmap; one
  with manual chapters and no heatmap; and a short/obscure one with
  neither (to exercise the "no data" message).
- **Videos still loading their duration** (e.g. a live stream just started)
  will show empty ranges briefly, but this now self-corrects — see
  `content.js`'s `durationchange` handling above, which reinitializes once
  the real duration is known.
- **Header layout at very narrow panel widths.** Screenshotted the real
  header (not eyeballed) after adding the settings gear icon: everything
  — title, toggle, gear, minimize button — fits comfortably down to
  ~520px, degrades gracefully (elements pushed past the edge, nothing
  overlapping or unreadable) below that, and the header/settings-popover
  combination hasn't been tested below 400px, which is narrower than any
  realistic mount width in practice (the panel mounts alongside YouTube's
  primary player column, not a narrow sidebar). Not fixed proactively,
  consistent with how the onboarding card's own narrow-width behavior was
  already treated — revisit if it's ever actually reported.
- **The native control-bar button (`nativeToggleButton.js`) was verified
  against a live page and had one real bug, now fixed.** The current
  "Delhi" player redesign nests the actual buttons a level deeper than
  the first version assumed: `.ytp-right-controls` is just an outer
  wrapper around two priority-managed sub-rows,
  `.ytp-right-controls-left` (CC/autonav/settings) and
  `.ytp-right-controls-right` (theater/remote/fullscreen). The first
  version called `rightControls.insertBefore(button, ref)` with a `ref`
  that wasn't `rightControls`'s own child — `insertBefore` requires the
  reference node's actual parent, so that threw `NotFoundError`, silently
  swallowed by the surrounding try/catch, so the button just never
  appeared with no visible error. Fixed by inserting via
  `ref.parentNode` instead; `RIGHT_CONTROLS_SELECTORS` /
  `INSERT_BEFORE_SELECTORS` themselves matched the real markup on the
  first try and didn't need correcting. If it ever stops showing up again
  after a future YouTube markup change, this diagnostic (same shape as
  the one that caught this bug) will show the real DOM tree plus whether
  a probe insertion actually renders at a nonzero size:

  ```js
  (function () {
    function describe(el) {
      if (!el) return null;
      var rect = el.getBoundingClientRect();
      return {
        tag: el.tagName, class: el.className,
        dataPriority: el.getAttribute('data-priority'),
        w: Math.round(rect.width), h: Math.round(rect.height),
        children: Array.prototype.map.call(el.children, describe),
      };
    }
    var right = document.querySelector('.ytp-right-controls');
    var result = { rightControlsFound: !!right, tree: describe(right) };
    if (right) {
      var probe = document.createElement('button');
      probe.className = 'ytp-button yhp-probe-button';
      var settingsBtn = right.querySelector('.ytp-settings-button');
      if (settingsBtn) settingsBtn.parentNode.insertBefore(probe, settingsBtn);
      else right.appendChild(probe);
      var r = probe.getBoundingClientRect();
      result.probe = { parentClass: probe.parentNode.className, w: r.width, h: r.height };
      probe.parentNode.removeChild(probe);
    }
    console.log(result);
    copy(JSON.stringify(result, null, 2));
    console.log('%cCopied — paste back to Claude.', 'color:#7c5cff;font-weight:bold');
  })();
  ```

  The tooltip is still a simplification worth knowing about: it uses a
  plain `title` attribute (a real, always-correct native browser tooltip)
  rather than reverse-engineering YouTube's own custom tooltip
  bubble/positioning — close in function, not pixel-identical in style.

### Glassmorphic redesign — scope decisions and open gaps

This UI pass was a large brief; a few things were deliberately scoped down
or flagged rather than guessed at:

- **No thumbnail preview on timeline hover.** That needs YouTube's separate
  storyboard/sprite API, which nothing in this codebase fetches or parses
  today — a real new data source, not a visual tweak. Out of scope here.
- **Collapse is click-to-toggle, not drag-to-corner.** The brief asked for
  a pill that can be dragged to a corner and persists there; this pass
  ships a simpler expand/collapse click instead (state persisted via
  `Store`'s `panelCollapsed`, position is not). Free-drag positioning needs
  pointer-drag tracking, viewport-bounds clamping, and a persisted
  `{x, y}` — real scope, not just CSS, if it's still wanted.
- **No settings (gear) icon.** Mode/percentage controls were removed for
  simplicity earlier; there's nothing behind a gear right now. Trivial to
  add back next to the toggle if real settings return.
- **Contrast against the video itself can't be fully guaranteed.** Both the
  glass panel and the skip indicator sit on top of arbitrary, unknown video
  content — light text on a busy light frame (or vice versa) is an
  inherent risk of any translucent video-overlay HUD (YouTube's own
  transient overlays have the same limitation). The panel mitigates this
  with a fixed ~75%-opacity dark backdrop + blur; the skip indicator uses a
  drop-shadow instead of a background. Worth a visual spot-check on a few
  very bright/high-contrast videos.
