# ROADMAP

| ID | Title | Status | Priority | Notes |
| --- | --- | --- | --- | --- |
| 1 | Generalize BYO S3-compatible storage | Done | High | Port travel-copilot's SigV4 signing + upload/download/list into this package, parameterized/app-agnostic. Shipped as `s3.ts`, tagged `v2`. See `roadmap/completed/1-byo-s3-storage.md`. |
| 2 | File-attachment support (manifest + compression hook) | Done | High | Enumerate/upload/download/restore-path-rewrite for binary files attached to a backup snapshot. Shipped as `attachments.ts`, tagged `v2`. Adopted by gym-copilot (#200) and travel-copilot (#117). See `roadmap/completed/2-file-attachments.md`. |
| 3 | Encrypted snapshots + restore-path hardening | Done | High | Passphrase AES-256-GCM (PBKDF2) snapshot encryption in `crypto.ts`; SQL-identifier/manifest-key validation and size caps on the restore path (2026-07-06 security audit). Tag as `v3` on merge. See `roadmap/completed/3-encrypted-snapshots.md`. |
