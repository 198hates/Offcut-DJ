/**
 * PageHelp — a small floating "?" in the bottom-right of the page area that pops
 * a short explanation of how to use the current page. Anchored to the content
 * row (above the persistent deck zone), opens upward, closes on outside-click /
 * Escape / page change.
 */

import { useEffect, useRef, useState } from 'react'
import type { Section } from './NavRail'

interface Help {
  title: string
  summary: string
  points: string[]
}

const PAGE_HELP: Record<Section, Help> = {
  library: {
    title: 'Library',
    summary: 'Your whole collection — browse, preview and organise tracks, and load them onto the decks.',
    points: [
      'Search and filter up top; click any column to sort. The FN·BUS chips are one-tap filters.',
      'Pick a playlist in the sidebar to scope the view to a crate.',
      'Double-click or drag a track onto the decks below to audition and beatmatch.',
      'Right-click a track for tagging, playlist and export actions.'
    ]
  },
  sync: {
    title: 'Sync',
    summary: 'Move your library to and from other DJ software.',
    points: [
      'Import or export Rekordbox, Serato, Traktor, Engine DJ, Apple Music, VirtualDJ and M3U.',
      'Choose what travels — tracks, playlists, cues and beat grids.',
      'Review the diff before you commit anything.'
    ]
  },
  analyse: {
    title: 'Analyse',
    summary: 'Batch-analyse the library so every track has the data you mix on.',
    points: [
      'Detect BPM, key, energy and beat grids; generate auto-cues.',
      'Run loudness (LUFS), genre inference, phrase detection and audio similarity.',
      'Select tracks (or the whole library), pick tools, and it runs in the background.'
    ]
  },
  health: {
    title: 'Library Health',
    summary: 'Keep the collection clean and safe.',
    points: [
      'Find duplicates (including re-tagged copies) and missing or moved files.',
      'Review play history and auto-grouped genre playlists.',
      'Take versioned backups before risky bulk edits.'
    ]
  },
  organize: {
    title: 'Organize',
    summary: 'Consolidate audio files scattered across your laptop into one music folder.',
    points: [
      'Pick your music library folder and add source folders to scan (Downloads, Desktop, an old drive…).',
      'Review the preview before anything moves — library tracks are relinked automatically.',
      'Files that fail to move (permissions, disk full) are reported without leaving the library out of sync.'
    ]
  },
  fixes: {
    title: 'Smart Fixes',
    summary: 'Tidy messy metadata across many tracks at once.',
    points: [
      'Fix title casing, strip promo / “free download” text, standardise keys.',
      'Pull artist names out of titles and normalise “feat.” credits.',
      'Preview every change before applying — with an AI tidy for the tricky ones.'
    ]
  },
  builder: {
    title: 'Set Builder',
    summary: 'Compose a set visually and find what comes next.',
    points: [
      'Drag tracks into the set; arrange in split, swimlane, timeline or graph views.',
      'Annotate transitions and get next-track suggestions by key, energy and BPM.',
      'Export the finished set when it flows.'
    ]
  },
  search: {
    title: 'Advanced Search',
    summary: 'Pinpoint tracks across every dimension at once.',
    points: [
      'Range sliders for BPM, energy, danceability, mood and rating.',
      'Filter by harmonic key, genre and tags — results update live.',
      'Great for building tight, rule-based crates.'
    ]
  },
  orders: {
    title: 'Running Orders',
    summary: 'Lay out a gig’s running order and export it.',
    points: [
      'Arrange tracks on the three-lens arc canvas; drag to reorder.',
      'Transition badges show how each blend flows.',
      'Export a clean PDF for the booth or promoter.'
    ]
  },
  lineage: {
    title: 'Lineage',
    summary: 'Dig for new music related to a seed track.',
    points: [
      'Type an artist + title (or drag a track from the tray) and hit Dig.',
      'Branches fan out by remixes & versions, label artists, sounds-like, samples, SoundCloud and played-alongside.',
      'Reveal a branch to see its tracks; DIG a track to chain a fresh net — the wave traces the path home.',
      'Save finds to the crate and export to Rekordbox.'
    ]
  },
  assistant: {
    title: 'Assistant',
    summary: 'Ask your library questions in plain language.',
    points: [
      '“Find 124–126 BPM peak-time rollers in 8A” — it searches for you.',
      'Have it build a playlist or a set from a description.',
      'Needs an Anthropic API key in Settings › AI & Discovery.'
    ]
  },
  sethistory: {
    title: 'Set History',
    summary: 'Look back at the sets you’ve played.',
    points: [
      'Heatmap and gig-density views of your history.',
      'Transition deltas and stats — spot your go-to combos.',
      'Edit venue and notes inline.'
    ]
  },
  phonesync: {
    title: 'Phone',
    summary: 'Pair the companion phone app over your network.',
    points: [
      'Prep edits and notes made on your phone sync back here in real time.',
      'Keep tagging on the move; changes land straight in the library.'
    ]
  },
  usb: {
    title: 'USB Export',
    summary: 'Prepare a CDJ-ready USB straight from Offcut.',
    points: [
      'Writes a Rekordbox-format stick — playlists, cues, grids and stems.',
      'No Rekordbox needed; you can also import an existing stick’s backup.',
      'Close Rekordbox before writing directly to a drive.'
    ]
  },
  settings: {
    title: 'Settings',
    summary: 'Configure integrations and how the app behaves.',
    points: [
      'Integration paths + keys (Discogs, Last.fm, AI, SoundCloud, 1001Tracklists).',
      'Playback, library locations, MIDI mapping and audio routing.',
      'Theme and performance / concurrency tuning.'
    ]
  }
}

export function PageHelp({ page }: { page: Section }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const help = PAGE_HELP[page]

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Close the popover whenever the page changes.
  useEffect(() => setOpen(false), [page])

  if (!help) return null

  return (
    <div ref={ref} className="absolute bottom-3 right-3 z-30 flex flex-col items-end">
      {open && (
        <div
          className="mb-2 w-[330px] max-h-[60vh] overflow-y-auto rounded-lg border border-border/50 bg-chassis p-4"
          style={{ boxShadow: '0 12px 44px rgba(0,0,0,0.4)' }}
        >
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-mono text-[11px] uppercase tracking-[0.16em] text-accent">{help.title}</h3>
            <button
              onClick={() => setOpen(false)}
              className="text-muted hover:text-ink text-[15px] leading-none -mt-0.5"
              aria-label="Close help"
            >
              ×
            </button>
          </div>
          <p className="text-[12.5px] text-ink-soft leading-relaxed">{help.summary}</p>
          <ul className="mt-2.5 space-y-1.5">
            {help.points.map((pt, i) => (
              <li key={i} className="flex gap-2 text-[12px] text-muted leading-snug">
                <span className="text-accent shrink-0">›</span>
                <span>{pt}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <button
        onClick={() => setOpen((o) => !o)}
        title="How to use this page"
        aria-label="How to use this page"
        className={`w-7 h-7 flex items-center justify-center rounded-full border text-[13px] font-mono transition-colors ${
          open
            ? 'bg-accent text-white border-accent'
            : 'bg-chassis/90 border-border/50 text-muted/70 hover:text-accent hover:border-accent/60'
        }`}
        style={{ boxShadow: '0 2px 10px rgba(0,0,0,0.25)' }}
      >
        ?
      </button>
    </div>
  )
}
