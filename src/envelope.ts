export const BACKUP_FORMAT_VERSION = 1

export type BackupSnapshot = {
  formatVersion: number
  schemaVersion: number
  exportedAt: string
  tables: Record<string, Record<string, unknown>[]>
}

export type ParseSnapshotResult =
  | { ok: true; snapshot: BackupSnapshot }
  | { ok: false; reason: string }

export const serializeSnapshot = (snapshot: BackupSnapshot): string => {
  return JSON.stringify(snapshot, null, 2)
}

export const parseSnapshot = (jsonText: string): ParseSnapshotResult => {
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return { ok: false, reason: 'File is not valid JSON.' }
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, reason: 'Backup root must be an object.' }
  }

  const candidate = parsed as Record<string, unknown>
  const formatVersion = candidate.formatVersion
  if (
    typeof formatVersion !== 'number' ||
    !Number.isInteger(formatVersion) ||
    formatVersion < 1
  ) {
    return { ok: false, reason: 'Missing or invalid formatVersion.' }
  }
  if (formatVersion > BACKUP_FORMAT_VERSION) {
    return {
      ok: false,
      reason: `Backup format ${formatVersion} is newer than this app supports.`,
    }
  }

  const schemaVersion = candidate.schemaVersion
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)) {
    return { ok: false, reason: 'Missing or invalid schemaVersion.' }
  }

  const exportedAt = candidate.exportedAt
  if (typeof exportedAt !== 'string') {
    return { ok: false, reason: 'Missing or invalid exportedAt.' }
  }

  const tablesValue = candidate.tables
  if (!tablesValue || typeof tablesValue !== 'object') {
    return { ok: false, reason: 'Missing or invalid tables map.' }
  }

  const tables: Record<string, Record<string, unknown>[]> = {}
  for (const [tableName, rows] of Object.entries(
    tablesValue as Record<string, unknown>,
  )) {
    if (!Array.isArray(rows)) {
      return {
        ok: false,
        reason: `Table "${tableName}" must be an array of rows.`,
      }
    }

    const normalizedRows: Record<string, unknown>[] = []
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        return {
          ok: false,
          reason: `Table "${tableName}" contains a non-object row.`,
        }
      }
      normalizedRows.push(row as Record<string, unknown>)
    }
    tables[tableName] = normalizedRows
  }

  return {
    ok: true,
    snapshot: {
      formatVersion,
      schemaVersion,
      exportedAt,
      tables,
    },
  }
}
