import { useState, useRef, useCallback, useMemo, useEffect } from 'react'
import { useLibraryStore } from '../store/libraryStore'
import { useToastStore } from '../store/toastStore'
import { ContextMenu } from './ContextMenu'
import { SmartPlaylistEditor } from './SmartPlaylistEditor'
import { acceptsTrackDrop, readTrackIds } from '../lib/trackDrag'
import type { Playlist, SmartRule, Track } from '@shared/types'

function fmtPlaylistDuration(secs: number): string {
  if (secs < 60) return '<1m'
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  return h > 0 ? `${h}h${m}m` : `${m}m`
}

// Field Unit functional palette — crate chips + playlist energy sparklines.
const BLIP_COLORS = [
  '#6E8059', '#4E7090', '#B07A4E', '#C9A02C',
  '#B86E72', '#4E9A8E', '#8A6EA8', '#C24E4E',
  '#A9C23E', '#C2683E',
]

export function Sidebar(): JSX.Element {
  const {
    playlists, stats, activePlaylistId,
    setActivePlaylistId,
    createPlaylist, createSmartPlaylist, updateSmartPlaylistRules,
    renamePlaylist, deletePlaylist, reorderPlaylists,
  } = useLibraryStore()

  const [newPlaylistName, setNewPlaylistName] = useState('')
  const [addingPlaylist, setAddingPlaylist] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [smartEditorPlaylist, setSmartEditorPlaylist] = useState<Playlist | null | undefined>(undefined)
  const [showTemplates, setShowTemplates] = useState(false)
  const newPlaylistInputRef = useRef<HTMLInputElement>(null)

  // ── Playlist list sort mode (persisted) ─────────────────────────────────────
  type PlaylistSortMode = 'name' | 'created' | 'manual'
  const [sortMode, setSortMode] = useState<PlaylistSortMode>('manual')
  const [showSortMenu, setShowSortMenu] = useState(false)
  const [draggedId, setDraggedId] = useState<string | null>(null)

  useEffect(() => {
    window.api.settings.get().then((s) => setSortMode((s.playlistSortMode as PlaylistSortMode) || 'manual'))
  }, [])

  const chooseSortMode = async (mode: PlaylistSortMode): Promise<void> => {
    setSortMode(mode)
    setShowSortMenu(false)
    await window.api.settings.save({ playlistSortMode: mode })
  }

  const reorderRegular = async (draggedPlId: string, targetPlId: string): Promise<void> => {
    const ids = regular.map((p) => p.id)
    const from = ids.indexOf(draggedPlId)
    const to = ids.indexOf(targetPlId)
    if (from < 0 || to < 0 || from === to) return
    ids.splice(to, 0, ids.splice(from, 1)[0])
    await reorderPlaylists(ids)
  }

  // Collapsible sidebar sections (persisted). Folders/auto-groups manage their own.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('offcut.sidebarCollapsed') || '[]') as string[]) } catch { return new Set() }
  })
  const persistCollapsed = (next: Set<string>): void => {
    try { localStorage.setItem('offcut.sidebarCollapsed', JSON.stringify([...next])) } catch { /* ignore */ }
  }
  const toggleSection = (key: string): void =>
    setCollapsed((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); persistCollapsed(n); return n })
  const expandSection = (key: string): void =>
    setCollapsed((prev) => { if (!prev.has(key)) return prev; const n = new Set(prev); n.delete(key); persistCollapsed(n); return n })

  // ── Smart playlist templates ────────────────────────────────────────────────

  const TEMPLATES: { name: string; icon: string; rules: SmartRule[] }[] = [
    { name: 'New additions', icon: '✦',
      rules: [{ field: 'dateAdded', op: 'in_last_days', value: 30 }] },
    { name: 'High energy', icon: '⚡',
      rules: [{ field: 'energy', op: 'greater_than', value: 7 }] },
    { name: 'Unrated', icon: '☆',
      rules: [{ field: 'rating', op: 'is', value: 0 }] },
    { name: 'Never played', icon: '⬚',
      rules: [{ field: 'playCount', op: 'is', value: 0 }] },
    { name: 'Recently played', icon: '◉',
      rules: [{ field: 'lastPlayedAt', op: 'in_last_days', value: 7 }] },
    { name: 'Highly rated', icon: '★',
      rules: [{ field: 'rating', op: 'greater_than', value: 3 }] },
    { name: '5-star', icon: '★★',
      rules: [{ field: 'rating', op: 'is', value: 5 }] },
    { name: 'Long tracks', icon: '⏱',
      rules: [{ field: 'durationSeconds', op: 'greater_than', value: 480 }] },
  ]

  const createFromTemplate = useCallback(async (t: typeof TEMPLATES[number]) => {
    setShowTemplates(false)
    await createSmartPlaylist(t.name, t.rules)
  }, [createSmartPlaylist])

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

  // Track-level data for duration sums
  const tracks = useLibraryStore((s) => s.tracks)
  const durMap = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of tracks) {
      if (t.durationSeconds) m.set(t.id, t.durationSeconds)
    }
    return m
  }, [tracks])
  const playlistDuration = useCallback((ids: string[]): number =>
    ids.reduce((s, id) => s + (durMap.get(id) ?? 0), 0), [durMap])

  const regularUnsorted = playlists.filter((p) => !p.parentId && !p.isFolder && !p.isSmart && !p.isAutoGroup)
  const regular =
    sortMode === 'name' ? [...regularUnsorted].sort((a, b) => a.name.localeCompare(b.name)) :
    sortMode === 'created' ? [...regularUnsorted].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()) :
    regularUnsorted // 'manual' — already in sort_order from the store query
  const smart      = playlists.filter((p) => !p.parentId && !p.isFolder && p.isSmart)
  const folders    = playlists.filter((p) => !p.parentId && p.isFolder && !p.isAutoGroup)
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
              <span className="text-[12px] text-muted tabular-nums">{stats.trackCount.toLocaleString()}</span>
            )}
          </button>
        </nav>

        {/* ── Playlist list ── */}
        <div className="flex-1 overflow-y-auto">
          <div className="px-2 pb-2">

            {/* Sets header */}
            <div className="flex items-center justify-between px-2.5 pt-3 pb-1">
              <button
                onClick={() => toggleSection('playlists')}
                className="flex items-center text-[12px] font-mono font-bold uppercase tracking-[0.2em] text-muted hover:text-ink transition-colors"
              >
                <span className="text-accent mr-1">01</span>playlists
                <span className="ml-1 text-muted/60">· {regular.length}</span>
                <span className="ml-1 text-muted/40">{collapsed.has('playlists') ? '▸' : '▾'}</span>
              </button>
              <div className="flex items-center gap-1.5 relative">
                {/* Sort mode picker */}
                <button
                  onClick={() => setShowSortMenu((v) => !v)}
                  className="text-muted/50 hover:text-accent text-[13px] leading-none transition-colors"
                  title="Sort playlists"
                >⇅</button>
                {showSortMenu && (
                  <div className="absolute top-full right-0 z-30 mt-1 w-36 bg-chassis border border-border/40 rounded shadow-xl">
                    {([
                      ['manual', 'Manual (drag)'],
                      ['name', 'Name (A–Z)'],
                      ['created', 'Date created'],
                    ] as const).map(([mode, label]) => (
                      <button key={mode}
                        onClick={() => chooseSortMode(mode)}
                        className={`w-full text-left flex items-center gap-2 px-2 py-1 hover:bg-accent/[0.06] border-b border-border/10 last:border-b-0 transition-colors font-mono text-[11px] ${
                          sortMode === mode ? 'text-accent' : 'text-ink'
                        }`}>
                        {sortMode === mode && <span>✓</span>} {label}
                      </button>
                    ))}
                  </div>
                )}
                {/* Template picker */}
                <button
                  onClick={() => setShowTemplates((v) => !v)}
                  className="text-muted/50 hover:text-accent text-[13px] leading-none transition-colors"
                  title="Create from template"
                >☰</button>
                {showTemplates && (
                  <div className="absolute top-full right-0 z-30 mt-1 w-44 bg-chassis border border-border/40 rounded shadow-xl">
                    <div className="flex items-center justify-between px-2 py-1 border-b border-border/30">
                      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted/50">smart templates</span>
                      <button onClick={() => setShowTemplates(false)} className="text-muted/30 hover:text-muted text-xs">✕</button>
                    </div>
                    {TEMPLATES.map((t) => (
                      <button key={t.name}
                        onClick={() => createFromTemplate(t)}
                        className="w-full text-left flex items-center gap-2 px-2 py-1 hover:bg-accent/[0.06] border-b border-border/10 transition-colors">
                        <span className="text-[13px] text-muted/60 shrink-0 w-4">{t.icon}</span>
                        <span className="font-mono text-[11px] text-ink truncate">{t.name}</span>
                      </button>
                    ))}
                  </div>
                )}
                <button
                  onClick={() => setSmartEditorPlaylist(null)}
                  className="text-muted hover:text-accent text-xs leading-none transition-colors"
                  title="New smart playlist"
                >⚡</button>
                <button
                  onClick={() => { expandSection('playlists'); setAddingPlaylist(true); setTimeout(() => newPlaylistInputRef.current?.focus(), 50) }}
                  className="text-muted hover:text-ink text-base leading-none transition-colors"
                  title="New playlist"
                >+</button>
              </div>
            </div>

            {!collapsed.has('playlists') && (<>
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
              {regular.map((pl) => (
                <div
                  key={pl.id}
                  draggable={sortMode === 'manual'}
                  onDragStart={() => setDraggedId(pl.id)}
                  onDragOver={(e) => { if (sortMode === 'manual' && draggedId && draggedId !== pl.id) e.preventDefault() }}
                  onDrop={(e) => {
                    if (sortMode !== 'manual' || !draggedId || draggedId === pl.id) return
                    e.preventDefault()
                    reorderRegular(draggedId, pl.id)
                    setDraggedId(null)
                  }}
                  onDragEnd={() => setDraggedId(null)}
                >
                  <PlaylistItem
                    playlist={pl}
                    totalDurationSeconds={playlistDuration(pl.trackIds)}
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
                </div>
              ))}
              {regular.length === 0 && !addingPlaylist && (
                <p className="px-3 py-1 text-[13px] font-mono text-muted/50 italic">no playlists yet</p>
              )}
            </div>
            </>)}

            {/* Smart playlists */}
            {smart.length > 0 && (
              <>
                <div className="px-2.5 pt-3 pb-1">
                  <button
                    onClick={() => toggleSection('smart')}
                    className="flex items-center text-[12px] font-mono font-bold uppercase tracking-[0.2em] text-muted hover:text-ink transition-colors"
                  >
                    <span className="text-accent mr-1">02</span>smart
                    <span className="ml-1 text-muted/60">· {smart.length}</span>
                    <span className="ml-1 text-muted/40">{collapsed.has('smart') ? '▸' : '▾'}</span>
                  </button>
                </div>
                {!collapsed.has('smart') && (
                <div className="space-y-px">
                  {smart.map((pl) => (
                    <PlaylistItem
                      key={pl.id}
                      playlist={pl}
                      totalDurationSeconds={playlistDuration(pl.trackIds)}
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
                )}
              </>
            )}

            {/* Sets (folder playlists — created via Set Builder) */}
            {folders.length > 0 && (
              <FoldersSection
                folders={folders}
                playlists={playlists}
                activePlaylistId={activePlaylistId}
                onSelect={setActivePlaylistId}
              />
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
  totalDurationSeconds?: number
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
  playlist, totalDurationSeconds, isActive, isRenaming, renameValue,
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
    if (!isDraggingTracks && !acceptsTrackDrop(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setIsDragOver(true)
  }

  const handleDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setIsDragOver(false)
    if (playlist.isSmart) return
    const ids = draggingTrackIds.length ? draggingTrackIds : readTrackIds(e)
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
        className={`flex-1 text-left py-1 pr-1 font-mono text-[13px] transition-colors min-w-0 overflow-hidden ${
          isActive ? 'text-ink font-bold' : 'text-ink-soft'
        }`}
        title={playlist.isSmart
          ? `${playlist.name} · smart · ${playlist.trackIds.length} tracks`
          : `${playlist.name} · ${playlist.trackIds.length} tracks · dbl-click to rename`}
      >
        <div className="truncate">
          {playlist.isSmart && <span className="mr-1 text-accent opacity-80">⚡</span>}
          {playlist.name}
        </div>
        <div className="flex items-center gap-1 mt-0.5">
          <span className="font-mono text-[11px] text-muted tabular-nums">
            {playlist.trackIds.length} trk{playlist.trackIds.length !== 1 ? 's' : ''}
          </span>
          {totalDurationSeconds != null && totalDurationSeconds > 0 && (
            <span className="font-mono text-[11px] text-muted/60">· {fmtPlaylistDuration(totalDurationSeconds)}</span>
          )}
        </div>
      </button>

      {hovered && !isDragOver && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            const rect = e.currentTarget.getBoundingClientRect()
            setToolsMenuPos({ x: rect.left, y: rect.bottom + 4 })
          }}
          className="shrink-0 px-1.5 mr-1 text-muted hover:text-ink transition-colors text-[13px] leading-none"
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

// ── FoldersSection ────────────────────────────────────────────────────────────
// Shows folder-type playlists (sets from Set Builder) with their children

function FoldersSection({ folders, playlists, activePlaylistId, onSelect }: {
  folders: Playlist[]
  playlists: Playlist[]
  activePlaylistId: string | null
  onSelect: (id: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(true)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const toggleFolder = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  return (
    <>
      <div className="flex items-center justify-between px-2.5 pt-3 pb-1">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1 text-[12px] font-mono font-bold uppercase tracking-[0.2em] text-muted hover:text-ink transition-colors"
        >
          <span className="text-accent mr-0.5">03</span>sets
          <span className="ml-1 text-muted/60">· {folders.length}</span>
          <span className="ml-1 text-muted/40">{open ? '▾' : '▸'}</span>
        </button>
      </div>
      {open && (
        <div className="space-y-px">
          {folders.map((folder) => {
            const children = playlists.filter((p) => p.parentId === folder.id && !p.isFolder)
            const isExpanded = expanded.has(folder.id)
            return (
              <div key={folder.id}>
                {/* Folder row */}
                <button
                  onClick={() => toggleFolder(folder.id)}
                  className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-left hover:bg-ink/[0.04] transition-colors group"
                >
                  <span className="font-mono text-[12px] text-muted/50">{isExpanded ? '▾' : '▸'}</span>
                  <span className="font-mono text-[13px] font-bold text-ink-soft truncate flex-1">{folder.name}</span>
                  <span className="font-mono text-[12px] text-muted/50 tabular-nums shrink-0">{children.length}</span>
                </button>
                {/* Children */}
                {isExpanded && children.map((ch) => (
                  <button
                    key={ch.id}
                    onClick={() => onSelect(ch.id)}
                    className={`w-full flex items-center gap-2 pl-6 pr-2.5 py-1 text-left transition-colors ${
                      activePlaylistId === ch.id
                        ? 'bg-accent/[0.07] text-ink'
                        : 'text-ink-soft hover:bg-ink/[0.04] hover:text-ink'
                    }`}
                  >
                    <span
                      className="w-1.5 h-1.5 rounded-sm shrink-0"
                      style={{ background: ch.color || '#8A8474' }}
                    />
                    <span className="font-mono text-[13px] truncate flex-1">{ch.name}</span>
                    <span className="font-mono text-[12px] text-muted/50 tabular-nums">{ch.trackIds.length}</span>
                  </button>
                ))}
              </div>
            )
          })}
        </div>
      )}
    </>
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
          className="flex items-center gap-1 text-[12px] font-mono font-bold uppercase tracking-[0.2em] text-muted hover:text-ink transition-colors"
        >
          <span className="text-accent mr-0.5">03</span>generated
          <span className="ml-1 text-muted/60">· {groups.length}</span>
          <span className="ml-1 text-muted/40">{open ? '▾' : '▸'}</span>
        </button>
        <button
          onClick={onDeleteAll}
          title="Clear all auto groups"
          className="text-muted/40 hover:text-red-500 transition-colors font-mono text-[12px]"
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
              <span className="text-[12px] text-muted tabular-nums ml-1 shrink-0">
                {pl.trackIds.length}
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  )
}
