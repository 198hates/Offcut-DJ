import { useState, useRef, useCallback } from 'react'
import { useLibraryStore } from '../store/libraryStore'
import { useToastStore } from '../store/toastStore'
import { ContextMenu } from './ContextMenu'
import { SmartPlaylistEditor } from './SmartPlaylistEditor'
import type { Playlist, SmartRule, Track } from '@shared/types'

const BLIP_COLORS = [
  '#6E8059', '#4E7090', '#B07A4E', '#C9A02C',
  '#B86E72', '#874850', '#8E8473', '#B84A2B',
  '#3CA8A1', '#2E6FB8',
]

export function Sidebar(): JSX.Element {
  const {
    playlists, stats, activePlaylistId,
    setActivePlaylistId,
    createPlaylist, createSmartPlaylist, updateSmartPlaylistRules,
    renamePlaylist, deletePlaylist,
  } = useLibraryStore()

  const [newPlaylistName, setNewPlaylistName] = useState('')
  const [addingPlaylist, setAddingPlaylist] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [smartEditorPlaylist, setSmartEditorPlaylist] = useState<Playlist | null | undefined>(undefined)
  const newPlaylistInputRef = useRef<HTMLInputElement>(null)

  const handleCreatePlaylist = async (): Promise<void> => {
    const name = newPlaylistName.trim()
    if (!name) return
    await createPlaylist(name)
    setNewPlaylistName('')
    setAddingPlaylist(false)
  }

  const startRename = (pl: Playlist): void => {
    setRenamingId(pl.id)
    setRenameValue(pl.name)
  }

  const commitRename = async (): Promise<void> => {
    if (!renamingId || !renameValue.trim()) { setRenamingId(null); return }
    await renamePlaylist(renamingId, renameValue.trim())
    setRenamingId(null)
  }

  const handleDeletePlaylist = async (id: string, name: string): Promise<void> => {
    if (!window.confirm(`Delete playlist "${name}"?`)) return
    await deletePlaylist(id)
  }

  const handleSmartSave = async (name: string, rules: SmartRule[]): Promise<void> => {
    if (smartEditorPlaylist) {
      await updateSmartPlaylistRules(smartEditorPlaylist.id, name, rules)
    } else {
      await createSmartPlaylist(name, rules)
    }
    setSmartEditorPlaylist(undefined)
  }

  const sets      = playlists.filter((p) => !p.isFolder && !p.isSmart && !p.isAutoGroup)
  const smart     = playlists.filter((p) => !p.isFolder && p.isSmart)
  const autoGroups = playlists.filter((p) => !p.isFolder && p.isAutoGroup)

  return (
    <>
      <aside className="w-48 bg-chassis border-r border-border/30 flex flex-col shrink-0">

        {/* ── All Tracks nav ── */}
        <nav className="px-2 pt-2 pb-1 shrink-0">
          <button
            onClick={() => setActivePlaylistId(null)}
            className={`w-full text-left px-2.5 py-1.5 rounded font-mono text-xs transition-colors flex items-center justify-between ${
              !activePlaylistId
                ? 'bg-ink/8 text-ink font-bold'
                : 'text-ink-soft hover:bg-ink/5 hover:text-ink'
            }`}
          >
            <span>all tracks</span>
            {stats && (
              <span className="text-[9px] text-muted tabular-nums">{stats.trackCount.toLocaleString()}</span>
            )}
          </button>
        </nav>

        {/* ── Playlist list ── */}
        <div className="flex-1 overflow-y-auto">
          <div className="px-2 pb-2">

            {/* Sets header */}
            <div className="flex items-center justify-between px-2.5 pt-3 pb-1">
              <p className="text-[9px] font-mono font-bold uppercase tracking-[0.2em] text-muted">
                <span className="text-accent mr-1">01</span>playlists
                <span className="ml-1 text-muted/60">· {sets.length}</span>
              </p>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setSmartEditorPlaylist(null)}
                  className="text-muted hover:text-accent text-xs leading-none transition-colors"
                  title="New smart playlist"
                >⚡</button>
                <button
                  onClick={() => { setAddingPlaylist(true); setTimeout(() => newPlaylistInputRef.current?.focus(), 50) }}
                  className="text-muted hover:text-ink text-base leading-none transition-colors"
                  title="New playlist"
                >+</button>
              </div>
            </div>

            {addingPlaylist && (
              <div className="px-1 mb-1">
                <input
                  ref={newPlaylistInputRef}
                  value={newPlaylistName}
                  onChange={(e) => setNewPlaylistName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCreatePlaylist()
                    if (e.key === 'Escape') { setAddingPlaylist(false); setNewPlaylistName('') }
                  }}
                  onBlur={() => { if (!newPlaylistName.trim()) setAddingPlaylist(false) }}
                  placeholder="playlist name…"
                  className="w-full bg-paper border border-accent/40 rounded px-2 py-1 text-xs font-mono text-ink outline-none"
                />
              </div>
            )}

            <div className="space-y-px">
              {sets.map((pl) => (
                <PlaylistItem
                  key={pl.id}
                  playlist={pl}
                  isActive={activePlaylistId === pl.id}
                  isRenaming={renamingId === pl.id}
                  renameValue={renameValue}
                  onRenameChange={setRenameValue}
                  onRenameCommit={commitRename}
                  onClick={() => setActivePlaylistId(pl.id)}
                  onStartRename={() => startRename(pl)}
                  onDelete={() => handleDeletePlaylist(pl.id, pl.name)}
                  onEditSmart={() => setSmartEditorPlaylist(pl)}
                />
              ))}
              {sets.length === 0 && !addingPlaylist && (
                <p className="px-3 py-1 text-[10px] font-mono text-muted/50 italic">no playlists yet</p>
              )}
            </div>

            {/* Smart playlists */}
            {smart.length > 0 && (
              <>
                <div className="px-2.5 pt-3 pb-1">
                  <p className="text-[9px] font-mono font-bold uppercase tracking-[0.2em] text-muted">
                    <span className="text-accent mr-1">02</span>smart
                    <span className="ml-1 text-muted/60">· {smart.length}</span>
                  </p>
                </div>
                <div className="space-y-px">
                  {smart.map((pl) => (
                    <PlaylistItem
                      key={pl.id}
                      playlist={pl}
                      isActive={activePlaylistId === pl.id}
                      isRenaming={renamingId === pl.id}
                      renameValue={renameValue}
                      onRenameChange={setRenameValue}
                      onRenameCommit={commitRename}
                      onClick={() => setActivePlaylistId(pl.id)}
                      onStartRename={() => startRename(pl)}
                      onDelete={() => handleDeletePlaylist(pl.id, pl.name)}
                      onEditSmart={() => setSmartEditorPlaylist(pl)}
                    />
                  ))}
                </div>
              </>
            )}

            {/* Auto Groups (generated) */}
            {autoGroups.length > 0 && (
              <AutoGroupsSection
                groups={autoGroups}
                activePlaylistId={activePlaylistId}
                onSelect={setActivePlaylistId}
                onDeleteAll={async () => {
                  await window.api.library.runAutoGroup([])
                  await useLibraryStore.getState().loadLibrary()
                }}
              />
            )}
          </div>
        </div>

      </aside>

      {smartEditorPlaylist !== undefined && (
        <SmartPlaylistEditor
          playlist={smartEditorPlaylist ?? undefined}
          onSave={handleSmartSave}
          onClose={() => setSmartEditorPlaylist(undefined)}
        />
      )}
    </>
  )
}

