import { createServer } from 'node:http'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import { createDataStore } from './storage.mjs'
import { getServerTimeouts } from './httpConfig.mjs'
import { createRequestId, elapsedMs, logError, logInfo, redactUrl } from './logger.mjs'
import {
  SESSION_COOKIE,
  createSessionCookie,
  parseCookies,
  safeCompare,
  sessionClearCookieHeader,
  sessionSetCookieHeader,
  verifySessionCookie,
} from './auth.mjs'

const PORT = Number(process.env.PORT || 3000)
const DATA_DIR = process.env.DATA_DIR || '/data'
const PUBLIC_DIR = process.env.PUBLIC_DIR || join(process.cwd(), 'dist')
const APP_LOGIN_KEY = process.env.APP_LOGIN_KEY || ''
const APP_SECRET = process.env.APP_SECRET || APP_LOGIN_KEY || 'gpt-image-playground-dev-secret'
const SERVER_TIMEOUTS = getServerTimeouts()

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
}

await mkdir(DATA_DIR, { recursive: true })
const store = await createDataStore({ dataDir: DATA_DIR, secret: APP_SECRET })


function normalizeBaseUrl(baseUrl) {
  const trimmed = String(baseUrl || '').trim()
  if (!trimmed) return ''
  const input = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`
  const url = new URL(input)
  const pathSegments = url.pathname.split('/').filter(Boolean)
  const v1Index = pathSegments.indexOf('v1')
  const normalizedSegments = v1Index >= 0
    ? pathSegments.slice(0, v1Index + 1)
    : pathSegments.length
      ? [...pathSegments, 'v1']
      : []
  const pathname = normalizedSegments.length ? `/${normalizedSegments.join('/')}` : ''
  return `${url.origin}${pathname}`
}

function normalizeAzureResourceUrl(baseUrl) {
  const trimmed = String(baseUrl || '').trim()
  if (!trimmed) return ''
  const input = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`
  return new URL(input).origin
}

function buildUpstreamUrl(settings, path) {
  const endpointPath = path.replace(/^\/+/, '')
  if (settings.apiProvider === 'azure') {
    const resourceUrl = normalizeAzureResourceUrl(settings.baseUrl)
    const deployment = encodeURIComponent(String(settings.model || '').trim())
    const query = new URLSearchParams({ 'api-version': settings.azureApiVersion || '2025-04-01-preview' })
    return `${resourceUrl}/openai/deployments/${deployment}/${endpointPath}?${query}`
  }

  const baseUrl = normalizeBaseUrl(settings.baseUrl)
  const apiPath = baseUrl.endsWith('/v1') ? endpointPath : `v1/${endpointPath}`
  return `${baseUrl}/${apiPath}`
}

async function proxyOpenAI(req, res, path) {
  const settings = await store.getPrivateSettings()
  if (!settings.apiKey) return sendError(res, 400, '请先配置 API Key')

  const headers = {
    'Cache-Control': 'no-store, no-cache, max-age=0',
    Pragma: 'no-cache',
  }
  if (settings.apiProvider === 'azure') headers['api-key'] = settings.apiKey
  else headers.Authorization = `Bearer ${settings.apiKey}`

  const contentType = req.headers['content-type']
  if (contentType) headers['Content-Type'] = contentType

  let upstream
  const startedAt = Date.now()
  const upstreamUrl = buildUpstreamUrl(settings, path)
  const requestId = req.requestId || createRequestId()
  logInfo('openai.upstream.start', {
    requestId,
    method: req.method,
    path,
    provider: settings.apiProvider,
    apiMode: settings.apiMode,
    model: settings.model,
    upstreamUrl: redactUrl(upstreamUrl),
    contentType: contentType || null,
    contentLength: req.headers['content-length'] || null,
  })
  try {
    upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req,
      duplex: 'half',
    })
  } catch (error) {
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000)
    logError('openai.upstream.error', {
      requestId,
      path,
      provider: settings.apiProvider,
      upstreamUrl: redactUrl(upstreamUrl),
      elapsedSeconds,
      message: error instanceof Error ? error.message : String(error),
    })
    return sendError(res, 504, `上游 API 请求失败或超时，请检查 API 地址、网络连通性和反代超时配置（已等待 ${elapsedSeconds} 秒）`)
  }

  logInfo('openai.upstream.response', {
    requestId,
    path,
    provider: settings.apiProvider,
    status: upstream.status,
    elapsedMs: elapsedMs(startedAt),
    contentType: upstream.headers.get('content-type') || null,
  })

  res.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  if (upstream.body) {
    for await (const chunk of upstream.body) res.write(chunk)
  }
  res.end()
  logInfo('openai.proxy.complete', {
    requestId,
    path,
    status: upstream.status,
    elapsedMs: elapsedMs(startedAt),
  })
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message })
}

