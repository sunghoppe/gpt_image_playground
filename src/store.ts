import { create } from 'zustand'
import type {
  AppSettings,
  TaskParams,
  InputImage,
  MaskDraft,
  TaskRecord,
  ExportData,
} from './types'
import { DEFAULT_SETTINGS, DEFAULT_PARAMS } from './types'
import {
  getAllTasks,
  putTask,
  deleteTask as dbDeleteTask,
  clearTasks as dbClearTasks,
  getImage,
  getAllImages,
  putImage,
  deleteImage,
  clearImages,
  storeImage,
  hashDataUrl,
} from './lib/db'
import { apiGet, apiPost, apiPut } from './lib/serverData'
import { validateMaskMatchesImage } from './lib/canvasImage'
import { orderInputImagesForMask } from './lib/mask'
import { normalizeImageSize } from './lib/size'
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'

// ===== Image cache =====
// 鍐呭瓨缂撳瓨锛宨d 鈫?dataUrl锛岄伩鍏嶆瘡娆′粠鏈嶅姟绔鍙?

type ImageVariant = 'original' | 'thumbnail' | 'preview'

const imageCache = new Map<string, string>()
const imageVariantCache = new Map<string, string>()

function imageVariantCacheKey(id: string, variant: ImageVariant): string {
  return `${variant}:${id}`
}

function deleteImageCaches(id: string) {
  imageCache.delete(id)
  imageVariantCache.delete(imageVariantCacheKey(id, 'thumbnail'))
  imageVariantCache.delete(imageVariantCacheKey(id, 'preview'))
}

export function getCachedImage(id: string): string | undefined {
  return imageCache.get(id)
}

export async function ensureImageCached(id: string): Promise<string | undefined> {
  if (imageCache.has(id)) return imageCache.get(id)
  const rec = await getImage(id)
  if (rec?.dataUrl) {
    imageCache.set(id, rec.dataUrl)
    return rec.dataUrl
  }
  if (rec) {
    const url = `/api/images/${encodeURIComponent(id)}/content`
    imageCache.set(id, url)
    return url
  }
  return undefined
}

export function getCachedImageVariant(id: string, variant: ImageVariant): string | undefined {
  if (variant === 'original') return getCachedImage(id)
  return imageVariantCache.get(imageVariantCacheKey(id, variant))
}

export async function ensureImageVariantCached(id: string, variant: ImageVariant): Promise<string | undefined> {
  if (variant === 'original') return ensureImageCached(id)
  const cacheKey = imageVariantCacheKey(id, variant)
  if (imageVariantCache.has(cacheKey)) return imageVariantCache.get(cacheKey)
  const rec = await getImage(id)
  if (!rec) return undefined
  const url = `/api/images/${encodeURIComponent(id)}/${variant}`
  imageVariantCache.set(cacheKey, url)
  return url
}

// ===== Store 绫诲瀷 =====

interface AppState {
  // 璁剧疆
  settings: AppSettings
  setSettings: (s: Partial<AppSettings>) => void
  dismissedCodexCliPrompts: string[]
  dismissCodexCliPrompt: (key: string) => void

  // 杈撳叆
  prompt: string
  setPrompt: (p: string) => void
  inputImages: InputImage[]
  addInputImage: (img: InputImage) => void
  removeInputImage: (idx: number) => void
  clearInputImages: () => void
  setInputImages: (imgs: InputImage[]) => void
  maskDraft: MaskDraft | null
  setMaskDraft: (draft: MaskDraft | null) => void
  clearMaskDraft: () => void
  maskEditorImageId: string | null
  setMaskEditorImageId: (id: string | null) => void

  // 鍙傛暟
  params: TaskParams
  setParams: (p: Partial<TaskParams>) => void

  // 浠诲姟鍒楄〃
  tasks: TaskRecord[]
  setTasks: (t: TaskRecord[]) => void
  tasksNextOffset: number | null
  tasksLoadingMore: boolean
  loadMoreTasks: () => Promise<void>
  reloadTasks: () => Promise<void>
  refreshTask: (id: string) => Promise<void>
  refreshTasks: (ids: string[]) => Promise<void>

