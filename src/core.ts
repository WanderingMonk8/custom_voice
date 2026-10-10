export const CONFIG_KEY = 'chat_voice'
export const DEFAULT_MESSAGE_LIMIT = 20
export const MIN_MESSAGE_LIMIT = 1
export const MAX_MESSAGE_LIMIT = 500

export interface VoiceRef {
  connectionId: string
  voice: string
}

export interface VoiceOverrides {
  narrator?: VoiceRef
  characters?: Record<string, VoiceRef>
}

export interface ChatVoiceConfig {
  version: 5
  messageLimit: number
  connectionId: string
  narratorVoice: string
  characterVoices: Record<string, string>
  detectedCharacters: Array<{ id: string; name: string; messageCount: number }>
  managedCharacterIds: string[]
  parsedMessages: Record<string, CachedMessageParse>
}

export interface MessageLike {
  id?: string
  is_user: boolean
  name: string
  content?: string
  extra?: Record<string, unknown>
}

export interface CachedMessageParse {
  contentHash: string
  segments: PlaybackSegment[]
}

export interface LlmParsedSegment {
  type: 'narration' | 'speech'
  text: string
  speaker: string | null
}

export interface LlmParsedMessage {
  id: string
  segments: LlmParsedSegment[]
}

export interface CardCastMember {
  cardId: string
  name: string
}

export interface CharacterLike {
  id: string
  name: string
}

export interface DetectedCharacter extends CharacterLike {
  messageCount: number
}

export interface PlaybackSegment {
  text: string
  speakerId: string | null
}

export interface VoicePlanSegment {
  text: string
  voice: string
}

export interface PcmAudioSegment {
  sampleRate: number
  channels: Float32Array[]
}

/** Combine decoded audio into one PCM WAV so the host does not need FFmpeg to save it. */
export function encodeConcatenatedWav(segments: PcmAudioSegment[]): ArrayBuffer {
  const usable = segments.filter(segment => (
    Number.isFinite(segment.sampleRate)
    && segment.sampleRate > 0
    && segment.channels.length > 0
    && segment.channels.some(channel => channel.length > 0)
  ))
  if (usable.length === 0) throw new Error('No decoded audio is available to save.')

  const sampleRate = Math.max(...usable.map(segment => Math.round(segment.sampleRate)))
  const channelCount = Math.max(...usable.map(segment => segment.channels.length))
  const frameCounts = usable.map(segment => {
    const sourceFrames = Math.max(...segment.channels.map(channel => channel.length))
    return Math.max(1, Math.round(sourceFrames * sampleRate / segment.sampleRate))
  })
  const totalFrames = frameCounts.reduce((sum, count) => sum + count, 0)
  const bytesPerSample = 2
  const dataLength = totalFrames * channelCount * bytesPerSample
  const output = new ArrayBuffer(44 + dataLength)
  const view = new DataView(output)
  const writeText = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index))
    }
  }

  writeText(0, 'RIFF')
  view.setUint32(4, 36 + dataLength, true)
  writeText(8, 'WAVE')
  writeText(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channelCount, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channelCount * bytesPerSample, true)
  view.setUint16(32, channelCount * bytesPerSample, true)
  view.setUint16(34, bytesPerSample * 8, true)
  writeText(36, 'data')
  view.setUint32(40, dataLength, true)

  let writeOffset = 44
  usable.forEach((segment, segmentIndex) => {
    const outputFrames = frameCounts[segmentIndex]
    const sourceFrames = Math.max(...segment.channels.map(channel => channel.length))
    for (let frame = 0; frame < outputFrames; frame += 1) {
      const sourcePosition = outputFrames === 1 ? 0 : frame * (sourceFrames - 1) / (outputFrames - 1)
      const lower = Math.floor(sourcePosition)
      const upper = Math.min(sourceFrames - 1, lower + 1)
      const fraction = sourcePosition - lower
      for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
        const channel = segment.channels[Math.min(channelIndex, segment.channels.length - 1)]
        const lowerValue = channel[Math.min(lower, channel.length - 1)] ?? 0
        const upperValue = channel[Math.min(upper, channel.length - 1)] ?? lowerValue
        const sample = Math.max(-1, Math.min(1, lowerValue + (upperValue - lowerValue) * fraction))
        view.setInt16(writeOffset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
        writeOffset += bytesPerSample
      }
    }
  })

  return output
}