// ── PlaylistItem ──────────────────────────────────────────────────────────────

interface PlaylistItemProps {
  playlist: Playlist
  isActive: boolean
  isRenaming: boolean
  renameValue: string
  onRenameChange: (v: string) => void
  onRenameCommit: () => void
  onClick: () => void
  onStartRename: () => void
  onDelete: () => void
  onEditSmart: () => void
}

function PlaylistItem({
  playlist, isActive, isRenaming, renameValue,
  onRenameChange, onRenameCommit, onClick, onStartRename, onDelete, onEditSmart
}: PlaylistItemProps): JSX.Element {
  const [hovered, setHovered] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)
  const [colorPickerOpen, setColorPickerOpen] = useState(false)
  const [toolsMenuPos, setToolsMenuPos] = useState<{ x: number; y: number } | null>(null)

  const isDraggingTracks = useLibraryStore((s) => s.isDraggingTracks)
  const draggingTrackIds = useLibraryStore((s) => s.draggingTrackIds)
  const addTracksToPlaylist = useLibraryStore((s) => s.addTracksToPlaylist)
  const updatePlaylistColor = useLibraryStore((s) => s.updatePlaylistColor)
  const showToast = useToastStore((s) => s.show)

  // ── Playlist tools (operate on store state at call time, no subscription) ──

  const handleShuffle = useCallback(() => {
    if (playlist.isSmart) return
    const ids = [...playlist.trackIds]
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[ids[i], ids[j]] = [ids[j], ids[i]]
    }
    useLibraryStore.getState().reorderPlaylistTracks(playlist.id, ids)
      .then(() => showToast(`Shuffled ${ids.length} tracks`, 'success'))
  }, [playlist.id, playlist.trackIds, playlist.isSmart, showToast])

  const handleSort = useCallback((field: keyof Track, dir: 'asc' | 'desc') => {
    if (playlist.isSmart) return
    const { tracks } = useLibraryStore.getState()
    const trackMap = new Map(tracks.map((t) => [t.id, t]))
    const sorted = [...playlist.trackIds].sort((a, b) => {
      const av = String(trackMap.get(a)?.[field] ?? '')
      const bv = String(trackMap.get(b)?.[field] ?? '')
      const cmp = av.localeCompare(bv, undefined, { numeric: true })
      return dir === 'asc' ? cmp : -cmp
    })
    useLibraryStore.getState().reorderPlaylistTracks(playlist.id, sorted)
      .then(() => showToast(`Sorted by ${String(field)}`, 'success'))
  }, [playlist.id, playlist.trackIds, playlist.isSmart, showToast])

  const handleMerge = useCallback((targetId: string) => {
    const { playlists, addTracksToPlaylist: add } = useLibraryStore.getState()
    const target = playlists.find((p) => p.id === targetId)
    if (!target) return
    const existing = new Set(playlist.trackIds)
    const toAdd = target.trackIds.filter((id) => !existing.has(id))
    if (!toAdd.length) { showToast('No new tracks to add', 'info'); return }
    add(playlist.id, toAdd).then(() =>
      showToast(`Merged ${toAdd.length} tracks from "${target.name}"`, 'success')
    )
  }, [playlist.id, playlist.trackIds, showToast])

  const handleFindUnique = useCallback(async (otherPlaylistId: string) => {
    const { playlists, createPlaylist: create, addTracksToPlaylist: add } = useLibraryStore.getState()
    const other = playlists.find((p) => p.id === otherPlaylistId)
    if (!other) return
    const otherSet = new Set(other.trackIds)
    const uniqueIds = playlist.trackIds.filter((id) => !otherSet.has(id))
    if (!uniqueIds.length) { showToast('No unique tracks found', 'info'); return }
    const newPl = await create(`${playlist.name} ∖ ${other.name}`)
    await add(newPl.id, uniqueIds)
    showToast(`Created "${newPl.name}" with ${uniqueIds.length} tracks`, 'success')
  }, [playlist.id, playlist.trackIds, playlist.name, showToast])

  const handleDragOver = (e: React.DragEvent): void => {
    if (playlist.isSmart) return
    if (!isDraggingTracks && !e.dataTransfer.types.includes('application/x-crate-track-ids')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setIsDragOver(true)
  }

  const handleDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setIsDragOver(false)
    if (playlist.isSmart) return
    let ids = draggingTrackIds
    if (ids.length === 0) {
      try { ids = JSON.parse(e.dataTransfer.getData('application/x-crate-track-ids')) } catch { /* ignore */ }
    }
    if (ids.length > 0) addTracksToPlaylist(playlist.id, ids)
  }

  if (isRenaming) {
    return (
      <div className="px-1">
        <input
          autoFocus
          value={renameValue}
          onChange={(e) => onRenameChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onRenameCommit(); if (e.key === 'Escape') onRenameCommit() }}
          onBlur={onRenameCommit}
          className="w-full bg-paper border border-accent/40 rounded px-2 py-1 text-xs font-mono text-ink outline-none"
        />
      </div>
    )
  }

  return (
    <div
      className={`relative flex items-center rounded transition-colors ${
        isActive
          ? 'bg-ink/8'
          : isDragOver
          ? 'bg-accent/10'
          : hovered
          ? 'bg-ink/5'
          : ''
      }`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setColorPickerOpen(false) }}
      onDragOver={handleDragOver}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleDrop}
    >
      {/* Blip dot — click to open colour picker */}
      <button
        className="shrink-0 ml-2 mr-1.5 relative"
        onClick={(e) => { e.stopPropagation(); setColorPickerOpen((o) => !o) }}
        title="Change colour"
      >
        <span
          className="block w-2 h-2 rounded-sm"
          style={{ background: playlist.color || '#8A8474' }}
        />
        {colorPickerOpen && (
          <div className="absolute left-0 top-4 z-50 bg-paper border border-border/50 rounded p-1.5 shadow-lg grid grid-cols-5 gap-1"
               style={{ width: 100 }}>
            {BLIP_COLORS.map((c) => (
              <button
                key={c}
                className="w-4 h-4 rounded-sm border-2 transition-all hover:scale-110"
                style={{ background: c, borderColor: playlist.color === c ? '#14110E' : 'transparent' }}
                onClick={(e) => {
                  e.stopPropagation()
                  updatePlaylistColor(playlist.id, c)
                  setColorPickerOpen(false)
                }}
              />
            ))}
          </div>
        )}
      </button>

      <button
        onClick={onClick}
        onDoubleClick={playlist.isSmart ? onEditSmart : onStartRename}
        className={`flex-1 text-left py-1.5 pr-1 font-mono text-[10.5px] truncate transition-colors ${
          isActive ? 'text-ink font-bold' : 'text-ink-soft'
        }`}
        title={playlist.isSmart
          ? `${playlist.name} · smart · ${playlist.trackIds.length} tracks`
          : `${playlist.name} · ${playlist.trackIds.length} tracks · dbl-click to rename`}
      >
        {playlist.isSmart && <span className="mr-1 text-accent opacity-80">⚡</span>}
        {playlist.name}
        <span className={`ml-1 font-mono text-[9px] ${isActive ? 'text-muted' : 'opacity-0 group-hover:opacity-40'}`}>
          {playlist.trackIds.length}
        </span>
      </button>

      {hovered && !isDragOver && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            const rect = e.currentTarget.getBoundingClientRect()
            setToolsMenuPos({ x: rect.left, y: rect.bottom + 4 })
          }}
          className="shrink-0 px-1.5 mr-1 text-muted hover:text-ink transition-colors text-[11px] leading-none"
          title="Playlist tools"
        >···</button>
      )}

      {toolsMenuPos && (() => {
        const { playlists: allPls } = useLibraryStore.getState()
        const others = allPls.filter((p) => p.id !== playlist.id && !p.isSmart)
        return (
          <ContextMenu
            x={toolsMenuPos.x}
            y={toolsMenuPos.y}
            onClose={() => setToolsMenuPos(null)}
            sections={[
              ...(!playlist.isSmart ? [{
                items: [
                  { label: 'Shuffle order', action: handleShuffle },
                  {
                    label: 'Sort by',
                    submenu: [
                      { label: 'BPM ↑',        action: () => handleSort('bpm', 'asc') },
                      { label: 'BPM ↓',        action: () => handleSort('bpm', 'desc') },
                      { label: 'Energy ↓',     action: () => handleSort('energy', 'desc') },
                      { label: 'Key (Camelot)', action: () => handleSort('key', 'asc') },
                      { label: 'Artist A–Z',   action: () => handleSort('artist', 'asc') },
                      { label: 'Title A–Z',    action: () => handleSort('title', 'asc') },
                      { label: 'Duration ↑',   action: () => handleSort('durationSeconds', 'asc') },
                    ]
                  },
                ]
              }] : []),
              ...(!playlist.isSmart && others.length > 0 ? [{
                items: [
                  {
                    label: 'Merge with',
                    submenu: others.map((p) => ({ label: p.name, action: () => handleMerge(p.id) }))
                  },
                  {
                    label: 'Tracks not in',
                    submenu: others.map((p) => ({ label: p.name, action: () => handleFindUnique(p.id) }))
                  },
                ]
              }] : []),
              {
                items: [
                  { label: 'Export as M3U', action: () => window.api.library.exportPlaylistM3U(playlist.id) },
                  { label: 'Export as CSV', action: () => window.api.library.exportPlaylistCSV(playlist.id) },
                ]
              },
              {
                items: [
                  playlist.isSmart
                    ? { label: 'Edit rules', action: onEditSmart }
                    : { label: 'Rename', action: onStartRename },
                  { label: 'Delete playlist', danger: true, action: onDelete },
                ]
              }
            ]}
          />
        )
      })()}
      {isDragOver && (
        <span className="shrink-0 px-2 text-accent text-xs font-bold">+</span>
      )}
    </div>
  )
}

