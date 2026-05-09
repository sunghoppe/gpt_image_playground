import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

const DEFAULT_SETTINGS = {
  apiProvider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-image-2',
  azureApiVersion: '2025-04-01-preview',
  timeout: 900,
  apiMode: 'images',
  codexCli: false,
}

const DEFAULT_PARAMS = {
  size: 'auto',
  quality: 'auto',
  output_format: 'png',
  output_compression: null,
  moderation: 'auto',
  n: 1,
}


const DATA_URL_RE = /^data:([^;,]+)?(;base64)?,(.*)$/s
const EXT_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

function parseDataUrl(dataUrl) {
  const match = DATA_URL_RE.exec(dataUrl || '')
  if (!match) throw new Error('无效的 data URL')
  const mime = match[1] || 'application/octet-stream'
  const isBase64 = Boolean(match[2])
  const payload = match[3] || ''
  const bytes = isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8')
  return { mime, bytes, ext: EXT_BY_MIME[mime] || 'bin' }
}

function getImageRelativePath(id, ext) {
  const safeId = String(id).replace(/[^a-zA-Z0-9._-]/g, '_')
  return join('images', safeId.slice(0, 2) || 'xx', safeId.slice(2, 4) || 'xx', `${safeId}.${ext}`)
}

function toPublicImage(image) {
  if (!image) return image
  const { dataUrl, ...publicImage } = image
  return publicImage
}

function createEmptyState() {
  return {
    version: 1,
    settings: { ...DEFAULT_SETTINGS, apiKey: undefined },
    params: { ...DEFAULT_PARAMS },
    tasks: [],
    images: {},
    secrets: {},
    dismissedCodexCliPrompts: [],
  }
}

function getKey(secret) {
  return createHash('sha256').update(String(secret || 'gpt-image-playground-dev-secret')).digest()
}

function encryptText(value, secret) {
  if (!value) return undefined
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', getKey(secret), iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [iv, tag, encrypted].map((buf) => buf.toString('base64url')).join('.')
}

