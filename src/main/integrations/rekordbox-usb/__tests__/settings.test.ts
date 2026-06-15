import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { patchDevSetting } from '../settings'
import type { UsbDeviceSettings } from '../../../../shared/types'

const TPL = readFileSync(join(__dirname, '../templates/DEVSETTING.DAT')) as Buffer

function crc16xmodem(buf: Buffer): number {
  let c = 0
  for (const b of buf) {
    c ^= b << 8
    for (let i = 0; i < 8; i++) {
      c = c & 0x8000 ? (c << 1) ^ 0x1021 : c << 1
      c &= 0xffff
    }
  }
  return c
}
const checksumOf = (b: Buffer): number => crc16xmodem(b.subarray(104, b.length - 4))

describe('patchDevSetting', () => {
  it('writes the chosen bytes and a valid checksum', () => {
    const s: UsbDeviceSettings = {
      waveformColor: '3band',
      waveformPosition: 'center',
      keyDisplay: 'classic',
      overviewWaveform: 'half'
    }
    const out = patchDevSetting(TPL, s)
    expect(out[0x71]).toBe(0x01) // overview half
    expect(out[0x72]).toBe(0x04) // colour 3band
    expect(out[0x74]).toBe(0x01) // key classic
    expect(out[0x75]).toBe(0x01) // position center
    expect(out.readUInt16LE(out.length - 4)).toBe(checksumOf(out)) // checksum valid
  })

  it('maps every enum and only touches the setting + checksum bytes', () => {
    const s: UsbDeviceSettings = {
      waveformColor: 'blue',
      waveformPosition: 'left',
      keyDisplay: 'alphanumeric',
      overviewWaveform: 'full'
    }
    const out = patchDevSetting(TPL, s)
    expect(out[0x71]).toBe(0x02) // full
    expect(out[0x72]).toBe(0x01) // blue
    expect(out[0x74]).toBe(0x02) // alphanumeric
    expect(out[0x75]).toBe(0x02) // left
    const changed = [...out].map((b, i) => (b !== TPL[i] ? i : -1)).filter((i) => i >= 0)
    // only the 4 setting bytes + the 2 checksum bytes may differ
    expect(changed.every((i) => [0x71, 0x72, 0x74, 0x75, out.length - 4, out.length - 3].includes(i))).toBe(true)
    expect(out.readUInt16LE(out.length - 4)).toBe(checksumOf(out))
  })

  it('leaves a too-short template untouched', () => {
    const tiny = Buffer.alloc(8, 1)
    expect(patchDevSetting(tiny, { waveformColor: 'rgb', waveformPosition: 'left', keyDisplay: 'classic', overviewWaveform: 'half' })).toEqual(tiny)
  })
})