function isAuthenticated(req) {
  if (!APP_LOGIN_KEY) return true
  const token = parseCookies(req)[SESSION_COOKIE]
  return verifySessionCookie(token, APP_SECRET)
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1024 * 1024 * 1024) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : {}
}

function createSession(res) {
  res.setHeader('Set-Cookie', sessionSetCookieHeader(createSessionCookie(APP_SECRET)))
}

function clearSession(req, res) {
  res.setHeader('Set-Cookie', sessionClearCookieHeader())
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/auth/status' && req.method === 'GET') {
    return sendJson(res, 200, { authenticated: isAuthenticated(req), authRequired: Boolean(APP_LOGIN_KEY) })
  }

  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    if (!APP_LOGIN_KEY) return sendJson(res, 200, { authenticated: true })
    const body = await readJson(req)
    if (!safeCompare(body.key || '', APP_LOGIN_KEY)) return sendError(res, 401, '登录密钥错误')
    createSession(res)
    return sendJson(res, 200, { authenticated: true })
  }

  if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
    clearSession(req, res)
    return sendJson(res, 200, { authenticated: false })
  }

  if (!isAuthenticated(req)) return sendError(res, 401, '请先登录')

  if (url.pathname.startsWith('/api/openai/')) {
    return proxyOpenAI(req, res, url.pathname.replace('/api/openai/', ''))
  }

  if (url.pathname === '/api/bootstrap' && req.method === 'GET') {
    return sendJson(res, 200, await store.getBootstrap())
  }

  if (url.pathname === '/api/settings' && req.method === 'GET') {
    return sendJson(res, 200, await store.getPublicSettings())
  }

  if (url.pathname === '/api/settings' && req.method === 'PUT') {
    return sendJson(res, 200, await store.updateSettings(await readJson(req)))
  }

  if (url.pathname === '/api/params' && req.method === 'PUT') {
    const state = await store.updateParams(await readJson(req))
    return sendJson(res, 200, state.params)
  }

  if (url.pathname === '/api/dismissed-codex-cli-prompts' && req.method === 'PUT') {
    const body = await readJson(req)
    const state = await store.updateDismissedCodexCliPrompts(body.values)
    return sendJson(res, 200, state.dismissedCodexCliPrompts)
  }

  if (url.pathname === '/api/tasks' && req.method === 'GET') {
    const limit = url.searchParams.get('limit')
    const offset = url.searchParams.get('offset')
    const q = url.searchParams.get('q') || ''
    const status = url.searchParams.get('status') || 'all'
    const favorite = url.searchParams.get('favorite') === 'true'
    if (limit !== null || offset !== null || q || status !== 'all' || favorite) {
      return sendJson(res, 200, await store.getPagedTasks({ limit, offset, q, status, favorite }))
    }
    return sendJson(res, 200, await store.getAllTasks())
  }

  if (url.pathname === '/api/tasks' && req.method === 'DELETE') {
    await store.clearTasks()
    return sendJson(res, 200, { ok: true })
  }

  const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/)
  if (taskMatch && req.method === 'PUT') {
    const task = await readJson(req)
    task.id = decodeURIComponent(taskMatch[1])
    await store.putTask(task)
    return sendJson(res, 200, { id: task.id })
  }

  if (taskMatch && req.method === 'DELETE') {
    await store.deleteTask(decodeURIComponent(taskMatch[1]))
    return sendJson(res, 200, { ok: true })
  }

  if (url.pathname === '/api/images' && req.method === 'GET') {
    return sendJson(res, 200, await store.getAllImages())
  }

  if (url.pathname === '/api/images' && req.method === 'DELETE') {
    await store.clearImages()
    return sendJson(res, 200, { ok: true })
  }

  const imageContentMatch = url.pathname.match(/^\/api\/images\/([^/]+)\/content$/)
  if (imageContentMatch && req.method === 'GET') {
    const content = await store.getImageContent(decodeURIComponent(imageContentMatch[1]))
    if (!content) return sendError(res, 404, '图片不存在')
    res.writeHead(200, {
      'Content-Type': content.mime,
      'Content-Length': content.size,
      'Cache-Control': 'public, max-age=31536000, immutable',
    })
    res.end(content.bytes)
    return
  }

  const imageMatch = url.pathname.match(/^\/api\/images\/([^/]+)$/)
  if (imageMatch && req.method === 'GET') {
    const image = await store.getImage(decodeURIComponent(imageMatch[1]))
    if (!image) return sendError(res, 404, '图片不存在')
    const { dataUrl, ...publicImage } = image
    return sendJson(res, 200, publicImage)
  }

  if (imageMatch && req.method === 'PUT') {
    const image = await readJson(req)
    image.id = decodeURIComponent(imageMatch[1])
    await store.putImage(image)
    return sendJson(res, 200, { id: image.id })
  }

  if (imageMatch && req.method === 'DELETE') {
    await store.deleteImage(decodeURIComponent(imageMatch[1]))
    return sendJson(res, 200, { ok: true })
  }

  return sendError(res, 404, '接口不存在')
}

