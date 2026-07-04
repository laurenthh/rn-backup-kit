import { BACKUP_FORMAT_VERSION, type BackupSnapshot } from './envelope'

/**
 * The minimal, structural subset of `expo-sqlite`'s `SQLiteDatabase` this
 * package needs. Deliberately hand-written rather than imported from
 * `expo-sqlite` directly: when this package is installed as a `file:`/git
 * dependency alongside a consumer that has its own separate `expo-sqlite`
 * install, TypeScript treats the two copies' `SQLiteDatabase` as distinct
 * nominal types (private fields on `SQLiteStatement` break structural
 * equality across installs) — importing the real type here would make every
 * consumer's actual `SQLiteDatabase` fail to satisfy `BackupDatabase`. A
 * plain structural type has no such identity, so any real `SQLiteDatabase`
 * (from any copy of the package) satisfies it.
 */
export type BackupTransaction = {
  execAsync: (sql: string) => Promise<unknown>
  runAsync: (
    sql: string,
    params: (string | number | null)[],
  ) => Promise<unknown>
}

export type BackupDatabase = {
  execAsync: (sql: string) => Promise<unknown>
  getAllAsync: <T>(sql: string) => Promise<T[]>
  runAsync: (
    sql: string,
    params: (string | number | null)[],
  ) => Promise<unknown>
  withExclusiveTransactionAsync: (
    task: (txn: BackupTransaction) => Promise<void>,
  ) => Promise<void>
}

export type BackupTableConfig = {
  /** Database handle to read/write. */
  database: BackupDatabase
  /**
   * Every table to include, in *parent → child* order so bulk INSERTs during
   * a restore satisfy foreign-key constraints. Wipes happen in the reverse
   * order. Keep in sync with the consuming app's schema.
   */
  tables: readonly string[]
  /**
   * Setting keys whose values are sensitive credentials and must never leave
   * the device through a backup. Rows with one of these keys are redacted
   * from `redactTable` during export, and ignored during import (so a
   * hand-crafted snapshot cannot push a foreign token onto the device).
   */
  secretSettingKeys?: readonly string[]
  /** Table the `secretSettingKeys` redaction applies to. Defaults to `'Settings'`. */
  redactTable?: string
}

const isSecretSettingsRow = (
  row: Record<string, unknown>,
  secretKeySet: Set<string>,
): boolean => {
  const key = row.key
  return typeof key === 'string' && secretKeySet.has(key)
}

export const exportDatabaseSnapshot = async (
  config: BackupTableConfig & { schemaVersion: number },
): Promise<BackupSnapshot> => {
  const {
    database,
    tables,
    secretSettingKeys = [],
    redactTable = 'Settings',
    schemaVersion,
  } = config
  const secretKeySet = new Set(secretSettingKeys)

  const result: Record<string, Record<string, unknown>[]> = {}
  for (const tableName of tables) {
    const rows = await database.getAllAsync<Record<string, unknown>>(
      `SELECT * FROM ${tableName}`,
    )
    result[tableName] =
      tableName === redactTable
        ? rows.filter((row) => !isSecretSettingsRow(row, secretKeySet))
        : rows
  }

  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion,
    exportedAt: new Date().toISOString(),
    tables: result,
  }
}

export const importDatabaseSnapshot = async (
  config: BackupTableConfig & { snapshot: BackupSnapshot },
): Promise<void> => {
  const {
    database,
    tables,
    secretSettingKeys = [],
    redactTable = 'Settings',
    snapshot,
  } = config
  const secretKeySet = new Set(secretSettingKeys)

  await database.execAsync('PRAGMA foreign_keys = OFF;')
  try {
    await database.withExclusiveTransactionAsync(async (txn) => {
      for (const tableName of [...tables].reverse()) {
        await txn.execAsync(`DELETE FROM ${tableName};`)
      }

      for (const tableName of tables) {
        const rawRows = snapshot.tables[tableName] ?? []
        const rows =
          tableName === redactTable
            ? rawRows.filter((row) => !isSecretSettingsRow(row, secretKeySet))
            : rawRows
        if (rows.length === 0) {
          continue
        }

        const columnNames = Object.keys(rows[0]!)
        if (columnNames.length === 0) {
          continue
        }
        const placeholders = columnNames.map(() => '?').join(', ')
        const sql = `INSERT INTO ${tableName} (${columnNames.join(
          ', ',
        )}) VALUES (${placeholders})`

        for (const row of rows) {
          const values = columnNames.map((name) =>
            row[name] === undefined ? null : row[name],
          ) as (string | number | null)[]
          await txn.runAsync(sql, values)
        }
      }
    })
  } finally {
    await database.execAsync('PRAGMA foreign_keys = ON;')
  }
}
