import { downloadFromS3, uploadToS3, withPathPrefix, type S3Config } from './s3'

// Backups only ever covered DB rows — nothing about the binary files those
// rows reference (a photo, a scanned document) was ever backed up. This
// module adds that: each attachment uploads as its own S3 object, with a
// manifest recording which {table, rowId, column} each one belongs to.
//
// Kept dependency-free on purpose (per the lesson in this project's own
// history: importing a native Expo module here would break for any consumer
// with its own separate copy of that module). Actual image compression
// needs expo-image-manipulator, which this package can't and shouldn't
// depend on — compression is therefore a caller-supplied function, and
// reading/writing files locally is caller-supplied too (expo-file-system).

/** One binary file a consuming app wants backed up, referenced from one DB row/column. */
export type FileAttachment = {
  table: string
  rowId: string | number
  column: string
  localUri: string
  mimeType?: string
}

/** What actually gets written into the manifest — `key` is a bare key, resolved against `S3Config.pathPrefix` the same way `uploadToS3` resolves it internally. */
export type AttachmentManifestEntry = {
  table: string
  rowId: string | number
  column: string
  key: string
  originalName?: string
}

/**
 * Caller-supplied compression hook. Returning the same `localUri` unchanged
 * (with no `cleanup`) is a valid "don't compress this" implementation — e.g.
 * for a PDF, which can't be image-compressed. The function itself decides
 * whether an attachment is compressible (typically by checking `mimeType`);
 * this module always calls it if provided, for every attachment.
 */
export type CompressFn = (
  localUri: string,
  mimeType?: string,
) => Promise<{ uri: string; cleanup?: () => Promise<void> }>

function extensionOf(uri: string): string {
  const match = uri.match(/\.[a-zA-Z0-9]+$/)
  return match ? match[0] : ''
}

function basenameOf(uri: string): string {
  const parts = uri.split('/')
  return parts[parts.length - 1] ?? uri
}

/**
 * Pure, deterministic key assignment — no I/O. Keys are bare (not yet
 * resolved against any `S3Config.pathPrefix`); `uploadAttachments` resolves
 * them at upload time via `uploadToS3`, and `downloadAttachments` resolves
 * them the same way via `withPathPrefix` before calling `downloadFromS3`.
 */
export function buildAttachmentManifest(
  attachments: readonly FileAttachment[],
  config: { keyPrefix: string },
): AttachmentManifestEntry[] {
  const prefix = config.keyPrefix.replace(/\/+$/, '')
  return attachments.map((attachment) => ({
    table: attachment.table,
    rowId: attachment.rowId,
    column: attachment.column,
    key: `${prefix}/${attachment.table}-${attachment.rowId}-${attachment.column}${extensionOf(attachment.localUri)}`,
    originalName: basenameOf(attachment.localUri),
  }))
}

function findManifestEntry(
  manifest: readonly AttachmentManifestEntry[],
  attachment: FileAttachment,
): AttachmentManifestEntry {
  const entry = manifest.find(
    (m) => m.table === attachment.table && m.rowId === attachment.rowId && m.column === attachment.column,
  )
  if (!entry) {
    throw new Error(
      `No manifest entry for ${attachment.table}.${attachment.column} (row ${attachment.rowId}) — call buildAttachmentManifest first.`,
    )
  }
  return entry
}

/** Uploads every attachment to its manifest key, optionally compressing first. */
export async function uploadAttachments(config: {
  attachments: readonly FileAttachment[]
  manifest: readonly AttachmentManifestEntry[]
  s3: S3Config
  compress?: CompressFn
  readFile: (uri: string) => Promise<string>
}): Promise<void> {
  for (const attachment of config.attachments) {
    const entry = findManifestEntry(config.manifest, attachment)

    let uploadUri = attachment.localUri
    let cleanup: (() => Promise<void>) | undefined
    if (config.compress) {
      const compressed = await config.compress(attachment.localUri, attachment.mimeType)
      uploadUri = compressed.uri
      cleanup = compressed.cleanup
    }

    try {
      const data = await config.readFile(uploadUri)
      await uploadToS3(config.s3, data, entry.key)
    } finally {
      if (cleanup) {
        await cleanup()
      }
    }
  }
}

/**
 * Downloads every manifest entry and hands the bytes to the caller's
 * `writeFile`, which decides the new local path on this device and returns
 * its URI. Returns a map of manifest `key` → new local URI — the caller
 * uses this to rewrite the corresponding DB rows' URI columns. This module
 * never touches a database; it only orchestrates file transfer.
 */
// Manifest keys arrive from a downloaded backup — untrusted input — and get
// handed to the caller's `writeFile`, which typically derives a local file
// path from them. A tampered manifest with a key like `../../app.bundle`
// could escape the caller's attachment directory. Reject anything that isn't
// a plain relative key of safe path segments.
function assertSafeManifestKey(key: string): void {
  const segments = key.split('/')
  const ok =
    key.length > 0 &&
    !key.startsWith('/') &&
    !key.includes('\\') &&
    segments.every((s) => s.length > 0 && s !== '.' && s !== '..' && !/[\x00-\x1f]/.test(s))
  if (!ok) {
    throw new Error(`Unsafe attachment key in manifest: ${JSON.stringify(key)}`)
  }
}

// Same rationale as envelope.ts's MAX_SNAPSHOT_BYTES: a legitimate
// attachment is a compressed photo or a document, well under this; a
// tampered bucket could serve an arbitrarily large body and OOM the app.
export const MAX_ATTACHMENT_BYTES = 200 * 1024 * 1024

export async function downloadAttachments(config: {
  manifest: readonly AttachmentManifestEntry[]
  s3: S3Config
  writeFile: (key: string, data: string) => Promise<string>
  maxBytesPerAttachment?: number
}): Promise<Map<string, string>> {
  const maxBytes = config.maxBytesPerAttachment ?? MAX_ATTACHMENT_BYTES
  const result = new Map<string, string>()
  for (const entry of config.manifest) {
    assertSafeManifestKey(entry.key)
    const fullKey = withPathPrefix(config.s3, entry.key)
    const data = await downloadFromS3(config.s3, fullKey)
    if (data.length > maxBytes) {
      throw new Error(
        `Attachment ${entry.key} is too large (over ${Math.round(maxBytes / (1024 * 1024))} MB).`,
      )
    }
    const newUri = await config.writeFile(entry.key, data)
    result.set(entry.key, newUri)
  }
  return result
}