  // 鎼滅储鍜岀瓫閫?
  searchQuery: string
  setSearchQuery: (q: string) => void
  filterStatus: 'all' | 'running' | 'done' | 'error'
  setFilterStatus: (status: AppState['filterStatus']) => void
  filterFavorite: boolean
  setFilterFavorite: (f: boolean) => void

  // 澶氶€?
  selectedTaskIds: string[]
  setSelectedTaskIds: (ids: string[] | ((prev: string[]) => string[])) => void
  toggleTaskSelection: (id: string, force?: boolean) => void
  clearSelection: () => void

  // UI
  detailTaskId: string | null
  setDetailTaskId: (id: string | null) => void
  lightboxImageId: string | null
  lightboxImageList: string[]
  setLightboxImageId: (id: string | null, list?: string[]) => void
  showSettings: boolean
  setShowSettings: (v: boolean) => void

  // Toast
  toast: { message: string; type: 'info' | 'success' | 'error' } | null
  showToast: (message: string, type?: 'info' | 'success' | 'error') => void

  // Confirm dialog
  confirmDialog: {
    title: string
    message: string
    confirmText?: string
    messageAlign?: 'left' | 'center'
    tone?: 'danger' | 'warning'
    action: () => void
    cancelAction?: () => void
  } | null
  setConfirmDialog: (d: AppState['confirmDialog']) => void
}

type BlockingOverlayState = Pick<
  AppState,
  'detailTaskId' | 'lightboxImageId' | 'maskEditorImageId' | 'showSettings' | 'confirmDialog'
>

export function hasBlockingOverlayOpen(state: BlockingOverlayState): boolean {
  return Boolean(
    state.detailTaskId ||
      state.lightboxImageId ||
      state.maskEditorImageId ||
      state.showSettings ||
      state.confirmDialog,
  )
}

export function isDataUrl(value: string): boolean {
  return value.trimStart().startsWith('data:')
}

