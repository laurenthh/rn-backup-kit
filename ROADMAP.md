# ROADMAP

| ID | Title | Status | Priority | Notes |
| --- | --- | --- | --- | --- |
| 1 | Generalize BYO S3-compatible storage | Done | High | Port travel-copilot's SigV4 signing + upload/download/list into this package, parameterized/app-agnostic. Shipped as `s3.ts`, tagged `v2`. See `roadmap/completed/1-byo-s3-storage.md`. |
| 2 | File-attachment support (manifest + compression hook) | Done | High | Enumerate/upload/download/restore-path-rewrite for binary files attached to a backup snapshot. Shipped as `attachments.ts`, tagged `v2`. Adopted by gym-copilot (#200) and travel-copilot (#117). See `roadmap/completed/2-file-attachments.md`. |
