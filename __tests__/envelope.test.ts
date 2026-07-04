import { describe, expect, it } from 'vitest'

import {
  BACKUP_FORMAT_VERSION,
  parseSnapshot,
  serializeSnapshot,
  type BackupSnapshot,
} from '../src/envelope.js'

const baseSnapshot: BackupSnapshot = {
  formatVersion: BACKUP_FORMAT_VERSION,
  schemaVersion: 1,
  exportedAt: '2026-04-22T08:55:00.000Z',
  tables: {
    Location: [{ id: 'loc-1', name: 'Snap Mirrabooka' }],
    Workout: [],
  },
}

describe('serializeSnapshot / parseSnapshot', () => {
  it('round-trips a valid snapshot', () => {
    const text = serializeSnapshot(baseSnapshot)
    const result = parseSnapshot(text)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.snapshot).toEqual(baseSnapshot)
  })

  it('rejects non-JSON input', () => {
    const result = parseSnapshot('not json')
    expect(result).toEqual({ ok: false, reason: 'File is not valid JSON.' })
  })

  it('rejects a non-object root', () => {
    const result = parseSnapshot('123')
    expect(result.ok).toBe(false)
  })

  it('rejects a missing formatVersion', () => {
    const text = JSON.stringify({ ...baseSnapshot, formatVersion: undefined })
    const result = parseSnapshot(text)
    expect(result.ok).toBe(false)
  })

  it('rejects a future formatVersion', () => {
    const text = JSON.stringify({
      ...baseSnapshot,
      formatVersion: BACKUP_FORMAT_VERSION + 5,
    })
    const result = parseSnapshot(text)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/newer/i)
  })

  it('rejects a tables value that is not a map', () => {
    const text = JSON.stringify({ ...baseSnapshot, tables: 'oops' })
    const result = parseSnapshot(text)
    expect(result.ok).toBe(false)
  })

  it('rejects rows that are not objects', () => {
    const text = JSON.stringify({
      ...baseSnapshot,
      tables: { Location: [42] },
    })
    const result = parseSnapshot(text)
    expect(result.ok).toBe(false)
  })

  it('rejects a table whose rows is not an array', () => {
    const text = JSON.stringify({
      ...baseSnapshot,
      tables: { Location: { id: 'a' } },
    })
    const result = parseSnapshot(text)
    expect(result.ok).toBe(false)
  })
})
