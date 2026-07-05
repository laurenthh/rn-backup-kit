// BYO S3-compatible cloud backup: AWS Signature V4 request signing (Web
// Crypto, no AWS SDK dependency) plus upload/list-latest/download. Works
// against any S3-compatible endpoint (AWS S3, DigitalOcean Spaces, MinIO,
// Cloudflare R2) using credentials the caller supplies and stores
// themselves — this package never sees or stores credentials beyond the
// single call it's given them for.
//
// Ported from travel-copilot's services/backup.ts, which had this working
// and tested for three near-identical request types (PUT, LIST, GET) with
// the whole signing dance duplicated three times. Deduplicated into one
// signS3Request() here since there's no reason to port the duplication too.

export type S3Config = {
  endpoint: string
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  pathPrefix?: string
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  // Uint8Array's `buffer` is typed as ArrayBufferLike (which includes
  // SharedArrayBuffer), but BufferSource requires a plain ArrayBuffer —
  // a real Uint8Array from TextEncoder is always backed by one at runtime,
  // this is purely a type-strictness mismatch in lib.dom.d.ts.
  const hash = await crypto.subtle.digest('SHA-256', data as BufferSource)
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function hmacSha256(key: ArrayBuffer, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message))
}

async function hmacSha256Hex(key: ArrayBuffer, message: string): Promise<string> {
  const sig = await hmacSha256(key, message)
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function getSignatureKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<ArrayBuffer> {
  const kDate = await hmacSha256(
    new TextEncoder().encode('AWS4' + secretKey).buffer as ArrayBuffer,
    dateStamp,
  )
  const kRegion = await hmacSha256(kDate, region)
  const kService = await hmacSha256(kRegion, service)
  return hmacSha256(kService, 'aws4_request')
}

function joinCanonicalHeaders(headers: Record<string, string>): {
  signedHeadersStr: string
  canonicalHeaders: string
} {
  const signedHeaderKeys = Object.keys(headers)
    .map((k) => k.toLowerCase())
    .sort()
  const signedHeadersStr = signedHeaderKeys.join(';')
  const canonicalHeaders =
    signedHeaderKeys
      .map((k) => `${k}:${headers[Object.keys(headers).find((h) => h.toLowerCase() === k)!]!.trim()}`)
      .join('\n') + '\n'
  return { signedHeadersStr, canonicalHeaders }
}

/**
 * Signs one S3 request (PUT upload, or the GET used for both listing and
 * downloading). `path` must start with `/` and be the exact path used in
 * both the canonical request and the actual URL — for LIST requests this is
 * `/` with the query string carrying `list-type=2&prefix=...`; for GET/PUT
 * on a specific object it's `/${key}`.
 */
async function signS3Request(
  config: S3Config,
  args: {
    method: 'GET' | 'PUT'
    path: string
    query?: string
    bodyHash: string
    includeContentType?: boolean
  },
): Promise<{ url: string; headers: Record<string, string> }> {
  const host = config.endpoint.replace(/^https?:\/\//, '')
  const vhostBase = config.endpoint.replace(/\/+$/, '').replace('://', `://${config.bucket}.`)

  const now = new Date()
  const dateStamp = now.toISOString().replace(/[-:]/g, '').slice(0, 8)
  const amzDate = dateStamp + 'T' + now.toISOString().replace(/[-:]/g, '').slice(9, 15) + 'Z'
  const credentialScope = `${dateStamp}/${config.region}/s3/aws4_request`

  const headers: Record<string, string> = {
    Host: `${config.bucket}.${host}`,
    'x-amz-content-sha256': args.bodyHash,
    'x-amz-date': amzDate,
  }
  if (args.includeContentType) {
    headers['Content-Type'] = 'application/json'
  }

  const { signedHeadersStr, canonicalHeaders } = joinCanonicalHeaders(headers)

  const canonicalRequest = [
    args.method,
    args.path,
    args.query ?? '',
    canonicalHeaders,
    signedHeadersStr,
    args.bodyHash,
  ].join('\n')

  const canonicalRequestHash = await sha256Hex(new TextEncoder().encode(canonicalRequest))
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, canonicalRequestHash].join('\n')
  const signingKey = await getSignatureKey(config.secretAccessKey, dateStamp, config.region, 's3')
  const signature = await hmacSha256Hex(signingKey, stringToSign)
  const authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeadersStr}, Signature=${signature}`

  const url = args.query ? `${vhostBase}${args.path}?${args.query}` : `${vhostBase}${args.path}`

  return { url, headers: { ...headers, Authorization: authorization } }
}

/**
 * Resolves a bare key against `config.pathPrefix`, the same way `uploadToS3`
 * does internally. Exported so callers that need to predict or replicate the
 * actual stored object key — e.g. `downloadAttachments`, which calls
 * `downloadFromS3` directly rather than through `uploadToS3`/`listLatestS3Key`
 * — stay consistent with where `uploadToS3` actually put the object.
 * `downloadFromS3`/`listLatestS3Key` deliberately do NOT apply this
 * themselves: `listLatestS3Key`'s result is already a full key straight from
 * S3's own listing, and re-folding a prefix into an already-full key would
 * double it.
 */
export function withPathPrefix(config: S3Config, key: string): string {
  return config.pathPrefix ? `${config.pathPrefix.replace(/\/+$/, '')}/${key}` : key
}

/** Signs and uploads `body` to `key` (joined with `config.pathPrefix` if set). */
export async function uploadToS3(config: S3Config, body: string, key: string): Promise<void> {
  const fullKey = withPathPrefix(config, key)
  const bodyHash = await sha256Hex(new TextEncoder().encode(body))
  const { url, headers } = await signS3Request(config, {
    method: 'PUT',
    path: `/${fullKey}`,
    bodyHash,
    includeContentType: true,
  })

  const response = await fetch(url, { method: 'PUT', headers, body })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`S3 upload failed (${response.status}): ${text}`)
  }
}

/**
 * Lists objects under `keyPrefix` (joined with `config.pathPrefix` if set)
 * and returns the lexicographically-latest full key, or `null` if none
 * exist. Lexicographic ordering matches upload keys built from an ISO-ish
 * timestamp string, so "latest" here means "most recently uploaded" as long
 * as callers name their keys that way (as this package's own backup-file
 * naming does).
 */
export async function listLatestS3Key(config: S3Config, keyPrefix: string): Promise<string | null> {
  const fullPrefix = withPathPrefix(config, keyPrefix)
  const emptyHash = await sha256Hex(new TextEncoder().encode(''))
  const query = `list-type=2&prefix=${encodeURIComponent(fullPrefix)}`
  const { url, headers } = await signS3Request(config, {
    method: 'GET',
    path: '/',
    query,
    bodyHash: emptyHash,
  })

  const response = await fetch(url, { headers })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`S3 list failed (${response.status}): ${text}`)
  }

  const xml = await response.text()
  const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)]
    .map((m) => m[1])
    .filter((k): k is string => k != null)
    .sort()

  return keys.length > 0 ? keys[keys.length - 1]! : null
}

/** Downloads and returns the text body of `key` (already a full key, e.g. from {@link listLatestS3Key}). */
export async function downloadFromS3(config: S3Config, key: string): Promise<string> {
  const emptyHash = await sha256Hex(new TextEncoder().encode(''))
  const { url, headers } = await signS3Request(config, {
    method: 'GET',
    path: `/${key}`,
    bodyHash: emptyHash,
  })

  const response = await fetch(url, { headers })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`S3 download failed (${response.status}): ${text}`)
  }
  return response.text()
}
