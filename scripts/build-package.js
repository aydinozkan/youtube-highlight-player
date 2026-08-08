#!/usr/bin/env node
/**
 * build-package — stages exactly the files manifest.json references (plus
 * manifest.json itself) into dist/package/, then zips that into
 * dist/<name>-<version>.zip — the artifact you actually upload to the
 * Chrome Web Store Developer Dashboard.
 *
 * Deliberately derives the file list FROM manifest.json (icons,
 * action.default_icon, background.service_worker, each content_scripts
 * entry's js/css) rather than hardcoding a copy of that list here — a
 * hardcoded list silently drifts the moment a new content script or icon
 * size is added to the manifest without a matching update to this file.
 * Reading it live means this script can't go stale that way.
 *
 * Run via `npm run package`, which chains `build:icons` first so the zip
 * always ships freshly-rendered PNGs, not whatever happened to be on disk.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const STAGE = path.join(DIST, "package");

function readManifest() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
}

/** Every file path manifest.json itself references, relative to the repo root. */
function collectManifestFiles(manifest) {
  var files = new Set();
  function addValues(obj) {
    if (!obj) return;
    Object.keys(obj).forEach(function (key) { files.add(obj[key]); });
  }
  addValues(manifest.icons);
  if (manifest.action) addValues(manifest.action.default_icon);
  if (manifest.background && manifest.background.service_worker) {
    files.add(manifest.background.service_worker);
  }
  (manifest.content_scripts || []).forEach(function (entry) {
    (entry.js || []).forEach(function (f) { files.add(f); });
    (entry.css || []).forEach(function (f) { files.add(f); });
  });
  return Array.from(files);
}

function rimraf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function copyIntoStage(relPath) {
  var src = path.join(ROOT, relPath);
  var dest = path.join(STAGE, relPath);
  if (!fs.existsSync(src)) {
    throw new Error(
      "manifest.json references '" + relPath + "' but that file doesn't exist on disk — " +
      "either build:icons hasn't been run yet, or this is a real typo in manifest.json."
    );
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function main() {
  var manifest = readManifest();
  var files = collectManifestFiles(manifest);

  rimraf(STAGE);
  fs.mkdirSync(STAGE, { recursive: true });
  copyIntoStage("manifest.json");
  files.forEach(copyIntoStage);

  console.log("Staged " + (files.length + 1) + " files into " + path.relative(ROOT, STAGE) + "/");

  var zipName = manifest.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-" + manifest.version + ".zip";
  var zipPath = path.join(DIST, zipName);
  fs.rmSync(zipPath, { force: true });

  try {
    // -X: drop extra file attributes (uid/gid/timestamps) for a
    // reproducible zip regardless of which machine built it.
    execFileSync("zip", ["-r", "-X", zipPath, "."], { cwd: STAGE, stdio: "inherit" });
  } catch (err) {
    console.error("\nCouldn't run the system 'zip' command (" + err.message + ").");
    console.error(
      "The staged files are still ready at " + path.relative(ROOT, STAGE) + "/ " +
      "— zip that folder's *contents* (not the folder itself) by hand instead."
    );
    process.exitCode = 1;
    return;
  }

  var stats = fs.statSync(zipPath);
  console.log(
    "Wrote " + path.relative(ROOT, zipPath) + " (" + (stats.size / 1024).toFixed(1) + " KB) " +
    "— upload this to the Chrome Web Store Developer Dashboard."
  );
}

main();
