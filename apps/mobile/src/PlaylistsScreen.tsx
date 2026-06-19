// The Playlists tab: create a playlist, browse all of them (regular, smart, and
// folders). Tapping a row opens it (PlaylistScreen) — editable lists land in the
// manage view, smart/folder lists in a read-only track view. Smart counts are
// evaluated client-side.

import { useMemo, useState } from 'react'
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { playlistTracks } from './smartRules'
import { C, MONO, MONO_BOLD } from './theme'
import type { PlaylistActions } from './usePlaylists'
import type { LibraryState } from './useLibrary'
import type { Playlist } from './sync-types'

export function PlaylistsScreen({
  lib,
  actions,
  onOpenPlaylist
}: {
  lib: LibraryState
  actions: PlaylistActions
  onOpenPlaylist: (p: Playlist) => void
}): JSX.Element {
  const insets = useSafeAreaInsets()
  const [newName, setNewName] = useState('')

  const smartCounts = useMemo<Map<string, number>>(() => {
    const m = new Map<string, number>()
    for (const p of lib.playlists) {
      if (p.isSmart) m.set(p.id, playlistTracks(p, lib.tracks, lib.byId).length)
    }
    return m
  }, [lib.playlists, lib.tracks, lib.byId])

  const create = (): void => {
    const name = newName.trim()
    if (!name) return
    void actions.create(name)
    setNewName('')
  }

  return (
    <View style={[styles.fill, { paddingTop: insets.top + 8 }]}>
      <View style={styles.head}>
        <Text style={styles.heading}>Playlists</Text>
        <Text style={styles.count}>{lib.playlists.length}</Text>
      </View>

      <FlatList
        data={lib.playlists}
        keyExtractor={(p) => p.id}
        ListHeaderComponent={
          <View style={styles.newRow}>
            <TextInput
              style={styles.newInput}
              placeholder="New playlist name"
              placeholderTextColor={C.muted}
              value={newName}
              onChangeText={setNewName}
              onSubmitEditing={create}
              returnKeyType="done"
            />
            <Pressable style={[styles.newBtn, !newName.trim() && styles.newBtnOff]} disabled={!newName.trim()} onPress={create}>
              <Text style={styles.newBtnTxt}>Create</Text>
            </Pressable>
          </View>
        }
        renderItem={({ item }) => {
          const count = item.isSmart ? (smartCounts.get(item.id) ?? 0) : item.trackIds.length
          return (
            <Pressable style={({ pressed }) => [styles.row, pressed && styles.rowPressed]} onPress={() => onOpenPlaylist(item)}>
              <View style={[styles.icon, item.color ? { backgroundColor: `${item.color}2E`, borderColor: item.color } : null]}>
                <Text style={styles.iconGlyph}>{item.isSmart ? '✨' : item.isFolder ? '▤' : '≡'}</Text>
              </View>
              <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
              <Text style={styles.cnt}>{count}</Text>
              <Text style={styles.chev}>›</Text>
            </Pressable>
          )
        }}
        ListEmptyComponent={<Text style={styles.empty}>No playlists</Text>}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: C.bg },
  head: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 12 },
  heading: { color: C.ink, fontFamily: MONO_BOLD, fontSize: 22, letterSpacing: 0.5 },
  count: { color: C.muted, fontFamily: MONO, fontSize: 12 },
  newRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, marginBottom: 12 },
  newInput: { flex: 1, backgroundColor: C.paper, borderWidth: 1, borderColor: C.border, borderRadius: 8, color: C.ink, fontFamily: MONO, paddingHorizontal: 12, paddingVertical: 9, fontSize: 14 },
  newBtn: { backgroundColor: C.accent, borderRadius: 8, paddingHorizontal: 16, justifyContent: 'center' },
  newBtnOff: { backgroundColor: C.panel },
  newBtnTxt: { color: C.bg, fontFamily: MONO_BOLD, fontSize: 13 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 16, gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  rowPressed: { backgroundColor: C.panel },
  icon: { width: 34, height: 34, borderRadius: 6, backgroundColor: C.paper, borderWidth: StyleSheet.hairlineWidth, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
  iconGlyph: { fontSize: 14, color: C.inkSoft },
  name: { flex: 1, color: C.ink, fontFamily: MONO, fontSize: 14 },
  cnt: { color: C.muted, fontFamily: MONO_BOLD, fontSize: 12, fontVariant: ['tabular-nums'] },
  chev: { color: C.muted, fontFamily: MONO, fontSize: 18 },
  empty: { color: C.muted, fontFamily: MONO, textAlign: 'center', marginTop: 40 }
})
