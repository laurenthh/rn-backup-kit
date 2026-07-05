// Client-side snapshot encryption: passphrase → PBKDF2-SHA256 → AES-256-GCM,
// via the same Web Crypto (`crypto.subtle`) that s3.ts already depends on.
// Snapshots otherwise sit in the bucket as plaintext JSON of personal data,
// readable by anyone with bucket access; GCM's auth tag also makes tampering
// detectable, so a modified ciphertext fails decryption instead of flowing
// into the restore path.
//
// Passphrase-based on purpose (not a random device-local key): a backup's
// whole job is restoring onto a *new* device, where a key that only ever
// lived in the old device's SecureStore is gone. The envelope is
// self-describing (kdf, iterations, salt, iv all inside it) so old backups
// stay decryptable if defaults change later.

/** On-the-wire shape of an encrypted backup file. */
export type EncryptedEnvelope = {
  encryptionVersion: 1
  kdf: 'PBKDF2-SHA256'
  iterations: number
  /** base64 */
  salt: string
  /** base64 */
  iv: string
  /** base64 AES-GCM ciphertext (auth tag appended, per WebCrypto) */
  ciphertext: string
}

export type DecryptResult =
  | { ok: true; plaintext: string }
  | { ok: false; reason: string }

/** OWASP 2023 guidance for PBKDF2-HMAC-SHA256. */
export const DEFAULT_PBKDF2_ITERATIONS = 210_000

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// Hand-rolled base64 rather than Buffer/btoa: Buffer is Node-only and
// btoa/atob aren't guaranteed on every React Native runtime this package
// supports, while this stays dependency-free.
export function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0
    out += BASE64_ALPHABET[b0 >> 2]!
    out += BASE64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)]!
    out += i + 1 < bytes.length ? BASE64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)]! : '='
    out += i + 2 < bytes.length ? BASE64_ALPHABET[b2 & 0x3f]! : '='
  }
  return out
}

export function base64ToBytes(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let outIndex = 0
  let buffer = 0
  let bits = 0
  for (const char of clean) {
    const value = BASE64_ALPHABET.indexOf(char)
    if (value === -1) {
      throw new Error('Invalid base64 in encrypted backup.')
    }
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[outIndex++] = (buffer >> bits) & 0xff
    }
  }
  return out
}

async function deriveAesKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
  usage: 'encrypt' | 'decrypt',
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase) as BufferSource,
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  )
}

/** Encrypts `plaintext` under `passphrase`; returns the serialized envelope (safe to upload as-is). */
export async function encryptSnapshotText(
  plaintext: string,
  passphrase: string,
  options?: { iterations?: number },
): Promise<string> {
  if (passphrase.length === 0) {
    throw new Error('Encryption passphrase must not be empty.')
  }
  const iterations = options?.iterations ?? DEFAULT_PBKDF2_ITERATIONS
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveAesKey(passphrase, salt, iterations, 'encrypt')
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plaintext) as BufferSource,
  )

  const envelope: EncryptedEnvelope = {
    encryptionVersion: 1,
    kdf: 'PBKDF2-SHA256',
    iterations,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  }
  return JSON.stringify(envelope)
}

/**
 * True if `text` parses as an {@link EncryptedEnvelope} — lets a restore path
 * accept both encrypted and legacy plaintext snapshots and route accordingly.
 */
export function isEncryptedSnapshot(text: string): boolean {
  return parseEnvelope(text) !== null
}

function parseEnvelope(text: string): EncryptedEnvelope | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') {
    return null
  }
  const candidate = parsed as Record<string, unknown>
  if (
    candidate.encryptionVersion !== 1 ||
    candidate.kdf !== 'PBKDF2-SHA256' ||
    typeof candidate.iterations !== 'number' ||
    !Number.isInteger(candidate.iterations) ||
    candidate.iterations < 1 ||
    typeof candidate.salt !== 'string' ||
    typeof candidate.iv !== 'string' ||
    typeof candidate.ciphertext !== 'string'
  ) {
    return null
  }
  return candidate as EncryptedEnvelope
}

/**
 * Decrypts a serialized envelope produced by {@link encryptSnapshotText}.
 * A wrong passphrase and a tampered ciphertext are indistinguishable by
 * design (GCM auth failure), so both come back as the same `ok: false`.
 */
export async function decryptSnapshotText(
  envelopeText: string,
  passphrase: string,
): Promise<DecryptResult> {
  const envelope = parseEnvelope(envelopeText)
  if (!envelope) {
    return { ok: false, reason: 'Not an encrypted backup envelope.' }
  }
  try {
    const key = await deriveAesKey(
      passphrase,
      base64ToBytes(envelope.salt),
      envelope.iterations,
      'decrypt',
    )
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(envelope.iv) as BufferSource },
      key,
      base64ToBytes(envelope.ciphertext) as BufferSource,
    )
    return { ok: true, plaintext: new TextDecoder().decode(plaintext) }
  } catch {
    return {
      ok: false,
      reason: 'Decryption failed — wrong passphrase or corrupted backup.',
    }
  }
}
