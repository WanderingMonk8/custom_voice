export const CONFIG_KEY = 'chat_voice'
export const DEFAULT_MESSAGE_LIMIT = 20
export const MIN_MESSAGE_LIMIT = 1
export const MAX_MESSAGE_LIMIT = 500
export const DEFAULT_SAVED_AUDIO_LIMIT = 50
export const MAX_SAVED_AUDIO_LIMIT = 10_000

export interface SavedAudioRecord {
  chatId: string
  messageId: string
  audioId: string
  swipeId: number
  savedAt: number
}

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

export interface LlmSpeakerAssignment {
  quote: number
  speakerId: string | null
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
  gain?: number
}

export interface AdaptiveGenerationState {
  concurrency: number
  shortCooldown: number
  longWindowStreak: number
}

/** Return the delay required to keep request starts inside a rolling quota window. */
export function rollingRequestWindowDelay(
  recentStarts: number[],
  now: number,
  requestLimit: number,
  windowMs = 60_000,
): number {
  const safeLimit = Math.max(1, Math.round(requestLimit))
  const safeWindow = Math.max(1, Math.round(windowMs))
  const activeStarts = recentStarts
    .filter(start => Number.isFinite(start) && start > now - safeWindow && start <= now)
    .sort((left, right) => left - right)
  if (activeStarts.length < safeLimit) return 0
  const limitingStart = activeStarts[activeStarts.length - safeLimit] ?? now
  return Math.max(0, limitingStart + safeWindow - now)
}

/** Back off a learned rolling request ceiling aggressively after a 429. */
export function reducedRequestWindowLimit(current: number, minimum = 6): number {
  const safeMinimum = Math.max(1, Math.round(minimum))
  return Math.max(safeMinimum, Math.floor(Math.max(safeMinimum, current) / 2))
}