export const useStore = create<AppState>()(
    (set, get) => ({
      // Settings
      settings: { ...DEFAULT_SETTINGS },
      setSettings: (s) => set((st) => {
        const nextSettings = {
          ...st.settings,
          ...s,
          apiProvider:
            s.apiProvider === 'openai' || s.apiProvider === 'azure'
              ? s.apiProvider
              : st.settings.apiProvider ?? DEFAULT_SETTINGS.apiProvider,
          apiMode:
            s.apiMode === 'images' || s.apiMode === 'responses'
              ? s.apiMode
              : st.settings.apiMode ?? DEFAULT_SETTINGS.apiMode,
          azureApiVersion: s.azureApiVersion ?? st.settings.azureApiVersion ?? DEFAULT_SETTINGS.azureApiVersion,
          codexCli: s.codexCli ?? st.settings.codexCli ?? DEFAULT_SETTINGS.codexCli,
        }
        void apiPut('/api/settings', s).catch((error) => st.showToast('保存设置失败：' + (error instanceof Error ? error.message : String(error)), 'error'))
        return { settings: nextSettings }
      }),
      dismissedCodexCliPrompts: [],
      dismissCodexCliPrompt: (key) => set((st) => {
        const dismissedCodexCliPrompts = st.dismissedCodexCliPrompts.includes(key)
          ? st.dismissedCodexCliPrompts
          : [...st.dismissedCodexCliPrompts, key]
        void apiPut('/api/dismissed-codex-cli-prompts', { values: dismissedCodexCliPrompts }).catch(() => undefined)
        return { dismissedCodexCliPrompts }
      }),

      // Input
      prompt: '',
      setPrompt: (prompt) => set({ prompt }),
      inputImages: [],
      addInputImage: (img) =>
        set((s) => {
          if (s.inputImages.find((i) => i.id === img.id)) return s
          return { inputImages: [...s.inputImages, img] }
        }),
      removeInputImage: (idx) =>
        set((s) => {
          const removed = s.inputImages[idx]
          const shouldClearMask = removed?.id === s.maskDraft?.targetImageId
          return {
            inputImages: s.inputImages.filter((_, i) => i !== idx),
            ...(shouldClearMask ? { maskDraft: null, maskEditorImageId: null } : {}),
          }
        }),
      clearInputImages: () =>
        set((s) => {
          for (const img of s.inputImages) deleteImageCaches(img.id)
          return { inputImages: [], maskDraft: null, maskEditorImageId: null }
        }),
      setInputImages: (imgs) =>
        set((s) => {
          const shouldClearMask =
            Boolean(s.maskDraft) && !imgs.some((img) => img.id === s.maskDraft?.targetImageId)
          return {
            inputImages: imgs,
            ...(shouldClearMask ? { maskDraft: null, maskEditorImageId: null } : {}),
          }
        }),
      maskDraft: null,
      setMaskDraft: (maskDraft) => set({ maskDraft }),
      clearMaskDraft: () => set({ maskDraft: null }),
      maskEditorImageId: null,
      setMaskEditorImageId: (maskEditorImageId) => set({ maskEditorImageId }),

      // Params
      params: { ...DEFAULT_PARAMS },
      setParams: (p) => set((s) => {
        const params = { ...s.params, ...p }
        void apiPut('/api/params', params).catch((error) => s.showToast('保存参数失败：' + (error instanceof Error ? error.message : String(error)), 'error'))
        return { params }
      }),

      // Tasks
      tasks: [],
      setTasks: (tasks) => set({ tasks }),
      tasksNextOffset: null,
      tasksLoadingMore: false,
      reloadTasks: async () => {
        const state = get()
        const params = new URLSearchParams({ limit: '50', offset: '0' })
        if (state.searchQuery.trim()) params.set('q', state.searchQuery.trim())
        if (state.filterStatus !== 'all') params.set('status', state.filterStatus)
        if (state.filterFavorite) params.set('favorite', 'true')
        try {
          const result = await apiGet<{ items: TaskRecord[]; nextOffset: number | null }>(`/api/tasks?${params}`)
          set({ tasks: result.items, tasksNextOffset: result.nextOffset })
        } catch (error) {
          get().showToast('刷新任务失败：' + (error instanceof Error ? error.message : String(error)), 'error')
        }
      },
      refreshTask: async (id) => {
        try {
          const task = await apiGet<TaskRecord>(`/api/tasks/${encodeURIComponent(id)}`)
          set((current) => ({
            tasks: current.tasks.map((item) => item.id === id ? task : item),
          }))
        } catch (error) {
          get().showToast('刷新任务失败：' + (error instanceof Error ? error.message : String(error)), 'error')
        }
      },
      refreshTasks: async (ids) => {
        if (!ids.length) return
        try {
          const params = new URLSearchParams({ ids: ids.join(',') })
          const result = await apiGet<{ items: TaskRecord[] }>(`/api/tasks/status?${params}`)
          const updatedById = new Map(result.items.map((task) => [task.id, task]))
          set((current) => ({
            tasks: current.tasks.map((item) => updatedById.get(item.id) ?? item),
          }))
        } catch (error) {
          get().showToast('刷新任务失败：' + (error instanceof Error ? error.message : String(error)), 'error')
        }
      },
      loadMoreTasks: async () => {
        const state = get()
        if (state.tasksLoadingMore || state.tasksNextOffset == null) return
        set({ tasksLoadingMore: true })
        try {
          const params = new URLSearchParams({ limit: '50', offset: String(state.tasksNextOffset) })
          if (state.searchQuery.trim()) params.set('q', state.searchQuery.trim())
          if (state.filterStatus !== 'all') params.set('status', state.filterStatus)
          if (state.filterFavorite) params.set('favorite', 'true')
          const result = await apiGet<{ items: TaskRecord[]; nextOffset: number | null }>(`/api/tasks?${params}`)
          set((current) => {
            const existingIds = new Set(current.tasks.map((task) => task.id))
            const nextTasks = [...current.tasks, ...result.items.filter((task) => !existingIds.has(task.id))]
            return { tasks: nextTasks, tasksNextOffset: result.nextOffset, tasksLoadingMore: false }
          })
        } catch (error) {
          set({ tasksLoadingMore: false })
          get().showToast('加载更多失败：' + (error instanceof Error ? error.message : String(error)), 'error')
        }
      },

      // Search & Filter
      searchQuery: '',
      setSearchQuery: (searchQuery) => set({ searchQuery }),
      filterStatus: 'all',
      setFilterStatus: (filterStatus) => set({ filterStatus }),
      filterFavorite: false,
      setFilterFavorite: (filterFavorite) => set({ filterFavorite }),

      // Selection
      selectedTaskIds: [],
      setSelectedTaskIds: (updater) => set((s) => ({
        selectedTaskIds: typeof updater === 'function' ? updater(s.selectedTaskIds) : updater
      })),
      toggleTaskSelection: (id, force) => set((s) => {
        const isSelected = s.selectedTaskIds.includes(id)
        const shouldSelect = force !== undefined ? force : !isSelected
        if (shouldSelect === isSelected) return s
        return {
          selectedTaskIds: shouldSelect
            ? [...s.selectedTaskIds, id]
            : s.selectedTaskIds.filter((x) => x !== id)
        }
      }),
      clearSelection: () => set({ selectedTaskIds: [] }),

      // UI
      detailTaskId: null,
      setDetailTaskId: (detailTaskId) => set({ detailTaskId }),
      lightboxImageId: null,
      lightboxImageList: [],
      setLightboxImageId: (lightboxImageId, list) =>
        set({ lightboxImageId, lightboxImageList: list ?? (lightboxImageId ? [lightboxImageId] : []) }),
      showSettings: false,
      setShowSettings: (showSettings) => set({ showSettings }),

      // Toast
      toast: null,
      showToast: (message, type = 'info') => {
        set({ toast: { message, type } })
        setTimeout(() => {
          set((s) => (s.toast?.message === message ? { toast: null } : s))
        }, 3000)
      },

      // Confirm
      confirmDialog: null,
      setConfirmDialog: (confirmDialog) => set({ confirmDialog }),
    }),
)

