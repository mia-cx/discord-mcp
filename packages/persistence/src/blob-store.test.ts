import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BlobError, BlobStore } from './blob-store.js'
import { Database } from './database.js'

describe('content-addressed blob store', () => {
  const temporary: Array<string> = []

  afterEach(async () => {
    await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  })

  const setup = async () => {
    const root = await mkdtemp(join(tmpdir(), 'discord-mcp-blobs-'))
    temporary.push(root)
    const database = new Database(':memory:')
    database.migrate()
    database.run(
      'INSERT INTO principals(id, name, kind, created_at) VALUES (?, ?, ?, ?)',
      'owner',
      'Owner',
      'local',
      new Date().toISOString(),
    )
    return { database, store: new BlobStore(database, root) }
  }

  it('stores bounded inline bytes and only exposes metadata publicly', async () => {
    const { database, store } = await setup()
    const metadata = await store.putInline({
      ownerPrincipalId: 'owner',
      filename: 'release notes.txt',
      mimeType: 'text/plain',
      base64: Buffer.from('hello').toString('base64'),
    })
    expect(metadata.id).toMatch(/^[a-f0-9]{64}$/)
    expect(metadata.filename).toBe('release_notes.txt')
    expect(store.getMetadata(metadata.id, 'owner')).toEqual(metadata)
    expect((await store.readForDiscord(metadata.id)).toString()).toBe('hello')
    await store.delete(metadata.id, 'owner')
    expect(() => store.getMetadata(metadata.id, 'owner')).toThrow(BlobError)
    database.close()
  })

  it('rejects invalid data, MIME types, and cross-principal reads', async () => {
    const { database, store } = await setup()
    await expect(
      store.putInline({
        ownerPrincipalId: 'owner',
        filename: 'x.exe',
        mimeType: 'application/x-msdownload',
        base64: Buffer.from('x').toString('base64'),
      }),
    ).rejects.toThrow(/MIME/)
    const metadata = await store.putInline({
      ownerPrincipalId: 'owner',
      filename: 'x.txt',
      mimeType: 'text/plain',
      base64: Buffer.from('x').toString('base64'),
    })
    expect(() => store.getMetadata(metadata.id, 'other')).toThrow(/another principal/)
    database.close()
  })
})
