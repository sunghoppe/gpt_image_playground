export function parsePositiveIntegerSeconds(value, fallbackSeconds) {
  const seconds = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(seconds) && seconds > 0 ? seconds : fallbackSeconds
}

export function getServerTimeouts(env = process.env) {
  const requestTimeoutSeconds = parsePositiveIntegerSeconds(env.SERVER_REQUEST_TIMEOUT_SECONDS, 900)
  const keepAliveTimeoutSeconds = parsePositiveIntegerSeconds(env.SERVER_KEEP_ALIVE_TIMEOUT_SECONDS, 5)

  return {
    requestTimeoutMs: requestTimeoutSeconds * 1000,
    headersTimeoutMs: Math.min(60, requestTimeoutSeconds) * 1000,
    keepAliveTimeoutMs: keepAliveTimeoutSeconds * 1000,
  }
}
