import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import sharp from 'sharp'

export const IMAGE_VARIANTS = {
  thumbnail: {
    maxWidth: Number.parseInt(process.env.IMAGE_THUMBNAIL_MAX_WIDTH || '480', 10),
    quality: Number.parseInt(process.env.IMAGE_THUMBNAIL_QUALITY || '78', 10),
  },
  preview: {
    maxWidth: Number.parseInt(process.env.IMAGE_PREVIEW_MAX_WIDTH || '1600', 10),
    quality: Number.parseInt(process.env.IMAGE_PREVIEW_QUALITY || '86', 10),
  },
}

export function getImageVariantRelativePath(id, variant) {
  const safeId = String(id).replace(/[^a-zA-Z0-9._-]/g, '_')
  return join('images', variant, safeId.slice(0, 2) || 'xx', safeId.slice(2, 4) || 'xx', `${safeId}.webp`)
}

export async function createImageVariantFromBytes({ dataDir, id, variant, bytes }) {
  const options = IMAGE_VARIANTS[variant]
  if (!options) return undefined
  const filePath = getImageVariantRelativePath(id, variant)
  const absolutePath = join(dataDir, filePath)
  await mkdir(dirname(absolutePath), { recursive: true })
  try {
    const variantBytes = await sharp(bytes, { animated: false })
      .rotate()
      .resize({ width: options.maxWidth, height: options.maxWidth, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: options.quality, effort: 4 })
      .toBuffer()
    await writeFile(absolutePath, variantBytes)
    return { filePath, sizeBytes: variantBytes.length }
  } catch {
    return undefined
  }
}

export async function readImageMetadata(bytes) {
  try {
    const metadata = await sharp(bytes, { animated: false }).metadata()
    return {
      width: metadata.width,
      height: metadata.height,
      format: metadata.format,
    }
  } catch {
    return {}
  }
}
