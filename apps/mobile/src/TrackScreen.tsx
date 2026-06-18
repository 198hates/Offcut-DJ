// Track detail — metadata, waveform from /media/peaks (cached), audition of the
// AAC proxy, prep editing, and "save for offline". Peaks/snapshot are cached so
// this works offline; audio plays from a downloaded file when saved offline.

import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useAudioPlayer, useAudioPlayerStatus, setAudioModeAsync } from 'expo-audio'
import { DeckWaveform } from './DeckWaveform'
import { TransportControls } from './TransportControls'
import { TrackEditor } from './TrackEditor'
import { isEditable } from './playlists'
import { getCachedPeaks, cachePeaks, cachedAudioUri, saveAudioOffline, removeAudioOffline } from './offline'
import { C, MONO, MONO_BOLD } from './theme'
import type { SyncClient } from './syncClient'
import type { CuePoint, PeaksData, Playlist, Track, SyncPushPayload, SyncPushResult } from './sync-types'

type Push = (payload: SyncPushPayload) => Promise<SyncPushResult | null>

function mmss(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const s = Math.floor(sec)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function TrackScreen({
  track,
  client,
  push,
  onBack,
  onPatched,
  playlists,
  onAddToPlaylist
}: {
  track: Track
  client: SyncClient
  push: Push
  onBack: () => void
  onPatched: (id: string, fields: Partial<Track>) => void
  playlists: Playlist[]
  onAddToPlaylist: (p: Playlist, trackId: string) => Promise<void>
}): JSX.Element {
  const [peaks, setPeaks] = useState<PeaksData | null>(null)
  const [peaksErr, setPeaksErr] = useState<string | null>(null)
  const [offlineUri, setOfflineUri] = useState<string | null>(null)
  const [savingOffline, setSavingOffline] = useState(false)

  // Hot cues are the single source of truth here (the transport pads + waveform
  // share them). Like the desktop, they persist immediately — separate from the
  // metadata draft+Save in TrackEditor.
  const [cues, setCues] = useState<CuePoint[]>(track.cuePoints ?? [])
  useEffect(() => setCues(track.cuePoints ?? []), [track.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const commitCues = (next: CuePoint[]): void => {
    setCues(next)
    onPatched(track.id, { cuePoints: next })
    void push({ tracks: [{ id: track.id, updatedAt: new Date().toISOString(), cuePoints: next }] })
  }

  // Faster status ticks so beat-loop wrap + the scrolling waveform stay tight.
  const player = useAudioPlayer({ uri: client.proxyUrl(track.id) }, { updateInterval: 100 })
  const status = useAudioPlayerStatus(player)

  useEffect(() => {
    // iOS won't play through the silent switch unless we opt in.
    void setAudioModeAsync({ playsInSilentMode: true })
  }, [])

  // Peaks: paint from cache instantly, then refresh from the desktop if reachable.
  useEffect(() => {
    let cancelled = false
    setPeaks(null)
    setPeaksErr(null)
    void (async () => {
      const cached = await getCachedPeaks(track.id)
      if (cached && !cancelled) setPeaks(cached)
      try {
        const fresh = await client.peaks(track.id)
        if (cancelled) return
        setPeaks(fresh)
        void cachePeaks(track.id, fresh)
      } catch (e) {
        if (!cancelled && !cached) setPeaksErr((e as Error).message)
      }
    })()
    return () => { cancelled = true }
  }, [client, track.id])

  // If this track was saved offline, play the local file instead of streaming.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const uri = await cachedAudioUri(track.id)
      if (cancelled) return
      setOfflineUri(uri)
      if (uri) player.replace({ uri })
    })()
    return () => { cancelled = true }
  }, [track.id, player])

  const toggleOffline = async (): Promise<void> => {
    setSavingOffline(true)
    try {
      if (offlineUri) {
        await removeAudioOffline(track.id)
        setOfflineUri(null)
        player.replace({ uri: client.proxyUrl(track.id) }) // back to streaming
      } else {
        const uri = await saveAudioOffline(track.id, client.proxyUrl(track.id))
        setOfflineUri(uri)
        player.replace({ uri })
      }
    } catch {
      /* leave state as-is; a failed download just means not-saved */
    } finally {
      setSavingOffline(false)
    }
  }

  return (
    <ScrollView style={styles.fill} contentContainerStyle={styles.content}>
      <Pressable onPress={onBack} hitSlop={8}>
        <Text style={styles.back}>‹ library</Text>
      </Pressable>

      <Text style={styles.title}>{track.title || '(untitled)'}</Text>
      <Text style={styles.artist}>{track.artist || '—'}</Text>

      <View style={styles.metaRow}>
        {track.bpm != null && <Meta label="BPM" value={`${Math.round(track.bpm)}`} accent />}
        {track.key && <Meta label="KEY" value={track.key} accent />}
        {track.energy != null && <Meta label="ENERGY" value={`${track.energy}`} />}
        {track.durationSeconds != null && <Meta label="LEN" value={mmss(track.durationSeconds)} />}
      </View>

      <View style={styles.waveBox}>
        {peaks ? (
          <DeckWaveform
            data={peaks}
            currentTime={status.currentTime}
            duration={status.duration || track.durationSeconds || peaks.durationSec}
            playing={status.playing}
            cues={cues}
            onSeek={(s) => void player.seekTo(s)}
          />
        ) : peaksErr ? (
          <Text style={styles.dim}>waveform unavailable</Text>
        ) : (
          <ActivityIndicator color="#D86A4A" />
        )}
      </View>

      <TransportControls track={track} player={player} status={status} cues={cues} onCommitCues={commitCues} />

      <Pressable style={styles.offlineBtn} onPress={() => void toggleOffline()} disabled={savingOffline}>
        <Text style={[styles.offlineTxt, offlineUri && styles.offlineTxtOn]}>
          {savingOffline ? 'Saving…' : offlineUri ? '✓ Saved offline — tap to remove' : '⤓ Save for offline'}
        </Text>
      </Pressable>

      <AddToPlaylist playlists={playlists} track={track} onAdd={onAddToPlaylist} />

      <TrackEditor track={track} push={push} onPatched={onPatched} />
    </ScrollView>
  )
}

