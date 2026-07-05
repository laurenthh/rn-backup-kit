# 1. Generalize BYO S3-compatible storage

## Summary

travel-copilot's `services/backup.ts` has a working, tested implementation of BYO S3-compatible cloud backup: AWS Signature V4 request signing (via Web Crypto, no AWS SDK dependency), upload (`PUT`), list-latest (`GET ?list-type=2`), and download (`GET`). It works against any S3-compatible endpoint (AWS S3, DigitalOcean Spaces, MinIO, Cloudflare R2) using credentials the user supplies and stores themselves (`expo-secure-store`) — no backend the developer runs or pays for, consistent with this whole family of apps' "local-first, no backend" principle.

This item ports that logic into `rn-backup-kit`, parameterized so any consuming app can offer the same off-device backup option without re-implementing SigV4 signing from scratch. This is the foundation `roadmap/2-file-attachments.md` builds on (file attachments need somewhere to actually upload to).

## Scope

- New module in `rn-backup-kit` (e.g. `src/s3.ts`) exporting:
  - `type S3Config = { endpoint: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string; pathPrefix?: string }`
  - `uploadToS3(config: S3Config, body: string, key: string): Promise<void>` — signs and PUTs. Generalizes travel-copilot's `uploadBackupToS3`, but takes an explicit `key` instead of hardcoding a `travel-log-backup-`-style filename prefix — callers decide their own naming.
  - `listLatestS3Key(config: S3Config, keyPrefix: string): Promise<string | null>` — lists objects under a prefix, returns the lexicographically-latest key (or null if none). Splits travel-copilot's combined "list + download + restore" `downloadLatestFromS3` into its list-only half, since restoring is a separate concern from finding the file.
  - `downloadFromS3(config: S3Config, key: string): Promise<string>` — GETs and returns the body as text. The other half of the split above.
  - The SigV4 helpers (`sha256Hex`, `hmacSha256`, `hmacSha256Hex`, `getSignatureKey`) move over as internal (non-exported) functions — they're pure Web-Crypto logic, no Expo/RN-specific APIs, so they port verbatim.
- Own test suite: sign a known request and check the canonical request/signature against a hand-computed expected value (at least one golden-value test, not just round-trip mocking), plus upload/list/download against a stubbed `fetch`.
- **Not in scope for this item**: file-attachment orchestration (that's #2), and travel-copilot's own migration to call this instead of its local copy (that's a separate app-level item, tracked once #1 and #2 both exist).

## Planned tasks

1. Port the SigV4 signing helpers verbatim into `src/s3.ts` (no behavior change, same algorithm).
2. Implement `uploadToS3`/`listLatestS3Key`/`downloadFromS3` with the split/parameterized shape above.
3. Add `src/s3.ts` exports to `src/index.ts`.
4. Write tests: at least one golden-value SigV4 signature test (sign a fixed request with fixed fake credentials/date, assert the exact expected `Authorization` header — catches any subtle porting bug the mocked-fetch tests wouldn't), plus stubbed-fetch tests for upload/list/download success and failure paths (network error, non-2xx, empty bucket).
5. Verify: `npm run typecheck`, `npm test`, `npm run build`.
6. Commit, push, PR, merge.
