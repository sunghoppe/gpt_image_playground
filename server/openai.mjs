const MIME_MAP = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

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

export function buildUpstreamUrl(settings, path) {
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

async function getApiErrorMessage(response) {
  let errorMsg = `HTTP ${response.status}`
  try {
    const payload = await response.json()
    if (payload?.error?.message) errorMsg = payload.error.message
    else if (payload?.error) errorMsg = typeof payload.error === 'string' ? payload.error : JSON.stringify(payload.error)
    else if (payload?.message) errorMsg = payload.message
  } catch {
    try {
      const text = await response.text()
      if (text) errorMsg = text
    } catch {
      /* ignore */
    }
  }
  return errorMsg
}

function normalizeBase64Image(value, fallbackMime) {
  return value.startsWith('data:') ? value : `data:${fallbackMime};base64,${value}`
}

function pickActualParams(payload) {
  const actualParams = {}
  for (const key of ['quality', 'size', 'output_format', 'background', 'moderation']) {
    if (payload?.[key] != null) actualParams[key] = payload[key]
  }
  return Object.keys(actualParams).length ? actualParams : undefined
}

function mergeActualParams(...sources) {
  const merged = Object.assign({}, ...sources.filter((source) => source && Object.keys(source).length))
  return Object.keys(merged).length ? merged : undefined
}

function createRequestHeaders(settings) {
  const headers = {
    'Cache-Control': 'no-store, no-cache, max-age=0',
    Pragma: 'no-cache',
  }
  if (settings.apiProvider === 'azure') headers['api-key'] = settings.apiKey
  else headers.Authorization = `Bearer ${settings.apiKey}`
  return headers
}

function createResponsesImageTool(params, isEdit, settings, maskDataUrl) {
  const tool = {
    type: 'image_generation',
    action: isEdit ? 'edit' : 'generate',
    size: params.size,
    output_format: params.output_format,
  }
  if (!settings.codexCli) tool.quality = params.quality
  if (params.output_format !== 'png' && params.output_compression != null) tool.output_compression = params.output_compression
  if (maskDataUrl) tool.input_image_mask = { image_url: maskDataUrl }
  return tool
}

function createResponsesInput(prompt, inputImageDataUrls) {
  const text = `Use the following text as the complete prompt. Do not rewrite it:\n${prompt}`
  if (!inputImageDataUrls.length) return text
  return [{
    role: 'user',
    content: [
      { type: 'input_text', text },
      ...inputImageDataUrls.map((dataUrl) => ({ type: 'input_image', image_url: dataUrl })),
    ],
  }]
}

function parseResponsesImageResults(payload, fallbackMime) {
  const results = []
  const output = Array.isArray(payload?.output) ? payload.output : []
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : []
    for (const entry of content) {
      const image = entry?.result || entry?.image || entry?.b64_json
      if (typeof image === 'string') {
        results.push({
          image: normalizeBase64Image(image, fallbackMime),
          revisedPrompt: typeof entry.revised_prompt === 'string' ? entry.revised_prompt : undefined,
          actualParams: pickActualParams(entry),
        })
      }
    }
  }
  return results
}

export async function callImageApi({ settings, prompt, params, inputImageDataUrls = [], maskDataUrl }) {
  return settings.apiMode === 'responses'
    ? callResponsesImageApi({ settings, prompt, params, inputImageDataUrls, maskDataUrl })
    : callImagesApi({ settings, prompt, params, inputImageDataUrls, maskDataUrl })
}

async function callImagesApi(options) {
  const { settings, prompt: originalPrompt, params, inputImageDataUrls, maskDataUrl } = options
  const prompt = settings.codexCli
    ? `Use the following text as the complete prompt. Do not rewrite it:\n${originalPrompt}`
    : originalPrompt
  const mime = MIME_MAP[params.output_format] || 'image/png'
  const headers = createRequestHeaders(settings)
  const isEdit = inputImageDataUrls.length > 0
  let response

  if (isEdit) {
    const formData = new FormData()
    if (settings.apiProvider !== 'azure') formData.append('model', settings.model)
    formData.append('prompt', prompt)
    formData.append('size', params.size)
    formData.append('output_format', params.output_format)
    formData.append('moderation', params.moderation)
    if (!settings.codexCli) formData.append('quality', params.quality)
    if (params.output_format !== 'png' && params.output_compression != null) formData.append('output_compression', String(params.output_compression))
    if (params.n > 1) formData.append('n', String(params.n))
    for (let index = 0; index < inputImageDataUrls.length; index += 1) {
      const response = await fetch(inputImageDataUrls[index])
      const blob = await response.blob()
      const ext = blob.type.split('/')[1] || 'png'
      formData.append('image[]', blob, `input-${index + 1}.${ext}`)
    }
    if (maskDataUrl) {
      const maskResponse = await fetch(maskDataUrl)
      formData.append('mask', await maskResponse.blob(), 'mask.png')
    }
    response = await fetch(buildUpstreamUrl(settings, 'images/edits'), { method: 'POST', headers, body: formData })
  } else {
    const body = {
      ...(settings.apiProvider === 'azure' ? {} : { model: settings.model }),
      prompt,
      size: params.size,
      output_format: params.output_format,
      moderation: params.moderation,
    }
    if (!settings.codexCli) body.quality = params.quality
    if (params.output_format !== 'png' && params.output_compression != null) body.output_compression = params.output_compression
    if (params.n > 1) body.n = params.n
    response = await fetch(buildUpstreamUrl(settings, 'images/generations'), {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  if (!response.ok) throw new Error(await getApiErrorMessage(response))
  const payload = await response.json()
  const data = payload.data
  if (!Array.isArray(data) || !data.length) throw new Error('接口未返回图片数据')
  const images = []
  const revisedPrompts = []
  for (const item of data) {
    if (item.b64_json) {
      images.push(normalizeBase64Image(item.b64_json, mime))
      revisedPrompts.push(typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined)
    }
  }
  if (!images.length) throw new Error('接口未返回可用图片数据')
  const actualParams = mergeActualParams(pickActualParams(payload))
  return { images, actualParams, actualParamsList: images.map(() => actualParams), revisedPrompts }
}

async function callResponsesImageApi(options) {
  const { settings, prompt, params, inputImageDataUrls, maskDataUrl } = options
  const mime = MIME_MAP[params.output_format] || 'image/png'
  const body = {
    ...(settings.apiProvider === 'azure' ? {} : { model: settings.model }),
    input: createResponsesInput(prompt, inputImageDataUrls),
    tools: [createResponsesImageTool(params, inputImageDataUrls.length > 0, settings, maskDataUrl)],
    tool_choice: 'required',
  }
  const response = await fetch(buildUpstreamUrl(settings, 'responses'), {
    method: 'POST',
    headers: { ...createRequestHeaders(settings), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(await getApiErrorMessage(response))
  const payload = await response.json()
  const imageResults = parseResponsesImageResults(payload, mime)
  if (!imageResults.length) throw new Error('接口未返回可用图片数据')
  const actualParams = mergeActualParams(imageResults[0]?.actualParams ?? {})
  return {
    images: imageResults.map((result) => result.image),
    actualParams,
    actualParamsList: imageResults.map((result) => mergeActualParams(result.actualParams ?? {})),
    revisedPrompts: imageResults.map((result) => result.revisedPrompt),
  }
}
