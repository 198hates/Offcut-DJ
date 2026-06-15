import React, { useEffect, useCallback, useState, useRef, useMemo } from 'react'
import { useLibraryStore } from '../store/libraryStore'
import type { StoreApi, UseBoundStore } from 'zustand'
import type { DeckStore } from '../store/playerStore'
import { HOT_CUE_COLORS, HOT_CUE_LABELS, type AnalysisState } from '../store/playerStore'
import { useWaveformStore } from '../store/waveformStore'
import { generateBeatgrid } from '../lib/compatibility'
import { fromBeatgridMarkers } from '../lib/quantiser'
import { WaveformGL } from './WaveformGL'
import { OverviewWaveform } from './OverviewWaveform'
import { StemPanel } from './StemPanel'
import { BeatgridEditor } from './BeatgridEditor'
import { useArtwork } from '../hooks/useArtwork'
import { acceptsTrackDrop, readTrackIds } from '../lib/trackDrag'
import { formatDuration, formatTime } from '../lib/format'
import { NativeAudioEngine } from '../lib/nativeAudioEngine'
import type { CuePoint } from '@shared/types'

type DeckStoreHook = UseBoundStore<StoreApi<DeckStore>>

interface Props {
  useStore: DeckStoreHook
  label: 'A' | 'B'
  /** Which digit keys this deck listens to (A=no modifier, B=Alt) */
  keyMod?: 'none' | 'alt'
}

const fmt = (s: number, ms = false): string =>
  ms ? formatTime(s) : formatDuration(s, { round: false, dash: '0:00' })

