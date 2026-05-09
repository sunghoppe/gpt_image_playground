import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequestId, redactUrl } from '../logger.mjs'

test('redactUrl removes query strings from upstream URLs', () => {
  assert.equal(
    redactUrl('https://example.openai.azure.com/openai/deployments/d/images/generations?api-version=2025-04-01-preview'),
    'https://example.openai.azure.com/openai/deployments/d/images/generations',
  )
})

test('createRequestId returns compact unique ids', () => {
  const first = createRequestId()
  const second = createRequestId()

  assert.match(first, /^[a-f0-9]{12}$/)
  assert.notEqual(first, second)
})
