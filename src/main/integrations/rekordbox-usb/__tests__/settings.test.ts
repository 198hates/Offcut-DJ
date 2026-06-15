import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { patchDevSetting, patchMySetting, patchMySetting2 } from '../settings'
import type { UsbDeviceSettings } from '../../../../shared/types'

const TPL = readFileSync(join(__dirname, '../templates/DEVSETTING.DAT')) as Buffer
const MY = readFileSync(join(__dirname, '../templates/MYSETTING.DAT')) as Buffer
const MY2 = readFileSync(join(__dirname, '../templates/MYSETTING2.DAT')) as Buffer

const FULL: UsbDeviceSettings = {
  waveformColor: '3band', waveformPosition: 'center', keyDisplay: 'classic', overviewWaveform: 'half',
  waveformDivisions: 'phrase', jogDisplay: 'auto', quantize: 'on', quantizeBeat: '1/4',
  autoCue: 'off', hotcueAutoload: 'off', timeMode: 'elapsed'
}

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
    const out = patchDevSetting(TPL, FULL)
    expect(out[0x71]).toBe(0x01) // overview half
    expect(out[0x72]).toBe(0x04) // colour 3band
    expect(out[0x74]).toBe(0x01) // key classic
    expect(out[0x75]).toBe(0x01) // position center
    expect(out.readUInt16LE(out.length - 4)).toBe(checksumOf(out)) // checksum valid
  })

  it('maps every enum and only touches the setting + checksum bytes', () => {
    const s: UsbDeviceSettings = { ...FULL, waveformColor: 'blue', waveformPosition: 'left', keyDisplay: 'alphanumeric', overviewWaveform: 'full' }
    const out = patchDevSetting(TPL, s)
    expect(out[0x71]).toBe(0x02) // full
    expect(out[0x72]).toBe(0x01) // blue
    expect(out[0x74]).toBe(0x02) // alphanumeric
    expect(out[0x75]).toBe(0x02) // left
    const changed = [...out].map((b, i) => (b !== TPL[i] ? i : -1)).filter((i) => i >= 0)
    expect(changed.every((i) => [0x71, 0x72, 0x74, 0x75, out.length - 4, out.length - 3].includes(i))).toBe(true)
    expect(out.readUInt16LE(out.length - 4)).toBe(checksumOf(out))
  })

  it('leaves a too-short template untouched', () => {
    const tiny = Buffer.alloc(8, 1)
    expect(patchDevSetting(tiny, FULL)).toEqual(tiny)
  })
})

describe('patchMySetting', () => {
  it('writes player settings (quantize, auto-cue…) with a valid checksum', () => {
    const s: UsbDeviceSettings = { ...FULL, quantize: 'on', quantizeBeat: '1/8', hotcueAutoload: 'rekordbox', timeMode: 'remain', autoCue: 'on' }
    const out = patchMySetting(MY, s)
    expect(out[0x72]).toBe(0x81) // quantize on
    expect(out[0x7c]).toBe(0x83) // 1/8 beat
    expect(out[0x7d]).toBe(0x82) // hotcue autoload = rekordbox
    expect(out[0x80]).toBe(0x81) // time mode remain
    expect(out[0x82]).toBe(0x81) // auto cue on
    expect(out.readUInt16LE(out.length - 4)).toBe(checksumOf(out))
  })
})

describe('patchMySetting2', () => {
  it('writes waveform divisions + jog display with a valid checksum', () => {
    const s: UsbDeviceSettings = { ...FULL, waveformDivisions: 'timescale', jogDisplay: 'artwork' }
    const out = patchMySetting2(MY2, s)
    expect(out[0x69]).toBe(0x83) // jog display artwork
    expect(out[0x6c]).toBe(0x80) // waveform divisions timescale
    expect(out.readUInt16LE(out.length - 4)).toBe(checksumOf(out))
  })
})