export function Deck({ useStore, label, keyMod = 'none' }: Props): JSX.Element {
  const waveformStyle = useWaveformStore((s) => s.style)
  // KEY/SYNC are engine features — under the Web Audio fallback they'd be
  // silent no-ops, so the buttons disable honestly instead of lying.
  const engineIsNative = useStore((s) => s._engine instanceof NativeAudioEngine)

  const {
    currentTrack, isPlaying, currentTime, duration,
    waveformPeaks, detailPeaks, lowPeaks, midPeaks, highPeaks, isLoading, mainCueTime,
    loopStart, loopEnd, isLooping, playbackRate, pitchRange, keylockEnabled, synced,
    isQuantized, slipMode, analysisState,
    fluxEnabled, stemsVisible, stems,
    stemsLoaded, stemsSeparating, stemsProgress, stemsAvailable,
    loadTrack, togglePlay, seek, scrubStart, scrubEnd, pressCue,
    setCue, clearCue, jumpToCue, setMemoryCue,
    setLoopIn, setLoopOut, beatLoop, loopRoll, toggleLoop, clearLoop, setPlaybackRate, setPitchRange,
    toggleKeylock, toggleSync, toggleQuantize, toggleSlipMode,
    toggleFlux, getFluxTime,
    toggleStemsVisible, setStemMuted, setStemSoloed, setStemGain,
    separateStems, unloadStems, checkStemsAvailable,
    saveLoopSlot, jumpToLoopSlot, clearLoopSlot,
    beatJump, analyzeCurrentTrack, applyGridEdit
  } = useStore()

  const updateTrack = useLibraryStore((s) => s.updateTrack)
  const artworkUrl  = useArtwork(currentTrack?.filePath)

  const isRight = label === 'B'

  // ── Beatgrid edit mode (opens the full BeatgridEditor modal) ───────────────
  const [gridEditMode, setGridEditMode] = useState(false)

  // Exit grid mode when track changes or unloads
  useEffect(() => { setGridEditMode(false) }, [currentTrack?.id])

  // Keyboard shortcuts — Deck A: Space / 1-8, Deck B: Alt+Space / Alt+1-8
  const handleKey = useCallback((e: KeyboardEvent) => {
    // Never trigger deck transport while the user is typing anywhere —
    // a Space in a comment field must not start/stop a live deck.
    const t = e.target as HTMLElement
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return
    const wantAlt = keyMod === 'alt'
    if (e.altKey !== wantAlt) return

    if (e.code === 'Space' && !e.metaKey && !e.ctrlKey) {
      // Only handle Space if it hasn't already been claimed by a focused element
      // (e.g. the Library list handles Space for 30s preview when it has focus).
      if (e.defaultPrevented) return
      e.preventDefault()
      togglePlay()
    }
    const digit = e.code.match(/^Digit([1-8])$/)?.[1]
    if (digit) {
      e.preventDefault()
      const idx = parseInt(digit) - 1
      if (e.shiftKey) setCue(idx)
      else jumpToCue(idx)
    }
  }, [togglePlay, setCue, jumpToCue, keyMod])

  useEffect(() => {
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [handleKey])

  const tracks = useLibraryStore((s) => s.tracks)
  // The deck store's `currentTrack` is a load-time snapshot, so edits made after
  // load (beatgrid editor, re-analysis) don't reach it. Mirror the live store
  // copy for *display-only* fields — grid, BPM, key — so saving the beatgrid is
  // reflected in the visualiser immediately.
  const liveTrack =
    useLibraryStore((s) => s.tracks.find((t) => t.id === currentTrack?.id)) ?? currentTrack
  // Live beatgrid: prefer stored markers; fall back to a generated grid from BPM
  // so the waveform always shows a grid once a track has been analysed.
  const liveBeatgrid = useMemo(() => {
    if (!liveTrack) return []
    if (liveTrack.beatgrid.length > 0) return liveTrack.beatgrid
    if (liveTrack.bpm && liveTrack.durationSeconds) {
      return generateBeatgrid(liveTrack.bpm, 0, liveTrack.durationSeconds * 1000)
    }
    return []
  }, [liveTrack])
  // What the waveform shows: the stored grid (editing happens in the modal).
  const displayBeatgrid = liveBeatgrid
  const liveAnalysedBeatgrid = liveTrack?.analysedBeatgrid ?? null

  const [isDragOver, setIsDragOver] = useState(false)

  // ── Flux ghost-time — updated via RAF while flux is active ────────────
  const [fluxGhostTime, setFluxGhostTime] = useState<number | null>(null)
  const fluxEnabledRef = useRef(fluxEnabled)
  useEffect(() => { fluxEnabledRef.current = fluxEnabled }, [fluxEnabled])

  useEffect(() => {
    if (!fluxEnabled) { setFluxGhostTime(null); return }
    let raf: number
    const tick = () => {
      if (fluxEnabledRef.current) {
        setFluxGhostTime(getFluxTime())
        raf = requestAnimationFrame(tick)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fluxEnabled])

  // ── Drag-to-load: drop a track from the library onto this deck ────────
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!acceptsTrackDrop(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // Only clear when leaving the deck entirely (not a child element)
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
      setIsDragOver(false)
    }
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    const ids = readTrackIds(e)
    const track = ids.length ? tracks.find((t) => t.id === ids[0]) : null
    if (track) loadTrack(track)
  }, [tracks, loadTrack])

  const hotcues = HOT_CUE_LABELS.map((lbl, i) => ({
    label: lbl, index: i,
    cue: currentTrack?.cuePoints.find((c) => c.type === 'hotcue' && c.index === i),
    color: HOT_CUE_COLORS[i]
  }))
  const memoryCues = currentTrack?.cuePoints.filter((c) => c.type === 'memory') ?? []
  // Saved loop slots (CuePoint type:'loop' at fixed indices 0-7)
  const loopSlots = Array.from({ length: 8 }, (_, i) =>
    currentTrack?.cuePoints.find((c) => c.type === 'loop' && c.index === i) ?? null
  )
  const remaining = duration - currentTime

  // Deck-zone colour helpers (always dark — not Tailwind theme aware)
  const dkRule  = 'rgba(42,36,28,0.6)'   // --deck-rule at 60%
  const dkRule2 = 'rgba(42,36,28,0.35)'  // --deck-rule at 35% (faint)

  return (
    <div
      className={`flex-1 min-w-0 flex flex-col overflow-hidden relative transition-colors ${isDragOver ? 'ring-1 ring-inset' : ''}`}
      style={isDragOver ? { background: 'rgba(216,106,74,0.08)', boxShadow: 'inset 0 0 0 1px rgba(216,106,74,0.4)' } : undefined}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
          <div className="text-xs font-bold px-3 py-1.5 rounded shadow-lg tracking-widest uppercase"
            style={{ background: 'rgba(216,106,74,0.9)', color: 'var(--deck-bg)' }}>
            Load to Deck {label}
          </div>
        </div>
      )}

      {/* ── Track info + BPM + time ──────────────────────────────────── */}
      <div
        className={`flex items-center gap-2 px-2 pt-1 pb-0.5 border-b`}
        style={{ borderColor: dkRule }}
      >
        {/* Deck label chip */}
        <div
          className="shrink-0 px-1.5 py-0.5 rounded text-[13px] font-black tracking-widest select-none"
          style={{ background: 'rgba(216,106,74,0.15)', color: 'var(--deck-spot)' }}
        >
          {label}
        </div>

        {/* Album art thumbnail — 40×40, only when artwork is available */}
        {artworkUrl && (
          <div
            className="shrink-0 rounded overflow-hidden"
            style={{ width: 40, height: 40, background: 'var(--deck-rule)' }}
          >
            <img
              src={artworkUrl}
              alt=""
              className="w-full h-full object-cover"
              style={{ display: 'block' }}
            />
          </div>
        )}

        {/* Track info */}
        <div className="flex-1 min-w-0">
          <p
            className="text-xs font-semibold truncate leading-tight overflow-hidden"
            style={{ color: 'var(--deck-ink)', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {currentTrack?.title || (
              <span className="italic font-normal" style={{ color: 'var(--deck-mute)', opacity: 0.6 }}>
                {isRight ? 'Load a cut into deck B' : 'No track loaded'}
              </span>
            )}
          </p>
          <div className={`flex items-center gap-2`}>
            <p className="text-[13px] truncate" style={{ color: 'var(--deck-mute)' }}>
              {currentTrack?.artist || ''}
              {currentTrack?.album ? ` · ${currentTrack.album}` : ''}
            </p>
            <AnalysisIndicator state={analysisState} onAnalyze={analyzeCurrentTrack} hasTrack={!!currentTrack} />
            {liveBeatgrid.length > 0 && (
              <button
                onClick={() => setGridEditMode(true)}
                disabled={!currentTrack}
                title={`Beat grid · ${liveBeatgrid.length} beats — click to edit`}
                className="text-[11px] font-mono shrink-0 transition-colors disabled:opacity-40"
                style={{ color: 'rgba(216,106,74,0.5)' }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = 'var(--deck-spot)')}
                onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = 'rgba(216,106,74,0.5)')}
              >
                grid
              </button>
            )}
          </div>
        </div>

        {/* Key LED */}
        <LedReadout value={liveTrack?.key || '—'} ghost="00A"   label="key" fontSize={13} />
        {/* BPM LED */}
        <LedReadout value={liveTrack?.bpm ? liveTrack.bpm.toFixed(1) : '—.—'} ghost="000.0" label="bpm" fontSize={13} />
        {/* Time LED */}
        <LedReadout value={fmt(currentTime, true)} ghost="0:00.0" label={`-${fmt(remaining)}`} fontSize={12} />
      </div>

      {/* ── Overview waveform — dark screen ──────────────────────────── */}
      <div className="px-2 border-b" style={{ background: 'var(--deck-panel)', borderColor: dkRule2 }}>
        <OverviewWaveform
          peaks={waveformPeaks}
          lowPeaks={lowPeaks}
          midPeaks={midPeaks}
          highPeaks={highPeaks}
          waveformStyle={waveformStyle}
          duration={duration}
          currentTime={currentTime}
          cuePoints={currentTrack?.cuePoints ?? []}
          mainCueTime={mainCueTime}
          beatgrid={displayBeatgrid}
          analysedBeatgrid={liveAnalysedBeatgrid}
          onSeek={seek}
        />
      </div>

      {/* ── Scrolling detail waveform ─────────────────────────────────── */}
      <div className="px-2 py-1 flex flex-1 min-h-0" style={{ background: 'var(--deck-panel)' }}>
        <WaveformGL
          peaks={detailPeaks}
          lowPeaks={lowPeaks}
          midPeaks={midPeaks}
          highPeaks={highPeaks}
          waveformStyle={waveformStyle}
          duration={duration}
          currentTime={currentTime}
          isPlaying={isPlaying}
          playbackRate={playbackRate}
          cuePoints={currentTrack?.cuePoints ?? []}
          mainCueTime={mainCueTime}
          beatgrid={displayBeatgrid}
          analysedBeatgrid={liveAnalysedBeatgrid}
          loopStart={loopStart}
          loopEnd={loopEnd}
          isLooping={isLooping}
          fluxTime={fluxGhostTime}
          onSeek={seek}
          onScrubStart={scrubStart}
          onScrubEnd={scrubEnd}
          isLoading={isLoading}
        />
      </div>

      {/* ── Stem buses ───────────────────────────────────────────────── */}
      {stemsVisible && (
        <StemPanel
          stems={stems}
          loaded={stemsLoaded}
          separating={stemsSeparating}
          progress={stemsProgress}
          available={stemsAvailable}
          onMute={setStemMuted}
          onSolo={setStemSoloed}
          onGain={setStemGain}
          onSeparate={separateStems}
          onUnload={unloadStems}
        />
      )}

      {/* ── Beatgrid editor (full, draggable, zoomable — opens over the app) ── */}
      {gridEditMode && currentTrack && (
        <BeatgridEditor
          track={currentTrack}
          onSave={async (beatgrid, newBpm) => {
            // Human-verified: confidence 1.0 on every beat → KEPT stamp earned.
            const kept = beatgrid.map((m) => ({ ...m, confidence: 1.0 }))
            const roundedBpm = Math.round(newBpm * 10) / 10
            const analysedBeatgrid = fromBeatgridMarkers(kept, 'manual')
            await updateTrack({
              id: currentTrack.id,
              beatgrid: kept,
              bpm: roundedBpm,
              analysedBeatgrid
            })
            // Push the new grid into the deck engine so quantise / beat-jump /
            // loops use it immediately — no track reload needed.
            applyGridEdit(currentTrack.id, { beatgrid: kept, bpm: roundedBpm, analysedBeatgrid })
            setGridEditMode(false)
          }}
          onClose={() => setGridEditMode(false)}
        />
      )}

      {/* ── Loop controls + pitch ─────────────────────────────────────── */}
      <div
        className={`flex items-center gap-1 px-2 py-0.5 border-t flex-wrap`}
        style={{ borderColor: dkRule2 }}
      >
        {/* Beat loop buttons */}
        <span className="text-[11px] uppercase tracking-[0.15em] shrink-0 mr-0.5" style={{ color: 'var(--deck-mute)' }}>Loop</span>
        {[0.5, 1, 2, 4, 8].map((bars) => (
          <button
            key={bars}
            onClick={() => beatLoop(bars)}
            disabled={!currentTrack}
            title={`${bars} bar loop`}
            className="deck-btn h-6 px-1.5 rounded text-[13px] font-bold border transition-colors disabled:opacity-40"
          >
            {bars < 1 ? '½' : bars}
          </button>
        ))}

        <div className="w-px h-4 mx-0.5 shrink-0" style={{ background: 'var(--deck-rule)' }} />

        {/* Loop Roll buttons */}
        <span className="text-[11px] uppercase tracking-[0.15em] shrink-0 mr-0.5" style={{ color: 'rgba(139,92,246,0.65)' }} title="Loop roll — slips back to where the track would have been">Roll</span>
        {[0.5, 1, 2, 4].map((bars) => (
          <button
            key={bars}
            onClick={() => loopRoll(bars)}
            disabled={!currentTrack}
            title={`${bars === 0.5 ? '½' : bars} bar loop roll (slip)`}
            className="h-6 px-1.5 rounded text-[13px] font-bold border transition-colors disabled:opacity-40"
            style={{ borderColor: 'rgba(139,92,246,0.4)', color: 'rgba(139,92,246,0.8)' }}
          >
            {bars < 1 ? '½' : bars}
          </button>
        ))}

        <div className="w-px h-4 mx-0.5 shrink-0" style={{ background: 'var(--deck-rule)' }} />

        {/* IN / OUT / LOOP */}
        <button onClick={setLoopIn}  disabled={!currentTrack} className="deck-btn h-6 px-1.5 rounded text-[13px] font-bold border transition-colors disabled:opacity-40">IN</button>
        <button onClick={setLoopOut} disabled={!currentTrack} className="deck-btn h-6 px-1.5 rounded text-[13px] font-bold border transition-colors disabled:opacity-40">OUT</button>
        <button
          onClick={toggleLoop}
          disabled={!currentTrack || (loopStart === null && loopEnd === null)}
          className={`h-6 px-2 rounded text-[13px] font-bold border transition-colors disabled:opacity-40 ${isLooping ? 'deck-btn-active' : 'deck-btn'}`}
        >
          LOOP
        </button>
        <button
          onClick={clearLoop}
          disabled={!currentTrack || (loopStart === null)}
          className="deck-btn h-6 px-1.5 rounded text-[13px] border transition-colors disabled:opacity-40"
          title="Clear loop"
        >✕</button>

        <div className="flex-1" />

        {/* QUANT / SLIP / FLUX / KEY mode buttons */}
        <button
          onClick={toggleQuantize}
          disabled={!currentTrack}
          title="Quantize — cues and loops snap to nearest beat"
          className={`h-6 px-1.5 rounded text-[13px] font-bold border transition-colors disabled:opacity-40 ${isQuantized ? 'deck-btn-active' : 'deck-btn'}`}
        >
          QUANT
        </button>
        <button
          onClick={toggleSlipMode}
          disabled={!currentTrack}
          title="Slip mode — playhead advances under loops; exits to real position"
          className={`h-6 px-1.5 rounded text-[13px] font-bold border transition-colors disabled:opacity-40 ${slipMode ? 'deck-btn-active' : 'deck-btn'}`}
        >
          SLIP
        </button>
        <button
          onClick={toggleFlux}
          disabled={!currentTrack}
          title="Flux mode — shadow playhead advances at tempo while you juggle; release snaps back on-beat"
          className={`h-6 px-1.5 rounded text-[13px] font-bold border transition-colors disabled:opacity-40 ${fluxEnabled ? 'deck-btn-active' : 'deck-btn'}`}
        >
          FLUX
        </button>
        <button
          onClick={toggleKeylock}
          disabled={!currentTrack || !engineIsNative}
          title={engineIsNative
            ? 'Key lock — maintain key when changing tempo'
            : 'Key lock requires the native audio engine (not loaded)'}
          className={`h-6 px-1.5 rounded text-[13px] font-bold border transition-colors disabled:opacity-40 ${keylockEnabled ? 'deck-btn-active' : 'deck-btn'}`}
        >
          KEY
        </button>
        <button
          onClick={toggleSync}
          disabled={!currentTrack || !engineIsNative}
          title={engineIsNative
            ? 'Sync — beat-lock this deck to the other deck (shared clock)'
            : 'Sync requires the native audio engine (not loaded)'}
          className={`h-6 px-1.5 rounded text-[13px] font-bold border transition-colors disabled:opacity-40 ${synced ? 'deck-btn-active' : 'deck-btn'}`}
        >
          SYNC
        </button>

        {/* Beatgrid edit toggle */}
        <button
          onClick={() => setGridEditMode((v) => !v)}
          disabled={!currentTrack}
          title="Edit beatgrid"
          className={`h-6 px-2 rounded text-[13px] font-bold border transition-colors disabled:opacity-40 ${gridEditMode ? 'deck-btn-active' : 'deck-btn'}`}
        >
          GRID
        </button>

        {/* Stem buses toggle */}
        <button
          onClick={() => {
            if (!stemsVisible) checkStemsAvailable()
            toggleStemsVisible()
          }}
          disabled={!currentTrack}
          title="Stem buses — drums / bass / vocals / other"
          className={`h-6 px-1.5 rounded text-[13px] font-bold border transition-colors disabled:opacity-40 ${stemsVisible ? 'deck-btn-active' : 'deck-btn'}`}
        >
          STEMS
        </button>

        <div className="w-px h-4 mx-0.5 shrink-0" style={{ background: 'var(--deck-rule)' }} />

        {/* Pitch range selector + slider */}
        <div className={`flex items-center gap-1`}>
          <span className="text-[11px] uppercase tracking-[0.15em] shrink-0 mr-0.5" style={{ color: 'var(--deck-mute)' }}>Pitch</span>
          <span className="text-[12px] tabular-nums w-9 text-center" style={{ color: 'var(--deck-mute)' }}>
            {playbackRate === 1 ? '±0%' : `${playbackRate > 1 ? '+' : ''}${((playbackRate - 1) * 100).toFixed(1)}%`}
          </span>
          <input
            type="range"
            min={1 - pitchRange / 100}
            max={1 + pitchRange / 100}
            step={0.001}
            value={playbackRate}
            onChange={(e) => setPlaybackRate(parseFloat(e.target.value))}
            onDoubleClick={() => setPlaybackRate(1.0)}
            disabled={!currentTrack}
            className="w-16 h-1 cursor-pointer disabled:opacity-40"
            style={{ accentColor: 'var(--deck-spot)' }}
            title="Pitch/tempo — double-click to reset"
          />
          <select
            value={pitchRange}
            onChange={(e) => setPitchRange(Number(e.target.value))}
            disabled={!currentTrack}
            className="h-5 rounded text-[12px] border cursor-pointer disabled:opacity-40"
            style={{ background: 'var(--deck-panel)', borderColor: 'var(--deck-rule)', color: 'var(--deck-mute)', paddingLeft: 2 }}
            title="Pitch range"
          >
            {[4, 8, 16, 50].map((r) => (
              <option key={r} value={r}>±{r}%</option>
            ))}
          </select>
        </div>
      </div>

      {/* ── Beat jump ─────────────────────────────────────────────────────── */}
      <div
        className={`flex items-center gap-1 px-2 py-0.5 border-t`}
        style={{ borderColor: dkRule2 }}
      >
        <span className="text-[11px] uppercase tracking-[0.15em] shrink-0 mr-0.5" style={{ color: 'var(--deck-mute)' }}>Jump</span>
        {[-32, -16, -8, -4, -2, -1].map((b) => (
          <button
            key={b}
            onClick={() => beatJump(b)}
            disabled={!currentTrack}
            title={`Beat jump ${b}`}
            className="deck-btn h-6 px-1.5 rounded text-[13px] font-bold border transition-colors disabled:opacity-40"
          >
            {b}
          </button>
        ))}
        {[1, 2, 4, 8, 16, 32].map((b) => (
          <button
            key={b}
            onClick={() => beatJump(b)}
            disabled={!currentTrack}
            title={`Beat jump +${b}`}
            className="deck-btn h-6 px-1.5 rounded text-[13px] font-bold border transition-colors disabled:opacity-40"
          >
            +{b}
          </button>
        ))}

        <div className="flex-1" />

        {/* Saved loop slots — 8 pads */}
        {loopSlots.map((slot, i) => (
          <SavedLoopPad
            key={i}
            index={i}
            slot={slot}
            disabled={!currentTrack}
            onJump={() => jumpToLoopSlot(i)}
            onSave={() => saveLoopSlot(i)}
            onClear={() => clearLoopSlot(i)}
          />
        ))}
      </div>

      {/* ── Transport + hotcue pads ───────────────────────────────────── */}
      <div
        className={`flex items-center gap-1 px-2 pb-1.5 pt-0.5 flex-wrap border-t`}
        style={{ borderColor: dkRule2 }}
      >
        <button
          onClick={pressCue}
          disabled={!currentTrack}
          className="deck-btn h-9 px-3 rounded text-[13px] font-black tracking-widest border transition-colors disabled:opacity-40"
        >
          CUE
        </button>
        <button
          onClick={togglePlay}
          disabled={!currentTrack}
          className="h-9 w-12 rounded flex items-center justify-center transition-all disabled:opacity-40 text-sm font-bold"
          style={{
            background: isPlaying ? 'var(--deck-spot)' : 'rgba(216,106,74,0.85)',
            color: 'var(--deck-bg)',
            boxShadow: isPlaying ? '0 0 14px var(--deck-glow)' : 'none',
          }}
        >
          {isPlaying ? '❚❚' : '▶'}
        </button>

        <div className="w-px h-5 mx-0.5 shrink-0" style={{ background: 'var(--deck-rule)' }} />

        <span className="text-[11px] uppercase tracking-[0.15em] shrink-0 mr-0.5" style={{ color: 'var(--deck-mute)' }} title="Hot cues — click to jump · right-click to set/clear">Cues</span>
        {hotcues.map(({ label: lbl, index, cue, color }) => (
          <HotCuePad
            key={index}
            label={lbl}
            index={index}
            cue={cue}
            color={color}
            disabled={!currentTrack}
            onPress={() => cue ? jumpToCue(index) : setCue(index)}
            onSet={() => setCue(index)}
            onClear={() => clearCue(index)}
          />
        ))}

        <div className="w-px h-5 mx-0.5 shrink-0" style={{ background: 'var(--deck-rule)' }} />

        <button
          onClick={setMemoryCue}
          disabled={!currentTrack}
          className="h-8 px-2 rounded text-[13px] font-bold border transition-colors disabled:opacity-40"
          style={{ borderColor: 'rgba(245,158,11,0.3)', color: 'rgba(245,158,11,0.7)' }}
        >
          MEM
        </button>

        {memoryCues.map((c, i) => (
          <button
            key={i}
            onClick={() => seek(c.positionMs / 1000)}
            className="h-8 px-2 rounded text-[13px] font-mono border transition-colors tabular-nums"
            style={{ borderColor: 'rgba(245,158,11,0.2)', color: 'rgba(245,158,11,0.5)' }}
          >
            {fmt(c.positionMs / 1000)}
          </button>
        ))}
      </div>
    </div>
  )
}

