// Client-side snapshot encryption: passphrase → PBKDF2-SHA256 → AES-256-GCM,
// implemented with @noble/hashes + @noble/ciphers (audited, pure JS) rather
// than `crypto.subtle`: Hermes release builds ship NO global WebCrypto at
// all, so anything built on `crypto.subtle` works under Node and in dev
// debugging but throws `Property 'crypto' doesn't exist` on a real device.
// The envelope layout is unchanged (GCM auth tag appended to the
// ciphertext, exactly like WebCrypto), so envelopes produced by earlier
// builds stay decryptable.
//
// Entropy: encryption needs random salt/iv. `globalThis.crypto.getRandomValues`
// is used when present (Node, browsers); on bare Hermes the consuming app
// must install the `react-native-get-random-values` polyfill — encrypt
// throws a clear error otherwise. Decryption needs no entropy and works
// everywhere.
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

import { sha256 } from '@noble/hashes/sha2.js'
import { pbkdf2Async } from '@noble/hashes/pbkdf2.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import { gcm } from '@noble/ciphers/aes.js'
import { bytesToUtf8 } from '@noble/ciphers/utils.js'

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

function randomBytes(length: number): Uint8Array {
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto
  if (!cryptoObj?.getRandomValues) {
    throw new Error(
      'No secure random source: install the react-native-get-random-values ' +
        'polyfill (import it once at app startup) to encrypt backups on this runtime.',
    )
  }
  return cryptoObj.getRandomValues(new Uint8Array(length))
}

async function deriveAesKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  return pbkdf2Async(sha256, utf8ToBytes(passphrase), salt, {
    c: iterations,
    dkLen: 32,
  })
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
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = await deriveAesKey(passphrase, salt, iterations)
  const ciphertext = gcm(key, iv).encrypt(utf8ToBytes(plaintext))

  const envelope: EncryptedEnvelope = {
    encryptionVersion: 1,
    kdf: 'PBKDF2-SHA256',
    iterations,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertext),
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
    )
    const plaintext = gcm(key, base64ToBytes(envelope.iv)).decrypt(
      base64ToBytes(envelope.ciphertext),
    )
    return { ok: true, plaintext: bytesToUtf8(plaintext) }
  } catch {
    return {
      ok: false,
      reason: 'Decryption failed — wrong passphrase or corrupted backup.',
    }
  }
}