/** Reduce TTS requests without changing playback order or voice boundaries. */
export function mergeVoicePlan(segments: VoicePlanSegment[]): VoicePlanSegment[] {
  const result: VoicePlanSegment[] = []
  for (const segment of segments) {
    const paragraphs = segment.text
      .trim()
      .split(/\n\s*\n+/)
      .map(paragraph => paragraph.replace(/\s*\n\s*/g, ' ').trim())
      .filter(Boolean)
    for (let index = 0; index < paragraphs.length; index += 1) {
      const text = paragraphs[index]
      const previous = result.at(-1)
      if (index === 0 && previous?.voice === segment.voice) {
        previous.text = `${previous.text} ${text}`
      } else {
        result.push({ text, voice: segment.voice })
      }
    }
  }
  return result
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function clampMessageLimit(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_MESSAGE_LIMIT
  return Math.min(MAX_MESSAGE_LIMIT, Math.max(MIN_MESSAGE_LIMIT, Math.round(numeric)))
}

export function readVoiceRef(value: unknown): VoiceRef | null {
  if (!isRecord(value)) return null
  if (typeof value.connectionId !== 'string' || !value.connectionId.trim()) return null
  return {
    connectionId: value.connectionId.trim(),
    voice: typeof value.voice === 'string' ? value.voice.trim() : '',
  }
}

function readStringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (key && typeof item === 'string') result[key] = item.trim().slice(0, 512)
  }
  return result
}

function readParsedMessages(value: unknown): Record<string, CachedMessageParse> {
  if (!isRecord(value)) return {}
  const result: Record<string, CachedMessageParse> = {}
  for (const [messageId, item] of Object.entries(value).slice(0, MAX_MESSAGE_LIMIT)) {
    if (!messageId || !isRecord(item) || typeof item.contentHash !== 'string' || !Array.isArray(item.segments)) continue
    const segments: PlaybackSegment[] = []
    for (const segment of item.segments.slice(0, 500)) {
      if (!isRecord(segment) || typeof segment.text !== 'string') continue
      const text = segment.text.trim().slice(0, 20_000)
      const speakerId = segment.speakerId === null || typeof segment.speakerId === 'string'
        ? segment.speakerId
        : null
      if (text) segments.push({ text, speakerId: speakerId?.slice(0, 256) ?? null })
    }
    if (segments.length > 0) {
      result[messageId.slice(0, 256)] = {
        contentHash: item.contentHash.slice(0, 32),
        segments,
      }
    }
  }
  return result
}

function readDetectedCharacters(
  value: unknown,
  fallbackIds: string[],
): Array<{ id: string; name: string; messageCount: number }> {
  if (!Array.isArray(value)) {
    return [...new Set(fallbackIds)].map((id) => ({ id, name: '', messageCount: 0 }))
  }
  const result: Array<{ id: string; name: string; messageCount: number }> = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id || seen.has(item.id)) continue
    seen.add(item.id)
    const count = typeof item.messageCount === 'number' && Number.isFinite(item.messageCount)
      ? Math.max(0, Math.round(item.messageCount))
      : 0
    result.push({
      id: item.id,
      name: typeof item.name === 'string' ? item.name.trim().slice(0, 128) : '',
      messageCount: count,
    })
  }
  return result
}

export function readVoiceOverrides(metadata: Record<string, unknown>): VoiceOverrides {
  const raw = metadata.voiceOverrides
  if (!isRecord(raw)) return {}
  const narrator = readVoiceRef(raw.narrator) ?? undefined
  const characters: Record<string, VoiceRef> = {}
  if (isRecord(raw.characters)) {
    for (const [id, value] of Object.entries(raw.characters)) {
      const ref = readVoiceRef(value)
      if (id && ref) characters[id] = ref
    }
  }
  return {
    ...(narrator ? { narrator } : {}),
    ...(Object.keys(characters).length > 0 ? { characters } : {}),
  }
}

export function readConfig(
  metadata: Record<string, unknown>,
  candidateCharacterIds: string[],
): ChatVoiceConfig {
  const raw = isRecord(metadata[CONFIG_KEY]) ? metadata[CONFIG_KEY] : {}
  const overrides = readVoiceOverrides(metadata)
  const storedVoices = readStringMap(raw.characterVoices)
  const characterVoices = { ...storedVoices }

  for (const characterId of candidateCharacterIds) {
    if (!(characterId in characterVoices)) {
      characterVoices[characterId] = overrides.characters?.[characterId]?.voice ?? ''
    }
  }

  const managedCharacterIds = Array.isArray(raw.managedCharacterIds)
    ? raw.managedCharacterIds.filter((id): id is string => typeof id === 'string' && !!id)
    : Object.keys(storedVoices)

  const inferredConnection = overrides.narrator?.connectionId
    ?? candidateCharacterIds
      .map((id) => overrides.characters?.[id]?.connectionId)
      .find((id): id is string => !!id)
    ?? ''

  const legacyDetectedIds = Object.keys(storedVoices).length > 0
    ? Object.keys(storedVoices)
    : managedCharacterIds

  return {
    version: 5,
    messageLimit: clampMessageLimit(raw.messageLimit),
    connectionId: typeof raw.connectionId === 'string'
      ? raw.connectionId.trim().slice(0, 128)
      : inferredConnection,
    narratorVoice: typeof raw.narratorVoice === 'string'
      ? raw.narratorVoice.trim().slice(0, 512)
      : overrides.narrator?.voice ?? '',
    characterVoices,
    detectedCharacters: readDetectedCharacters(raw.detectedCharacters, legacyDetectedIds),
    managedCharacterIds: [...new Set(managedCharacterIds)],
    parsedMessages: readParsedMessages(raw.parsedMessages),
  }
}