// ===== Actions =====

let uid = 0
function genId(): string {
  return Date.now().toString(36) + (++uid).toString(36) + Math.random().toString(36).slice(2, 6)
}

export function getCodexCliPromptKey(settings: AppSettings): string {
  return `${settings.baseUrl}\n${settings.apiKey}`
}

export function showCodexCliPrompt(force = false, reason = '鎺ュ彛杩斿洖鐨勬彁绀鸿瘝宸茶鏀瑰啓') {
  const state = useStore.getState()
  const settings = state.settings
  const promptKey = getCodexCliPromptKey(settings)
  if (!force && (settings.codexCli || state.dismissedCodexCliPrompts.includes(promptKey))) return

  state.setConfirmDialog({
    title: '检测到 Codex CLI API',
    message:
      reason +
      '，当前 API 来源很可能是 Codex CLI。\n\n是否开启 Codex CLI 兼容模式？开启后会禁用在此处无效的质量参数，并在 Images API 多图生成时使用并发请求，解决该 API 数量参数无效的问题。',
    confirmText: '开启',
    action: () => {
      const state = useStore.getState()
      state.dismissCodexCliPrompt(promptKey)
      state.setSettings({ codexCli: true })
    },
    cancelAction: () => useStore.getState().dismissCodexCliPrompt(promptKey),
  })
}

/** 鍒濆鍖栵細浠庢湇鍔＄鍔犺浇浠诲姟鍜屽浘鐗囩紦瀛橈紝娓呯悊瀛ょ珛鍥剧墖 */
export async function initStore() {
  const bootstrap = await apiGet<{ settings: AppSettings; params: TaskParams; tasks: TaskRecord[]; tasksNextOffset?: number | null; dismissedCodexCliPrompts: string[] }>('/api/bootstrap')
  useStore.setState({
    settings: { ...DEFAULT_SETTINGS, ...bootstrap.settings },
    params: { ...DEFAULT_PARAMS, ...bootstrap.params },
    dismissedCodexCliPrompts: bootstrap.dismissedCodexCliPrompts ?? [],
    tasksNextOffset: bootstrap.tasksNextOffset ?? (bootstrap.tasks.length >= 50 ? 50 : null),
  })
  const tasks = bootstrap.tasks
  useStore.getState().setTasks(tasks)

  // 鏀堕泦鎵€鏈変换鍔″紩鐢ㄧ殑鍥剧墖 id
  const referencedIds = new Set<string>()
  for (const t of tasks) {
    for (const id of t.inputImageIds || []) referencedIds.add(id)
    if (t.maskImageId) referencedIds.add(t.maskImageId)
    for (const id of t.outputImages || []) referencedIds.add(id)
  }

  // 棰勫姞杞芥墍鏈夊浘鐗囧埌缂撳瓨锛屽悓鏃舵竻鐞嗗绔嬪浘鐗?
  const images = await getAllImages()
  for (const img of images) {
    if (!referencedIds.has(img.id)) {
      await deleteImage(img.id)
    }
  }
}

