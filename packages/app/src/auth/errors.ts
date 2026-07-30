// The bearer names no session this server holds: it was never issued, or sign-out revoked it.
// Distinct from a *missing* bearer only in wording — both mean "signed out" to a client, which is
// why the contract gives them one code (`unauthorized`). The other 401 the contract can carry,
// `UPSTREAM_SESSION_LOST`, is the opposite case (a live token over a dead upstream chain) and
// belongs to the keep-alive loop, not here.
export class UnknownTokenError extends Error {
  constructor() {
    super('This token names no session on this server')
    this.name = 'UnknownTokenError'
  }
}

// The opposite case to UnknownTokenError, and the reason the two must not share a code: the token
// is live and this server still holds its entry, but the Audiobookshelf chain behind it has died —
// contact with ABS was lost for longer than its refresh window, or the account was renamed. Only
// the password can restore it, so the client is told to re-authenticate (401
// `UPSTREAM_SESSION_LOST`) rather than that it is signed out. Rare and loud, by design: the
// keep-alive loop exists to make this the only remaining way a chain ends (SPEC section 8).
export class UpstreamSessionLostError extends Error {
  constructor() {
    super('The Audiobookshelf session behind this token has been lost')
    this.name = 'UpstreamSessionLostError'
  }
}

// Errors from the encrypted session store (SPEC section 8). All of them are fatal by design:
// the store holds every device's credentials, so the only safe reaction to a file it cannot
// read is to refuse — never to start from an empty store, which would silently sign every
// device out and drop the ABS chains that keep them signed in.
export class SessionStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'SessionStoreError'
  }
}

// The file did not authenticate under the configured key: either the key is wrong (an
// operator rotated or lost it) or the file was tampered with. AES-GCM cannot tell the two
// apart, so the message covers both and, above all, insists on data preservation.
export class SessionStoreKeyError extends SessionStoreError {
  constructor(path: string, options?: { cause?: unknown }) {
    super(
      `The session store at ${path} cannot be decrypted with the configured SESSION_STORE_KEY ` +
        '(wrong key, or the file was modified). Refusing to continue so no session data is lost: ' +
        'restore the matching key, or delete the file to sign every device out and start over.',
      options,
    )
    this.name = 'SessionStoreKeyError'
  }
}

// The file changed since this server last wrote it, so publishing our copy of the entries would
// drop whatever the other writer added. `found` is undefined when the file is gone entirely.
export class SessionStoreConflictError extends SessionStoreError {
  constructor(path: string, expected: number, found: number | undefined) {
    super(
      `The session store at ${path} changed underneath this server: it was left at revision ` +
        `${expected}, and ${found === undefined ? 'is now gone' : `is now at revision ${found}`}. ` +
        'Refusing to overwrite it. Either another process is using this store — two Ratatoskr ' +
        'instances must never share one file, each would drop the devices the other signed in, so ' +
        'give one its own SESSION_STORE_PATH — or the file was replaced by hand. This server keeps ' +
        'serving the sessions it already knows, but its view is stale until it is restarted.',
    )
    this.name = 'SessionStoreConflictError'
  }
}

// The file exists but could not be read at all (permissions, a broken mount, a directory where
// the store should be). Nothing is known about its contents, so it stays untouched.
export class SessionStoreIoError extends SessionStoreError {
  constructor(path: string, options: { cause: unknown }) {
    super(`The session store at ${path} could not be read. Refusing to continue.`, options)
    this.name = 'SessionStoreIoError'
  }
}

// The file could not be written. Separate from the read failure because the remedy is about the
// *directory*, not the file — and because this is what a mistyped SESSION_STORE_PATH or an
// unwritable volume looks like. Wrapped rather than left raw so it reaches the operator as an
// actionable line at boot (main.ts) instead of a stack trace.
export class SessionStoreWriteError extends SessionStoreError {
  constructor(path: string, options: { cause: unknown }) {
    super(
      `The session store at ${path} could not be written. Check that its directory exists and is ` +
        'writable by the user this server runs as (SESSION_STORE_PATH; in the container, the /data ' +
        'volume). Refusing to continue.',
      options,
    )
    this.name = 'SessionStoreWriteError'
  }
}

// The file is not a session store this build can read: foreign content, a truncated write,
// an unknown format version, or a payload that survived decryption but is not the expected
// shape. Distinct from SessionStoreKeyError because the remedy differs — a wrong key is
// fixable by supplying the right one, this is not.
export class SessionStoreCorruptError extends SessionStoreError {
  constructor(path: string, reason: string) {
    super(`The session store at ${path} cannot be read: ${reason}. Refusing to continue.`)
    this.name = 'SessionStoreCorruptError'
  }
}
