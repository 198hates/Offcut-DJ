// The Library tab: search + browse every synced track. Playlists live in their
// own tab now (PlaylistsScreen); tapping a row pushes the track detail via the
// navigator. Restyled to the desktop palette + JetBrains Mono.

import { useMemo, useState } from 'react'
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Artwork } from './Artwork'
import { BatchEditBar } from './BatchEditBar'
import { C, MONO, MONO_BOLD } from './theme'
import type { BatchFields } from './edits'
import type { LibraryState } from './useLibrary'
import type { Track } from './sync-types'

export function LibraryScreen({
  lib,
  onSelectTrack,
  artworkUrl,
  onBatchEdit
}: {
  lib: LibraryState
  onSelectTrack: (t: Track) => void
  artworkUrl: (trackId: string) => string
  onBatchEdit: (ids: string[], fields: BatchFields) => void
}): JSX.Element {
  const insets = useSafeAreaInsets()
  const [query, setQuery] = useState('')

  // multi-select for batch editing (long-press a row to enter)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const toggle = (id: string): void =>
    setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const enterSelect = (id: string): void => { setSelecting(true); setSelected(new Set([id])) }
  const clearSelect = (): void => { setSelecting(false); setSelected(new Set()) }

  const tracks = useMemo<Track[]>(() => {
    const q = query.trim().toLowerCase()
    if (!q) return lib.tracks
    return lib.tracks.filter((t) => `${t.title} ${t.artist}`.toLowerCase().includes(q))
  }, [query, lib.tracks])

  return (
    <View style={[styles.fill, { paddingTop: insets.top + 8 }]}>
      <View style={styles.head}>
        <Text style={styles.heading}>Library</Text>
        <Text style={styles.count}>{lib.tracks.length.toLocaleString()} tracks</Text>
      </View>

      <TextInput
        style={styles.search}
        placeholder="Search title or artist"
        placeholderTextColor={C.muted}
        autoCapitalize="none"
        autoCorrect={false}
        value={query}
        onChangeText={setQuery}
      />

      <FlatList
        style={styles.list}
        data={tracks}
        keyExtractor={(t) => t.id}
        initialNumToRender={18}
        windowSize={11}
        removeClippedSubviews
        extraData={selected}
        refreshControl={<RefreshControl refreshing={lib.loading} onRefresh={lib.refresh} tintColor={C.accent} />}
        renderItem={({ item }) => {
          const sel = selected.has(item.id)
          return (
            <Pressable
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed, sel && styles.rowSel]}
              onPress={() => (selecting ? toggle(item.id) : onSelectTrack(item))}
              onLongPress={() => enterSelect(item.id)}
            >
              {selecting && (
                <View style={[styles.check, sel && styles.checkOn]}>{sel && <Text style={styles.checkMark}>✓</Text>}</View>
              )}
              {item.color ? <View style={[styles.colorBar, { backgroundColor: item.color }]} /> : <View style={styles.colorBar} />}
              <Artwork url={artworkUrl(item.id)} size={44} label={item.title} color={item.color} />
              <View style={styles.main}>
                <Text style={styles.title} numberOfLines={1}>{item.title || '(untitled)'}</Text>
                <Text style={styles.sub} numberOfLines={1}>{item.artist || '—'}</Text>
              </View>
              <View style={styles.badges}>
                {item.rating > 0 && <Text style={styles.rating}>{'★'.repeat(item.rating)}</Text>}
                <View style={styles.metaRow}>
                  {item.bpm ? <Text style={styles.bpm}>{Math.round(item.bpm)}</Text> : null}
                  {item.key ? <Text style={styles.key}>{item.key}</Text> : null}
                </View>
              </View>
            </Pressable>
          )
        }}
        ListEmptyComponent={<Text style={styles.empty}>{lib.loading ? 'Loading…' : 'No tracks'}</Text>}
      />

      {lib.error && <Text style={styles.error}>⚠ {lib.error}</Text>}

      {selecting && selected.size > 0 && (
        <BatchEditBar count={selected.size} onApply={(fields) => onBatchEdit(Array.from(selected), fields)} onClear={clearSelect} />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: C.bg },
  head: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 10 },
  heading: { color: C.ink, fontFamily: MONO_BOLD, fontSize: 22, letterSpacing: 0.5 },
  count: { color: C.muted, fontFamily: MONO, fontSize: 12 },
  search: {
    marginHorizontal: 16,
    marginBottom: 10,
    backgroundColor: C.paper,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 8,
    color: C.ink,
    fontFamily: MONO,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 14
  },
  list: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, paddingRight: 16, paddingLeft: 0, gap: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  rowPressed: { backgroundColor: C.panel },
  rowSel: { backgroundColor: '#D86A4A1F' },
  check: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, borderColor: C.muted, marginLeft: 14, alignItems: 'center', justifyContent: 'center' },
  checkOn: { backgroundColor: C.accent, borderColor: C.accent },
  checkMark: { color: C.bg, fontSize: 12, fontWeight: '800' },
  colorBar: { width: 3, alignSelf: 'stretch', backgroundColor: 'transparent' },
  main: { flex: 1 },
  title: { color: C.ink, fontFamily: MONO, fontSize: 14 },
  sub: { color: C.muted, fontFamily: MONO, fontSize: 11, marginTop: 2 },
  badges: { alignItems: 'flex-end', gap: 3 },
  rating: { color: '#C9A02C', fontSize: 10 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  bpm: { color: C.inkSoft, fontFamily: MONO_BOLD, fontSize: 12, fontVariant: ['tabular-nums'] },
  key: { color: C.accent, fontFamily: MONO_BOLD, fontSize: 11 },
  empty: { color: C.muted, fontFamily: MONO, textAlign: 'center', marginTop: 40 },
  error: { color: C.rec, fontFamily: MONO, fontSize: 12, textAlign: 'center', padding: 8 }
})
