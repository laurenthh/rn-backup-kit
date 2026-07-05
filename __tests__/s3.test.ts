import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { uploadToS3, listLatestS3Key, downloadFromS3, type S3Config } from '../src/s3'

const config: S3Config = {
  endpoint: 'https://s3.example-region.amazonaws.com',
  bucket: 'my-bucket',
  region: 'example-region',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'secretExampleKey',
}

type FetchCall = { url: string; init?: RequestInit }
let calls: FetchCall[] = []

function stubFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return Promise.resolve(impl(url, init))
    }),
  )
}

function jsonResponse(body: string, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: async () => body,
  } as Response
}

// Independently re-derives what the SigV4 signature *should* be, using
// Node's classic crypto API (createHash/createHmac) rather than Web Crypto
// — a genuinely different implementation of the same algorithm, not just a
// second call into the same code under test. This is the real correctness
// check: if src/s3.ts's port introduced a subtle bug, this would catch it
// even though a same-implementation round-trip test would not.
function sha256HexNode(data: string): string {
  return createHash('sha256').update(data).digest('hex')
}
function hmacNode(key: Buffer, message: string): Buffer {
  return createHmac('sha256', key).update(message).digest()
}
function signatureKeyNode(secretKey: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmacNode(Buffer.from('AWS4' + secretKey), dateStamp)
  const kRegion = hmacNode(kDate, region)
  const kService = hmacNode(kRegion, service)
  return hmacNode(kService, 'aws4_request')
}

function expectedSignature(args: {
  method: string
  path: string
  query: string
  amzDate: string
  dateStamp: string
  bodyHash: string
  signedHeadersStr: string
  canonicalHeaders: string
}): string {
  const credentialScope = `${args.dateStamp}/${config.region}/s3/aws4_request`
  const canonicalRequest = [
    args.method,
    args.path,
    args.query,
    args.canonicalHeaders,
    args.signedHeadersStr,
    args.bodyHash,
  ].join('\n')
  const canonicalRequestHash = sha256HexNode(canonicalRequest)
  const stringToSign = ['AWS4-HMAC-SHA256', args.amzDate, credentialScope, canonicalRequestHash].join('\n')
  const signingKey = signatureKeyNode(config.secretAccessKey, args.dateStamp, config.region, 's3')
  return hmacNode(signingKey, stringToSign).toString('hex')
}

function parseAuthHeader(auth: string): { signedHeadersStr: string; signature: string } {
  const signedHeadersMatch = auth.match(/SignedHeaders=([^,]+)/)
  const signatureMatch = auth.match(/Signature=([0-9a-f]+)/)
  return {
    signedHeadersStr: signedHeadersMatch![1]!,
    signature: signatureMatch![1]!,
  }
}

afterEach(() => {
  calls = []
  vi.unstubAllGlobals()
})

describe('uploadToS3', () => {
  it('signs a PUT request whose signature matches an independently-computed one (Node crypto)', async () => {
    stubFetch(() => jsonResponse(''))
    const body = '{"hello":"world"}'
    await uploadToS3(config, body, 'backup.json')

    expect(calls).toHaveLength(1)
    const { url, init } = calls[0]!
    expect(url).toBe('https://my-bucket.s3.example-region.amazonaws.com/backup.json')
    expect(init?.method).toBe('PUT')

    const headers = init!.headers as Record<string, string>
    const amzDate = headers['x-amz-date']!
    const dateStamp = amzDate.slice(0, 8)
    const bodyHash = sha256HexNode(body)
    expect(headers['x-amz-content-sha256']).toBe(bodyHash)

    const { signedHeadersStr, signature } = parseAuthHeader(headers.Authorization!)
    const canonicalHeaders =
      signedHeadersStr
        .split(';')
        .map((k) => {
          const headerKey = Object.keys(headers).find((h) => h.toLowerCase() === k)!
          return `${k}:${headers[headerKey]!.trim()}`
        })
        .join('\n') + '\n'

    const expected = expectedSignature({
      method: 'PUT',
      path: '/backup.json',
      query: '',
      amzDate,
      dateStamp,
      bodyHash,
      signedHeadersStr,
      canonicalHeaders,
    })
    expect(signature).toBe(expected)
  })

  it('folds pathPrefix into the uploaded key', async () => {
    stubFetch(() => jsonResponse(''))
    await uploadToS3({ ...config, pathPrefix: 'backups/nested/' }, '{}', 'backup.json')
    expect(calls[0]!.url).toBe(
      'https://my-bucket.s3.example-region.amazonaws.com/backups/nested/backup.json',
    )
  })

  it('throws with the response body on a non-ok status', async () => {
    stubFetch(() => jsonResponse('access denied', false, 403))
    await expect(uploadToS3(config, '{}', 'backup.json')).rejects.toThrow(/403.*access denied/)
  })
})

