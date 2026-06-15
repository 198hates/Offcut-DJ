// Edit the Pioneer setting files (DEVSETTING.DAT / MYSETTING.DAT /
// MYSETTING2.DAT) that the rekordbox device/player settings panels expose. Each
// setting is a single enum byte at a known offset; we patch a known-good
// template in place and recompute its CRC16/XMODEM checksum over the data
// section. Offsets, enum values and the checksum were all verified byte-for-byte
// against real rekordbox 7 exports (patching with a file's own values
// reproduces it identically).

import type { UsbDeviceSettings } from '../../../shared/types'

type FieldSpec = { offset: number; map: Record<string, number> }

// DEVSETTING.DAT — data section at 0x68 (9-byte prefix, then the fields).
const DEV_FIELDS: Partial<Record<keyof UsbDeviceSettings, FieldSpec>> = {
  overviewWaveform: { offset: 0x71, map: { half: 0x01, full: 0x02 } },
  waveformColor: { offset: 0x72, map: { blue: 0x01, rgb: 0x03, '3band': 0x04 } },
  keyDisplay: { offset: 0x74, map: { classic: 0x01, alphanumeric: 0x02 } },
  waveformPosition: { offset: 0x75, map: { center: 0x01, left: 0x02 } }
}

// MYSETTING.DAT — data at 0x68 (8-byte prefix).
const MY_FIELDS: Partial<Record<keyof UsbDeviceSettings, FieldSpec>> = {
  quantize: { offset: 0x72, map: { off: 0x80, on: 0x81 } },
  quantizeBeat: { offset: 0x7c, map: { '1': 0x80, '1/2': 0x81, '1/4': 0x82, '1/8': 0x83 } },
  hotcueAutoload: { offset: 0x7d, map: { off: 0x80, on: 0x81, rekordbox: 0x82 } },
  timeMode: { offset: 0x80, map: { elapsed: 0x80, remain: 0x81 } },
  autoCue: { offset: 0x82, map: { off: 0x80, on: 0x81 } }
}

// MYSETTING2.DAT — data at 0x68 (no prefix).
const MY2_FIELDS: Partial<Record<keyof UsbDeviceSettings, FieldSpec>> = {
  jogDisplay: { offset: 0x69, map: { auto: 0x80, info: 0x81, simple: 0x82, artwork: 0x83 } },
  waveformDivisions: { offset: 0x6c, map: { timescale: 0x80, phrase: 0x81 } }
}

const CHECKSUM_START = 104 // data section start (header is len + 3×0x20 strings + len_data)

function crc16xmodem(buf: Buffer): number {
  let crc = 0
  for (const byte of buf) {
    crc ^= byte << 8
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1
      crc &= 0xffff
    }
  }
  return crc
}

function patchSetting(template: Buffer, fields: Partial<Record<keyof UsbDeviceSettings, FieldSpec>>, s: UsbDeviceSettings): Buffer {
  // Too short to be a valid setting file → copy verbatim.
  if (template.length < CHECKSUM_START + 6) return Buffer.from(template)
  const buf = Buffer.from(template)
  for (const key of Object.keys(fields) as (keyof UsbDeviceSettings)[]) {
    const spec = fields[key]!
    const value = spec.map[s[key] as string]
    if (value != null && spec.offset < buf.length - 4) buf[spec.offset] = value
  }
  buf.writeUInt16LE(crc16xmodem(buf.subarray(CHECKSUM_START, buf.length - 4)), buf.length - 4)
  return buf
}

export const patchDevSetting = (t: Buffer, s: UsbDeviceSettings): Buffer => patchSetting(t, DEV_FIELDS, s)
export const patchMySetting = (t: Buffer, s: UsbDeviceSettings): Buffer => patchSetting(t, MY_FIELDS, s)
export const patchMySetting2 = (t: Buffer, s: UsbDeviceSettings): Buffer => patchSetting(t, MY2_FIELDS, s)