/** Adjust TTS concurrency from fragmentation density while resisting rapid oscillation. */
export function adaptiveGenerationConcurrency(
  current: number,
  configuredMaximum: number,
  segmentLengths: number[],
  shortCooldown = 0,
  longWindowStreak = 0,
  maximum = 10,
  voiceChanges = 0,
): AdaptiveGenerationState {
  const safeMaximum = Math.max(1, Math.round(maximum))
  const safeConfiguredMaximum = Math.min(safeMaximum, Math.max(1, Math.round(configuredMaximum)))
  const safeCurrent = Math.min(safeConfiguredMaximum, Math.max(1, Math.round(current)))
  const safeCooldown = Math.max(0, Math.round(shortCooldown))
  const safeLongStreak = Math.max(0, Math.round(longWindowStreak))
  const lengths = segmentLengths.filter(length => Number.isFinite(length) && length >= 0)
  if (lengths.length === 0) {
    return { concurrency: safeCurrent, shortCooldown: safeCooldown, longWindowStreak: safeLongStreak }
  }
  const sorted = [...lengths].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const medianLength = sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? 0
  const lowerQuartileLength = sorted[Math.floor((sorted.length - 1) * 0.25)] ?? 0
  const shortCount = lengths.filter(length => length < 160).length
  const mixedDenseWindow = lengths.length >= 4 && lowerQuartileLength < 220
  if (shortCount >= 3 || medianLength < 200 || mixedDenseWindow || voiceChanges >= 3) {
    return { concurrency: 1, shortCooldown: 6, longWindowStreak: 0 }
  }
  if (safeCooldown > 0) {
    return { concurrency: 1, shortCooldown: safeCooldown - 1, longWindowStreak: 0 }
  }
  const uniformlyLongWindow = lengths.length >= 3
    && Math.min(...lengths) >= 300
    && lowerQuartileLength > 320
    && medianLength > 420
  if (uniformlyLongWindow) {
    const nextStreak = safeLongStreak + 1
    if (nextStreak >= 2) {
      return {
        concurrency: Math.min(safeConfiguredMaximum, safeCurrent + 1),
        shortCooldown: 0,
        longWindowStreak: 0,
      }
    }
    return { concurrency: safeCurrent, shortCooldown: 0, longWindowStreak: nextStreak }
  }
  return { concurrency: safeCurrent, shortCooldown: 0, longWindowStreak: 0 }
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
    const gain = Number.isFinite(segment.gain) ? Math.max(0, segment.gain ?? 1) : 1
    for (let frame = 0; frame < outputFrames; frame += 1) {
      const sourcePosition = outputFrames === 1 ? 0 : frame * (sourceFrames - 1) / (outputFrames - 1)
      const lower = Math.floor(sourcePosition)
      const upper = Math.min(sourceFrames - 1, lower + 1)
      const fraction = sourcePosition - lower
      for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
        const channel = segment.channels[Math.min(channelIndex, segment.channels.length - 1)]
        const lowerValue = channel[Math.min(lower, channel.length - 1)] ?? 0
        const upperValue = channel[Math.min(upper, channel.length - 1)] ?? lowerValue
        const sample = Math.max(-1, Math.min(1, (lowerValue + (upperValue - lowerValue) * fraction) * gain))
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

export function clampSavedAudioLimit(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_SAVED_AUDIO_LIMIT
  return Math.min(MAX_SAVED_AUDIO_LIMIT, Math.max(1, Math.round(numeric)))
}

export function readSavedAudioHistory(value: unknown): SavedAudioRecord[] {
  if (!Array.isArray(value)) return []
  const records: SavedAudioRecord[] = []
  const seenAudioIds = new Set<string>()
  for (const item of value.slice(-MAX_SAVED_AUDIO_LIMIT)) {
    if (!isRecord(item)) continue
    const chatId = typeof item.chatId === 'string' ? item.chatId : ''
    const messageId = typeof item.messageId === 'string' ? item.messageId : ''
    const audioId = typeof item.audioId === 'string' ? item.audioId : ''
    const swipeId = typeof item.swipeId === 'number' ? Math.max(0, Math.round(item.swipeId)) : NaN
    const savedAt = typeof item.savedAt === 'number' ? item.savedAt : NaN
    if (!chatId || !messageId || !audioId || !Number.isFinite(swipeId) || !Number.isFinite(savedAt)) continue
    if (seenAudioIds.has(audioId)) continue
    seenAudioIds.add(audioId)
    records.push({ chatId, messageId, audioId, swipeId, savedAt })
  }
  return records
}

export function upsertSavedAudioRecord(
  records: SavedAudioRecord[],
  next: SavedAudioRecord,
): SavedAudioRecord[] {
  return [
    ...records.filter(record => (
      record.audioId !== next.audioId
      && !(record.chatId === next.chatId
        && record.messageId === next.messageId
        && record.swipeId === next.swipeId)
    )),
    next,
  ]
}

export function expiredSavedAudioRecords(
  records: SavedAudioRecord[],
  limit: number,
): SavedAudioRecord[] {
  const overflow = Math.max(0, records.length - clampSavedAudioLimit(limit))
  return [...records]
    .sort((left, right) => left.savedAt - right.savedAt)
    .slice(0, overflow)
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

export function parseLlmSpeakerAssignments(
  response: unknown,
  allowedSpeakerIds: ReadonlySet<string>,
  quoteCount: number,
): LlmSpeakerAssignment[] {
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
  if (!isRecord(parsed) || !Array.isArray(parsed.assignments)) return []
  const result: LlmSpeakerAssignment[] = []
  const seen = new Set<number>()
  for (const item of parsed.assignments.slice(0, 500)) {
    if (!isRecord(item) || !Number.isInteger(item.quote)) continue
    const quote = item.quote as number
    if (quote < 0 || quote >= quoteCount || seen.has(quote)) continue
    const speakerId = item.speakerId === null
      ? null
      : typeof item.speakerId === 'string' && allowedSpeakerIds.has(item.speakerId)
        ? item.speakerId
        : undefined
    if (speakerId === undefined) continue
    seen.add(quote)
    result.push({ quote, speakerId })
  }
  return result.sort((left, right) => left.quote - right.quote)
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

function namesDescribeSameCardCharacter(cardName: string, scannedName: string): boolean {
  const cardAliases = speakerAliases(cardName)
  const scannedAliases = speakerAliases(scannedName)
  const cardKeys = new Set(cardAliases.map(alias => alias.toLowerCase()))
  const scannedKeys = new Set(scannedAliases.map(alias => alias.toLowerCase()))
  if (cardAliases.some(alias => scannedKeys.has(alias.toLowerCase()))) return true
  const cardFirst = firstNameAlias(cardName)?.toLowerCase()
  const scannedFirst = firstNameAlias(scannedName)?.toLowerCase()
  return !!(
    (cardFirst && scannedKeys.has(cardFirst))
    || (scannedFirst && cardKeys.has(scannedFirst))
  )
}

function combineSpeakerNames(left: string, right: string): string {
  const aliases = [...speakerAliases(left), ...speakerAliases(right)]
  const unique = aliases.filter((alias, index) => (
    aliases.findIndex(candidate => candidate.toLowerCase() === alias.toLowerCase()) === index
  ))
  unique.sort((a, b) => b.split(/\s+/u).length - a.split(/\s+/u).length)
  const combined = unique.join(' / ')
  return combined.length <= 128 ? combined : left
}

/** Consolidate a card's first-name and full-name variants into its stable card ID. */
export function mergeScannedCardCast(
  cards: CharacterLike[],
  cast: CardCastMember[],
): CharacterLike[] {
  const cardsById = new Map(cards.map(card => [card.id, card] as const))
  const cardsByName = new Map<string, CharacterLike>()
  for (const card of cards) {
    for (const alias of speakerAliases(card.name)) cardsByName.set(alias.toLowerCase(), card)
  }
  const detected = new Map(cards.map(card => [card.id, { ...card }] as const))
  for (const member of cast) {
    const exactCard = cardsByName.get(normalizeSpeakerName(member.name).toLowerCase())
    const sourceCard = cardsById.get(member.cardId)
    const matchingCard = exactCard
      ?? (sourceCard && namesDescribeSameCardCharacter(sourceCard.name, member.name) ? sourceCard : null)
    const id = matchingCard?.id ?? npcSpeakerId(member.name)
    const existing = detected.get(id)
    if (!existing) {
      detected.set(id, { id, name: member.name })
    } else if (matchingCard) {
      detected.set(id, { ...existing, name: combineSpeakerNames(existing.name, member.name) })
    }
  }
  return addScannedFirstNameAliases([...detected.values()])
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

export function parseSkippedTrackerTags(value: string): string[] {
  const decoded = decodePlaybackEntities(value)
  const tags: string[] = []
  const seen = new Set<string>()
  const addTag = (value: string) => {
    const tag = value.toLowerCase()
    if (!tag || seen.has(tag) || !/^[a-z][a-z0-9:._-]*$/u.test(tag)) return
    seen.add(tag)
    tags.push(tag)
  }
  for (const entry of decoded.split(',')) {
    addTag(entry.trim())
    if (tags.length >= 100) return tags
  }
  // Keep previously saved paired-tag settings working after the simpler name-only format is introduced.
  const pairPattern = /\\?<\s*([a-z][a-z0-9:._-]*)\b[^>]*>[\s\S]*?\\?<\s*\/\s*\1\s*>/giu
  for (const match of decoded.matchAll(pairPattern)) {
    addTag(match[1] ?? '')
    if (tags.length >= 100) break
  }
  return tags
}

function stripPairedTagBlocks(value: string, tag: string): string {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const tokenPattern = new RegExp(
    `\\\\?<\\s*(/?)\\s*${escapedTag}(?=\\s|>)[^>]*>`,
    'giu',
  )
  const ranges: Array<{ start: number; end: number }> = []
  let depth = 0
  let blockStart = -1
  for (const match of value.matchAll(tokenPattern)) {
    if (match.index === undefined) continue
    const closing = match[1] === '/'
    if (!closing && !/\/\s*>$/u.test(match[0])) {
      if (depth === 0) blockStart = match.index
      depth += 1
    } else if (closing && depth > 0) {
      depth -= 1
      if (depth === 0 && blockStart >= 0) {
        ranges.push({ start: blockStart, end: match.index + match[0].length })
        blockStart = -1
      }
    }
  }
  if (ranges.length === 0) return value
  let result = value
  for (let index = ranges.length - 1; index >= 0; index--) {
    result = `${result.slice(0, ranges[index].start)} ${result.slice(ranges[index].end)}`
  }
  return result
}

export function stripSkippedTrackerBlocks(content: string, tagPairs: string): string {
  let result = content
    .replace(/&lt;|&#60;|&#x3c;/gi, '<')
    .replace(/&gt;|&#62;|&#x3e;/gi, '>')
    .replace(/<!--[\s\S]*?-->/g, ' ')
  for (const tag of parseSkippedTrackerTags(tagPairs)) {
    result = stripPairedTagBlocks(result, tag)
  }
  return result
}

export function preparePlaybackContent(content: string, skippedTrackerTagPairs = ''): string {
  return stripPlaybackMarkup(stripSkippedTrackerBlocks(content, skippedTrackerTagPairs))
    // Rich-text sources may preserve quote entities, and some model outputs emit
    // the same opening mark twice. A doubled opener shifts a global quote regex
    // by one delimiter, turning later dialogue into narration and vice versa.
    .replace(/&quot;|&#34;|&#x22;/giu, '"')
    .replace(/["“”]{2,}/gu, '"')
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
  const quotes = playbackQuotes(text)
  if (quotes.length === 0) return text
  let result = ''
  let cursor = 0
  for (const quote of quotes) {
    result += `${text.slice(cursor, quote.start)} `
    cursor = quote.end
  }
  return result + text.slice(cursor)
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

const SPEECH_BEARING_NOUNS = '(?:voice|words?|reply|answer|question|whisper|shout|yell|call|murmur|remark|response)'

/** Resolve possessive metonymy such as "Colton's voice" when it heads the main clause. */
function mainClauseSpeechPossessor(text: string, speakers: CharacterLike[]): string | null {
  const narrative = narrativeOnly(text)
  const matches = new Set<string>()
  for (const speaker of speakers) {
    for (const alias of speakerAliases(speaker.name)) {
      const pattern = new RegExp(
        `\\b${escapedPattern(alias)}\\b['’](?:s)?\\s+(?:[\\p{L}\\p{M}'’-]+\\s+){0,3}${SPEECH_BEARING_NOUNS}\\b`,
        'giu',
      )
      for (const match of narrative.matchAll(pattern)) {
        if (match.index === undefined) continue
        const prefix = narrative.slice(0, match.index)
        const sentenceStart = Math.max(
          prefix.lastIndexOf('.'), prefix.lastIndexOf('!'), prefix.lastIndexOf('?'),
          prefix.lastIndexOf(';'), prefix.lastIndexOf('\n'),
        ) + 1
        const lead = prefix.slice(sentenceStart)
        if (!lead.trim() || /^[^,]{1,80},\s*$/u.test(lead)) matches.add(speaker.id)
      }
    }
  }
  return matches.size === 1 ? [...matches][0] : null
}

const POSSESSIVE_SUBJECT_VERBS = '(?:is|are|was|were|has|have|had|does|do|did|falls?|finds?|takes?|presses?|moves?|comes?|goes?|holds?|keeps?|starts?|stops?|turns?|looks?|watches?|breathes?|shakes?|slides?|opens?|closes?|reaches?|catches?|carries?|knots?|locks?|shards?|reforms?|rest(?:s|ed|ing)?)'

/** Resolve an owning character when their possessive noun phrase heads a clause. */
function mainClausePossessiveSubject(
  text: string,
  speakers: CharacterLike[],
  eligibleSpeakerIds: Set<string>,
): string | null {
  const narrative = narrativeOnly(text)
  const matches = new Set<string>()
  for (const speaker of speakers) {
    if (!eligibleSpeakerIds.has(speaker.id)) continue
    for (const alias of speakerAliases(speaker.name)) {
      const pattern = new RegExp(`\\b${escapedPattern(alias)}\\b['’]s\\s+(?:[\\p{L}\\p{M}'’-]+\\s+){1,5}${POSSESSIVE_SUBJECT_VERBS}\\b`, 'giu')
      for (const match of narrative.matchAll(pattern)) {
        if (match.index === undefined) continue
        const prefix = narrative.slice(0, match.index)
        if (/\b(?:to|from|for|with|by|at|on|of|in|into|beside|behind|under|near|against)\s*$/iu.test(prefix)) {
          continue
        }
        const sentenceStart = Math.max(
          prefix.lastIndexOf('.'), prefix.lastIndexOf('!'), prefix.lastIndexOf('?'),
          prefix.lastIndexOf(';'), prefix.lastIndexOf('\n'),
        ) + 1
        const lead = prefix.slice(sentenceStart)
        if (!lead.trim() || /\b(?:and|but|then)\s*$/iu.test(lead)) matches.add(speaker.id)
      }
    }
  }
  return matches.size === 1 ? [...matches][0] : null
}

function preferredMentionedSpeaker(
  text: string,
  speakers: CharacterLike[],
  mentions: SpeakerMentions,
): string | null {
  const speechPossessor = mainClauseSpeechPossessor(text, speakers)
  if (speechPossessor) return speechPossessor
  if (mentions.clean.size === 1) return [...mentions.clean][0]
  if (mentions.clean.size > 1) return discourseSubjectSpeaker(text, speakers, mentions.clean)
  return mainClausePossessiveSubject(text, speakers, mentions.possessive)
}

function hasSpeakerMentions(mentions: SpeakerMentions): boolean {
  return mentions.clean.size > 0 || mentions.possessive.size > 0
}

function soleMentionedSpeaker(text: string, speakers: CharacterLike[]): string | null {
  return preferredMentionedSpeaker(text, speakers, mentionedSpeakers(text, speakers))
}

function unambiguousNarrativeSpeaker(text: string, speakers: CharacterLike[]): string | null {
  const mentions = mentionedSpeakers(text, speakers)
  if (mentions.clean.size === 1) return [...mentions.clean][0]
  if (mentions.clean.size === 0) {
    return mainClausePossessiveSubject(text, speakers, mentions.possessive)
  }
  return null
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
    // A possessive buried in an object phrase (for example, "in Grace's
    // wrist") is not a competing discourse subject and should not stop the
    // upward search for the last confident speaker.
    if (mentions.clean.size > 0) return null
  }
  return null
}

function precedingActionBeatSpeaker(before: string, speakers: CharacterLike[]): string | null {
  const previousQuoteEnd = Math.max(before.lastIndexOf('"'), before.lastIndexOf('”'))
  const previousParagraphEnd = [...before.matchAll(/\n[^\S\n]*\n/gu)].at(-1)
  const paragraphBoundary = previousParagraphEnd?.index === undefined
    ? -1
    : previousParagraphEnd.index + previousParagraphEnd[0].length - 1
  const localNarration = before.slice(Math.max(previousQuoteEnd, paragraphBoundary) + 1).trimStart()
  if (!localNarration) return null

  const matches = new Set<string>()
  for (const speaker of speakers) {
    for (const alias of speakerAliases(speaker.name)) {
      const pattern = new RegExp(
        `^${escapedPattern(alias)}\\b(?!['’](?:s\\b)?)\\s*(?:,|—|-)`,
        'iu',
      )
      if (pattern.test(localNarration)) matches.add(speaker.id)
    }
  }
  return matches.size === 1 ? [...matches][0] : null
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
  const actionBeatSpeakerId = precedingActionBeatSpeaker(before, speakers)
  if (actionBeatSpeakerId) {
    return { speakerId: actionBeatSpeakerId, confident: true, source: 'explicit' }
  }
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

interface PlaybackQuote {
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

/**
 * Extract quotes without ever pairing delimiters across a paragraph boundary.
 * One malformed paragraph can therefore no longer invert dialogue and narration
 * throughout the remainder of a message.
 */
function playbackQuotes(content: string): PlaybackQuote[] {
  const quotes: PlaybackQuote[] = []
  for (const paragraph of playbackParagraphs(content)) {
    let matched = false
    for (const match of paragraph.text.matchAll(/["“]([\s\S]*?)["”]/gu)) {
      if (match.index === undefined) continue
      matched = true
      const start = paragraph.start + match.index
      quotes.push({
        start,
        end: start + match[0].length,
        text: match[1] ?? '',
      })
    }
    if (matched) continue

    // Recover a fully quoted paragraph whose model-generated closing delimiter
    // is missing or is a single quote. This is deliberately limited to a quote
    // at the start of one paragraph, so it cannot consume later narration.
    const leadingQuote = paragraph.text.match(/^(\s*)["“]([\s\S]+)$/u)
    if (!leadingQuote) continue
    const localStart = leadingQuote[1]?.length ?? 0
    quotes.push({
      start: paragraph.start + localStart,
      end: paragraph.end,
      text: (leadingQuote[2] ?? '').replace(/['’]\s*$/u, ''),
    })
  }
  return quotes
}

interface InitialDialogueBackfill {
  speakerId: string
  paragraphIndexes: Set<number>
}

/**
 * Seed only a message-opening ambiguous dialogue run from later narration.
 * Once any preceding character is established, downstream evidence is ignored.
 */
function initialDialogueBackfill(
  paragraphs: PlaybackParagraph[],
  speakers: CharacterLike[],
): InitialDialogueBackfill | null {
  const paragraphIndexes: number[] = []
  let dialogueStarted = false
  for (let index = 0; index < paragraphs.length; index++) {
    const paragraph = paragraphs[index]
    const hasDialogue = playbackQuotes(paragraph.text).length > 0
    const mentions = mentionedSpeakers(paragraph.text, speakers)
    const localSpeakerId = preferredMentionedSpeaker(paragraph.text, speakers, mentions)

    if (!dialogueStarted) {
      if (!hasDialogue) {
        if (localSpeakerId || hasSpeakerMentions(mentions)) return null
        continue
      }
      dialogueStarted = true
    }

    if (hasDialogue) {
      if (localSpeakerId || hasSpeakerMentions(mentions)) return null
      paragraphIndexes.push(index)
      continue
    }

    if (localSpeakerId) {
      return {
        speakerId: localSpeakerId,
        paragraphIndexes: new Set(paragraphIndexes),
      }
    }
    if (hasSpeakerMentions(mentions)) return null
  }
  return null
}

function confidentDialogueParagraphSpeaker(
  content: string,
  paragraph: PlaybackParagraph,
  speakers: CharacterLike[],
  defaultSpeakerId: string | null,
): string | null {
  const speakerIds = new Set<string>()
  for (const quote of playbackQuotes(paragraph.text)) {
    const quoteStart = paragraph.start + quote.start
    const quoteEnd = paragraph.start + quote.end
    const inference = inferQuotedSpeaker(
      content.slice(0, quoteStart),
      content.slice(quoteEnd),
      quote.text,
      speakers,
      defaultSpeakerId,
    )
    if (inference.confident && inference.speakerId) speakerIds.add(inference.speakerId)
  }
  return speakerIds.size === 1 ? [...speakerIds][0] : null
}

/**
 * Resolve an unattributed reply using strong evidence on both sides. The next
 * paragraph must be narration-only and begin with a different, clear subject;
 * a paragraph containing dialogue represents a new turn and cannot backfill.
 */
function downstreamNarrativeReplySpeakers(
  content: string,
  paragraphs: PlaybackParagraph[],
  speakers: CharacterLike[],
  defaultSpeakerId: string | null,
): Map<number, string> {
  const replies = new Map<number, string>()
  for (let index = 1; index + 1 < paragraphs.length; index++) {
    const previous = paragraphs[index - 1]
    const current = paragraphs[index]
    const next = paragraphs[index + 1]
    if (!/["“][\s\S]*?["”]/u.test(previous.text)) continue
    if (!/["“][\s\S]*?["”]/u.test(current.text)) continue
    if (/["“][\s\S]*?["”]/u.test(next.text)) continue
    if (cleanPlaybackText(narrativeOnly(current.text))) continue
    if (hasSpeakerMentions(mentionedSpeakers(current.text, speakers))) continue

    const previousSpeakerId = confidentDialogueParagraphSpeaker(
      content,
      previous,
      speakers,
      defaultSpeakerId,
    )
    if (!previousSpeakerId) continue

    const nextMentions = mentionedSpeakers(next.text, speakers)
    if (nextMentions.clean.size === 0) continue
    const nextSpeakerId = discourseSubjectSpeaker(next.text, speakers, nextMentions.clean)
    if (!nextSpeakerId || nextSpeakerId === previousSpeakerId) continue
    replies.set(index, nextSpeakerId)
  }
  return replies
}

function hasSustainedUnnamedNarration(
  paragraphs: PlaybackParagraph[],
  startIndex: number,
  speakers: CharacterLike[],
): boolean {
  let narrationLength = 0
  for (let index = startIndex; index < paragraphs.length; index++) {
    const paragraph = paragraphs[index]
    if (hasSpeakerMentions(mentionedSpeakers(paragraph.text, speakers))) break
    narrationLength += cleanPlaybackText(narrativeOnly(paragraph.text)).length
    if (narrationLength >= 160) return true
  }
  return false
}

function hasPronounSpeechAttribution(text: string): boolean {
  const narration = cleanPlaybackText(narrativeOnly(text))
  return new RegExp(`\\b(?:he|she|they)\\b[^.!?\\n]{0,40}\\b${SPEECH_VERBS}\\b`, 'iu').test(narration)
}

function pronounSpeechAttributionSubjects(text: string): Set<string> {
  const narration = cleanPlaybackText(narrativeOnly(text))
  const subjects = new Set<string>()
  const patterns = [
    new RegExp(`\\b(he|she|they)\\b[^.!?\\n]{0,80}\\b${SPEECH_VERBS}\\b`, 'giu'),
    new RegExp(`\\b${SPEECH_VERBS}\\b\\s+(he|she|they)\\b`, 'giu'),
  ]
  for (const pattern of patterns) {
    for (const match of narration.matchAll(pattern)) {
      const subject = (match[1] ?? '').toLowerCase()
      if (subject) subjects.add(subject)
    }
  }
  return subjects
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
    const quoteMatches = playbackQuotes(paragraph.text)
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
    const initialHistorySpeakerIds = new Set<string>()
    const continuationHistorySpeakerIds = new Set<string>()
    for (const quote of quoteMatches) {
      const quoteStart = paragraph.start + quote.start
      const quoteEnd = paragraph.start + quote.end
      const inference = inferQuotedSpeaker(
        content.slice(0, quoteStart),
        content.slice(quoteEnd),
        quote.text,
        speakers,
        defaultSpeakerId,
      )
      if (inference.source === 'explicit' && inference.speakerId) {
        explicitSpeakerIds.add(inference.speakerId)
      } else if (
        !pair
        && previousStrongSpeakerId
        && inference.source === 'history'
        && inference.confident
        && inference.speakerId === previousStrongSpeakerId
      ) {
        continuationHistorySpeakerIds.add(inference.speakerId)
      } else if (
        !pair
        && !previousStrongSpeakerId
        && inference.source === 'history'
        && inference.confident
        && inference.speakerId
      ) {
        initialHistorySpeakerIds.add(inference.speakerId)
      }
    }

    if (explicitSpeakerIds.size > 1) {
      pair = null
      previousStrongSpeakerId = null
      lastTurnSpeakerId = null
      continue
    }

    const explicitSpeakerId = explicitSpeakerIds.size === 1 ? [...explicitSpeakerIds][0] : null
    const initialHistorySpeakerId = initialHistorySpeakerIds.size === 1
      ? [...initialHistorySpeakerIds][0]
      : null
    const continuationHistorySpeakerId = continuationHistorySpeakerIds.size === 1
      && hasPronounSpeechAttribution(paragraph.text)
      ? [...continuationHistorySpeakerIds][0]
      : null
    const localSpeakerId = explicitSpeakerId
      ?? soleMentionedSpeaker(paragraph.text, speakers)
      ?? continuationHistorySpeakerId
      ?? initialHistorySpeakerId
    if (localSpeakerId) {
      if (pair && !pair.includes(localSpeakerId)) pair = null
      if (!pair && previousStrongSpeakerId && previousStrongSpeakerId !== localSpeakerId) {
        pair = [previousStrongSpeakerId, localSpeakerId]
      }
      previousStrongSpeakerId = localSpeakerId
      lastTurnSpeakerId = localSpeakerId
      continue
    }

    if (
      pair
      && lastTurnSpeakerId
      && pair.includes(lastTurnSpeakerId)
      && hasSustainedUnnamedNarration(paragraphs, paragraphIndex, speakers)
    ) {
      turns.set(paragraphIndex, lastTurnSpeakerId)
      pair = null
      previousStrongSpeakerId = lastTurnSpeakerId
    } else if (pair && lastTurnSpeakerId && pair.includes(lastTurnSpeakerId)) {
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

export function speakerReviewQuotes(content: string, skippedTrackerTagPairs = ''): string[] {
  const playbackContent = preparePlaybackContent(content, skippedTrackerTagPairs)
  return playbackQuotes(playbackContent).map(quote => cleanPlaybackText(quote.text))
}

export function needsLlmSpeakerReview(
  content: string,
  defaultSpeakerId: string | null,
  speakers: CharacterLike[],
  skippedTrackerTagPairs = '',
): boolean {
  const playbackContent = preparePlaybackContent(content, skippedTrackerTagPairs)
  for (const quote of playbackQuotes(playbackContent)) {
    if (!cleanPlaybackText(quote.text)) continue
    const inference = inferQuotedSpeaker(
      playbackContent.slice(0, quote.start),
      playbackContent.slice(quote.end),
      quote.text,
      speakers,
      defaultSpeakerId,
    )
    if (inference.source === 'history' || inference.source === 'fallback') return true
  }
  return false
}

function parseRosterVoiceSegmentsInternal(
  content: string,
  defaultSpeakerId: string | null,
  speakers: CharacterLike[],
  skippedTrackerTagPairs = '',
  quoteSpeakerOverrides?: ReadonlyMap<number, string | null>,
  historicalSpeakerId: string | null = null,
  preserveLocalOnNullOverride = false,
): PlaybackSegment[] {
  const playbackContent = preparePlaybackContent(content, skippedTrackerTagPairs)
  const result: PlaybackSegment[] = []
  const quotes = playbackQuotes(playbackContent)
  const paragraphs = playbackParagraphs(playbackContent)
  const openingBackfill = initialDialogueBackfill(paragraphs, speakers)
  const dialogueTurns = paragraphDialogueTurns(playbackContent, speakers, defaultSpeakerId)
  const downstreamReplies = downstreamNarrativeReplySpeakers(
    playbackContent,
    paragraphs,
    speakers,
    defaultSpeakerId,
  )
  const paragraphSpeakers = paragraphs.map(paragraph => (
    unambiguousNarrativeSpeaker(paragraph.text, speakers)
  ))
  let paragraphIndex = 0
  let cursor = 0
  let lastConfidentSpeakerId: string | null = null
  let lastAssignedSpeakerId: string | null = null
  let historicalPrefixActive = historicalSpeakerId !== null
  let quoteIndex = 0
  for (const quote of quotes) {
    const currentQuoteIndex = quoteIndex
    quoteIndex += 1
    while (paragraphIndex + 1 < paragraphs.length && quote.start >= paragraphs[paragraphIndex].end) {
      paragraphIndex += 1
    }
    const bridge = playbackContent.slice(cursor, quote.start)
    const narration = cleanPlaybackText(bridge)
    if (narration) result.push({ text: narration, speakerId: null })
    const speech = cleanPlaybackText(quote.text)
    if (speech) {
      const inference = inferQuotedSpeaker(
        playbackContent.slice(0, quote.start),
        playbackContent.slice(quote.end),
        quote.text,
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
      const openingSpeakerId = inference.source === 'fallback'
        && openingBackfill?.paragraphIndexes.has(paragraphIndex)
        ? openingBackfill.speakerId
        : null
      const currentEvidenceSpeakerId = paragraphSpeakers[paragraphIndex]
        ?? (inference.confident ? inference.speakerId : null)
      if (
        historicalPrefixActive
        && (
          inference.source === 'explicit'
          || inference.source === 'paragraph'
          || (paragraphSpeakers[paragraphIndex] !== null
            && currentEvidenceSpeakerId !== historicalSpeakerId)
        )
      ) {
        historicalPrefixActive = false
      }
      const historicalFallbackId = historicalPrefixActive
        && (inference.source === 'history' || inference.source === 'fallback')
        ? historicalSpeakerId
        : null
      const localSpeakerId: string | null = paragraphSpeakers[paragraphIndex]
        ?? downstreamReplies.get(paragraphIndex)
        ?? inferredTurnSpeakerId
        ?? continuedSpeakerId
        ?? historicalFallbackId
        ?? openingSpeakerId
        ?? inference.speakerId
      const overrideSpeakerId = quoteSpeakerOverrides?.get(currentQuoteIndex) ?? null
      const hasOverride = quoteSpeakerOverrides?.has(currentQuoteIndex) === true
      const speakerId: string | null = hasOverride
        && (!preserveLocalOnNullOverride || overrideSpeakerId !== null || localSpeakerId === null)
        ? overrideSpeakerId
        : localSpeakerId
      result.push({
        text: speech,
        speakerId,
      })
      if ((inference.confident || openingSpeakerId) && speakerId) lastConfidentSpeakerId = speakerId
      if (speakerId) lastAssignedSpeakerId = speakerId
    }
    cursor = quote.end
  }
  const narration = cleanPlaybackText(playbackContent.slice(cursor))
  if (narration) result.push({ text: narration, speakerId: null })
  return result
}

export function parseRosterVoiceSegments(
  content: string,
  defaultSpeakerId: string | null,
  speakers: CharacterLike[],
  skippedTrackerTagPairs = '',
  historicalSpeakerId: string | null = null,
): PlaybackSegment[] {
  return parseRosterVoiceSegmentsInternal(
    content,
    defaultSpeakerId,
    speakers,
    skippedTrackerTagPairs,
    undefined,
    historicalSpeakerId,
  )
}

export function parseRosterVoiceSegmentsWithAssignments(
  content: string,
  defaultSpeakerId: string | null,
  speakers: CharacterLike[],
  assignments: LlmSpeakerAssignment[],
  skippedTrackerTagPairs = '',
  historicalSpeakerId: string | null = null,
  preserveLocalOnNullOverride = false,
): PlaybackSegment[] {
  return parseRosterVoiceSegmentsInternal(
    content,
    defaultSpeakerId,
    speakers,
    skippedTrackerTagPairs,
    new Map(assignments.map(assignment => [assignment.quote, assignment.speakerId])),
    historicalSpeakerId,
    preserveLocalOnNullOverride,
  )
}

/** Resolve an identity-free message from the immediately preceding assistant turn. */
export function previousAssistantSpeakerFallback(
  content: string,
  previousAssistantContent: string,
  previousDefaultSpeakerId: string | null,
  speakers: CharacterLike[],
  skippedTrackerTagPairs = '',
): string | null {
  const playbackContent = preparePlaybackContent(content, skippedTrackerTagPairs)
  const quoteMatches = playbackQuotes(playbackContent)
    .filter(quote => !!cleanPlaybackText(quote.text))
  if (quoteMatches.length === 0) return null

  const previousContent = preparePlaybackContent(previousAssistantContent, skippedTrackerTagPairs)
  const previousParagraphs = playbackParagraphs(previousContent)
  let previousSpeakerId: string | null = null
  for (let index = previousParagraphs.length - 1; index >= 0; index--) {
    const paragraph = previousParagraphs[index]
    const speakerId = preferredMentionedSpeaker(
      paragraph.text,
      speakers,
      mentionedSpeakers(paragraph.text, speakers),
    )
    if (speakerId) {
      previousSpeakerId = speakerId
      break
    }
  }
  if (!previousSpeakerId) {
    const previousSegments = parseRosterVoiceSegmentsInternal(
      previousAssistantContent,
      previousDefaultSpeakerId,
      speakers,
      skippedTrackerTagPairs,
    )
    for (let index = previousSegments.length - 1; index >= 0; index--) {
      if (previousSegments[index].speakerId) {
        previousSpeakerId = previousSegments[index].speakerId
        break
      }
    }
  }
  if (!previousSpeakerId) return null

  let hasOpeningContinuity = false
  let openingContinuityEnd = 0
  const currentParagraphs = playbackParagraphs(playbackContent)
  for (const quote of quoteMatches) {
    const inference = inferQuotedSpeaker(
      playbackContent.slice(0, quote.start),
      playbackContent.slice(quote.end),
      quote.text,
      speakers,
      null,
    )
    if (inference.source === 'explicit' || inference.source === 'paragraph') break
    if (
      inference.source === 'history'
      && inference.speakerId
      && inference.speakerId !== previousSpeakerId
    ) {
      if (!hasOpeningContinuity) break
      // A different name in preceding narration is weaker than an actual
      // dialogue attribution. Keep the established opening continuity; the
      // segment parser will close it on explicit current-message evidence.
    }
    hasOpeningContinuity = true
    openingContinuityEnd = currentParagraphs.find(paragraph => (
      quote.start >= paragraph.start && quote.start < paragraph.end
    ))?.end ?? quote.end
  }
  if (!hasOpeningContinuity) return null
  if (pronounSpeechAttributionSubjects(playbackContent.slice(0, openingContinuityEnd)).size > 1) {
    return null
  }
  return previousSpeakerId
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
