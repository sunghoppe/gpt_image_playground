export function shouldBypassServiceWorkerCache(request: Pick<Request, 'method' | 'url'>, origin: string): boolean {
  if (request.method !== 'GET') return true

  const url = new URL(request.url)
  if (url.origin !== origin) return true

  return url.pathname.startsWith('/api/')
}
