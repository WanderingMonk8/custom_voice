export interface FreesoundSearchResult {
  id: number
  name: string
  username: string
  license: string
  duration: number
  url: string
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
    result.push({ id: row.id as number, name: row.name.trim().slice(0, 160), username: row.username.trim().slice(0, 120), license: row.license.trim().slice(0, 300), duration: row.duration, url: `https://freesound.org/s/${row.id}/` })
  }
  return result
}
