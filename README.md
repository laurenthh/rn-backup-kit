# rn-backup-kit

Shared backup/restore module for Expo/SQLite React Native apps: a portable JSON envelope format plus parameterized export/import against a `expo-sqlite` database.

Extracted from `gym-copilot` and `chef-copilot`, whose backup logic was found byte-identical in the envelope layer and structurally identical in the SQLite export/import layer — this package is that logic, parameterized by each app's own table list and secret-setting keys instead of hardcoding them.

## Install

Not published to a registry — install as a git dependency:

```json
{
  "dependencies": {
    "rn-backup-kit": "github:laurenthh/rn-backup-kit#v1"
  }
}
```

## Usage

```ts
import {
  exportDatabaseSnapshot,
  importDatabaseSnapshot,
  serializeSnapshot,
  parseSnapshot,
} from 'rn-backup-kit'

const BACKUP_TABLES = ['Location', 'Equipment', 'Workout' /* ...parent → child order */] as const
const BACKUP_SECRET_SETTING_KEYS = ['myAppToken'] as const

// Export
const snapshot = await exportDatabaseSnapshot({
  database: db,
  tables: BACKUP_TABLES,
  secretSettingKeys: BACKUP_SECRET_SETTING_KEYS,
  schemaVersion: MY_SCHEMA_VERSION,
})
const fileContents = serializeSnapshot(snapshot)

// Import
const parsed = parseSnapshot(fileContents)
if (parsed.ok) {
  await importDatabaseSnapshot({
    database: db,
    tables: BACKUP_TABLES,
    secretSettingKeys: BACKUP_SECRET_SETTING_KEYS,
    snapshot: parsed.snapshot,
  })
}
```

`tables` must be listed in *parent → child* order so bulk inserts during a restore satisfy foreign-key constraints; wipes run in the reverse order automatically. `secretSettingKeys` + `redactTable` (defaults to `'Settings'`) control which rows get redacted on export and rejected on import — use this for any credential/token a backup file must never carry.

## Not included

- No validation beyond structural checks (JSON shape, required envelope fields, row/array shapes) — this is a direct port of what `gym-copilot`/`chef-copilot` already had, not a new design. A future revision could tighten this with schema validation (Zod) if a consuming app needs stronger guarantees on untrusted backup files.
- No adapter for envelope shapes that don't match the generic `{ formatVersion, schemaVersion, exportedAt, tables }` structure — `travel-log`'s S3-based backup format is different and would need its own adapter, not a drop-in use of this package.