export function hashMessageContent(content: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < content.length; index++) {
    hash ^= content.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${content.length.toString(36)}-${(hash >>> 0).toString(36)}`
}

function extractGenerationText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!isRecord(value)) return ''
  if (typeof value.content === 'string') return value.content
  if (isRecord(value.data) && typeof value.data.content === 'string') return value.data.content
  return ''
}

export function parseLlmSegmentation(
  response: unknown,
  allowedMessageIds: ReadonlySet<string>,
): LlmParsedMessage[] {
  let text = extractGenerationText(response).trim()
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.messages)) return []
  const result: LlmParsedMessage[] = []
  const seen = new Set<string>()
  for (const item of parsed.messages) {
    if (!isRecord(item) || typeof item.id !== 'string' || seen.has(item.id) || !allowedMessageIds.has(item.id)) continue
    if (!Array.isArray(item.segments)) continue
    const segments: LlmParsedSegment[] = []
    for (const segment of item.segments.slice(0, 500)) {
      if (!isRecord(segment) || typeof segment.text !== 'string') continue
      const text = segment.text.trim().slice(0, 20_000)
      if (!text) continue
      const type = segment.type === 'speech' ? 'speech' : segment.type === 'narration' ? 'narration' : null
      if (!type) continue
      const speaker = type === 'speech' && typeof segment.speaker === 'string'
        ? normalizeSpeakerName(segment.speaker).slice(0, 128) || null
        : null
      segments.push({ type, text, speaker })
    }
    if (segments.length === 0) continue
    seen.add(item.id)
    result.push({ id: item.id, segments })
  }
  return result
}

export function parseCardCast(
  response: unknown,
  allowedCardIds: ReadonlySet<string>,
): CardCastMember[] {
  let text = extractGenerationText(response).trim()
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.characters)) return []
  const result: CardCastMember[] = []
  const seen = new Set<string>()
  for (const item of parsed.characters.slice(0, 200)) {
    if (!isRecord(item) || typeof item.cardId !== 'string' || !allowedCardIds.has(item.cardId)) continue
    if (typeof item.name !== 'string') continue
    const name = normalizeSpeakerName(item.name).slice(0, 128)
    const key = `${item.cardId}\u0000${name.toLowerCase()}`
    if (!name || seen.has(key)) continue
    seen.add(key)
    result.push({ cardId: item.cardId, name })
  }
  return result
}

export function normalizeSpeakerName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ')
}

export function speakerAliases(value: string): string[] {
  const aliases: string[] = []
  const seen = new Set<string>()
  for (const part of value.split('/')) {
    const alias = normalizeSpeakerName(part)
    const key = alias.toLowerCase()
    if (!alias || seen.has(key)) continue
    seen.add(key)
    aliases.push(alias)
  }
  return aliases
}

const SPEAKER_TITLES = new Set([
  'mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'prof', 'sir', 'lady', 'lord',
  'capt', 'captain', 'sgt', 'sergeant',
])

function firstNameAlias(value: string): string | null {
  const aliases = speakerAliases(value)
  const words = aliases[0]?.split(/\s+/u) ?? []
  if (words.length < 2) return null
  const title = words[0].replace(/\.$/u, '').toLowerCase()
  const firstName = words[SPEAKER_TITLES.has(title) ? 1 : 0]
  if (!firstName || aliases.some(alias => alias.toLowerCase() === firstName.toLowerCase())) return null
  return firstName
}

export function addScannedFirstNameAliases<T extends CharacterLike>(characters: T[]): T[] {
  const candidates = new Map<string, string>()
  const owners = new Map<string, Set<string>>()
  const addOwner = (alias: string, id: string) => {
    const key = alias.toLowerCase()
    const ids = owners.get(key) ?? new Set<string>()
    ids.add(id)
    owners.set(key, ids)
  }

  for (const character of characters) {
    for (const alias of speakerAliases(character.name)) addOwner(alias, character.id)
    const candidate = firstNameAlias(character.name)
    if (candidate) {
      candidates.set(character.id, candidate)
      addOwner(candidate, character.id)
    }
  }

  return characters.map((character) => {
    const candidate = candidates.get(character.id)
    if (!candidate || owners.get(candidate.toLowerCase())?.size !== 1) return character
    const name = [...speakerAliases(character.name), candidate].join(' / ')
    return name.length <= 128 ? { ...character, name } : character
  })
}

export function npcSpeakerId(name: string): string {
  return `npc:${normalizeSpeakerName(name).toLowerCase()}`
}

const SPEAKER_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}\p{M} ._'’\-]{0,63}$/u
const NAMED_DIALOGUE_RE = /^(?:\s*(?:[-*]\s*)?)?(?:\*\*)?([^:\n]{1,64}?)(?:\*\*)?\s*:\s*["“]([\s\S]*?)["”]/gm

export function extractNamedDialogue(content: string): Array<{ name: string; text: string; start: number; end: number }> {
  const result: Array<{ name: string; text: string; start: number; end: number }> = []
  for (const match of content.matchAll(NAMED_DIALOGUE_RE)) {
    const name = normalizeSpeakerName(match[1] ?? '')
    const text = (match[2] ?? '').trim()
    if (!name || !text || !SPEAKER_NAME_RE.test(name) || match.index === undefined) continue
    result.push({ name, text, start: match.index, end: match.index + match[0].length })
  }
  return result
}

function stripPlaybackMarkup(value: string): string {
  return value
    .replace(/&lt;\/?(?:p|div|br)(?:\s[\s\S]*?)?&gt;/gi, '\n\n')
    .replace(/\\?<\/?(?:p|div|br)(?:\s[^>]*)?>/gi, '\n\n')
    .replace(/&lt;\/?[a-z][\s\S]*?&gt;/gi, ' ')
    .replace(/\\?<\/?[a-z][^>]*>/gi, ' ')
    .replace(/\[\/?(?:font|color|size|style|span|div|p|b|i|u|em|strong)(?:=[^\]]*)?\]/gi, ' ')
    .replace(/[*_~]+/g, ' ')
}

function decodePlaybackEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;|&#34;|&#x22;/gi, '"')
    .replace(/&apos;|&#39;|&#x27;/gi, "'")
    .replace(/&lt;|&#60;|&#x3c;/gi, '<')
    .replace(/&gt;|&#62;|&#x3e;/gi, '>')
    .replace(/&amp;|&#38;|&#x26;/gi, '&')
}

function cleanPlaybackText(value: string): string {
  return decodePlaybackEntities(stripPlaybackMarkup(value))
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function appendGenericSegments(result: PlaybackSegment[], text: string, defaultSpeakerId: string | null): void {
  const quotePattern = /["“]([\s\S]*?)["”]/g
  let cursor = 0
  for (const match of text.matchAll(quotePattern)) {
    if (match.index === undefined) continue
    const narration = cleanPlaybackText(text.slice(cursor, match.index))
    if (narration) result.push({ text: narration, speakerId: null })
    const speech = cleanPlaybackText(match[1] ?? '')
    if (speech) result.push({ text: speech, speakerId: defaultSpeakerId })
    cursor = match.index + match[0].length
  }
  const narration = cleanPlaybackText(text.slice(cursor))
  if (narration) result.push({ text: narration, speakerId: null })
}

export function parseMultiVoiceSegments(content: string, defaultSpeakerId: string | null): PlaybackSegment[] {
  const named = extractNamedDialogue(content)
  const result: PlaybackSegment[] = []
  let cursor = 0
  for (const dialogue of named) {
    appendGenericSegments(result, content.slice(cursor, dialogue.start), defaultSpeakerId)
    const speech = cleanPlaybackText(dialogue.text)
    if (speech) result.push({ text: speech, speakerId: npcSpeakerId(dialogue.name) })
    cursor = dialogue.end
  }
  appendGenericSegments(result, content.slice(cursor), defaultSpeakerId)

  const merged: PlaybackSegment[] = []
  for (const segment of result) {
    const previous = merged[merged.length - 1]
    if (previous?.speakerId === null && segment.speakerId === null) previous.text += ` ${segment.text}`
    else merged.push({ ...segment })
  }
  return merged
}

const SPEECH_VERBS = '(?:said|says|asked|asks|replied|replies|whispered|whispers|shouted|shouts|yelled|yells|called|calls|murmured|murmurs|answered|answers|added|adds|continued|continues|remarked|remarks|cried|cries|growled|growls|sighed|sighs)'

interface SpeakerInference {
  speakerId: string | null
  confident: boolean
  source: 'explicit' | 'paragraph' | 'history' | 'fallback'
}

function escapedPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface SpeakerMentions {
  clean: Set<string>
  possessive: Set<string>
}

function narrativeOnly(text: string): string {
  return text.replace(/["“][\s\S]*?["”]/gu, ' ')
}

function mentionedSpeakers(text: string, speakers: CharacterLike[]): SpeakerMentions {
  const narrative = narrativeOnly(text)
  const mentions: SpeakerMentions = { clean: new Set(), possessive: new Set() }
  for (const speaker of speakers) {
    for (const alias of speakerAliases(speaker.name)) {
      const pattern = new RegExp(`\\b${escapedPattern(alias)}\\b`, 'giu')
      for (const match of narrative.matchAll(pattern)) {
        if (match.index === undefined) continue
        const suffix = narrative.slice(match.index + match[0].length)
        const collection = /^['’](?:s\b)?/iu.test(suffix) ? mentions.possessive : mentions.clean
        collection.add(speaker.id)
      }
    }
  }
  return mentions
}

interface SpeakerOccurrence {
  speakerId: string
  start: number
  end: number
}

function discourseSubjectSpeaker(
  text: string,
  speakers: CharacterLike[],
  eligibleSpeakerIds: Set<string>,
): string | null {
  const narrative = narrativeOnly(text)
  const occurrencesByPosition = new Map<string, SpeakerOccurrence>()
  for (const speaker of speakers) {
    if (!eligibleSpeakerIds.has(speaker.id)) continue
    for (const alias of speakerAliases(speaker.name)) {
      const pattern = new RegExp(`\\b${escapedPattern(alias)}\\b`, 'giu')
      for (const match of narrative.matchAll(pattern)) {
        if (match.index === undefined) continue
        const end = match.index + match[0].length
        if (/^['’](?:s\b)?/iu.test(narrative.slice(end))) continue
        const key = `${speaker.id}:${match.index}`
        const previous = occurrencesByPosition.get(key)
        if (!previous || end > previous.end) {
          occurrencesByPosition.set(key, { speakerId: speaker.id, start: match.index, end })
        }
      }
    }
  }
  const occurrences = [...occurrencesByPosition.values()].sort((left, right) => (
    left.start - right.start || right.end - left.end
  ))
  if (occurrences.length === 0) return null

  const scores = new Map<string, number>([...eligibleSpeakerIds].map(id => [id, 0]))
  const firstMentionStart = occurrences[0].start
  const clauseStart = (index: number) => {
    const prefix = narrative.slice(0, index)
    return Math.max(
      prefix.lastIndexOf('.'), prefix.lastIndexOf('!'), prefix.lastIndexOf('?'),
      prefix.lastIndexOf(';'), prefix.lastIndexOf('\n'),
    ) + 1
  }

  for (const occurrence of occurrences) {
    const start = clauseStart(occurrence.start)
    const lead = narrative.slice(start, occurrence.start)
    const earlierInClause = occurrences.some(other => (
      other.start >= start && other.start < occurrence.start
    ))
    let score = occurrence.start === firstMentionStart ? 2 : 0
    if (!lead.trim()) score += 10
    else if (!earlierInClause && /^[^,]{1,48},\s*$/u.test(lead)) score += 8

    if (/\b(?:to|from|for|with|by|at|on|of|beside|behind|under|near|toward|towards)\s*$/iu.test(lead)) {
      score -= 6
    }
    if (/\b(?:that|which|who|whom|whose|because|while|when|if|though|although)\s*$/iu.test(lead)) {
      score -= 5
    }
    if (earlierInClause && /^\s+(?:had|has|have)\b/iu.test(narrative.slice(occurrence.end))) {
      score -= 5
    }
    scores.set(occurrence.speakerId, (scores.get(occurrence.speakerId) ?? 0) + score)
  }

  for (let index = 1; index < occurrences.length; index++) {
    const left = occurrences[index - 1]
    const right = occurrences[index]
    if (left.speakerId === right.speakerId || clauseStart(left.start) !== clauseStart(right.start)) continue
    const between = narrative.slice(left.end, right.start)
    if (/^\s*(?:,\s*)?(?:and|or)\s*$/iu.test(between)) {
      scores.set(right.speakerId, (scores.get(right.speakerId) ?? 0) + 10)
    }
  }

  const ranked = [...scores.entries()].sort((left, right) => right[1] - left[1])
  const [winnerId, winnerScore] = ranked[0]
  const runnerUpScore = ranked[1]?.[1] ?? Number.NEGATIVE_INFINITY
  return winnerScore >= 8 && winnerScore - runnerUpScore >= 4 ? winnerId : null
}

function preferredMentionedSpeaker(
  text: string,
  speakers: CharacterLike[],
  mentions: SpeakerMentions,
): string | null {
  if (mentions.clean.size === 1) return [...mentions.clean][0]
  if (mentions.clean.size > 1) return discourseSubjectSpeaker(text, speakers, mentions.clean)
  return mentions.possessive.size === 1 ? [...mentions.possessive][0] : null
}

function hasSpeakerMentions(mentions: SpeakerMentions): boolean {
  return mentions.clean.size > 0 || mentions.possessive.size > 0
}

function soleMentionedSpeaker(text: string, speakers: CharacterLike[]): string | null {
  return preferredMentionedSpeaker(text, speakers, mentionedSpeakers(text, speakers))
}

function currentParagraphSpeaker(
  before: string,
  after: string,
  speakers: CharacterLike[],
): string | null {
  let paragraphStart = 0
  for (const match of before.matchAll(/\n[^\S\n]*\n/gu)) {
    if (match.index !== undefined) paragraphStart = match.index + match[0].length
  }
  const nextBreak = /\n[^\S\n]*\n/u.exec(after)
  const paragraphEnd = nextBreak?.index ?? after.length
  return soleMentionedSpeaker(
    `${before.slice(paragraphStart)}\n${after.slice(0, paragraphEnd)}`,
    speakers,
  )
}

function precedingParagraphSpeaker(before: string, speakers: CharacterLike[]): string | null {
  const paragraphs = before.split(/\n[^\S\n]*\n/gu)
  if (paragraphs.length < 2) return null
  for (let index = paragraphs.length - 2; index >= 0; index--) {
    const paragraph = paragraphs[index]
    const mentions = mentionedSpeakers(paragraph, speakers)
    const speakerId = preferredMentionedSpeaker(paragraph, speakers, mentions)
    if (speakerId) return speakerId
    if (hasSpeakerMentions(mentions)) return null
  }
  return null
}

function inferQuotedSpeaker(
  before: string,
  after: string,
  quotedText: string,
  speakers: CharacterLike[],
  defaultSpeakerId: string | null,
): SpeakerInference {
  if (/[,]\s*$/u.test(quotedText)) {
    const actionBeat = after.slice(0, 140).split(/["“\n]/u, 1)[0]
    let nearest: { id: string; index: number } | null = null
    for (const speaker of speakers) {
      for (const alias of speakerAliases(speaker.name)) {
        const name = escapedPattern(alias)
        const index = actionBeat.search(new RegExp(`\\b${name}\\b`, 'iu'))
        if (index >= 0 && (!nearest || index < nearest.index)) nearest = { id: speaker.id, index }
      }
    }
    if (nearest) return { speakerId: nearest.id, confident: true, source: 'explicit' }
  }

  let best: { id: string; score: number } | null = null
  for (const speaker of speakers) {
    for (const alias of speakerAliases(speaker.name)) {
      const name = escapedPattern(alias)
      const tests: Array<[RegExp, string, number]> = [
        [new RegExp(`(?:^|\\n)\\s*(?:[-*]\\s*)?(?:\\*\\*)?${name}(?:\\*\\*)?\\s*:\\s*[^"“\\n]{0,120}$`, 'iu'), before.slice(-220), 100],
        [new RegExp(`\\b${name}\\b[^\\n.!?]{0,60}\\b${SPEECH_VERBS}\\b[^\\n.!?]{0,20}$`, 'iu'), before.slice(-180), 90],
        [new RegExp(`\\b${SPEECH_VERBS}\\b\\s+(?:to\\s+)?${name}\\b[^\\n.!?]{0,20}$`, 'iu'), before.slice(-180), 90],
        [new RegExp(`^\\s*[,;:.!?—-]*\\s*${name}\\b[^\\n.!?]{0,50}\\b${SPEECH_VERBS}\\b`, 'iu'), after.slice(0, 180), 85],
        [new RegExp(`^\\s*[,;:.!?—-]*\\s*${SPEECH_VERBS}\\b\\s+(?:to\\s+)?${name}\\b`, 'iu'), after.slice(0, 180), 85],
      ]
      for (const [pattern, sample, score] of tests) {
        if (pattern.test(sample) && (!best || score > best.score)) best = { id: speaker.id, score }
      }
    }
  }
  if (best) return { speakerId: best.id, confident: true, source: 'explicit' }
  const currentSpeakerId = currentParagraphSpeaker(before, after, speakers)
  if (currentSpeakerId) {
    return { speakerId: currentSpeakerId, confident: true, source: 'paragraph' }
  }
  const paragraphSpeakerId = precedingParagraphSpeaker(before, speakers)
  return paragraphSpeakerId
    ? { speakerId: paragraphSpeakerId, confident: true, source: 'history' }
    : { speakerId: defaultSpeakerId, confident: false, source: 'fallback' }
}

