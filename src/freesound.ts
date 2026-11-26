export interface FreesoundSearchResult {
  id: number
  name: string
  username: string
  license: string
  duration: number
  url: string
  previewUrl?: string
}

/** Accept only canonical Freesound MP3 previews tied to the result ID. */
export function safeFreesoundPreviewUrl(value: unknown, id: number): string | undefined {
  if (typeof value !== 'string' || !Number.isSafeInteger(id) || id < 1) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return undefined
    const prefix = url.hostname === 'cdn.freesound.org' ? '/previews/' : url.hostname === 'freesound.org' ? '/data/previews/' : ''
    if (!prefix || !new RegExp(`^${prefix}\\d+/${id}_[0-9]+-hq\\.mp3$`, 'u').test(url.pathname)) return undefined
    return url.href
  } catch { return undefined }
}

/** Accept only bounded metadata; construct links locally, never trust remote URLs. */
export function parseFreesoundSearch(payload: unknown): FreesoundSearchResult[] {
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { results?: unknown }).results)) throw new Error('Unexpected Freesound search response.')
  const result: FreesoundSearchResult[] = []
  for (const value of (payload as { results: unknown[] }).results.slice(0, 20)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const row = value as Record<string, unknown>
    if (!Number.isSafeInteger(row.id) || (row.id as number) < 1 || typeof row.name !== 'string' || !row.name.trim()
      || typeof row.username !== 'string' || !row.username.trim() || typeof row.license !== 'string' || !row.license.trim()
      || typeof row.duration !== 'number' || !Number.isFinite(row.duration) || row.duration < 0) continue
    const previews = row.previews && typeof row.previews === 'object' && !Array.isArray(row.previews) ? row.previews as Record<string, unknown> : {}
    const previewUrl = safeFreesoundPreviewUrl(previews['preview-hq-mp3'], row.id as number)
    result.push({ id: row.id as number, name: row.name.trim().slice(0, 160), username: row.username.trim().slice(0, 120), license: row.license.trim().slice(0, 300), duration: row.duration, url: `https://freesound.org/s/${row.id}/`, ...(previewUrl ? { previewUrl } : {}) })
  }
  return result
}