function decryptText(value, secret) {
  if (!value) return ''
  const [ivRaw, tagRaw, encryptedRaw] = value.split('.')
  const iv = Buffer.from(ivRaw, 'base64url')
  const tag = Buffer.from(tagRaw, 'base64url')
  const encrypted = Buffer.from(encryptedRaw, 'base64url')
  const decipher = createDecipheriv('aes-256-gcm', getKey(secret), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}

export function maskSecret(value) {
  if (!value) return ''
  if (value.length <= 4) return '••••'
  return `${'•'.repeat(12)}${value.slice(-4)}`
}

function normalizeState(input) {
  const state = { ...createEmptyState(), ...(input && typeof input === 'object' ? input : {}) }
  state.settings = { ...DEFAULT_SETTINGS, apiKey: undefined, ...(state.settings || {}) }
  if (!Number.isFinite(Number(state.settings.timeout)) || Number(state.settings.timeout) < DEFAULT_SETTINGS.timeout) {
    state.settings.timeout = DEFAULT_SETTINGS.timeout
  }
  state.params = { ...DEFAULT_PARAMS, ...(state.params || {}) }
  state.tasks = Array.isArray(state.tasks) ? state.tasks : []
  state.images = state.images && typeof state.images === 'object' ? state.images : {}
  state.secrets = state.secrets && typeof state.secrets === 'object' ? state.secrets : {}
  state.dismissedCodexCliPrompts = Array.isArray(state.dismissedCodexCliPrompts) ? state.dismissedCodexCliPrompts : []
  delete state.settings.apiKey
  return state
}

export async function createDataStore({ dataDir, secret }) {
  const statePath = join(dataDir, 'state.json')
  let writeQueue = Promise.resolve()
  await mkdir(dataDir, { recursive: true })
  await mkdir(join(dataDir, 'images'), { recursive: true })

  async function readRawState() {
    if (!existsSync(statePath)) return createEmptyState()
    const text = await readFile(statePath, 'utf8')
    return normalizeState(JSON.parse(text))
  }

  async function writeRawState(state) {
    const normalized = normalizeState(state)
    const tempPath = `${statePath}.${process.pid}.${Date.now()}.${randomBytes(6).toString('hex')}.tmp`
    await writeFile(tempPath, JSON.stringify(normalized, null, 2), 'utf8')
    await rename(tempPath, statePath)
    return normalized
  }

  async function withWriteLock(fn) {
    const run = writeQueue.then(fn, fn)
    writeQueue = run.catch(() => undefined)
    return run
  }

  async function update(mutator) {
    return withWriteLock(async () => {
      const state = await readRawState()
      const nextState = await mutator(state)
      return writeRawState(nextState || state)
    })
  }

  async function getPrivateSettings() {
    const state = await readRawState()
    return {
      ...DEFAULT_SETTINGS,
      ...state.settings,
      apiKey: decryptText(state.secrets.apiKeyCiphertext, secret),
    }
  }

  async function getPublicSettings() {
    const privateSettings = await getPrivateSettings()
    const { apiKey, ...settings } = privateSettings
    return {
      ...settings,
      apiKey: '',
      hasApiKey: Boolean(apiKey),
      apiKeyMasked: maskSecret(apiKey),
    }
  }

  async function updateSettings(patch) {
    await update((state) => {
      const { apiKey, apiKeyMasked, hasApiKey, ...settingsPatch } = patch || {}
      state.settings = { ...state.settings, ...settingsPatch }
      delete state.settings.apiKey
      if (typeof apiKey === 'string' && apiKey.trim()) {
        state.secrets.apiKeyCiphertext = encryptText(apiKey.trim(), secret)
      }
      return state
    })
    return getPublicSettings()
  }

  async function getBootstrap() {
    const state = await readRawState()
    const firstPage = await getPagedTasks({ limit: 50 })
    return {
      settings: await getPublicSettings(),
      params: state.params,
      tasks: firstPage.items,
      tasksNextOffset: firstPage.nextOffset,
      dismissedCodexCliPrompts: state.dismissedCodexCliPrompts,
    }
  }

  async function updateParams(params) {
    return update((state) => {
      state.params = { ...state.params, ...(params || {}) }
      return state
    })
  }

  async function getAllTasks() {
    return (await readRawState()).tasks
  }

  async function getPagedTasks({ limit = 50, offset = 0, q = '', status = 'all', favorite = false } = {}) {
    const normalizedLimit = Math.max(1, Math.min(200, Number(limit) || 50))
    const normalizedOffset = Math.max(0, Number(offset) || 0)
    const query = String(q || '').trim().toLowerCase()
    const tasks = (await readRawState()).tasks
      .slice()
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .filter((task) => {
        if (status && status !== 'all' && task.status !== status) return false
        if (favorite && !task.isFavorite) return false
        if (!query) return true
        const searchText = `${task.prompt || ''} ${JSON.stringify(task.params || {})}`.toLowerCase()
        return searchText.includes(query)
      })
    return {
      items: tasks.slice(normalizedOffset, normalizedOffset + normalizedLimit),
      total: tasks.length,
      nextOffset: normalizedOffset + normalizedLimit < tasks.length ? normalizedOffset + normalizedLimit : null,
    }
  }

  async function putTask(task) {
    await update((state) => {
      state.tasks = state.tasks.filter((item) => item.id !== task.id)
      state.tasks.push(task)
      state.tasks.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      return state
    })
    return task.id
  }

  async function getTask(id) {
    return (await readRawState()).tasks.find((task) => task.id === id)
  }

  async function updateTask(id, patch) {
    let updatedTask
    await update((state) => {
      state.tasks = state.tasks.map((task) => {
        if (task.id !== id) return task
        updatedTask = { ...task, ...(patch || {}) }
        return updatedTask
      })
      return state
    })
    return updatedTask
  }

  async function deleteTask(id) {
    return update((state) => {
      state.tasks = state.tasks.filter((task) => task.id !== id)
      return state
    })
  }

  async function clearTasks() {
    return update((state) => {
      state.tasks = []
      return state
    })
  }

  async function markRunningTasksAsError(message) {
    return update((state) => {
      const now = Date.now()
      state.tasks = state.tasks.map((task) => task.status === 'running'
        ? {
            ...task,
            status: 'error',
            error: message,
            finishedAt: task.finishedAt || now,
            elapsed: task.elapsed ?? now - (task.createdAt || now),
          }
        : task)
      return state
    })
  }

  async function materializeImage(image) {
    if (!image) return undefined
    if (image.dataUrl && !image.filePath) {
      await putImage(image)
      return (await readRawState()).images[image.id]
    }
    return image
  }

  async function getImage(id) {
    return materializeImage((await readRawState()).images[id])
  }

  async function getImageContent(id) {
    const image = await getImage(id)
    if (!image) return undefined
    if (image.dataUrl) {
      const parsed = parseDataUrl(image.dataUrl)
      return { ...parsed, size: parsed.bytes.length }
    }
    const bytes = await readFile(join(dataDir, image.filePath))
    return { bytes, mime: image.mime || 'application/octet-stream', ext: image.ext || 'bin', size: bytes.length }
  }

  async function getAllImages() {
    const images = Object.values((await readRawState()).images)
    return images.map(toPublicImage)
  }

  async function putImage(image) {
    const { mime, bytes, ext } = parseDataUrl(image.dataUrl)
    const filePath = getImageRelativePath(image.id, ext)
    const absolutePath = join(dataDir, filePath)
    await mkdir(dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, bytes)

    const storedImage = {
      id: image.id,
      mime,
      ext,
      sizeBytes: bytes.length,
      filePath,
      createdAt: image.createdAt || Date.now(),
      source: image.source,
    }

    await update((state) => {
      state.images[image.id] = storedImage
      return state
    })
    return image.id
  }

  async function deleteImage(id) {
    return withWriteLock(async () => {
      const state = await readRawState()
      const image = state.images[id]
      if (image?.filePath) {
        await rm(join(dataDir, image.filePath), { force: true })
      }
      delete state.images[id]
      return writeRawState(state)
    })
  }

  async function clearImages() {
    await rm(join(dataDir, 'images'), { recursive: true, force: true })
    await mkdir(join(dataDir, 'images'), { recursive: true })
    return update((state) => {
      state.images = {}
      return state
    })
  }

  async function updateDismissedCodexCliPrompts(values) {
    return update((state) => {
      state.dismissedCodexCliPrompts = Array.isArray(values) ? values : []
      return state
    })
  }

  return {
    readRawState,
    writeRawState,
    getPrivateSettings,
    getPublicSettings,
    updateSettings,
    getBootstrap,
    updateParams,
    getAllTasks,
    getPagedTasks,
    putTask,
    getTask,
    updateTask,
    deleteTask,
    clearTasks,
    markRunningTasksAsError,
    getImage,
    getImageContent,
    getAllImages,
    putImage,
    deleteImage,
    clearImages,
    updateDismissedCodexCliPrompts,
  }
}
