import { useState } from 'react'
import { useLibraryStore, type Filters } from '../store/libraryStore'

export function FilterBar(): JSX.Element {
  const { filters, setFilters, resetFilters, availableKeys, availableGenres, searchQuery, setSearchQuery } = useLibraryStore()
  const [open, setOpen] = useState(false)

  const keys = availableKeys()
  const genres = availableGenres()
  const hasActiveFilters =
    filters.bpmMin != null || filters.bpmMax != null ||
    filters.keys.length > 0 || filters.genres.length > 0 ||
    filters.ratingMin != null

  const toggleKey = (key: string): void => {
    setFilters({
      keys: filters.keys.includes(key)
        ? filters.keys.filter((k) => k !== key)
        : [...filters.keys, key]
    })
  }

  const toggleGenre = (genre: string): void => {
    setFilters({
      genres: filters.genres.includes(genre)
        ? filters.genres.filter((g) => g !== genre)
        : [...filters.genres, genre]
    })
  }

  return (
    <div className="border-b border-white/5 shrink-0">
      <div className="flex items-center gap-2 px-4 py-2">
        <div className="relative flex-1 max-w-xs">
          <input
            type="text"
            placeholder="Search tracks…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white placeholder-white/30 outline-none focus:border-accent transition-colors"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-white/30 hover:text-white"
            >
              ×
            </button>
          )}
        </div>

        <button
          onClick={() => setOpen((o) => !o)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors ${
            open || hasActiveFilters
              ? 'bg-accent/20 text-accent border border-accent/30'
              : 'bg-white/5 text-white/50 border border-white/10 hover:text-white'
          }`}
        >
          <span>Filter</span>
          {hasActiveFilters && (
            <span className="bg-accent text-white text-xs rounded-full w-4 h-4 flex items-center justify-center leading-none">
              {[filters.bpmMin != null, filters.bpmMax != null, filters.keys.length > 0, filters.genres.length > 0, filters.ratingMin != null].filter(Boolean).length}
            </span>
          )}
        </button>

        {hasActiveFilters && (
          <button
            onClick={resetFilters}
            className="text-xs text-white/40 hover:text-white transition-colors"
          >
            Clear filters
          </button>
        )}
      </div>

      {open && (
        <div className="px-4 pb-3 flex flex-wrap gap-6">
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-white/30">BPM</p>
            <div className="flex items-center gap-2">
              <input
                type="number"
                placeholder="Min"
                value={filters.bpmMin ?? ''}
                min={60} max={220}
                onChange={(e) => setFilters({ bpmMin: e.target.value ? Number(e.target.value) : null })}
                className="w-16 bg-white/5 border border-white/10 rounded px-2 py-1 text-xs text-white outline-none focus:border-accent"
              />
              <span className="text-white/30 text-xs">–</span>
              <input
                type="number"
                placeholder="Max"
                value={filters.bpmMax ?? ''}
                min={60} max={220}
                onChange={(e) => setFilters({ bpmMax: e.target.value ? Number(e.target.value) : null })}
                className="w-16 bg-white/5 border border-white/10 rounded px-2 py-1 text-xs text-white outline-none focus:border-accent"
              />
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-white/30">Rating</p>
            <div className="flex items-center gap-1">
              {[1, 2, 3, 4, 5].map((r) => (
                <button
                  key={r}
                  onClick={() => setFilters({ ratingMin: filters.ratingMin === r ? null : r })}
                  className={`text-base transition-colors ${r <= (filters.ratingMin ?? 0) ? 'text-yellow-400' : 'text-white/20 hover:text-white/50'}`}
                >
                  ★
                </button>
              ))}
              {filters.ratingMin && <span className="text-xs text-white/40 ml-1">+</span>}
            </div>
          </div>

          {keys.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-white/30">Key</p>
              <div className="flex flex-wrap gap-1 max-w-xs">
                {keys.map((key) => (
                  <button
                    key={key}
                    onClick={() => toggleKey(key)}
                    className={`px-2 py-0.5 rounded text-xs font-mono transition-colors ${
                      filters.keys.includes(key)
                        ? 'bg-accent text-white'
                        : 'bg-white/5 text-white/50 hover:bg-white/10 hover:text-white'
                    }`}
                  >
                    {key}
                  </button>
                ))}
              </div>
            </div>
          )}

          {genres.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-white/30">Genre</p>
              <div className="flex flex-wrap gap-1 max-w-sm">
                {genres.map((genre) => (
                  <button
                    key={genre}
                    onClick={() => toggleGenre(genre)}
                    className={`px-2 py-0.5 rounded text-xs transition-colors ${
                      filters.genres.includes(genre)
                        ? 'bg-accent text-white'
                        : 'bg-white/5 text-white/50 hover:bg-white/10 hover:text-white'
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