// ── LedReadout ────────────────────────────────────────────────────────────────

function LedReadout({ value, ghost, label, fontSize = 14 }: {
  value: string; ghost: string; label: string; fontSize?: number
}): JSX.Element {
  return (
    <div className="led-readout shrink-0 text-right">
      <div className="led-readout-ghost" style={{ fontSize }}>{ghost}</div>
      <div className="led-readout-val" style={{ fontSize }}>{value}</div>
      <span className="led-readout-label">{label}</span>
    </div>
  )
}

// ── Analysis indicator ────────────────────────────────────────────────────────

function AnalysisIndicator({ state, onAnalyze, hasTrack }: {
  state: AnalysisState
  onAnalyze: () => void
  hasTrack: boolean
}): JSX.Element | null {
  if (!hasTrack) return null
  if (state === 'reading-tags' || state === 'analyzing') {
    return (
      <span className="text-[13px] shrink-0 animate-pulse" style={{ color: 'var(--deck-mute)' }}>
        {state === 'reading-tags' ? 'reading tags…' : 'analysing…'}
      </span>
    )
  }
  if (state === 'idle' || state === 'error') {
    return (
      <button
        onClick={onAnalyze}
        className="text-[13px] shrink-0 transition-colors"
        style={{ color: 'rgba(216,106,74,0.6)' }}
        onMouseEnter={(e) => ((e.target as HTMLElement).style.color = 'var(--deck-spot)')}
        onMouseLeave={(e) => ((e.target as HTMLElement).style.color = 'rgba(216,106,74,0.6)')}
        title="Analyse BPM and key from audio"
      >
        {state === 'error' ? 'retry analysis' : 'analyse'}
      </button>
    )
  }
  return null
}

