/**
 * Track drag-and-drop helpers — one definition of the app's track-id drag
 * protocol, used by every drag source and drop target (previously copied into
 * Library, LibraryMini, Deck, Sidebar, Lineage, Set Builder and Orders).
 */

import type { DragEvent } from 'react'

/** The dataTransfer MIME carrying a JSON array of track ids. */
export const TRACK_DRAG_MIME = 'application/x-offcut-track-ids'

/** Mark a drag as carrying these track ids (call from onDragStart). */
export function setTrackDragData(e: DragEvent, ids: string[]): void {
  e.dataTransfer.effectAllowed = 'copy'
  e.dataTransfer.setData(TRACK_DRAG_MIME, JSON.stringify(ids))
}

/** True when the drag carries track ids (call from onDragOver/onDrop). */
export function acceptsTrackDrop(e: DragEvent): boolean {
  return e.dataTransfer.types.includes(TRACK_DRAG_MIME)
}

/** Parse the dragged track ids; [] if absent/malformed. */
export function readTrackIds(e: DragEvent): string[] {
  try {
    const raw = e.dataTransfer.getData(TRACK_DRAG_MIME)
    const ids = raw ? (JSON.parse(raw) as unknown) : null
    return Array.isArray(ids) ? (ids as string[]) : []
  } catch {
    return []
  }
}
