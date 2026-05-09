import { randomBytes } from 'node:crypto'
import { callImageApi } from './openai.mjs'
import { elapsedMs, logError, logInfo } from './logger.mjs'

function genId() {
  return `${Date.now().toString(36)}${randomBytes(4).toString('hex')}`
}

function hashDataUrlFallback(dataUrl) {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let index = 0; index < dataUrl.length; index += 1) {
    const code = dataUrl.charCodeAt(index)
    h1 ^= code
    h1 = Math.imul(h1, 0x01000193)
    h2 ^= code
    h2 = Math.imul(h2, 0x27d4eb2d)
  }
  return `fallback-${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`
}

async function hashDataUrl(dataUrl) {
  if (!globalThis.crypto?.subtle) return hashDataUrlFallback(dataUrl)
  const data = new TextEncoder().encode(dataUrl)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hashBuffer)).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function loadImageDataUrl(store, id) {
  const image = await store.getImage(id)
  if (image?.dataUrl) return image.dataUrl
  const content = await store.getImageContent(id)
  if (!content) return undefined
  return `data:${content.mime};base64,${Buffer.from(content.bytes).toString('base64')}`
}

export function createTaskRunner({ store }) {
  const runningTaskIds = new Set()

  async function runTask(taskId) {
    if (runningTaskIds.has(taskId)) return
    runningTaskIds.add(taskId)
    const startedAt = Date.now()
    logInfo('task.runner.start', { taskId })

    try {
      const task = await store.getTask(taskId)
      if (!task) throw new Error('任务不存在')
      const settings = await store.getPrivateSettings()
      if (!settings.apiKey) throw new Error('请先配置 API Key')

      const inputImageDataUrls = []
      for (const imageId of task.inputImageIds || []) {
        const dataUrl = await loadImageDataUrl(store, imageId)
        if (!dataUrl) throw new Error('输入图片已不存在')
        inputImageDataUrls.push(dataUrl)
      }
      const maskDataUrl = task.maskImageId ? await loadImageDataUrl(store, task.maskImageId) : undefined
      if (task.maskImageId && !maskDataUrl) throw new Error('遮罩图片已不存在')

      logInfo('task.runner.upstream.start', {
        taskId,
        provider: settings.apiProvider,
        apiMode: settings.apiMode,
        model: settings.model,
        inputImageCount: inputImageDataUrls.length,
        hasMask: Boolean(maskDataUrl),
      })

      const result = await callImageApi({
        settings,
        prompt: task.prompt,
        params: task.params,
        inputImageDataUrls,
        maskDataUrl,
      })

      logInfo('task.runner.upstream.response', {
        taskId,
        elapsedMs: elapsedMs(startedAt),
        imageCount: result.images.length,
      })

      const outputImages = []
      for (const dataUrl of result.images) {
        const imageId = await hashDataUrl(dataUrl)
        await store.putImage({ id: imageId, dataUrl, createdAt: Date.now(), source: 'generated' })
        outputImages.push(imageId)
      }

      const actualParamsByImage = result.actualParamsList?.reduce((acc, params, index) => {
        const imageId = outputImages[index]
        if (imageId && params && Object.keys(params).length > 0) acc[imageId] = params
        return acc
      }, {})
      const revisedPromptByImage = result.revisedPrompts?.reduce((acc, revisedPrompt, index) => {
        const imageId = outputImages[index]
        if (imageId && revisedPrompt && revisedPrompt.trim()) acc[imageId] = revisedPrompt
        return acc
      }, {})

      await store.updateTask(taskId, {
        outputImages,
        actualParams: { ...(result.actualParams || {}), n: outputImages.length },
        actualParamsByImage: actualParamsByImage && Object.keys(actualParamsByImage).length ? actualParamsByImage : undefined,
        revisedPromptByImage: revisedPromptByImage && Object.keys(revisedPromptByImage).length ? revisedPromptByImage : undefined,
        status: 'done',
        error: null,
        finishedAt: Date.now(),
        elapsed: Date.now() - task.createdAt,
      })

      logInfo('task.runner.complete', { taskId, elapsedMs: elapsedMs(startedAt), outputCount: outputImages.length })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await store.updateTask(taskId, {
        status: 'error',
        error: message,
        finishedAt: Date.now(),
        elapsed: Date.now() - startedAt,
      })
      logError('task.runner.error', { taskId, elapsedMs: elapsedMs(startedAt), message })
    } finally {
      runningTaskIds.delete(taskId)
    }
  }

  function createTask({ prompt, params, inputImageIds = [], maskTargetImageId = null, maskImageId = null }) {
    return {
      id: genId(),
      prompt: String(prompt || '').trim(),
      params,
      inputImageIds,
      maskTargetImageId,
      maskImageId,
      outputImages: [],
      status: 'running',
      error: null,
      createdAt: Date.now(),
      finishedAt: null,
      elapsed: null,
    }
  }

  return { createTask, runTask }
}