/** 鎻愪氦鏂颁换鍔?*/
export async function submitTask(options: { allowFullMask?: boolean } = {}) {
  const { settings, prompt, inputImages, maskDraft, params, showToast, setConfirmDialog } =
    useStore.getState()

  if (!settings.apiKey && !settings.hasApiKey) {
    showToast('请先在设置中配置 API Key', 'error')
    useStore.getState().setShowSettings(true)
    return
  }

  if (!prompt.trim()) {
    showToast('请输入提示词', 'error')
    return
  }

  let orderedInputImages = inputImages
  let maskImageId: string | null = null
  let maskTargetImageId: string | null = null

  if (maskDraft) {
    try {
      orderedInputImages = orderInputImagesForMask(inputImages, maskDraft.targetImageId)
      const coverage = await validateMaskMatchesImage(maskDraft.maskDataUrl, orderedInputImages[0].dataUrl)
      if (coverage === 'full' && !options.allowFullMask) {
        setConfirmDialog({
          title: '确认编辑整张图片？',
          message: '当前遮罩覆盖了整张图片，提交后可能会重绘全部内容。是否继续？',
          confirmText: '继续提交',
          tone: 'warning',
          action: () => {
            void submitTask({ allowFullMask: true })
          },
        })
        return
      }
      maskImageId = await storeImage(maskDraft.maskDataUrl, 'mask')
      imageCache.set(maskImageId, maskDraft.maskDataUrl)
      maskTargetImageId = maskDraft.targetImageId
    } catch (err) {
      if (!inputImages.some((img) => img.id === maskDraft.targetImageId)) {
        useStore.getState().clearMaskDraft()
      }
      showToast(err instanceof Error ? err.message : String(err), 'error')
      return
    }
  }

  // 鎸佷箙鍖栬緭鍏ュ浘鐗囧埌鏈嶅姟绔紙姝ゅ墠鍙湪鍐呭瓨缂撳瓨涓級
  for (const img of orderedInputImages) {
    if (isDataUrl(img.dataUrl)) {
      await storeImage(img.dataUrl)
    }
  }

  const normalizedParams = {
    ...params,
    size: normalizeImageSize(params.size) || DEFAULT_PARAMS.size,
    quality: settings.codexCli ? DEFAULT_PARAMS.quality : params.quality,
  }
  if (normalizedParams.size !== params.size || normalizedParams.quality !== params.quality) {
    useStore.getState().setParams({ size: normalizedParams.size, quality: normalizedParams.quality })
  }

  await createRunningTask({
    prompt: prompt.trim(),
    params: normalizedParams,
    inputImageIds: orderedInputImages.map((i) => i.id),
    maskTargetImageId,
    maskImageId,
    statePatch: { prompt: '' },
  })
}

async function createRunningTask(options: {
  prompt: string
  params: TaskParams
  inputImageIds: string[]
  maskTargetImageId?: string | null
  maskImageId?: string | null
  statePatch?: Partial<AppState>
}): Promise<TaskRecord> {
  const task = await apiPost<TaskRecord>('/api/tasks/generate', {
    prompt: options.prompt,
    params: options.params,
    inputImageIds: options.inputImageIds,
    maskTargetImageId: options.maskTargetImageId ?? null,
    maskImageId: options.maskImageId ?? null,
  })
  const latestTasks = useStore.getState().tasks
  useStore.setState({ ...options.statePatch, tasks: [task, ...latestTasks] })
  return task
}

export async function retryTask(task: TaskRecord) {
  if (task.status !== 'error') return

  const retriedTask = await createRunningTask({
    prompt: task.prompt,
    params: task.params,
    inputImageIds: [...task.inputImageIds],
    maskTargetImageId: task.maskTargetImageId ?? null,
    maskImageId: task.maskImageId ?? null,
  })
  useStore.getState().showToast('已重新提交生成任务', 'success')
}

