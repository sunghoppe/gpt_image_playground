import type { TaskRecord, StoredImage } from '../types'
import { apiDelete, apiGet, apiPut } from './serverData'

// ===== Tasks =====

export function getAllTasks(): Promise<TaskRecord[]> {
  return apiGet<TaskRecord[]>('/api/tasks')
}

export function putTask(task: TaskRecord): Promise<string> {
  return apiPut<{ id: string }>(`/api/tasks/${encodeURIComponent(task.id)}`, task).then((result) => result.id)
}

export function deleteTask(id: string): Promise<undefined> {
  return apiDelete<{ ok: true }>(`/api/tasks/${encodeURIComponent(id)}`).then(() => undefined)
}

export function clearTasks(): Promise<undefined> {
  return apiDelete<{ ok: true }>('/api/tasks').then(() => undefined)
}

// ===== Images =====

export function getImage(id: string): Promise<StoredImage | undefined> {
  return apiGet<StoredImage>(`/api/images/${encodeURIComponent(id)}`).catch((error) => {
    if (error instanceof Error && error.message.includes('图片不存在')) return undefined
    throw error
  })
}

export function getAllImages(): Promise<StoredImage[]> {
  return apiGet<StoredImage[]>('/api/images')
}

export function putImage(image: StoredImage): Promise<string> {
  return apiPut<{ id: string }>(`/api/images/${encodeURIComponent(image.id)}`, image).then((result) => result.id)
}

export function deleteImage(id: string): Promise<undefined> {
  return apiDelete<{ ok: true }>(`/api/images/${encodeURIComponent(id)}`).then(() => undefined)
}

export function clearImages(): Promise<undefined> {
  return apiDelete<{ ok: true }>('/api/images').then(() => undefined)
}

// ===== Image hashing & dedup =====

export async function hashDataUrl(dataUrl: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    return hashDataUrlFallback(dataUrl)
  }

  const data = new TextEncoder().encode(dataUrl)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function hashDataUrlFallback(dataUrl: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193

  for (let i = 0; i < dataUrl.length; i++) {
    const code = dataUrl.charCodeAt(i)
    h1 ^= code
    h1 = Math.imul(h1, 0x01000193)
    h2 ^= code
    h2 = Math.imul(h2, 0x27d4eb2d)
  }

  return `fallback-${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`
}

/**
 * 存储图片，若已存在（按 hash 去重）则跳过。
 * 返回 image id。
 */
export async function storeImage(dataUrl: string, source: NonNullable<StoredImage['source']> = 'upload'): Promise<string> {
  const id = await hashDataUrl(dataUrl)
  const existing = await getImage(id)
  if (!existing) {
    await putImage({ id, dataUrl, createdAt: Date.now(), source })
  }
  return id
}
