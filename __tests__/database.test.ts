import { describe, expect, it } from 'vitest'

import {
  exportDatabaseSnapshot,
  importDatabaseSnapshot,
  type BackupDatabase,
  type BackupSnapshot,
} from '../src/index.js'

const TEST_TABLES = ['Location', 'Equipment', 'Workout', 'Settings'] as const
const TEST_SECRET_KEYS = ['copilotToken'] as const

type Row = Record<string, unknown>

const createMockBackupDatabase = (seed: Record<string, Row[]> = {}) => {
  const tables: Record<string, Row[]> = {}
  for (const name of TEST_TABLES) {
    tables[name] = seed[name] ? seed[name].map((row) => ({ ...row })) : []
  }
  let foreignKeysOn = true

  const runStatement = (sql: string, params: readonly unknown[] = []) => {
    const trimmed = sql.trim().replace(/;\s*$/, '')

    const insertMatch = trimmed.match(
      /^INSERT INTO (\w+) \(([^)]+)\) VALUES \(([^)]+)\)$/i,
    )
    if (insertMatch) {
      const [, tableName, columnsList] = insertMatch
      const columns = columnsList!.split(',').map((column) => column.trim())
      const row: Row = {}
      columns.forEach((column, index) => {
        row[column] = params[index]
      })
      ;(tables[tableName!] ??= []).push(row)
      return
    }

    const deleteMatch = trimmed.match(/^DELETE FROM (\w+)$/i)
    if (deleteMatch) {
      tables[deleteMatch[1]!] = []
      return
    }

    const pragmaMatch = trimmed.match(/^PRAGMA foreign_keys = (ON|OFF)$/i)
    if (pragmaMatch) {
      foreignKeysOn = pragmaMatch[1]!.toUpperCase() === 'ON'
      return
    }

    throw new Error(`Unhandled SQL in mock: ${trimmed}`)
  }

  const txn = {
    execAsync: async (sql: string) => runStatement(sql),
    runAsync: async (sql: string, params: readonly unknown[] = []) => {
      runStatement(sql, params)
      return { lastInsertRowId: 0, changes: 0 }
    },
  }

  const database = {
    execAsync: async (sql: string) => runStatement(sql),
    getAllAsync: async <T>(sql: string) => {
      const match = sql.trim().match(/^SELECT \* FROM (\w+)$/i)
      if (!match) {
        throw new Error(`Unhandled SELECT in mock: ${sql}`)
      }
      return (tables[match[1]!] ?? []).map((row) => ({ ...row })) as T[]
    },
    runAsync: txn.runAsync,
    withExclusiveTransactionAsync: async (
      work: (txnArg: typeof txn) => Promise<void>,
    ) => {
      await work(txn)
    },
  } as unknown as BackupDatabase

  return {
    database,
    getTables: () => tables,
    getForeignKeysState: () => foreignKeysOn,
  }
}

const doExport = (database: BackupDatabase) =>
  exportDatabaseSnapshot({
    database,
    tables: TEST_TABLES,
    secretSettingKeys: TEST_SECRET_KEYS,
    schemaVersion: 1,
  })

const doImport = (database: BackupDatabase, snapshot: BackupSnapshot) =>
  importDatabaseSnapshot({
    database,
    tables: TEST_TABLES,
    secretSettingKeys: TEST_SECRET_KEYS,
    snapshot,
  })

describe('exportDatabaseSnapshot', () => {
  it('captures every configured table', async () => {
    const { database } = createMockBackupDatabase({
      Location: [{ id: 'loc-1', name: 'Snap Mirrabooka' }],
      Workout: [{ id: 'workout-1', locationId: 'loc-1' }],
    })

    const snapshot = await doExport(database)

    expect(snapshot.formatVersion).toBe(1)
    expect(snapshot.exportedAt).toMatch(/Z$/)
    for (const tableName of TEST_TABLES) {
      expect(snapshot.tables[tableName]).toBeDefined()
    }
    expect(snapshot.tables.Location).toEqual([
      { id: 'loc-1', name: 'Snap Mirrabooka' },
    ])
  })
})

describe('importDatabaseSnapshot', () => {
  it('replaces existing rows with the snapshot contents', async () => {
    const { database, getTables, getForeignKeysState } =
      createMockBackupDatabase({
        Location: [{ id: 'loc-stale', name: 'Stale' }],
        Equipment: [{ id: 'eq-stale', locationId: 'loc-stale' }],
      })

    const snapshot = await doExport(
      createMockBackupDatabase({
        Location: [{ id: 'loc-1', name: 'Snap Mirrabooka' }],
        Equipment: [{ id: 'eq-1', locationId: 'loc-1' }],
      }).database,
    )

    await doImport(database, snapshot)

    const tables = getTables()
    expect(tables.Location).toEqual([{ id: 'loc-1', name: 'Snap Mirrabooka' }])
    expect(tables.Equipment).toEqual([{ id: 'eq-1', locationId: 'loc-1' }])
    expect(getForeignKeysState()).toBe(true)
  })

  it('round-trips an export → import cycle without changes', async () => {
    const seed = {
      Location: [
        { id: 'loc-1', name: 'A' },
        { id: 'loc-2', name: 'B' },
      ],
      Workout: [{ id: 'workout-1', locationId: 'loc-1' }],
    }
    const source = createMockBackupDatabase(seed)
    const target = createMockBackupDatabase()

    const snapshot = await doExport(source.database)
    await doImport(target.database, snapshot)
    const reExported = await doExport(target.database)

    expect(reExported.tables.Location).toEqual(seed.Location)
    expect(reExported.tables.Workout).toEqual(seed.Workout)
  })

  it('strips secret Settings rows from exported snapshots', async () => {
    const { database } = createMockBackupDatabase({
      Settings: [
        { key: 'copilotToken', value: 'super-secret' },
        { key: 'themePreference', value: 'dark' },
      ],
    })

    const snapshot = await doExport(database)

    const settingsRows = snapshot.tables.Settings ?? []
    expect(settingsRows).toEqual([{ key: 'themePreference', value: 'dark' }])
    for (const secretKey of TEST_SECRET_KEYS) {
      expect(settingsRows.some((row) => row.key === secretKey)).toBe(false)
    }
  })

  it('refuses to import secret Settings rows present in a snapshot', async () => {
    const { database, getTables } = createMockBackupDatabase({
      Settings: [{ key: 'copilotToken', value: 'preserved-on-device' }],
    })

    const snapshot: BackupSnapshot = {
      formatVersion: 1,
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      tables: {
        Settings: [
          { key: 'copilotToken', value: 'attacker-supplied' },
          { key: 'themePreference', value: 'light' },
        ],
      },
    }

    await doImport(database, snapshot)

    const settingsRows = getTables().Settings ?? []
    expect(settingsRows).toEqual([{ key: 'themePreference', value: 'light' }])
    expect(settingsRows.some((row) => row.key === 'copilotToken')).toBe(false)
  })

  it('defaults redactTable to "Settings" and secretSettingKeys to none when omitted', async () => {
    const { database } = createMockBackupDatabase({
      Location: [{ id: 'loc-1', name: 'A' }],
    })

    const snapshot = await exportDatabaseSnapshot({
      database,
      tables: TEST_TABLES,
      schemaVersion: 1,
    })

    expect(snapshot.tables.Location).toEqual([{ id: 'loc-1', name: 'A' }])
  })
})