export function updateTaskInStore(taskId: string, patch: Partial<TaskRecord>) {
  const { tasks, setTasks } = useStore.getState()
  const updated = tasks.map((t) =>
    t.id === taskId ? { ...t, ...patch } : t,
  )
  setTasks(updated)
  const task = updated.find((t) => t.id === taskId)
  if (task) putTask(task)
}

/** 澶嶇敤閰嶇疆 */
export async function reuseConfig(task: TaskRecord) {
  const { setPrompt, setParams, setInputImages, setMaskDraft, clearMaskDraft, showToast } = useStore.getState()
  setPrompt(task.prompt)
  setParams(task.params)

  // 鎭㈠杈撳叆鍥剧墖
  const imgs: InputImage[] = []
  for (const imgId of task.inputImageIds) {
    const dataUrl = await ensureImageCached(imgId)
    if (dataUrl) {
      imgs.push({ id: imgId, dataUrl })
    }
  }
  setInputImages(imgs)
  const maskTargetImageId = task.maskTargetImageId ?? (task.maskImageId ? task.inputImageIds[0] : null)
  if (maskTargetImageId && task.maskImageId && imgs.some((img) => img.id === maskTargetImageId)) {
    const maskDataUrl = await ensureImageCached(task.maskImageId)
    if (maskDataUrl) {
      setMaskDraft({
        targetImageId: maskTargetImageId,
        maskDataUrl,
        updatedAt: Date.now(),
      })
    } else {
      clearMaskDraft()
    }
  } else {
    clearMaskDraft()
  }
  showToast('已复用配置', 'success')
}

/** 缂栬緫杈撳嚭锛氬皢杈撳嚭鍥惧姞鍏ヨ緭鍏?*/
export async function editOutputs(task: TaskRecord) {
  const { inputImages, addInputImage, clearMaskDraft, showToast } = useStore.getState()
  if (!task.outputImages?.length) return

  clearMaskDraft()
  let added = 0
  for (const imgId of task.outputImages) {
    if (inputImages.find((i) => i.id === imgId)) continue
    const dataUrl = await ensureImageCached(imgId)
    if (dataUrl) {
      addInputImage({ id: imgId, dataUrl })
      added++
    }
  }
  showToast('Added ' + added + ' output image(s) to input', 'success')
}

/** 鍒犻櫎澶氭潯浠诲姟 */
export async function removeMultipleTasks(taskIds: string[]) {
  const { tasks, setTasks, inputImages, showToast, clearSelection, selectedTaskIds } = useStore.getState()
  
  if (!taskIds.length) return

  const toDelete = new Set(taskIds)
  const remaining = tasks.filter(t => !toDelete.has(t.id))

  // 鏀堕泦鎵€鏈夎鍒犻櫎浠诲姟鐨勫叧鑱斿浘鐗?
  const deletedImageIds = new Set<string>()
  for (const t of tasks) {
    if (toDelete.has(t.id)) {
      for (const id of t.inputImageIds || []) deletedImageIds.add(id)
      if (t.maskImageId) deletedImageIds.add(t.maskImageId)
      for (const id of t.outputImages || []) deletedImageIds.add(id)
    }
  }

  setTasks(remaining)
  for (const id of taskIds) {
    await dbDeleteTask(id)
  }

  // 鎵惧嚭鍏朵粬浠诲姟浠嶅紩鐢ㄧ殑鍥剧墖
  const stillUsed = new Set<string>()
  for (const t of remaining) {
    for (const id of t.inputImageIds || []) stillUsed.add(id)
    if (t.maskImageId) stillUsed.add(t.maskImageId)
    for (const id of t.outputImages || []) stillUsed.add(id)
  }
  for (const img of inputImages) stillUsed.add(img.id)

  // 鍒犻櫎瀛ょ珛鍥剧墖
  for (const imgId of deletedImageIds) {
    if (!stillUsed.has(imgId)) {
      await deleteImage(imgId)
      deleteImageCaches(imgId)
    }
  }

  // 濡傛灉鍒犻櫎鐨勪换鍔″湪閫変腑鍒楄〃涓紝鍒欑Щ闄?
  const newSelection = selectedTaskIds.filter(id => !toDelete.has(id))
  if (newSelection.length !== selectedTaskIds.length) {
    useStore.getState().setSelectedTaskIds(newSelection)
  }

  showToast('Deleted ' + taskIds.length + ' record(s)', 'success')
}

