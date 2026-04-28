import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULT_SETTINGS = {
  apiProvider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-image-2',
  azureApiVersion: '2025-04-01-preview',
  timeout: 300,
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
  await mkdir(dataDir, { recursive: true })

  async function readRawState() {
    if (!existsSync(statePath)) return createEmptyState()
    const text = await readFile(statePath, 'utf8')
    return normalizeState(JSON.parse(text))
  }

  async function writeRawState(state) {
    const normalized = normalizeState(state)
    const tempPath = `${statePath}.tmp`
    await writeFile(tempPath, JSON.stringify(normalized, null, 2), 'utf8')
    await rename(tempPath, statePath)
    return normalized
  }

  async function update(mutator) {
    const state = await readRawState()
    const nextState = await mutator(state)
    return writeRawState(nextState || state)
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
    return {
      settings: await getPublicSettings(),
      params: state.params,
      tasks: state.tasks,
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

  async function putTask(task) {
    await update((state) => {
      state.tasks = state.tasks.filter((item) => item.id !== task.id)
      state.tasks.push(task)
      state.tasks.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      return state
    })
    return task.id
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

  async function getImage(id) {
    return (await readRawState()).images[id]
  }

  async function getAllImages() {
    return Object.values((await readRawState()).images)
  }

  async function putImage(image) {
    await update((state) => {
      state.images[image.id] = image
      return state
    })
    return image.id
  }

  async function deleteImage(id) {
    return update((state) => {
      delete state.images[id]
      return state
    })
  }

  async function clearImages() {
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
    putTask,
    deleteTask,
    clearTasks,
    getImage,
    getAllImages,
    putImage,
    deleteImage,
    clearImages,
    updateDismissedCodexCliPrompts,
  }
}