// ── SavedLoopPad ──────────────────────────────────────────────────────────────

interface SavedLoopPadProps {
  index: number
  slot: CuePoint | null
  disabled: boolean
  onJump: () => void
  onSave: () => void
  onClear: () => void
}

function SavedLoopPad({ index, slot, disabled, onJump, onSave, onClear }: SavedLoopPadProps): JSX.Element {
  const hasSlot = slot !== null
  const loopLen = slot && slot.endMs != null
    ? fmt((slot.endMs - slot.positionMs) / 1000)
    : null

  return (
    <button
      onClick={hasSlot ? onJump : onSave}
      onContextMenu={(e) => { e.preventDefault(); hasSlot ? onClear() : onSave() }}
      disabled={disabled}
      title={
        hasSlot
          ? `Loop ${index + 1}: ${fmt(slot!.positionMs / 1000)} (${loopLen}) — click to jump · right-click clear`
          : `Loop ${index + 1}: click to save current loop`
      }
      className="relative h-7 w-8 rounded text-[12px] font-bold transition-all disabled:opacity-40 disabled:cursor-default"
      style={
        hasSlot
          ? { background: 'rgba(139,92,246,0.2)', border: '1px solid rgba(139,92,246,0.6)', color: 'rgba(139,92,246,0.9)', boxShadow: '0 0 4px rgba(139,92,246,0.2)' }
          : { background: 'rgba(42,36,28,0.4)', border: '1px solid rgba(42,36,28,0.8)', color: 'rgba(110,101,83,0.5)' }
      }
    >
      {index + 1}
      {hasSlot && loopLen && (
        <span className="absolute bottom-0.5 left-0 right-0 text-center font-normal leading-none" style={{ fontSize: 6, color: 'rgba(139,92,246,0.7)' }}>
          {loopLen}
        </span>
      )}
    </button>
  )
}

