// Track detail — metadata, waveform from /media/peaks (cached), audition of the
// AAC proxy, prep editing, and "save for offline". Peaks/snapshot are cached so
// this works offline; audio plays from a downloaded file when saved offline.

import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useAudioPlayer, useAudioPlayerStatus, setAudioModeAsync } from 'expo-audio'
import { Waveform } from './Waveform'
import { TrackEditor } from './TrackEditor'
import { isEditable } from './playlists'
import { getCachedPeaks, cachePeaks, cachedAudioUri, saveAudioOffline, removeAudioOffline } from './offline'
import type { SyncClient } from './syncClient'
import type { PeaksData, Playlist, Track, SyncPushPayload, SyncPushResult } from './sync-types'

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

  const player = useAudioPlayer({ uri: client.proxyUrl(track.id) })
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

  const toggle = (): void => {
    if (status.playing) player.pause()
    else player.play()
  }

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
        {track.bpm != null && <Meta label="BPM" value={`${Math.round(track.bpm)}`} />}
        {track.key && <Meta label="KEY" value={track.key} />}
        {track.energy != null && <Meta label="ENERGY" value={`${track.energy}`} />}
        {track.durationSeconds != null && <Meta label="LEN" value={mmss(track.durationSeconds)} />}
      </View>

      <View style={styles.waveBox}>
        {peaks ? (
          <Waveform data={peaks} />
        ) : peaksErr ? (
          <Text style={styles.dim}>waveform unavailable</Text>
        ) : (
          <ActivityIndicator color="#D86A4A" />
        )}
      </View>

      <View style={styles.transport}>
        <Pressable style={styles.playBtn} onPress={toggle} disabled={!status.isLoaded}>
          <Text style={styles.playIcon}>{status.playing ? '❚❚' : '▶'}</Text>
        </Pressable>
        <Text style={styles.time}>
          {mmss(status.currentTime)} / {mmss(status.duration || track.durationSeconds || 0)}
        </Text>
        {!status.isLoaded && <Text style={styles.dim}>buffering…</Text>}
      </View>

      <Pressable style={styles.offlineBtn} onPress={() => void toggleOffline()} disabled={savingOffline}>
        <Text style={[styles.offlineTxt, offlineUri && styles.offlineTxtOn]}>
          {savingOffline ? 'Saving…' : offlineUri ? '✓ Saved offline — tap to remove' : '⤓ Save for offline'}
        </Text>
      </Pressable>

      <AddToPlaylist playlists={playlists} track={track} onAdd={onAddToPlaylist} />

      <TrackEditor
        track={track}
        push={push}
        player={player}
        playheadSec={status.currentTime}
        onPatched={onPatched}
      />
    </ScrollView>
  )
}

function Meta({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <View style={styles.meta}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue}>{value}</Text>
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
  fill: { flex: 1, backgroundColor: '#17150f' },
  content: { padding: 20, paddingTop: 60, gap: 6 },
  back: { color: '#D86A4A', fontSize: 14, marginBottom: 12 },
  title: { color: '#ECE3CC', fontSize: 22, fontWeight: '700' },
  artist: { color: '#a59a82', fontSize: 16, marginBottom: 12 },
  metaRow: { flexDirection: 'row', gap: 18, marginBottom: 18, flexWrap: 'wrap' },
  meta: { gap: 2 },
  metaLabel: { color: '#7a7264', fontSize: 10, letterSpacing: 1 },
  metaValue: { color: '#ECE3CC', fontSize: 16, fontVariant: ['tabular-nums'] },
  waveBox: { minHeight: 96, justifyContent: 'center', backgroundColor: '#0e0d09', borderRadius: 8, padding: 8, marginBottom: 18 },
  dim: { color: '#7a7264', fontSize: 12, textAlign: 'center' },
  offlineBtn: { marginTop: 14, borderWidth: 1, borderColor: '#3a352b', borderRadius: 8, paddingVertical: 9, alignItems: 'center' },
  offlineTxt: { color: '#a59a82', fontSize: 12, fontWeight: '600' },
  offlineTxtOn: { color: '#6E8059' },
  addWrap: { marginTop: 18, gap: 8 },
  addBtn: { borderWidth: 1, borderColor: '#3a352b', borderRadius: 8, paddingVertical: 10, alignItems: 'center' },
  addBtnTxt: { color: '#D86A4A', fontSize: 13, fontWeight: '600' },
  addList: { borderWidth: 1, borderColor: '#2a261d', borderRadius: 8, overflow: 'hidden' },
  addRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#2a261d' },
  addRowTxt: { color: '#ECE3CC', fontSize: 14, flex: 1 },
  addRowCount: { color: '#7a7264', fontSize: 12, marginLeft: 10 },
  addMsg: { color: '#a59a82', fontSize: 12, textAlign: 'center' },
  transport: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  playBtn: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#D86A4A', alignItems: 'center', justifyContent: 'center' },
  playIcon: { color: '#17150f', fontSize: 20, fontWeight: '800' },
  time: { color: '#ECE3CC', fontSize: 15, fontVariant: ['tabular-nums'] },
  note: { color: '#7a7264', fontSize: 12, marginTop: 24, lineHeight: 18 }
})
