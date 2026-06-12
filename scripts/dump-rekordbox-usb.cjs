#!/usr/bin/env node
/**
 * Validation tool for the Rekordbox USB reader (M0).
 *
 * Parses a prepared USB's `PIONEER/rekordbox/export.pdb` (the DeviceSQL format
 * CDJs read) using the committed Kaitai parser, and prints a summary of the
 * tracks and playlist tree it found. Plain Node — no bundler, no app — so it's
 * the quickest way to confirm the parser handles a real stick.
 *
 * Usage:
 *   node scripts/dump-rekordbox-usb.cjs /Volumes/MY_USB
 *   node scripts/dump-rekordbox-usb.cjs /Volumes/MY_USB/PIONEER/rekordbox/export.pdb
 */
const fs = require('fs')
const path = require('path')
const KaitaiStream = require('kaitai-struct/KaitaiStream')
const RekordboxPdb = require('../src/main/integrations/rekordbox-usb/kaitai/RekordboxPdb.cjs')

const PT = RekordboxPdb.PageType // TRACKS=0 GENRES=1 ARTISTS=2 ALBUMS=3 LABELS=4 KEYS=5 COLORS=6 PLAYLIST_TREE=7 PLAYLIST_ENTRIES=8

function resolvePdb(input) {
  if (!input) {
    console.error('Pass a USB path or an export.pdb path.')
    process.exit(1)
  }
  const candidates = [
    input,
    path.join(input, 'PIONEER', 'rekordbox', 'export.pdb'),
    path.join(input, 'rekordbox', 'export.pdb'),
    path.join(input, 'export.pdb')
  ]
  const hit = candidates.find((p) => {
    try {
      return fs.statSync(p).isFile()
    } catch {
      return false
    }
  })
  if (!hit) {
    console.error('No export.pdb found at or under:', input)
    console.error('Looked for:', candidates.join('\n            '))
    process.exit(1)
  }
  return hit
}

function devStr(s) {
  try {
    return s && s.body && typeof s.body.text === 'string' ? s.body.text : ''
  } catch {
    return ''
  }
}

function* tableRows(pdb, type) {
  const table = pdb.tables.find((t) => t.type === type)
  if (!table) return
  const lastIndex = table.lastPage.index
  let ref = table.firstPage
  let guard = 0
  while (ref && guard++ < 200000) {
    let page
    try {
      page = ref.body
    } catch {
      break
    }
    if (page && page.type !== type) break
    if (page && page.isDataPage) {
      for (const rg of page.rowGroups) {
        for (const row of rg.rows) {
          let present = false
          try {
            present = row.present
          } catch {
            present = false
          }
          if (!present) continue
          let body = null
          try {
            body = row.body
          } catch {
            body = null
          }
          if (body) yield body
        }
      }
    }
    if (page && page.pageIndex === lastIndex) break
    ref = page ? page.nextPage : null
  }
}

function nameMap(pdb, type) {
  const m = new Map()
  for (const r of tableRows(pdb, type)) m.set(r.id, devStr(r.name))
  return m
}

function main() {
  const pdbPath = resolvePdb(process.argv[2])
  console.log('Reading:', pdbPath)
  const buf = fs.readFileSync(pdbPath)
  const pdb = new RekordboxPdb(new KaitaiStream(buf), null, null, false)

  console.log(`page size: ${pdb.lenPage} · tables: ${pdb.numTables}`)

  const artists = nameMap(pdb, PT.ARTISTS)
  const albums = nameMap(pdb, PT.ALBUMS)
  const keys = nameMap(pdb, PT.KEYS)
  const genres = nameMap(pdb, PT.GENRES)

  const tracks = new Map()
  for (const t of tableRows(pdb, PT.TRACKS)) {
    tracks.set(t.id, {
      id: t.id,
      title: devStr(t.title),
      artist: artists.get(t.artistId) || '',
      album: albums.get(t.albumId) || '',
      key: keys.get(t.keyId) || '',
      genre: genres.get(t.genreId) || '',
      bpm: t.tempo ? t.tempo / 100 : null,
      durationSec: t.duration || null,
      year: t.year || null,
      rating: t.rating || 0,
      filePath: devStr(t.filePath)
    })
  }

  const playlists = []
  for (const p of tableRows(pdb, PT.PLAYLIST_TREE)) {
    playlists.push({ id: p.id, name: devStr(p.name), isFolder: p.isFolder, parentId: p.parentId, sortOrder: p.sortOrder })
  }
  const entriesByPlaylist = new Map()
  for (const e of tableRows(pdb, PT.PLAYLIST_ENTRIES)) {
    if (!entriesByPlaylist.has(e.playlistId)) entriesByPlaylist.set(e.playlistId, [])
    entriesByPlaylist.get(e.playlistId).push({ entryIndex: e.entryIndex, trackId: e.trackId })
  }

  console.log(`\nartists: ${artists.size}  albums: ${albums.size}  keys: ${keys.size}  genres: ${genres.size}`)
  console.log(`tracks: ${tracks.size}  playlists/folders: ${playlists.length}`)

  console.log('\n── first 10 tracks ─────────────────────────────')
  let n = 0
  for (const t of tracks.values()) {
    if (n++ >= 10) break
    console.log(
      `  ${String(t.bpm ?? '—').padStart(6)}  ${(t.key || '—').padEnd(4)}  ${(t.artist || '—').slice(0, 24).padEnd(24)}  ${(t.title || '—').slice(0, 32)}`
    )
  }

  console.log('\n── playlist tree ──────────────────────────────')
  const byParent = new Map()
  for (const p of playlists) {
    if (!byParent.has(p.parentId)) byParent.set(p.parentId, [])
    byParent.get(p.parentId).push(p)
  }
  const printTree = (parentId, depth) => {
    const kids = (byParent.get(parentId) || []).sort((a, b) => a.sortOrder - b.sortOrder)
    for (const p of kids) {
      const count = entriesByPlaylist.get(p.id)?.length ?? 0
      const tag = p.isFolder ? '📁' : '🎵'
      console.log(`  ${'  '.repeat(depth)}${tag} ${p.name}${p.isFolder ? '' : ` (${count})`}`)
      if (p.isFolder) printTree(p.id, depth + 1)
    }
  }
  printTree(0, 0)
  console.log('')
}

try {
  main()
} catch (e) {
  console.error('\nParse failed:', e && e.stack ? e.stack : e)
  process.exit(1)
}
