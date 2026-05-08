import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  createSessionCookie,
  parseCookies,
  sessionSetCookieHeader,
  verifySessionCookie,
} from '../auth.mjs'

test('signed session cookie survives in a new verifier', () => {
  const token = createSessionCookie('stable-secret', 1000)

  assert.equal(verifySessionCookie(token, 'stable-secret', 2000), true)
})

test('signed session cookie rejects tampering and wrong secrets', () => {
  const token = createSessionCookie('stable-secret', 1000)
  const [payload, signature] = token.split('.')

  assert.equal(verifySessionCookie(`${payload}.tampered-${signature}`, 'stable-secret', 2000), false)
  assert.equal(verifySessionCookie(token, 'different-secret', 2000), false)
})

test('signed session cookie expires after ttl', () => {
  const token = createSessionCookie('stable-secret', 1000)

  assert.equal(verifySessionCookie(token, 'stable-secret', 1000 + SESSION_TTL_MS + 1), false)
})

test('parseCookies reads encoded session cookie from request header', () => {
  const token = createSessionCookie('stable-secret', 1000)
  const cookieHeader = sessionSetCookieHeader(token).split(';')[0]
  const cookies = parseCookies({ headers: { cookie: `theme=dark; ${cookieHeader}` } })

  assert.equal(cookies[SESSION_COOKIE], token)
})
