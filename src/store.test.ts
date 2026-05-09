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
    let generatedTaskIndex = 0
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      const url = String(input)
      if (url === '/api/tasks/generate') {
        generatedTaskIndex += 1
        const body = JSON.parse(String(init?.body || '{}'))
        return new Response(JSON.stringify(task({
          id: `generated-task-${generatedTaskIndex}`,
          prompt: body.prompt,
          params: body.params,
          inputImageIds: body.inputImageIds,
          maskTargetImageId: body.maskTargetImageId,
          maskImageId: body.maskImageId,
          outputImages: [],
          status: 'queued',
          phase: '排队中',
          error: null,
          createdAt: 10 + generatedTaskIndex,
          finishedAt: null,
          elapsed: null,
        })), { status: 200 })
      }
      if (url === '/api/tasks/running-task') {
        return new Response(JSON.stringify(task({
          id: 'running-task',
          status: 'done',
          outputImages: ['generated-image'],
          finishedAt: 20,
          elapsed: 10,
        })), { status: 200 })
      }
      if (url === '/api/tasks/status?ids=running-task%2Cother-running-task') {
        return new Response(JSON.stringify({
          items: [
            task({ id: 'running-task', status: 'done', outputImages: ['generated-image'], finishedAt: 20, elapsed: 10 }),
            task({ id: 'other-running-task', status: 'saving', phase: '?????', finishedAt: null, elapsed: null }),
          ],
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ id: 'ok', ok: true }), { status: 200 })
    }))
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
    expect(retriedTask.status).toBe('queued')
    expect(retriedTask.phase).toBe('排队中')
    expect(retriedTask.error).toBeNull()
    expect(originalTask).toBe(failedTask)
    expect(useStore.getState().prompt).toBe('current prompt')
  })

  it('refreshes a single running task without reloading the task list', async () => {
    const runningTask = task({ id: 'running-task', status: 'running', finishedAt: null, elapsed: null })
    const otherTask = task({ id: 'other-task', prompt: 'other' })
    useStore.setState({ tasks: [runningTask, otherTask] })

    await useStore.getState().refreshTask('running-task')

    const [updatedTask, unchangedTask] = useStore.getState().tasks
    expect(updatedTask.id).toBe('running-task')
    expect(updatedTask.status).toBe('done')
    expect(updatedTask.outputImages).toEqual(['generated-image'])
    expect(unchangedTask).toBe(otherTask)
  })

  it('refreshes multiple running task statuses in one request', async () => {
    const runningTask = task({ id: 'running-task', status: 'running', finishedAt: null, elapsed: null })
    const otherRunningTask = task({ id: 'other-running-task', status: 'queued', finishedAt: null, elapsed: null })
    const doneTask = task({ id: 'done-task', status: 'done' })
    useStore.setState({ tasks: [runningTask, otherRunningTask, doneTask] })

    await useStore.getState().refreshTasks(['running-task', 'other-running-task'])

    const [updatedTask, updatedOtherTask, unchangedTask] = useStore.getState().tasks
    expect(updatedTask.status).toBe('done')
    expect(updatedOtherTask.status).toBe('saving')
    expect(updatedOtherTask.phase).toBe('?????')
    expect(unchangedTask).toBe(doneTask)
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
