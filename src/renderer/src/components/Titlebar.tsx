export function Titlebar(): JSX.Element {
  const isMac = navigator.platform.toLowerCase().includes('mac')

  return (
    <div
      className={`drag-region flex items-center h-10 bg-surface-900 border-b border-white/5 shrink-0 ${
        isMac ? 'pl-20' : 'pl-4'
      }`}
    >
      <span className="no-drag text-white/60 text-xs font-medium tracking-wide select-none">
        Crate
      </span>
    </div>
  )
}