interface PlaybackParagraph {
  start: number
  end: number
  text: string
}

function playbackParagraphs(content: string): PlaybackParagraph[] {
  const paragraphs: PlaybackParagraph[] = []
  let cursor = 0
  for (const separator of content.matchAll(/\n[^\S\n]*\n/gu)) {
    if (separator.index === undefined) continue
    const text = content.slice(cursor, separator.index)
    if (text.trim()) paragraphs.push({ start: cursor, end: separator.index, text })
    cursor = separator.index + separator[0].length
  }
  const text = content.slice(cursor)
  if (text.trim()) paragraphs.push({ start: cursor, end: content.length, text })
  return paragraphs
}

function paragraphDialogueTurns(
  content: string,
  speakers: CharacterLike[],
  defaultSpeakerId: string | null,
): Map<number, string> {
  const turns = new Map<number, string>()
  const paragraphs = playbackParagraphs(content)
  let pair: [string, string] | null = null
  let previousStrongSpeakerId: string | null = null
  let lastTurnSpeakerId: string | null = null

  for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex++) {
    const paragraph = paragraphs[paragraphIndex]
    const quoteMatches = [...paragraph.text.matchAll(/["“]([\s\S]*?)["”]/gu)]
    if (quoteMatches.length === 0) {
      const narration = cleanPlaybackText(paragraph.text)
      const transparentBeat = narration.length <= 120
        && !hasSpeakerMentions(mentionedSpeakers(paragraph.text, speakers))
      if (!transparentBeat) {
        pair = null
        previousStrongSpeakerId = null
        lastTurnSpeakerId = null
      }
      continue
    }

    const explicitSpeakerIds = new Set<string>()
    for (const match of quoteMatches) {
      if (match.index === undefined) continue
      const quoteStart = paragraph.start + match.index
      const quoteEnd = quoteStart + match[0].length
      const inference = inferQuotedSpeaker(
        content.slice(0, quoteStart),
        content.slice(quoteEnd),
        match[1] ?? '',
        speakers,
        defaultSpeakerId,
      )
      if (inference.source === 'explicit' && inference.speakerId) {
        explicitSpeakerIds.add(inference.speakerId)
      }
    }

    if (explicitSpeakerIds.size > 1) {
      pair = null
      previousStrongSpeakerId = null
      lastTurnSpeakerId = null
      continue
    }

    const explicitSpeakerId = explicitSpeakerIds.size === 1 ? [...explicitSpeakerIds][0] : null
    const localSpeakerId = explicitSpeakerId ?? soleMentionedSpeaker(paragraph.text, speakers)
    if (localSpeakerId) {
      if (pair && !pair.includes(localSpeakerId)) pair = null
      if (!pair && previousStrongSpeakerId && previousStrongSpeakerId !== localSpeakerId) {
        pair = [previousStrongSpeakerId, localSpeakerId]
      }
      previousStrongSpeakerId = localSpeakerId
      lastTurnSpeakerId = localSpeakerId
      continue
    }

    if (pair && lastTurnSpeakerId && pair.includes(lastTurnSpeakerId)) {
      const alternatingSpeakerId: string = pair[0] === lastTurnSpeakerId ? pair[1] : pair[0]
      turns.set(paragraphIndex, alternatingSpeakerId)
      lastTurnSpeakerId = alternatingSpeakerId
    } else {
      previousStrongSpeakerId = null
      lastTurnSpeakerId = null
    }
  }

  return turns
}

