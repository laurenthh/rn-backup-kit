# 3. Encrypted snapshots + restore-path hardening

## Summary

Two related security items, born out of the 2026-07-06 cross-repo security audit.

**Restore-path hardening.** The restore path treats a downloaded/imported backup as trusted, but it isn't: a tampered snapshot could inject SQL through column names (`INSERT INTO t (${keys})` — identifiers can't be parameterized), a tampered attachment manifest could path-traverse via keys like `../../app.bundle` handed to the caller's `writeFile`, and an oversized body could OOM the app before validation runs (the JSON analog of a 42.zip decompression bomb — no actual zip handling exists in this package, but unbounded `JSON.parse` of a downloaded body is the same failure mode). Fixed with strict identifier validation on all table/column names crossing the snapshot boundary, safe-relative-path validation on manifest keys, and byte caps on snapshot parse (`MAX_SNAPSHOT_BYTES`, 100 MB) and per-attachment download (`MAX_ATTACHMENT_BYTES`, 200 MB) — both overridable.

**Encrypted snapshots.** Snapshots sit in the user's bucket as plaintext JSON of personal data, readable by anyone with bucket access. New `src/crypto.ts` module: passphrase → PBKDF2-SHA256 (210k iterations, OWASP 2023) → AES-256-GCM, via the same Web Crypto (`crypto.subtle`) that `s3.ts` already depends on — still zero runtime dependencies (hand-rolled base64 rather than Buffer/btoa for the same reason). GCM's auth tag doubles as tamper detection: a modified ciphertext fails decryption rather than flowing into restore.

Design choices:
- **Passphrase-based, not a random device-local key**: a backup's whole job is restoring onto a *new* device, where a key that only lived in the old device's SecureStore is gone.
- **Self-describing envelope** (`kdf`, `iterations`, `salt`, `iv` all inside it): old backups stay decryptable if defaults change later.
- **`isEncryptedSnapshot(text)` detection**: consuming apps' restore paths accept both encrypted and legacy plaintext snapshots and route accordingly — no migration required, encryption is opt-in per app.
- Wrong passphrase and tampered ciphertext are deliberately indistinguishable (both are GCM auth failures).

## Shipped

- `src/crypto.ts`: `encryptSnapshotText`, `decryptSnapshotText`, `isEncryptedSnapshot`, `DEFAULT_PBKDF2_ITERATIONS`, `EncryptedEnvelope`/`DecryptResult` types, base64 helpers.
- Hardening in `src/database.ts` (identifier validation), `src/envelope.ts` (`parseSnapshot` size cap), `src/attachments.ts` (manifest-key validation, download size cap).
- Tests: crypto round-trip/wrong-passphrase/tamper/detection suite plus security regression tests for the injection, traversal, and size-cap guards.

## Consumer notes

- travel-copilot wires this in via an optional backup passphrase stored in SecureStore next to the S3 config; encrypts on upload/export when set, auto-detects on restore.
- Runtime requirement: `crypto.subtle.encrypt/decrypt/deriveKey` and `crypto.getRandomValues` must exist — same family as the SigV4 signing in `s3.ts` that already works in consuming apps, but **verify once on a real device** since PBKDF2/AES-GCM are additional SubtleCrypto surface beyond digest/HMAC.
