import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { SessionStoreCorruptError, SessionStoreError, SessionStoreKeyError } from './errors.js'

// On-disk envelope of the session store (SPEC section 8): a single AES-256-GCM file.
//
//   magic (8 bytes, ASCII) | iv (12) | auth tag (16) | ciphertext
//
// The magic carries the format version in its last byte and is fed to GCM as additional
// authenticated data, so the version is covered by the tag: an attacker cannot rewrite the
// header to a format with weaker rules and still have the file authenticate.
const MAGIC_PREFIX = 'RTKSESS'
const FORMAT_VERSION = '1'
const MAGIC = Buffer.from(MAGIC_PREFIX + FORMAT_VERSION, 'ascii')
// 96-bit nonce, the size AES-GCM is specified for. A fresh one per write is mandatory —
// reusing a nonce under the same key breaks GCM outright (it leaks the keystream and the
// authentication key), which is why encodeStoreFile draws it internally and never takes one.
const IV_LENGTH = 12
const TAG_LENGTH = 16
const HEADER_LENGTH = MAGIC.length + IV_LENGTH + TAG_LENGTH

const KEY_LENGTH = 32

// Owner read/write only: the file holds every signed-in device's ABS chain, and it lives on a
// volume the operator may share with other containers (the TLS cert sits next to it).
const FILE_MODE = 0o600

function assertKeyLength(key: Buffer): void {
  if (key.length !== KEY_LENGTH) {
    // Unreachable through config (it validates the length), so this is a wiring bug, not an
    // operator error — but AES would otherwise fail with an opaque OpenSSL message.
    throw new SessionStoreError(`session store key must be ${KEY_LENGTH} bytes, got ${key.length}`)
  }
}

export function encodeStoreFile(key: Buffer, plaintext: Buffer): Buffer {
  assertKeyLength(key)
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(MAGIC)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext])
}

export function decodeStoreFile(key: Buffer, file: Buffer, path: string): Buffer {
  assertKeyLength(key)
  if (file.length < HEADER_LENGTH) {
    throw new SessionStoreCorruptError(path, `the file is only ${file.length} bytes, shorter than the format header`)
  }
  const magic = file.subarray(0, MAGIC.length)
  if (!magic.equals(MAGIC)) {
    throw new SessionStoreCorruptError(path, describeForeignMagic(magic))
  }
  const iv = file.subarray(MAGIC.length, MAGIC.length + IV_LENGTH)
  const tag = file.subarray(MAGIC.length + IV_LENGTH, HEADER_LENGTH)
  const ciphertext = file.subarray(HEADER_LENGTH)

  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAAD(MAGIC)
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    // GCM cannot distinguish a wrong key from a modified file — both fail the tag check.
    throw new SessionStoreKeyError(path)
  }
}

function describeForeignMagic(magic: Buffer): string {
  const text = magic.toString('ascii')
  if (text.startsWith(MAGIC_PREFIX)) {
    return `it was written in format version "${text.slice(MAGIC_PREFIX.length)}", which this build cannot read`
  }
  return 'it is not a Ratatoskr session store (unexpected file header)'
}

// Replace the store's contents without ever leaving a half-written file behind: write the
// full bytes to a sibling temp file, flush them to disk, then rename over the target. Rename
// within a directory is atomic, so a crash at any point leaves either the previous store or
// the new one — never a truncated mix, which would cost every device its session.
export async function writeFileAtomic(path: string, bytes: Buffer): Promise<void> {
  // The temp name is per-process, and no other name in the directory is ever touched. Two
  // processes sharing one name would defeat the atomic replace outright: one unlinks the name
  // the other still holds open, so a rename can publish a file its writer has not finished —
  // the exact truncated store this function exists to prevent. Distinct names degrade a second
  // writer to a lost update instead (see the single-writer note on SessionStore).
  const tmp = `${path}.${process.pid}.tmp`
  // A temp file left by an earlier crash of this process is never read (only `path` is), but it
  // may carry the wrong mode, and 'wx' below would refuse to reuse it — so drop it first.
  await rm(tmp, { force: true })
  const handle = await open(tmp, 'wx', FILE_MODE)
  try {
    await handle.writeFile(bytes)
    // Without fsync the rename can land before the data does, so a power cut would publish an
    // empty file as the current store.
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(tmp, path)
  await syncDirectory(dirname(path))
}

// Persist the rename itself. Best effort: opening a directory is POSIX-only — on Windows it
// fails outright — and a missing directory fsync costs durability only in a power cut, which
// must not turn into a failed login on a developer machine.
async function syncDirectory(path: string): Promise<void> {
  let handle
  try {
    handle = await open(path, 'r')
    await handle.sync()
  } catch {
    return
  } finally {
    await handle?.close()
  }
}