interface HotCuePadProps {
  label: string; index?: number; cue: CuePoint | undefined
  color: string; disabled: boolean
  onPress: () => void; onSet: () => void; onClear: () => void
}

function HotCuePad({ label, cue, color, disabled, onPress, onSet, onClear }: HotCuePadProps): JSX.Element {
  return (
    <button
      onClick={onPress}
      onContextMenu={(e) => { e.preventDefault(); cue ? onClear() : onSet() }}
      disabled={disabled}
      title={cue ? `${label}: ${fmt(cue.positionMs / 1000, true)} — click to jump · right-click clear` : `${label}: right-click to set`}
      className="relative h-9 w-9 rounded text-[13px] font-black tracking-wide transition-all disabled:opacity-40 disabled:cursor-default"
      style={
        cue
          ? { background: `linear-gradient(180deg,${color}44 0%,${color}18 100%)`, border: `1px solid ${color}`, color, boxShadow: `0 0 6px ${color}33` }
          : { background: 'rgba(42,36,28,0.5)', border: '1px solid rgba(140,129,106,0.35)', color: 'var(--deck-mute)' }
      }
    >
      {label}
      {cue && (
        <span className="absolute bottom-0.5 left-0 right-0 text-center font-normal leading-none" style={{ fontSize: 7, color: color + 'aa' }}>
          {fmt(cue.positionMs / 1000)}
        </span>
      )}
    </button>
  )
}