function canContinueSpeaker(
  bridge: string,
  previousSpeakerId: string,
  speakers: CharacterLike[],
): boolean {
  if (/\n\s*\n/u.test(bridge)) return false
  for (const speaker of speakers) {
    if (speaker.id === previousSpeakerId) continue
    for (const alias of speakerAliases(speaker.name)) {
      const name = escapedPattern(alias)
      if (new RegExp(`\\b${name}\\b`, 'iu').test(bridge)) return false
    }
  }
  return true
}

export function parseRosterVoiceSegments(
  content: string,
  defaultSpeakerId: string | null,
  speakers: CharacterLike[],
): PlaybackSegment[] {
  const playbackContent = stripPlaybackMarkup(content)
  const result: PlaybackSegment[] = []
  const quotePattern = /["“]([\s\S]*?)["”]/g
  const paragraphs = playbackParagraphs(playbackContent)
  const dialogueTurns = paragraphDialogueTurns(playbackContent, speakers, defaultSpeakerId)
  let paragraphIndex = 0
  let cursor = 0
  let lastConfidentSpeakerId: string | null = null
  let lastAssignedSpeakerId: string | null = null
  for (const match of playbackContent.matchAll(quotePattern)) {
    if (match.index === undefined) continue
    while (paragraphIndex + 1 < paragraphs.length && match.index >= paragraphs[paragraphIndex].end) {
      paragraphIndex += 1
    }
    const bridge = playbackContent.slice(cursor, match.index)
    const narration = cleanPlaybackText(bridge)
    if (narration) result.push({ text: narration, speakerId: null })
    const speech = cleanPlaybackText(match[1] ?? '')
    if (speech) {
      const quoteEnd = match.index + match[0].length
      const inference = inferQuotedSpeaker(
        playbackContent.slice(0, match.index),
        playbackContent.slice(quoteEnd),
        match[1] ?? '',
        speakers,
        defaultSpeakerId,
      )
      const continuationCandidate: string | null = lastAssignedSpeakerId ?? lastConfidentSpeakerId
      const continuedSpeakerId: string | null = inference.source === 'fallback'
        && continuationCandidate
        && canContinueSpeaker(bridge, continuationCandidate, speakers)
        ? continuationCandidate
        : null
      const dialogueTurnSpeakerId = dialogueTurns.get(paragraphIndex) ?? null
      const inferredTurnSpeakerId = (inference.source === 'history' || inference.source === 'fallback')
        ? dialogueTurnSpeakerId
        : null
      const speakerId: string | null = inferredTurnSpeakerId
        ?? continuedSpeakerId
        ?? inference.speakerId
      result.push({
        text: speech,
        speakerId,
      })
      if (inference.confident && speakerId) lastConfidentSpeakerId = speakerId
      if (speakerId) lastAssignedSpeakerId = speakerId
    }
    cursor = match.index + match[0].length
  }
  const narration = cleanPlaybackText(playbackContent.slice(cursor))
  if (narration) result.push({ text: narration, speakerId: null })
  return result
}

