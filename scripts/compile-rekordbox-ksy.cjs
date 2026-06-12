#!/usr/bin/env node
/**
 * Compiles the vendored rekordbox_pdb.ksy (Deep Symmetry crate-digger grammar)
 * into a JavaScript Kaitai Struct parser, committed alongside the grammar.
 *
 * Run once (or when the grammar changes):
 *   node scripts/compile-rekordbox-ksy.cjs
 *
 * The generated parser uses the `kaitai-struct` runtime (KaitaiStream) at run
 * time — no compiler dependency ships with the app.
 */
const fs = require('fs')
const path = require('path')
const YAML = require('js-yaml')
const KaitaiStructCompiler = require('kaitai-struct-compiler')

const dir = path.join(__dirname, '..', 'src', 'main', 'integrations', 'rekordbox-usb', 'kaitai')
const ksyText = fs.readFileSync(path.join(dir, 'rekordbox_pdb.ksy'), 'utf8')
const ksy = YAML.load(ksyText)

/** Strip Kaitai's UMD wrapper, leaving a plain CommonJS module. */
function toCommonJs(src) {
  const open = '}(this, function (KaitaiStream) {'
  const oi = src.indexOf(open)
  if (oi === -1) return src // not the expected wrapper — leave as-is
  let body = src.slice(oi + open.length)
  // The factory ends with `\n  return RekordboxPdb;\n}));`. Turn that into an export.
  body = body.replace(/\n\s*return ([A-Za-z0-9_]+);\s*\}\)\);\s*$/, '\nmodule.exports = $1;\n')
  return (
    '// Generated from rekordbox_pdb.ksy via scripts/compile-rekordbox-ksy.cjs — do not edit.\n' +
    "const KaitaiStream = require('kaitai-struct/KaitaiStream');\n" +
    body
  )
}

const compiler = new KaitaiStructCompiler()
compiler
  .compile('javascript', ksy, null, false)
  .then((files) => {
    for (const [name, source] of Object.entries(files)) {
      // Kaitai emits a UMD wrapper whose conditional `module.exports` defeats
      // rollup's static export analysis (electron-vite bundles main with rollup).
      // Rewrite to plain CommonJS and use a .cjs extension so vite/rollup treat
      // it as CommonJS and give it a clean default export when bundling.
      const out = path.join(dir, name.replace(/\.js$/, '.cjs'))
      const cjs = toCommonJs(source)
      fs.writeFileSync(out, cjs, 'utf8')
      console.log('wrote', path.relative(path.join(__dirname, '..'), out), `(${cjs.length} bytes, CJS)`)
    }
  })
  .catch((e) => {
    console.error('compile failed:', e)
    process.exit(1)
  })
