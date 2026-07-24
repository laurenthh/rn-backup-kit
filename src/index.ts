export {
  BACKUP_FORMAT_VERSION,
  parseSnapshot,
  serializeSnapshot,
  type BackupSnapshot,
  type ParseSnapshotResult,
} from './envelope'

export {
  exportDatabaseSnapshot,
  importDatabaseSnapshot,
  type BackupDatabase,
  type BackupTableConfig,
  type BackupTransaction,
} from './database'

export {
  uploadToS3,
  listLatestS3Key,
  downloadFromS3,
  withPathPrefix,
  type S3Config,
} from './s3'

export {
  DEFAULT_PBKDF2_ITERATIONS,
  decryptSnapshotText,
  encryptSnapshotText,
  isEncryptedSnapshot,
  type DecryptResult,
  type EncryptedEnvelope,
} from './crypto'

export {
  buildAttachmentManifest,
  uploadAttachments,
  downloadAttachments,
  type FileAttachment,
  type AttachmentManifestEntry,
  type CompressFn,
} from './attachments'
