/**
 * useVirtualList — lightweight manual windowing for fixed-row-height lists.
 *
 * One implementation for the scrollTop/rowHeight slice pattern that was copied
 * into the Library table and LibraryMini. Render only `items.slice(start, end)`
 * inside the scroll container, with spacer divs of `topPad` / `bottomPad`.
 */

import { useEffect, useRef, useState } from 'react'
import type { RefObject, UIEvent } from 'react'

export interface VirtualWindow {
  /** Attach to the scrollable container. */
  containerRef: RefObject<HTMLDivElement>
  /** First visible index (inclusive, with overscan). */
  start: number
  /** Last visible index (exclusive, with overscan). */
  end: number
  /** Spacer height above the rendered slice. */
  topPad: number
  /** Spacer height below the rendered slice. */
  bottomPad: number
  /** Attach to the container's onScroll. */
  onScroll: (e: UIEvent<HTMLElement>) => void
}

export function useVirtualList(
  count: number,
  rowHeight: number,
  overscan = 6,
  externalRef?: RefObject<HTMLDivElement>
): VirtualWindow {
  const internalRef = useRef<HTMLDivElement>(null)
  const containerRef = externalRef ?? internalRef
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(400)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewport(el.clientHeight))
    ro.observe(el)
    setViewport(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
  const end = Math.min(count, Math.ceil((scrollTop + viewport) / rowHeight) + overscan)

  return {
    containerRef,
    start,
    end,
    topPad: start * rowHeight,
    bottomPad: Math.max(0, (count - end) * rowHeight),
    onScroll: (e) => setScrollTop((e.target as HTMLElement).scrollTop)
  }
}
