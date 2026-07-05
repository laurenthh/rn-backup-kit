import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  buildAttachmentManifest,
  uploadAttachments,
  downloadAttachments,
  type FileAttachment,
} from '../src/attachments'
import type { S3Config } from '../src/s3'

const s3: S3Config = {
  endpoint: 'https://s3.example-region.amazonaws.com',
  bucket: 'my-bucket',
  region: 'example-region',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'secret',
}

function stubFetch(impl: (url: string) => Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => Promise.resolve(impl(url))),
  )
}

afterEach(() => vi.unstubAllGlobals())

describe('buildAttachmentManifest', () => {
  it('assigns deterministic keys from table/rowId/column, preserving the file extension', () => {
    const attachments: FileAttachment[] = [
      { table: 'Equipment', rowId: 1, column: 'thumbnailUri', localUri: 'file:///a/thumb.jpg' },
      { table: 'documents', rowId: 'doc-42', column: 'file_uri', localUri: 'file:///b/receipt.pdf' },
    ]
    const manifest = buildAttachmentManifest(attachments, { keyPrefix: 'attachments' })

    expect(manifest).toEqual([
      {
        table: 'Equipment',
        rowId: 1,
        column: 'thumbnailUri',
        key: 'attachments/Equipment-1-thumbnailUri.jpg',
        originalName: 'thumb.jpg',
      },
      {
        table: 'documents',
        rowId: 'doc-42',
        column: 'file_uri',
        key: 'attachments/documents-doc-42-file_uri.pdf',
        originalName: 'receipt.pdf',
      },
    ])
  })

  it('strips trailing slashes from keyPrefix', () => {
    const manifest = buildAttachmentManifest(
      [{ table: 'T', rowId: 1, column: 'c', localUri: 'x.png' }],
      { keyPrefix: 'attachments///' },
    )
    expect(manifest[0]!.key).toBe('attachments/T-1-c.png')
  })
})