export function detectCharacters(
  messages: MessageLike[],
  candidates: CharacterLike[],
  messageLimit: number,
  fallbackCharacterId: string | null,
): DetectedCharacter[] {
  const byName = new Map<string, CharacterLike>()
  for (const character of candidates) {
    for (const alias of speakerAliases(character.name)) {
      const normalizedName = alias.toLowerCase()
      if (!byName.has(normalizedName)) byName.set(normalizedName, character)
    }
  }
  const byId = new Map(candidates.map((character) => [character.id, character] as const))
  const counts = new Map<string, number>()
  const order: string[] = []
  const detectedById = new Map<string, CharacterLike>()
  const window = messages
    .filter((message) => !message.is_user)
    .slice(-clampMessageLimit(messageLimit))

  for (let index = window.length - 1; index >= 0; index--) {
    const message = window[index]
    const namedDialogue = extractNamedDialogue(message.content ?? '')
    for (let dialogueIndex = namedDialogue.length - 1; dialogueIndex >= 0; dialogueIndex--) {
      const dialogue = namedDialogue[dialogueIndex]
      const matchingCard = byName.get(dialogue.name.toLowerCase())
      const character = matchingCard ?? { id: npcSpeakerId(dialogue.name), name: dialogue.name }
      detectedById.set(character.id, character)
      if (!counts.has(character.id)) order.push(character.id)
      counts.set(character.id, (counts.get(character.id) ?? 0) + 1)
    }
    const normalizedName = message.name?.trim().toLowerCase() ?? ''
    const explicitCharacterId = typeof message.extra?.character_id === 'string'
      ? message.extra.character_id
      : ''
    let character = explicitCharacterId ? byId.get(explicitCharacterId) : undefined
    if (!character) character = normalizedName ? byName.get(normalizedName) : undefined
    if (!character && candidates.length === 1 && fallbackCharacterId) {
      character = byId.get(fallbackCharacterId)
    }
    if (!character) continue
    detectedById.set(character.id, character)
    if (!counts.has(character.id)) order.push(character.id)
    counts.set(character.id, (counts.get(character.id) ?? 0) + 1)
  }

  if (order.length === 0 && fallbackCharacterId && byId.has(fallbackCharacterId)) {
    order.push(fallbackCharacterId)
    counts.set(fallbackCharacterId, 0)
  }

  return order.map((id) => ({
    ...(detectedById.get(id) ?? byId.get(id)!),
    messageCount: counts.get(id) ?? 0,
  }))
}

