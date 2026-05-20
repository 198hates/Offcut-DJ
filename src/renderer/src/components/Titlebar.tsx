import { useThemeStore } from '../store/themeStore'

export function Titlebar(): JSX.Element {
  const { theme, toggleTheme } = useThemeStore()
  const isMac = navigator.platform.toLowerCase().includes('mac')

  return (
    <div
      className={`drag-region flex items-center h-9 bg-chassis-soft border-b border-border/30 shrink-0 ${
        isMac ? 'pl-[76px]' : 'pl-4'
      } pr-3`}
    >
      {/* Brand mark + wordmark */}
      <div className="no-drag flex items-center gap-1.5 select-none">
        {/* mk·01 — the Frame */}
        <svg viewBox="0 0 22 22" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4"
             style={{ color: 'rgb(var(--muted-rgb))', flexShrink: 0 }}>
          <path d="M 2 2 L 16 2 L 20 6 L 20 20 L 2 20 Z" />
          <circle cx="18" cy="4" r="1.6" fill="rgb(var(--accent-rgb))" stroke="none" />
        </svg>
        {/* offcut wordmark — Fraunces 300 italic */}
        <span style={{
          fontFamily: "'Fraunces', serif",
          fontStyle: 'italic',
          fontWeight: 300,
          fontSize: 16,
          letterSpacing: '-0.03em',
          color: 'rgb(var(--ink-rgb))',
          lineHeight: 1,
        }}>offcut</span>
        {/* product code */}
        <span style={{
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: 7.5,
          letterSpacing: '0.14em',
          color: 'rgb(var(--muted-rgb))',
          marginLeft: 2,
        }}>od·01</span>
      </div>

      <div className="flex-1" />

      {/* Chunky physical toggle */}
      <button
        onClick={toggleTheme}
        className="no-drag theme-toggle"
        aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
        title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
      >
        {/* Sun icon */}
        <span className="theme-toggle-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="4"/>
            <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>
          </svg>
        </span>
        {/* Moon icon */}
        <span className="theme-toggle-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
          </svg>
        </span>
        {/* Sliding knob */}
        <div className="theme-toggle-knob" />
      </button>
    </div>
  )
}
