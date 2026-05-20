export function getOriginalImageDownloadUrl(src: string): string {
  const previewMatch = src.match(/^(.*\/api\/images\/[^/?#]+)\/(?:preview|thumbnail)([?#].*)?$/)
  if (previewMatch) return `${previewMatch[1]}/download${previewMatch[2] ?? ''}`

  const contentMatch = src.match(/^(.*\/api\/images\/[^/?#]+)\/content([?#].*)?$/)
  if (contentMatch) return `${contentMatch[1]}/download${contentMatch[2] ?? ''}`

  return src
}

