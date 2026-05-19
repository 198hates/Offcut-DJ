import { usePlayerStore } from '../store/playerStore'
import { Waveform } from './Waveform'

function fmt(s: number): string {
  if (!isFinite(s) || s < 0) return '0:00'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

export function Player(): JSX.Element {
  const { currentTrack, isPlaying, currentTime, duration, waveformPeaks, isLoading, togglePlay, seek, setVolume } =
    usePlayerStore()

  return (
    <div className="h-20 bg-surface-900 border-t border-white/5 flex items-center gap-3 px-4 shrink-0">
      {/* Track info */}
      <div className="w-48 shrink-0">
        {currentTrack ? (
          <>
            <p className="text-sm font-medium text-white truncate leading-tight">{currentTrack.title || 'Untitled'}</p>
            <p className="text-xs text-white/50 truncate leading-tight mt-0.5">{currentTrack.artist || 'Unknown artist'}</p>
            <p className="text-xs text-white/25 mt-0.5">
              {currentTrack.bpm ? `${currentTrack.bpm.toFixed(1)} BPM` : '— BPM'}
              {currentTrack.key ? ` · ${currentTrack.key}` : ''}
            </p>
          </>
        ) : (
          <p className="text-xs text-white/20">Double-click a track to load</p>
        )}
      </div>

      {/* Play / pause */}
      <button
        onClick={togglePlay}
        disabled={!currentTrack}
        className="w-9 h-9 shrink-0 rounded-full bg-accent hover:bg-accent-hover disabled:opacity-30 disabled:cursor-default flex items-center justify-center text-white transition-colors text-sm"
        title={isPlaying ? 'Pause' : 'Play'}
      >
        {isPlaying ? '❚❚' : '▶'}
      </button>

      {/* Time */}
      <span className="text-xs text-white/40 font-mono w-10 shrink-0 text-right tabular-nums">
        {fmt(currentTime)}
      </span>

      {/* Waveform */}
      <Waveform
        peaks={waveformPeaks}
        duration={duration}
        currentTime={currentTime}
        cuePoints={currentTrack?.cuePoints ?? []}
        onSeek={seek}
        isLoading={isLoading}
      />

      {/* Remaining time */}
      <span className="text-xs text-white/40 font-mono w-10 shrink-0 tabular-nums">
        {currentTrack ? `-${fmt(duration - currentTime)}` : '0:00'}
      </span>

      {/* Volume */}
      <div className="shrink-0 flex items-center gap-1.5 w-20">
        <span className="text-white/30 text-xs select-none">▲</span>
        <input
          type="range"
          min={0} max={1} step={0.01}
          defaultValue={0.8}
          onChange={(e) => setVolume(parseFloat(e.target.value))}
          className="flex-1 h-1 cursor-pointer accent-accent"
        />
      </div>
    </div>
  )
}
