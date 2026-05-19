import { useState, useRef } from 'react'
import { useLibraryStore } from '../store/libraryStore'
import { RekordboxSync } from './RekordboxSync'
import type { IntegrationId, Playlist } from '@shared/types'

interface Integration {
  id: IntegrationId
  label: string
  icon: string
  canExport: boolean
}

const INTEGRATIONS: Integration[] = [
  { id: 'rekordbox', label: 'Rekordbox', icon: '◈', canExport: true },
  { id: 'traktor', label: 'Traktor', icon: '◉', canExport: true },
  { id: 'serato', label: 'Serato', icon: '◎', canExport: true },
  { id: 'apple-music', label: 'Apple Music', icon: '♪', canExport: false }
]

interface SidebarProps {
  activePage: 'library' | 'health' | 'settings'
  onNavigate: (page: 'library' | 'health' | 'settings') => void
}

export function Sidebar({ activePage, onNavigate }: SidebarProps): JSX.Element {
  const {
    playlists, stats, activePlaylistId,
    setActivePlaylistId, importFromIntegration, exportToIntegration,
    createPlaylist, renamePlaylist, deletePlaylist,
    isImporting, isExporting
  } = useLibraryStore()

  const [newPlaylistName, setNewPlaylistName] = useState('')
  const [addingPlaylist, setAddingPlaylist] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
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

  const nonFolderPlaylists = playlists.filter((p) => !p.isFolder)

  return (
    <aside className="w-52 bg-surface-900 border-r border-white/5 flex flex-col shrink-0">
      <nav className="p-2 space-y-0.5 shrink-0">
        <button
          onClick={() => { setActivePlaylistId(null); onNavigate('library') }}
          className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
            activePage === 'library' && !activePlaylistId
              ? 'bg-accent text-white'
              : 'text-white/70 hover:bg-white/5 hover:text-white'
          }`}
        >
          All Tracks
          {stats && <span className="ml-2 text-xs opacity-50">{stats.trackCount.toLocaleString()}</span>}
        </button>
      </nav>

      <div className="flex-1 overflow-y-auto">
        <div className="px-2 pb-2">
          <div className="flex items-center justify-between px-3 py-1.5">
            <p className="text-xs font-semibold uppercase tracking-wider text-white/30">Playlists</p>
            <button
              onClick={() => { setAddingPlaylist(true); setTimeout(() => newPlaylistInputRef.current?.focus(), 50) }}
              className="text-white/30 hover:text-white text-lg leading-none transition-colors"
              title="New playlist"
            >
              +
            </button>
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
                onBlur={() => { if (!newPlaylistName.trim()) { setAddingPlaylist(false) } }}
                placeholder="Playlist name…"
                className="w-full bg-white/10 border border-accent/50 rounded px-2 py-1 text-xs text-white outline-none"
              />
            </div>
          )}

          <div className="space-y-0.5">
            {nonFolderPlaylists.map((playlist) => (
              <PlaylistItem
                key={playlist.id}
                playlist={playlist}
                isActive={activePlaylistId === playlist.id && activePage === 'library'}
                isRenaming={renamingId === playlist.id}
                renameValue={renameValue}
                onRenameChange={setRenameValue}
                onRenameCommit={commitRename}
                onClick={() => { setActivePlaylistId(playlist.id); onNavigate('library') }}
                onStartRename={() => startRename(playlist)}
                onDelete={() => handleDeletePlaylist(playlist.id, playlist.name)}
              />
            ))}

            {nonFolderPlaylists.length === 0 && !addingPlaylist && (
              <p className="px-3 py-1 text-xs text-white/20 italic">No playlists yet</p>
            )}
          </div>
        </div>
      </div>

      <RekordboxSync />

      <div className="p-2 border-t border-white/5 shrink-0">
        <p className="px-3 py-1 text-xs font-semibold uppercase tracking-wider text-white/30">Import</p>
        <div className="space-y-0.5 mb-2">
          {INTEGRATIONS.map((i) => (
            <button
              key={`import-${i.id}`}
              onClick={() => importFromIntegration(i.id)}
              disabled={isImporting}
              className="w-full text-left px-3 py-1.5 rounded-lg text-sm text-white/60 hover:bg-white/5 hover:text-white transition-colors flex items-center gap-2 disabled:opacity-40"
            >
              <span className="text-xs opacity-60">{i.icon}</span>
              {isImporting ? 'Importing…' : i.label}
            </button>
          ))}
        </div>

        <p className="px-3 py-1 text-xs font-semibold uppercase tracking-wider text-white/30">Export</p>
        <div className="space-y-0.5 mb-2">
          {INTEGRATIONS.filter((i) => i.canExport).map((i) => (
            <button
              key={`export-${i.id}`}
              onClick={() => exportToIntegration(i.id)}
              disabled={isExporting || !stats?.trackCount}
              className="w-full text-left px-3 py-1.5 rounded-lg text-sm text-white/60 hover:bg-white/5 hover:text-white transition-colors flex items-center gap-2 disabled:opacity-40"
            >
              <span className="text-xs opacity-60">↑</span>
              {isExporting ? 'Exporting…' : i.label}
            </button>
          ))}
        </div>

        <button
          onClick={() => onNavigate('health')}
          className={`w-full text-left px-3 py-1.5 rounded-lg text-sm transition-colors ${
            activePage === 'health'
              ? 'bg-white/10 text-white'
              : 'text-white/50 hover:bg-white/5 hover:text-white'
          }`}
        >
          Library Health
        </button>
        <button
          onClick={() => onNavigate('settings')}
          className={`w-full text-left px-3 py-1.5 rounded-lg text-sm transition-colors ${
            activePage === 'settings'
              ? 'bg-white/10 text-white'
              : 'text-white/50 hover:bg-white/5 hover:text-white'
          }`}
        >
          Settings
        </button>
      </div>
    </aside>
  )
}

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
}

function PlaylistItem({
  playlist, isActive, isRenaming, renameValue,
  onRenameChange, onRenameCommit, onClick, onStartRename, onDelete
}: PlaylistItemProps): JSX.Element {
  const [hovered, setHovered] = useState(false)

  if (isRenaming) {
    return (
      <div className="px-1">
        <input
          autoFocus
          value={renameValue}
          onChange={(e) => onRenameChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onRenameCommit(); if (e.key === 'Escape') onRenameCommit() }}
          onBlur={onRenameCommit}
          className="w-full bg-white/10 border border-accent/50 rounded px-2 py-1 text-xs text-white outline-none"
        />
      </div>
    )
  }

  return (
    <div
      className={`flex items-center rounded-lg group ${isActive ? 'bg-accent' : 'hover:bg-white/5'}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        onClick={onClick}
        onDoubleClick={onStartRename}
        className={`flex-1 text-left px-3 py-1.5 text-sm truncate transition-colors ${
          isActive ? 'text-white' : 'text-white/70 group-hover:text-white'
        }`}
        title={`${playlist.name} · ${playlist.trackIds.length} tracks · Double-click to rename`}
      >
        {playlist.name}
        <span className={`ml-1 text-xs ${isActive ? 'opacity-60' : 'opacity-0 group-hover:opacity-40'}`}>
          {playlist.trackIds.length}
        </span>
      </button>
      {hovered && !isActive && (
        <button
          onClick={onDelete}
          className="shrink-0 px-2 text-white/30 hover:text-red-400 transition-colors text-xs"
          title="Delete playlist"
        >
          ×
        </button>
      )}
    </div>
  )
}