// ── AutoGroupsSection ─────────────────────────────────────────────────────────

function AutoGroupsSection({ groups, activePlaylistId, onSelect, onDeleteAll }: {
  groups: import('@shared/types').Playlist[]
  activePlaylistId: string | null
  onSelect: (id: string) => void
  onDeleteAll: () => Promise<void>
}): JSX.Element {
  const [open, setOpen] = useState(true)

  return (
    <>
      <div className="flex items-center justify-between px-2.5 pt-3 pb-1">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1 text-[9px] font-mono font-bold uppercase tracking-[0.2em] text-muted hover:text-ink transition-colors"
        >
          <span className="text-accent mr-0.5">03</span>generated
          <span className="ml-1 text-muted/60">· {groups.length}</span>
          <span className="ml-1 text-muted/40">{open ? '▾' : '▸'}</span>
        </button>
        <button
          onClick={onDeleteAll}
          title="Clear all auto groups"
          className="text-muted/40 hover:text-red-500 transition-colors font-mono text-[9px]"
        >✕</button>
      </div>
      {open && (
        <div className="space-y-px">
          {groups.map((pl) => (
            <button
              key={pl.id}
              onClick={() => onSelect(pl.id)}
              className={`w-full text-left px-2.5 py-1.5 rounded font-mono text-xs transition-colors flex items-center justify-between group ${
                activePlaylistId === pl.id
                  ? 'bg-ink/8 text-ink font-bold'
                  : 'text-ink-soft hover:bg-ink/5 hover:text-ink'
              }`}
            >
              <span className="truncate flex-1">{pl.name}</span>
              <span className="text-[9px] text-muted tabular-nums ml-1 shrink-0">
                {pl.trackIds.length}
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  )
}
