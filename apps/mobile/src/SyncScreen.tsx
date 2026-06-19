// The Sync tab: connection/queue status, a manual flush, library totals, and
// disconnect (re-pair). This used to be crammed into the library header.

import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { C, MONO, MONO_BOLD } from './theme'
import type { LibraryState } from './useLibrary'
import type { Outbox } from './useOutbox'

export function SyncScreen({
  lib,
  outbox,
  onDisconnect
}: {
  lib: LibraryState
  outbox: Outbox
  onDisconnect: () => void
}): JSX.Element {
  const insets = useSafeAreaInsets()
  const { online, pending, flushing } = outbox

  const state = flushing
    ? 'Syncing…'
    : online
      ? pending > 0
        ? `${pending} edit${pending === 1 ? '' : 's'} queued`
        : 'Synced'
      : pending > 0
        ? `Offline · ${pending} queued`
        : 'Offline'

  return (
    <View style={[styles.fill, { paddingTop: insets.top + 8 }]}>
      <Text style={styles.heading}>Sync</Text>

      <View style={styles.card}>
        <View style={styles.statusRow}>
          <View style={[styles.dot, { backgroundColor: online ? '#6E8059' : C.muted }]} />
          <Text style={styles.status}>{state}</Text>
        </View>
        <Pressable
          style={[styles.syncBtn, (flushing || pending === 0) && styles.syncBtnOff]}
          disabled={flushing || pending === 0}
          onPress={() => void outbox.flush()}
        >
          <Text style={styles.syncBtnTxt}>{flushing ? 'Syncing…' : 'Sync now'}</Text>
        </Pressable>
      </View>

      <View style={styles.statsRow}>
        <Stat label="TRACKS" value={lib.tracks.length.toLocaleString()} />
        <Stat label="PLAYLISTS" value={`${lib.playlists.length}`} />
      </View>

      {lib.error && <Text style={styles.error}>⚠ {lib.error}</Text>}

      <View style={{ flex: 1 }} />
      <Pressable style={styles.disconnect} onPress={onDisconnect}>
        <Text style={styles.disconnectTxt}>Disconnect / re-pair</Text>
      </Pressable>
    </View>
  )
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: C.bg, paddingHorizontal: 16 },
  heading: { color: C.ink, fontFamily: MONO_BOLD, fontSize: 22, letterSpacing: 0.5, marginBottom: 16 },
  card: { backgroundColor: C.panel, borderRadius: 10, padding: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: C.border, gap: 14 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  status: { color: C.ink, fontFamily: MONO, fontSize: 14 },
  syncBtn: { backgroundColor: C.accent, borderRadius: 8, paddingVertical: 11, alignItems: 'center' },
  syncBtnOff: { backgroundColor: C.paper },
  syncBtnTxt: { color: C.bg, fontFamily: MONO_BOLD, fontSize: 13 },
  statsRow: { flexDirection: 'row', gap: 12, marginTop: 14 },
  stat: { flex: 1, backgroundColor: C.panel, borderRadius: 10, padding: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: C.border },
  statValue: { color: C.ink, fontFamily: MONO_BOLD, fontSize: 22, fontVariant: ['tabular-nums'] },
  statLabel: { color: C.muted, fontFamily: MONO, fontSize: 10, letterSpacing: 1.4, marginTop: 4 },
  error: { color: C.rec, fontFamily: MONO, fontSize: 12, marginTop: 14 },
  disconnect: { borderWidth: 1, borderColor: C.border, borderRadius: 8, paddingVertical: 13, alignItems: 'center', marginBottom: 24 },
  disconnectTxt: { color: C.accent, fontFamily: MONO, fontSize: 13 }
})