function Meta({ label, value, accent }: { label: string; value: string; accent?: boolean }): JSX.Element {
  return (
    <View style={styles.meta}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={[styles.metaValue, accent && styles.metaValueAccent]}>{value}</Text>
    </View>
  )
}

function AddToPlaylist({
  playlists,
  track,
  onAdd
}: {
  playlists: Playlist[]
  track: Track
  onAdd: (p: Playlist, trackId: string) => Promise<void>
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const targets = playlists.filter(isEditable)

  const add = (p: Playlist): void => {
    setMsg(null)
    const already = p.trackIds.includes(track.id)
    onAdd(p, track.id)
      .then(() => setMsg(already ? `Already in ${p.name}` : `Added to ${p.name} ✓`))
      .catch((e) => setMsg((e as Error).message))
    setOpen(false)
  }

  return (
    <View style={styles.addWrap}>
      <Pressable style={styles.addBtn} onPress={() => setOpen((o) => !o)}>
        <Text style={styles.addBtnTxt}>＋ Add to playlist {open ? '▴' : '▾'}</Text>
      </Pressable>
      {open && (
        <View style={styles.addList}>
          {targets.length === 0 && <Text style={styles.dim}>No editable playlists — create one first.</Text>}
          {targets.map((p) => (
            <Pressable key={p.id} style={styles.addRow} onPress={() => add(p)}>
              <Text style={styles.addRowTxt} numberOfLines={1}>{p.name}</Text>
              <Text style={styles.addRowCount}>{p.trackIds.length}</Text>
            </Pressable>
          ))}
        </View>
      )}
      {msg && <Text style={styles.addMsg}>{msg}</Text>}
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: C.bg },
  content: { padding: 20, paddingTop: 60, gap: 6 },
  back: { color: C.accent, fontFamily: MONO, fontSize: 12, letterSpacing: 0.5, marginBottom: 12 },
  title: { color: C.ink, fontFamily: MONO_BOLD, fontSize: 20 },
  artist: { color: C.muted, fontFamily: MONO, fontSize: 14, marginBottom: 14 },
  metaRow: { flexDirection: 'row', gap: 22, marginBottom: 18, flexWrap: 'wrap' },
  meta: { gap: 3 },
  metaLabel: { color: C.muted, fontFamily: MONO, fontSize: 9, letterSpacing: 1.6 },
  metaValue: { color: C.ink, fontFamily: MONO_BOLD, fontSize: 15, fontVariant: ['tabular-nums'] },
  metaValueAccent: { color: C.accent },
  waveBox: { minHeight: 112, justifyContent: 'center', backgroundColor: C.deckPanel, borderRadius: 6, overflow: 'hidden', paddingHorizontal: 6, marginBottom: 18 },
  dim: { color: C.muted, fontFamily: MONO, fontSize: 12, textAlign: 'center' },
  offlineBtn: { marginTop: 14, borderWidth: 1, borderColor: 'rgba(42,36,28,0.8)', borderRadius: 4, paddingVertical: 9, alignItems: 'center' },
  offlineTxt: { color: C.muted, fontFamily: MONO, fontSize: 11, letterSpacing: 0.5 },
  offlineTxtOn: { color: '#6E8059' },
  addWrap: { marginTop: 18, gap: 8 },
  addBtn: { borderWidth: 1, borderColor: 'rgba(42,36,28,0.8)', borderRadius: 4, paddingVertical: 10, alignItems: 'center' },
  addBtnTxt: { color: C.accent, fontFamily: MONO, fontSize: 12, letterSpacing: 0.5 },
  addList: { borderWidth: 1, borderColor: C.border, borderRadius: 4, overflow: 'hidden' },
  addRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  addRowTxt: { color: C.ink, fontFamily: MONO, fontSize: 13, flex: 1 },
  addRowCount: { color: C.muted, fontFamily: MONO, fontSize: 12, marginLeft: 10 },
  addMsg: { color: C.muted, fontFamily: MONO, fontSize: 11, textAlign: 'center' },
  transport: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  playBtn: { width: 52, height: 52, borderRadius: 26, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  playIcon: { color: C.bg, fontSize: 18, fontWeight: '800' },
  time: { color: C.ink, fontFamily: MONO, fontSize: 14, fontVariant: ['tabular-nums'] }
})
