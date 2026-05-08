import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const SESSION_COOKIE = 'gip_session'

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

function base64UrlEncode(value) {
  return Buffer.from(value).toString('base64url')
}

function base64UrlDecode(value) {
  return Buffer.from(String(value), 'base64url').toString('utf8')
}

function sign(value, secret) {
  return createHmac('sha256', String(secret)).update(value).digest('base64url')
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  return left.length === right.length && timingSafeEqual(left, right)
}

export function parseCookies(req) {
  const header = req.headers.cookie || ''
  return Object.fromEntries(header.split(';').map((part) => {
    const index = part.indexOf('=')
    if (index < 0) return ['', '']
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())]
  }).filter(([key]) => key))
}

export function createSessionCookie(secret, now = Date.now()) {
  const payload = base64UrlEncode(JSON.stringify({
    expiresAt: now + SESSION_TTL_MS,
    nonce: randomBytes(16).toString('base64url'),
  }))
  return `${payload}.${sign(payload, secret)}`
}

export function verifySessionCookie(token, secret, now = Date.now()) {
  if (!token) return false
  const [payload, signature] = String(token).split('.')
  if (!payload || !signature || !safeEqual(signature, sign(payload, secret))) return false

  try {
    const session = JSON.parse(base64UrlDecode(payload))
    return Number(session.expiresAt) > now
  } catch {
    return false
  }
}

export function sessionSetCookieHeader(token) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`
}

export function sessionClearCookieHeader() {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
}

export function safeCompare(a, b) {
  return safeEqual(a, b)
}
