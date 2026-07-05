import { describe, expect, it } from 'vitest'

import {
  base64ToBytes,
  bytesToBase64,
  decryptSnapshotText,
  encryptSnapshotText,
  isEncryptedSnapshot,
} from '../src/crypto'
import { serializeSnapshot } from '../src/envelope'

// Low iteration count: these tests exercise correctness of the envelope
// format and GCM behavior, not KDF hardness — production uses the default.
const FAST = { iterations: 1000 }

describe('base64 helpers', () => {
  it('round-trips arbitrary bytes at every padding length', () => {
    for (const length of [0, 1, 2, 3, 4, 5, 31, 32, 33]) {
      const bytes = new Uint8Array(length).map((_, i) => (i * 37 + length) % 256)
      expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes)
    }
  })

  it('rejects invalid base64 characters', () => {
    expect(() => base64ToBytes('ab$d')).toThrow('Invalid base64')
  })
})

describe('encryptSnapshotText / decryptSnapshotText', () => {
  it('round-trips a snapshot', async () => {
    const plaintext = serializeSnapshot({
      formatVersion: 1,
      schemaVersion: 3,
      exportedAt: '2026-07-06T00:00:00.000Z',
      tables: { Trips: [{ id: 1, name: 'Ütf-8 ✓ trip' }] },
    })
    const envelope = await encryptSnapshotText(plaintext, 'correct horse', FAST)
    const result = await decryptSnapshotText(envelope, 'correct horse')
    expect(result).toEqual({ ok: true, plaintext })
  })

  it('produces a different envelope each time (random salt/iv)', async () => {
    const a = await encryptSnapshotText('same text', 'pw', FAST)
    const b = await encryptSnapshotText('same text', 'pw', FAST)
    expect(a).not.toEqual(b)
  })

  it('fails with the wrong passphrase', async () => {
    const envelope = await encryptSnapshotText('secret', 'right', FAST)
    const result = await decryptSnapshotText(envelope, 'wrong')
    expect(result.ok).toBe(false)
  })

  it('fails on tampered ciphertext (GCM auth)', async () => {
    const envelope = JSON.parse(await encryptSnapshotText('secret', 'pw', FAST))
    const bytes = base64ToBytes(envelope.ciphertext)
    bytes[0]! ^= 0xff
    envelope.ciphertext = bytesToBase64(bytes)
    const result = await decryptSnapshotText(JSON.stringify(envelope), 'pw')
    expect(result.ok).toBe(false)
  })

  it('rejects an empty passphrase', async () => {
    await expect(encryptSnapshotText('x', '', FAST)).rejects.toThrow('passphrase')
  })

  it('rejects text that is not an envelope', async () => {
    const result = await decryptSnapshotText('{"formatVersion":1}', 'pw')
    expect(result).toEqual({ ok: false, reason: 'Not an encrypted backup envelope.' })
  })
})

describe('isEncryptedSnapshot', () => {
  it('detects an encrypted envelope', async () => {
    expect(isEncryptedSnapshot(await encryptSnapshotText('x', 'pw', FAST))).toBe(true)
  })

  it('is false for a plaintext snapshot and for junk', () => {
    const plaintext = serializeSnapshot({
      formatVersion: 1,
      schemaVersion: 1,
      exportedAt: 'now',
      tables: {},
    })
    expect(isEncryptedSnapshot(plaintext)).toBe(false)
    expect(isEncryptedSnapshot('not json')).toBe(false)
    expect(isEncryptedSnapshot('{"encryptionVersion":2}')).toBe(false)
  })
})