describe('listLatestS3Key', () => {
  it('signs a GET list request whose signature matches an independently-computed one', async () => {
    const xml = `<ListBucketResult><Contents><Key>backups/a-2026-01-01.json</Key></Contents></ListBucketResult>`
    stubFetch(() => jsonResponse(xml))
    await listLatestS3Key(config, 'backups/a-')

    const { url, init } = calls[0]!
    expect(url).toContain('?list-type=2&prefix=')
    expect(url).toContain(encodeURIComponent('backups/a-'))

    const headers = init!.headers as Record<string, string>
    const amzDate = headers['x-amz-date']!
    const dateStamp = amzDate.slice(0, 8)
    const emptyHash = sha256HexNode('')
    const { signedHeadersStr, signature } = parseAuthHeader(headers.Authorization!)
    const canonicalHeaders =
      signedHeadersStr
        .split(';')
        .map((k) => {
          const headerKey = Object.keys(headers).find((h) => h.toLowerCase() === k)!
          return `${k}:${headers[headerKey]!.trim()}`
        })
        .join('\n') + '\n'

    const expected = expectedSignature({
      method: 'GET',
      path: '/',
      query: `list-type=2&prefix=${encodeURIComponent('backups/a-')}`,
      amzDate,
      dateStamp,
      bodyHash: emptyHash,
      signedHeadersStr,
      canonicalHeaders,
    })
    expect(signature).toBe(expected)
  })

  it('returns the lexicographically-latest key', async () => {
    const xml = `<ListBucketResult>
      <Contents><Key>backups/x-2026-01-01.json</Key></Contents>
      <Contents><Key>backups/x-2026-06-01.json</Key></Contents>
      <Contents><Key>backups/x-2026-03-01.json</Key></Contents>
    </ListBucketResult>`
    stubFetch(() => jsonResponse(xml))
    const latest = await listLatestS3Key(config, 'backups/x-')
    expect(latest).toBe('backups/x-2026-06-01.json')
  })

  it('returns null when no objects match', async () => {
    stubFetch(() => jsonResponse('<ListBucketResult></ListBucketResult>'))
    expect(await listLatestS3Key(config, 'backups/none-')).toBeNull()
  })
})

describe('downloadFromS3', () => {
  it('downloads the exact key given, without re-applying pathPrefix', async () => {
    stubFetch(() => jsonResponse('{"restored":true}'))
    const configWithPrefix = { ...config, pathPrefix: 'backups' }
    const body = await downloadFromS3(configWithPrefix, 'backups/already-full-key.json')

    expect(body).toBe('{"restored":true}')
    expect(calls[0]!.url).toBe(
      'https://my-bucket.s3.example-region.amazonaws.com/backups/already-full-key.json',
    )
  })

  it('throws with the response body on a non-ok status', async () => {
    stubFetch(() => jsonResponse('not found', false, 404))
    await expect(downloadFromS3(config, 'missing.json')).rejects.toThrow(/404.*not found/)
  })
})
