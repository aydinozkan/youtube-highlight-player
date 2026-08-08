#!/usr/bin/env node
/**
 * build-icons — rasterizes icons/src/*.svg into the PNGs manifest.json
 * actually references. Added because the project previously had no
 * SVG-to-PNG pipeline at all: icons/*.png existed as hand-produced raster
 * files with no source to regenerate them from.
 *
 * Uses @resvg/resvg-js (a Rust SVG renderer with prebuilt native bindings)
 * rather than shelling out to a system tool (rsvg-convert, Inkscape,
 * ImageMagick) or a headless-browser screenshot: none of the former are
 * guaranteed to be installed on a given machine, and the latter is heavy
 * for what's a deterministic, dependency-light rasterization step. This
 * keeps `npm run build:icons` reproducible on any machine `npm install`
 * already works on.
 *
 * Sizes/sources below are intentionally hardcoded to what manifest.json
 * currently declares (`icons` + `action.default_icon`, kept identical) —
 * this script doesn't read manifest.json itself, so if those sizes ever
 * change, update TARGETS here too.
 */
const fs = require("fs");
const path = require("path");
const { Resvg } = require("@resvg/resvg-js");

const SRC_DIR = path.join(__dirname, "..", "icons", "src");
const OUT_DIR = path.join(__dirname, "..", "icons");

// Below this size the detailed variant's secondary peaks + glow wash out
// into noise rather than adding legibility — see icon-simple.svg's header
// comment. 48px and up gets the fuller motif.
const SIMPLE_MAX_SIZE = 32;

const TARGETS = [
  { size: 16, out: "icon16.png" },
  // 32px exists specifically for the toolbar action icon on HiDPI/Retina
  // displays: Chrome renders that icon at 16 CSS px, but a 2x-density
  // screen needs a real 32px source to stay sharp there — without one, it
  // upscales the 16px PNG and the icon reads as blurry. Manifest sizes
  // otherwise stop at 16/48/128 (see README's Icons section for why no
  // 19/38, the older MV2-era HiDPI pair).
  { size: 32, out: "icon32.png" },
  { size: 48, out: "icon48.png" },
  { size: 128, out: "icon128.png" },
];

function render(svgPath, size) {
  const svg = fs.readFileSync(svgPath, "utf8");
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: size } });
  return resvg.render().asPng();
}

for (const target of TARGETS) {
  const variant = target.size <= SIMPLE_MAX_SIZE ? "icon-simple.svg" : "icon-detailed.svg";
  const svgPath = path.join(SRC_DIR, variant);
  const png = render(svgPath, target.size);
  fs.writeFileSync(path.join(OUT_DIR, target.out), png);
  console.log(target.out + " <- " + variant + " @ " + target.size + "px");
}