function serveStatic(req, res, url) {
  const requestedPath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
  const publicRoot = resolve(PUBLIC_DIR)
  const filePath = resolve(join(publicRoot, normalize(requestedPath)))
  const fallbackPath = join(publicRoot, 'index.html')
  const finalPath = filePath.startsWith(publicRoot) && existsSync(filePath) ? filePath : fallbackPath

  if (!existsSync(finalPath)) return sendError(res, 404, '页面不存在')

  res.writeHead(200, {
    'Content-Type': MIME_TYPES[extname(finalPath)] || 'application/octet-stream',
    'Cache-Control': finalPath.includes(`${join('assets', '')}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  createReadStream(finalPath).pipe(res)
}

const server = createServer(async (req, res) => {
  const requestId = createRequestId()
  const startedAt = Date.now()
  req.requestId = requestId
  res.on('finish', () => {
    const url = req.url || '/'
    if (url.startsWith('/api/')) {
      logInfo('http.request.finish', {
        requestId,
        method: req.method,
        path: url.split('?')[0],
        status: res.statusCode,
        elapsedMs: elapsedMs(startedAt),
        contentLength: req.headers['content-length'] || null,
        userAgent: req.headers['user-agent'] || null,
        forwardedFor: req.headers['x-forwarded-for'] || null,
      })
    }
  })
  req.on('aborted', () => {
    logError('http.request.aborted', {
      requestId,
      method: req.method,
      path: (req.url || '/').split('?')[0],
      elapsedMs: elapsedMs(startedAt),
      contentLength: req.headers['content-length'] || null,
    })
  })
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url)
    return serveStatic(req, res, url)
  } catch (error) {
    logError('http.request.error', {
      requestId,
      method: req.method,
      path: (req.url || '/').split('?')[0],
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    })
    return sendError(res, 500, error instanceof Error ? error.message : '服务器错误')
  }
})

server.requestTimeout = SERVER_TIMEOUTS.requestTimeoutMs
server.headersTimeout = SERVER_TIMEOUTS.headersTimeoutMs
server.keepAliveTimeout = SERVER_TIMEOUTS.keepAliveTimeoutMs

server.listen(PORT, () => {
  logInfo('server.listen', {
    port: PORT,
    dataDir: DATA_DIR,
    publicDir: PUBLIC_DIR,
    requestTimeoutMs: SERVER_TIMEOUTS.requestTimeoutMs,
    headersTimeoutMs: SERVER_TIMEOUTS.headersTimeoutMs,
    keepAliveTimeoutMs: SERVER_TIMEOUTS.keepAliveTimeoutMs,
  })
})
