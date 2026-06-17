// Track detail — metadata, waveform from /media/peaks, and audition of the AAC
// proxy via expo-audio. Read-only (slice 2).

import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useAudioPlayer, useAudioPlayerStatus, setAudioModeAsync } from 'expo-audio'
import { Waveform } from './Waveform'
import type { SyncClient } from './syncClient'
import type { PeaksData, Track } from './sync-types'

function mmss(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const s = Math.floor(sec)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function TrackScreen({
  track,
  client,
  onBack
}: {
  track: Track
  client: SyncClient
  onBack: () => void
}): JSX.Element {
  const [peaks, setPeaks] = useState<PeaksData | null>(null)
  const [peaksErr, setPeaksErr] = useState<string | null>(null)

  const player = useAudioPlayer({ uri: client.proxyUrl(track.id) })
  const status = useAudioPlayerStatus(player)

  useEffect(() => {
    // iOS won't play through the silent switch unless we opt in.
    void setAudioModeAsync({ playsInSilentMode: true })
  }, [])

  useEffect(() => {
    let cancelled = false
    setPeaks(null)
    setPeaksErr(null)
    client
      .peaks(track.id)
      .then((p) => { if (!cancelled) setPeaks(p) })
      .catch((e) => { if (!cancelled) setPeaksErr((e as Error).message) })
    return () => { cancelled = true }
  }, [client, track.id])

  const toggle = (): void => {
    if (status.playing) player.pause()
    else player.play()
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

      <Text style={styles.note}>
        Auditioning the desktop's AAC proxy over the LAN. Editing (rating, cues…) comes next.
      </Text>
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
  transport: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  playBtn: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#D86A4A', alignItems: 'center', justifyContent: 'center' },
  playIcon: { color: '#17150f', fontSize: 20, fontWeight: '800' },
  time: { color: '#ECE3CC', fontSize: 15, fontVariant: ['tabular-nums'] },
  note: { color: '#7a7264', fontSize: 12, marginTop: 24, lineHeight: 18 }
})
