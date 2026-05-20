import { describe, expect, it } from 'vitest'
import { getOriginalImageDownloadUrl } from './imageDownload'

describe('getOriginalImageDownloadUrl', () => {
  it('uses the original image download endpoint for preview images', () => {
    expect(getOriginalImageDownloadUrl('/api/images/image-a/preview')).toBe('/api/images/image-a/download')
  })

  it('uses the original image download endpoint for thumbnail images', () => {
    expect(getOriginalImageDownloadUrl('/api/images/image-a/thumbnail')).toBe('/api/images/image-a/download')
  })

  it('uses the original image download endpoint for content images', () => {
    expect(getOriginalImageDownloadUrl('/api/images/image-a/content')).toBe('/api/images/image-a/download')
  })

  it('keeps query strings when replacing variant endpoints', () => {
    expect(getOriginalImageDownloadUrl('/api/images/image-a/preview?v=1')).toBe('/api/images/image-a/download?v=1')
  })

  it('leaves data urls unchanged', () => {
    expect(getOriginalImageDownloadUrl('data:image/png;base64,aGVsbG8=')).toBe('data:image/png;base64,aGVsbG8=')
  })
})