/** 鍒犻櫎鍗曟潯浠诲姟 */
export async function removeTask(task: TaskRecord) {
  const { tasks, setTasks, inputImages, showToast } = useStore.getState()

  // 鏀堕泦姝や换鍔″叧鑱旂殑鍥剧墖
  const taskImageIds = new Set([
    ...(task.inputImageIds || []),
    ...(task.maskImageId ? [task.maskImageId] : []),
    ...(task.outputImages || []),
  ])

  // 浠庡垪琛ㄧЩ闄?
  const remaining = tasks.filter((t) => t.id !== task.id)
  setTasks(remaining)
  await dbDeleteTask(task.id)

  // 鎵惧嚭鍏朵粬浠诲姟浠嶅紩鐢ㄧ殑鍥剧墖
  const stillUsed = new Set<string>()
  for (const t of remaining) {
    for (const id of t.inputImageIds || []) stillUsed.add(id)
    if (t.maskImageId) stillUsed.add(t.maskImageId)
    for (const id of t.outputImages || []) stillUsed.add(id)
  }
  for (const img of inputImages) stillUsed.add(img.id)

  // 鍒犻櫎瀛ょ珛鍥剧墖
  for (const imgId of taskImageIds) {
    if (!stillUsed.has(imgId)) {
      await deleteImage(imgId)
      deleteImageCaches(imgId)
    }
  }

  showToast('已删除', 'success')
}

/** 娓呯┖鎵€鏈夋暟鎹紙鍚厤缃噸缃級 */
export async function clearAllData() {
  await dbClearTasks()
  await clearImages()
  imageCache.clear()
  imageVariantCache.clear()
  const { setTasks, clearInputImages, clearMaskDraft, setSettings, setParams, showToast } = useStore.getState()
  setTasks([])
  clearInputImages()
  useStore.setState({ dismissedCodexCliPrompts: [] })
  clearMaskDraft()
  setSettings({ ...DEFAULT_SETTINGS })
  setParams({ ...DEFAULT_PARAMS })
  showToast('鎵€鏈夋暟鎹凡娓呯┖', 'success')
}

/** 浠?dataUrl 瑙ｆ瀽鍑?MIME 鎵╁睍鍚嶅拰浜岃繘鍒舵暟鎹?*/
function dataUrlToBytes(dataUrl: string): { ext: string; bytes: Uint8Array } {
  const match = dataUrl.match(/^data:image\/(\w+);base64,/)
  const ext = match?.[1] ?? 'png'
  const b64 = dataUrl.replace(/^data:[^;]+;base64,/, '')
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return { ext, bytes }
}


async function imageSourceToBytes(source: string): Promise<{ ext: string; bytes: Uint8Array }> {
  if (source.startsWith('data:')) return dataUrlToBytes(source)
  const response = await fetch(source, { cache: 'no-store' })
  if (!response.ok) throw new Error('Image download failed: HTTP ' + response.status)
  const contentType = response.headers.get('content-type') || 'image/png'
  const ext = contentType.includes('jpeg') ? 'jpg' : contentType.includes('webp') ? 'webp' : contentType.includes('gif') ? 'gif' : 'png'
  return { ext, bytes: new Uint8Array(await response.arrayBuffer()) }
}

/** 灏嗕簩杩涘埗鏁版嵁杩樺師涓?dataUrl */
function bytesToDataUrl(bytes: Uint8Array, filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? 'png'
  const mimeMap: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }
  const mime = mimeMap[ext] ?? 'image/png'
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return `data:${mime};base64,${btoa(binary)}`
}

