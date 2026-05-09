import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { createDataStore, maskSecret } from '../storage.mjs'

test('maskSecret keeps only the last four characters', () => {
  assert.equal(maskSecret('sk-1234567890abcdef'), '••••••••••••cdef')
  assert.equal(maskSecret('abc'), '••••')
  assert.equal(maskSecret(''), '')
})

test('settings API stores apiKey encrypted and returns only masked key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gpt-image-store-'))
  try {
    const store = await createDataStore({ dataDir: dir, secret: 'test-secret' })
    await store.updateSettings({
      apiProvider: 'azure',
      baseUrl: 'https://example.openai.azure.com',
      apiKey: 'secret-api-key-1234',
      model: 'gpt-image-deployment',
      azureApiVersion: '2025-04-01-preview',
      timeout: 300,
      apiMode: 'images',
      codexCli: false,
    })

    const publicSettings = await store.getPublicSettings()
    assert.equal(publicSettings.apiKey, '')
    assert.equal(publicSettings.hasApiKey, true)
    assert.equal(publicSettings.apiKeyMasked, '••••••••••••1234')

    const privateSettings = await store.getPrivateSettings()
    assert.equal(privateSettings.apiKey, 'secret-api-key-1234')

    const raw = await store.readRawState()
    assert.equal(raw.settings.apiKey, undefined)
    assert.notEqual(raw.secrets.apiKeyCiphertext, 'secret-api-key-1234')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('settings timeout below the default is upgraded for long image requests', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gpt-image-store-'))
  try {
    await writeFile(join(dir, 'state.json'), JSON.stringify({
      version: 1,
      settings: { timeout: 300 },
      params: {},
      tasks: [],
      images: {},
      secrets: {},
    }))
    const store = await createDataStore({ dataDir: dir, secret: 'test-secret' })

    const settings = await store.getPublicSettings()

    assert.equal(settings.timeout, 900)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})


async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

test('deleteImage removes image metadata and file from disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gpt-image-store-'))
  try {
    const store = await createDataStore({ dataDir: dir, secret: 'test-secret' })
    const source = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 4,
        background: { r: 220, g: 80, b: 80, alpha: 1 },
      },
    }).png().toBuffer()
    await store.putImage({ id: 'image-delete-test', dataUrl: `data:image/png;base64,${source.toString('base64')}`, source: 'generated' })
    const image = await store.getImage('image-delete-test')
    const filePath = join(dir, image.filePath)
    const thumbnailPath = join(dir, image.thumbnailPath)
    const previewPath = join(dir, image.previewPath)
    assert.equal(await exists(filePath), true)
    assert.equal(await exists(thumbnailPath), true)
    assert.equal(await exists(previewPath), true)

    await store.deleteImage('image-delete-test')

    assert.equal(await store.getImage('image-delete-test'), undefined)
    assert.equal(await exists(filePath), false)
    assert.equal(await exists(thumbnailPath), false)
    assert.equal(await exists(previewPath), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('putImage creates thumbnail and preview variants', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gpt-image-store-'))
  try {
    const store = await createDataStore({ dataDir: dir, secret: 'test-secret' })
    const source = await sharp({
      create: {
        width: 2000,
        height: 1000,
        channels: 4,
        background: { r: 60, g: 120, b: 180, alpha: 1 },
      },
    }).png().toBuffer()
    await store.putImage({ id: 'image-variant-test', dataUrl: `data:image/png;base64,${source.toString('base64')}`, source: 'generated' })

    const image = await store.getImage('image-variant-test')
    assert.equal(await exists(join(dir, image.filePath)), true)
    assert.equal(await exists(join(dir, image.thumbnailPath)), true)
    assert.equal(await exists(join(dir, image.previewPath)), true)

    const original = await store.getImageContent('image-variant-test')
    const thumbnail = await store.getImageVariantContent('image-variant-test', 'thumbnail')
    const preview = await store.getImageVariantContent('image-variant-test', 'preview')
    const thumbnailMeta = await sharp(thumbnail.bytes).metadata()
    const previewMeta = await sharp(preview.bytes).metadata()

    assert.equal(original.mime, 'image/png')
    assert.equal(thumbnail.mime, 'image/webp')
    assert.equal(preview.mime, 'image/webp')
    assert.equal(thumbnailMeta.width, 480)
    assert.equal(previewMeta.width, 1600)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('updateTask patches an existing task without replacing other fields', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gpt-image-store-'))
  try {
    const store = await createDataStore({ dataDir: dir, secret: 'test-secret' })
    const task = {
      id: 'task-update-test',
      prompt: 'prompt',
      params: {},
      inputImageIds: [],
      maskTargetImageId: null,
      maskImageId: null,
      outputImages: [],
      status: 'running',
      error: null,
      createdAt: 1,
      finishedAt: null,
      elapsed: null,
    }
    await store.putTask(task)

    const updated = await store.updateTask(task.id, { status: 'error', error: 'failed', finishedAt: 2 })

    assert.equal(updated.prompt, 'prompt')
    assert.equal(updated.status, 'error')
    assert.equal(updated.error, 'failed')
    assert.equal((await store.getTask(task.id)).finishedAt, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('markRunningTasksAsError changes only running tasks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gpt-image-store-'))
  try {
    const store = await createDataStore({ dataDir: dir, secret: 'test-secret' })
    await store.putTask({
      id: 'task-running', prompt: 'running', params: {}, inputImageIds: [], maskTargetImageId: null, maskImageId: null,
      outputImages: [], status: 'running', error: null, createdAt: 1, finishedAt: null, elapsed: null,
    })
    await store.putTask({
      id: 'task-done', prompt: 'done', params: {}, inputImageIds: [], maskTargetImageId: null, maskImageId: null,
      outputImages: [], status: 'done', error: null, createdAt: 1, finishedAt: 2, elapsed: 1,
    })

    await store.markRunningTasksAsError('interrupted')

    assert.equal((await store.getTask('task-running')).status, 'error')
    assert.equal((await store.getTask('task-running')).error, 'interrupted')
    assert.equal((await store.getTask('task-done')).status, 'done')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('clearImages removes all image files from disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gpt-image-store-'))
  try {
    const store = await createDataStore({ dataDir: dir, secret: 'test-secret' })
    await store.putImage({ id: 'image-clear-a', dataUrl: 'data:image/png;base64,YQ==', source: 'generated' })
    await store.putImage({ id: 'image-clear-b', dataUrl: 'data:image/png;base64,Yg==', source: 'generated' })
    const imageA = await store.getImage('image-clear-a')
    const imageB = await store.getImage('image-clear-b')
    const fileA = join(dir, imageA.filePath)
    const fileB = join(dir, imageB.filePath)
    assert.equal(await exists(fileA), true)
    assert.equal(await exists(fileB), true)

    await store.clearImages()

    assert.deepEqual(await store.getAllImages(), [])
    assert.equal(await exists(fileA), false)
    assert.equal(await exists(fileB), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})


test('concurrent image writes do not conflict on state temp file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gpt-image-store-'))
  try {
    const store = await createDataStore({ dataDir: dir, secret: 'test-secret' })
    await Promise.all(
      Array.from({ length: 20 }).map((_, index) =>
        store.putImage({
          id: `concurrent-image-${index}`,
          dataUrl: `data:image/png;base64,${Buffer.from(`image-${index}`).toString('base64')}`,
          source: 'generated',
        }),
      ),
    )
    const images = await store.getAllImages()
    assert.equal(images.length, 20)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
