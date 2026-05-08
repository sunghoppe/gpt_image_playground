import test from 'node:test'
import assert from 'node:assert/strict'
import { getServerTimeouts, parsePositiveIntegerSeconds } from '../httpConfig.mjs'

test('parsePositiveIntegerSeconds uses fallback for invalid values', () => {
  assert.equal(parsePositiveIntegerSeconds('', 900), 900)
  assert.equal(parsePositiveIntegerSeconds('0', 900), 900)
  assert.equal(parsePositiveIntegerSeconds('-1', 900), 900)
  assert.equal(parsePositiveIntegerSeconds('abc', 900), 900)
})

test('parsePositiveIntegerSeconds accepts positive integer values', () => {
  assert.equal(parsePositiveIntegerSeconds('600', 900), 600)
})

test('getServerTimeouts defaults to long image-generation request timeout', () => {
  assert.deepEqual(getServerTimeouts({}), {
    requestTimeoutMs: 900000,
    headersTimeoutMs: 60000,
    keepAliveTimeoutMs: 5000,
  })
})

test('getServerTimeouts reads request timeout from environment', () => {
  assert.deepEqual(getServerTimeouts({ SERVER_REQUEST_TIMEOUT_SECONDS: '1200', SERVER_KEEP_ALIVE_TIMEOUT_SECONDS: '10' }), {
    requestTimeoutMs: 1200000,
    headersTimeoutMs: 60000,
    keepAliveTimeoutMs: 10000,
  })
})
