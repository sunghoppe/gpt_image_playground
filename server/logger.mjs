import { randomBytes } from 'node:crypto'

export function createRequestId() {
  return randomBytes(6).toString('hex')
}

export function elapsedMs(startedAt) {
  return Date.now() - startedAt
}

export function redactUrl(value) {
  try {
    const url = new URL(value)
    url.search = ''
    return url.toString()
  } catch {
    return String(value || '')
  }
}

export function logInfo(event, data = {}) {
  console.log(JSON.stringify({ level: 'info', event, time: new Date().toISOString(), ...data }))
}

export function logError(event, data = {}) {
  console.error(JSON.stringify({ level: 'error', event, time: new Date().toISOString(), ...data }))
}
