/**
 * Phase 2: Direct Rekordbox master.db access via SQLCipher.
 *
 * Rekordbox 6/7 encrypts master.db with SQLCipher 4. The key is the same across
 * all installations and is publicly documented:
 * https://pyrekordbox.readthedocs.io/en/latest/formats/db6.html
 *
 * This reader requires a SQLCipher-capable SQLite binding. On macOS ARM64 the
 * `better-sqlite3-multiple-ciphers` package currently fails to compile due to
 * an x86-only -maes flag. Blocked pending upstream fix or alternative binding.
 *
 * DB location:
 *   macOS:   ~/Library/Pioneer/rekordbox/master.db
 *   Windows: %AppData%\Pioneer\rekordbox\master.db
 */

export const RB_CIPHER_KEY =
  '402fd482c38817c35ffa8ffb8c7d93143b749e7d315df7a81732a1ff43608497'

export const RB_DB_PATH = {
  darwin: `${process.env.HOME}/Library/Pioneer/rekordbox/master.db`,
  win32: `${process.env.APPDATA}\\Pioneer\\rekordbox\\master.db`
}

// Full implementation to be added in Phase 2 when SQLCipher binding is resolved.
