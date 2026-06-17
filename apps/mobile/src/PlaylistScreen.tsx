// Manage one playlist (slice 4): rename, recolour, reorder/remove tracks, and
// delete. Membership + meta edits buffer into a draft and push in one Save;
// delete is immediate (with a confirm). Smart playlists / folders are read-only.

import { useMemo, useState } from 'react'
import { Alert, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { TRACK_COLORS } from './edits'
import { move, isEditable } from './playlists'
import type { PlaylistActions } from './usePlaylists'
import type { LibraryState } from './useLibrary'
import type { Track } from './sync-types'

export function PlaylistScreen({
  playlistId,
  lib,
  actions,
  onBack,
  onSelectTrack
}: {
  playlistId: string
  lib: LibraryState
  actions: PlaylistActions
  onBack: () => void
  onSelectTrack: (t: Track) => void
}): JSX.Element {
  const playlist = lib.playlists.find((p) => p.id === playlistId) ?? null

  const [name, setName] = useState(playlist?.name ?? '')
  const [color, setColor] = useState(playlist?.color ?? '')
  const [order, setOrder] = useState<string[]>(playlist?.trackIds ?? [])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const rows = useMemo<Track[]>(
    () => order.map((id) => lib.byId.get(id)).filter((t): t is Track => !!t),
    [order, lib.byId]
  )

  if (!playlist) {
    // Deleted out from under us.
    return (
      <View style={[styles.fill, styles.center]}>
        <Text style={styles.dim}>Playlist removed.</Text>
        <Pressable style={styles.btnGhost} onPress={onBack}>
          <Text style={styles.btnGhostTxt}>Back</Text>
        </Pressable>
      </View>
    )
  }

  const editable = isEditable(playlist)
  const dirty =
    name !== playlist.name ||
    color !== playlist.color ||
    order.length !== playlist.trackIds.length ||
    order.some((id, i) => id !== playlist.trackIds[i])

  const save = async (): Promise<void> => {
    setBusy(true)
    setMsg(null)
    try {
      await actions.update(playlist, { name: name.trim() || playlist.name, color, trackIds: order })
      setMsg('Saved to desktop ✓')
    } catch (e) {
      // Roll the draft back to whatever the library now holds.
      const cur = lib.playlists.find((p) => p.id === playlistId)
      if (cur) {
        setName(cur.name)
        setColor(cur.color)
        setOrder(cur.trackIds)
      }
      setMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const confirmDelete = (): void => {
    Alert.alert('Delete playlist?', `"${playlist.name}" — this removes it on the desktop too.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          setBusy(true)
          actions
            .remove(playlist)
            .then(onBack)
            .catch((e) => {
              setBusy(false)
              setMsg((e as Error).message)
            })
        }
      }
    ])
  }

  return (
    <View style={styles.fill}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={8}>
          <Text style={styles.back}>‹ playlists</Text>
        </Pressable>
        {editable && (
          <Pressable onPress={confirmDelete} hitSlop={8} disabled={busy}>
            <Text style={styles.delete}>delete</Text>
          </Pressable>
        )}
      </View>

      {!editable ? (
        <Text style={styles.title}>{playlist.name}</Text>
      ) : (
        <TextInput style={styles.titleInput} value={name} onChangeText={setName} placeholder="Playlist name" placeholderTextColor="#6a6253" />
      )}

      {editable && (
        <View style={styles.swatchRow}>
          {TRACK_COLORS.map((c) => (
            <Pressable
              key={c}
              style={[styles.swatch, { backgroundColor: c }, color === c && styles.swatchOn]}
              onPress={() => setColor(c)}
            />
          ))}
        </View>
      )}

      {!editable && <Text style={styles.note}>This is a smart playlist / folder — read-only on the phone.</Text>}

      <FlatList
        data={rows}
        keyExtractor={(t, i) => `${t.id}:${i}`}
        contentContainerStyle={{ paddingBottom: 120 }}
        renderItem={({ item, index }) => (
          <View style={styles.row}>
            <Pressable style={styles.rowMain} onPress={() => onSelectTrack(item)}>
              <Text style={styles.idx}>{index + 1}</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.trkTitle} numberOfLines={1}>{item.title || '(untitled)'}</Text>
                <Text style={styles.trkSub} numberOfLines={1}>{item.artist || '—'}</Text>
              </View>
            </Pressable>
            {editable && (
              <View style={styles.rowBtns}>
                <Pressable hitSlop={6} disabled={index === 0} onPress={() => setOrder((o) => move(o, index, index - 1))}>
                  <Text style={[styles.move, index === 0 && styles.moveOff]}>▲</Text>
                </Pressable>
                <Pressable hitSlop={6} disabled={index === rows.length - 1} onPress={() => setOrder((o) => move(o, index, index + 1))}>
                  <Text style={[styles.move, index === rows.length - 1 && styles.moveOff]}>▼</Text>
                </Pressable>
                <Pressable hitSlop={6} onPress={() => setOrder((o) => o.filter((_, i) => i !== index))}>
                  <Text style={styles.rm}>✕</Text>
                </Pressable>
              </View>
            )}
          </View>
        )}
        ListEmptyComponent={<Text style={styles.dim}>No tracks. Add some from a track's “Add to playlist”.</Text>}
      />

      {editable && (dirty || msg) && (
        <View style={styles.footer}>
          {msg && <Text style={styles.msg}>{msg}</Text>}
          {dirty && (
            <Pressable style={[styles.save, busy && styles.saveOff]} disabled={busy} onPress={save}>
              <Text style={styles.saveTxt}>{busy ? 'Saving…' : 'Save changes'}</Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#17150f', paddingTop: 56, paddingHorizontal: 16 },
  center: { alignItems: 'center', justifyContent: 'center', gap: 14 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  back: { color: '#D86A4A', fontSize: 14 },
  delete: { color: '#e0726f', fontSize: 13 },
  title: { color: '#ECE3CC', fontSize: 22, fontWeight: '700', marginBottom: 8 },
  titleInput: {
    color: '#ECE3CC', fontSize: 22, fontWeight: '700', borderBottomWidth: 1, borderBottomColor: '#3a352b', paddingVertical: 4, marginBottom: 10
  },
  note: { color: '#7a7264', fontSize: 12, marginBottom: 10 },
  swatchRow: { flexDirection: 'row', gap: 8, marginBottom: 14, flexWrap: 'wrap' },
  swatch: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, borderColor: 'transparent' },
  swatchOn: { borderColor: '#ECE3CC' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#2a261d', gap: 8 },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  idx: { color: '#6a6253', fontSize: 12, width: 22, textAlign: 'right', fontVariant: ['tabular-nums'] },
  trkTitle: { color: '#ECE3CC', fontSize: 15 },
  trkSub: { color: '#8c8270', fontSize: 12, marginTop: 1 },
  rowBtns: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  move: { color: '#a59a82', fontSize: 15 },
  moveOff: { color: '#3a352b' },
  rm: { color: '#8c8270', fontSize: 15 },
  dim: { color: '#7a7264', fontSize: 13, textAlign: 'center', marginTop: 30 },
  footer: { position: 'absolute', left: 16, right: 16, bottom: 24, gap: 8 },
  msg: { color: '#a59a82', fontSize: 12, textAlign: 'center' },
  save: { backgroundColor: '#D86A4A', borderRadius: 8, paddingVertical: 13, alignItems: 'center' },
  saveOff: { backgroundColor: '#2a261d' },
  saveTxt: { color: '#17150f', fontSize: 15, fontWeight: '700' },
  btnGhost: { borderWidth: 1, borderColor: '#3a352b', borderRadius: 8, paddingHorizontal: 20, paddingVertical: 12 },
  btnGhostTxt: { color: '#ECE3CC', fontSize: 14, fontWeight: '600' }
})
