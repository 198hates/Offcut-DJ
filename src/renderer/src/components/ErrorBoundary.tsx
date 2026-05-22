/**
 * ErrorBoundary — catches React render/lifecycle errors per-page.
 *
 * Wraps each page in App.tsx so a crash in Orders doesn't blank the Library,
 * and a crash in the Player doesn't blank everything.
 */

import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  name?: string          // for console logging
  inline?: boolean       // when true renders a compact inline error strip
}

interface State {
  hasError: boolean
  error:    Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: { componentStack: string }): void {
    console.error(`[ErrorBoundary${this.props.name ? ':' + this.props.name : ''}]`, error)
    console.error(info.componentStack)
  }

  reset = (): void => this.setState({ hasError: false, error: null })

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children

    if (this.props.inline) {
      return (
        <div className="flex items-center gap-3 px-4 py-2 bg-red-500/10 border-b border-red-500/20">
          <span className="font-mono text-[8px] uppercase tracking-[0.15em] text-red-400 shrink-0">error</span>
          <span className="font-mono text-[9px] text-red-300/80 truncate flex-1">{this.state.error?.message}</span>
          <button
            onClick={this.reset}
            className="font-mono text-[8px] uppercase tracking-[0.1em] px-2 py-0.5 border border-red-400/30 rounded text-red-400 hover:bg-red-400/10 transition-colors shrink-0"
          >
            retry
          </button>
        </div>
      )
    }

    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 p-8">
        <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-accent/60">render error</span>
        <p className="font-mono text-[11px] text-ink text-center max-w-sm leading-relaxed">
          {this.state.error?.message ?? 'An unexpected error occurred.'}
        </p>
        {this.props.name && (
          <p className="font-mono text-[8.5px] text-muted/40 uppercase tracking-[0.1em]">{this.props.name}</p>
        )}
        <button
          onClick={this.reset}
          className="font-mono text-[9px] uppercase tracking-[0.1em] px-4 py-2 border border-border/40 rounded hover:border-accent/40 text-muted hover:text-accent transition-colors mt-2"
        >
          try again
        </button>
      </div>
    )
  }
}
