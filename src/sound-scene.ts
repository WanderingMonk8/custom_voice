import type { FavoriteSound } from './sound-library'

export interface SoundSceneCue {
  kind: 'event' | 'ambience'
  action: 'play' | 'stop'
  assetId?: string
  anchor: string
  position: 'before' | 'after'
  offset: number
}

/** Reject malformed or ungrounded candidates; never invent an anchor. */
export function parseSoundScenePlan(raw: string, message: string, favorites: readonly FavoriteSound[]): SoundSceneCue[] {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')
  let parsed: unknown
  try { parsed = JSON.parse(cleaned) } catch { return [] }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { cues?: unknown }).cues)) return []
  const available = new Map(favorites.map(item => [item.id, item]))
  const result: SoundSceneCue[] = []
  const seen = new Set<string>()
  for (const value of (parsed as { cues: unknown[] }).cues.slice(0, 32)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const item = value as Record<string, unknown>
    if ((item.kind !== 'event' && item.kind !== 'ambience') || (item.action !== 'play' && item.action !== 'stop')
      || (item.position !== 'before' && item.position !== 'after') || typeof item.anchor !== 'string'
      || item.anchor.length < 3 || item.anchor.length > 200) continue
    if (item.action === 'stop' && item.kind !== 'ambience') continue
    const offset = message.indexOf(item.anchor)
    if (offset < 0 || message.lastIndexOf(item.anchor) !== offset) continue
    const assetId = typeof item.assetId === 'string' ? item.assetId : ''
    if (item.action === 'play' && (!available.has(assetId) || available.get(assetId)?.kind !== item.kind)) continue
    const key = `${item.kind}\u0000${item.action}\u0000${assetId}\u0000${offset}\u0000${item.position}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ kind: item.kind, action: item.action, ...(item.action === 'play' ? { assetId } : {}), anchor: item.anchor, position: item.position, offset })
    if (result.length >= 8) break
  }
  return result.sort((a, b) => a.offset - b.offset)
}
