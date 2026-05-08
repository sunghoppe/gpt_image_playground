import { describe, expect, it } from 'vitest'
import { shouldBypassServiceWorkerCache } from './serviceWorkerCache'

describe('shouldBypassServiceWorkerCache', () => {
  it('bypasses same-origin API GET requests', () => {
    expect(shouldBypassServiceWorkerCache({ method: 'GET', url: 'https://example.com/api/auth/status' }, 'https://example.com')).toBe(true)
  })

  it('allows same-origin static GET requests to use cache', () => {
    expect(shouldBypassServiceWorkerCache({ method: 'GET', url: 'https://example.com/assets/index.js' }, 'https://example.com')).toBe(false)
  })

  it('bypasses non-GET and cross-origin requests', () => {
    expect(shouldBypassServiceWorkerCache({ method: 'POST', url: 'https://example.com/api/auth/login' }, 'https://example.com')).toBe(true)
    expect(shouldBypassServiceWorkerCache({ method: 'GET', url: 'https://cdn.example.com/assets/index.js' }, 'https://example.com')).toBe(true)
  })
})
