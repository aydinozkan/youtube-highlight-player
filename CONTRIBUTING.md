# Contributing

Thanks for taking a look. This is a solo side project, not a company —
response times on issues/PRs will vary, and I'm the only one who merges
things or ships a new version to the Chrome Web Store. That said, real
bug reports and well-scoped PRs are genuinely welcome.

## Getting set up

```bash
git clone https://github.com/aydinozkan/youtube-highlight-player.git
cd youtube-highlight-player
npm install       # only dev dependency is @resvg/resvg-js, for icon builds
npm test          # 128 tests, no browser needed
```

To try it live: `chrome://extensions` → enable **Developer mode** → **Load
unpacked** → select the repo folder. See the README's "Install" section for
more.

## How this codebase is built — read before changing things

- **No build step, no framework, no bundler.** Every file under `src/` is
  the exact vanilla JS that ships — what you edit is what runs. Don't
  introduce a bundler, TypeScript, or a UI framework; it would break that
  property for no benefit a browser extension this size actually needs.
- **UMD-style modules attached to `window.YHP.*`**, wired together purely
  by `manifest.json`'s `content_scripts` array (isolated-world files) and
  `background.js`'s own `importScripts()` (for the two `src/telemetry/*`
  files it also needs). New file → add it to the right list, in the right
  order (dependencies before dependents).
- **`textContent`, never `innerHTML`, for anything creator-controlled** —
  chapter titles, video titles, etc. are arbitrary untrusted strings. This
  is a real security rule, not a style preference; a PR that introduces
  `innerHTML` for page-supplied text will get bounced.
- **DOM-heavy files (`panel.js`, `content.js`) are deliberately not
  unit-tested** — `node:test` covers pure logic only (interval math,
  object-graph search, detection-strategy parsing, the player controller's
  skip logic, the analytics/error-reporter helpers). If your change is to
  one of the pure-logic files, add tests alongside the existing ones in
  `tests/`. If it's UI, see the next point instead.
- **UI changes get verified against a real render before being called
  done, not eyeballed from the source.** The established technique: copy
  `panel.js`/`panel.css` into a small standalone HTML harness that calls
  `window.YHP.Panel.mount()` directly, then screenshot it with headless
  Chromium (`chromium --headless --disable-gpu --screenshot=out.png
  --window-size=W,H page.html`) and actually look at the result. This
  caught several real bugs during development (a settings popover
  colliding with an onboarding card, an icon that read as a sun instead of
  a gear, text truncation that wasn't actually truncating) that reading
  the CSS/SVG source alone did not.
- **Never sends more than it says it does.** If you're touching
  `src/telemetry/*`, re-read that section of the README first — there's a
  specific, deliberate discipline there (never a video ID/title/URL,
  `$process_person_profile: false`, rate limits, scrubbing) that's easy to
  accidentally widen without noticing.

The README's "How it works" section covers the actual detection/playback
architecture in more depth than belongs here.

## Before opening a PR

```bash
npm test                                    # all tests must pass
for f in src/**/*.js; do node --check "$f"; done   # syntax check
```

Keep PRs scoped to one thing — easier to review, easier to revert if
something's wrong. Explain *why*, not just *what*, in the description;
this codebase's own commit messages and code comments lean heavily on
"why," and a PR that matches that is much faster to review.

## Reporting bugs

Open an issue with what you expected vs. what happened, the video URL if
it's reproducible (or a description if it's private/unlisted), and — if
you can — the console output with `localStorage.setItem("yhp_debug", "1")`
set beforehand (then reload the page). That log format is what caught
essentially every real bug documented in the README's "Known limitations"
section.

## License

By contributing, you agree your contribution is licensed under this
project's [MIT license](LICENSE).
