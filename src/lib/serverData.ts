async function requestJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body == null ? {} : { 'Content-Type': 'application/json' }),
      ...options.headers,
    },
    credentials: 'same-origin',
    cache: 'no-store',
  })

  if (!response.ok) {
    let message = `HTTP ${response.status}`
    try {
      const payload = await response.json()
      if (payload?.error) message = payload.error
    } catch {
      /* ignore */
    }
    throw new Error(message)
  }

  return response.json() as Promise<T>
}

export function apiGet<T>(path: string): Promise<T> {
  return requestJson<T>(path)
}

export function apiPut<T>(path: string, body: unknown): Promise<T> {
  return requestJson<T>(path, { method: 'PUT', body: JSON.stringify(body) })
}

export function apiPost<T>(path: string, body: unknown): Promise<T> {
  return requestJson<T>(path, { method: 'POST', body: JSON.stringify(body) })
}

export function apiDelete<T>(path: string): Promise<T> {
  return requestJson<T>(path, { method: 'DELETE' })
}
