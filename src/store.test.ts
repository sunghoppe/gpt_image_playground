import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS, DEFAULT_SETTINGS } from './types'
import type { TaskRecord } from './types'
import { editOutputs, hasBlockingOverlayOpen, isDataUrl, retryTask, submitTask, useStore } from './store'

const imageA = { id: 'image-a', dataUrl: 'data:image/png;base64,a' }

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-a',
    prompt: 'prompt',
    params: { ...DEFAULT_PARAMS },
    inputImageIds: [],
    maskTargetImageId: null,
    maskImageId: null,
    outputImages: [],
    status: 'done',
    error: null,
    createdAt: 1,
    finishedAt: 2,
    elapsed: 1,
    ...overrides,
  }
}

describe('mask draft lifecycle in store actions', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'ok', ok: true }), { status: 200 })))
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS, apiKey: 'test-key' },
      prompt: 'prompt',
      inputImages: [],
      maskDraft: null,
      maskEditorImageId: null,
      params: { ...DEFAULT_PARAMS },
      tasks: [],
      detailTaskId: null,
      lightboxImageId: null,
      lightboxImageList: [],
      showSettings: false,
      toast: null,
      confirmDialog: null,
      showToast: vi.fn(),
      setConfirmDialog: vi.fn(),
    })
  })

  it('clears an existing mask when quick edit-output adds outputs as references', async () => {
    useStore.setState({
      inputImages: [imageA],
      maskDraft: {
        targetImageId: imageA.id,
        maskDataUrl: 'data:image/png;base64,mask',
        updatedAt: 1,
      },
    })

    await editOutputs(task({ outputImages: [imageA.id] }))

    expect(useStore.getState().maskDraft).toBeNull()
  })

  it('clears an invalid mask draft when submit cannot find the mask target image', async () => {
    useStore.setState({
      inputImages: [imageA],
      maskDraft: {
        targetImageId: 'missing-image',
        maskDataUrl: 'data:image/png;base64,mask',
        updatedAt: 1,
      },
    })

    await submitTask()

    expect(useStore.getState().maskDraft).toBeNull()
  })

  it('clears the prompt after creating a submitted task', async () => {
    useStore.setState({ prompt: '  a cat wearing sunglasses  ' })

    await submitTask()

    expect(useStore.getState().tasks[0].prompt).toBe('a cat wearing sunglasses')
    expect(useStore.getState().prompt).toBe('')
  })

  it('creates a new running task when retrying an error task', async () => {
    const failedTask = task({
      id: 'failed-task',
      prompt: 'retry prompt',
      params: { ...DEFAULT_PARAMS, n: 2 },
      status: 'error',
      error: 'HTTP 504',
      inputImageIds: [imageA.id],
      outputImages: [],
      finishedAt: 2,
      elapsed: 1,
    })
    useStore.setState({ tasks: [failedTask], prompt: 'current prompt' })

    await retryTask(failedTask)

    const [retriedTask, originalTask] = useStore.getState().tasks
    expect(retriedTask.id).not.toBe(failedTask.id)
    expect(retriedTask.prompt).toBe('retry prompt')
    expect(retriedTask.params.n).toBe(2)
    expect(retriedTask.inputImageIds).toEqual([imageA.id])
    expect(retriedTask.status).toBe('running')
    expect(retriedTask.error).toBeNull()
    expect(originalTask).toBe(failedTask)
    expect(useStore.getState().prompt).toBe('current prompt')
  })
})

describe('blocking overlay detection', () => {
  it('treats settings modal as a blocking overlay', () => {
    expect(hasBlockingOverlayOpen({
      detailTaskId: null,
      lightboxImageId: null,
      maskEditorImageId: null,
      showSettings: true,
      confirmDialog: null,
    })).toBe(true)
  })

  it('does not block when no overlay is open', () => {
    expect(hasBlockingOverlayOpen({
      detailTaskId: null,
      lightboxImageId: null,
      maskEditorImageId: null,
      showSettings: false,
      confirmDialog: null,
    })).toBe(false)
  })
})

describe('image input URL detection', () => {
  it('identifies data URLs that can be stored directly', () => {
    expect(isDataUrl('data:image/png;base64,aGVsbG8=')).toBe(true)
  })

  it('does not treat server image content URLs as data URLs', () => {
    expect(isDataUrl('/api/images/fallback-854ac47f6f99ac7f/content')).toBe(false)
  })
})
