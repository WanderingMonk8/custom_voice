import type { FavoriteSound } from './sound-library'
import type { VoicePlanSegment } from './core'

export interface SoundSceneCue {
  kind: 'event' | 'ambience'
  action: 'play' | 'stop'
  assetId?: string
  anchor: string
  position: 'before' | 'after'
  offset: number
}

export interface MissingSoundSuggestion {
  kind: 'event' | 'ambience'
  query: string
  anchor: string
}

/** Only expose short, grounded search suggestions; never turn model output into a URL. */
export function parseMissingSoundSuggestions(raw: string, message: string): MissingSoundSuggestion[] {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')
  let parsed: unknown
  try { parsed = JSON.parse(cleaned) } catch { return [] }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { missing?: unknown }).missing)) return []
  const result: MissingSoundSuggestion[] = []
  const seen = new Set<string>()
  for (const value of (parsed as { missing: unknown[] }).missing.slice(0, 12)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const item = value as Record<string, unknown>
    if ((item.kind !== 'event' && item.kind !== 'ambience') || typeof item.query !== 'string' || typeof item.anchor !== 'string') continue
    const query = item.query.trim().replace(/\s+/gu, ' ')
    if (query.length < 3 || query.length > 60 || !/^[\p{L}\p{N} '\-]+$/u.test(query) || /https?|www/iu.test(query)) continue
    if (item.anchor.length < 3 || item.anchor.length > 200 || !message.includes(item.anchor) || message.indexOf(item.anchor) !== message.lastIndexOf(item.anchor)) continue
    const key = `${item.kind}:${query.toLocaleLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key); result.push({ kind: item.kind, query, anchor: item.anchor })
    if (result.length >= 4) break
  }
  return result
}

export interface SoundSceneSegment {
  start: number
  end: number
}

/** Add natural narration boundaries without changing dialogue or vocal-tag jobs. */
export function splitNarrationForSoundEvents(segments: readonly VoicePlanSegment[]): VoicePlanSegment[] {
  const result: VoicePlanSegment[] = []
  for (const segment of segments) {
    if (segment.originalSpeech !== undefined || segment.tagId || /[\[\]<>]/u.test(segment.text)) { result.push(segment); continue }
    // Avoid splitting obvious abbreviations and decimals into unrelated jobs.
    if (/\b(?:Dr|Mr|Mrs|Ms|Prof|St|vs|etc)\.|\d\.\d/iu.test(segment.text)) { result.push(segment); continue }
    const fragments = segment.text.match(/[^,;.!?]+[,;.!?]+(?:["'”’)]*)|[^,;.!?]+$/gu)?.map(part => part.trim()).filter(Boolean) ?? []
    const parts: string[] = []
    let pending = ''
    for (const fragment of fragments) {
      pending = pending ? `${pending} ${fragment}` : fragment
      if (pending.length >= 8) { parts.push(pending); pending = '' }
    }
    if (pending) {
      if (parts.length) parts[parts.length - 1] += ` ${pending}`
      else parts.push(pending)
    }
    // Keep the request count bounded without giving up every useful boundary.
    while (parts.length > 12) {
      let shortest = 0
      for (let i = 1; i < parts.length - 1; i++) if (parts[i].length + parts[i + 1].length < parts[shortest].length + parts[shortest + 1].length) shortest = i
      parts.splice(shortest, 2, `${parts[shortest]} ${parts[shortest + 1]}`)
    }
    if (parts.length < 2) result.push(segment)
    else for (const text of parts) result.push({ ...segment, text })
  }
  return result
}

/** Small deterministic shortlist for speculative local reads, never a cue decision. */
export function shortlistSoundAssets(message: string, favorites: readonly FavoriteSound[], limit = 8, kinds: readonly FavoriteSound['kind'][] = ['event', 'ambience']): FavoriteSound[] {
  const words = new Set((message.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []))
  return favorites.filter(sound => kinds.includes(sound.kind)).map((sound, order) => {
    const terms = new Set(([sound.name, sound.description, ...sound.tags].join(' ').toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []))
    let score = 0
    for (const term of terms) if (words.has(term)) score++
    return { sound, score, order }
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, Math.max(0, Math.min(8, Math.floor(limit)))).map(item => item.sound)
}

/** Find the latest ambience instruction already reached, even if its asset was late. */
export function ambienceInstructionAtBoundary(
  mapped: readonly { cue: SoundSceneCue; boundary: number }[], boundary: number,
): { key: string; assetId: string } | null {
  let latest: { cue: SoundSceneCue; boundary: number; index: number } | null = null
  mapped.forEach((item, index) => {
    if (item.cue.kind !== 'ambience' || item.boundary > boundary) return
    if (!latest || item.boundary > latest.boundary || (item.boundary === latest.boundary && index > latest.index)) latest = { ...item, index }
  })
  const instruction = latest as { cue: SoundSceneCue; boundary: number; index: number } | null
  if (!instruction || instruction.cue.action !== 'play' || !instruction.cue.assetId) return null
  return { key: `${instruction.boundary}:${instruction.index}:${instruction.cue.assetId}`, assetId: instruction.cue.assetId }
}

/** Insert events at voice boundaries, preserving both voice and event order. */
export function interleaveSoundEvents<T>(voices: readonly T[], events: ReadonlyMap<number, readonly T[]>): T[] {
  const result: T[] = []
  for (let index = 0; index <= voices.length; index++) {
    result.push(...(events.get(index) ?? []))
    if (index < voices.length) result.push(voices[index])
  }
  return result
}

/** Select competing cues for one batched Decision-model review. */
export function competingSoundCueIndexes(cues: readonly SoundSceneCue[]): number[] {
  const selected = new Set<number>()
  for (let i = 0; i < cues.length; i++) {
    if (cues[i].action !== 'play') continue
    for (let j = i + 1; j < cues.length; j++) {
      if (cues[j].action === 'play' && cues[i].kind === cues[j].kind
        && cues[i].offset < cues[j].offset + cues[j].anchor.length
        && cues[j].offset < cues[i].offset + cues[i].anchor.length) { selected.add(i); selected.add(j) }
    }
  }
  return [...selected]
}

/** Align unmodified clip text to its source, tolerating whitespace only.
 * Duplicate or missing text stays unaligned rather than guessing an occurrence.
 * Null entries retain clip indexes so later cue boundaries cannot shift.
 */
export function alignSoundSourceSegments(message: string, clipTexts: readonly string[]): Array<SoundSceneSegment | null> {
  const normalize = (input: string): { text: string; offsets: number[] } => {
    let text = ''
    const offsets: number[] = []
    for (let i = 0; i < input.length; i++) {
      const char = input[i]
      if (/\s/u.test(char)) {
        if (!text || text.endsWith(' ')) continue
        text += ' '; offsets.push(i)
      } else { text += char; offsets.push(i) }
    }
    if (text.endsWith(' ')) { text = text.slice(0, -1); offsets.pop() }
    return { text, offsets }
  }
  const source = normalize(message)
  const matches = clipTexts.map(clip => {
    const text = normalize(clip).text
    if (!text) return null
    const start = source.text.indexOf(text)
    if (start < 0 || source.text.lastIndexOf(text) !== start) return null
    return { start: source.offsets[start], end: source.offsets[start + text.length - 1] + 1 }
  })
  // Any overlap or out-of-order pair is ambiguous; discard both, not the clip index.
  const invalid = new Set<number>()
  for (let i = 0; i < matches.length; i++) {
    for (let j = i + 1; j < matches.length; j++) {
      if (matches[i] && matches[j] && matches[i]!.end > matches[j]!.start) {
        invalid.add(i); invalid.add(j)
      }
    }
  }
  return matches.map((match, index) => invalid.has(index) ? null : match)
}

/** Map validated source anchors to clip boundaries; never split or overlap a voice clip. */
export function mapSoundCueBoundaries(cues: readonly SoundSceneCue[], segments: readonly (SoundSceneSegment | null)[], messageLength: number): Array<{ cue: SoundSceneCue; boundary: number }> {
  let lastEnd = 0
  for (const segment of segments) {
    if (!segment) continue
    if (!Number.isSafeInteger(segment.start) || !Number.isSafeInteger(segment.end)
      || segment.start < lastEnd || segment.end <= segment.start || segment.end > messageLength) throw new Error('Invalid scene segment boundaries.')
    lastEnd = segment.end
  }
  const mapped: Array<{ cue: SoundSceneCue; boundary: number }> = []
  for (const cue of cues) {
    const end = cue.offset + cue.anchor.length
    const index = segments.findIndex(segment => segment !== null && cue.offset >= segment.start && end <= segment.end)
    if (index < 0) continue
    mapped.push({ cue, boundary: cue.position === 'before' ? index : index + 1 })
  }
  return mapped
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
