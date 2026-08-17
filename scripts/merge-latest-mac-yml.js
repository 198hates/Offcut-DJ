#!/usr/bin/env node
/**
 * Merge the Intel (x64) entries of a locally-built latest-mac.yml into the
 * arm64 latest-mac.yml that CI already published to the GitHub Release.
 *
 * Why this exists
 * ---------------
 * macOS releases are built in two places: CI builds arm64 (release.yml), and an
 * Intel Mac builds x64 afterwards (scripts/build-mac-x64.sh). Each run generates
 * its OWN latest-mac.yml describing only the arch it built. Whichever is uploaded
 * last wins, so the published manifest only ever listed arm64 — and
 * electron-updater's MacUpdater filters candidate files by
 *
 *     isArm64Mac ? keep files whose URL contains "arm64"
 *                : keep files whose URL does NOT contain "arm64"
 *
 * On an Intel Mac that filter emptied the list and the update died with
 * ERR_UPDATER_ZIP_FILE_NOT_FOUND. Intel users were therefore frozen on whatever
 * DMG they hand-installed (which is how a fixed-in-v1.0.7 Rekordbox sync bug was
 * still being hit weeks later).
 *
 * Merging both arches into one `files:` list satisfies the filter on both sides:
 * arm64 machines still match the arm64 zip, Intel machines now match the x64 zip.
 *
 * Usage:
 *   node scripts/merge-latest-mac-yml.js --base <published.yml> --add <dist/latest-mac.yml> --out <merged.yml>
 *
 * js-yaml comes in transitively with electron-builder, which is by definition
 * installed wherever this runs (it only runs right after a package step).
 */
const { readFileSync, writeFileSync, existsSync } = require('fs')
const yaml = require('js-yaml')

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? null : process.argv[i + 1]
}

const basePath = arg('base')
const addPath = arg('add')
const outPath = arg('out')

if (!basePath || !addPath || !outPath) {
  console.error('Usage: merge-latest-mac-yml.js --base <yml> --add <yml> --out <yml>')
  process.exit(2)
}

for (const [label, p] of [['--base', basePath], ['--add', addPath]]) {
  if (!existsSync(p)) {
    console.error(`✗ ${label} not found: ${p}`)
    if (label === '--base') {
      console.error('  The arm64 release must be published FIRST — this script merges x64 into it.')
      console.error('  Refusing to guess: uploading an x64-only manifest would strand arm64 users.')
    }
    process.exit(1)
  }
}

const base = yaml.load(readFileSync(basePath, 'utf8'))
const add = yaml.load(readFileSync(addPath, 'utf8'))

// Merging manifests from different versions would publish a manifest whose
// entries point at assets that don't exist on that release.
if (base.version !== add.version) {
  console.error(`✗ Version mismatch: base is ${base.version}, local build is ${add.version}.`)
  console.error('  Re-run the Intel build from the same tag CI released.')
  process.exit(1)
}

const isArm64 = (f) => f.url.includes('arm64')

const baseFiles = base.files ?? []
const addFiles = add.files ?? []

// Only take the non-arm64 entries from the local build. If the Intel box ever
// produces an arm64 artifact, it is NOT authoritative — CI's is.
const x64Files = addFiles.filter((f) => !isArm64(f))
if (x64Files.length === 0) {
  console.error(`✗ ${addPath} contains no non-arm64 files — nothing to merge.`)
  console.error(`  Found: ${addFiles.map((f) => f.url).join(', ') || '(none)'}`)
  process.exit(1)
}

// electron-updater needs a ZIP to actually perform a mac update; a dmg-only
// entry would resolve and then fail at download time.
if (!x64Files.some((f) => f.url.endsWith('.zip'))) {
  console.error('✗ No x64 .zip among the merged files — electron-updater cannot update from a dmg.')
  console.error(`  Found: ${x64Files.map((f) => f.url).join(', ')}`)
  process.exit(1)
}

// Rebuild the list: keep base entries, replace any same-url entry, append new.
const merged = [...baseFiles]
for (const f of x64Files) {
  const i = merged.findIndex((m) => m.url === f.url)
  if (i === -1) merged.push(f)
  else merged[i] = f
}

// Keep base's top-level path/sha512/releaseDate/version untouched. Those legacy
// fields are only read by very old electron-updater builds, which resolve them
// as a single fallback file — pointing them at arm64 matches the CI-published
// manifest and the bulk of the user base.
const out = { ...base, files: merged }

writeFileSync(outPath, yaml.dump(out, { lineWidth: -1 }))

console.log(`✓ Merged ${x64Files.length} x64 entr${x64Files.length === 1 ? 'y' : 'ies'} into ${outPath}`)
for (const f of merged) console.log(`    ${isArm64(f) ? 'arm64' : ' x64 '}  ${f.url}`)