export function applyConfigToMetadata(
  metadata: Record<string, unknown>,
  config: ChatVoiceConfig,
): Record<string, unknown> {
  const previousOverrides = readVoiceOverrides(metadata)
  const characters = { ...(previousOverrides.characters ?? {}) }
  const nextManagedIds = Object.keys(config.characterVoices)

  for (const characterId of new Set([...config.managedCharacterIds, ...nextManagedIds])) {
    delete characters[characterId]
  }

  if (config.connectionId) {
    for (const [characterId, voice] of Object.entries(config.characterVoices)) {
      if (voice && !characterId.startsWith('npc:')) {
        characters[characterId] = { connectionId: config.connectionId, voice }
      }
    }
  }

  const voiceOverrides: VoiceOverrides = {}
  if (config.connectionId && config.narratorVoice) {
    voiceOverrides.narrator = { connectionId: config.connectionId, voice: config.narratorVoice }
  }
  if (Object.keys(characters).length > 0) voiceOverrides.characters = characters

  const storedConfig: ChatVoiceConfig = {
    ...config,
    managedCharacterIds: [...new Set(nextManagedIds)],
  }
  const result: Record<string, unknown> = { ...metadata, [CONFIG_KEY]: storedConfig }
  if (voiceOverrides.narrator || voiceOverrides.characters) result.voiceOverrides = voiceOverrides
  else delete result.voiceOverrides
  return result
}
