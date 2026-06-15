// Edit the Pioneer DEVSETTING.DAT device settings (waveform colour, key display,
// overview type, waveform position) that the rekordbox device-settings panel
// exposes. We patch a known-good template in place and recompute its checksum
// (CRC16/XMODEM over the data section) rather than rebuild the file — the format
// and checksum were verified byte-for-byte against real rekordbox exports.

import type { UsbDeviceSettings } from '../../../shared/types'

// Enum byte values (from rekordcrate's setting.rs, confirmed against real files).
const WAVEFORM_COLOR: Record<UsbDeviceSettings['waveformColor'], number> = { blue: 0x01, rgb: 0x03, '3band': 0x04 }
const WAVEFORM_POSITION: Record<UsbDeviceSettings['waveformPosition'], number> = { left: 0x02, center: 0x01 }
const KEY_DISPLAY: Record<UsbDeviceSettings['keyDisplay'], number> = { classic: 0x01, alphanumeric: 0x02 }
const OVERVIEW: Record<UsbDeviceSettings['overviewWaveform'], number> = { half: 0x01, full: 0x02 }

// Field offsets within DEVSETTING.DAT (the 32-byte data section starts at 0x68).
const OFF_OVERVIEW = 0x71
const OFF_COLOR = 0x72
const OFF_KEY = 0x74
const OFF_POSITION = 0x75
// The checksum covers the data section (offset 104) up to the last 4 bytes
// (checksum u16 + trailing u16) for every file except DJMMYSETTING.DAT.
const CHECKSUM_START = 104

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

/**
 * Return a copy of a DEVSETTING.DAT template with `s` applied and the checksum
 * recomputed. If the template is too short to be a valid settings file it's
 * returned unchanged (the export then just copies it verbatim).
 */
export function patchDevSetting(template: Buffer, s: UsbDeviceSettings): Buffer {
  if (template.length < OFF_POSITION + 4 + 4) return Buffer.from(template)
  const buf = Buffer.from(template)
  buf[OFF_OVERVIEW] = OVERVIEW[s.overviewWaveform]
  buf[OFF_COLOR] = WAVEFORM_COLOR[s.waveformColor]
  buf[OFF_KEY] = KEY_DISPLAY[s.keyDisplay]
  buf[OFF_POSITION] = WAVEFORM_POSITION[s.waveformPosition]
  const crc = crc16xmodem(buf.subarray(CHECKSUM_START, buf.length - 4))
  buf.writeUInt16LE(crc, buf.length - 4)
  return buf
}
