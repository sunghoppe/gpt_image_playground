import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
