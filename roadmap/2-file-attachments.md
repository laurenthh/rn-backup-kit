# 2. File-attachment support (manifest + compression hook)

## Summary

Backups today only cover structured DB rows — nothing about the binary files those rows reference (equipment photos in gym-copilot, trip highlight photos/documents in travel-copilot) is ever backed up. This item adds that capability: a manifest-based scheme where each attached file uploads as its own object (alongside the main JSON snapshot), with the JSON manifest recording which `{table, rowId, column}` each file belongs to.

Depends on `roadmap/1-byo-s3-storage.md` (needs somewhere to actually upload files to). This package stays storage-agnostic beyond S3 conceptually, but S3 is the only real transport implemented right now, so this item's upload/download calls into `1`'s functions directly rather than inventing a second abstraction layer prematurely.

Keeps `rn-backup-kit` dependency-free (per [[Decisions]] ADR-012's lesson): actual image compression needs `expo-image-manipulator`, a native Expo module this package can't and shouldn't depend on. Compression is therefore a **caller-supplied function**, not something this package does itself — this package only orchestrates enumerate → optionally compress (via the caller's function) → upload → write manifest → (on restore) download → hand the bytes back to the caller to re-save at whatever local path makes sense on the new device.

## Scope

- New module (e.g. `src/attachments.ts`) exporting:
  - `type FileAttachment = { table: string; rowId: string | number; column: string; localUri: string; mimeType?: string }` — describes one file a consuming app wants backed up. The caller builds this list themselves (walking their own exported snapshot + schema knowledge of which columns hold file URIs) — this package has no idea what a "table" or "column" means beyond these being opaque strings it round-trips into the manifest.
  - `type AttachmentManifestEntry = { table: string; rowId: string | number; column: string; key: string; originalName?: string }` — what actually gets written into the manifest (the `key` being the file's identifier in whatever storage backend, e.g. an S3 key).
  - `type CompressFn = (localUri: string, mimeType?: string) => Promise<{ uri: string; cleanup?: () => Promise<void> }>` — caller-supplied. Returning the same `localUri` unchanged (with no `cleanup`) is a valid "don't compress this" implementation, e.g. for PDFs.
  - `buildAttachmentManifest(attachments: FileAttachment[], config: { keyPrefix: string }): AttachmentManifestEntry[]` — pure, deterministic key assignment (e.g. `${keyPrefix}/${table}-${rowId}-${column}${ext}`), no I/O.
  - `uploadAttachments(config: { attachments: FileAttachment[]; manifest: AttachmentManifestEntry[]; s3: S3Config; compress?: CompressFn; readFile: (uri: string) => Promise<string /* base64 or binary-safe string */> }): Promise<void>` — for each attachment: optionally compress (if `compress` provided and the attachment is compressible), read the file, upload to its manifest key. Calls into `1`'s `uploadToS3`. `readFile` is caller-supplied too (this package has no `expo-file-system` dependency either) — likely just `FileSystem.readAsStringAsync(uri, {encoding: 'base64'})` in practice.
  - `downloadAttachments(config: { manifest: AttachmentManifestEntry[]; s3: S3Config; writeFile: (key: string, data: string) => Promise<string /* returns the new local URI */> }): Promise<Map<string, string>>` — downloads each manifest entry, hands the bytes to the caller's `writeFile` (which decides the new local path on this device), returns a map of manifest `key` → new local URI. **The caller is responsible for using this map to rewrite the corresponding DB rows' URI columns** — this package doesn't touch a database, only orchestrates file transfer.
- Tests: `buildAttachmentManifest`'s key-assignment logic (pure, easy), and `uploadAttachments`/`downloadAttachments` with fake in-memory `compress`/`readFile`/`writeFile` implementations (no real filesystem/network needed, same testing philosophy as the rest of this package).
- **Not in scope**: any actual app wiring (gym-copilot's/travel-copilot's own items cover that) — this item only builds the reusable capability.

## Planned tasks

1. Implement `buildAttachmentManifest` (pure key-assignment).
2. Implement `uploadAttachments`/`downloadAttachments`, calling into `1`'s S3 functions.
3. Export from `src/index.ts`.
4. Tests with fake compress/readFile/writeFile functions covering: compression applied when provided, skipped when not, manifest round-trips correctly, download map correctly associates each entry's new URI.
5. Verify: `npm run typecheck`, `npm test`, `npm run build`.
6. Commit, push, PR, merge.
