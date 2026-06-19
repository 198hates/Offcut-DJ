// Cover-art thumbnail with a graceful fallback. The desktop serves embedded art
// at /media/artwork (404 when a track has none), so we render the image and, on
// 404/error/empty, fall back to a tinted tile showing the title's initial — the
// same "no artwork" treatment the desktop library uses.

import { useEffect, useState } from 'react'
import { Image, StyleSheet, Text, View } from 'react-native'
import { C, MONO_BOLD } from './theme'

export function Artwork({
  url,
  size,
  label,
  color,
  radius = 4
}: {
  url: string | null
  size: number
  label?: string
  color?: string | null
  radius?: number
}): JSX.Element {
  const [failed, setFailed] = useState(false)
  // A new url (different track recycled into this row) gets a fresh try.
  useEffect(() => setFailed(false), [url])

  const box = { width: size, height: size, borderRadius: radius }
  if (!url || failed) {
    const initial = (label ?? '').trim().charAt(0).toUpperCase() || '♪'
    return (
      <View style={[styles.fallback, box, color ? { backgroundColor: tint(color) } : null]}>
        <Text style={[styles.initial, { fontSize: Math.round(size * 0.42) }]} numberOfLines={1}>
          {initial}
        </Text>
      </View>
    )
  }
  return (
    <Image
      source={{ uri: url }}
      style={[styles.img, box]}
      onError={() => setFailed(true)}
      resizeMode="cover"
    />
  )
}

/** Mute a track colour so it reads as a background, not a swatch. */
function tint(hex: string): string {
  return hex.length === 7 ? `${hex}2E` : hex
}

const styles = StyleSheet.create({
  img: { backgroundColor: C.deckPanel },
  fallback: { backgroundColor: C.paper, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: C.border },
  initial: { color: C.muted, fontFamily: MONO_BOLD }
})
