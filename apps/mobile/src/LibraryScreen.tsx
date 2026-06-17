// Browse the synced library — tracks + playlists. Playlist create/manage is
// slice 4 (the rest is read-only browse from slice 2).

import { useMemo, useState } from 'react'
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native'
import { isEditable } from './playlists'
import type { LibraryState } from './useLibrary'
import type { Playlist, Track } from './sync-types'

type Tab = 'tracks' | 'playlists'

export function LibraryScreen({
  lib,
  onSelectTrack,
  onDisconnect,
  onCreatePlaylist,
  onManagePlaylist
}: {
  lib: LibraryState
  onSelectTrack: (t: Track) => void
  onDisconnect: () => void
  onCreatePlaylist: (name: string) => void
  onManagePlaylist: (p: Playlist) => void
}): JSX.Element {
  const [tab, setTab] = useState<Tab>('tracks')
  const [query, setQuery] = useState('')
  const [playlist, setPlaylist] = useState<Playlist | null>(null)
  const [newName, setNewName] = useState('')

  const tracks = useMemo<Track[]>(() => {
    const base = playlist
      ? playlist.trackIds.map((id) => lib.byId.get(id)).filter((t): t is Track => !!t)
      : lib.tracks
    const q = query.trim().toLowerCase()
    if (!q) return base
    return base.filter((t) => `${t.title} ${t.artist}`.toLowerCase().includes(q))
  }, [playlist, query, lib.tracks, lib.byId])

  return (
    <View style={styles.fill}>
      <View style={styles.header}>
        <Text style={styles.brand}>OFFCUT</Text>
        <Text style={styles.count}>
          {lib.tracks.length.toLocaleString()} trks · {lib.playlists.length} lists
        </Text>
        <Pressable onPress={onDisconnect} hitSlop={8}>
          <Text style={styles.link}>disconnect</Text>
        </Pressable>
      </View>

      <View style={styles.tabs}>
        {(['tracks', 'playlists'] as Tab[]).map((t) => (
          <Pressable
            key={t}
            onPress={() => {
              setTab(t)
              if (t === 'playlists') setPlaylist(null)
            }}
            style={[styles.tab, tab === t && styles.tabActive]}
          >
            <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>{t}</Text>
          </Pressable>
        ))}
      </View>

      {tab === 'tracks' && (
        <>
          {playlist && (
            <Pressable style={styles.filterChip} onPress={() => setPlaylist(null)}>
              <Text style={styles.filterChipText}>▶ {playlist.name} · tap to clear</Text>
            </Pressable>
          )}
          <TextInput
            style={styles.search}
            placeholder="Search title or artist"
            placeholderTextColor="#7a7264"
            autoCapitalize="none"
            autoCorrect={false}
            value={query}
            onChangeText={setQuery}
          />
          <FlatList
            data={tracks}
            keyExtractor={(t) => t.id}
            initialNumToRender={20}
            windowSize={11}
            refreshControl={
              <RefreshControl refreshing={lib.loading} onRefresh={lib.refresh} tintColor="#D86A4A" />
            }
            renderItem={({ item }) => (
              <Pressable style={styles.row} onPress={() => onSelectTrack(item)}>
                <View style={[styles.colorBar, item.color ? { backgroundColor: item.color } : null]} />
                <View style={styles.rowMain}>
                  <Text style={styles.title} numberOfLines={1}>{item.title || '(untitled)'}</Text>
                  <Text style={styles.sub} numberOfLines={1}>{item.artist || '—'}</Text>
                </View>
                {item.rating > 0 && <Text style={styles.rowRating}>{'★'.repeat(item.rating)}</Text>}
                <Text style={styles.meta}>
                  {item.bpm ? `${Math.round(item.bpm)}` : '–'}
                  {item.key ? ` · ${item.key}` : ''}
                </Text>
              </Pressable>
            )}
            ListEmptyComponent={
              <Text style={styles.empty}>{lib.loading ? 'Loading…' : 'No tracks'}</Text>
            }
          />
        </>
      )}

      {tab === 'playlists' && (
        <FlatList
          data={lib.playlists}
          keyExtractor={(p) => p.id}
          ListHeaderComponent={
            <View style={styles.newRow}>
              <TextInput
                style={styles.newInput}
                placeholder="New playlist name"
                placeholderTextColor="#7a7264"
                value={newName}
                onChangeText={setNewName}
                onSubmitEditing={() => {
                  if (newName.trim()) {
                    onCreatePlaylist(newName.trim())
                    setNewName('')
                  }
                }}
                returnKeyType="done"
              />
              <Pressable
                style={[styles.newBtn, !newName.trim() && styles.newBtnOff]}
                disabled={!newName.trim()}
                onPress={() => {
                  onCreatePlaylist(newName.trim())
                  setNewName('')
                }}
              >
                <Text style={styles.newBtnTxt}>Create</Text>
              </Pressable>
            </View>
          }
          renderItem={({ item }) => (
            <View style={styles.row}>
              <Pressable
                style={styles.plRowMain}
                onPress={() => {
                  setPlaylist(item)
                  setQuery('')
                  setTab('tracks')
                }}
              >
                <Text style={[styles.title, { flex: 1 }]} numberOfLines={1}>
                  {item.isSmart ? '✨ ' : item.isFolder ? '📁 ' : ''}{item.name}
                </Text>
                <Text style={styles.meta}>{item.trackIds.length}</Text>
              </Pressable>
              {isEditable(item) && (
                <Pressable hitSlop={10} onPress={() => onManagePlaylist(item)}>
                  <Text style={styles.manage}>edit</Text>
                </Pressable>
              )}
            </View>
          )}
          ListEmptyComponent={<Text style={styles.empty}>No playlists</Text>}
        />
      )}

      {lib.error && <Text style={styles.error}>⚠ {lib.error}</Text>}
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#17150f', paddingTop: 56 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 10, gap: 10 },
  brand: { color: '#ECE3CC', fontSize: 16, fontWeight: '800', letterSpacing: 3 },
  count: { color: '#a59a82', fontSize: 12, flex: 1 },
  link: { color: '#D86A4A', fontSize: 12 },
  tabs: { flexDirection: 'row', paddingHorizontal: 16, gap: 8, marginBottom: 8 },
  tab: { paddingVertical: 6, paddingHorizontal: 14, borderRadius: 6, borderWidth: 1, borderColor: '#3a352b' },
  tabActive: { backgroundColor: '#D86A4A22', borderColor: '#D86A4A' },
  tabText: { color: '#a59a82', fontSize: 13, textTransform: 'uppercase', letterSpacing: 1 },
  tabTextActive: { color: '#D86A4A' },
  filterChip: { marginHorizontal: 16, marginBottom: 6 },
  filterChipText: { color: '#D86A4A', fontSize: 12 },
  search: {
    marginHorizontal: 16,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#3a352b',
    borderRadius: 8,
    color: '#ECE3CC',
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 11,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#2a261d',
    gap: 10
  },
  rowMain: { flex: 1 },
  plRowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  manage: { color: '#D86A4A', fontSize: 13 },
  newRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, marginBottom: 10 },
  newInput: {
    flex: 1, borderWidth: 1, borderColor: '#3a352b', borderRadius: 8, color: '#ECE3CC', paddingHorizontal: 12, paddingVertical: 8, fontSize: 14
  },
  newBtn: { backgroundColor: '#D86A4A', borderRadius: 8, paddingHorizontal: 16, justifyContent: 'center' },
  newBtnOff: { backgroundColor: '#2a261d' },
  newBtnTxt: { color: '#17150f', fontSize: 13, fontWeight: '700' },
  colorBar: { width: 3, alignSelf: 'stretch', borderRadius: 2, backgroundColor: 'transparent' },
  title: { color: '#ECE3CC', fontSize: 15, flex: 1 },
  sub: { color: '#8c8270', fontSize: 12, marginTop: 1 },
  rowRating: { color: '#C9A02C', fontSize: 11 },
  meta: { color: '#a59a82', fontSize: 12, fontVariant: ['tabular-nums'] },
  empty: { color: '#7a7264', textAlign: 'center', marginTop: 40 },
  error: { color: '#e0726f', fontSize: 12, textAlign: 'center', padding: 8 }
})
