/**
 * Organize — consolidate audio files scattered across the laptop into one
 * music library folder, and relink any library tracks that moved.
 */
import { useState, useCallback, useEffect } from 'react'
import { useLibraryStore } from '../../store/libraryStore'
import { PageHeader } from '../../components/PageHeader'
import { btnPrimary, btnGhost } from '../../lib/ui'
import type { OrganizeMove, OrganizeMoveResult } from '@shared/types'

function SourceFoldersTool({ folders, onChange }: {
  folders: string[]; onChange: (next: string[]) => void
}): JSX.Element {
  const add = async (): Promise<void> => {
    const p = await window.api.settings.choosePath('Add source folder to scan', true)
    if (!p || folders.includes(p)) return
    onChange([...folders, p])
  }
  const remove = (path: string): void => onChange(folders.filter((f) => f !== path))

  return (
    <div className="space-y-2">
      {folders.length === 0 ? (
        <p className="font-mono text-[12px] text-muted/50 italic">No source folders added yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {folders.map((f) => (
            <li key={f} className="flex items-center gap-2 bg-ink/[0.03] border border-border/30 rounded px-3 py-2">
              <span className="flex-1 font-mono text-[13px] text-ink truncate">{f}</span>
              <button
                onClick={() => remove(f)}
                className="text-muted hover:text-red-500 transition-colors font-mono text-[12px]"
                title="Remove"
              >✕</button>
            </li>
          ))}
        </ul>
      )}
      <button onClick={add} className={btnGhost}>+ add source folder</button>
    </div>
  )
}

export function OrganizePage(): JSX.Element {
  const [sourceFolders, setSourceFolders] = useState<string[]>([])
  const [libraryRoot, setLibraryRoot]     = useState('')
  const [scanning, setScanning]           = useState(false)
  const [moves, setMoves]                 = useState<OrganizeMove[] | null>(null)
  const [applying, setApplying]           = useState(false)
  const [results, setResults]             = useState<OrganizeMoveResult[] | null>(null)

  useEffect(() => {
    window.api.settings.get().then((s) => setLibraryRoot(s.musicLibraryRoot))
  }, [])

  const chooseLibraryRoot = async (): Promise<void> => {
    const p = await window.api.settings.choosePath('Choose music library folder', true)
    if (!p) return
    setLibraryRoot(p)
    await window.api.settings.save({ musicLibraryRoot: p })
  }

  const scan = useCallback(async (): Promise<void> => {
    if (!sourceFolders.length || !libraryRoot) return
    setScanning(true)
    setResults(null)
    const found = await window.api.library.scanForOrganize(sourceFolders, libraryRoot)
    setMoves(found)
    setScanning(false)
  }, [sourceFolders, libraryRoot])

  const apply = async (): Promise<void> => {
    if (!moves?.length) return
    const relinkCount = moves.filter((m) => m.trackId).length
    const msg =
      `Move ${moves.length} file${moves.length !== 1 ? 's' : ''} into ${libraryRoot}?` +
      (relinkCount ? `\n\n${relinkCount} of them are library tracks and will be relinked automatically.` : '')
    if (!window.confirm(msg)) return
    setApplying(true)
    const res = await window.api.library.organizeFiles(moves)
    setApplying(false)
    setResults(res)
    setMoves(null)
    if (res.some((r) => r.ok && r.trackId)) await useLibraryStore.getState().loadLibrary()
  }

  const succeeded = results?.filter((r) => r.ok).length ?? 0
  const failed     = results?.filter((r) => !r.ok) ?? []

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PageHeader marker="⊞" title="organize" subtitle="consolidate scattered audio files into one music folder" />

      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6 max-w-3xl">
        <section className="space-y-2">
          <h2 className="font-mono text-xs font-bold uppercase tracking-[0.12em] text-ink">music library folder</h2>
          <p className="font-mono text-[13px] text-muted">Files found below are moved here.</p>
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={libraryRoot}
              readOnly
              className="flex-1 bg-paper border border-border/40 rounded px-3 py-1.5 font-mono text-[13px] text-ink"
            />
            <button onClick={chooseLibraryRoot} className={btnGhost}>browse</button>
          </div>
        </section>

        <section className="space-y-2">
          <h2 className="font-mono text-xs font-bold uppercase tracking-[0.12em] text-ink">source folders to scan</h2>
          <p className="font-mono text-[13px] text-muted">
            Add the folders on your laptop where scattered audio files might be — Downloads, Desktop, an old
            external drive&rsquo;s mount point, etc.
          </p>
          <SourceFoldersTool folders={sourceFolders} onChange={setSourceFolders} />
        </section>

        <div>
          <button onClick={scan} disabled={scanning || !sourceFolders.length || !libraryRoot} className={btnPrimary}>
            {scanning ? 'scanning…' : 'scan for files'}
          </button>
        </div>

        {moves !== null && (
          moves.length === 0 ? (
            <p className="font-mono text-[13px] text-green-600 dark:text-green-400 flex items-center gap-2">
              <span>✓</span> nothing to move — everything&rsquo;s already in the library folder
            </p>
          ) : (
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="font-mono text-[13px] text-ink-soft">
                  found <span className="text-ink font-bold">{moves.length}</span> file{moves.length !== 1 ? 's' : ''} to move
                  {' '}(<span className="text-ink font-bold">{moves.filter((m) => m.trackId).length}</span> are library tracks — will be relinked)
                </p>
                <button onClick={apply} disabled={applying} className={btnPrimary}>
                  {applying ? 'moving…' : `move ${moves.length} file${moves.length !== 1 ? 's' : ''}`}
                </button>
              </div>
              <div className="space-y-1 max-h-96 overflow-y-auto">
                {moves.map((m, i) => (
                  <div key={i} className="flex items-center gap-2 bg-ink/[0.03] border border-border/20 rounded px-3 py-1.5 font-mono text-[12px]">
                    {m.trackId && <span className="text-accent shrink-0" title="Library track — will be relinked">●</span>}
                    <span className="flex-1 truncate text-muted" title={m.from}>{m.from}</span>
                    <span className="text-muted/40 shrink-0">→</span>
                    <span className="flex-1 truncate text-ink" title={m.to}>{m.to}</span>
                  </div>
                ))}
              </div>
            </section>
          )
        )}

        {results !== null && (
          <section className="space-y-2">
            <p className="font-mono text-[13px] text-green-600 dark:text-green-400">
              ✓ moved {succeeded} of {results.length} files
            </p>
            {failed.length > 0 && (
              <div className="space-y-1">
                <p className="font-mono text-[12px] text-red-500">{failed.length} failed:</p>
                {failed.map((f, i) => (
                  <p key={i} className="font-mono text-[11px] text-muted truncate" title={f.from}>{f.from}: {f.error}</p>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  )
}