describe('uploadAttachments', () => {
  it('uploads each attachment to its manifest key, without compression when none is given', async () => {
    const puts: { url: string; body: string }[] = []
    stubFetch((url) => {
      puts.push({ url, body: '' })
      return { ok: true, status: 200, text: async () => '' } as Response
    })

    const attachments: FileAttachment[] = [
      { table: 'Equipment', rowId: 1, column: 'thumbnailUri', localUri: 'file:///thumb.jpg' },
    ]
    const manifest = buildAttachmentManifest(attachments, { keyPrefix: 'attachments' })
    const readFile = vi.fn(async (uri: string) => `bytes-of(${uri})`)

    await uploadAttachments({ attachments, manifest, s3, readFile })

    expect(readFile).toHaveBeenCalledWith('file:///thumb.jpg')
    expect(puts).toHaveLength(1)
    expect(puts[0]!.url).toContain('attachments/Equipment-1-thumbnailUri.jpg')
  })

  it('runs the compress function and uploads its result, then calls cleanup', async () => {
    stubFetch(() => ({ ok: true, status: 200, text: async () => '' }) as Response)

    const attachments: FileAttachment[] = [
      { table: 'documents', rowId: 1, column: 'file_uri', localUri: 'file:///original.jpg', mimeType: 'image/jpeg' },
    ]
    const manifest = buildAttachmentManifest(attachments, { keyPrefix: 'attachments' })
    const cleanup = vi.fn(async () => {})
    const compress = vi.fn(async (uri: string) => ({ uri: `${uri}.compressed`, cleanup }))
    const readFile = vi.fn(async (uri: string) => `bytes-of(${uri})`)

    await uploadAttachments({ attachments, manifest, s3, compress, readFile })

    expect(compress).toHaveBeenCalledWith('file:///original.jpg', 'image/jpeg')
    expect(readFile).toHaveBeenCalledWith('file:///original.jpg.compressed')
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('calls cleanup even if the upload itself fails', async () => {
    stubFetch(() => ({ ok: false, status: 500, text: async () => 'boom' }) as Response)

    const attachments: FileAttachment[] = [
      { table: 'documents', rowId: 1, column: 'file_uri', localUri: 'file:///a.jpg' },
    ]
    const manifest = buildAttachmentManifest(attachments, { keyPrefix: 'attachments' })
    const cleanup = vi.fn(async () => {})
    const compress = vi.fn(async (uri: string) => ({ uri, cleanup }))

    await expect(
      uploadAttachments({ attachments, manifest, s3, compress, readFile: async () => 'x' }),
    ).rejects.toThrow(/500/)
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('passes a file through unchanged when compress returns the same uri (the "do not compress" case)', async () => {
    stubFetch(() => ({ ok: true, status: 200, text: async () => '' }) as Response)

    const attachments: FileAttachment[] = [
      { table: 'documents', rowId: 1, column: 'file_uri', localUri: 'file:///a.pdf', mimeType: 'application/pdf' },
    ]
    const manifest = buildAttachmentManifest(attachments, { keyPrefix: 'attachments' })
    const readFile = vi.fn(async (uri: string) => `bytes-of(${uri})`)
    // A realistic compress() that only compresses images, passing PDFs through.
    const compress = async (uri: string, mimeType?: string) =>
      mimeType?.startsWith('image/') ? { uri: `${uri}.compressed`, cleanup: async () => {} } : { uri }

    await uploadAttachments({ attachments, manifest, s3, compress, readFile })
    expect(readFile).toHaveBeenCalledWith('file:///a.pdf')
  })
})

describe('downloadAttachments', () => {
  it('downloads each manifest key (resolved against pathPrefix) and returns a key→newUri map', async () => {
    const s3WithPrefix: S3Config = { ...s3, pathPrefix: 'backups' }
    const gets: string[] = []
    stubFetch((url) => {
      gets.push(url)
      return { ok: true, status: 200, text: async () => 'file-bytes' } as Response
    })

    const manifest = buildAttachmentManifest(
      [{ table: 'Equipment', rowId: 1, column: 'thumbnailUri', localUri: 'thumb.jpg' }],
      { keyPrefix: 'attachments' },
    )
    const writeFile = vi.fn(async (key: string) => `file:///new/${key.split('/').pop()}`)

    const result = await downloadAttachments({ manifest, s3: s3WithPrefix, writeFile })

    // uploadToS3 would have stored this under backups/attachments/... — download must look there too.
    expect(gets[0]).toContain('backups/attachments/Equipment-1-thumbnailUri.jpg')
    expect(writeFile).toHaveBeenCalledWith('attachments/Equipment-1-thumbnailUri.jpg', 'file-bytes')
    expect(result.get('attachments/Equipment-1-thumbnailUri.jpg')).toBe(
      'file:///new/Equipment-1-thumbnailUri.jpg',
    )
  })
})

describe('downloadAttachments hardening', () => {
  it('rejects manifest keys with path traversal segments', async () => {
    stubFetch(() => new Response('data'))
    await expect(
      downloadAttachments({
        manifest: [
          {
            table: 'documents',
            rowId: 1,
            column: 'file_uri',
            key: 'attachments/../../app.bundle',
          },
        ],
        s3,
        writeFile: async () => 'file:///should-not-be-called',
      }),
    ).rejects.toThrow('Unsafe attachment key')
  })

  it('rejects oversized attachment bodies before writeFile', async () => {
    stubFetch(() => new Response('x'.repeat(64)))
    await expect(
      downloadAttachments({
        manifest: [
          { table: 'documents', rowId: 1, column: 'file_uri', key: 'attachments/doc.pdf' },
        ],
        s3,
        writeFile: async () => 'file:///should-not-be-called',
        maxBytesPerAttachment: 16,
      }),
    ).rejects.toThrow('too large')
  })
})
