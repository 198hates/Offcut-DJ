import { useState } from 'react'
import { useLibraryStore } from '../store/libraryStore'

export function FilterBar(): JSX.Element {
  const { filters, setFilters, resetFilters, availableKeys, availableGenres, searchQuery, setSearchQuery } = useLibraryStore()
  const [open, setOpen] = useState(false)

  const keys   = availableKeys()
  const genres = availableGenres()
  const activeCount = [
    filters.bpmMin != null, filters.bpmMax != null,
    filters.keys.length > 0, filters.genres.length > 0,
    filters.ratingMin != null
  ].filter(Boolean).length

  const toggleKey   = (key: string): void => setFilters({ keys:   filters.keys.includes(key)     ? filters.keys.filter((k) => k !== key)     : [...filters.keys, key] })
  const toggleGenre = (g: string): void   => setFilters({ genres: filters.genres.includes(g)      ? filters.genres.filter((x) => x !== g)     : [...filters.genres, g] })

  return (
    <div className="border-b border-border/30 shrink-0 bg-chassis-soft">
      <div className="flex items-center gap-2 px-3 py-1.5">
        {/* Search */}
        <div className="relative flex-1 max-w-xs">
          <input
            type="text"
            placeholder="search…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-paper border border-border/40 rounded px-3 py-1 text-[10.5px] font-mono text-ink placeholder-muted outline-none focus:border-accent/60 transition-colors"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-ink text-sm"
            >×</button>
          )}
        </div>

        {/* Filter toggle */}
        <button
          onClick={() => setOpen((o) => !o)}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded border font-mono text-[9.5px] uppercase tracking-[0.12em] transition-colors ${
            open || activeCount > 0
              ? 'bg-accent/10 text-accent border-accent/30'
              : 'bg-paper border-border/40 text-muted hover:text-ink'
          }`}
        >
          filter
          {activeCount > 0 && (
            <span className="bg-accent text-paper text-[9px] rounded-full w-3.5 h-3.5 flex items-center justify-center leading-none font-bold">
              {activeCount}
            </span>
          )}
        </button>

        {activeCount > 0 && (
          <button
            onClick={resetFilters}
            className="text-[9.5px] font-mono text-muted hover:text-ink transition-colors uppercase tracking-[0.1em]"
          >
            clear
          </button>
        )}
      </div>

      {open && (
        <div className="px-4 pb-3 flex flex-wrap gap-5 border-t border-border/20 pt-2.5">
          {/* BPM */}
          <div className="space-y-1.5">
            <p className="text-[9px] font-mono font-bold uppercase tracking-[0.2em] text-muted">BPM</p>
            <div className="flex items-center gap-1.5">
              <input
                type="number" placeholder="min"
                value={filters.bpmMin ?? ''}
                min={60} max={220}
                onChange={(e) => setFilters({ bpmMin: e.target.value ? Number(e.target.value) : null })}
                className="w-14 bg-paper border border-border/40 rounded px-2 py-1 text-[10px] font-mono text-ink outline-none focus:border-accent"
              />
              <span className="text-muted text-xs">–</span>
              <input
                type="number" placeholder="max"
                value={filters.bpmMax ?? ''}
                min={60} max={220}
                onChange={(e) => setFilters({ bpmMax: e.target.value ? Number(e.target.value) : null })}
                className="w-14 bg-paper border border-border/40 rounded px-2 py-1 text-[10px] font-mono text-ink outline-none focus:border-accent"
              />
            </div>
          </div>

          {/* Rating */}
          <div className="space-y-1.5">
            <p className="text-[9px] font-mono font-bold uppercase tracking-[0.2em] text-muted">Rating</p>
            <div className="flex items-center gap-0.5">
              {[1, 2, 3, 4, 5].map((r) => (
                <button
                  key={r}
                  onClick={() => setFilters({ ratingMin: filters.ratingMin === r ? null : r })}
                  className={`text-base transition-colors ${r <= (filters.ratingMin ?? 0) ? 'text-accent' : 'text-border hover:text-muted'}`}
                >★</button>
              ))}
              {filters.ratingMin && <span className="text-[9px] font-mono text-muted ml-1">+</span>}
            </div>
          </div>

          {/* Key */}
          {keys.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[9px] font-mono font-bold uppercase tracking-[0.2em] text-muted">Key</p>
              <div className="flex flex-wrap gap-1 max-w-xs">
                {keys.map((key) => (
                  <button
                    key={key}
                    onClick={() => toggleKey(key)}
                    className={`px-1.5 py-0.5 rounded text-[9.5px] font-mono font-bold transition-colors ${
                      filters.keys.includes(key)
                        ? 'bg-accent text-paper'
                        : 'bg-paper border border-border/40 text-muted hover:text-ink'
                    }`}
                  >
                    {key}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Genre */}
          {genres.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[9px] font-mono font-bold uppercase tracking-[0.2em] text-muted">Genre</p>
              <div className="flex flex-wrap gap-1 max-w-sm">
                {genres.map((genre) => (
                  <button
                    key={genre}
                    onClick={() => toggleGenre(genre)}
                    className={`px-1.5 py-0.5 rounded text-[9.5px] font-mono transition-colors ${
                      filters.genres.includes(genre)
                        ? 'bg-accent text-paper'
                        : 'bg-paper border border-border/40 text-muted hover:text-ink'
                    }`}
                  >
                    {genre}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