/** 瀵煎嚭鏁版嵁涓?ZIP */
export async function exportData() {
  try {
    const tasks = await getAllTasks()
    const images = await getAllImages()
    const { settings } = useStore.getState()
    const exportedAt = Date.now()
    const imageCreatedAtFallback = new Map<string, number>()

    for (const task of tasks) {
      for (const id of [
        ...(task.inputImageIds || []),
        ...(task.maskImageId ? [task.maskImageId] : []),
        ...(task.outputImages || []),
      ]) {
        const prev = imageCreatedAtFallback.get(id)
        if (prev == null || task.createdAt < prev) {
          imageCreatedAtFallback.set(id, task.createdAt)
        }
      }
    }

    const imageFiles: ExportData['imageFiles'] = {}
    const zipFiles: Record<string, Uint8Array | [Uint8Array, { mtime: Date }]> = {}

    for (const img of images) {
      const source = img.dataUrl ?? await ensureImageCached(img.id)
      if (!source) continue
      const { ext, bytes } = await imageSourceToBytes(source)
      const path = `images/${img.id}.${ext}`
      const createdAt = img.createdAt ?? imageCreatedAtFallback.get(img.id) ?? exportedAt
      imageFiles[img.id] = { path, createdAt, source: img.source }
      zipFiles[path] = [bytes, { mtime: new Date(createdAt) }]
    }

    const manifest: ExportData = {
      version: 2,
      exportedAt: new Date(exportedAt).toISOString(),
      settings,
      tasks,
      imageFiles,
    }

    zipFiles['manifest.json'] = [strToU8(JSON.stringify(manifest, null, 2)), { mtime: new Date(exportedAt) }]

    const zipped = zipSync(zipFiles, { level: 6 })
    const blob = new Blob([zipped.buffer as ArrayBuffer], { type: 'application/zip' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `gpt-image-playground-${Date.now()}.zip`
    a.click()
    URL.revokeObjectURL(url)
    useStore.getState().showToast('?????', 'success')
  } catch (e) {
    useStore
      .getState()
      .showToast(
        'Export failed: ' + (e instanceof Error ? e.message : String(e)),
        'error',
      )
  }
}

/** 瀵煎叆 ZIP 鏁版嵁 */
export async function importData(file: File) {
  try {
    const buffer = await file.arrayBuffer()
    const unzipped = unzipSync(new Uint8Array(buffer))

    const manifestBytes = unzipped['manifest.json']
    if (!manifestBytes) throw new Error('ZIP 中缺少 manifest.json')

    const data: ExportData = JSON.parse(strFromU8(manifestBytes))
    if (!data.tasks || !data.imageFiles) throw new Error('无效的数据格式')

    // 杩樺師鍥剧墖
    for (const [id, info] of Object.entries(data.imageFiles)) {
      const bytes = unzipped[info.path]
      if (!bytes) continue
      const dataUrl = bytesToDataUrl(bytes, info.path)
      await putImage({ id, dataUrl, createdAt: info.createdAt, source: info.source })
      imageCache.set(id, dataUrl)
    }

    for (const task of data.tasks) {
      await putTask(task)
    }

    if (data.settings) {
      useStore.getState().setSettings(data.settings)
    }

    const tasks = await getAllTasks()
    useStore.getState().setTasks(tasks)
    useStore
      .getState()
      .showToast('Imported ' + data.tasks.length + ' record(s)', 'success')
  } catch (e) {
    useStore
      .getState()
      .showToast(
        'Import failed: ' + (e instanceof Error ? e.message : String(e)),
        'error',
      )
  }
}

/** 娣诲姞鍥剧墖鍒拌緭鍏ワ紙鏂囦欢涓婁紶锛夆€斺€?浠呮斁鍏ュ唴瀛樼紦瀛橈紝涓嶇珛鍗冲啓鍏ユ湇鍔＄ */
export async function addImageFromFile(file: File): Promise<void> {
  if (!file.type.startsWith('image/')) return
  const dataUrl = await fileToDataUrl(file)
  const id = await hashDataUrl(dataUrl)
  imageCache.set(id, dataUrl)
  useStore.getState().addInputImage({ id, dataUrl })
}

/** 娣诲姞鍥剧墖鍒拌緭鍏ワ紙鍙抽敭鑿滃崟锛夆€斺€?鏀寔 data/blob/http URL */
export async function addImageFromUrl(src: string): Promise<void> {
  const res = await fetch(src)
  const blob = await res.blob()
  if (!blob.type.startsWith('image/')) throw new Error('不是有效的图片')
  const dataUrl = await blobToDataUrl(blob)
  const id = await hashDataUrl(dataUrl)
  imageCache.set(id, dataUrl)
  useStore.getState().addInputImage({ id, dataUrl })
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

