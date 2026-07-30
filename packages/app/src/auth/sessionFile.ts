import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmod, open, rename, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { SessionStoreCorruptError, SessionStoreError, SessionStoreKeyError, SessionStoreWriteError } from './errors.js'

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
  } catch (cause) {
    // GCM cannot distinguish a wrong key from a modified file — both fail the tag check. The
    // underlying tag-check failure is kept as the cause so the log still shows what actually threw.
    throw new SessionStoreKeyError(path, { cause })
  }
}

function describeForeignMagic(magic: Buffer): string {
  const text = magic.toString('ascii')
  if (text.startsWith(MAGIC_PREFIX)) {
    return `it was written in format version "${text.slice(MAGIC_PREFIX.length)}", which this build cannot read`
  }
  return 'it is not a Ratatoskr session store (unexpected file header)'
}

// The mode heal (ADR-0003): FILE_MODE is a standing invariant, not a creation-time property, so
// opening a pre-existing store re-asserts it — a restore (cp, or tar without -p) silently leaves
// the live store at the umask, and until the next mutation rewrote it nothing would have noticed.
// Heal and warn, never block: the exposure is ciphertext (the key is never on this volume), and
// refusing to boot would hit hardest on exactly the restore that causes this.
export async function healStoreFileMode(path: string, warn: (message: string) => void): Promise<void> {
  // File modes are a POSIX concept. Windows ignores the mode argument on creation and mirrors the
  // owner bits onto group/other, so the check below would cry wolf on every boot there.
  if (process.platform === 'win32') return
  let mode: number
  try {
    mode = (await stat(path)).mode & 0o777
  } catch {
    // The file is gone (or unreadable) — nothing left to heal; whoever reads it next reports it.
    return
  }
  // Only group/other bits are a leak. A narrower mode (0400) exposes nothing and stays the
  // operator's business: the atomic replace never opens this file for writing anyway.
  if ((mode & 0o077) === 0) return
  const octal = `0${mode.toString(8)}`
  try {
    await chmod(path, FILE_MODE)
    warn(`session store ${path} was readable by group/others (mode ${octal}); restored mode 0600`)
  } catch (cause) {
    // Classic cause: a root-driven restore left the file owned by root, and chmod is the owner's
    // privilege. Still not worth blocking boot — the next mutation republishes the store as a
    // fresh 0600 file owned by this server, which also heals the ownership.
    warn(
      `session store ${path} is readable by group/others (mode ${octal}), and mode 0600 could not ` +
        `be restored (${(cause as Error).message}); restore its owner and mode 0600 by hand`,
    )
  }
}

// Replace the store's contents without ever leaving a half-written file behind: write the
// full bytes to a sibling temp file, flush them to disk, then rename over the target. Rename
// within a directory is atomic, so a crash at any point leaves either the previous store or
// the new one — never a truncated mix, which would cost every device its session.
//
// Every failure here is wrapped, for the reason on SessionStoreWriteError.
export async function writeFileAtomic(path: string, bytes: Buffer): Promise<void> {
  try {
    await writeAndPublish(path, bytes)
  } catch (cause) {
    throw new SessionStoreWriteError(path, { cause })
  }
}

async function writeAndPublish(path: string, bytes: Buffer): Promise<void> {
  // A temp name unique to THIS write, so no other writer's name is ever touched. Unique per write,
  // not per process: two containers sharing one /data volume both run as PID 1, so a process-id
  // suffix would not tell them apart — and two writers on one temp name defeat the atomic replace
  // outright, one unlinking or overwriting the name the other still holds open, publishing a file
  // its writer has not finished. The random suffix gives every writer its own name, so a concurrent
  // writer degrades to a lost update (caught by the store's revision check) rather than a torn file.
  // The name cannot pre-exist, so 'wx' never collides and there is nothing to remove first; a temp
  // left by a crash between here and the rename is a rare, tiny orphan that is never read (only
  // `path` is) — not worth a directory sweep that could race another writer's in-flight temp.
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
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
