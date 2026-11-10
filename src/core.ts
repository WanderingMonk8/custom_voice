export const CONFIG_KEY = 'chat_voice'
export const USER_SPEAKER_ID = '__chat_voice_user__'
export const UNCAST_SPEAKER_ID = '__chat_voice_uncast__'
/** Standard Jev review policy, independent of retired per-user experiment flags. */
export function standardSpeakerReviewPolicy() {
  return { runReview: true, bestAvailableSpeaker: true, shadowEvaluation: false, focusedOpeningFallback: false } as const
}

export interface AutoplayGeneration { chatId: string; messageId: string; generationId: string; reroll?: boolean; content?: string }

/** Accept successful foreground new messages and rerolls in the active chat. */
export function autoplayGenerationEvent(value: unknown, activeChatId: string | null): AutoplayGeneration | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !activeChatId) return null
  const event = value as Record<string, unknown>
  if (event.chatId !== activeChatId || typeof event.messageId !== 'string' || !event.messageId.trim()
    || typeof event.generationId !== 'string' || !event.generationId.trim() || event.error || event.backgroundSwipe === true) return null
  const kind = typeof event.generationType === 'string' ? event.generationType.trim().toLowerCase() : ''
  if (['continue', 'impersonate'].includes(kind)) return null
  const reroll = kind === 'regenerate' || kind === 'swipe'
  return { chatId: activeChatId, messageId: event.messageId, generationId: event.generationId,
    ...(reroll ? { reroll: true } : {}), ...(typeof event.content === 'string' ? { content: event.content } : {}) }
}

/** Deduplicate reconnect/repeated notifications while bounding in-memory state. */
export function claimAutoplayGeneration(event: AutoplayGeneration, generations: Set<string>, messages: Set<string>): boolean {
  const generationKey = `${event.chatId}\u0000${event.generationId}`
  const messageKey = `${event.chatId}\u0000${event.messageId}`
  if (generations.has(generationKey)) return false
  generations.add(generationKey)
  messages.add(messageKey)
  if (generations.size > 512) generations.delete(generations.values().next().value!)
  if (messages.size > 512) messages.delete(messages.values().next().value!)
  return true
}

/** Legacy attachments without a swipe ID belong to the original swipe only. */
export function hasAudioForActiveSwipe(message: { swipe_id?: number; extra?: Record<string, unknown> }): boolean {
  const attachments = message.extra?.attachments
  if (!Array.isArray(attachments)) return false
  const swipe = message.swipe_id ?? 0
  return attachments.some(candidate => {
    if (!candidate || typeof candidate !== 'object') return false
    const attachment = candidate as { type?: unknown; swipe_id?: unknown }
    return attachment.type === 'audio' && (attachment.swipe_id ?? 0) === swipe
  })
}

export interface AutoplaySwipeSnapshot { swipeId: number; contentHash: string; swipeDate?: number }
export function autoplaySwipeSnapshot(message: { swipe_id?: number; content: string; swipe_dates?: number[] }): AutoplaySwipeSnapshot {
  const swipeId = message.swipe_id ?? 0
  const swipeDate = message.swipe_dates?.[swipeId]
  return { swipeId, contentHash: hashMessageContent(message.content), ...(typeof swipeDate === 'number' && Number.isFinite(swipeDate) ? { swipeDate } : {}) }
}

export function autoplaySwipeMatches(message: { swipe_id?: number; content: string; swipe_dates?: number[] }, expected: AutoplaySwipeSnapshot): boolean {
  const actual = autoplaySwipeSnapshot(message)
  return actual.swipeId === expected.swipeId && actual.contentHash === expected.contentHash
    && (expected.swipeDate === undefined || actual.swipeDate === expected.swipeDate)
}

/** Accept same-swipe edits during the delay but never follow a different swipe. */
export function refreshAutoplaySwipe(message: { swipe_id?: number; content: string; swipe_dates?: number[] }, original: AutoplaySwipeSnapshot): AutoplaySwipeSnapshot | null {
  const current = autoplaySwipeSnapshot(message)
  if (current.swipeId !== original.swipeId) return null
  if (original.swipeDate !== undefined && current.swipeDate !== original.swipeDate) return null
  return current
}

export function swipeSynthesisKey(chatId: string, messageId: string, swipeId: number): string {
  return `${chatId}\u0000${messageId}\u0000${swipeId}`
}

/** A save is confirmed only when the host attaches that audio to the target swipe. */
export function savedAudioMatchesSwipe(result: { message?: { id?: string; extra?: { attachments?: Array<{ type?: string; image_id?: string; swipe_id?: number }> } }; audio?: { id?: string }; swipe_id?: number }, messageId: string, swipeId: number): boolean {
  const audioId = result.audio?.id
  return result.message?.id === messageId && result.swipe_id === swipeId && !!audioId
    && !!result.message.extra?.attachments?.some(item => item?.type === 'audio' && item.image_id === audioId && item.swipe_id === swipeId)
}

/** Existing audio does not block autoplay; saving is governed separately. */
export function automaticPlaybackSkipReason(message: { is_user: boolean; swipe_id?: number; content: string; swipe_dates?: number[] }, expected?: AutoplaySwipeSnapshot): 'user-message' | 'changed-swipe' | null {
  if (message.is_user) return 'user-message'
  if (expected && !autoplaySwipeMatches(message, expected)) return 'changed-swipe'
  return null
}

/** Preserve explicit casting opt-outs; automatic playback requires an opt-in. */
export function readAutomaticVoicePreferences(value: Record<string, unknown>) {
  return { autoVoiceCasting: value.chatVoiceAutoCasting !== false, autoPlayback: value.chatVoiceAutoPlayback === true }
}

export const MAX_AUTOPLAY_DELAY_SECONDS = 3600
export function readAutoplayDelaySeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.min(MAX_AUTOPLAY_DELAY_SECONDS, Math.max(0, Math.round(value)))
}
/** Choose a global extension preference, then Lumiverse's global default. */
export function globalTtsConnectionPreference(value: Record<string, unknown>): string {
  const chosen = typeof value.chatVoiceTtsConnectionId === 'string' ? value.chatVoiceTtsConnectionId : value.ttsConnectionId
  return typeof chosen === 'string' ? chosen.trim().slice(0, 128) : ''
}

export function resolveGlobalTtsConnection(preference: string, connections: Array<{ id: string; is_default?: boolean }>): string {
  return preference || connections.find(connection => connection.is_default)?.id || ''
}
/** A speech span whose identity is unknown; unlike null, this is not narration. */
export const UNRESOLVED_SPEAKER_ID = '__chat_voice_unresolved__'
export const DEFAULT_MESSAGE_LIMIT = 20
export const MIN_MESSAGE_LIMIT = 1
export const MAX_MESSAGE_LIMIT = 500
export const DEFAULT_SAVED_AUDIO_LIMIT = 50
export const MAX_SAVED_AUDIO_LIMIT = 10_000

export interface FavoriteVoice {
  id: string
  name: string
  /** Free-form classification. Legacy values 'male'/'female'/'unspecified' still read fine. */
  category: string
  description: string
  gender?: 'male' | 'female' | undefined
  author?: string
  source?: 'community' | 'favorite' | undefined
  communityLink?: string
  tags?: string[] | undefined
  languages?: string[] | undefined
}

/** Derive a male/female hint from a free-form category string. */
export function voiceCategoryGender(category: string): 'male' | 'female' | 'unspecified' {
  const value = (category ?? '').trim().toLowerCase()
  if (!value) return 'unspecified'
  if (/\bfemale\b/.test(value)) return 'female'
  if (/\bmale\b/.test(value)) return 'male'
  return 'unspecified'
}

/** Gender hint for a stored favorite, falling back to tag/category inspection. */
export function voiceGender(voice: { category: string; tags?: readonly string[]; gender?: 'male' | 'female' | undefined }): 'male' | 'female' | 'unknown' {
  if (voice.gender === 'male' || voice.gender === 'female') return voice.gender
  const fromCategory = voiceCategoryGender(voice.category)
  if (fromCategory !== 'unspecified') return fromCategory
  for (const tag of voice.tags ?? []) {
    const tagGender = voiceCategoryGender(tag)
    if (tagGender !== 'unspecified') return tagGender
  }
  return 'unknown'
}

/** Age hint for a stored favorite, read from its tags. */
export function voiceAge(voice: { tags?: readonly string[] }): 'young' | 'middle aged' | 'old' | 'unknown' {
  for (const tag of voice.tags ?? []) {
    const value = tag.trim().toLowerCase()
    if (value === 'young' || value === 'middle aged' || value === 'old') return value
  }
  return 'unknown'
}

/** A voice is eligible for a gendered role when its hint agrees or is unknown. */
export function voiceGenderCompatible(voice: { category: string; tags?: readonly string[]; gender?: 'male' | 'female' | undefined }, gender: 'male' | 'female' | 'unknown'): boolean {
  const hint = voiceGender(voice)
  return gender === 'unknown' || hint === 'unknown' || hint === gender
}

/** Validate globally saved favorites without changing the case of provider IDs. */
export function readFavoriteVoices(value: unknown): FavoriteVoice[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: FavoriteVoice[] = []
  for (const item of value.slice(0, 500)) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    if (typeof row.id !== 'string') continue
    const id = row.id.trim().slice(0, 512)
    if (!id || seen.has(id)) continue
    seen.add(id)
    result.push({
      id,
      name: typeof row.name === 'string' ? row.name.trim().slice(0, 128) : '',
      category: typeof row.category === 'string' && row.category.trim()
        ? row.category.trim().slice(0, 64)
        : 'unspecified',
      description: typeof row.description === 'string' ? row.description.trim().slice(0, 500) : '',
      ...(row.gender === 'male' || row.gender === 'female' ? { gender: row.gender } : {}),
      ...(typeof row.author === 'string' && row.author.trim() ? { author: row.author.trim().slice(0, 128) } : {}),
      ...(row.source === 'community' || row.source === 'favorite' ? { source: row.source } : {}),
      ...(typeof row.communityLink === 'string' && row.communityLink.trim() ? { communityLink: row.communityLink.trim().slice(0, 512) } : {}),
      ...(Array.isArray(row.tags)
        ? { tags: row.tags.filter((value): value is string => typeof value === 'string').map(value => value.trim().slice(0, 64)).filter(Boolean).slice(0, 32) }
        : {}),
      ...(Array.isArray(row.languages)
        ? { languages: row.languages.filter((value): value is string => typeof value === 'string').map(value => value.trim().slice(0, 32)).filter(Boolean).slice(0, 8) }
        : {}),
    })
  }
  return result
}

/** A normalized Fish Audio community voice, safe to store and display. */
export interface CommunityVoice {
  id: string
  title: string
  description: string
  category: string
  tags: string[]
  languages: string[]
  author: string
  likeCount: number
  taskCount: number
  licensed: boolean
  licensedNote: string | null
  communityLink: string
}

const FISH_LANGUAGE_WORDS = new Set(['english', 'japanese', 'chinese', 'french', 'german', 'spanish', 'korean', 'italian', 'russian', 'portuguese', 'arabic', 'hindi', 'dutch', 'polish', 'turkish', 'vietnamese', 'thai', 'indonesian', 'en', 'ja', 'zh', 'fr', 'de', 'es', 'ko', 'it', 'ru', 'pt', 'ar', 'hi', 'nl', 'pl', 'tr', 'vi', 'th', 'id'])

/** Normalize one Fish `/model` payload entry into a community voice. */
export function readCommunityVoice(row: unknown): CommunityVoice | null {
  if (!row || typeof row !== 'object') return null
  const item = row as Record<string, unknown>
  const id = typeof item._id === 'string' ? item._id.trim().slice(0, 512) : ''
  if (!id) return null
  const title = typeof item.title === 'string' ? item.title.trim().slice(0, 128) : ''
  const description = typeof item.description === 'string' ? item.description.trim().slice(0, 500) : ''
  const tags = Array.isArray(item.tags)
    ? item.tags.filter((value): value is string => typeof value === 'string').map(value => value.trim().slice(0, 64)).filter(Boolean).slice(0, 16)
    : []
  const languages = Array.isArray(item.languages)
    ? item.languages.filter((value): value is string => typeof value === 'string').map(value => value.trim().slice(0, 32)).filter(Boolean).slice(0, 8)
    : []
  const author = item.author && typeof item.author === 'object' && typeof (item.author as Record<string, unknown>).nickname === 'string'
    ? (item.author as Record<string, unknown>).nickname as string
    : ''
  const likeCount = typeof item.like_count === 'number' && Number.isFinite(item.like_count) ? Math.max(0, Math.round(item.like_count)) : 0
  const taskCount = typeof item.task_count === 'number' && Number.isFinite(item.task_count) ? Math.max(0, Math.round(item.task_count)) : 0
  const licensed = item.licensed === true
  const classification = tags.find(tag => !['male', 'female'].includes(tag.toLowerCase()) && !FISH_LANGUAGE_WORDS.has(tag.toLowerCase()))
  return {
    id,
    title,
    description,
    category: classification ?? '',
    tags,
    languages,
    author: author.trim().slice(0, 128),
    likeCount,
    taskCount,
    licensed,
    licensedNote: licensed ? 'Licensed by Fish Audio (rights secured from the voice owner)' : null,
    communityLink: `https://fish.audio/m/${id}`,
  }
}

/** One level of `{ data }` / `{ result }` wrapping is tolerated so composer envelopes work too. */
function unwrapCommunityPayload(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object') return null
  const row = payload as Record<string, unknown>
  if (Array.isArray(row.items) || Array.isArray(row.data) || Array.isArray(row.models)) return row
  for (const key of ['data', 'result', 'response'] as const) {
    const nested = unwrapCommunityPayload(row[key])
    if (nested) return nested
  }
  if (Array.isArray(payload)) return { items: payload }
  return null
}

/** Parse a Fish `/model` list payload into community voices plus pagination. */
export function readCommunityVoiceList(payload: unknown): { items: CommunityVoice[]; total: number; hasMore: boolean } | null {
  const row = unwrapCommunityPayload(payload)
  if (!row) return null
  const rawItems = Array.isArray(row.items) ? row.items
    : Array.isArray(row.data) ? row.data
      : Array.isArray(row.models) ? row.models
        : null
  if (!rawItems) return null
  const items = rawItems.flatMap(item => {
    const voice = readCommunityVoice(item)
    return voice ? [voice] : []
  }).slice(0, 100)
  return {
    items,
    total: typeof row.total === 'number' && Number.isFinite(row.total) ? Math.max(0, Math.round(row.total)) : items.length,
    hasMore: row.has_more === true,
  }
}

/** A short, secret-free summary of a failed catalog payload for diagnostics. */
export function communityPayloadShape(payload: unknown): string {
  if (payload === null || payload === undefined) return 'no response body'
  if (typeof payload === 'string') return `text ${payload.length} chars: ${payload.slice(0, 120)}`
  if (Array.isArray(payload)) return `array of ${payload.length}`
  if (typeof payload === 'object') {
    const row = payload as Record<string, unknown>
    const parts = Object.keys(row).slice(0, 8).map(key => {
      const value = row[key]
      const kind = Array.isArray(value) ? `array(${value.length})` : typeof value
      return `${key}:${kind}`
    })
    const message = typeof row.error === 'string' ? row.error
      : row.error && typeof row.error === 'object' && typeof (row.error as Record<string, unknown>).message === 'string'
        ? (row.error as Record<string, unknown>).message as string
        : typeof row.message === 'string' ? row.message : ''
    return `${parts.join(', ')}${message ? ` message: ${String(message).slice(0, 120)}` : ''}`
  }
  return typeof payload
}

/** The cached casting pool is stored as favorites so casting code is pool-agnostic. */
export function readCommunityVoicePool(value: unknown): FavoriteVoice[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 500).flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const row = item as Record<string, unknown>
    const voice = readCommunityVoice(row)
    if (!voice) {
      const fallback = readFavoriteVoices([row])
      return fallback
    }
    return [communityVoiceToFavorite(voice)]
  })
}

/** Import a community voice into the user's favorites with its metadata preserved. */
export function communityVoiceToFavorite(voice: CommunityVoice): FavoriteVoice {
  const gender = ['male', 'female'].find(tag => voice.tags.some(item => item.toLowerCase() === tag)) as 'male' | 'female' | undefined
  return {
    id: voice.id,
    name: voice.title,
    category: voice.category || (gender ?? 'unspecified'),
    description: voice.description,
    ...(gender ? { gender } : {}),
    ...(voice.author ? { author: voice.author } : {}),
    source: 'community',
    communityLink: voice.communityLink,
    ...(voice.tags.length ? { tags: voice.tags } : {}),
    ...(voice.languages.length ? { languages: voice.languages } : {}),
  }
}

/** Add or update a favorite from the community catalog so imports are idempotent. */
export function upsertCommunityFavorite(existing: FavoriteVoice[], voice: CommunityVoice): FavoriteVoice[] {
  const favorite = communityVoiceToFavorite(voice)
  const id = favorite.id.trim().slice(0, 512)
  if (!id) throw new Error('That community voice has no voice ID.')
  if (!existing.some(item => item.id === id) && existing.length >= 500) throw new Error('The favorites list is limited to 500 voices.')
  if (existing.some(item => item.id === id)) {
    return existing.map(item => (item.id === id ? { ...item, ...favorite, id } : item))
  }
  return [...existing, favorite]
}

/** Reject duplicate provider IDs while preserving all existing favorites. */
export function addFavoriteVoice(existing: FavoriteVoice[], voice: FavoriteVoice): FavoriteVoice[] {
  const id = voice.id.trim().slice(0, 512)
  if (!id) throw new Error('Enter a voice ID to add a favorite.')
  if (existing.some(item => item.id === id)) throw new Error('That voice ID is already a favorite.')
  if (existing.length >= 500) throw new Error('The favorites list is limited to 500 voices.')
  return [...existing, { ...voice, id }]
}

export interface UncastVoiceGroup { id: string; speakerId: string; segmentIndexes: number[]; speeches: string[]; context: string[]; addressee?: string; flankPartners?: string[]; pronounPartners?: string[]; pronounGender?: 'male' | 'female'; narratedName?: string; inferredName?: string }
export interface GhostOccurrenceEvidence { messageId: string; messageHash: string; speechHash: string; version: 'occurrence-1'; reason: string }
export interface GhostVoice { id: string; speakerId: string; voiceId: string; context: string; occurrenceKeys: string[]; lastSeenMessageId: string; label?: string; createdAtMessageId?: string; lastInvokedAtMessageId?: string; invokedMessageIds?: string[]; aliases?: string[]; conversationHistory?: Array<{ messageId: string; text: string }>; occurrenceEvidence?: GhostOccurrenceEvidence[] }
export const GHOST_VOICE_LIFETIME_MESSAGES = 10

export function readGhostVoices(value: unknown): GhostVoice[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 200).flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const row = item as Record<string, unknown>
    if (typeof row.id !== 'string' || typeof row.speakerId !== 'string' || typeof row.voiceId !== 'string' || !row.id || !row.voiceId) return []
    return [{ id: row.id.slice(0, 128), speakerId: row.speakerId.slice(0, 256), voiceId: row.voiceId.slice(0, 512),
      label: typeof row.label === 'string' ? row.label.trim().slice(0, 100) : '',
      aliases: mergeGhostAliases(Array.isArray(row.aliases) ? row.aliases.filter((value): value is string => typeof value === 'string') : []),
      context: typeof row.context === 'string' ? row.context.slice(0, 2_000) : '',
      occurrenceKeys: Array.isArray(row.occurrenceKeys) ? row.occurrenceKeys.filter((key): key is string => typeof key === 'string').slice(-100) : [],
      occurrenceEvidence: Array.isArray(row.occurrenceEvidence) ? row.occurrenceEvidence.flatMap(entry => {
        if (!entry || typeof entry !== 'object') return []
        const item = entry as Record<string, unknown>
        if (item.version !== 'occurrence-1' || typeof item.messageId !== 'string' || !item.messageId || typeof item.messageHash !== 'string' || !item.messageHash || typeof item.speechHash !== 'string' || !item.speechHash || typeof item.reason !== 'string') return []
        return [{ messageId: item.messageId.slice(0, 256), messageHash: item.messageHash.slice(0, 128), speechHash: item.speechHash.slice(0, 128), version: 'occurrence-1' as const, reason: item.reason.slice(0, 256) }]
      }).slice(-100) : [],
      lastSeenMessageId: typeof row.lastSeenMessageId === 'string' ? row.lastSeenMessageId : '',
      invokedMessageIds: Array.isArray(row.invokedMessageIds) ? row.invokedMessageIds.filter((id): id is string => typeof id === 'string') : [],
      conversationHistory: Array.isArray(row.conversationHistory) ? row.conversationHistory.flatMap(entry => {
        if (!entry || typeof entry !== 'object') return []
        const item = entry as Record<string, unknown>
        return typeof item.messageId === 'string' && typeof item.text === 'string' && item.messageId && item.text
          ? [{ messageId: item.messageId.slice(0, 256), text: item.text.slice(0, 6_000) }] : []
      }).slice(-3) : [],
      ...(typeof row.createdAtMessageId === 'string' && row.createdAtMessageId ? { createdAtMessageId: row.createdAtMessageId } : {}),
      ...(typeof row.lastInvokedAtMessageId === 'string' && row.lastInvokedAtMessageId ? { lastInvokedAtMessageId: row.lastInvokedAtMessageId } : {}) }]
  })
}

/** Add bounded provenance without deleting legacy occurrence keys or user data. */
export function recordGhostOccurrence(ghost: GhostVoice, messageId: string, messageHash: string, speechHash: string, reason: string): void {
  if (!messageId || !messageHash || !speechHash) return
  const entries = (ghost.occurrenceEvidence ?? []).filter(item => item.messageId !== messageId || item.speechHash !== speechHash)
  entries.push({ messageId: messageId.slice(0, 256), messageHash: messageHash.slice(0, 128), speechHash: speechHash.slice(0, 128), version: 'occurrence-1', reason: reason.slice(0, 256) })
  ghost.occurrenceEvidence = entries.slice(-100)
}

/** Preserve recent complete exchanges without moving an older replay to the present. */
export function updateGhostConversationHistory(ghost: GhostVoice, messageId: string, message: string, assistantMessageIds: readonly string[]): void {
  const text = message.trim().slice(0, 6_000)
  if (!messageId || !text) return
  const entries = (ghost.conversationHistory ?? []).filter(item => item.messageId !== messageId)
  entries.push({ messageId, text })
  entries.sort((a, b) => assistantMessageIds.indexOf(a.messageId) - assistantMessageIds.indexOf(b.messageId))
  ghost.conversationHistory = entries.slice(-3)
}

/** Keep only unique, complete aliases within the regular cast name limit. */
export function mergeGhostAliases(...sources: Array<readonly string[]>): string[] {
  const aliases: string[] = []
  const seen = new Set<string>()
  for (const source of sources) for (const value of source) for (const alias of speakerAliases(value)) {
    const key = alias.toLowerCase()
    if (seen.has(key) || [...aliases, alias].join(' / ').length > 4096) continue
    seen.add(key)
    aliases.push(alias)
  }
  return aliases
}

/** Include legacy names when promoting previously saved ghosts. */
export function ghostCastAliases(ghost: GhostVoice): string[] {
  return mergeGhostAliases(
    ghost.speakerId.startsWith('unconfigured:') ? [ghost.speakerId.slice('unconfigured:'.length)] : [],
    ghost.label ? [ghost.label] : [], ghost.aliases ?? [],
  )
}

/** Refresh expiry at the current chat head, even when an older message was played. */
export function markGhostVoiceInvoked(ghost: GhostVoice, assistantMessageIds: readonly string[], messageId: string): void {
  if (!messageId || ghost.invokedMessageIds?.includes(messageId) || ghost.occurrenceKeys.some(key => key.startsWith(`${messageId}:`))) return
  ghost.invokedMessageIds = [...(ghost.invokedMessageIds ?? []), messageId]
  const latest = assistantMessageIds.at(-1)
  if (latest) ghost.lastInvokedAtMessageId = latest
}

/** The caller supplies assistant-message IDs only, in chronological order. */
export function activeGhostVoices(ghosts: GhostVoice[], assistantMessageIds: readonly string[], targetId: string, lifetime = GHOST_VOICE_LIFETIME_MESSAGES): GhostVoice[] {
  const target = assistantMessageIds.indexOf(targetId)
  if (target < 0) return []
  return ghosts.filter(ghost => {
    if (ghost.occurrenceKeys.some(key => key.startsWith(`${targetId}:`))) return true
    const lastSeen = ghost.lastSeenMessageId ? assistantMessageIds.indexOf(ghost.lastSeenMessageId) : -1
    const createdAt = ghost.createdAtMessageId ? assistantMessageIds.indexOf(ghost.createdAtMessageId) : -1
    const invokedAt = ghost.lastInvokedAtMessageId ? assistantMessageIds.indexOf(ghost.lastInvokedAtMessageId) : -1
    const earlierOccurrences = ghost.occurrenceKeys.map(key => assistantMessageIds.indexOf(key.split(':', 1)[0])).filter(index => index >= 0 && index <= target)
    const activeSince = Math.max(lastSeen <= target ? lastSeen : -1, createdAt <= target ? createdAt : -1, invokedAt <= target ? invokedAt : -1, ...earlierOccurrences)
    return (activeSince >= 0 || !ghost.lastSeenMessageId) && activeSince <= target && target - activeSince <= Math.max(1, lifetime)
  })
}

/** Discard stored scene context once a temporary voice is no longer active. */
export function purgeExpiredGhostContexts(ghosts: GhostVoice[], assistantMessageIds: readonly string[], lifetime: number): boolean {
  const head = assistantMessageIds.at(-1)
  if (!head) return false
  const active = new Set(activeGhostVoices(ghosts, assistantMessageIds, head, lifetime).map(ghost => ghost.id))
  let changed = false
  for (const ghost of ghosts) {
    if (active.has(ghost.id) || (!ghost.context && !ghost.conversationHistory?.length)) continue
    ghost.context = ''
    ghost.conversationHistory = []
    changed = true
  }
  return changed
}

/** Group named unconfigured speakers by identity; anonymous runs stay separate. */
function hasStrongNarrativeName(text: string): boolean {
  const narrative = narrativeOnly(text)
  for (const match of narrative.matchAll(/\b([\p{Lu}][\p{Ll}\p{M}'’-]{1,39})\s+(?:is|was|has|had|stands|stood|sits|sat|turns|turned|looks|looked|says|said|asks|asked|answers|answered|replies|replied|huffs|huffed|slaps|slapped|calls|called|shouts|shouted|speaks|spoke|mutters|muttered|laughs|laughed|glances|glanced|walks|walked|moves|moved|steps|stepped|nods|nodded)\b/gu)) {
    const name = normalizeSpeakerName(match[1])
    if (name && !NON_NAME_PARAGRAPH_LEADS.has(name.toLowerCase())) return true
  }
  return false
}
const STORY_NARRATION_SKIP_STARTERS = new Set(['then', 'so', 'and', 'but', 'still', 'yet', 'meanwhile', 'now', 'anyway'])
const STORY_MALE_PRONOUNS = new Set(['he', 'him', 'hisself', 'himself', 'his'])
const STORY_FEMALE_PRONOUNS = new Set(['she', 'her', 'herself', 'hers'])
/** Gender of a narration paragraph's first-subject pronoun; named or neutral starts carry none. */
export function narrationFirstPronounClass(text: string): 'male' | 'female' | null {
  const tokens = text.toLowerCase().replace(/[^a-z'-]+/gu, ' ').split(/\s+/u).filter(Boolean)
  let head = tokens[0]
  if (!head) return null
  if (STORY_NARRATION_SKIP_STARTERS.has(head)) head = tokens[1] ?? ''
  if (STORY_MALE_PRONOUNS.has(head)) return 'male'
  if (STORY_FEMALE_PRONOUNS.has(head)) return 'female'
  return null
}
/**
 * The gendered pronoun class a group's first speech inherits from the
 * narration before it: the nearest class-bearing paragraph ("…then he
 * walked…"), a character introduction ("a man came in…"), or nothing when
 * the chain is interrupted by an explicit new character ("another man
 * came…") or a contrary pronoun. Speech does not count.
 */
export function backwardNarrationPronounGender(segments: PlaybackSegment[], fromIndex: number): 'male' | 'female' | null {
  const castNames = new Set<string>()
  for (const segment of segments) {
    const id = segment.speakerId
    if (id?.startsWith('npc:') || id?.startsWith('unconfigured:')) {
      const name = id.slice(id.indexOf(':') + 1).trim().toLowerCase()
      if (name) castNames.add(name)
    }
  }
  const mentionsCastCharacter = (text: string): boolean => {
    if (!castNames.size) return false
    const words = new Set(text.toLowerCase().replace(/[^a-z'-]+/gu, ' ').split(/\s+/u).filter(Boolean))
    for (const name of castNames) if (words.has(name)) return true
    return false
  }
  // Walk narration the same way a reader would: the paragraph nearest to
  // the speech decides its pronoun gender. One multi-paragraph narration
  // segment can introduce a man and later describe a cast speaker, so
  // classify paragraph by paragraph rather than segment by segment.
  for (let index = fromIndex - 1; index >= 0; index -= 1) {
    const segment = segments[index]
    if (!segment || segment.speakerId !== null) continue
    const paragraphs = segment.text.split(/\n\s*\n/u).filter(paragraph => paragraph.trim())
    for (let paragraphIndex = paragraphs.length - 1; paragraphIndex >= 0; paragraphIndex -= 1) {
      const text = paragraphs[paragraphIndex]
      // A paragraph that names a cast character describes that character,
      // not an emerging uncast chain; other paragraphs in the same segment
      // can still anchor the uncast chain.
      if (mentionsCastCharacter(text)) continue
      if (/(^|[.!?]\s+)(another|second|third|other)\s+(man|woman|girl|boy|lady|guy)\b/iu.test(text)) return null
      const introduction = text.match(/(?:^|[.!?]\s+)(?:a|an|the|one)\s+(man|woman|girl|boy|lady|guy)(?:\s+\w+){0,2}?\s+(?:came|entered|arrived|appeared|walked in|stepped in|strode in|drew close)\b/iu)
      if (introduction) return labelGenderHint(`the ${introduction[1]}`)
      // A paragraph that opens on a gendered person ("The guy stops…",
      // "A tall woman turns…") describes that person even though the
      // sentence has no leading pronoun. Without this, the scan skips the
      // introduction and inherits a gender from an earlier paragraph about
      // somebody else.
      const lead = text.trimStart().match(/^(?:the|a|an)\s+(?:(?:young|younger|old|older|elderly|middle-aged|tall|short|thin|heavy|bald|bearded|blond|blonde|brunette)\s+)*([a-z-]+)\b/iu)
      const leadHint = lead ? labelGenderHint(lead[1]) : null
      if (leadHint) return leadHint
      const klass = narrationFirstPronounClass(text)
      if (klass) return klass
    }
  }
  return null
}

export function collectUncastVoiceGroups(segments: PlaybackSegment[]): UncastVoiceGroup[] {
  const groups: UncastVoiceGroup[] = []
  const named = new Map<string, UncastVoiceGroup>()
  let anonymous: UncastVoiceGroup | null = null
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]
    const id = segment.speakerId
    // Never treat narration as dialogue, even if a malformed upstream segment carries a speaker ID.
    if (segment.debugPath?.some(step => step.startsWith('segment-type:narration'))) continue
    if (id === null) continue
    if (id !== UNCAST_SPEAKER_ID && !id.startsWith('unconfigured:') && !id.startsWith('ghost:')) { anonymous = null; continue }
    if (id !== UNCAST_SPEAKER_ID) anonymous = null
    // A substantial intervening narrative can introduce a different uncast
    // speaker even without an intervening cast quotation. Review each side.
    if (id === UNCAST_SPEAKER_ID && segments[index - 1]?.speakerId === null && segments[index - 1].text.length > 240) anonymous = null
    // Named actions and adjacent replies can signal a change of speaker.
    // Split for review; the action alone does not identify the quotation.
    // Dashed appositives (the man — Ellis —) are context candidates for
    // narration, not a split trigger: they may describe the same speaker's
    // next line (Hallie) and must not fragment her run.
    if (id === UNCAST_SPEAKER_ID && segments[index - 1]?.speakerId === null && hasStrongNarrativeName(segments[index - 1].text)) anonymous = null
    if (id === UNCAST_SPEAKER_ID && segments[index - 1]?.speakerId === UNCAST_SPEAKER_ID && segments[index - 2]?.speakerId === null && hasStrongNarrativeName(segments[index - 2].text)) anonymous = null
    // An invocation alone does not split an anonymous run: the same speaker can address one name and continue speaking (e.g. "Ellis." then the same woman's next line).
    let group: UncastVoiceGroup | null | undefined = id === UNCAST_SPEAKER_ID ? anonymous : named.get(id)
    if (!group) {
      group = { id: `g${groups.length}`, speakerId: id, segmentIndexes: [], speeches: [], context: [] }
      groups.push(group)
      if (id === UNCAST_SPEAKER_ID) anonymous = group
      else { named.set(id, group); anonymous = null }
    }
    group.segmentIndexes.push(index)
    group.speeches.push(segment.text)
    group.context.push([segments[index - 1]?.speakerId === null ? segments[index - 1].text : '', segment.text,
      segments[index + 1]?.speakerId === null ? segments[index + 1].text : ''].filter(Boolean).join(' ').slice(0, 2_000))
  }
  for (const group of groups) {
    const addressee = addressedNameBeforeGroup(group, segments)
    if (addressee) group.addressee = addressee
  }
  for (const group of groups) {
    if (group.speakerId === UNCAST_SPEAKER_ID) continue
    const first = Math.min(...group.segmentIndexes)
    const invokerIndex = adjacentQuoteIndex(segments, first, -1)
    if (invokerIndex < 0 || segments[invokerIndex].speakerId !== UNCAST_SPEAKER_ID) continue
    const invoked = vocativeNames(segments[invokerIndex].text)[0]
    if (!invoked) continue
    group.narratedName = invoked
    const invoker = groups.find(item => item.speakerId === UNCAST_SPEAKER_ID && item.segmentIndexes.includes(invokerIndex))
    if (!invoker) continue
    group.flankPartners = [...(group.flankPartners ?? []), invoker.id]
    invoker.flankPartners = [...(invoker.flankPartners ?? []), group.id]
  }
  for (const group of groups) {
    const first = Math.min(...group.segmentIndexes)
    const lead = segments[first - 1]
    if (!lead || lead.speakerId !== null) continue
    const named = lead.text.match(/^(\p{Lu}[\p{Ll}\p{M}'’-]{2,})\s+(?:says|said|asks|asked|murmurs|murmured|whispers|whispered|mutters|muttered|replies|replied|answers|answered|calls|called|tells|told|informs|informed|adds|added|continues|continued|shouts|shouted|yells|yelled|remarked|remarks|cries|cried|sighs|sighed|snaps|snapped)\b/u)
    if (named) group.narratedName = named[1].toLowerCase()
  }
  for (const group of groups) {
    if (group.addressee) continue
    const last = Math.max(...group.segmentIndexes)
    const nextIndex = adjacentQuoteIndex(segments, last, 1)
    const next = nextIndex >= 0 ? segments[nextIndex] : undefined
    if (!next || next.speakerId === UNCAST_SPEAKER_ID) continue
    const named = vocativeNames(next.text).find(name => name !== group.speakerId.replace(/^unconfigured:/u, ''))
    if (named) group.addressee = named
  }
  for (const group of groups) {
    const invoking = segments.findIndex((segment, index) => index < Math.min(...group.segmentIndexes) && segment.speakerId !== null && segment.speakerId !== UNCAST_SPEAKER_ID && new RegExp(`(?:^|,\\s*)${group.addressee}\\s*[.!?,]`, 'iu').test(segment.text))
    if (invoking < 0) continue
    const priorSpeech = segments.slice(0, invoking).reduce<number | undefined>((found, segment, index) => segment.speakerId === null ? found : index, undefined)
    const before = priorSpeech === undefined ? undefined : groups.find(item => item !== group && item.speakerId === UNCAST_SPEAKER_ID && item.segmentIndexes.includes(priorSpeech) && segments[priorSpeech].speakerId !== segments[invoking].speakerId)
    const after = group
    if (before) {
      after.flankPartners = [...(after.flankPartners ?? []), before.id]
      before.flankPartners = [...(before.flankPartners ?? []), after.id]
    }
  }
  // Pronoun-continuity partners: consecutive unnamed fragments whose first
  // speeches inherit the same gendered pronoun chain from the narration
  // before them ("…then he walked…", "…then she stood…") are the same
  // introduced character even when Jev only leans 'same'.
  const unnamedInOrder = groups
    .filter(group => group.speakerId === UNCAST_SPEAKER_ID)
    .sort((a, b) => Math.min(...a.segmentIndexes) - Math.min(...b.segmentIndexes))
  for (const group of unnamedInOrder) {
    group.pronounGender = backwardNarrationPronounGender(segments, Math.min(...group.segmentIndexes)) ?? undefined
  }
  for (let index = 1; index < unnamedInOrder.length; index += 1) {
    const previous = unnamedInOrder[index - 1]
    const group = unnamedInOrder[index]
    const gender = group.pronounGender
    if (!gender || gender !== previous.pronounGender) {
      // A fragment that does not join the chain keeps no pronoun credit:
      // its narration may describe somebody else (e.g. a cast speaker).
      group.pronounGender = undefined
      continue
    }
    previous.pronounPartners = [...(previous.pronounPartners ?? []), group.id]
    group.pronounPartners = [...(group.pronounPartners ?? []), previous.id]
  }
  // Mutual naming: two unnamed voices that each invoke a distinct name for
  // the other are those names, even when the message holds more voices than
  // the pair covers (e.g. Elena plus two non-invoking unnamed voices). Only
  // trailing ", Name." vocatives count here: standalone imperatives like
  // "First." / "Next." are discourse markers, not personal names.
  const unknownGroups = groups.filter(group => group.speakerId === UNCAST_SPEAKER_ID)
  const invokedByGroup = new Map(unknownGroups.map(group => [group.id, [...new Set(group.speeches.flatMap(speech => vocativeNames(speech)))]]))
  const invokingGroups = unknownGroups.filter(group => invokedByGroup.get(group.id)?.length === 1)
  const knownNames = new Set<string>()
  for (const segment of segments) {
    const id = segment.speakerId
    if (!id || id === UNCAST_SPEAKER_ID || id.startsWith('unconfigured:') || id.startsWith('ghost:') || id === USER_SPEAKER_ID || id === UNRESOLVED_SPEAKER_ID) continue
    knownNames.add(id.includes(':') ? id.slice(id.indexOf(':') + 1).toLowerCase() : id.toLowerCase())
  }
  const invokedCounts = new Map<string, number>()
  for (const names of invokedByGroup.values()) for (const name of names) invokedCounts.set(name, (invokedCounts.get(name) ?? 0) + 1)
  const nameIsEligible = (name: string) => !isBroadPersonLabel(name) && !knownNames.has(name) && invokedCounts.get(name) === 1
  if (invokingGroups.length === 2) {
    const [a, b] = invokingGroups
    const invokedA = invokedByGroup.get(a.id)![0]
    const invokedB = invokedByGroup.get(b.id)![0]
    if (invokedA !== invokedB && nameIsEligible(invokedA) && nameIsEligible(invokedB)) {
      a.inferredName = invokedB
      b.inferredName = invokedA
      a.addressee = invokedB
      b.addressee = invokedA
    }
  } else if (invokingGroups.length === 1) {
    const invoker = invokingGroups[0]
    const invoked = invokedByGroup.get(invoker.id)![0]
    if (nameIsEligible(invoked) && unknownGroups.length >= 2) {
      // Single invocation: the other participant in the same exchange is named.
      // Prefer the nearest neighbouring unknown group in appearance order
      // (even when a known voice interjects between them); fall back to the
      // predecessor when the invoker is last. Other voices stay unnamed.
      const sorted = [...unknownGroups].sort((x, y) => Math.min(...x.segmentIndexes) - Math.min(...y.segmentIndexes))
      const index = sorted.indexOf(invoker)
      const candidates = [sorted[index + 1], sorted[index - 1]].filter(Boolean) as UncastVoiceGroup[]
      const distance = (a: UncastVoiceGroup, b: UncastVoiceGroup) => Math.min(...a.segmentIndexes.flatMap(x => b.segmentIndexes.map(y => Math.abs(x - y))))
      candidates.sort((x, y) => distance(x, invoker) - distance(y, invoker)
        || (x === sorted[index + 1] ? -1 : 1) - (y === sorted[index + 1] ? -1 : 1))
      const partner = candidates.find(candidate => !candidate.inferredName && invokedByGroup.get(candidate.id)?.length === 0)
      if (partner) {
        partner.inferredName = invoked
        partner.addressee = invoked
      }
    }
  }
  return groups
}

/** Count speech voices in a message: unnamed groups plus distinct known speakers. */
export function countSpeechVoices(segments: PlaybackSegment[], groups: UncastVoiceGroup[]): number {
  const known = new Set<string>()
  for (const segment of segments) {
    const id = segment.speakerId
    if (!id || id === UNCAST_SPEAKER_ID || id.startsWith('unconfigured:') || id.startsWith('ghost:') || id === USER_SPEAKER_ID || id === UNRESOLVED_SPEAKER_ID) continue
    known.add(id)
  }
  return groups.length + known.size
}

/** Reserve a favorite only while it is unused; a character may keep its own voice. */
export function canReserveAutomaticVoice(voiceId: string, reserved: ReadonlySet<string>, ghosts: readonly GhostVoice[], existingGhostId = ''): boolean {
  return !!voiceId && !reserved.has(voiceId) && !ghosts.some(ghost => ghost.voiceId === voiceId && ghost.id !== existingGhostId)
}

/**
 * Select a random unused favorite from Jev's top-ranked candidates. Jev
 * decides which voices match the character from the available metadata
 * (category, tags, languages, description); the final voice is drawn
 * uniformly from that shortlist so the same candidate does not always win.
 */
export function selectAutomaticVoice(voices: FavoriteVoice[], used: ReadonlySet<string>, answer: SpeakerDecisionChoice, gender: string, random: () => number = Math.random): string {
  const eligible = voices.flatMap((voice, index) => {
    if (used.has(voice.id) || !voiceGenderCompatible(voice, gender as 'male' | 'female' | 'unknown')) return []
    return [{ voice, score: answer.probabilities[`voice_${index}`] ?? 0 }]
  })
  if (eligible.length === 1) return eligible[0].voice.id
  if (answer.choice === 'no_match' || !eligible.length) return ''
  const shortlist = shortlistRankedVoices(eligible, entry => entry.score)
  return shortlist[Math.min(shortlist.length - 1, Math.floor(random() * shortlist.length))].voice.id
}

/** Voices kept for the random pick, and how far below the top score a voice
 * may fall and still qualify. */
export const AUTO_VOICE_SHORTLIST_LIMIT = 5
export const AUTO_VOICE_SHORTLIST_FLOOR_RATIO = 0.2

/**
 * Keep the strongest Jev-ranked candidates and drop the also-rans. Voices
 * that never received a score (for example because the ranking call failed)
 * are not punished: when nothing scored, the whole compatible pool is
 * returned unchanged, and missing metadata never excludes a voice here.
 */
export function shortlistRankedVoices<T>(candidates: readonly T[], scoreOf: (candidate: T) => number, limit = AUTO_VOICE_SHORTLIST_LIMIT, floorRatio = AUTO_VOICE_SHORTLIST_FLOOR_RATIO): T[] {
  const scored = candidates.map(candidate => {
    const score = scoreOf(candidate)
    return { candidate, score: Number.isFinite(score) && score > 0 ? score : 0 }
  })
  const ranked = scored.filter(entry => entry.score > 0).sort((a, b) => b.score - a.score)
  if (!ranked.length) return [...candidates]
  const floor = ranked[0].score * Math.max(0, Math.min(1, floorRatio))
  return ranked.filter(entry => entry.score >= floor).slice(0, Math.max(1, Math.round(limit))).map(entry => entry.candidate)
}

/** Only unassigned favorites may be used; unspecified categories remain eligible. */
export function availableUncastVoices(favorites: FavoriteVoice[], used: readonly string[]): FavoriteVoice[] {
  const reserved = new Set(used.map(voice => voice.trim()).filter(Boolean))
  return favorites.filter(voice => !reserved.has(voice.id))
}

/**
 * The nearest quote from the given direction, skipping narration. Narration
 * that names a speaker ends the search, since it can claim nearby speeches.
 */
function adjacentQuoteIndex(segments: PlaybackSegment[], from: number, step: 1 | -1): number {
  for (let index = from + step; index >= 0 && index < segments.length; index += step) {
    const segment = segments[index]
    if (segment.speakerId !== null) return index
    if (uncastNarrativeNameCandidates(segment.text).length || /^[A-Z][a-z]{2,}\s+(?:says|said|murmurs|murmured|whispers|whispered|mutters|muttered|replies|replied|answers|answered|calls|called)\b/u.test(segment.text)) {
      if (narrationNamesInvokedSpeaker(segments, index)) continue
      return -1
    }
  }
  return -1
}

/** Narration that names a speaker who is invoked by an adjacent quote does not claim speeches. */
function narrationNamesInvokedSpeaker(segments: PlaybackSegment[], index: number): boolean {
  const named = segments[index].text.match(/^([A-Z][a-z]{2,})\s+(?:says|said|murmurs|murmured|whispers|whispered|mutters|muttered|replies|replied|answers|answered|calls|called)\b/u)
  if (!named) return false
  const name = named[1].toLowerCase()
  return [segments[index - 1], segments[index + 1]].some(quote => !!quote && quote.speakerId !== null && vocativeNames(quote.text).includes(name))
}

const UNCAST_VOCATIVE_STOPWORDS = new Set(['okay', 'yeah', 'yes', 'no', 'hello', 'hey', 'please', 'thanks', 'sorry', 'listen', 'look', 'wait', 'fine', 'well', 'honey', 'sweetie', 'darling', 'first', 'second', 'third', 'fourth', 'fifth', 'last', 'next', 'one', 'two', 'three', 'four', 'five', 'once', 'twice', 'again', 'then'])

/**
 * Names a quote addresses directly: a name that opens the quote or follows a
 * leading interjection and comma, set off by punctuation. A name merely
 * mentioned after a preposition, possessive, or inside a clause is not a vocative.
 */
export function vocativeNames(quote: string): string[] {
  const found = new Set<string>()
  const text = quote.trim()
  const push = (raw: string, prefix: string) => {
    const name = raw.toLowerCase()
    if (!name || UNCAST_VOCATIVE_STOPWORDS.has(name)) return
    if (/\b(?:on|at|to|for|with|about|from|of|by)\s*$/iu.test(prefix)) return
    found.add(name)
  }
  const leading = text.match(/^(?:[A-Za-z' ]+,\s*)?([A-Z][A-Za-z'-]*)\s*([.!?,;:])(?!\w)/u)
  if (leading) push(leading[1], text.slice(0, text.indexOf(leading[1])))
  for (const match of text.matchAll(/,\s*([A-Z][A-Za-z'-]*)\s*[.!?]/gu)) {
    push(match[1], text.slice(0, match.index))
  }
  return [...found]
}

/**
 * A name addressed in the quotation right after an unnamed group's speech is a
 * candidate for that group: the next speaker is talking to the group's speaker.
 * It is only a candidate; the label question decides whether it identifies them.
 */
export function addressedNameBeforeGroup(group: UncastVoiceGroup, segments: PlaybackSegment[]): string {
  if (group.speakerId !== UNCAST_SPEAKER_ID) return ''
  const first = Math.min(...group.segmentIndexes)
  const previousIndex = adjacentQuoteIndex(segments, first, -1)
  const previous = previousIndex >= 0 ? segments[previousIndex] : undefined
  if (!previous || previous.speakerId === UNCAST_SPEAKER_ID) return ''
  for (const name of vocativeNames(previous.text)) {
    if (!UNCAST_VOCATIVE_STOPWORDS.has(name)) return name
  }
  return ''
}

/** Shared labels plus this group's own addressee candidate, so only that group can take the name. */
export function groupLabelOptions(group: UncastVoiceGroup, labels: string[]): string[] {
  return group.addressee && !labels.includes(group.addressee) ? [...labels, group.addressee] : labels
}

/** Collect possible descriptive identities; Jev decides whether any refers to a speaker. */
export function uncastIdentityLabels(message: string, ghosts: GhostVoice[]): string[] {
  const labels = new Set<string>()
  for (const ghost of ghosts) for (const alias of ghostCastAliases(ghost)) labels.add(alias.toLowerCase())
  // Offer relationship labels as candidates, not facts: Jev must establish
  // which person speaks, who is addressed, and whose relationship it is.
  const names = addUnconfiguredDialogueSpeakers(message, []).slice(0, 12).map(speaker => speaker.name)
  const relations = [...new Set([...message.matchAll(/\b(?:mom|mother|mum|dad|father|sister|brother|daughter|son|wife|husband|partner|parent|aunt|uncle|friend|boss|doctor|nurse|teacher|assistant)\b/giu)].map(match => match[0].toLowerCase()))]
  for (const name of names) for (const relation of relations) {
    if (labels.size >= 60) break
    labels.add(`${name.toLowerCase()}'s ${relation}`)
  }
  for (const match of message.matchAll(/\b(?:the|an?)\s+([a-z][a-z'-]{2,})(?:['?]s)?\b/giu)) {
    labels.add(`the ${match[1].toLowerCase().replace(/['?]s$/u, '')}`)
    if (labels.size >= 80) break
  }
  return [...labels].slice(0, 80)
}

/** Offer narrative subject names as candidates only; Jev must identify the speaker. */
export function uncastNarrativeNameCandidates(message: string): string[] {
  const names = new Map<string, string>()
  const narrative = narrativeOnly(message)
  const pattern = /\b([\p{Lu}][\p{Ll}\p{M}'’-]{1,39})\s+(?:is|was|has|had|stands|stood|sits|sat|turns|turned|looks|looked|says|said|asks|asked|answers|answered|replies|replied)\b/gu
  for (const match of narrative.matchAll(pattern)) {
    const name = normalizeSpeakerName(match[1])
    if (!name || NON_NAME_PARAGRAPH_LEADS.has(name.toLowerCase())) continue
    names.set(name.toLowerCase(), name)
    if (names.size >= 20) break
  }
  // Action subjects are candidates, not automatic attributions: the named
  // actor can instead be an addressee, observer, or unrelated bystander.
  const actions = /\b([\p{Lu}][\p{Ll}\p{M}'’-]{1,39})\s+(?:huffs|huffed|slaps|slapped|calls|called|shouts|shouted|speaks|spoke|mutters|muttered|laughs|laughed|glances|glanced|walks|walked|moves|moved|steps|stepped|nods|nodded)\b/gu
  for (const match of narrative.matchAll(actions)) {
    const name = normalizeSpeakerName(match[1])
    if (!name || NON_NAME_PARAGRAPH_LEADS.has(name.toLowerCase())) continue
    names.set(name.toLowerCase(), name)
    if (names.size >= 20) break
  }
  // Dashed appositives name a participant in passing: "the man — Ellis — has
  // stopped" (double dash) and "now — Hallie, half-crouched" (single dash).
  // They are still only candidates. Hyphen forms are accepted too.
  const dashed = /(?:—+|–+|--+|-)\s*([\p{Lu}][\p{Ll}\p{M}'’-]{1,39})\s*(?:—+|–+|--+|-|,)/gu
  for (const match of narrative.matchAll(dashed)) {
    const name = normalizeSpeakerName(match[1])
    if (!name || NON_NAME_PARAGRAPH_LEADS.has(name.toLowerCase())) continue
    names.set(name.toLowerCase(), name)
    if (names.size >= 20) break
  }
  return [...names.values()]
}

/** Expose only links to messages actually present in the bounded prior context. */
function ghostPriorMessageIds(ghost: GhostVoice, previousMessages: RelationshipReviewContext['previousMessages']): string[] {
  const linked = new Set([ghost.lastSeenMessageId, ...(ghost.conversationHistory ?? []).map(entry => entry.messageId), ...ghost.occurrenceKeys.map(key => key.split(':', 1)[0])])
  return previousMessages.filter(item => linked.has(item.id)).map(item => item.id)
}

const VOICE_DESCRIPTION_TAG_ALIASES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['young', ['young', 'youthful', 'adolescent', 'teen', 'teenage', 'teenaged', 'childlike']],
  ['middle aged', ['middle aged', 'mature']],
  ['old', ['old', 'aged', 'elderly', 'senior']],
  ['conversational', ['conversational', 'chatty', 'casual']],
  ['narration', ['narration', 'narrator']],
  ['character voice', ['character voice', 'roleplay', 'role play']],
  ['social media', ['social media']],
  ['educational', ['educational', 'tutorial', 'tutorials', 'instructional']],
  ['advertisement', ['advertisement', 'commercial', 'advert']],
  ['entertainment', ['entertainment', 'performer']],
  ['deep', ['deep', 'basso']],
  ['low', ['low', 'low pitched', 'baritone']],
  ['medium', ['medium', 'midrange', 'mid range']],
  ['high', ['high', 'high pitched', 'soprano', 'treble']],
  ['soft', ['soft', 'soft spoken']],
  ['bright', ['bright']],
  ['warm', ['warm', 'warmth']],
  ['dark', ['dark']],
  ['raspy', ['raspy', 'raspiness']],
  ['smooth', ['smooth']],
  ['breathy', ['breathy', 'breathiness']],
  ['husky', ['husky', 'huskiness']],
  ['energetic', ['energetic', 'lively', 'vigorous']],
  ['calm', ['calm', 'soothing']],
  ['relaxed', ['relaxed', 'laid back', 'unhurried']],
  ['fast', ['fast', 'quick', 'rapid']],
  ['slow', ['slow']],
  ['measured', ['measured', 'deliberate', 'steady', 'even']],
  ['dynamic', ['dynamic', 'varied']],
  ['sexy', ['sexy', 'sultry']],
  ['friendly', ['friendly', 'approachable']],
  ['professional', ['professional', 'polished', 'corporate']],
  ['serious', ['serious', 'grave']],
  ['cheerful', ['cheerful', 'upbeat', 'sunny']],
  ['enthusiastic', ['enthusiastic', 'excited']],
  ['confident', ['confident', 'assured']],
  ['authoritative', ['authoritative', 'commanding']],
  ['gentle', ['gentle', 'tender']],
  ['empathetic', ['empathetic', 'compassionate']],
  ['playful', ['playful', 'mischievous']],
  ['dramatic', ['dramatic', 'theatrical']],
  ['intimate', ['intimate', 'intimacy', 'hushed', 'close']],
  ['mysterious', ['mysterious', 'enigmatic']],
  ['sad', ['sad', 'melancholic', 'mournful']],
  ['angry', ['angry', 'furious']],
  ['clear', ['clear', 'articulate']],
  ['crisp', ['crisp']],
  ['neutral tone', ['neutral tone', 'neutral']],
  ['expressive', ['expressive', 'emotive']],
  ['monotone', ['monotone', 'monotonous', 'flat']],
  ['animated', ['animated', 'animatedly']],
  ['storytelling', ['storytelling', 'storyteller']],
  ['narrative', ['narrative']],
  ['character', ['character']],
  ['announcer', ['announcer', 'announcing']],
  ['host', ['host', 'hosting']],
  ['teacher', ['teacher', 'teaching']],
  ['coach', ['coach', 'coaching']],
  ['anime', ['anime']],
  ['gaming', ['gaming']],
  ['cinematic', ['cinematic', 'filmic']],
  ['documentary', ['documentary']],
  ['radio', ['radio']],
  ['podcast', ['podcast']],
]

const escapeVoiceHintPattern = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const normalizeVoiceHintText = (value: string): string => value
  .toLowerCase()
  .replace(/[\u2013\u2014]/gu, '-')
  .replace(/[.!?;:]+/gu, ' § ')
  .replace(/\b(?:but|though|however|although|yet)\b/gu, ' § ')
  .replace(/[-_\u2018\u2019']/gu, ' ')
  .replace(/[^\p{L}\p{N}\s§]/gu, ' ')
  .replace(/\s+/gu, ' ')
  .trim()

/** Canonical Fish quality tags supported by a free-form description. */
export function voiceDescriptionTagHints(description: string): string[] {
  const text = normalizeVoiceHintText(description)
  if (!text) return []
  const hinted: string[] = []
  for (const [tag, aliases] of VOICE_DESCRIPTION_TAG_ALIASES) {
    const supports = aliases.some(alias => {
      const aliasText = normalizeVoiceHintText(alias)
      const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeVoiceHintPattern(aliasText)}(?![\\p{L}\\p{N}])`, 'gu')
      return text.split('§').some(clause => {
        return [...clause.matchAll(pattern)].some(match => {
          const start = match.index ?? 0
          const before = clause.slice(Math.max(0, start - 24), start)
          return !/\b(?:not|never|no|without|lacks|lacking|barely)\b/u.test(before)
        })
      })
    })
    if (supports) hinted.push(tag)
  }
  return hinted
}

/** One-line summary of a voice for the auto-cast ranking questions.
 * Includes tags and languages so Fish metadata (age, use case, qualities,
 * language) can influence the match, not just title/category/description.
 * Descriptions are broken down into the tags they support so their qualities
 * are scored across the tag system instead of as a vague, lengthy vote.
 * Missing fields are simply omitted: a sparse voice must not look worse than
 * a fully described one. */
export function voiceDecisionSummary(voice: FavoriteVoice): string {
  const tags = [...new Set((voice.tags ?? []).map(tag => tag.trim().toLowerCase()).filter(Boolean))]
  const languages = [...new Set((voice.languages ?? []).map(code => code.trim().toLowerCase()).filter(Boolean))]
  const description = (voice.description ?? '').replace(/\s+/gu, ' ').trim()
  const descriptionSupport = voiceDescriptionTagHints(description)
  const parts = [voice.name, voice.category].map(part => (part ?? '').replace(/\s+/gu, ' ').trim()).filter(Boolean)
  if (languages.length) parts.push(`languages: ${languages.join(', ')}`)
  if (tags.length) parts.push(`tags: ${tags.join(', ')}`)
  if (descriptionSupport.length) parts.push(`description supports: ${descriptionSupport.join(', ')}`)
  if (description) parts.push(`description: ${description}`)
  return parts.join('; ') || 'No details provided.'
}

/** One decision call classifies each uncast group and ranks the available voice descriptions. */
export function buildUncastVoiceDecision(groups: UncastVoiceGroup[], voices: FavoriteVoice[], message: string, ghosts: GhostVoice[] = [], previousMessages: RelationshipReviewContext['previousMessages'] = []) {
  const labels = uncastIdentityLabels(message, ghosts)
  const narrativeNames = uncastNarrativeNameCandidates(message)
  const state = {
    message,
    previousMessages,
    narrativeNames,
    characters: groups.map(group => ({ id: group.id, identity: group.speakerId, speeches: group.speeches, context: group.context })),
    ghosts: ghosts.map((ghost, index) => ({ option: `ghost_${index}`, identity: ghost.speakerId, label: ghost.label || null, aliases: ghostCastAliases(ghost), priorMessageIds: ghostPriorMessageIds(ghost, previousMessages), context: ghost.context, conversationHistory: ghost.conversationHistory ?? [] })),
    voices: voices.map((voice, index) => ({ option: `voice_${index}`, name: voice.name })),
  }
  // Deterministic gender hints prefer what the narration says about the
  // speaker; the pool is score-ordered, so the earliest compatible voices
  // are the strongest candidates. The shortlist keeps each ranking
  // question small enough for the decision gateway while preserving the
  // original voice indexes for probability lookup.
  const voiceOptionsFor = (group: UncastVoiceGroup): Array<{ index: number; voice: FavoriteVoice }> => {
    const hint = group.pronounGender && (group.pronounGender === 'male' || group.pronounGender === 'female') ? group.pronounGender : 'unknown'
    return voices
      .map((voice, index) => ({ index, voice }))
      .filter(({ voice }) => hint === 'unknown' || voiceGenderCompatible(voice, hint))
      .slice(0, 32)
  }
  const questions: Record<string, { type: 'choice'; instructions: string; criteria: Record<string, string> }> = {}
  for (const group of groups) {
    questions[`gender_${group.id}`] = {
      type: 'choice', instructions: `Identify the gender of character ${group.id} from the scene. Choose unknown when not established.`,
      criteria: { male: 'The character is male.', female: 'The character is female.', unknown: 'Gender is not established or is not male or female.' },
    }
    if (labels.length) questions[`label_${group.id}`] = {
      type: 'choice',
      instructions: `Choose the descriptive label for the person who actually speaks the quoted dialogue in ${group.id}. A person mentioned in narration, observing, or addressed by the speaker is not necessarily speaking. Choose none unless the label identifies the speaker of these quotations.`,
      criteria: { none: 'No reliable descriptive identity.', ...Object.fromEntries(groupLabelOptions(group, labels).map((label, index) => [`label_${index}`, label])) },
    }
    if (group.speakerId === UNCAST_SPEAKER_ID && narrativeNames.length) questions[`narrative_name_${group.id}`] = {
      type: 'choice',
      instructions: `Does a person explicitly named in CURRENT narration actually speak the quotations in ${group.id}? Trace nearby pronouns, actions, dialogue and previousMessages. Names of addressees, bystanders, narrators, and people merely discussed are not speaker identities. Choose none unless the evidence clearly identifies the speaker.`,
      criteria: { none: 'No named person is clearly identified as this speaker.', ...Object.fromEntries(narrativeNames.map((name, index) => [`name_${index}`, name])) },
    }
    const earlier = groups.slice(0, groups.indexOf(group))
    if (ghosts.length || earlier.length) questions[`identity_${group.id}`] = {
      type: 'choice', instructions: `Does character ${group.id} clearly represent the same individual as one prior character? Compare the current exchange with previousMessages and the prior character's own conversation history. Trace distinctive objects or workstations, physical location, actions, conversation topic, who addresses whom, and continuing relationships, including across user messages. Several agreeing details can identify someone when their name is revealed later. A shared object, setting, gender, occupation, or voice alone is insufficient; check for multiple people, scene changes, interruptions, and names that identify an addressee or bystander rather than the speaker. Do not confuse the speaker with the person they address. Select new_or_unclear unless identity is clear.`,
      criteria: { new_or_unclear: 'A new character, or identity cannot be reliably established.',
        ...Object.fromEntries(ghosts.map((ghost, index) => [`ghost_${index}`, `Previously seen character ${ghostCastAliases(ghost).join(" / ") || ghost.speakerId}; context: ${ghost.context}`])),
        ...Object.fromEntries(earlier.map(previous => [`group_${previous.id}`, `Earlier character ${previous.id}; context: ${previous.context.join(' ').slice(0, 2_000)}`])) },
    }
    for (const previous of earlier.slice(-8)) {
      questions[`same_${group.id}_${previous.id}`] = {
        type: 'choice',
        instructions: `Compare ${group.id} and ${previous.id} across the entire scene. Are these speeches clearly from the same individual? Treat references to the same role as evidence, and distinguish different people with the same role.`,
        criteria: { same: 'The two groups clearly belong to the same individual.', different_or_unclear: 'They are different people, or the evidence is insufficient.' },
      }
    }
    if (!voices.length) continue
    const options = voiceOptionsFor(group)
    questions[`voice_${group.id}`] = {
      type: 'choice', instructions: `Rank the available voices for the person who actually speaks the quoted dialogue in ${group.id}. Narration-only bystanders and people merely addressed are not speakers. Use the full scene as context, including other character groups only when clearly the same speaker. Score voices by metadata cues, not prose length: name is weak context, category and languages contribute one compatibility cue in aggregate, each explicit tag is one cue, and each tag listed in "description supports" is one cue. The description is evidence for those tags, not an extra vote, and support for an explicit tag counts once rather than twice. Balance tags against that description evidence instead of letting a long description outweigh otherwise better matches. Missing fields are not a reason to rank a voice lower. Select the best available voice.`,
      criteria: { ...Object.fromEntries(options.map(({ index, voice }) => [`voice_${index}`, voiceDecisionSummary(voice)])), ...(options.length === 1 ? { no_match: 'No suitable voice is available.' } : {}) },
    }
  }
  return { state, questions }
}

function revealedUncastName(group: UncastVoiceGroup, answers: Record<string, SpeakerDecisionChoice> = {}, message = ''): string {
  if (group.speakerId.startsWith('unconfigured:')) return group.speakerId.slice('unconfigured:'.length)
  const names = new Set(group.speeches.flatMap(speech => [...speech.matchAll(/\b(?:[Mm]y name is|[Ii] am|[Ii]'m)\s+([A-Z][a-z]+(?:[-'][A-Z]?[a-z]+)?)(?=[,.!?;:]|\s+(?:and|from|but|here)\b)/gu)].map(match => match[1].toLowerCase())))
  if (names.size === 1) return [...names][0]
  const answer = answers[`narrative_name_${group.id}`]
  const match = answer?.choice.match(/^name_(\d+)$/u)
  const probability = answer?.probabilities[answer.choice] ?? 0
  const runnerUp = answer ? Math.max(0, ...Object.entries(answer.probabilities).filter(([key]) => key !== answer.choice).map(([, value]) => value)) : 0
  const jev = match && answer && answer.confidence >= 0.8 && probability >= 0.8 && probability - runnerUp >= 0.25 ? (uncastNarrativeNameCandidates(message)[Number(match[1])] ?? '').toLowerCase() : ''
  if (jev) return jev
  return group.inferredName && !isBroadPersonLabel(group.inferredName) ? group.inferredName.toLowerCase() : ''
}

/** Prefer the most recently recorded claim if a rejected old occurrence was superseded. */
function latestGhostOccurrenceIndex(ghosts: GhostVoice[], key: string): number {
  let found = -1
  if (key) for (let index = 0; index < ghosts.length; index++) if (ghosts[index].occurrenceKeys.includes(key)) found = index
  return found
}

/** A ghost with no saved narrative evidence for a reviewer to compare against. */
function ghostLacksSavedEvidence(ghost: GhostVoice): boolean {
  return !(ghost.context ?? '').trim() && !(ghost.conversationHistory ?? []).length
}

/** Review borderline same-speaker links when a later turn has a clear label. */
export function buildUncastIdentityReview(groups: UncastVoiceGroup[], answers: Record<string, SpeakerDecisionChoice>, message: string, ghosts: GhostVoice[] = [], messageId = '', previousMessages: RelationshipReviewContext['previousMessages'] = []) {
  const labels = uncastIdentityLabels(message, ghosts)
  const questions: Record<string, { type: 'choice'; instructions: string; criteria: Record<string, string> }> = {}
  for (const [index, group] of groups.entries()) {
    if (Object.keys(questions).length >= 16) break
    const occurrenceKey = messageId ? `${messageId}:${hashMessageContent(group.speeches.join('\n'))}` : ''
    const occurrenceIndex = latestGhostOccurrenceIndex(ghosts, occurrenceKey)
    const initialIdentity = answers[`identity_${group.id}`]
    const confirmedOccurrence = occurrenceIndex >= 0 && initialIdentity?.choice === `ghost_${occurrenceIndex}`
      && initialIdentity.confidence >= 0.8 && (initialIdentity.probabilities[initialIdentity.choice] ?? 0) >= 0.8
      && (initialIdentity.probabilities[initialIdentity.choice] ?? 0) - Math.max(0, ...Object.entries(initialIdentity.probabilities).filter(([key]) => key !== initialIdentity.choice).map(([, value]) => value)) >= 0.25
    if (occurrenceIndex >= 0 && !confirmedOccurrence) {
      questions[`review_occurrence_${group.id}_${occurrenceIndex}`] = {
        type: 'choice',
        instructions: `A previous generation assigned current group ${group.id} to ghost_${occurrenceIndex}. The saved occurrence may be wrong. Compare the current speaker, narrative actions and prior character context. Is this clearly the same individual? Do not infer identity from the name, gender, or the saved occurrence alone.`,
        criteria: { same: 'The current speaker and saved character are clearly the same person.', different_or_unclear: 'They differ, or there is insufficient evidence to confirm identity.' },
      }
      if (Object.keys(questions).length >= 16) break
      questions[`review_occurrence_disposition_${group.id}_${occurrenceIndex}`] = {
        type: 'choice',
        instructions: `Compare the actual speaker of ${group.id} with ghost_${occurrenceIndex}, which a prior generation linked to this exact occurrence. Decide whether they are clearly the same person, clearly different people, or unclear. Read their saved histories, other participants, actions, dialogue and scene context. Do not treat an uncertain mismatch as proof of a different person.`,
        criteria: { same: 'The speaker and the saved character are clearly the same person.', different: 'They are clearly different people.', unclear: 'The evidence does not establish whether they are the same or different.' },
      }
      if (Object.keys(questions).length >= 16) break
    }
    const identity = answers[`identity_${group.id}`]
    const ghostChoice = identity?.choice.match(/^ghost_(\d+)$/u)
    const candidate = ghostChoice ? ghosts[Number(ghostChoice[1])] : undefined
    const probability = identity ? identity.probabilities[identity.choice] ?? 0 : 0
    const runnerUp = identity ? Math.max(0, ...Object.entries(identity.probabilities).filter(([key]) => key !== identity.choice).map(([, value]) => value)) : 0
    if (candidate && identity && probability >= 0.6 && identity.confidence >= 0.5 && probability - runnerUp >= 0.2
      && (probability < 0.8 || identity.confidence < 0.8 || probability - runnerUp < 0.25)) {
      questions[`review_ghost_${group.id}_${ghostChoice![1]}`] = {
        type: 'choice',
        instructions: `Compare the speaker in current group ${group.id} with the previously seen character ${candidate.label || candidate.speakerId}. Read the prior character's conversation history and the full current scene, including other participants? dialogue, relationship clues, and continuity from phone to in-person. Confirm only if they are the same person; distinguish callers, people addressed, and people merely mentioned.`,
        criteria: { same: 'The prior character and current speaker are clearly the same person.', different_or_unclear: 'They differ or the evidence is insufficient.' },
      }
    }
    // A newly revealed name may not yet appear in an anonymous ghost's aliases.
    // Ask about unnamed candidates even when the first pass chose new/unclear.
    const revealedName = revealedUncastName(group, answers, message)
    const alreadyNamed = ghosts.some(ghost => ghostCastAliases(ghost).some(alias => alias.toLowerCase() === revealedName.toLowerCase()))
    if (revealedName && !isBroadPersonLabel(revealedName) && !alreadyNamed) {
      const priorIds = previousMessages.map(item => item.id)
      const candidates = ghosts.map((ghost, ghostIndex) => ({ ghost, ghostIndex, recent: Math.max(priorIds.indexOf(ghost.lastSeenMessageId), ...(ghost.conversationHistory ?? []).map(item => priorIds.indexOf(item.messageId))) }))
        .sort((a, b) => b.recent - a.recent || a.ghostIndex - b.ghostIndex)
      for (const { ghostIndex, ghost } of candidates) {
        if (Object.keys(questions).length >= 16) break
        const aliases = ghostCastAliases(ghost)
        if (aliases.some(alias => !isDescriptiveGhostLabel(alias))) continue
        const priorAssistant = [...previousMessages].reverse().find(item => item.role === 'assistant')
        const priorAssistantIndex = priorAssistant ? previousMessages.indexOf(priorAssistant) : -1
        const interveningUser = priorAssistantIndex >= 0 && previousMessages.slice(priorAssistantIndex + 1).some(item => item.role === 'user')
        const linkedToPrior = !!priorAssistant && (ghost.lastSeenMessageId === priorAssistant.id || (ghost.conversationHistory ?? []).some(item => item.messageId === priorAssistant.id))
        if (interveningUser && linkedToPrior) {
          questions[`review_continuity_${group.id}_${ghostIndex}`] = {
            type: 'choice',
            instructions: `Compare ghost_${ghostIndex}'s actual speech in the immediately preceding assistant message with the intervening user message and current group ${group.id}, now identified as ${revealedName}. The user may address the earlier speaker and the current dialogue may directly answer that user's question: follow the conversation and narrative actions across all three messages. Do not assume every speaker in the earlier message is this ghost, or that the same setting alone proves identity. Is this clearly the same person, clearly a different person, or genuinely uncertain?`,
            criteria: { same: 'The conversation and scene clearly identify the same person.', different: 'The evidence clearly establishes different people.', unclear: 'There is not enough evidence to decide.' },
          }
          if (Object.keys(questions).length >= 16) break
        }
        const key = `review_reveal_${group.id}_${ghostIndex}`
        questions[key] = {
          type: 'choice',
          instructions: `Has previously seen character ghost_${ghostIndex} now been identified as ${revealedName}, the actual speaker of ${group.id}? Compare that character's saved conversation history and the full scene, including relationships, locations, actions, and who addresses whom. Do not equate people based only on gender, occupation, or a shared setting. Confirm only when the evidence clearly identifies the same individual.`,
          criteria: { same: 'The newly named speaker and the earlier character are clearly the same person.', different_or_unclear: 'They are different, or the available evidence is insufficient.' },
        }
        if (previousMessages.length && ghost.conversationHistory?.length && Object.keys(questions).length < 16) {
          questions[`review_scene_${group.id}_${ghostIndex}`] = {
            type: 'choice',
            instructions: `Re-read previousMessages, ghost_${ghostIndex}'s own saved conversation history, and the CURRENT exchange. Has the previously unnamed person who spoke in that history now been identified as ${revealedName}, the actual speaker of ${group.id}? Trace who speaks to whom, a continuing conversation, distinctive objects or workstations and their location, associated actions and later naming. Use several agreeing clues together, including intervening user messages. A shared setting, object, profession, or gender alone does not prove identity. Consider multiple people, a new arrival or scene change, and whether the name belongs to an addressee or bystander. Select different_or_unclear when these details do not clearly establish the same individual.`,
            criteria: { same: 'The earlier unnamed character and the newly named speaker are clearly the same individual.', different_or_unclear: 'Different individuals, or continuity is not clearly established.' },
          }
        }
      }
    }
    const label = answers[`label_${group.id}`]
    const labelIndex = label?.choice.match(/^label_(\d+)$/u)
    const labelProbability = label ? label.probabilities[label.choice] ?? 0 : 0
    const labelRunnerUp = label ? Math.max(0, ...Object.entries(label.probabilities).filter(([key]) => key !== label.choice).map(([, probability]) => probability)) : 0
    const named = labelIndex && groupLabelOptions(group, labels)[Number(labelIndex[1])] && label && label.confidence >= 0.7 && labelProbability >= 0.7 && labelProbability - labelRunnerUp >= 0.25
    if (!named) continue
    for (const previous of groups.slice(0, index).slice(-8)) {
      const pair = answers[`same_${group.id}_${previous.id}`]
      const priorLabel = answers[`label_${previous.id}`]
      const priorNamed = priorLabel?.choice.startsWith('label_') && priorLabel.confidence >= 0.7 && (priorLabel.probabilities[priorLabel.choice] ?? 0) >= 0.7
      const probability = pair?.probabilities.same ?? 0
      if (priorNamed || pair?.choice !== 'same' || probability < 0.8 || pair.confidence < 0.6 || pair.confidence >= 0.8) continue
      questions[`review_same_${group.id}_${previous.id}`] = {
        type: 'choice',
        instructions: `Review whether the speaker of the earlier group ${previous.id} is the same individual as ${group.id}, identified as ${groupLabelOptions(group, labels)[Number(labelIndex![1])]}. Read the entire scene, including intervening turns and narration. Shared occupation, gender, or similar voice alone is not enough.`,
        criteria: { same: 'The scene clearly establishes that both groups have the same speaker.', different_or_unclear: 'The speakers differ or the evidence is insufficient.' },
      }
      if (Object.keys(questions).length >= 16) break
    }
    if (Object.keys(questions).length >= 16) break
  }
  return { state: { message, previousMessages, characters: groups.map(group => ({ id: group.id, identity: group.speakerId, speeches: group.speeches, context: group.context })), ghosts: ghosts.map((ghost, index) => ({ option: `ghost_${index}`, identity: ghost.speakerId, aliases: ghostCastAliases(ghost), priorMessageIds: ghostPriorMessageIds(ghost, previousMessages), context: ghost.context, conversationHistory: ghost.conversationHistory ?? [] })) }, questions }
}

export interface UncastVoiceAssignment { groupId: string; voiceId: string; gender: string; ghostId?: string; label?: string; aliases?: string[]; matchReason?: string }

/** Broad descriptions are useful context, but do not uniquely identify a person. */
export function isBroadPersonLabel(label: string): boolean {
  return /^(?:(?:the|a|an)\s+)?(?:(?:young|younger|old|older|elderly|middle-aged|tall|short)\s+)*(?:woman|man|person|girl|boy|guy|lady|stranger|someone|somebody)$/iu.test(label.trim())
}

/** Adult person words name no particular individual, unlike a repeated "the girl" label. */
function isGenericAdultLabel(label: string): boolean {
  return /^(?:(?:the|a|an)\s+)?(?:(?:young|younger|old|older|elderly|middle-aged|tall|short)\s+)*(?:woman|man|person|lady|guy|stranger|someone|somebody)$/iu.test(label.trim())
}

export function isDescriptiveGhostLabel(label: string): boolean {
  return isBroadPersonLabel(label) || /^(?:the|a|an)\s/iu.test(label.trim()) || /['’]s\s/iu.test(label.trim())
}

const LABEL_GENDER_TOKENS: ReadonlyMap<string, 'male' | 'female'> = new Map(
  [
    ...['girl', 'girls', 'woman', 'women', 'lady', 'ladies', 'female', 'females', 'mother', 'mothers', 'mum', 'mums', 'mom', 'moms', 'sister', 'sisters', 'wife', 'wives', 'daughter', 'daughters', 'aunt', 'aunts', 'niece', 'nieces', 'grandmother', 'grandmothers', 'grandma', 'grandmas', 'granny', 'grannies', 'nanny', 'nannies', 'maid', 'maids', 'bride', 'brides', 'princess', 'princesses', 'madam', 'mrs', 'miss', 'she', 'her', 'hers', 'herself'].map(token => [token, 'female'] as const),
    ...['boy', 'boys', 'man', 'men', 'gentleman', 'gentlemen', 'male', 'males', 'father', 'fathers', 'dad', 'dads', 'brother', 'brothers', 'husband', 'husbands', 'son', 'sons', 'uncle', 'uncles', 'nephew', 'nephews', 'grandfather', 'grandfathers', 'grandpa', 'grandpas', 'groom', 'grooms', 'prince', 'princes', 'monk', 'monks', 'guy', 'guys', 'mr', 'sir', 'he', 'him', 'his', 'himself'].map(token => [token, 'male'] as const),
  ],
)

/**
 * Deterministic gender hint from a descriptive label ("the girl", "the
 * taller man"). A label can be too broad to identify an individual yet still
 * state their gender. Returns null when no gendered token appears, or when
 * both genders appear (e.g. "the man and the girl").
 */
export function labelGenderHint(label: string): 'male' | 'female' | null {
  const genders = new Set<'male' | 'female'>()
  for (const token of label.toLowerCase().replace(/[^a-z]+/gu, ' ').split(/\s+/u)) {
    if (!token) continue
    const gender = LABEL_GENDER_TOKENS.get(token)
    if (gender) {
      genders.add(gender)
      if (genders.size > 1) return null
    }
  }
  return genders.size === 1 ? [...genders][0] : null
}

/** Two unnamed groups that each invoke the other's name are the same pair of speakers. */
export function mutuallyInvoked(a: UncastVoiceGroup, b: UncastVoiceGroup, answers: Record<string, SpeakerDecisionChoice> = {}, message = ''): boolean {
  const nameA = revealedUncastName(a, answers, message).toLowerCase()
  const nameB = revealedUncastName(b, answers, message).toLowerCase()
  return !!nameA && !!nameB && a.addressee === nameB && b.addressee === nameA
}

/** A narration name boosts a group only when it confirms a flank pair: the narrated speaker is the partner's addressee. */
export function narrationBoostsPair(group: UncastVoiceGroup, partner: UncastVoiceGroup): boolean {
  return !!group.narratedName && group.flankPartners?.includes(partner.id) === true && partner.addressee === group.narratedName
}

export function resolveUncastVoiceDecisions(
  groups: UncastVoiceGroup[], voices: FavoriteVoice[], answers: Record<string, SpeakerDecisionChoice>,
  ghosts: GhostVoice[] = [], reserved: readonly string[] = [], messageId = '', message = '', previousMessageIds: readonly string[] = [],
  random: () => number = Math.random,
): UncastVoiceAssignment[] {
  const used = new Set<string>(reserved.filter(Boolean))
  const assignments: UncastVoiceAssignment[] = []
  const roots = new Map<string, string>()
  const linkedGhosts = new Map<string, GhostVoice>()
  const conflictedRoots = new Set<string>()
  const confirmedNewRoots = new Set<string>()
  const contradictedRoots = new Set<string>()
  const linkReasons = new Map<string, string>()
  const labels = uncastIdentityLabels(message, ghosts)
  const groupLabels = new Map<string, string>()
  const rootByLabel = new Map<string, string>()
  const rootByRevealedName = new Map<string, string>()
  const strongChoice = (answer: SpeakerDecisionChoice | undefined): boolean => {
    if (!answer || answer.choice === 'new_or_unclear') return false
    if (!Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1 || !answer.probabilities || Object.values(answer.probabilities).some(value => !Number.isFinite(value) || value < 0 || value > 1)) return false
    const probability = answer.probabilities[answer.choice] ?? 0
    const runnerUp = Math.max(0, ...Object.entries(answer.probabilities).filter(([key]) => key !== answer.choice).map(([, p]) => p))
    return answer.confidence >= 0.8 && probability >= 0.8 && probability - runnerUp >= 0.25
  }
  // Resolve identity links before choosing voices, so later evidence can help
  // the whole character even when the first group has no suitable match.
  for (const group of groups) {
    let root = group.id
    const occurrenceKey = messageId ? `${messageId}:${hashMessageContent(group.speeches.join('\n'))}` : ''
    const name = revealedUncastName(group, answers, message).toLowerCase()
    // Narration that explicitly names the speaker ("Voss says…") is
    // deterministic evidence even when the parser left the quote anonymous
    // and Jev did not independently resolve the name. Use it only to find an
    // existing ghost with that exact alias, never to invent a new identity.
    const narratedName = normalizeSpeakerName(group.narratedName ?? '').toLowerCase()
    const matchNames = [...new Set([name, narratedName].filter(value => value && !isBroadPersonLabel(value)))]
    const occurrenceIndex = latestGhostOccurrenceIndex(ghosts, occurrenceKey)
    const occurrence = occurrenceIndex >= 0 ? ghosts[occurrenceIndex] : undefined
    const occurrenceReview = occurrenceIndex >= 0 ? answers[`review_occurrence_${group.id}_${occurrenceIndex}`] : undefined
    const identityAnswer = answers[`identity_${group.id}`]
    const disposition = occurrenceIndex >= 0 ? answers[`review_occurrence_disposition_${group.id}_${occurrenceIndex}`] : undefined
    // A 'different' disposition only escapes a hollow/self-referential
    // confirmation when it is a genuinely strong verdict: a weak flip
    // (e.g. 0.43 probability at 0.14 confidence) is noise on a circular
    // review, not an explicit "different person" signal.
    const dispositionDifferent = disposition?.choice === 'different' && strongChoice(disposition)
    const reviewedAsGhost = occurrence && group.speakerId === `ghost:${occurrence.id}`
    // A ghost with no saved evidence (no context, no conversation history)
    // cannot be meaningfully contested: the occurrence review only restates
    // that the evidence is insufficient. The identical occurrence (same
    // message, same speeches) then confirms the ghost by itself, unless
    // Jev's disposition verdict explicitly says a different person.
    const hollowOccurrence = !!occurrence && ghostLacksSavedEvidence(occurrence) && !dispositionDifferent
    // A ghost created during this very message's playback has only
    // self-referential evidence: its saved context is a snippet of this
    // same passage, so the occurrence comparison against it is circular
    // and flips between runs. The identical occurrence confirms it unless
    // the disposition decisively says a different person.
    const selfReferentialOccurrence = !!occurrence && !!messageId
      && occurrence.createdAtMessageId === messageId && occurrence.lastSeenMessageId === messageId
      && !dispositionDifferent
    // When both occurrence questions lean 'same' without reaching
    // strong-choice levels, their agreement on the identical occurrence
    // still confirms it; strength is unnecessary when neither question
    // found a contradiction.
    const occurrenceReviewSame = occurrenceReview?.choice === 'same' && (occurrenceReview.probabilities?.same ?? 0) >= 0.6
    const dispositionSame = disposition?.choice === 'same' && (disposition.probabilities?.same ?? 0) >= 0.6
    const occurrenceConfirmed = !!occurrence && (reviewedAsGhost
      || (identityAnswer?.choice === `ghost_${occurrenceIndex}` && strongChoice(identityAnswer))
      || (occurrenceReview?.choice === 'same' && strongChoice(occurrenceReview))
      || hollowOccurrence
      || selfReferentialOccurrence
      || (occurrenceReviewSame && dispositionSame))
    const identityProbability = identityAnswer?.probabilities.new_or_unclear ?? 0
    const identityRunnerUp = identityAnswer ? Math.max(0, ...Object.entries(identityAnswer.probabilities).filter(([key]) => key !== 'new_or_unclear').map(([, value]) => value)) : 0
    const confirmedNew = !!occurrence && disposition?.choice === 'different' && strongChoice(disposition)
      && identityAnswer?.choice === 'new_or_unclear' && identityAnswer.confidence >= 0.8 && identityProbability >= 0.8 && identityProbability - identityRunnerUp >= 0.25
    const occurrenceConflict = !!occurrence && !occurrenceConfirmed && !confirmedNew
    const aliasMatches = matchNames.length ? ghosts.filter(item => (!confirmedNew || item.id !== occurrence?.id) && ghostCastAliases(item).some(alias => matchNames.includes(alias.toLowerCase()))) : []
    const exact = (occurrenceConfirmed ? occurrence : undefined)
      ?? (group.speakerId !== UNCAST_SPEAKER_ID && !isBroadPersonLabel(name) ? ghosts.find(item => item.speakerId === group.speakerId && (!confirmedNew || item.id !== occurrence?.id)) : undefined)
      ?? (aliasMatches.length === 1 ? aliasMatches[0] : undefined)
      ?? (!confirmedNew ? occurrence : undefined)
    const identity = answers[`identity_${group.id}`]
    const labelAnswer = answers[`label_${group.id}`]
    const labelIndex = labelAnswer?.choice.match(/^label_(\d+)$/u)
    const labelProbability = labelAnswer ? labelAnswer.probabilities[labelAnswer.choice] ?? 0 : 0
    const labelRunnerUp = labelAnswer ? Math.max(0, ...Object.entries(labelAnswer.probabilities).filter(([key]) => key !== labelAnswer.choice).map(([, probability]) => probability)) : 0
    const label = labelIndex && labelAnswer && labelAnswer.confidence >= 0.7 && labelProbability >= 0.7 && labelProbability - labelRunnerUp >= 0.25 ? groupLabelOptions(group, labels)[Number(labelIndex[1])] : undefined
    if (label) groupLabels.set(group.id, label)
    const previousGroups = groups.slice(0, groups.indexOf(group)).slice(-8)
    const same = previousGroups.flatMap(previous => {
      const previousName = revealedUncastName(previous, answers, message).toLowerCase()
      if (name && previousName && name !== previousName) return []
      const review = answers[`review_same_${group.id}_${previous.id}`]
      const answer = review && strongChoice(review) ? review : answers[`same_${group.id}_${previous.id}`]
      const boosted = answer?.choice === 'same' && answer.confidence >= 0.6 && (answer.probabilities.same ?? 0) >= 0.8 && !!group.flankPartners?.includes(previous.id)
      // A pronoun-continuity chain ("…then he walked…", "…then she stood…")
      // is a deterministic fact like a flank pair, so a lean of at least
      // 0.6 same lets the pair share a voice even below Jev's thresholds.
      const pronounLinked = answer?.choice === 'same' && answer.confidence >= 0.3 && (answer.probabilities.same ?? 0) >= 0.6 && !!group.pronounPartners?.includes(previous.id)
      return (answer?.choice === 'same' && strongChoice(answer)) || boosted || pronounLinked ? [{ previous, probability: answer?.probabilities.same ?? 0 }] : []
    }).sort((a, b) => b.probability - a.probability)
    const narratedPartner = previousGroups.find(previous => narrationBoostsPair(group, previous))
    if (same[0]) root = roots.get(same[0].previous.id) ?? root
    else if (narratedPartner) root = roots.get(narratedPartner.id) ?? root
    else if (label && !isBroadPersonLabel(label) && rootByLabel.has(label)) root = rootByLabel.get(label)!
    else if (strongChoice(identity) && identity?.choice.startsWith('group_')) root = roots.get(identity.choice.slice(6)) ?? root
    else if (name && rootByRevealedName.has(name)) {
      const namedRoot = rootByRevealedName.get(name)!
      const contradicts = previousGroups.some(previous => roots.get(previous.id) === namedRoot && answers[`same_${group.id}_${previous.id}`]?.choice === 'different_or_unclear' && strongChoice(answers[`same_${group.id}_${previous.id}`]))
      if (!contradicts) root = namedRoot
    }
    if (name && previousGroups.some(previous => roots.get(previous.id) === root && revealedUncastName(previous, answers, message) && revealedUncastName(previous, answers, message).toLowerCase() !== name)) root = group.id
    const namedGhosts = label && !isBroadPersonLabel(label) ? ghosts.filter(item => (!confirmedNew || item.id !== occurrence?.id) && ghostCastAliases(item).some(alias => alias.toLowerCase() === label)) : []
    const rankedGhosts = namedGhosts.map(item => ({ item, recent: Math.max(
      previousMessageIds.indexOf(item.lastSeenMessageId),
      ...item.occurrenceKeys.map(key => previousMessageIds.indexOf(key.split(':', 1)[0])),
    ) })).sort((a, b) => b.recent - a.recent)
    const priorGhost = rankedGhosts[0]?.recent >= 0 && (rankedGhosts.length === 1 || rankedGhosts[0].recent > rankedGhosts[1].recent) ? rankedGhosts[0].item : undefined
    const reviewedGhost = group.speakerId.startsWith('ghost:') ? ghosts.find(item => item.id === group.speakerId.slice('ghost:'.length) && (!confirmedNew || item.id !== occurrence?.id)) : undefined
    let ghost = reviewedGhost ?? (namedGhosts.length === 1 ? namedGhosts[0] : priorGhost ?? exact)
    const narratedMatch = !!ghost && ghost === exact && !!narratedName && !name
    let reason = reviewedGhost ? 'speaker relationship review' : ghost === occurrence && ghost ? 'exact message occurrence' : narratedMatch ? 'narrated name match' : ghost && namedGhosts.includes(ghost) ? 'label or alias match' : ghost ? 'speaker name or alias match' : ''
    if (occurrenceConflict && ghost?.id === occurrence?.id) {
      const alternatives = ghosts.flatMap((candidate, index) => {
        if (candidate.id === occurrence.id) return []
        const reveal = answers[`review_reveal_${group.id}_${index}`]
        const scene = answers[`review_scene_${group.id}_${index}`]
        const continuity = answers[`review_continuity_${group.id}_${index}`]
        const continuitySame = continuity?.choice === 'same' && strongChoice(continuity)
        const rejected = continuity?.choice === 'different' && strongChoice(continuity) || (!continuitySame && [reveal, scene].some(review => review?.choice === 'different_or_unclear' && strongChoice(review)))
        const confirmed = continuitySame || [reveal, scene].some(review => review?.choice === 'same' && strongChoice(review))
          || (identityAnswer?.choice === `ghost_${index}` && strongChoice(identityAnswer))
        return !rejected && confirmed ? [candidate] : []
      })
      if (alternatives.length === 1) { ghost = alternatives[0]; reason = 'Jev alternative identity review (contested occurrence)' }
    }
    if (!ghost && strongChoice(identity) && identity?.choice.startsWith('ghost_')) { ghost = ghosts[Number(identity.choice.slice(6))]; if (ghost) reason = 'Jev identity match' }
    if (!ghost && identity?.choice.startsWith('ghost_')) {
      const ghostIndex = identity.choice.slice(6)
      const review = answers[`review_ghost_${group.id}_${ghostIndex}`]
      if (review?.choice === 'same' && strongChoice(review)) { ghost = ghosts[Number(ghostIndex)]; if (ghost) reason = 'Jev identity follow-up review' }
    }
    // A weak identity answer is still a pointer to a specific ghost. When the
    // follow-up review confirms that same ghost, reuse it so one unnamed
    // character does not split into a new voice across messages.
    if (!ghost && identity?.choice.startsWith('ghost_')) {
      const ghostIndex = Number(identity.choice.slice(6))
      const review = answers[`review_ghost_${group.id}_${ghostIndex}`]
      const candidate = ghosts[ghostIndex]
      if (candidate && review?.choice === 'same' && (review.probabilities.same ?? 0) >= 0.8 && review.confidence >= 0.75) {
        ghost = candidate
        reason = 'Jev identity follow-up review (weak identity)'
      }
    }
    if (!ghost) {
      const confirmed = ghosts.flatMap((candidate, index) => {
        if (confirmedNew && candidate.id === occurrence?.id) return []
        const reveal = answers[`review_reveal_${group.id}_${index}`]
        const scene = answers[`review_scene_${group.id}_${index}`]
        const continuity = answers[`review_continuity_${group.id}_${index}`]
        const continuitySame = continuity?.choice === 'same' && strongChoice(continuity)
        const rejected = continuity?.choice === 'different' && strongChoice(continuity) || (!continuitySame && [reveal, scene].some(review => review?.choice === 'different_or_unclear' && strongChoice(review)))
        return !rejected && (continuitySame || [reveal, scene].some(review => review?.choice === 'same' && strongChoice(review))) ? [candidate] : []
      })
      if (confirmed.length === 1) { ghost = confirmed[0]; reason = 'Jev name-reveal review' }
    }
    // The same literal unnamed label across messages ("the girl") is evidence
    // in its own right, but only when exactly one stored character carries it
    // and the label is specific enough not to name a broad person type.
    if (!ghost && group.speakerId === UNCAST_SPEAKER_ID && groupLabels.has(group.id)) {
      const literal = normalizeSpeakerName(groupLabels.get(group.id)!).toLowerCase()
      const sameLabel = literal && !isGenericAdultLabel(literal) ? ghosts.filter(item => (!confirmedNew || item.id !== occurrence?.id) && ghostCastAliases(item).some(alias => alias.toLowerCase() === literal)) : []
      if (sameLabel.length === 1) { ghost = sameLabel[0]; reason = 'repeated unnamed label' }
    }
    roots.set(group.id, root)
    if (name && !rootByRevealedName.has(name)) rootByRevealedName.set(name, root)
    if (contradictedRoots.has(root)) continue
    if (confirmedNew && linkedGhosts.get(root)?.id === occurrence?.id) {
      confirmedNewRoots.delete(root)
      conflictedRoots.add(root)
      contradictedRoots.add(root)
      continue
    }
    if (confirmedNew) { confirmedNewRoots.add(root); conflictedRoots.delete(root) }
    if (occurrenceConflict && ghost?.id === occurrence?.id && !linkedGhosts.has(root)) {
      if (!confirmedNewRoots.has(root)) conflictedRoots.add(root)
      continue
    }
    if (label && !rootByLabel.has(label)) rootByLabel.set(label, root)
    // A matching earlier group owns the voice, even if a previous replay
    // cached a different voice for this individual turn.
    if (ghost && !reserved.includes(ghost.voiceId) && !linkedGhosts.has(root)) { linkedGhosts.set(root, ghost); linkReasons.set(root, `${reason}: ${ghost.id} (${ghost.label || ghost.speakerId})`) }
  }
  for (const root of new Set(roots.values())) {
    if (conflictedRoots.has(root)) continue
    const members = groups.filter(group => roots.get(group.id) === root)
    const genderVotes = members.map(group => answers[`gender_${group.id}`]).filter(answer => answer && (answer.choice === 'male' || answer.choice === 'female') && answer.confidence >= 0.6 && (answer.probabilities[answer.choice] ?? 0) >= 0.6)
    const genders = new Set(genderVotes.map(answer => answer.choice))
    const jevGender = genders.size === 1 ? genderVotes[0].choice as 'male' | 'female' : 'unknown'
    let ghost = linkedGhosts.get(root)
    // A gendered descriptive label ("the girl", "the lady", "the man") is
    // deterministic evidence Jev may have missed; it only fills in an
    // unknown gender, never overrules an established one. A pronoun chain
    // ("he", "she") left by the narration behind the fragments fills in next.
    const labelHint = labelGenderHint(ghost?.label || members.map(group => groupLabels.get(group.id)).find(Boolean) || '')
    const pronounHint = members.find(member => member.pronounGender && member.pronounPartners?.length)?.pronounGender
    let gender: 'male' | 'female' | 'unknown' = jevGender !== 'unknown' ? jevGender : labelHint || pronounHint || 'unknown'
    // The narration's own pronoun class shaped the voice shortlist, so it
    // defines the compatible pool even when Jev's gender answer disagrees.
    // A Jev gender only decides the pool when narration left none.
    const rankingHint = members.find(member => member.pronounGender === 'male' || member.pronounGender === 'female')?.pronounGender
    if (!ghost) {
      const matches = members.map(group => answers[`voice_${group.id}`]).filter((answer): answer is SpeakerDecisionChoice => !!answer)
      const poolGender: 'male' | 'female' | 'unknown' = rankingHint ?? gender
      const candidates = voices.flatMap((voice, index) => {
        if (used.has(voice.id) || !voiceGenderCompatible(voice, poolGender)) return []
        const scores = matches.map(match => match.probabilities[`voice_${index}`] ?? 0).filter(score => Number.isFinite(score) && score > 0)
        return [{ voice, score: scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : 0 }]
      })
      if (poolGender !== gender) gender = poolGender
      // Jev ranks the voices from their Fish metadata; randomization happens
      // only inside the shortlist of strong candidates, so quality still
      // leads the choice while new characters stop reusing the same voice.
      // A voice question still gates the assignment (except for a lone
      // compatible voice), and an explicit no_match on a real choice is
      // respected instead of forcing a random voice.
      if (!candidates.length || !matches.length) continue
      if (candidates.length > 1 && matches.every(match => match.choice === 'no_match')) continue
      const shortlist = shortlistRankedVoices(candidates, entry => entry.score)
      const chosen = shortlist[Math.min(shortlist.length - 1, Math.floor(random() * shortlist.length))].voice
      ghost = { id: `pending:${root}`, speakerId: members[0].speakerId, voiceId: chosen.id, context: members.flatMap(group => group.context).join(' ').slice(0, 2_000), occurrenceKeys: [], lastSeenMessageId: messageId }
      linkReasons.set(root, 'new voice selected from favorites')
    }
    used.add(ghost.voiceId)
    const label = ghost.label || members.map(group => groupLabels.get(group.id)).find(Boolean)
    for (const group of members) {
      const aliases = mergeGhostAliases(
        group.speakerId.startsWith('unconfigured:') ? [group.speakerId.slice('unconfigured:'.length)] : [],
        group.speakerId === UNCAST_SPEAKER_ID && revealedUncastName(group, answers, message) ? [revealedUncastName(group, answers, message)] : [],
        groupLabels.has(group.id) ? [groupLabels.get(group.id)!] : [],
      )
      assignments.push({ groupId: group.id, voiceId: ghost.voiceId, gender, ghostId: ghost.id, matchReason: `${linkReasons.get(root) ?? 'unknown'}${group.id !== root ? `; linked to group ${root}` : ''}`, ...(label ? { label } : {}), ...(aliases.length ? { aliases } : {}) })
    }
  }
  return assignments
}

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
  version: 7
  messageLimit: number
  connectionId: string
  narratorVoice: string
  userVoice: string
  useGlobalNarratorVoice: boolean
  useGlobalUserVoice: boolean
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
  /** Escalated dialogue runs and their triggers, retained for diagnostics. */
  discourse?: {
    status: 'not-escalated' | 'completed' | 'failed'
    /** Whether the first pass issued turn-relation questions. */
    turns?: 'issued' | 'omitted'
    runs: Array<{ id: string; targets: string[]; triggers: string[] }>
  }
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

export function speakersForMessageRole<T extends CharacterLike>(
  speakers: T[],
  _isUserMessage: boolean,
  userName = 'User',
): Array<T | CharacterLike> {
  const nonUserSpeakers = speakers.filter(speaker => speaker.id !== USER_SPEAKER_ID)
  return [
    ...nonUserSpeakers,
    { id: USER_SPEAKER_ID, name: normalizeSpeakerName(userName) || 'User' },
  ]
}

export interface DetectedCharacter extends CharacterLike {
  messageCount: number
}

export interface TtsTagPlacement {
  /** Speech ID from the decision plan, used to correlate placement chunks. */
  id: string
  /** Leading emotions, always rendered at the start. At most two. */
  emotions: string[]
  /** Leading Fish S2 voice styles, rendered at the start. */
  styles: string[]
  /** New sound cues to place. Existing sounds stay in baseText. At most two total. */
  sounds: string[]
  /** New pause cues to place. Existing pauses stay in baseText. At most two total. */
  pauses: Array<'short' | 'long'>
  source: 'jev' | 'llm'
  /** Emotion-bearing text before new sound/pause insertion, used for LLM placement. */
  baseText?: string
  /** True when a mid-speech modulation point is present in baseText. */
  modulation?: boolean
  /** Jev position option ID for the modulation point. */
  modulationPoint?: string
  /** Character offset of the modulation point in the original speech. */
  modulationCharIndex?: number
  /** Surrounding narration used when generating a custom Fish emotion tag. */
  narrativeBefore?: string
  narrativeAfter?: string
}

export interface PlaybackSegment {
  text: string
  speakerId: string | null
  /** Text delivered to TTS. May contain inline vocal tags; text is unchanged. */
  ttsText?: string
  /** The inline tags represented by ttsText. */
  ttsTag?: TtsTagPlacement
  /** Human-readable parser decisions, populated only when diagnostics are requested. */
  debugPath?: string[]
}

export type SpeakerAssignmentSource = 'best-available' | 'first-pass' | 'contextual-confirmation' | 'contextual-review' | 'opening-exchange' | 'opening-backlink' | 'opening-forwardlink' | 'chain-fill' | 'chain-override' | 'discourse-fill' | 'discourse-override' | 'inheritance' | 'previous-assistant' | 'card-title' | 'role-fallback' | 'local-parser' | 'unreported'

/** Classify existing diagnostic traces without affecting speaker decisions. */
export function speakerAssignmentSourceFromTrace(steps: readonly string[], localFallback: boolean): SpeakerAssignmentSource {
  const resolution = steps.find(step => step.startsWith('resolution:'))
  if (resolution?.startsWith('resolution:best-available speaker')) return 'best-available'
  if (resolution?.startsWith('resolution:chain-identity (overrode')) return 'chain-override'
  if (resolution?.startsWith('resolution:chain-identity')) return 'chain-fill'
  if (resolution?.startsWith('resolution:discourse-identity (overrode')) return 'discourse-override'
  if (resolution?.startsWith('resolution:discourse-identity')) return 'discourse-fill'
  if (resolution?.startsWith('resolution:global-context confirmed')) return 'contextual-confirmation'
  if (resolution?.startsWith('resolution:global-context review')) {
    if (steps.includes('jev-opening-exchange:strong single-speaker review applied')) return 'opening-exchange'
    if (steps.includes('jev-opening-backlink:accepted same-speaker link to later validated quote')) return 'opening-backlink'
    if (steps.includes('jev-opening-forwardlink:accepted same-speaker link to earlier validated quote')) return 'opening-forwardlink'
    return 'contextual-review'
  }
  if (resolution === 'resolution:direct-speech-identity') return steps.includes('jev-user-review:strong alternative applied') ? 'contextual-review' : 'first-pass'
  if (resolution?.startsWith('resolution:upstream-identity')) return 'inheritance'
  if (resolution?.startsWith('resolution:previous-assistant')) return 'previous-assistant'
  if (resolution?.startsWith('resolution:unique card-title')) return 'card-title'
  if (resolution?.startsWith('resolution:user-role') || resolution?.startsWith('resolution:unresolved speech') || resolution?.startsWith('resolution:assistant connection-default')) return 'role-fallback'
  if (localFallback || steps.some(step => step.startsWith('jev-fallback:') || step.startsWith('jev-disabled:'))) return 'local-parser'
  return 'unreported'
}

/** Snapshot Jev's initial answers for debug reporting, before later reviews. */
export function snapshotSpeakerFirstPass(plan: SpeakerDecisionPlan, answers: Record<string, SpeakerDecisionChoice>): void {
  for (const speech of plan.state.speeches) {
    const answer = answers[`speech_${speech.id}`]
    if (answer) answers[`first_pass_${speech.id}`] = { ...answer, probabilities: { ...answer.probabilities } }
  }
}

/** Suppress narration only after speaker classification; unresolved speech stays audible. */
export function filterNarrationSegments(segments: PlaybackSegment[], skipNarration: boolean): PlaybackSegment[] {
  return skipNarration ? segments.filter(segment => segment.speakerId !== null) : segments
}

export interface VoicePlanSegment {
  text: string
  voice: string
  /** Speech plan ID so late tag placements can update this entry. */
  tagId?: string
}

/** Keep a deterministic role fallback when optional review tries to replace it. */
export function protectDefaultSpeakerSegments(
  localSegments: PlaybackSegment[],
  reviewedSegments: PlaybackSegment[],
  protectedSpeakerId: string,
): PlaybackSegment[] {
  if (
    localSegments.length !== reviewedSegments.length
    || localSegments.some((segment, index) => segment.text !== reviewedSegments[index]?.text)
  ) {
    return localSegments
  }
  return reviewedSegments.map((segment, index) => (
    localSegments[index].speakerId === protectedSpeakerId
      ? { ...segment, speakerId: protectedSpeakerId }
      : segment
  ))
}

export function playbackVoiceForSpeaker(
  speakerId: string | null,
  isUserMessage: boolean,
  characterVoices: Readonly<Record<string, string>>,
  narratorVoice: string,
  userVoice: string,
): string {
  if (speakerId === USER_SPEAKER_ID) return userVoice
  if (speakerId) return characterVoices[speakerId] || ''
  return narratorVoice
}

/** Preserve the distinction between narration and an unidentified speech span. */
export function markUnresolvedSpeechSegments(segments: PlaybackSegment[], includeDebug = false): PlaybackSegment[] {
  return segments.map(segment => {
    const isSpeech = segment.debugPath?.some(step => step.startsWith('segment-type:speech')) ?? false
    const { debugPath, ...plain } = segment
    const speakerId = isSpeech && segment.speakerId === null ? UNRESOLVED_SPEAKER_ID : segment.speakerId
    return includeDebug ? { ...segment, speakerId } : { ...plain, speakerId }
  })
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

export function shouldPersistMessageAudio(
  isUserMessage: boolean,
  saveGeneratedAudio: boolean,
  regeneratingSavedAudio: boolean,
): boolean {
  return !isUserMessage && (saveGeneratedAudio || regeneratingSavedAudio)
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

/**
 * Raise synthesis concurrency only while playback is at risk of exhausting its
 * ready-audio buffer. The ordinary adaptive result remains authoritative once
 * enough segments are available, and rate limiting always forces serialization.
 */
export function bufferAwareGenerationConcurrency(
  current: number,
  configuredMaximum: number,
  readyAhead: number,
  targetBuffer: number,
  adaptiveBaseline: number,
  rateLimited = false,
  maximum = 10,
): number {
  if (rateLimited) return 1
  const ceiling = Math.min(
    Math.max(1, Math.round(maximum)),
    Math.max(1, Math.round(configuredMaximum)),
  )
  const safeCurrent = Math.min(ceiling, Math.max(1, Math.round(current)))
  const safeBaseline = Math.min(ceiling, Math.max(1, Math.round(adaptiveBaseline)))
  const ready = Math.max(0, Math.round(readyAhead))
  const target = Math.max(1, Math.round(targetBuffer))
  if (ready >= target || ceiling === 1) return safeBaseline
  return Math.min(ceiling, Math.max(2, safeCurrent + 1))
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

/**
 * Normalize each planned segment into paragraph-sized TTS requests. Segments
 * are split on blank lines, but never merged across parser boundaries: a long
 * speech made of several paragraphs should synthesize as several requests so
 * playback can start sooner and paragraphs can generate concurrently.
 */
export function mergeVoicePlan(segments: VoicePlanSegment[]): VoicePlanSegment[] {
  const result: VoicePlanSegment[] = []
  for (const segment of segments) {
    const paragraphs = segment.text
      .trim()
      .split(/\n\s*\n+/)
      .map(paragraph => paragraph.replace(/\s*\n\s*/g, ' ').trim())
      .filter(Boolean)
    for (const text of paragraphs) {
      result.push({
        text,
        voice: segment.voice,
        ...(segment.tagId ? { tagId: segment.tagId } : {}),
      })
    }
  }
  return result
}

export const DEFAULT_MAX_TTS_SEGMENT_CHARS = 360

/**
 * Remove prose punctuation that marks dialogue as entering mid-turn. Some TTS
 * providers treat a leading em/en dash as an instruction to clip the adjacent
 * words, especially when it follows a vocal cue. Keep internal and trailing
 * dashes intact because they carry useful spoken phrasing and cutoff behavior.
 */
export function normalizeSpeechBoundaryDashes(text: string): string {
  return text
    .replace(/^((?:\s*(?:\[[^\]\r\n]+\]|<[^>\r\n]+>))*\s*)[—–]\s*/u, '$1')
    .trim()
}

/**
 * Break oversized, already paragraph-scoped TTS jobs near natural pauses.
 * This runs after tag placement so one tagged paragraph cannot be duplicated
 * into every chunk by a later placement update.
 */
export function splitLargeVoicePlanSegments(
  segments: VoicePlanSegment[],
  maximumChars = DEFAULT_MAX_TTS_SEGMENT_CHARS,
): VoicePlanSegment[] {
  const limit = Math.max(80, Math.round(maximumChars))
  const result: VoicePlanSegment[] = []
  for (const segment of segments) {
    let remaining = segment.text.trim()
    while (remaining.length > limit) {
      const window = remaining.slice(0, limit + 1)
      const sentenceBreaks: number[] = []
      const clauseBreaks: number[] = []
      const wordBreaks: number[] = []
      let bracketDepth = 0
      for (let index = 0; index < window.length; index += 1) {
        const character = window[index]
        if (character === '[') bracketDepth += 1
        else if (character === ']' && bracketDepth > 0) bracketDepth -= 1
        if (bracketDepth > 0 || !/\s/u.test(character)) continue
        wordBreaks.push(index)
        let previousIndex = index - 1
        while (previousIndex >= 0 && /["”’')\]]/u.test(window[previousIndex])) previousIndex -= 1
        const previous = window[previousIndex] ?? ''
        if (/[.!?…]/u.test(previous)) sentenceBreaks.push(index)
        else if (/[,;:—–]/u.test(previous)) clauseBreaks.push(index)
      }
      const latestAtOrAfter = (candidates: number[], minimum: number) => (
        [...candidates].reverse().find(position => position >= minimum)
      )
      const splitAt = latestAtOrAfter(sentenceBreaks, Math.floor(limit * 0.35))
        ?? latestAtOrAfter(clauseBreaks, Math.floor(limit * 0.55))
        ?? latestAtOrAfter(wordBreaks, Math.floor(limit * 0.7))
        ?? wordBreaks.at(-1)
        ?? limit
      const text = remaining.slice(0, splitAt).trim()
      if (!text) break
      result.push({
        text,
        voice: segment.voice,
        ...(segment.tagId ? { tagId: segment.tagId } : {}),
      })
      remaining = remaining.slice(splitAt).trim()
    }
    if (remaining) {
      result.push({
        text: remaining,
        voice: segment.voice,
        ...(segment.tagId ? { tagId: segment.tagId } : {}),
      })
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

function readCachedDiscourse(
  value: unknown,
): CachedMessageParse['discourse'] {
  if (!isRecord(value)) return undefined
  const status = value.status
  if (status !== 'not-escalated' && status !== 'completed' && status !== 'failed') return undefined
  const turns = value.turns === 'issued' || value.turns === 'omitted' ? value.turns : undefined
  const runs: Array<{ id: string; targets: string[]; triggers: string[] }> = []
  const readIds = (ids: unknown) => Array.isArray(ids)
    ? ids.filter((id): id is string => typeof id === 'string').slice(0, 256).map(id => id.slice(0, 64))
    : []
  if (Array.isArray(value.runs)) {
    for (const run of value.runs.slice(0, 16)) {
      if (!isRecord(run) || typeof run.id !== 'string') continue
      runs.push({ id: run.id.slice(0, 64), targets: readIds(run.targets), triggers: readIds(run.triggers) })
    }
  }
  return { status, runs, ...(turns ? { turns } : {}) }
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
      const ttsText = typeof segment.ttsText === 'string'
        ? segment.ttsText.trim().slice(0, 20_000)
        : ''
      const ttsTag = isRecord(segment.ttsTag)
        && typeof segment.ttsTag.id === 'string'
        && Array.isArray(segment.ttsTag.emotions)
        && (segment.ttsTag.source === 'jev' || segment.ttsTag.source === 'llm')
        ? {
            id: segment.ttsTag.id.slice(0, 64),
            emotions: (segment.ttsTag.emotions as unknown[])
              .filter((value): value is string => typeof value === 'string')
              .map(value => normalizeTtsTagName(value))
              .filter((value): value is string => !!value && ttsTagCategory(value) === 'emotion')
              .slice(0, 2),
            styles: (Array.isArray(segment.ttsTag.styles) ? segment.ttsTag.styles : [])
              .filter((value): value is string => typeof value === 'string')
              .map(value => normalizeTtsTagName(value))
              .filter((value): value is string => !!value && ttsTagCategory(value) === 'style')
              .slice(0, 1),
            sounds: (Array.isArray(segment.ttsTag.sounds) ? segment.ttsTag.sounds : [])
              .filter((value): value is string => typeof value === 'string')
              .map(value => normalizeTtsTagName(value))
              .filter((value): value is string => !!value && ttsTagCategory(value) === 'sound')
              .slice(0, 2),
            pauses: (Array.isArray(segment.ttsTag.pauses) ? segment.ttsTag.pauses : [])
              .filter((value): value is 'short' | 'long' => value === 'short' || value === 'long')
              .slice(0, 2),
            source: segment.ttsTag.source as 'jev' | 'llm',
            ...(typeof segment.ttsTag.baseText === 'string'
              ? { baseText: segment.ttsTag.baseText.trim().slice(0, 20_000) }
              : {}),
            ...(segment.ttsTag.modulation === true
              ? { modulation: true }
              : {}),
            ...(segment.ttsTag.modulation === true
              && typeof segment.ttsTag.modulationPoint === 'string'
              ? { modulationPoint: segment.ttsTag.modulationPoint.trim().slice(0, 64) }
              : {}),
            ...(segment.ttsTag.modulation === true
              && typeof segment.ttsTag.modulationCharIndex === 'number'
              && Number.isInteger(segment.ttsTag.modulationCharIndex)
              ? { modulationCharIndex: segment.ttsTag.modulationCharIndex }
              : {}),
            ...(typeof segment.ttsTag.narrativeBefore === 'string'
              ? { narrativeBefore: segment.ttsTag.narrativeBefore.trim().slice(0, 20_000) }
              : {}),
            ...(typeof segment.ttsTag.narrativeAfter === 'string'
              ? { narrativeAfter: segment.ttsTag.narrativeAfter.trim().slice(0, 20_000) }
              : {}),
          }
        : null
      if (text) {
        segments.push({
          text,
          speakerId: speakerId?.slice(0, 256) ?? null,
          ...(ttsText ? { ttsText } : {}),
          ...(ttsTag && (
            ttsTag.emotions.length > 0
            || ttsTag.styles.length > 0
            || ttsTag.sounds.length > 0
            || ttsTag.pauses.length > 0
            || ttsTag.modulation === true
          ) ? { ttsTag } : {}),
        })
      }
    }
    if (segments.length > 0) {
      const discourse = readCachedDiscourse(item.discourse)
      result[messageId.slice(0, 256)] = {
        contentHash: item.contentHash.slice(0, 32),
        segments,
        ...(discourse ? { discourse } : {}),
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
      name: typeof item.name === 'string' ? item.name.trim().slice(0, 4096) : '',
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

  const narratorVoice = typeof raw.narratorVoice === 'string'
    ? raw.narratorVoice.trim().slice(0, 512)
    : overrides.narrator?.voice ?? ''
  const userVoice = typeof raw.userVoice === 'string'
    ? raw.userVoice.trim().slice(0, 512)
    : ''

  return {
    version: 7,
    messageLimit: clampMessageLimit(raw.messageLimit),
    connectionId: typeof raw.connectionId === 'string'
      ? raw.connectionId.trim().slice(0, 128)
      : inferredConnection,
    narratorVoice,
    userVoice,
    useGlobalNarratorVoice: typeof raw.useGlobalNarratorVoice === 'boolean'
      ? raw.useGlobalNarratorVoice
      : !narratorVoice,
    useGlobalUserVoice: typeof raw.useGlobalUserVoice === 'boolean'
      ? raw.useGlobalUserVoice
      : !userVoice,
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

export function extractGenerationText(value: unknown): string {
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

/** Obvious setting titles are not evidence that the card itself is a speaker. */
export function isScenarioCardTitle(name: string): boolean {
  return /\b(?:world|rpg|roleplay|scenario|simulator|simulation|sandbox)\b/iu.test(speakerAliases(name)[0] ?? name)
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

const PREPOSITION_WORDS = [
  'above', 'across', 'after', 'against', 'along', 'amid', 'among', 'around', 'as',
  'at', 'before', 'behind', 'below', 'beneath', 'beside', 'between', 'beyond', 'by',
  'despite', 'down', 'during', 'except', 'for', 'from', 'in', 'inside', 'into',
  'like', 'near', 'of', 'off', 'on', 'onto', 'opposite', 'out', 'outside', 'over',
  'past', 'since', 'through', 'throughout', 'to', 'toward', 'towards', 'under',
  'underneath', 'unlike', 'until', 'up', 'upon', 'via', 'with', 'within', 'without',
] as const

const NON_NAME_PARAGRAPH_LEADS = new Set<string>([
  ...PREPOSITION_WORDS,
  'a', 'an', 'although', 'and', 'because', 'but', 'he', 'her', 'here', 'his', 'if',
  'it', 'its', 'or', 'she', 'so', 'somebody', 'someone', 'anybody', 'anyone', 'nobody', 'noone', 'everybody', 'everyone', 'somewhere', 'that', 'the', 'their', 'then',
  'there', 'they', 'this', 'those', 'though', 'unless', 'we', 'when', 'where',
  'whereas', 'whether', 'while', 'who', 'whom', 'whose', 'you', 'your',
])

const PREPOSITION_BEFORE_NAME_PATTERN = new RegExp(
  `\\b(?:${PREPOSITION_WORDS.join('|')})\\s*$`,
  'iu',
)

const INTRODUCTORY_PREPOSITIONAL_PHRASE_PATTERN = new RegExp(
  `^\\s*(?:${PREPOSITION_WORDS.join('|')})\\b(?:\\s+[\\p{L}\\p{M}'’-]+){1,7}\\s*,?\\s*$`,
  'iu',
)

export function unconfiguredSpeakerId(name: string): string {
  return `unconfigured:${normalizeSpeakerName(name).toLowerCase()}`
}

/**
 * Add message-local identities for clear named subjects around dialogue.
 * These identities are intentionally not persisted to the card cast; an absent
 * voice mapping therefore routes them through the selected connection's voice.
 */
export function addUnconfiguredDialogueSpeakers(
  content: string,
  speakers: CharacterLike[],
  skippedTrackerTagPairs = '',
): CharacterLike[] {
  const preparedContent = preparePlaybackContent(content, skippedTrackerTagPairs)
  const result = [...speakers]
  const knownAliases = new Set(result.flatMap(speaker => (
    speakerAliases(speaker.name).map(alias => alias.toLowerCase())
  )))
  const addCandidate = (rawName: string, explicitlyAttributed = false) => {
    const name = normalizeSpeakerName(rawName.replace(/['’]s$/u, ''))
    const aliases = speakerAliases(name)
    const first = aliases[0]?.split(/\s+/u)[0]?.toLowerCase() ?? ''
    if (!name || !first || NON_NAME_PARAGRAPH_LEADS.has(first)) return
    if (aliases.some(alias => knownAliases.has(alias.toLowerCase()))) return
    if (!explicitlyAttributed) {
      const occurrences = [...preparedContent.matchAll(
        // A newly inferred proper name must repeat with the same capitalization.
        // This prevents sentence-leading descriptors such as "Quiet now" from
        // becoming characters merely because the word appears elsewhere in prose.
        new RegExp(`\\b${escapedPattern(name)}(?:['’]s)?\\b`, 'gu'),
      )].length
      if (occurrences < 2) return
    }
    const id = unconfiguredSpeakerId(name)
    if (result.some(speaker => speaker.id === id)) return
    result.push({ id, name })
    for (const alias of aliases) knownAliases.add(alias.toLowerCase())
  }

  // Possessive subjects can establish an unconfigured person even when the
  // name follows another sentence, as in a phone conversation's action beat.
  const narrative = narrativeOnly(preparedContent)
  for (const match of narrative.matchAll(/\b([\p{Lu}][\p{L}\p{M}-]{1,63})['\u2019]s\s+[\p{L}\p{M}-]+/gu)) addCandidate(match[1])
  // Collect repeated proper-name subjects within a sentence, not just at a
  // paragraph's beginning. These are candidates; Jev still attributes speech.
  for (const match of narrative.matchAll(/\b(?:and|but|then)\s+([\p{Lu}][\p{L}\p{M}-]{1,63})\s+[\p{Ll}][\p{L}\p{M}-]+/gu)) addCandidate(match[1])
  // A self-introduction supplies a candidate only when the same name also
  // appears elsewhere; it does not by itself assign any quote to that person.
  for (const quote of playbackQuotes(preparedContent)) {
    for (const match of quote.text.matchAll(/\bI(?:'|\u2019)m\s+([\p{Lu}][\p{L}\p{M}-]{1,63})\b/gu)) addCandidate(match[1])
  }
  const paragraphs = playbackParagraphs(preparedContent)
  for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex += 1) {
    const paragraph = paragraphs[paragraphIndex]
    const quotes = playbackQuotes(paragraph.text)
    if (quotes.length === 0) {
      const nextHasDialogue = paragraphIndex + 1 < paragraphs.length
        && playbackQuotes(paragraphs[paragraphIndex + 1].text).length > 0
      if (!nextHasDialogue) continue
      const narration = paragraph.text.replace(/^[\s,.;:!?—–-]+/u, '')
      const attributedLead = narration.match(
        new RegExp(
          `^([\\p{Lu}][\\p{L}\\p{M}'’.\\-]{1,63})(?:(?:\\s*,\\s*[^,\\n]{1,60},\\s*)|\\s+)${SPEECH_VERBS}\\b`,
          'u',
        ),
      )?.[1]
      if (attributedLead) addCandidate(attributedLead, true)
      else {
        const lead = narration.match(/^([\p{Lu}][\p{L}\p{M}'’.\-]{1,63})(?=\s)/u)?.[1]
        if (lead) addCandidate(lead)
      }
      continue
    }
    let cursor = 0
    for (const quote of quotes) {
      const narration = paragraph.text.slice(cursor, quote.start)
        .replace(/^[\s,.;:!?—–-]+/u, '')
      const lead = narration.match(/^([\p{Lu}][\p{L}\p{M}'’.\-]{1,63})(?=\s)/u)?.[1]
      if (lead) addCandidate(lead)
      cursor = quote.end
    }
    const trailingNarration = paragraph.text.slice(cursor)
      .replace(/^[\s,.;:!?—–-]+/u, '')
    const trailingLead = trailingNarration.match(
      /^([\p{Lu}][\p{L}\p{M}'’.\-]{1,63}(?:\s+[\p{Lu}][\p{L}\p{M}'’.\-]{1,63}){0,2})(?=\s+(?:said|asked|answered|replied|whispered|murmured|called|shouted|added|continued|observed|remarked|gasped|breathed)\b)/u,
    )?.[1]
    if (trailingLead) addCandidate(trailingLead, true)
    else {
      const lead = trailingNarration.match(/^([\p{Lu}][\p{L}\p{M}'’.\-]{1,63})(?=\s)/u)?.[1]
      if (lead) addCandidate(lead)
    }
  }
  return result
}

/** Whether the message names any available speaker, including inside dialogue. */
export function hasNamedSpeakerMention(
  content: string,
  speakers: CharacterLike[],
  skippedTrackerTagPairs = '',
): boolean {
  const playbackContent = preparePlaybackContent(content, skippedTrackerTagPairs)
  return speakers.some(speaker => speakerAliases(speaker.name).some(alias => (
    new RegExp(`\\b${escapedPattern(alias)}\\b`, 'iu').test(playbackContent)
  )))
}

/** Match a card title only when all matching aliases belong to one speaker. */
export function speakerIdMatchingCardTitle(
  cardTitle: string,
  speakers: CharacterLike[],
): string | null {
  const normalizedTitle = normalizeSpeakerName(cardTitle)
  const matchingSpeakerIds = new Set<string>()
  for (const speaker of speakers) {
    for (const alias of speakerAliases(speaker.name)) {
      if (!new RegExp(`\\b${escapedPattern(alias)}\\b`, 'iu').test(normalizedTitle)) continue
      matchingSpeakerIds.add(speaker.id)
      break
    }
  }
  return matchingSpeakerIds.size === 1 ? [...matchingSpeakerIds][0] : null
}

export function preferredCardSpeakerId(
  message: { name?: string; extra?: Record<string, unknown> },
  speakers: CharacterLike[],
  cardCharacterIds: readonly string[],
): string | null {
  const speakerIds = new Set(speakers.map(speaker => speaker.id))
  const explicitId = typeof message.extra?.character_id === 'string'
    ? message.extra.character_id
    : ''
  if (explicitId && speakerIds.has(explicitId)) return explicitId

  const messageName = normalizeSpeakerName(message.name ?? '').toLowerCase()
  const namedSpeaker = messageName
    ? speakers.find(speaker => (
        speakerAliases(speaker.name).some(alias => alias.toLowerCase() === messageName)
      ))
    : undefined
  if (namedSpeaker) return namedSpeaker.id

  const availableCardIds = [...new Set(cardCharacterIds)]
    .filter(characterId => speakerIds.has(characterId))
  return availableCardIds.length === 1 ? availableCardIds[0] : null
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
  const detected = new Map<string, CharacterLike>()
  for (const member of cast) {
    const exactCard = cardsByName.get(normalizeSpeakerName(member.name).toLowerCase())
    const sourceCard = cardsById.get(member.cardId)
    const matchingCard = exactCard
      ?? (sourceCard && namesDescribeSameCardCharacter(sourceCard.name, member.name) ? sourceCard : null)
    const id = matchingCard?.id ?? npcSpeakerId(member.name)
    const existing = detected.get(id)
    if (!existing) {
      detected.set(id, { id, name: matchingCard ? combineSpeakerNames(matchingCard.name, member.name) : member.name })
    } else if (matchingCard) {
      detected.set(id, { ...existing, name: combineSpeakerNames(existing.name, member.name) })
    }
  }
  return addScannedFirstNameAliases([...detected.values()])
}

export function npcSpeakerId(name: string): string {
  return `npc:${normalizeSpeakerName(name).toLowerCase()}`
}

/** Map every transient alias ID back to its configured roster identity. */
export function speakerAliasIdLookup(speakers: CharacterLike[]): Map<string, string> {
  const aliases = new Map<string, string>()
  for (const speaker of speakers) {
    for (const alias of speakerAliases(speaker.name)) {
      aliases.set(npcSpeakerId(alias), speaker.id)
      aliases.set(unconfiguredSpeakerId(alias), speaker.id)
    }
  }
  return aliases
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

export interface SkippedTrackerTagPair {
  open: string
  close: string
}

const TRACKER_TAG_NAME_RE = /^[a-z][a-z0-9:._-]*$/u

function normalizeTrackerTagName(value: string): string | null {
  const tag = value.trim().toLowerCase()
  return TRACKER_TAG_NAME_RE.test(tag) ? tag : null
}

/**
 * Parse the global exclusion setting. Each comma-separated entry is one of:
 * - a tag name (`tracker`), treated as a symmetric pair;
 * - a single full tag (`<tracker>`), treated as a symmetric pair;
 * - a full pair (`<o_ledger></o_l>`), which may open and close with different
 *   names.
 *
 * Attributes and surrounding whitespace are ignored; only the tag names are
 * retained so the same entry matches tags with attributes in the message.
 */
export function parseSkippedTrackerTagPairs(value: string): SkippedTrackerTagPair[] {
  const decoded = decodePlaybackEntities(value)
  const pairs: SkippedTrackerTagPair[] = []
  const seen = new Set<string>()
  const addPair = (open: string | null, close: string | null) => {
    if (!open || !close) return
    const key = `${open}\u0000${close}`
    if (seen.has(key)) return
    seen.add(key)
    pairs.push({ open, close })
  }
  const addSymmetric = (name: string | null) => addPair(name, name)

  for (const entry of decoded.split(',')) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    const pairMatch = trimmed.match(
      /^\\?<\s*([a-z][a-z0-9:._-]*)(?=\s|>)[^>]*>\s*\\?<\s*\/\s*([a-z][a-z0-9:._-]*)(?=\s|>)[^>]*>$/iu,
    )
    if (pairMatch) {
      addPair(
        normalizeTrackerTagName(pairMatch[1] ?? ''),
        normalizeTrackerTagName(pairMatch[2] ?? ''),
      )
      if (pairs.length >= 100) return pairs
      continue
    }
    const tagMatch = trimmed.match(/^\\?<\s*([a-z][a-z0-9:._-]*)(?=\s|>)[^>]*>$/iu)
    if (tagMatch) {
      addSymmetric(normalizeTrackerTagName(tagMatch[1] ?? ''))
      if (pairs.length >= 100) return pairs
      continue
    }
    addSymmetric(normalizeTrackerTagName(trimmed))
    if (pairs.length >= 100) return pairs
  }
  // Keep previously saved paired-tag settings working after the simpler
  // name-only format was introduced. This also accepts an entry that embeds
  // example content between symmetric tags.
  const legacyPattern = /\\?<\s*([a-z][a-z0-9:._-]*)(?=\s|>)[^>]*>[\s\S]*?\\?<\s*\/\s*\1\s*>/giu
  for (const match of decoded.matchAll(legacyPattern)) {
    addSymmetric(normalizeTrackerTagName(match[1] ?? ''))
    if (pairs.length >= 100) break
  }
  return pairs
}

/** Opening tag names for callers that only need the tag itself. */
export function parseSkippedTrackerTags(value: string): string[] {
  return [...new Set(parseSkippedTrackerTagPairs(value).map(pair => pair.open))].slice(0, 100)
}

function stripTagBlock(value: string, openTag: string, closeTag: string): string {
  const open = escapedPattern(openTag)
  const close = escapedPattern(closeTag)
  const tokenPattern = new RegExp(
    `(\\\\?<\\s*${open}(?=\\s|>)[^>]*>)|(\\\\?<\\s*\\/\\s*${close}(?=\\s|>)[^>]*>)`,
    'giu',
  )
  const ranges: Array<{ start: number; end: number }> = []
  let depth = 0
  let blockStart = -1
  for (const match of value.matchAll(tokenPattern)) {
    if (match.index === undefined) continue
    const opening = match[1] !== undefined
    if (opening) {
      if (!/\/\s*>$/u.test(match[0])) {
        if (depth === 0) blockStart = match.index
        depth += 1
      }
    } else if (depth > 0) {
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
  for (const pair of parseSkippedTrackerTagPairs(tagPairs)) {
    result = stripTagBlock(result, pair.open, pair.close)
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
    if (!lead.trim() || /^[\s{(\[]*$/u.test(lead)) score += 10
    else if (!earlierInClause && /^[^,]{1,48},\s*(?:(?:a|an|the)\s+)?$/iu.test(lead)) score += 8

    // A roster name used as the object of a preposition is an addressee or
    // contextual mention, not evidence that the name owns nearby dialogue.
    if (PREPOSITION_BEFORE_NAME_PATTERN.test(lead)) {
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
      const pattern = new RegExp(`\\b${escapedPattern(alias)}\\b['’]s\\s+`, 'giu')
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
        if (lead.trim() && !/\b(?:and|but|then)\s*$/iu.test(lead)) continue
        const clause = narrative.slice(match.index + match[0].length).split(/[.!?;\n]/u, 1)[0]
        const clauseWords = clause.match(/[\p{L}\p{M}'’-]+/gu) ?? []
        // Clause position is more durable evidence than a finite verb list.
        // Three following words also reject fragments such as "Grace's wrist."
        if (clauseWords.length >= 3) matches.add(speaker.id)
      }
    }
  }
  return matches.size === 1 ? [...matches][0] : null
}

/** Resolve "Across the room Jeremy's breathing..." immediately before dialogue. */
function frontedPrepositionalPossessiveSubject(
  text: string,
  speakers: CharacterLike[],
): string | null {
  const narrative = narrativeOnly(text)
  if (mentionedSpeakers(narrative, speakers).clean.size > 0) return null
  const matches = new Set<string>()
  for (const speaker of speakers) {
    for (const alias of speakerAliases(speaker.name)) {
      const pattern = new RegExp(`\\b${escapedPattern(alias)}\\b['’]s\\s+`, 'giu')
      for (const match of narrative.matchAll(pattern)) {
        if (match.index === undefined) continue
        const prefix = narrative.slice(0, match.index)
        const sentenceStart = Math.max(
          prefix.lastIndexOf('.'), prefix.lastIndexOf('!'), prefix.lastIndexOf('?'),
          prefix.lastIndexOf(';'), prefix.lastIndexOf('\n'),
        ) + 1
        if (!INTRODUCTORY_PREPOSITIONAL_PHRASE_PATTERN.test(prefix.slice(sentenceStart))) continue
        const clause = narrative.slice(match.index + match[0].length).split(/[.!?;\n]/u, 1)[0]
        if ((clause.match(/[\p{L}\p{M}'’-]+/gu) ?? []).length >= 3) matches.add(speaker.id)
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
  if (mentions.clean.size > 0) return discourseSubjectSpeaker(text, speakers, mentions.clean)
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
  if (mentions.clean.size === 1) return discourseSubjectSpeaker(text, speakers, mentions.clean)
  if (mentions.clean.size === 0) {
    return mainClausePossessiveSubject(text, speakers, mentions.possessive)
  }
  return null
}

const ANONYMOUS_ROLE_NOUNS = [
  'cashier', 'clerk', 'customer', 'driver', 'employee', 'guard', 'passerby',
  'server', 'shopkeeper', 'staffer', 'stranger', 'waiter', 'waitress', 'worker',
] as const

const ANONYMOUS_HUMAN_NOUNS = [
  ...ANONYMOUS_ROLE_NOUNS,
  'boy', 'child', 'girl', 'guy', 'kid', 'lady', 'man', 'person', 'teen',
  'teenager', 'woman',
] as const

const ANONYMOUS_HUMAN_SUBJECT_PATTERN = new RegExp(
  `(?:^\\s*|[.!?;]\\s+|^\\s*[^,\\n]{1,120},\\s*)(?:`
    + `(?:a|an|another|some)\\s+(?:[\\p{L}\\p{M}'’-]+[ -]){0,5}`
      + `(?:${ANONYMOUS_HUMAN_NOUNS.join('|')})`
    + `|the\\s+(?:[\\p{L}\\p{M}'’-]+[ -]){0,5}`
      + `(?:${ANONYMOUS_ROLE_NOUNS.join('|')})`
    + `)\\b`,
  'iu',
)

const ANONYMOUS_HUMAN_IDENTITY_PATTERN = new RegExp(
  `\\b(?:`
    + `(?:a|an|another|some)\\s+(?:[\\p{L}\\p{M}'’-]+[ -]){0,5}`
      + `(?:${ANONYMOUS_HUMAN_NOUNS.join('|')})`
    + `|the\\s+(?:[\\p{L}\\p{M}'’-]+[ -]){0,5}`
      + `(?:${ANONYMOUS_ROLE_NOUNS.join('|')})`
    + `)\\b`,
  'iu',
)

/**
 * An explicitly anonymous role such as "the clerk" or "a stranger". Unlike the
 * broader human pattern, generic descriptors like "the woman" or "the man" are
 * excluded, because those commonly refer to the card character itself.
 */
const ANONYMOUS_ROLE_IDENTITY_PATTERN = new RegExp(
  `\\b(?:a|an|another|some|the)\\s+(?:[\\p{L}\\p{M}'’-]+[ -]){0,5}`
    + `(?:${ANONYMOUS_ROLE_NOUNS.join('|')})\\b`,
  'iu',
)

/** Detect a clause-leading, explicitly anonymous person such as "an older woman". */
function hasAnonymousHumanSubject(text: string): boolean {
  return ANONYMOUS_HUMAN_SUBJECT_PATTERN.test(narrativeOnly(text))
}

function hasAnonymousHumanIdentity(text: string): boolean {
  return ANONYMOUS_HUMAN_IDENTITY_PATTERN.test(narrativeOnly(text))
}

function hasAnonymousSpeechAttribution(text: string): boolean {
  const narrative = narrativeOnly(text)
  return hasAnonymousHumanSubject(narrative)
    && new RegExp(`\\b${SPEECH_VERBS}\\b`, 'iu').test(narrative)
}

function hasLeadingPronounSubject(text: string): boolean {
  return /^(?:he|she|they)\b/iu.test(narrativeOnly(text).trimStart())
}

/** Whether playable narration establishes any available character as a clause subject. */
export function hasNamedSpeakerSubject(
  content: string,
  speakers: CharacterLike[],
  skippedTrackerTagPairs = '',
): boolean {
  const playbackContent = preparePlaybackContent(content, skippedTrackerTagPairs)
  return playbackParagraphs(playbackContent).some(paragraph => {
    const mentions = mentionedSpeakers(paragraph.text, speakers)
    return preferredMentionedSpeaker(paragraph.text, speakers, mentions) !== null
  })
}

/**
 * Use a card-matched speaker only when the message establishes no other
 * character identity. Named local speakers, explicit anonymous roles, and
 * indefinite human introductions all make the card match ineligible, leaving
 * otherwise unresolved dialogue on the connection default voice. A definite
 * "the woman" or "the man" may be the card itself, so it does not block the
 * fallback.
 */
export function eligibleCardFallbackSpeakerId(
  content: string,
  cardSpeakerId: string | null,
  speakers: CharacterLike[],
  skippedTrackerTagPairs = '',
): string | null {
  if (!cardSpeakerId) return null
  const alternativeSpeakers = speakers.filter(speaker => speaker.id !== cardSpeakerId)
  if (hasNamedSpeakerSubject(content, alternativeSpeakers, skippedTrackerTagPairs)) return null
  return hasExplicitUncastCue(content, skippedTrackerTagPairs) ? null : cardSpeakerId
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

export interface SpeakerDecisionPlan {
  state: {
    messageRole: 'assistant' | 'user'
    message: string
    speakers: Array<{ option: string; id: string; name: string; aliases: string[] }>
    paragraphs: Array<{ id: string; text: string }>
    speeches: Array<{
      id: string
      paragraphId: string
      text: string
      /** Clean narration before and after the quotation inside its paragraph. */
      narrativeBefore: string
      narrativeAfter: string
    }>
    /** Structural dialogue runs used by the chain decoder. */
    runs: Array<{ id: string; speechIds: string[] }>
    /** Adjacent speech pairs that carry a turn-relation question. */
    turns: Array<{ speechId: string; previousSpeechId: string; bridge: string }>
    /** True when turn questions were dropped to stay inside the question limit. */
    turnQuestionsOmitted: boolean
  }
  questions: Record<string, {
    type: 'choice'
    instructions: string
    criteria: Record<string, string>
  }>
  optionSpeakerIds: Record<string, string>
}

export interface SpeakerDecisionChoice {
  choice: string
  probabilities: Record<string, number>
  confidence: number
}

const DECISION_UNCAST_OPTION = 'uncast_character'
const DECISION_UNCLEAR_OPTION = 'no_clear_identity'
const TURN_CONTINUE_OPTION = 'continues_previous_turn'
const TURN_RESPOND_OPTION = 'responds_to_previous_speaker'
const TURN_OTHER_OPTION = 'responds_to_other_participant'
const TURN_UNCLEAR_OPTION = 'no_clear_relation'
const MAX_DECISION_QUESTIONS = 256

const TURN_RELATION_CRITERIA: Record<string, string> = {
  [TURN_CONTINUE_OPTION]: 'The same speaker is still talking; no new speaker has taken over.',
  [TURN_RESPOND_OPTION]: 'A different participant answers the immediately preceding speaker.',
  [TURN_OTHER_OPTION]: 'A different participant addresses someone else in the scene, a third party, or an off-scene channel.',
  [TURN_UNCLEAR_OPTION]: 'The text does not establish whether the speaker continues or changes.',
}

function speakerDecisionCriteria(
  stateSpeakers: SpeakerDecisionPlan['state']['speakers'],
): Record<string, string> {
  return Object.fromEntries([
    ...stateSpeakers.map(speaker => [
      speaker.option,
      speaker.id === USER_SPEAKER_ID
        ? `The user persona (${speaker.name}; aliases: ${speaker.aliases.join(', ')}). Select only when the text supports this identity; other unnamed people may be uncast.`
        : `${speaker.name}, including these aliases: ${speaker.aliases.join(', ')}`,
    ]),
    [DECISION_UNCAST_OPTION, 'A specific character present in the text who is not one of the known speakers.'],
    [DECISION_UNCLEAR_OPTION, 'The text does not establish a reliable character identity.'],
  ])
}

export function buildSpeakerDecisionPlan(
  content: string,
  speakers: CharacterLike[],
  isUserMessage: boolean,
  skippedTrackerTagPairs = '',
): SpeakerDecisionPlan {
  const message = preparePlaybackContent(content, skippedTrackerTagPairs)
  const paragraphs = playbackParagraphs(message)
  const quotes = playbackQuotes(message)
  const optionSpeakerIds: Record<string, string> = {}
  const stateSpeakers = speakers.slice(0, 253).map((speaker, index) => {
    const option = `known_${index}`
    optionSpeakerIds[option] = speaker.id
    return { option, id: speaker.id, name: speaker.name, aliases: speakerAliases(speaker.name) }
  })
  const criteria = speakerDecisionCriteria(stateSpeakers)
  const stateParagraphs = paragraphs.map((paragraph, index) => ({
    id: `p${index}`,
    text: cleanPlaybackText(paragraph.text),
  }))
  const stateSpeeches = quotes.map((quote, index) => {
    const paragraphIndex = Math.max(0, paragraphs.findIndex(paragraph => (
      quote.start >= paragraph.start && quote.start < paragraph.end
    )))
    const paragraph = paragraphs[paragraphIndex]
    const paragraphStart = paragraph?.start ?? 0
    const paragraphEnd = paragraph?.end ?? paragraphStart
    const localStart = Math.max(0, quote.start - paragraphStart)
    const localEnd = Math.max(localStart, quote.end - paragraphStart)
    const sameParagraph = (candidate: PlaybackQuote | undefined) => Boolean(
      candidate && candidate.start >= paragraphStart && candidate.start < paragraphEnd,
    )
    const previousQuote = index > 0 && sameParagraph(quotes[index - 1]) ? quotes[index - 1] : undefined
    const nextQuote = sameParagraph(quotes[index + 1]) ? quotes[index + 1] : undefined
    const beforeStart = previousQuote ? previousQuote.end - paragraphStart : 0
    const afterEnd = nextQuote ? nextQuote.start - paragraphStart : (paragraph?.text.length ?? 0)
    return {
      id: `s${index}`,
      paragraphId: `p${paragraphIndex}`,
      text: cleanPlaybackText(quote.text),
      narrativeBefore: cleanPlaybackText(narrativeOnly(paragraph?.text.slice(beforeStart, localStart) ?? '')),
      narrativeAfter: cleanPlaybackText(narrativeOnly(paragraph?.text.slice(localEnd, afterEnd) ?? '')),
    }
  })
  const questions: SpeakerDecisionPlan['questions'] = {}
  for (const paragraph of stateParagraphs) {
    questions[`paragraph_${paragraph.id}`] = {
      type: 'choice',
      instructions: `Which identity is locally established as the acting or speaking subject of paragraph ${paragraph.id}? Judge narration and quotations, including named subjects and pronoun references across nearby paragraphs and earlier conversation. Distinguish speakers from people addressed or mentioned; use pronouns as contextual evidence, not proof of gender or identity. Do not prefer a card or historical speaker without evidence.`,
      criteria,
    }
  }
  for (const speech of stateSpeeches) {
    questions[`speech_${speech.id}`] = {
      type: 'choice',
      instructions: `Who speaks quotation ${speech.id}? Use the quotation, narration before and after it, the previous assistant messages, name and pronoun references, action ownership, and dialogue flow. Follow a person's actions across messages and distinguish the speaker from a person addressed or a bystander. Consider phone calls and incoming text messages as separate channels. Pronouns are contextual clues, not proof of gender or identity; choose no_clear_identity if the link is uncertain. Do not prefer a known speaker merely because they are listed.`,
      criteria,
    }
  }
  const plan: SpeakerDecisionPlan = {
    state: {
      messageRole: isUserMessage ? 'user' : 'assistant',
      message,
      speakers: stateSpeakers,
      paragraphs: stateParagraphs,
      speeches: stateSpeeches,
      runs: [],
      turns: [],
      turnQuestionsOmitted: false,
    },
    questions,
    optionSpeakerIds,
  }

  // Turn questions cover adjacent quotations inside each structural run. They
  // are dropped rather than rejected when the first pass would exceed the
  // host's question limit.
  const drafts = dialogueRunDrafts(plan)
  const quoteBySpeechId = new Map(stateSpeeches.map((speech, index) => [speech.id, quotes[index]]))
  plan.state.runs = drafts.map((draft, index) => ({ id: `run_${index}`, speechIds: draft.speeches }))
  plan.state.turns = drafts.flatMap(draft => draft.speeches.slice(1).flatMap((speechId, index) => {
    const previousSpeechId = draft.speeches[index]
    return previousSpeechId
      ? [{
          speechId,
          previousSpeechId,
          bridge: narrationBridge(message, quoteBySpeechId.get(previousSpeechId), quoteBySpeechId.get(speechId)),
        }]
      : []
  }))
  for (const turn of plan.state.turns) {
    questions[`turn_${turn.speechId}`] = {
      type: 'choice',
      instructions: `How does quotation ${turn.speechId} relate to quotation ${turn.previousSpeechId} immediately before it in the same dialogue run? Judge the exchange using both quotations and the narration between them. Continuing means the same speaker is still talking; responding means a different participant has taken over.`,
      criteria: TURN_RELATION_CRITERIA,
    }
  }
  if (Object.keys(questions).length > MAX_DECISION_QUESTIONS) {
    for (const turn of plan.state.turns) delete questions[`turn_${turn.speechId}`]
    plan.state.turns = []
    plan.state.turnQuestionsOmitted = true
  }
  return plan
}

/** Reconsider assistant quotes attributed to the persona when another named subject is present. */
export function buildAssistantUserSpeakerReview(plan: SpeakerDecisionPlan, answers: Record<string, SpeakerDecisionChoice>) {
  const others = plan.state.speakers.filter(speaker => speaker.id !== USER_SPEAKER_ID)
  const questions: SpeakerDecisionPlan['questions'] = {}
  if (plan.state.messageRole === 'assistant' && others.length && hasNamedSpeakerSubject(plan.state.message, others)) {
    const criteria = speakerDecisionCriteria(plan.state.speakers)
    for (const speech of plan.state.speeches) {
      const first = evaluateSpeakerDecisionAnswer(answers[`speech_${speech.id}`], plan.optionSpeakerIds)
      if (first.identity !== USER_SPEAKER_ID) continue
      questions[`user_review_${speech.id}`] = {
        type: 'choice',
        instructions: `Independently identify who actually speaks quotation ${speech.id}. Consider the full scene, pronouns, the active user persona's name and role, who is physically speaking versus listening or addressed, and dialogue on a phone or other channel. Select the user only if the scene supports that identity; choose an uncast person or unclear if appropriate.`,
        criteria,
      }
    }
  }
  return { state: plan.state, questions }
}

/** Only a strong independent review may replace an assistant-message user assignment. */
export function applyAssistantUserSpeakerReview(plan: SpeakerDecisionPlan, answers: Record<string, SpeakerDecisionChoice>, reviewed: Record<string, SpeakerDecisionChoice>): void {
  for (const speech of plan.state.speeches) {
    const result = reviewed[`user_review_${speech.id}`]
    if (!result) continue
    answers[`user_review_${speech.id}`] = result
    const evaluated = evaluateSpeakerDecisionAnswer(result, plan.optionSpeakerIds, { probability: 0.8, confidence: 0.8, margin: 0.25 })
    if (plan.state.messageRole === 'assistant' && evaluated.identity && evaluated.identity !== USER_SPEAKER_ID
      && evaluateSpeakerDecisionAnswer(answers[`speech_${speech.id}`], plan.optionSpeakerIds).identity === USER_SPEAKER_ID) {
      answers[`user_review_original_${speech.id}`] = answers[`speech_${speech.id}`]
      answers[`speech_${speech.id}`] = result
      answers[`user_review_applied_${speech.id}`] = result
    }
  }
}

export interface RelationshipReviewContext {
  previousMessages: Array<{ id: string; text: string; role?: 'user' | 'assistant' }>
  ghosts: Array<{ id: string; label: string; aliases: string[]; context: string; conversationHistory: Array<{ messageId: string; text: string }> }>
}

/** Recheck user-voice assignments made by any stage, with prior conversation. */
export function buildContextualUserReconciliation(plan: SpeakerDecisionPlan, answers: Record<string, SpeakerDecisionChoice>, context: RelationshipReviewContext) {
  const questions: SpeakerDecisionPlan['questions'] = {}
  if (plan.state.messageRole !== 'assistant') return { state: { ...plan.state, previousMessages: context.previousMessages }, questions }
  for (const speech of plan.state.speeches) {
    const current = evaluateSpeakerDecisionAnswer(answers[`speech_${speech.id}`], plan.optionSpeakerIds).identity
    const candidate = evaluateSpeakerDecisionAnswer(answers[`relationship_review_${speech.id}`], plan.optionSpeakerIds).identity
    if (current !== USER_SPEAKER_ID && candidate !== USER_SPEAKER_ID) continue
    questions[`persona_check_${speech.id}`] = {
      type: 'choice',
      instructions: `Is quotation ${speech.id} in the CURRENT assistant message actually spoken by the user persona? Read the complete current exchange and role-labeled previousMessages. Distinguish the author of a previous user message, the addressee, a person echoing a word, a third party, and a remote caller. The user may genuinely speak in an assistant message, but is not the speaker merely because the previous message was written by the user. Choose unclear when the evidence does not establish whether the persona speaks.`,
      criteria: { user: 'The user persona actually speaks this quotation.', other: 'Another person speaks this quotation.', no_clear_identity: 'It is unclear whether the user persona speaks.' },
    }
  }
  return { state: { ...plan.state, previousMessages: context.previousMessages }, questions }
}

/** Preserve a user assignment only after explicit attribution or contextual confirmation. */
export function applyContextualUserReconciliation(plan: SpeakerDecisionPlan, answers: Record<string, SpeakerDecisionChoice>, reviewed: Record<string, SpeakerDecisionChoice>, questions: SpeakerDecisionPlan['questions']): void {
  const speakers = plan.state.speakers.map(speaker => ({ id: speaker.id, name: speaker.name }))
  for (const speech of plan.state.speeches) {
    const key = `persona_check_${speech.id}`
    if (!questions[key]) continue
    const result = reviewed[key]
    answers[`persona_check_${speech.id}`] = result ?? { choice: 'no_clear_identity', probabilities: {}, confidence: 0 }
    const checked = evaluateSpeakerDecisionAnswer(result, { user: USER_SPEAKER_ID, other: 'other' }, { probability: 0.8, confidence: 0.75, margin: 0.25 })
    const explicit = narrativeAttributionSpeaker(`${speech.narrativeBefore} ${speech.narrativeAfter}`, speakers)
    const candidate = answers[`relationship_review_${speech.id}`]
    const candidateIdentity = evaluateSpeakerDecisionAnswer(candidate, plan.optionSpeakerIds).identity
    if ((checked.identity === USER_SPEAKER_ID && (!explicit || explicit === USER_SPEAKER_ID)) || explicit === USER_SPEAKER_ID) {
      const currentIdentity = evaluateSpeakerDecisionAnswer(answers[`speech_${speech.id}`], plan.optionSpeakerIds).identity
      if (currentIdentity !== USER_SPEAKER_ID && candidateIdentity === USER_SPEAKER_ID) {
        answers[`relationship_original_${speech.id}`] = answers[`speech_${speech.id}`]
        answers[`speech_${speech.id}`] = candidate
        answers[`relationship_applied_${speech.id}`] = candidate
        answers[`relationship_global_${speech.id}`] = candidate
        answers[`relationship_continuity_${speech.id}`] = candidate
      }
      answers[`persona_confirmed_${speech.id}`] = result ?? candidate
      delete answers[`global_uncertain_${speech.id}`]
    } else {
      if (evaluateSpeakerDecisionAnswer(answers[`speech_${speech.id}`], plan.optionSpeakerIds).identity === USER_SPEAKER_ID) {
        answers[`persona_original_${speech.id}`] = answers[`speech_${speech.id}`]
        const before = answers[`relationship_original_${speech.id}`]
        const beforeIdentity = evaluateSpeakerDecisionAnswer(before, plan.optionSpeakerIds).identity
        answers[`speech_${speech.id}`] = before && beforeIdentity !== USER_SPEAKER_ID ? before : { choice: 'no_clear_identity', probabilities: {}, confidence: 0 }
        delete answers[`relationship_confirmed_${speech.id}`]
        delete answers[`relationship_applied_${speech.id}`]
        delete answers[`relationship_global_${speech.id}`]
        delete answers[`relationship_continuity_${speech.id}`]
      }
      answers[`global_uncertain_${speech.id}`] = result ?? { choice: 'no_clear_identity', probabilities: {}, confidence: 0 }
    }
  }
}

/** Resolve a historically safe ghost to a unique named roster entry, if any. */
export function continuityRosterIdentity(id: string | null, context: RelationshipReviewContext, speakers: CharacterLike[]): string | null {
  if (!id?.startsWith('ghost:')) return id
  const ghost = context.ghosts.find(item => `ghost:${item.id}` === id)
  if (!ghost) return id
  const aliases = new Set(ghost.aliases.map(alias => alias.toLowerCase()))
  const matches = speakers.filter(speaker => speaker.id !== USER_SPEAKER_ID && speakerAliases(speaker.name).some(alias => aliases.has(alias.toLowerCase())))
  return matches.length === 1 ? matches[0].id : id
}

/** A continuity record is valid only for the unchanged, immediately preceding assistant message. */
export function previousContinuitySpeaker(messages: Array<{ id: string; is_user: boolean; content?: string }>, targetId: string, records: unknown): string | null {
  const index = messages.findIndex(message => message.id === targetId)
  if (index < 0 || !records || typeof records !== 'object' || Array.isArray(records)) return null
  const prior = messages.slice(0, index).filter(message => !message.is_user).at(-1)
  if (!prior) return null
  const record = (records as Record<string, unknown>)[prior.id]
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null
  const value = record as Record<string, unknown>
  return value.contentHash === hashMessageContent(prior.content ?? '') && typeof value.speakerId === 'string' && value.speakerId ? value.speakerId : null
}

/** Recover pre-continuity records only when cached speech and a ghost occurrence agree. */
export function recoverPreviousGhostContinuity(messages: Array<{ id: string; is_user: boolean; content?: string }>, targetId: string, parsed: Record<string, CachedMessageParse>, ghosts: GhostVoice[], skippedTags = ''): string | null {
  const index = messages.findIndex(message => message.id === targetId)
  if (index < 0) return null
  const prior = messages.slice(0, index).filter(message => !message.is_user).at(-1)
  if (!prior) return null
  const segments = parsed[prior.id]?.segments
  const expected = buildSpeakerDecisionPlan(prior.content ?? '', [], false, skippedTags).state.speeches
  if (!expected.length || expected.length > 64) return null
  // Occurrences encode the exact spoken text; require one ghost to cover every
  // quote so a mixed-speaker message cannot create a false continuation.
  const recovered = ghosts.filter(ghost => {
    const reachable = new Set([0])
    for (let start = 0; start < expected.length; start++) {
      if (!reachable.has(start)) continue
      for (let end = start + 1; end <= expected.length; end++) {
        const hash = hashMessageContent(expected.slice(start, end).map(speech => speech.text).join('\n'))
        if (ghost.occurrenceKeys.includes(`${prior.id}:${hash}`)) reachable.add(end)
      }
    }
    return reachable.has(expected.length)
  })
  if (recovered.length === 1) return `ghost:${recovered[0].id}`
  if (recovered.length > 1 || !segments) return null
  const speeches = segments.filter(segment => segment.speakerId !== null)
  if (!speeches.length || speeches.length !== expected.length || speeches.some((segment, i) => segment.text.trim() !== expected[i].text.trim())) return null
  const groups = collectUncastVoiceGroups(segments)
  if (groups.reduce((sum, group) => sum + group.speeches.length, 0) !== speeches.length) return null
  const matches = groups.map(group => ghosts.filter(ghost => ghost.occurrenceKeys.includes(`${prior.id}:${hashMessageContent(group.speeches.join('\n'))}`)))
  if (matches.some(items => items.length !== 1)) return null
  const ids = new Set(matches.map(items => items[0].id))
  return ids.size === 1 ? `ghost:${matches[0][0].id}` : null
}

/** Bootstrap continuity from an unambiguous named subject in the prior turn. */
export function previousNamedGhostContinuity(messages: Array<{ id: string; is_user: boolean; content?: string }>, targetId: string, ghosts: GhostVoice[], configured: CharacterLike[], skippedTags = ''): string | null {
  const index = messages.findIndex(message => message.id === targetId)
  if (index < 0) return null
  const prior = messages.slice(0, index).filter(message => !message.is_user).at(-1)
  if (!prior || !buildSpeakerDecisionPlan(prior.content ?? '', [], false, skippedTags).state.speeches.length) return null
  const candidates = ghosts.flatMap(ghost => {
    const names = ghostCastAliases(ghost).filter(alias => !isDescriptiveGhostLabel(alias))
    return names.length ? [{ id: `ghost:${ghost.id}`, name: names.join(' / ') }] : []
  })
  const active = candidates.filter(candidate => hasNamedSpeakerSubject(prior.content ?? '', [candidate], skippedTags))
  if (active.length !== 1) return null
  const otherCast = configured.filter(speaker => speaker.id !== USER_SPEAKER_ID)
  const priorNarration = narrativeOnly(preparePlaybackContent(prior.content ?? '', skippedTags))
  if (hasSpeakerMentions(mentionedSpeakers(priorNarration, otherCast))) return null
  return active[0].id
}

export const CONTINUITY_LOOKBACK_BLOCKED = '__chat_voice_continuity_blocked__'
export const DEFAULT_SPEAKER_LOOKBACK = 6
export const MAX_SPEAKER_LOOKBACK = 100

/** Look back through assistant turns, stopping at clear or conflicting evidence. */
export function lookbackSpeakerContinuity(messages: Array<{ id: string; is_user: boolean; content?: string }>, targetId: string, records: unknown, parsed: Record<string, CachedMessageParse>, ghosts: GhostVoice[], configured: CharacterLike[], skippedTags = '', limit = DEFAULT_SPEAKER_LOOKBACK, diagnostics?: string[]): string | null {
  const index = messages.findIndex(message => message.id === targetId)
  if (index < 0) return null
  const target = messages[index]
  const count = Number.isFinite(limit) ? Math.max(1, Math.min(MAX_SPEAKER_LOOKBACK, Math.round(limit))) : DEFAULT_SPEAKER_LOOKBACK
  const preceding = messages.slice(0, index).filter(message => !message.is_user).slice(-count).reverse()
  for (const prior of preceding) {
    if (!buildSpeakerDecisionPlan(prior.content ?? '', [], false, skippedTags).state.speeches.length) continue
    const view = [prior, target]
    // Names introduced after this turn must not leak into earlier replays.
    const priorIndex = messages.findIndex(message => message.id === prior.id)
    const availableGhosts = ghosts.filter(ghost => {
      const lastSeen = messages.findIndex(message => message.id === ghost.lastSeenMessageId)
      const earlierOccurrence = ghost.occurrenceKeys.some(key => {
        const occurrenceIndex = messages.findIndex(message => message.id === key.split(':', 1)[0])
        return occurrenceIndex >= 0 && occurrenceIndex <= priorIndex
      })
      const earlierHistory = ghost.conversationHistory?.some(entry => {
        const historyIndex = messages.findIndex(message => message.id === entry.messageId)
        return historyIndex >= 0 && historyIndex <= priorIndex
      }) ?? false
      const eligible = (lastSeen >= 0 && lastSeen <= priorIndex) || earlierOccurrence || earlierHistory
      diagnostics?.push(`${prior.id}/${ghost.id}: ${eligible ? 'eligible' : 'excluded'} (lastSeen=${ghost.lastSeenMessageId || 'none'}, earlierOccurrence=${earlierOccurrence}, earlierHistory=${earlierHistory})`)
      return eligible
    })
    const cast = configured.filter(speaker => speaker.id !== USER_SPEAKER_ID)
    const record = previousContinuitySpeaker(view, targetId, records)
    if (record) { diagnostics?.push(`${prior.id}: saved continuity -> ${record}`); return record }
    const priorPlan = buildSpeakerDecisionPlan(prior.content ?? '', [], false, skippedTags)
    const lastSpeech = priorPlan.state.speeches.at(-1)
    const ghostSpeakers = availableGhosts.flatMap(ghost => {
      const aliases = ghostCastAliases(ghost).filter(alias => !isDescriptiveGhostLabel(alias))
      const overlapsCast = aliases.some(alias => cast.some(speaker => speakerAliases(speaker.name).some(name => name.toLowerCase() === alias.toLowerCase())))
      return aliases.length && !overlapsCast ? [{ id: `ghost:${ghost.id}`, name: aliases.join(' / ') }] : []
    })
    if (lastSpeech) {
      const candidates = [...cast, ...ghostSpeakers]
      const context = `${lastSpeech.narrativeBefore} ${lastSpeech.narrativeAfter}`
      const namedCandidates = candidates.filter(candidate => speakerAliases(candidate.name).some(alias => new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'iu').test(context)))
      const attributed = namedCandidates.length === 1 ? narrativeAttributionSpeaker(context, candidates) : null
      if (attributed) { diagnostics?.push(`${prior.id}: final speech attribution -> ${attributed}`); return attributed }
    }
    // Walk the closing run backwards: an earlier interruption should not
    // obscure a named speaker who subsequently resumes the conversation.
    const priorContent = preparePlaybackContent(prior.content ?? '', skippedTags)
    const lastQuote = playbackQuotes(priorContent).at(-1)
    const candidates = [...cast, ...ghostSpeakers]
    if (lastQuote) {
      const paragraphs = playbackParagraphs(priorContent.slice(0, lastQuote.end))
      for (let i = paragraphs.length - 1; i >= 0; i--) {
        const narration = narrativeOnly(paragraphs[i].text)
        const mentions = mentionedSpeakers(narration, candidates)
        const subject = unambiguousNarrativeSpeaker(narration, candidates)
        if (subject) {
          diagnostics?.push(`${prior.id}: closing named subject -> ${subject}`)
          return subject
        }
        if (hasAnonymousSpeechAttribution(narration)) {
          diagnostics?.push(`${prior.id}: closing anonymous speaker blocks continuity`)
          return CONTINUITY_LOOKBACK_BLOCKED
        }
        if (mentions.clean.size > 1) break
      }
    }
    const named = previousNamedGhostContinuity(view, targetId, availableGhosts, cast, skippedTags)
    if (named) { diagnostics?.push(`${prior.id}: named subject -> ${named}`); return named }
    const matchedCast = cast.filter(speaker => hasNamedSpeakerSubject(prior.content ?? '', [speaker], skippedTags))
    const matchedGhosts = availableGhosts.filter(ghost => ghostCastAliases(ghost).some(alias => !isDescriptiveGhostLabel(alias) && hasNamedSpeakerSubject(prior.content ?? '', [{ id: `ghost:${ghost.id}`, name: alias }], skippedTags)))
    if (matchedCast.length + matchedGhosts.length > 1) { diagnostics?.push(`${prior.id}: conflicting named subjects`); return CONTINUITY_LOOKBACK_BLOCKED }
    if (matchedCast.length === 1) { diagnostics?.push(`${prior.id}: named cast subject -> ${matchedCast[0].id}`); return matchedCast[0].id }
    if (matchedGhosts.length === 1) {
      if (hasSpeakerMentions(mentionedSpeakers(narrativeOnly(preparePlaybackContent(prior.content ?? '', skippedTags)), cast))) { diagnostics?.push(`${prior.id}: named cast conflict`); return CONTINUITY_LOOKBACK_BLOCKED }
      const id = `ghost:${matchedGhosts[0].id}`
      diagnostics?.push(`${prior.id}: named temporary subject -> ${id}`)
      return id
    }
    const recovered = recoverPreviousGhostContinuity(view, targetId, parsed, availableGhosts, skippedTags)
    if (recovered) { diagnostics?.push(`${prior.id}: recorded speech -> ${recovered}`); return recovered }
    const rawRecord = records && typeof records === 'object' && !Array.isArray(records) ? (records as Record<string, unknown>)[prior.id] : null
    if (rawRecord && typeof rawRecord === 'object' && (rawRecord as Record<string, unknown>).contentHash === hashMessageContent(prior.content ?? '') && (rawRecord as Record<string, unknown>).speakerId === null) { diagnostics?.push(`${prior.id}: saved ambiguous or mixed speaker`); return CONTINUITY_LOOKBACK_BLOCKED }
    const discovered = addUnconfiguredDialogueSpeakers(prior.content ?? '', configured, skippedTags)
      .filter(speaker => speaker.id.startsWith('unconfigured:') && !/^(?:what|who|where|when|why|how)$/iu.test(speaker.name))
    if (discovered.some(speaker => hasNamedSpeakerSubject(prior.content ?? '', [speaker], skippedTags)) || hasAnonymousSpeechAttribution(preparePlaybackContent(prior.content ?? '', skippedTags))) { diagnostics?.push(`${prior.id}: another unconfigured speaker`); return CONTINUITY_LOOKBACK_BLOCKED }
    diagnostics?.push(`${prior.id}: no clear speaker`)
  }
  return null
}

/** Prepare only earlier, tracker-free context, including when replaying old messages. */
export function relationshipReviewContext(messages: Array<{ id: string; is_user: boolean; content?: string }>, targetId: string, ghosts: GhostVoice[], skippedTags = '', limit = DEFAULT_SPEAKER_LOOKBACK): RelationshipReviewContext {
  const target = messages.findIndex(message => message.id === targetId)
  if (target < 0) return { previousMessages: [], ghosts: [] }
  const prior = messages.slice(0, target)
  const priorIds = new Set(prior.map(message => message.id))
  const count = Number.isFinite(limit) ? Math.max(1, Math.min(MAX_SPEAKER_LOOKBACK, Math.round(limit))) : DEFAULT_SPEAKER_LOOKBACK
  let remaining = 24_000
  const previousMessages = prior.slice(-count).reverse().flatMap(message => {
    if (remaining <= 0) return []
    const text = preparePlaybackContent(message.content ?? '', skippedTags).slice(-Math.min(4_000, remaining))
    remaining -= text.length
    return text ? [{ id: message.id, role: message.is_user ? 'user' as const : 'assistant' as const, text }] : []
  }).reverse()
  let ghostBudget = 12_000
  const takeGhostText = (text: string, limit: number): string => {
    if (ghostBudget <= 0) return ''
    const selected = preparePlaybackContent(text, skippedTags).slice(-Math.min(limit, ghostBudget))
    ghostBudget -= selected.length
    return selected
  }
  // Spend the shared budget on the most recently invoked eligible characters
  // first, but restore the original order so ghost_N decisions remain stable.
  const candidates = ghosts.slice(0, 20).map((ghost, index) => {
    const lastIndex = messages.findIndex(message => message.id === ghost.lastSeenMessageId)
    const safeCurrent = lastIndex >= 0 && lastIndex <= target
    const historical = (ghost.conversationHistory ?? []).filter(entry => priorIds.has(entry.messageId))
    const recent = Math.max(safeCurrent && lastIndex < target ? lastIndex : -1, ...historical.map(entry => prior.findIndex(message => message.id === entry.messageId)))
    return { ghost, index, safeCurrent, historical, recent }
  }).filter(item => item.safeCurrent || item.historical.length).sort((a, b) => b.recent - a.recent || a.index - b.index)
  const safeGhosts = candidates.map(({ ghost, index, safeCurrent, historical }) => {
    const context = safeCurrent ? takeGhostText(ghost.context, 1_200) : ''
    const conversationHistory = historical.slice(-3).reverse().map(entry => ({ messageId: entry.messageId, text: takeGhostText(entry.text, 1_200) })).filter(entry => entry.text).reverse()
    return { index, value: { id: ghost.id, label: safeCurrent ? ghost.label ?? '' : '', aliases: safeCurrent ? ghostCastAliases(ghost) : [], context, conversationHistory } }
  }).sort((a, b) => a.index - b.index).map(item => item.value)
  return { previousMessages, ghosts: safeGhosts }
}

/** Run relationship review only where local identity or an off-scene exchange needs context. */
export function independentlyGroundedSpeakerIds(plan: SpeakerDecisionPlan, context: RelationshipReviewContext, cardSpeakerId: string | null = null): Set<string> {
  const text = `${plan.state.message}\n${context.previousMessages.map(item => item.text).join('\n')}`
  const mentioned = (value: string) => {
    const alias = value.trim()
    return alias.length >= 2 && new RegExp(`(^|[^\\p{L}\\p{N}])${escapedPattern(alias)}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(text)
  }
  const ids = new Set<string>([USER_SPEAKER_ID, UNCAST_SPEAKER_ID])
  if (cardSpeakerId) ids.add(cardSpeakerId)
  for (const speaker of plan.state.speakers) if (speaker.aliases.some(mentioned)) ids.add(speaker.id)
  const previousIds = new Set(context.previousMessages.map(item => item.id))
  for (const ghost of context.ghosts) if ([ghost.label, ...ghost.aliases].some(mentioned) || ghost.conversationHistory.some(item => previousIds.has(item.messageId))) ids.add(`ghost:${ghost.id}`)
  return ids
}

/** Prevent ungrounded first-pass cast choices from anchoring later reviews. */
export function suppressUngroundedSpeakerChoices(plan: SpeakerDecisionPlan, answers: Record<string, SpeakerDecisionChoice>, context: RelationshipReviewContext, cardSpeakerId: string | null = null): void {
  if (plan.state.messageRole !== 'assistant') return
  const grounded = independentlyGroundedSpeakerIds(plan, context, cardSpeakerId)
  for (const speech of plan.state.speeches) {
    const key = `speech_${speech.id}`
    const answer = answers[key]
    const identity = answer && plan.optionSpeakerIds[answer.choice]
    if (!identity || grounded.has(identity)) continue
    answers[`ungrounded_original_${speech.id}`] = answer
    answers[key] = { choice: 'no_clear_identity', probabilities: { no_clear_identity: 1 }, confidence: 1 }
    answers[`global_uncertain_${speech.id}`] = answer
  }
  for (const paragraph of plan.state.paragraphs) {
    const key = `paragraph_${paragraph.id}`
    const answer = answers[key]
    const identity = answer && plan.optionSpeakerIds[answer.choice]
    if (identity && !grounded.has(identity)) answers[key] = { choice: 'no_clear_identity', probabilities: { no_clear_identity: 1 }, confidence: 1 }
  }
}

export function buildRelationshipSpeakerReview(plan: SpeakerDecisionPlan, answers: Record<string, SpeakerDecisionChoice>, context: RelationshipReviewContext, continuitySpeakerId: string | null = null, globalOptions?: { cardSpeakerId: string | null; targets: string[]; strategy?: 'scene' | 'run' }) {
  const questions: SpeakerDecisionPlan['questions'] = {}
  const ghostOptions: Record<string, string> = {}
  const sceneReferences: Array<{ speechId: string; narration: string; quotation: string }> = []
  const speakers = plan.state.speakers.map(speaker => ({ id: speaker.id, name: speaker.name }))
  const criteria = speakerDecisionCriteria(plan.state.speakers.slice(0, 220))
  const grounded = globalOptions ? independentlyGroundedSpeakerIds(plan, context, globalOptions.cardSpeakerId) : null
  if (grounded) for (const speaker of plan.state.speakers) if (!grounded.has(speaker.id)) delete criteria[speaker.option]
  const remaining = Math.max(0, 255 - Object.keys(criteria).length)
  const castAliases = new Set(plan.state.speakers.filter(speaker => speaker.id !== USER_SPEAKER_ID).flatMap(speaker => speaker.aliases.map(alias => alias.toLowerCase())))
  context.ghosts.filter(ghost => (!grounded || grounded.has(`ghost:${ghost.id}`)) && !ghost.aliases.some(alias => castAliases.has(alias.toLowerCase())))
    .slice(0, Math.min(20, remaining)).forEach((ghost, index) => {
    const option = `relationship_ghost_${index}`
    ghostOptions[option] = `ghost:${ghost.id}`
    criteria[option] = `Previously heard temporary character ${ghost.label || ghost.aliases.join(' / ') || `ghost ${index + 1}`}; use the supplied prior conversation, not the label alone.`
  })
  const phoneExchange = /\b(?:phone|telephone|caller|call|earpiece|voicemail|speakerphone)\b/iu.test(plan.state.message)
  const previousExchange = context.previousMessages.at(-1)
  const openingRun = plan.state.runs.find(run => run.speechIds.includes('s0'))
  const openingTargets = new Set(globalOptions && previousExchange && openingRun ? openingRun.speechIds : [])
  if (context.previousMessages.length || context.ghosts.length) {
    for (const speech of plan.state.speeches) {
      const local = evaluateSpeakerDecisionAnswer(answers[`speech_${speech.id}`], plan.optionSpeakerIds)
      const paragraph = evaluateSpeakerDecisionAnswer(answers[`paragraph_${speech.paragraphId}`], plan.optionSpeakerIds)
      const attribution = narrativeAttributionSpeaker(`${speech.narrativeBefore} ${speech.narrativeAfter}`, speakers)
      if (attribution && local.identity === attribution) continue
      const conflict = !!local.identity && !!paragraph.identity && local.identity !== paragraph.identity
      if (local.identity && local.identity !== UNCAST_SPEAKER_ID && !conflict && !phoneExchange && !globalOptions?.targets.includes(speech.id) && !openingTargets.has(speech.id)) continue
      questions[`relationship_${speech.id}`] = {
        type: 'choice',
        instructions: `Who actually speaks quotation ${speech.id}? Read its entire dialogue run together, including later quotations and narration in the current message. Compare the topic and wording with the preceding role-labeled exchange, including user messages: identify who spoke, whom they addressed, and whether this quote responds or continues. For an opening reply, consider the recipient of the preceding relevant utterance as a candidate, and trace distinctive objects, actions and pronouns into the current scene. A user message may contain several utterances or descriptions: identify the relevant exchange, not just its last name or the message author. Weigh semantic continuity and the whole run, but do not assume the addressee responds or that all quotes share a speaker. Connect people across messages using names, aliases, actions, pronouns and carried objects. A person who merely observes, is addressed, or passes by is not automatically speaking. Distinguish in-person dialogue from a caller or text sender. Pronouns are evidence, not proof of gender or identity. Prefer explicit attribution and select no_clear_identity when evidence is insufficient.`,
        criteria,
      }
      if (globalOptions && globalOptions.strategy !== 'run') {
        const paragraphIndex = plan.state.paragraphs.findIndex(paragraph => paragraph.id === speech.paragraphId)
        const narration = plan.state.paragraphs.slice(Math.max(0, paragraphIndex - 1), paragraphIndex + 2)
          .map(paragraph => cleanPlaybackText(narrativeOnly(paragraph.text)))
          .filter(Boolean).join('\n').slice(0, 2_000)
        if (narration) {
          sceneReferences.push({ speechId: speech.id, narration, quotation: speech.text })
          questions[`scene_reference_${speech.id}`] = {
            type: 'choice',
            instructions: `In sceneReferences for ${speech.id}, identify the person whose actions or pronouns are the immediate focus of the supplied narration. Use previousMessages to resolve references such as who carried an object. This asks who acts in narration, not who speaks; the actor may instead be an addressee or a bystander. If several people could be the focus or the identity is unclear, select no_clear_identity.`,
            criteria,
          }
          questions[`scene_secondary_${speech.id}`] = {
            type: 'choice',
            instructions: `In sceneReferences for ${speech.id}, is another distinct person explicitly acting in the supplied narration, such as an addressee or bystander? Identify that other person, not the focal actor; if no other person has a clear known identity, choose no_clear_identity. Do not assume that person is speaking.`,
            criteria,
          }
          questions[`scene_link_${speech.id}`] = {
            type: 'choice',
            instructions: `In sceneReferences for ${speech.id}, does the person who is the immediate focus of the supplied narration actually speak this quotation? Compare dialogue, actions, pronouns, preceding user and assistant messages, turn changes and channels. A person mentioned, addressed, or passing by is not automatically speaking. Only choose same_speaker when the connection is clear; otherwise choose different_person or unclear.`,
            criteria: { same_speaker: 'The focal narrative actor is the person speaking this quotation.', different_person: 'The focal narrative actor is another person, such as an addressee or bystander.', no_clear_identity: 'The relationship between the actor and speaker is uncertain.' },
          }
        }
      }
      if (Object.keys(questions).filter(id => id.startsWith('relationship_s')).length >= 32) break
    }
  }
  if (globalOptions && previousExchange && openingRun && openingRun.speechIds.length && Object.keys(questions).length < MAX_DECISION_QUESTIONS - 2) {
    questions.boundary_relation = {
      type: 'choice',
      instructions: 'Compare the first quotation in the target message with the relevant preceding exchange in previousMessages, including a user message if present. Is it a continuation by the same speaker, a response by a different participant, a third-party interjection, an unrelated/new scene, or unclear? Identify the preceding actual speaker and addressee from the text; do not assume the message author speaks every quotation.',
      criteria: { continuation: 'The same person continues speaking.', response: 'A different participant responds to the preceding exchange.', interjection: 'Another person interjects in the exchange.', new_exchange: 'The quotation starts an unrelated exchange or scene.', no_clear_identity: 'The relationship is unclear.' },
    }
    questions.boundary_addressee = {
      type: 'choice',
      instructions: 'Who is addressed in the relevant preceding exchange immediately before the target opening dialogue? Use names, aliases, actions and role-labeled prior messages; do not equate the author or a bystander with the addressee. Choose no_clear_identity if uncertain.',
      criteria,
    }
  }
  const reviewedRuns = globalOptions ? plan.state.runs.filter(run => run.speechIds.some(id => !!questions[`relationship_${id}`])) : []
  for (const run of reviewedRuns) {
    if (Object.keys(questions).length > MAX_DECISION_QUESTIONS - 2) break
    questions[`run_channel_${run.id}`] = {
      type: 'choice',
      instructions: `What communication channel is used for the selected dialogue run ${run.id}? Consider the complete current message and preceding exchanges. If the run contains multiple channels or the channel is uncertain, select no_clear_identity.`,
      criteria: { in_person: 'People speak in the same physical scene.', phone: 'A telephone or voice call.', text_message: 'Written messages on a phone or another device.', no_clear_identity: 'Mixed, different, or unclear channel.' },
    }
    questions[`run_participant_${run.id}`] = {
      type: 'choice',
      instructions: `Which person is most clearly established as an active participant in dialogue run ${run.id}? Compare the full exchange and role-labeled prior messages. An actor, addressee, or bystander is not necessarily speaking; if there is no single clearly established participant, choose no_clear_identity. This does not assign any quotation.`,
      criteria,
    }
  }
  const continuityOption = continuitySpeakerId ? plan.state.speakers.find(speaker => speaker.id === continuitySpeakerId)?.option : undefined
  if (!globalOptions && plan.state.messageRole === 'assistant' && (plan.state.speeches.length > 1 || (plan.state.speeches.length === 1 && continuitySpeakerId)) && (Object.keys(ghostOptions).length || continuityOption) && (Object.keys(questions).length || continuitySpeakerId)) {
    questions.relationship_scene = {
      type: 'choice',
      instructions: `Does one previously heard temporary character clearly speak every quotation in this message? Compare the entire scene and preceding conversation; distinguish scene changes, different speakers and people addressed. ${continuitySpeakerId ? `The immediately preceding assistant message ended with ${continuitySpeakerId}; treat this as a continuity clue, not proof.` : ''} Select no_clear_identity if any quotation may belong to another speaker or the continuity is uncertain.`,
      criteria: { no_clear_identity: 'The scene has multiple speakers or the identity is uncertain.', ...Object.fromEntries([...Object.keys(ghostOptions), ...(continuityOption ? [continuityOption] : [])].map(option => [option, criteria[option]])) },
    }
  }
  return { state: { ...plan.state, previousMessages: context.previousMessages, ghosts: context.ghosts, ...(globalOptions ? { sceneReferences, reviewedRuns, boundaryExchange: previousExchange ? { messageId: previousExchange.id, role: previousExchange.role ?? 'assistant', text: previousExchange.text, openingRunId: openingRun?.id ?? null, speechIds: openingRun?.speechIds ?? [] } : null, cardSpeakerPrior: globalOptions.cardSpeakerId, contextPolicy: 'Earlier messages are evidence, not automatic speaker assignments. A single-character card is a weak preference only. Distinguish user and assistant roles. Never assume a person is speaking merely because they spoke last.' } : {}) }, questions, ghostOptions }
}

/** Reject malformed or incomplete review results before they can enter the cache. */
export function invalidSpeakerReviewAnswers(questions: SpeakerDecisionPlan['questions'], answers: Record<string, SpeakerDecisionChoice>): string[] {
  return Object.entries(questions).flatMap(([id, question]) => {
    const answer = answers[id]
    const probabilities = answer?.probabilities
    if (!answer || typeof answer.choice !== 'string' || !Object.hasOwn(question.criteria, answer.choice)
      || !probabilities || typeof probabilities !== 'object' || Array.isArray(probabilities)
      || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1
      || !Object.hasOwn(probabilities, answer.choice)
      || Object.entries(probabilities).some(([key, value]) => !Object.hasOwn(question.criteria, key) || !Number.isFinite(value) || value < 0 || value > 1)) return [id]
    return []
  })
}

/** A best-available guess is a last resort, so assigning a known cast voice to
 * an unnamed exchange requires stronger evidence than an ordinary first-pass
 * answer. Weak guesses are left for the uncast pool, where recurring ghosts
 * can still reuse their established voices. */
export const BEST_AVAILABLE_KNOWN_CAST_MIN_PROBABILITY = 0.65
export const BEST_AVAILABLE_KNOWN_CAST_MIN_CONFIDENCE = 0.55
export const BEST_AVAILABLE_KNOWN_CAST_MIN_MARGIN = 0.15

/** A last-resort, scene-bounded guess. Results are never used as anchors. */
export function buildBestAvailableSpeakerReview(plan: SpeakerDecisionPlan, answers: Record<string, SpeakerDecisionChoice>, context: RelationshipReviewContext, cardSpeakerId: string | null = null) {
  const grounded = independentlyGroundedSpeakerIds(plan, context, cardSpeakerId)
  const knownCriteria = speakerDecisionCriteria(plan.state.speakers.slice(0, 220))
  const options: Record<string, string> = {}
  const criteria: Record<string, string> = {}
  for (const speaker of plan.state.speakers) {
    // User messages share the assistant pipeline: the user persona is a
    // normal candidate there (assistant messages only admit it once the
    // persona check confirms it).
    if (speaker.id === USER_SPEAKER_ID && plan.state.messageRole !== 'user') continue
    if (!grounded.has(speaker.id)) continue
    options[speaker.option] = speaker.id
    criteria[speaker.option] = knownCriteria[speaker.option]
  }
  for (const [index, ghost] of context.ghosts.slice(0, 20).entries()) {
    if (!grounded.has(`ghost:${ghost.id}`)) continue
    const option = `best_ghost_${index}`
    options[option] = `ghost:${ghost.id}`
    criteria[option] = `Temporary character ${ghost.label || ghost.aliases.join(' / ')}; use context, not name alone.`
  }
  criteria.uncast_character = 'A distinct unnamed or uncast person is the most plausible speaker.'
  criteria.no_clear_identity = 'No plausible speaker can be selected from the evidence.'
  options.uncast_character = UNCAST_SPEAKER_ID
  const questions: SpeakerDecisionPlan['questions'] = {}
  for (const speech of plan.state.speeches) {
    if (!answers[`global_uncertain_${speech.id}`]) continue
    const speechCriteria = { ...criteria }
    if (answers[`persona_confirmed_${speech.id}`]) {
      const user = plan.state.speakers.find(speaker => speaker.id === USER_SPEAKER_ID)
      if (user) { speechCriteria[user.option] = knownCriteria[user.option]; options[user.option] = USER_SPEAKER_ID }
    }
    questions[`best_guess_${speech.id}`] = { type: 'choice', criteria: speechCriteria, instructions: `For quotation ${speech.id}, select the most plausible actual speaker among the candidates, using the current scene and role-labeled previous messages, including user messages. Consider dialogue content, who addresses whom, pronouns, narrative actions, later attribution, scene and channel changes. A mentioned bystander or the author of a previous message is not automatically speaking. If evidence points to a different unnamed person choose uncast_character. If no candidate is plausible choose no_clear_identity. This is an explicitly uncertain best guess, not a validated identity.` }
    if (Object.keys(questions).length >= 32) break
  }
  return { state: { ...plan.state, previousMessages: context.previousMessages, ghosts: context.ghosts }, questions, options }
}

export function applyBestAvailableSpeakerReview(plan: SpeakerDecisionPlan, answers: Record<string, SpeakerDecisionChoice>, review: ReturnType<typeof buildBestAvailableSpeakerReview>, results: Record<string, SpeakerDecisionChoice>): void {
  for (const [id, question] of Object.entries(review.questions)) {
    const answer = results[id]
    if (invalidSpeakerReviewAnswers({ [id]: question }, { [id]: answer }).length || !Object.hasOwn(review.options, answer.choice)) continue
    const speechId = id.slice('best_guess_'.length)
    if (!answers[`global_uncertain_${speechId}`]) continue
    const identity = review.options[answer.choice]
    const isTemporaryGhost = identity?.startsWith('ghost:')
    const isKnownSpeaker = !isTemporaryGhost && identity !== UNCAST_SPEAKER_ID && identity !== 'no_clear_identity'
    if (isKnownSpeaker) {
      const probability = answer.probabilities[answer.choice] ?? 0
      const runnerUp = Math.max(0, ...Object.entries(answer.probabilities).filter(([choice]) => choice !== answer.choice).map(([, value]) => value))
      const uncastOption = Object.entries(review.options).find(([, optionIdentity]) => optionIdentity === UNCAST_SPEAKER_ID)?.[0]
      if (probability < BEST_AVAILABLE_KNOWN_CAST_MIN_PROBABILITY || answer.confidence < BEST_AVAILABLE_KNOWN_CAST_MIN_CONFIDENCE || probability - runnerUp < BEST_AVAILABLE_KNOWN_CAST_MIN_MARGIN) {
        // A weakly grounded known-cast guess must not steal an unnamed role.
        // Leave the quote in the uncast pool so the same speaker can keep a
        // ghost/voice across consecutive scenes without inventing a new one.
        if (uncastOption) {
          plan.optionSpeakerIds[uncastOption] = UNCAST_SPEAKER_ID
          answers[id] = { choice: uncastOption, probabilities: { [uncastOption]: 1 }, confidence: 1 }
        }
        continue
      }
    }
    if (answer.confidence < 0.2 || (answer.probabilities[answer.choice] ?? 0) < 0.25) continue
    plan.optionSpeakerIds[answer.choice] = identity
    answers[id] = answer
  }
}

/** Re-read possible self-introductions and their links without assuming a name is the speaker. */
export function buildSelfIntroductionReview(plan: SpeakerDecisionPlan, context: RelationshipReviewContext) {
  const questions: SpeakerDecisionPlan['questions'] = {}
  const candidates: Record<string, { name: string; anchorId: string; targetIds: string[] }> = {}
  const quotes = playbackQuotes(plan.state.message)
  for (const [index, speech] of plan.state.speeches.entries()) {
    const direct = speech.text.match(/\bI(?:'|\u2019)m\s+([\p{Lu}][\p{L}\p{M}'\u2019-]{2,30})\b/u)?.[1]
    const bare = speech.text.match(/^\s*([\p{Lu}][\p{Ll}\p{M}'\u2019-]{2,30})[.!?]\s+\S/u)?.[1]
    const name = direct ?? bare
    if (!name || NON_NAME_PARAGRAPH_LEADS.has(name.toLowerCase())) continue
    const anchorQuote = quotes[index]
    if (!anchorQuote) continue
    const targetIds: string[] = []
    for (let i = index - 1; i >= 0 && targetIds.length < 12; i -= 1) {
      const quote = quotes[i]
      if (!quote) break
      const between = plan.state.message.slice(quote.end, anchorQuote.start)
      if (SPEAKER_HARD_BOUNDARY_PATTERNS.some(boundary => boundary.pattern.test(narrativeOnly(between)))) break
      targetIds.unshift(plan.state.speeches[i].id)
    }
    if (!targetIds.length) continue
    const key = `intro_${speech.id}`
    candidates[key] = { name, anchorId: speech.id, targetIds }
    questions[key] = { type: 'choice', instructions: `In the CURRENT message, does the actual speaker of ${speech.id} explicitly identify themselves as ${name}? A name could instead identify an addressee, someone else, or be an ordinary word; select unclear when not established. Read the entire exchange.`, criteria: { self: 'The speaker explicitly gives this as their own name.', other_or_unclear: 'The name refers to someone else, is not a name, or the evidence is unclear.' } }
    for (const targetId of targetIds) questions[`intro_link_${speech.id}_${targetId}`] = { type: 'choice', instructions: `Compare the actual speaker of ${targetId} with the speaker of ${speech.id} in the CURRENT message. Read the full intervening dialogue and narration and the preceding exchange, including user messages. A bystander, person addressed, or person merely acting need not be speaking. Consider interruptions, new speakers, pronouns, scene and channel changes, and later identification. Select same only if the same actual person clearly speaks both; otherwise choose different_or_unclear.`, criteria: { same: 'The same person actually speaks both quotations.', different_or_unclear: 'Different speakers or insufficient evidence.' } }
    if (Object.keys(candidates).length >= 2) break
  }
  return { state: { ...plan.state, previousMessages: context.previousMessages }, questions, candidates }
}

export function applySelfIntroductionReview(plan: SpeakerDecisionPlan, answers: Record<string, SpeakerDecisionChoice>, review: ReturnType<typeof buildSelfIntroductionReview>, results: Record<string, SpeakerDecisionChoice>): void {
  const speakers = plan.state.speakers.map(speaker => ({ id: speaker.id, name: speaker.name }))
  for (const [key, candidate] of Object.entries(review.candidates)) {
    const intro = evaluateSpeakerDecisionAnswer(results[key], { self: 'self', other_or_unclear: 'other_or_unclear' }, { probability: 0.9, confidence: 0.8, margin: 0.5 })
    if (intro.identity !== 'self') continue
    const matching = plan.state.speakers.filter(speaker => speaker.id !== USER_SPEAKER_ID && speaker.aliases.some(alias => alias.toLocaleLowerCase() === candidate.name.toLocaleLowerCase()))
    if (matching.length > 1) continue
    const identity = matching[0]?.id ?? unconfiguredSpeakerId(candidate.name)
    const option = matching[0]?.option ?? `self_intro_${candidate.anchorId}`
    plan.optionSpeakerIds[option] = identity
    const targets = [...candidate.targetIds.filter(id => evaluateSpeakerDecisionAnswer(results[`intro_link_${candidate.anchorId}_${id}`], { same: 'same', different_or_unclear: 'different_or_unclear' }, { probability: 0.9, confidence: 0.8, margin: 0.5 }).identity === 'same'), candidate.anchorId]
    for (const id of targets) {
      const speech = plan.state.speeches.find(item => item.id === id)
      if (!speech) continue
      const explicitVoice = answers[`explicit_voice_attribution_${id}`]
      if (explicitVoice && plan.optionSpeakerIds[explicitVoice.choice] !== identity) continue
      const explicit = narrativeAttributionSpeaker(`${speech.narrativeBefore} ${speech.narrativeAfter}`, speakers)
      if (explicit && explicit !== identity) continue
      const original = answers[`relationship_original_${id}`] ?? answers[`first_pass_${id}`] ?? answers[`speech_${id}`]
      const originalIdentity = evaluateSpeakerDecisionAnswer(original, plan.optionSpeakerIds).identity
      if (originalIdentity && originalIdentity !== UNCAST_SPEAKER_ID && originalIdentity !== identity) continue
      const source = id === candidate.anchorId ? results[key] : results[`intro_link_${candidate.anchorId}_${id}`]
      const probability = source.probabilities[id === candidate.anchorId ? 'self' : 'same'] ?? 0
      const assignment = { choice: option, probabilities: { [option]: probability, no_clear_identity: 1 - probability }, confidence: source.confidence }
      answers[`relationship_original_${id}`] = answers[`speech_${id}`]
      answers[`speech_${id}`] = assignment
      answers[`self_intro_reconciled_${id}`] = assignment
      answers[`relationship_continuity_${id}`] = assignment
      answers[`relationship_global_${id}`] = assignment
      delete answers[`relationship_confirmed_${id}`]
      delete answers[`global_uncertain_${id}`]
    }
  }
}

/** Re-examine a run when a likely response was attributed to the same known person. */
export function applyExplicitPostQuoteVoiceAttributions(plan: SpeakerDecisionPlan, answers: Record<string, SpeakerDecisionChoice>): void {
  if (plan.state.messageRole !== 'assistant') return
  const quotes = playbackQuotes(plan.state.message)
  const paragraphs = playbackParagraphs(plan.state.message)
  const speakers = plan.state.speakers.map(speaker => ({ id: speaker.id, name: speaker.name }))
  for (const [index, speech] of plan.state.speeches.entries()) {
    const quote = quotes[index]
    if (!quote) continue
    const next = quotes[index + 1]
    const between = plan.state.message.slice(quote.end, next?.start ?? plan.state.message.length)
    const firstText = between.search(/\S/u)
    if (firstText < 0) continue
    const attributionPosition = quote.end + firstText
    const attributionParagraph = paragraphs.find(paragraph => attributionPosition >= paragraph.start && attributionPosition < paragraph.end)
    // An attribution directly introducing another quotation is ambiguous.
    if (!attributionParagraph || (next && next.start < attributionParagraph.end)) continue
    const immediate = plan.state.message.slice(attributionPosition, attributionParagraph.end)
    const matching = plan.state.speakers.filter(speaker => speaker.aliases.some(alias => {
      if (alias.trim().length < 2) return false
      return new RegExp(`^${escapedPattern(alias)}['\u2019]s\\s+voice\\s+(?:comes?|came|answers?|answered|repl(?:y|ies|ied)|says|said|cuts?\\s+in|reaches|reached|rises|rose|drops?|dropped|drifts?|drifted|floats?|floated)\\b`, 'iu').test(immediate)
    }))
    if (matching.length !== 1) continue
    const speaker = matching[0]
    if (speaker.id === USER_SPEAKER_ID && !answers[`persona_confirmed_${speech.id}`]) continue
    const priorExplicit = narrativeAttributionSpeaker(speech.narrativeBefore, speakers)
    if (priorExplicit && priorExplicit !== speaker.id) continue
    const assignment: SpeakerDecisionChoice = { choice: speaker.option, probabilities: { [speaker.option]: 1 }, confidence: 1 }
    answers[`relationship_original_${speech.id}`] = answers[`speech_${speech.id}`]
    answers[`speech_${speech.id}`] = assignment
    answers[`explicit_voice_attribution_${speech.id}`] = assignment
    answers[`relationship_continuity_${speech.id}`] = assignment
    answers[`relationship_global_${speech.id}`] = assignment
    delete answers[`relationship_confirmed_${speech.id}`]
    delete answers[`global_uncertain_${speech.id}`]
    delete answers[`best_guess_${speech.id}`]
  }
}

export function buildSpeakerSwitchContradictionReview(plan: SpeakerDecisionPlan, answers: Record<string, SpeakerDecisionChoice>, context: RelationshipReviewContext, cardSpeakerId: string | null = null) {
  const questions: SpeakerDecisionPlan['questions'] = {}
  const runs: Array<{ id: string; speechIds: string[]; previousId: string; currentId: string }> = []
  const roles: Array<{ id: string; runId: string; label: string; anchorId: string; speechIds: string[] }> = []
  const localEvidence: Array<{ roleId: string; speechId: string; cues: string[] }> = []
  const grounded = independentlyGroundedSpeakerIds(plan, context, cardSpeakerId)
  const criteria = speakerDecisionCriteria(plan.state.speakers.slice(0, 220))
  for (const speaker of plan.state.speakers) if (!grounded.has(speaker.id)) delete criteria[speaker.option]
  const ghostOptions: Record<string, string> = {}
  for (const [index, ghost] of context.ghosts.slice(0, 20).entries()) {
    if (!grounded.has(`ghost:${ghost.id}`)) continue
    const option = `switch_ghost_${index}`
    ghostOptions[option] = `ghost:${ghost.id}`
    criteria[option] = `Previously heard temporary character ${ghost.label || ghost.aliases.join(' / ') || `ghost ${index + 1}`}; verify the scene context.`
  }
  const knownIdentity = (speechId: string) => {
    const answer = answers[`speech_${speechId}`]
    const identity = answer && plan.optionSpeakerIds[answer.choice]
    return identity && identity !== UNCAST_SPEAKER_ID && identity !== USER_SPEAKER_ID ? identity : null
  }
  for (const turn of plan.state.turns) {
    const relation = answers[`turn_${turn.speechId}`]
    if (!relation || relation.choice !== TURN_RESPOND_OPTION || relation.confidence < 0.7 || (relation.probabilities[TURN_RESPOND_OPTION] ?? 0) < 0.75) continue
    const before = knownIdentity(turn.previousSpeechId)
    if (!before || before !== knownIdentity(turn.speechId)) continue
    const run = plan.state.runs.find(item => item.speechIds.includes(turn.previousSpeechId) && item.speechIds.includes(turn.speechId))
    if (!run || runs.some(item => item.id === run.id)) continue
    const speechIds = run.speechIds.slice(0, 12)
    if (!speechIds.includes(turn.previousSpeechId) || !speechIds.includes(turn.speechId)) continue
    runs.push({ id: run.id, speechIds, previousId: turn.previousSpeechId, currentId: turn.speechId })
    questions[`switch_${run.id}`] = { type: 'choice', instructions: `In the CURRENT message, are quotations ${turn.previousSpeechId} and ${turn.speechId} actually spoken by different people? Read the entire dialogue run, its narration, and preceding role-labeled messages. A reply can quote, echo, or continue the same person's words; a bystander is not automatically a speaker. Do not infer a switch just from a question or from the current assignments. Choose unclear if the text does not establish a change.`, criteria: { different: 'Two distinct people speak the quotations.', same_or_unclear: 'The same person speaks both or a switch is not established.' } }
    for (const id of speechIds) {
      const targetCriteria = { ...criteria }
      if (!answers[`persona_confirmed_${id}`]) for (const speaker of plan.state.speakers) if (speaker.id === USER_SPEAKER_ID) delete targetCriteria[speaker.option]
      questions[`switch_speaker_${run.id}_${id}`] = { type: 'choice', criteria: targetCriteria, instructions: `Identify the actual speaker of ${id} in run ${run.id}. Re-read all speech and narration around the exchange, later names and attributions, physical positions, actions, and the preceding messages. A distinct unnamed person may speak even when a known person is nearby. Do not assign an addressee, bystander, or previous message author merely because they are mentioned. Choose uncast_character for a distinct unnamed speaker, or no_clear_identity if uncertain.` }
      if (id !== turn.previousSpeechId && id !== turn.speechId) questions[`switch_link_${run.id}_${id}`] = { type: 'choice', instructions: `If quotations ${turn.previousSpeechId} and ${turn.speechId} are spoken by two different people, which of those actual speakers, if either, speaks ${id}? Read the full run, including adjacent actions, topic, objects, pronouns, later attributions and possible third speakers. Do not treat an addressee or a bystander as the speaker. Select other_or_unclear if the text does not clearly establish the link.`, criteria: { previous: `The person who speaks ${turn.previousSpeechId}.`, current: `The person who speaks ${turn.speechId}.`, other_or_unclear: 'A third person, or the link is unclear.' } }
    }
    // The contradiction can occur later than the explicit attribution. Search
    // only this bounded dialogue run and prefer the closest anchored quote.
    const turnIndex = speechIds.indexOf(turn.speechId)
    const anchorId = speechIds.filter(id => !!answers[`explicit_voice_attribution_${id}`]).sort((a, b) => Math.abs(speechIds.indexOf(a) - turnIndex) - Math.abs(speechIds.indexOf(b) - turnIndex))[0] ?? ''
    if (anchorId) {
      const firstParagraph = plan.state.paragraphs.findIndex(item => item.id === plan.state.speeches.find(speech => speech.id === speechIds[0])?.paragraphId)
      const lastParagraph = plan.state.paragraphs.findIndex(item => item.id === plan.state.speeches.find(speech => speech.id === speechIds.at(-1))?.paragraphId)
      const narrative = plan.state.paragraphs.slice(Math.max(0, firstParagraph - 2), Math.max(firstParagraph, lastParagraph) + 1).map(item => narrativeOnly(item.text)).join('\n')
      const counts = new Map<string, number>()
      for (const match of narrative.matchAll(/\bthe\s+([\p{L}][\p{L}\p{M}-]{2,30})['\u2019]s\b/giu)) {
        const label = `the ${match[1].toLocaleLowerCase()}`
        if (!isBroadPersonLabel(label)) counts.set(label, (counts.get(label) ?? 0) + 1)
      }
      for (const [label, count] of counts) {
        if (count < 2 || roles.filter(item => item.runId === run.id).length >= 2) continue
        const roleId = `role_${run.id}_${roles.filter(item => item.runId === run.id).length}`
        roles.push({ id: roleId, runId: run.id, label, anchorId, speechIds })
        const labelPattern = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const roleMention = new RegExp(`\\b${labelPattern}(?:['’]s)?\\b`, 'iu')
        for (const id of speechIds) {
          if (id === anchorId || localEvidence.filter(item => item.roleId === roleId).length >= 4) continue
          const speech = plan.state.speeches.find(item => item.id === id)
          if (!speech) continue
          const paragraphIndex = plan.state.paragraphs.findIndex(item => item.id === speech.paragraphId)
          const preceding = paragraphIndex > 0 ? narrativeOnly(plan.state.paragraphs[paragraphIndex - 1].text) : ''
          const cues: string[] = []
          const tag = /^\s*(?:he|she|they)\s+(?:says|said|asks|asked|replies|replied|answers|answered|whispers|whispered|murmurs|murmured)\b/iu
          const localSubject = `${preceding} ${speech.narrativeBefore}`
          const competingPerson = /\b(?:another|other|second|third)\s+(?:woman|man|person|speaker|girl|boy)\b/iu.test(localSubject) || hasSpeakerMentions(mentionedSpeakers(localSubject, plan.state.speakers.map(item => ({ id: item.id, name: item.name }))))
          if (roleMention.test(localSubject) && !competingPerson && tag.test(speech.narrativeAfter) && !SPEAKER_HARD_BOUNDARY_PATTERNS.some(item => item.pattern.test(localSubject))) cues.push(/[,，]\s*$/u.test(speech.text) ? 'recent role followed by pronoun speech tag after comma-ended quotation' : 'recent role followed by pronoun speech tag')
          const precedingSpeech = plan.state.speeches[plan.state.speeches.findIndex(item => item.id === id) - 1]
          if (precedingSpeech?.paragraphId === speech.paragraphId && roleMention.test(preceding) && !competingPerson && tag.test(speech.narrativeBefore) && !SPEAKER_HARD_BOUNDARY_PATTERNS.some(item => item.pattern.test(preceding))) cues.push(/[,，]\s*$/u.test(precedingSpeech.text) ? 'quotation follows a pronoun speech tag and comma-ended quotation near the role' : 'quotation follows a pronoun speech tag near the role')
          if (roleMention.test(speech.narrativeAfter) && speech.narrativeAfter.length <= 250 && !SPEAKER_TURN_SWITCH_PATTERN.test(speech.narrativeAfter)) cues.push('role action immediately follows quotation, before the next quotation')
          if (roleMention.test(speech.narrativeBefore) && speech.narrativeBefore.length <= 250 && !SPEAKER_TURN_SWITCH_PATTERN.test(speech.narrativeBefore)) cues.push('role action immediately precedes quotation, after the previous quotation')
          if (!cues.length) continue
          localEvidence.push({ roleId, speechId: id, cues })
          questions[`${roleId}_local_${id}`] = { type: 'choice', instructions: `Consider the local evidence listed for ${id} in narrativeRoleEvidence, together with the entire CURRENT exchange. Is the person described as ${label} the actual speaker of ${id}? A pronoun or action near a quote is suggestive, not proof: check whether another person could be referenced, whether the action belongs to a listener, whether speech is interrupted, and whether named speech attribution or context contradicts it. Consider the quotation's content and dialogue responses. Choose other_or_unclear when the evidence does not establish the speaker.`, criteria: { role: `The person described as ${label} speaks ${id}.`, other_or_unclear: 'Another person speaks or identity is uncertain.' } }
        }
        questions[`${roleId}_distinct`] = { type: 'choice', instructions: `In the CURRENT dialogue run, is the person described as ${label} a different person from the actual speaker of ${anchorId}? The name or role in narration might be a bystander, an addressee, an alias for the named speaker, or a different participant. Compare the whole scene and their physical positions and actions. Select different only when it is clear they are distinct people.`, criteria: { different: 'The described person and the named quote speaker are distinct people.', same_or_unclear: 'They are the same person, or their relationship is unclear.' } }
        questions[`${roleId}_exchange`] = { type: 'choice', instructions: `Read the entire CURRENT run as an exchange, especially the meaning of each quotation, clarifying questions and their answers, speech tags, physical actions, positions and later evidence. Is ${label} a distinct active speaker in conversation with the explicitly attributed speaker of ${anchorId}? Do not assume a question means a speaker change; a self-question, interruption, third speaker, bystander, or alias can make this uncertain.`, criteria: { two_speakers: `The described ${label} and the speaker of ${anchorId} are distinct and both actually speak in this exchange.`, other_or_unclear: 'That two-person exchange is not established.' } }
        for (const id of speechIds) if (id !== anchorId) {
          questions[`${roleId}_speech_${id}`] = { type: 'choice', instructions: `Does ${label}, the person described in narration, actually speak quotation ${id} in the CURRENT message? Trace who performs the intervening actions, speech tags, pronouns, objects, positions, responses and the surrounding exchange. A person merely present, addressed, or observing is not necessarily speaking. Select role only when this quote clearly belongs to that person; otherwise select other_or_unclear.`, criteria: { role: `The person described as ${label} speaks this quote.`, other_or_unclear: 'Another person speaks, or the evidence is unclear.' } }
          questions[`${roleId}_exchange_${id}`] = { type: 'choice', instructions: `Re-read the entire dialogue exchange, not just ${id}. Who speaks ${id}? Track the subject of decisions and actions across a clarification question and its answer, who continues a thought, and who responds. Compare the named voice at ${anchorId} with ${label}'s actions and speech, and check for self-questions, interruptions, other speakers and bystanders. Do not simply alternate speakers. Choose other_or_unclear if the identity cannot be established.`, criteria: { role: `The person described as ${label}.`, anchor: `The explicitly attributed speaker of ${anchorId}.`, other_or_unclear: 'Another speaker, or uncertain.' } }
        }
      }
    }
    if (runs.length >= 3) break
  }
  const explicitAttributions = Object.fromEntries(plan.state.speeches.flatMap(speech => {
    const answer = answers[`explicit_voice_attribution_${speech.id}`]
    return answer ? [[speech.id, plan.optionSpeakerIds[answer.choice]]] : []
  }))
  return { state: { ...plan.state, previousMessages: context.previousMessages, ghosts: context.ghosts, switchRuns: runs, explicitAttributions, narrativeRoles: roles, narrativeRoleEvidence: localEvidence }, questions, runs, ghostOptions, roles, localEvidence }
}

/** Apply a confirmed switch only when both sides resolve strongly and differently. */
export function applySpeakerSwitchContradictionReview(plan: SpeakerDecisionPlan, answers: Record<string, SpeakerDecisionChoice>, review: ReturnType<typeof buildSpeakerSwitchContradictionReview>, results: Record<string, SpeakerDecisionChoice>): void {
  const options = { ...plan.optionSpeakerIds, ...review.ghostOptions }
  const thresholds = { probability: 0.9, confidence: 0.8, margin: 0.5 }
  const speakers = plan.state.speakers.map(speaker => ({ id: speaker.id, name: speaker.name }))
  const eligibleIdentity = (runId: string, id: string, gates = thresholds) => {
    const identity = evaluateSpeakerDecisionAnswer(results[`switch_speaker_${runId}_${id}`], options, gates).identity
    if (!identity || (identity === USER_SPEAKER_ID && !answers[`persona_confirmed_${id}`])) return null
    const speech = plan.state.speeches.find(item => item.id === id)
    if (!speech) return null
    const explicit = narrativeAttributionSpeaker(`${speech.narrativeBefore} ${speech.narrativeAfter}`, speakers)
    return explicit && explicit !== identity ? null : identity
  }
  const samePerson = (left: string, right: string): boolean => {
    if (left === right) return true
    const ghostId = left.startsWith('ghost:') ? left.slice(6) : right.startsWith('ghost:') ? right.slice(6) : ''
    const speakerId = left.startsWith('ghost:') ? right : left
    if (!ghostId || speakerId.startsWith('ghost:')) return false
    const ghost = review.state.ghosts.find(item => item.id === ghostId)
    const speaker = plan.state.speakers.find(item => item.id === speakerId)
    if (!ghost || !speaker) return false
    const aliases = new Set(speaker.aliases.map(alias => alias.toLocaleLowerCase()))
    return [ghost.label, ...ghost.aliases].some(alias => !!alias && aliases.has(alias.toLocaleLowerCase()))
  }
  for (const run of review.runs) {
    const firstExplicit = answers[`explicit_voice_attribution_${run.previousId}`]
    const secondExplicit = answers[`explicit_voice_attribution_${run.currentId}`]
    const anchored = !!firstExplicit || !!secondExplicit
    const splitThresholds = anchored ? { probability: 0.7, confidence: 0.4, margin: 0.3 } : thresholds
    if (evaluateSpeakerDecisionAnswer(results[`switch_${run.id}`], { different: 'different', same_or_unclear: 'same_or_unclear' }, splitThresholds).identity !== 'different') continue
    const endpointThresholds = anchored ? { probability: 0.8, confidence: 0.75, margin: 0.3 } : thresholds
    const first = firstExplicit ? plan.optionSpeakerIds[firstExplicit.choice] : eligibleIdentity(run.id, run.previousId, endpointThresholds)
    const second = secondExplicit ? plan.optionSpeakerIds[secondExplicit.choice] : eligibleIdentity(run.id, run.currentId, endpointThresholds)
    if (!first || !second || samePerson(first, second)) continue
    for (const id of run.speechIds) {
      if (answers[`explicit_voice_attribution_${id}`]) continue
      let result = results[`switch_speaker_${run.id}_${id}`]
      let linkApplied: SpeakerDecisionChoice | undefined
      let identity = eligibleIdentity(run.id, id, id === run.previousId || id === run.currentId ? endpointThresholds : thresholds)
      if (!identity && anchored && id !== run.previousId && id !== run.currentId) {
        const link = results[`switch_link_${run.id}_${id}`]
        const linked = evaluateSpeakerDecisionAnswer(link, { previous: 'previous', current: 'current', other_or_unclear: 'other_or_unclear' }, { probability: 0.85, confidence: 0.75, margin: 0.4 }).identity
        const linkedId = linked === 'previous' ? first : linked === 'current' ? second : null
        const anchorId = linked === 'previous' ? run.previousId : run.currentId
        const anchorAnswer = answers[`explicit_voice_attribution_${anchorId}`] ?? results[`switch_speaker_${run.id}_${anchorId}`]
        const anchorChoice = anchorAnswer?.choice
        if (linkedId && anchorChoice && (linkedId !== USER_SPEAKER_ID || answers[`persona_confirmed_${id}`])) {
          const speech = plan.state.speeches.find(item => item.id === id)
          const explicit = speech && narrativeAttributionSpeaker(`${speech.narrativeBefore} ${speech.narrativeAfter}`, speakers)
          if (!explicit || explicit === linkedId) {
            identity = linkedId
            result = { choice: anchorChoice, probabilities: { [anchorChoice]: link.probabilities[link.choice] ?? 0 }, confidence: link.confidence }
            linkApplied = link
          }
        }
      }
      if (!identity) continue
      const original = answers[`speech_${id}`]
      const existing = evaluateSpeakerDecisionAnswer(original, options).identity
      if (existing === identity && !answers[`global_uncertain_${id}`]) continue
      Object.assign(plan.optionSpeakerIds, review.ghostOptions)
      answers[`relationship_original_${id}`] = original
      answers[`speech_${id}`] = result
      answers[`switch_reconciled_${id}`] = result
      if (linkApplied) answers[`switch_link_reconciled_${id}`] = linkApplied
      answers[`relationship_continuity_${id}`] = result
      answers[`relationship_global_${id}`] = result
      delete answers[`relationship_confirmed_${id}`]
      delete answers[`global_uncertain_${id}`]
    }
  }
}

/** Apply separately verified narrative-role links; a nearby bystander is not enough. */
export function applyNarrativeRoleSpeakerReview(plan: SpeakerDecisionPlan, answers: Record<string, SpeakerDecisionChoice>, review: ReturnType<typeof buildSpeakerSwitchContradictionReview>, results: Record<string, SpeakerDecisionChoice>, distinctThresholds = { probability: 0.85, confidence: 0.75, margin: 0.4 }, speechThresholds = { probability: 0.8, confidence: 0.7, margin: 0.3 }): void {
  const speakers = plan.state.speakers.map(speaker => ({ id: speaker.id, name: speaker.name }))
  const candidates = new Map<string, Array<{ role: typeof review.roles[number]; identity: string; option: string; result: SpeakerDecisionChoice }>>()
  for (const role of review.roles) {
    const distinct = evaluateSpeakerDecisionAnswer(results[`${role.id}_distinct`], { different: 'different', same_or_unclear: 'same_or_unclear' }, distinctThresholds)
    if (distinct.identity !== 'different') continue
    const anchor = answers[`explicit_voice_attribution_${role.anchorId}`]
    const anchorId = anchor && plan.optionSpeakerIds[anchor.choice]
    if (!anchorId) continue
    const names = [role.label, role.label.replace(/^the\s+/iu, '')].map(value => value.toLocaleLowerCase())
    const castMatches = plan.state.speakers.filter(speaker => speaker.id !== USER_SPEAKER_ID && speaker.aliases.some(alias => names.includes(alias.toLocaleLowerCase())))
    if (castMatches.length > 1 || castMatches.some(speaker => speaker.id === anchorId)) continue
    const ghostMatches = review.state.ghosts.filter(ghost => [ghost.label, ...ghost.aliases].some(alias => names.includes(alias.toLocaleLowerCase())))
    const anchorSpeaker = plan.state.speakers.find(speaker => speaker.id === anchorId)
    const anchorAliases = new Set(anchorSpeaker?.aliases.map(alias => alias.toLocaleLowerCase()) ?? [])
    if (ghostMatches.some(ghost => [ghost.label, ...ghost.aliases].some(alias => !!alias && anchorAliases.has(alias.toLocaleLowerCase())))) continue
    const identity = castMatches[0]?.id ?? (ghostMatches.length === 1 ? `ghost:${ghostMatches[0].id}` : unconfiguredSpeakerId(role.label))
    const option = castMatches[0]?.option ?? `${role.id}_identity`
    for (const id of role.speechIds) {
      if (id === role.anchorId || answers[`explicit_voice_attribution_${id}`]) continue
      const existing = evaluateSpeakerDecisionAnswer(answers[`speech_${id}`], plan.optionSpeakerIds).identity
      if ((answers[`persona_confirmed_${id}`] && existing === USER_SPEAKER_ID) || ((answers[`self_intro_reconciled_${id}`] || answers[`switch_reconciled_${id}`]) && existing !== identity)) continue
      const result = results[`${role.id}_speech_${id}`]
      if (evaluateSpeakerDecisionAnswer(result, { role: 'role', other_or_unclear: 'other_or_unclear' }, speechThresholds).identity !== 'role') continue
      const speech = plan.state.speeches.find(item => item.id === id)
      if (!speech) continue
      const explicit = narrativeAttributionSpeaker(`${speech.narrativeBefore} ${speech.narrativeAfter}`, speakers)
      if (explicit && explicit !== identity) continue
      const entries = candidates.get(id) ?? []
      entries.push({ role, identity, option, result })
      candidates.set(id, entries)
    }
  }
  for (const [id, entries] of candidates) {
    if (new Set(entries.map(item => item.identity)).size !== 1) continue
    const { identity, option, result } = entries[0]
    const original = answers[`speech_${id}`]
    const existing = evaluateSpeakerDecisionAnswer(original, plan.optionSpeakerIds).identity
    if (existing === identity && !answers[`global_uncertain_${id}`]) continue
    plan.optionSpeakerIds[option] = identity
    const assignment: SpeakerDecisionChoice = { choice: option, probabilities: { [option]: result.probabilities.role ?? 0 }, confidence: result.confidence }
    answers[`relationship_original_${id}`] = original
    answers[`speech_${id}`] = assignment
    answers[`narrative_role_reconciled_${id}`] = result
    answers[`relationship_continuity_${id}`] = assignment
    answers[`relationship_global_${id}`] = assignment
    delete answers[`relationship_confirmed_${id}`]
    delete answers[`global_uncertain_${id}`]
  }
}

/** Reconsider only lines with concrete local cues and an affirmative semantic review. */
export function applyNarrativeLocalEvidenceReview(plan: SpeakerDecisionPlan, answers: Record<string, SpeakerDecisionChoice>, review: ReturnType<typeof buildSpeakerSwitchContradictionReview>, results: Record<string, SpeakerDecisionChoice>): void {
  for (const role of review.roles) {
    const distinct = results[`${role.id}_distinct`]
    if (evaluateSpeakerDecisionAnswer(distinct, { different: 'different', same_or_unclear: 'same_or_unclear' }, { probability: 0.6, confidence: 0.2, margin: 0.2 }).identity !== 'different') continue
    const combined: Record<string, SpeakerDecisionChoice> = { [`${role.id}_distinct`]: distinct }
    const included: string[] = []
    for (const evidence of review.localEvidence.filter(item => item.roleId === role.id)) {
      const local = results[`${role.id}_local_${evidence.speechId}`]
      if (evaluateSpeakerDecisionAnswer(local, { role: 'role', other_or_unclear: 'other_or_unclear' }, { probability: 0.7, confidence: 0.6, margin: 0.4 }).identity !== 'role') continue
      const existingReview = results[`${role.id}_speech_${evidence.speechId}`]
      if (evaluateSpeakerDecisionAnswer(existingReview, { role: 'role', other_or_unclear: 'other_or_unclear' }, { probability: 0.9, confidence: 0.8, margin: 0.5 }).identity === 'other_or_unclear') continue
      combined[`${role.id}_speech_${evidence.speechId}`] = local
      included.push(evidence.speechId)
    }
    const before = new Set(Object.keys(answers).filter(id => id.startsWith('narrative_role_reconciled_')))
    applyNarrativeRoleSpeakerReview(plan, answers, { ...review, roles: [role] }, combined, { probability: 0.6, confidence: 0.2, margin: 0.2 }, { probability: 0.7, confidence: 0.6, margin: 0.4 })
    for (const id of included) if (!before.has(`narrative_role_reconciled_${id}`) && answers[`narrative_role_reconciled_${id}`]) answers[`narrative_local_reconciled_${id}`] = results[`${role.id}_local_${id}`]
  }
}

/** Bounded joint scoring of a contested run. Scores are heuristics, not calibrated probabilities. */
export function applyContestedDialogueChain(plan: SpeakerDecisionPlan, answers: Record<string, SpeakerDecisionChoice>, review: ReturnType<typeof buildSpeakerSwitchContradictionReview>, results: Record<string, SpeakerDecisionChoice>): void {
  const options = { ...plan.optionSpeakerIds, ...review.ghostOptions }
  for (const run of review.runs) {
    const roles = review.roles.filter(role => role.runId === run.id)
    if (roles.length !== 1 || run.speechIds.length < 3) continue
    const role = roles[0]
    const distinct = results[`${role.id}_distinct`]
    if (evaluateSpeakerDecisionAnswer(distinct, { different: 'different', same_or_unclear: 'same_or_unclear' }, { probability: 0.6, confidence: 0.2, margin: 0.2 }).identity !== 'different') continue
    const anchor = answers[`explicit_voice_attribution_${role.anchorId}`]
    const anchorIdentity = anchor && options[anchor.choice]
    if (!anchorIdentity || anchorIdentity === USER_SPEAKER_ID) continue
    const evidence = review.localEvidence.filter(item => item.roleId === role.id)
    const confirmedTags = evidence.filter(item => item.cues.some(cue => cue.includes('pronoun speech tag')) && evaluateSpeakerDecisionAnswer(results[`${role.id}_local_${item.speechId}`], { role: 'role', other_or_unclear: 'other_or_unclear' }, { probability: 0.7, confidence: 0.6, margin: 0.4 }).identity === 'role')
    if (!confirmedTags.length) continue
    const roleCandidates = new Map<string, number>()
    for (const item of confirmedTags) {
      const answer = results[`switch_speaker_${run.id}_${item.speechId}`]
      const identity = answer && options[answer.choice]
      if (identity?.startsWith('ghost:') && (answer.probabilities[answer.choice] ?? 0) >= 0.75 && answer.confidence >= 0.7) roleCandidates.set(identity, (roleCandidates.get(identity) ?? 0) + 1)
    }
    if (roleCandidates.size !== 1) continue
    const roleIdentity = [...roleCandidates.keys()][0]
    const ghost = review.state.ghosts.find(item => `ghost:${item.id}` === roleIdentity)
    const namedAnchor = plan.state.speakers.find(item => item.id === anchorIdentity)
    const anchorAliases = new Set(namedAnchor?.aliases.map(alias => alias.toLocaleLowerCase()) ?? [])
    if (!ghost || [ghost.label, ...ghost.aliases].some(alias => !!alias && anchorAliases.has(alias.toLocaleLowerCase()))) continue
    const roleOption = Object.entries(options).find(([, identity]) => identity === roleIdentity)?.[0]
    if (!roleOption) continue
    const identities = [roleIdentity, anchorIdentity, '__joint_other__']
    const speeches = run.speechIds.map(id => plan.state.speeches.find(speech => speech.id === id)!)
    if (speeches.some(speech => !speech)) continue
    const turns = new Map(plan.state.turns.map(turn => [turn.speechId, turn]))
    const emissions = speeches.map(speech => {
      const explicit = answers[`explicit_voice_attribution_${speech.id}`]
      const explicitId = explicit && options[explicit.choice]
      const result = results[`switch_speaker_${run.id}_${speech.id}`]
      const scores = new Map<string, number>()
      const roleProbability = Object.entries(result?.probabilities ?? {}).filter(([key]) => options[key] === roleIdentity).reduce((sum, [, value]) => sum + value, 0)
      const anchorProbability = Object.entries(result?.probabilities ?? {}).filter(([key]) => options[key] === anchorIdentity).reduce((sum, [, value]) => sum + value, 0)
      const otherProbability = Object.entries(result?.probabilities ?? {}).filter(([key]) => options[key] !== roleIdentity && options[key] !== anchorIdentity).reduce((sum, [, value]) => sum + value, 0)
      for (const [identity, probability] of [[roleIdentity, roleProbability], [anchorIdentity, anchorProbability], ['__joint_other__', otherProbability]] as const) scores.set(identity, 0.45 * Math.log(Math.max(0.05, probability)))
      const item = evidence.find(entry => entry.speechId === speech.id)
      const local = results[`${role.id}_local_${speech.id}`]
      if (item) {
        const tag = item.cues.some(cue => cue.includes('pronoun speech tag'))
        const action = item.cues.some(cue => cue.includes('role action'))
        let bonus = tag ? 1.2 : action ? 0.55 : 0
        if (local?.choice === 'role' && (local.probabilities.role ?? 0) >= 0.7 && local.confidence >= 0.6) bonus += 0.5
        scores.set(roleIdentity, (scores.get(roleIdentity) ?? 0) + bonus)
      }
      if (explicitId) for (const identity of identities) if (identity !== explicitId) scores.set(identity, Number.NEGATIVE_INFINITY)
      return scores
    })
    const transition = (index: number, previous: string, current: string) => {
      const turn = turns.get(speeches[index].id)
      const relation = answers[`turn_${speeches[index].id}`]
      if (!turn || turn.previousSpeechId !== speeches[index - 1].id || SPEAKER_HARD_BOUNDARY_PATTERNS.some(item => item.pattern.test(turn.bridge))) return 0
      const continuation = relation?.probabilities[TURN_CONTINUE_OPTION] ?? 0
      const response = relation?.probabilities[TURN_RESPOND_OPTION] ?? 0
      const other = relation?.probabilities[TURN_OTHER_OPTION] ?? 0
      const question = /[?？]\s*$/u.test(speeches[index - 1].text)
      if (previous === '__joint_other__' || current === '__joint_other__') return 0
      return previous === current ? 1.5 * continuation : 1.5 * response + (question && response > continuation && other < response ? 0.35 : 0)
    }
    const forward = speeches.map(() => new Map<string, number>())
    const backward = speeches.map(() => new Map<string, number>())
    for (let i = 0; i < speeches.length; i++) for (const identity of identities) {
      const prior = i === 0 ? 0 : Math.max(...identities.map(previous => (forward[i - 1].get(previous) ?? Number.NEGATIVE_INFINITY) + transition(i, previous, identity)))
      forward[i].set(identity, prior + (emissions[i].get(identity) ?? Number.NEGATIVE_INFINITY))
    }
    for (let i = speeches.length - 1; i >= 0; i--) for (const identity of identities) {
      backward[i].set(identity, i === speeches.length - 1 ? 0 : Math.max(...identities.map(next => transition(i + 1, identity, next) + (emissions[i + 1].get(next) ?? Number.NEGATIVE_INFINITY) + (backward[i + 1].get(next) ?? Number.NEGATIVE_INFINITY))))
    }
    for (let i = 0; i < speeches.length; i++) {
      const speech = speeches[i]
      const ranked = identities.map(identity => ({ identity, score: (forward[i].get(identity) ?? Number.NEGATIVE_INFINITY) + (backward[i].get(identity) ?? Number.NEGATIVE_INFINITY) })).sort((a, b) => b.score - a.score)
      const winner = ranked[0]
      const margin = winner.score - ranked[1].score
      const clues = evidence.find(item => item.speechId === speech.id)?.cues.join(' + ') || 'none'
      answers[`joint_chain_detail_${speech.id}`] = { choice: `role=${ranked.find(item => item.identity === roleIdentity)?.score.toFixed(2)} anchor=${ranked.find(item => item.identity === anchorIdentity)?.score.toFixed(2)} other=${ranked.find(item => item.identity === '__joint_other__')?.score.toFixed(2)} margin=${margin.toFixed(2)} cues=${clues}; scores are heuristic, not probabilities`, probabilities: {}, confidence: 0 }
      if (winner.identity === '__joint_other__' || !Number.isFinite(margin) || margin < 0.8 || answers[`explicit_voice_attribution_${speech.id}`] || answers[`self_intro_reconciled_${speech.id}`]) continue
      const previous = answers[`speech_${speech.id}`]
      const existing = evaluateSpeakerDecisionAnswer(previous, options).identity
      if ((answers[`persona_confirmed_${speech.id}`] && existing === USER_SPEAKER_ID) || (answers[`switch_reconciled_${speech.id}`] && existing !== winner.identity)) continue
      const local = results[`${role.id}_local_${speech.id}`]
      if (winner.identity === roleIdentity && evaluateSpeakerDecisionAnswer(local, { role: 'role', other_or_unclear: 'other_or_unclear' }, { probability: 0.9, confidence: 0.8, margin: 0.5 }).identity === 'other_or_unclear') continue
      const reviewed = results[`switch_speaker_${run.id}_${speech.id}`]
      const reviewedIdentity = reviewed && options[reviewed.choice]
      if (reviewedIdentity && reviewedIdentity !== roleIdentity && reviewedIdentity !== anchorIdentity && (reviewed.probabilities[reviewed.choice] ?? 0) >= 0.85 && reviewed.confidence >= 0.8) continue
      const explicit = narrativeAttributionSpeaker(`${speech.narrativeBefore} ${speech.narrativeAfter}`, plan.state.speakers)
      if (explicit && explicit !== winner.identity) continue
      if (existing === winner.identity && !answers[`global_uncertain_${speech.id}`]) continue
      const option = winner.identity === roleIdentity ? roleOption : anchor.choice
      Object.assign(plan.optionSpeakerIds, review.ghostOptions)
      const assignment: SpeakerDecisionChoice = { choice: option, probabilities: { [option]: 1 }, confidence: 1 }
      answers[`relationship_original_${speech.id}`] = previous
      answers[`speech_${speech.id}`] = assignment
      answers[`relationship_continuity_${speech.id}`] = assignment
      answers[`relationship_global_${speech.id}`] = assignment
      answers[`joint_chain_${speech.id}`] = { choice: option, probabilities: { [option]: Math.min(1, margin / 4) }, confidence: Math.min(1, margin / 4) }
      delete answers[`relationship_confirmed_${speech.id}`]
      delete answers[`global_uncertain_${speech.id}`]
    }
  }
}

/** Reconcile a contested exchange only when its whole-scene and per-line readings agree. */
export function applyNarrativeExchangeSpeakerReview(plan: SpeakerDecisionPlan, answers: Record<string, SpeakerDecisionChoice>, review: ReturnType<typeof buildSpeakerSwitchContradictionReview>, results: Record<string, SpeakerDecisionChoice>): void {
  for (const role of review.roles) {
    const exchange = results[`${role.id}_exchange`]
    if (evaluateSpeakerDecisionAnswer(exchange, { two_speakers: 'two_speakers', other_or_unclear: 'other_or_unclear' }, { probability: 0.8, confidence: 0.7, margin: 0.4 }).identity !== 'two_speakers') continue
    const distinct = results[`${role.id}_distinct`]
    if (evaluateSpeakerDecisionAnswer(distinct, { different: 'different', same_or_unclear: 'same_or_unclear' }, { probability: 0.6, confidence: 0.2, margin: 0.2 }).identity !== 'different') continue
    const combined: Record<string, SpeakerDecisionChoice> = { ...results, [`${role.id}_distinct`]: { choice: 'different', probabilities: { different: exchange.probabilities.two_speakers ?? 0, same_or_unclear: exchange.probabilities.other_or_unclear ?? 0 }, confidence: exchange.confidence } }
    const included: string[] = []
    for (const id of role.speechIds) {
      delete combined[`${role.id}_speech_${id}`]
      const answer = results[`${role.id}_exchange_${id}`]
      if (evaluateSpeakerDecisionAnswer(answer, { role: 'role', anchor: 'anchor', other_or_unclear: 'other_or_unclear' }, { probability: 0.8, confidence: 0.7, margin: 0.4 }).identity !== 'role') continue
      const local = results[`${role.id}_speech_${id}`]
      if (evaluateSpeakerDecisionAnswer(local, { role: 'role', other_or_unclear: 'other_or_unclear' }, { probability: 0.9, confidence: 0.8, margin: 0.5 }).identity === 'other_or_unclear') continue
      combined[`${role.id}_speech_${id}`] = { choice: 'role', probabilities: { role: answer.probabilities.role ?? 0, other_or_unclear: Math.max(answer.probabilities.anchor ?? 0, answer.probabilities.other_or_unclear ?? 0) }, confidence: answer.confidence }
      included.push(id)
    }
    const before = new Set(Object.keys(answers).filter(id => id.startsWith('narrative_role_reconciled_')))
    applyNarrativeRoleSpeakerReview(plan, answers, { ...review, roles: [role] }, combined, { probability: 0.8, confidence: 0.7, margin: 0.4 })
    for (const id of included) if (!before.has(`narrative_role_reconciled_${id}`) && answers[`narrative_role_reconciled_${id}`]) answers[`narrative_exchange_reconciled_${id}`] = results[`${role.id}_exchange_${id}`]
  }
}

/** A small, prior-only re-read for an unresolved opening exchange. */
export function buildOpeningSpeakerReview(plan: SpeakerDecisionPlan, answers: Record<string, SpeakerDecisionChoice>, context: RelationshipReviewContext, cardSpeakerId: string | null) {
  const openingRun = plan.state.runs.find(run => run.speechIds.includes('s0'))
  const targets = openingRun?.speechIds.filter(id => !!answers[`global_uncertain_${id}`]).slice(0, 12) ?? []
  if (!context.previousMessages.length || !targets.length || !openingRun) return null
  const localContext = { ...context, previousMessages: context.previousMessages.slice(-2) }
  const review = buildRelationshipSpeakerReview(plan, answers, localContext, null, { cardSpeakerId, targets, strategy: 'run' })
  const questions: SpeakerDecisionPlan['questions'] = {}
  for (const id of targets) {
    const question = review.questions[`relationship_${id}`]
    if (!question) continue
    questions[`relationship_${id}`] = { ...question, instructions: `Re-read the opening exchange carefully. ${question.instructions} Identify the speaker of ${id} itself, not the user who authored an earlier message or an incidental person mentioned in narration. Use the preceding exchange and opening passage as evidence; choose no_clear_identity when they do not establish the speaker.` }
  }
  if (!Object.keys(questions).length) return null
  if (openingRun.speechIds.length > 1) {
    const criteria = questions[Object.keys(questions)[0]].criteria
    questions.opening_exchange_pattern = {
      type: 'choice',
      instructions: 'Consider the complete opening dialogue run in the CURRENT message, together with the preceding exchange and narration. Do all quotations in this opening run belong to one actual speaker, or does a different person take a turn? A quoted response may echo the previous message without being spoken by its author. Consider interruptions, new entrants, changes of scene or channel, later clarification, and people merely mentioned or addressed. Select unclear if a speaker change cannot be ruled out.',
      criteria: { single_speaker: 'All quotations in this opening run are spoken by one person.', multiple_speakers: 'At least two people speak in this opening run.', no_clear_identity: 'The number of speakers is unclear.' },
    }
    questions.opening_exchange_speaker = {
      type: 'choice',
      instructions: 'Identify the person who speaks the entire opening dialogue run in the CURRENT message, only if one speaker clearly accounts for every quotation. Compare the preceding user and assistant exchange, the opening reply, carried objects, pronouns, intervening actions and later dialogue. A message author, addressee or bystander is not automatically the speaker. If the run contains multiple speakers or identity is uncertain, choose no_clear_identity.',
      criteria,
    }
  }
  const lastSpeech = plan.state.speeches.find(speech => speech.id === openingRun.speechIds.at(-1))
  const lastParagraph = plan.state.paragraphs.findIndex(paragraph => paragraph.id === lastSpeech?.paragraphId)
  // Do not include the following paragraph: it may contain another
  // conversation or a different channel, even when it is adjacent to the run.
  const paragraphs = plan.state.paragraphs.slice(0, lastParagraph >= 0 ? lastParagraph + 1 : 1)
  const openingSpeechIds = new Set(openingRun.speechIds)
  const prior = localContext.previousMessages.at(-1)!
  const priorQuote = playbackQuotes(prior.text).at(-1)
  const boundaryEvidence = priorQuote ? {
    messageId: prior.id, role: prior.role ?? 'assistant',
    lead: prior.text.slice(Math.max(0, priorQuote.start - 600), priorQuote.start),
    quotation: priorQuote.text.slice(-1_200),
    after: prior.text.slice(priorQuote.end, priorQuote.end + 600),
    currentOpening: plan.state.speeches[0]?.text ?? '',
  } : null
  return {
    ...review,
    questions,
    state: { ...review.state, message: paragraphs.map(paragraph => paragraph.text).join('\n\n'), paragraphs, speeches: plan.state.speeches.filter(speech => openingSpeechIds.has(speech.id)), runs: [openingRun], turns: plan.state.turns.filter(turn => openingSpeechIds.has(turn.speechId)), reviewedRuns: [openingRun], boundaryEvidence },
  }
}

/** Independent, observational review of the boundary exchange and interruption controls. */
export function buildBoundaryExchangeShadowReview(review: NonNullable<ReturnType<typeof buildOpeningSpeakerReview>>) {
  const questions: SpeakerDecisionPlan['questions'] = {}
  const targets = Object.keys(review.questions).filter(id => id.startsWith('relationship_'))
  for (const id of targets) {
    const speechId = id.slice('relationship_'.length)
    questions[`boundary_${speechId}`] = {
      type: 'choice',
      instructions: `Identify who actually speaks ${speechId} in the current opening. Read the complete previous exchange and current opening as a conversation: track who addresses whom across the message boundary, who responds, who continues, and whether another person interrupts. Consider narration, pronouns, actions, topic and later clarification together. A repeated word may be a response to the earlier message, not the immediately preceding quotation. A person mentioned or addressed is not necessarily the speaker. Choose no_clear_identity if the evidence does not establish the speaker.`,
      criteria: review.questions[id].criteria,
    }
    questions[`retrospective_${speechId}`] = {
      type: 'choice',
      instructions: `Identify the actual speaker of ${speechId} in the current opening. First read the entire opening and preceding exchange, then re-read ${speechId} in light of later explicit names, self-introductions, speech attributions, actions, pronouns and continuity of conversation. A later named speaker may clarify an earlier unnamed speaker, but do not assume they are the same: check for interruptions, speaker changes, new arrivals, scene and channel changes, and narration identifying someone else. People addressed or mentioned are not necessarily speaking. Choose no_clear_identity when the evidence does not establish the speaker.`,
      criteria: review.questions[id].criteria,
    }
  }
  const controls = [
    { id: 'boundary_control_continuation', prior: 'I turn to Mira. "Sometimes you sacrifice for a friend."', current: '"Sacrifice." Mira turns with her tray. "What are you sacrificing? The noodles?" A stranger steps aside. "No, I know what you mean."', target: 'What are you sacrificing? The noodles?' },
    { id: 'boundary_control_interruption', prior: 'I turn to Mira. "Sometimes you sacrifice for a friend."', current: '"Sacrifice," Mira says. Rowan steps between us. "What are you sacrificing? The noodles?" he asks. Mira shakes her head.', target: 'What are you sacrificing? The noodles?' },
    { id: 'boundary_control_reply', prior: 'I turn to Mira. "Are you coming?"', current: '"Yes," Mira says. Rowan sets down his cup. "I am staying," he replies.', target: 'I am staying,' },
    { id: 'boundary_control_unclear', prior: 'I turn to Mira. "Are you coming?"', current: '"Maybe." A door opens. "I am staying."', target: 'I am staying.' },
    { id: 'retrospective_control_introduction', prior: 'I ask the woman, "Where do you live?"', current: '"Bishop. Third floor." She balances her tray. "It is noisy, though." She sits down. "Mira. Mira Lee. Nice to meet you."', target: 'Bishop. Third floor.' },
    { id: 'retrospective_control_interruption', prior: 'I ask the woman, "Where do you live?"', current: '"Bishop. Third floor," Rowan answers. The woman sets her tray down. "Mira. Mira Lee. Nice to meet you," she says.', target: 'Bishop. Third floor,' },
    { id: 'retrospective_control_unclear', prior: 'I ask the group, "Where do you live?"', current: '"Bishop. Third floor." Someone moves behind the table. "Mira. Mira Lee," the woman says.', target: 'Bishop. Third floor.' },
  ]
  for (const control of controls) questions[control.id] = {
    type: 'choice',
    instructions: `Use only the prior and current texts of synthetic control ${control.id}; identify who says its target quotation. Do not use the chat or other controls.`,
    criteria: { mira: 'Mira', rowan: 'Rowan', no_clear_identity: 'Cannot establish the speaker' },
  }
  return {
    state: { previousMessages: review.state.previousMessages, message: review.state.message, paragraphs: review.state.paragraphs, speeches: review.state.speeches, boundaryEvidence: review.state.boundaryEvidence, controls },
    questions,
    targetIds: targets.map(id => `boundary_${id.slice('relationship_'.length)}`),
    retrospectiveTargetIds: targets.map(id => `retrospective_${id.slice('relationship_'.length)}`),
    expectedControls: { boundary_control_continuation: 'mira', boundary_control_interruption: 'rowan', boundary_control_reply: 'rowan', boundary_control_unclear: 'no_clear_identity', retrospective_control_introduction: 'mira', retrospective_control_interruption: 'rowan', retrospective_control_unclear: 'no_clear_identity' },
  }
}

/** Reconcile an explicitly evaluated single-speaker opening without blanket inheritance. */
export function applyOpeningExchangeReview(plan: SpeakerDecisionPlan, answers: Record<string, SpeakerDecisionChoice>, reviewed: Record<string, SpeakerDecisionChoice>): void {
  const run = plan.state.runs.find(item => item.speechIds.includes('s0'))
  if (!run || run.speechIds.length < 2) return
  for (const id of run.speechIds) {
    if (!answers[`global_uncertain_${id}`]) continue
    if (reviewed.opening_exchange_pattern) answers[`opening_pattern_${id}`] = reviewed.opening_exchange_pattern
    if (reviewed.opening_exchange_speaker) answers[`opening_speaker_${id}`] = reviewed.opening_exchange_speaker
  }
  const pattern = evaluateSpeakerDecisionAnswer(reviewed.opening_exchange_pattern, { single_speaker: 'single_speaker', multiple_speakers: 'multiple_speakers' }, { probability: 0.85, confidence: 0.8, margin: 0.3 })
  const identity = evaluateSpeakerDecisionAnswer(reviewed.opening_exchange_speaker, plan.optionSpeakerIds, { probability: 0.85, confidence: 0.8, margin: 0.3 }).identity
  if (pattern.identity !== 'single_speaker' || !identity || identity === UNCAST_SPEAKER_ID) return
  if (identity === USER_SPEAKER_ID && plan.state.messageRole === 'assistant'
    && run.speechIds.some(id => answers[`global_uncertain_${id}`] && answers.persona_phase_complete && !answers[`persona_confirmed_${id}`])) return
  const speakers = plan.state.speakers.map(speaker => ({ id: speaker.id, name: speaker.name }))
  for (const id of run.speechIds) {
    const speech = plan.state.speeches.find(item => item.id === id)
    if (!speech) return
    const explicit = narrativeAttributionSpeaker(`${speech.narrativeBefore} ${speech.narrativeAfter}`, speakers)
    if (explicit && explicit !== identity) return
    const existing = evaluateSpeakerDecisionAnswer(answers[`speech_${id}`], plan.optionSpeakerIds).identity
    if (!answers[`global_uncertain_${id}`] && existing && existing !== UNCAST_SPEAKER_ID && existing !== identity) return
    const reviewIdentity = evaluateSpeakerDecisionAnswer(reviewed[`relationship_${id}`], plan.optionSpeakerIds).identity
    if (reviewIdentity && reviewIdentity !== UNCAST_SPEAKER_ID && reviewIdentity !== identity) return
  }
  for (const id of run.speechIds) {
    if (!answers[`global_uncertain_${id}`]) continue
    const choice = reviewed.opening_exchange_speaker
    answers[`relationship_original_${id}`] = answers[`speech_${id}`]
    answers[`speech_${id}`] = choice
    answers[`relationship_exchange_${id}`] = choice
    answers[`relationship_continuity_${id}`] = choice
    answers[`relationship_global_${id}`] = choice
    delete answers[`global_uncertain_${id}`]
  }
}

/** Ask for per-quote links to nearby, contextually validated speakers in the same run. */
export function buildOpeningBacklinkReview(plan: SpeakerDecisionPlan, answers: Record<string, SpeakerDecisionChoice>, context: RelationshipReviewContext, cardSpeakerId: string | null) {
  const base = buildOpeningSpeakerReview(plan, answers, context, cardSpeakerId)
  const run = plan.state.runs.find(item => item.speechIds.includes('s0'))
  if (!base || !run) return null
  const questions: SpeakerDecisionPlan['questions'] = {}
  const links: Record<string, { targetId: string; anchorId: string; identity: string }> = {}
  const pairEvidence: Record<string, { target: string; anchor: string; between: string }> = {}
  const speakers = plan.state.speakers.map(speaker => ({ id: speaker.id, name: speaker.name }))
  const quotes = playbackQuotes(plan.state.message)
  for (const [index, targetId] of run.speechIds.entries()) {
    if (!answers[`global_uncertain_${targetId}`] || Object.keys(questions).length >= 12) continue
    const target = plan.state.speeches.find(speech => speech.id === targetId)
    if (!target) continue
    const directions = [
      { prefix: 'forwardlink', candidates: run.speechIds.slice(Math.max(0, index - 3), index).reverse(), earlier: true },
      { prefix: 'backlink', candidates: run.speechIds.slice(index + 1, index + 4), earlier: false },
    ]
    for (const direction of directions) for (const anchorId of direction.candidates) {
      if (Object.keys(questions).length >= 12) break
      if (answers[`global_uncertain_${anchorId}`]) continue
      const identity = evaluateSpeakerDecisionAnswer(answers[`speech_${anchorId}`], plan.optionSpeakerIds).identity
      if (!identity || identity === UNCAST_SPEAKER_ID) continue
      // A known intervening person without contextual validation is not a
      // usable anchor, nor may it be skipped to reach someone further away.
      if (!answers[`relationship_applied_${anchorId}`] && !answers[`relationship_confirmed_${anchorId}`]) break
      const explicit = narrativeAttributionSpeaker(`${target.narrativeBefore} ${target.narrativeAfter}`, speakers)
      if (explicit && explicit !== identity) break
      const id = `${direction.prefix}_${targetId}`
      questions[id] = {
        type: 'choice',
        instructions: `Do quotations ${targetId} and ${anchorId} in pairEvidence have the same actual speaker? Both quotations are from the CURRENT message. boundaryEvidence, if present, separately shows the final quotation from the PREVIOUS message, its surrounding narration and the current opening. Do not confuse an echo or response in the current opening with the earlier quotation or automatically assign it to the earlier speaker. The ${direction.earlier ? 'earlier' : 'later'} quotation ${anchorId} has a provisional supported identity, but that is not proof about ${targetId}. Read the preceding exchange and all intervening text and speech. Consider topic, pronouns, actions, turn changes, new entrants, channels and later clarification. A person addressed or merely passing by is not automatically speaking. Choose same only when the link is clear; otherwise choose different_or_unclear.`,
        criteria: { same: 'Both quotations are spoken by the same person.', different_or_unclear: 'They have different speakers or the evidence is not clear.' },
      }
      links[id] = { targetId, anchorId, identity }
      const targetIndex = plan.state.speeches.findIndex(speech => speech.id === targetId)
      const anchorIndex = plan.state.speeches.findIndex(speech => speech.id === anchorId)
      const targetQuote = quotes[targetIndex]
      const anchorQuote = quotes[anchorIndex]
      pairEvidence[id] = { target: target.text, anchor: plan.state.speeches[anchorIndex]?.text ?? '', between: targetQuote && anchorQuote ? plan.state.message.slice(direction.earlier ? anchorQuote.end : targetQuote.end, direction.earlier ? targetQuote.start : anchorQuote.start).slice(0, 4_000) : '' }
      break
    }
  }
  if (!Object.keys(questions).length) return null
  return { state: { ...base.state, backlinkCandidates: links, pairEvidence }, questions, links }
}

/** Build an isolated three-way formulation and unlabeled synthetic controls. */
export function buildContrastiveOpeningLinkReview(review: NonNullable<ReturnType<typeof buildOpeningBacklinkReview>>) {
  const questions: SpeakerDecisionPlan['questions'] = {}
  const criteria = { same: 'The same person speaks both quotations.', different: 'Different people speak the quotations.', no_clear_identity: 'The evidence does not establish whether the speakers are the same.' }
  for (const [id, link] of Object.entries(review.links)) {
    questions[id] = {
      type: 'choice',
      instructions: `Compare the two current-message quotations in pairEvidence.${id}: target ${link.targetId} and anchor ${link.anchorId}. Decide whether the actual speakers are the same or different, or whether that cannot be established. Read the intervening narration and previous exchange, including who is addressed, who acts, pronouns and topic. A response or repeated word does not itself establish either same or different speakers. The anchor identity is a provisional clue, not proof.`,
      criteria,
    }
    questions[`focused_${id}`] = {
      type: 'choice',
      instructions: `Compare ONLY the actual speakers of current-message target ${link.targetId} and anchor ${link.anchorId}, using pairEvidence.${id} and the full current opening for the text surrounding both quotes. Follow the person who speaks the target through the intervening narration and dialogue: who acts, handles the same objects, is addressed, introduces themselves, or is explicitly attributed later? A later self-introduction or attribution can clarify an earlier unnamed speaker, but a name or pronoun alone cannot establish continuity. Consider whether an interruption, speaker change, a different person acting, or a new scene or channel breaks the link. The anchor identity is provisional, and the preceding user message is context, not the target speaker. Choose same, different, or no_clear_identity; do not guess.`,
      criteria,
    }
  }
  const controls = [
    { id: 'control_continuation', text: '"Rain," Mira says. She looks at the clouds. "The washing will get wet."', first: 'Rain,', second: 'The washing will get wet.' },
    { id: 'control_reply', text: '"Tea?" Mira asks. Rowan shakes his head. "Coffee, please," he replies.', first: 'Tea?', second: 'Coffee, please,' },
    { id: 'control_uncertain', text: '"Wait." Someone moves behind the curtain. "Is the door open?"', first: 'Wait.', second: 'Is the door open?' },
    { id: 'focused_control_introduction', text: '"Bishop. Third floor." She balances her tray. "It is noisy." She sits. "Mira. Mira Lee. Nice to meet you."', first: 'Bishop. Third floor.', second: 'Mira. Mira Lee. Nice to meet you.' },
    { id: 'focused_control_interruption', text: '"Bishop. Third floor," Rowan says. The woman sets down her tray. "Mira. Mira Lee. Nice to meet you," she says.', first: 'Bishop. Third floor,', second: 'Mira. Mira Lee. Nice to meet you,' },
    { id: 'focused_control_unclear', text: '"Bishop. Third floor." Someone moves behind the table. "Mira. Mira Lee," the woman says.', first: 'Bishop. Third floor.', second: 'Mira. Mira Lee,' },
  ]
  for (const control of controls) questions[control.id] = {
    type: 'choice',
    instructions: `Evaluate only the synthetic control ${control.id} in controls. Are its first and second quotations spoken by the same person, different people, or is that unclear? Do not use the chat or other controls as evidence.`,
    criteria,
  }
  return { state: { ...review.state, controls }, questions, expectedControls: { control_continuation: 'same', control_reply: 'different', control_uncertain: 'no_clear_identity', focused_control_introduction: 'same', focused_control_interruption: 'different', focused_control_unclear: 'no_clear_identity' } }
}

/** Apply only clear links to anchors that remain validated and unchanged. */
export function applyFocusedOpeningFallback(plan: SpeakerDecisionPlan, answers: Record<string, SpeakerDecisionChoice>, reviewed: Record<string, SpeakerDecisionChoice>, links: Record<string, { targetId: string; anchorId: string; identity: string }>, baseline: Record<string, SpeakerDecisionChoice>): void {
  const qualified: Record<string, SpeakerDecisionChoice> = {}
  for (const [id, link] of Object.entries(links)) {
    const focused = reviewed[`focused_${id}`]
    if (!focused || evaluateSpeakerDecisionAnswer(focused, { same: 'same', different: 'different', no_clear_identity: 'no_clear_identity' }, { probability: 0.65, confidence: 0.5, margin: 0.3 }).identity !== 'same') continue
    const conflicts = Object.entries(links).some(([otherId, other]) => {
      if (other.targetId !== link.targetId) return false
      const candidate = reviewed[`focused_${otherId}`]
      const direct = baseline[otherId]
      const focusedDecision = candidate && evaluateSpeakerDecisionAnswer(candidate, { same: 'same', different: 'different', no_clear_identity: 'no_clear_identity' }, { probability: 0.65, confidence: 0.5, margin: 0.3 }).identity
      const baselineDecision = direct && evaluateSpeakerDecisionAnswer(direct, { same: 'same', different_or_unclear: 'different_or_unclear' }, { probability: 0.85, confidence: 0.8, margin: 0.3 }).identity
      return (focusedDecision === 'same' && other.identity !== link.identity) || (focusedDecision === 'different' && other.identity === link.identity) || (baselineDecision === 'different_or_unclear' && other.identity === link.identity)
    })
    if (!conflicts) qualified[id] = focused
  }
  for (const [id, result] of Object.entries(qualified)) {
    const link = links[id]
    const anchor = answers[`speech_${link.anchorId}`]
    if (link.identity === USER_SPEAKER_ID && plan.state.messageRole === 'assistant' && answers.persona_phase_complete && !answers[`persona_confirmed_${link.targetId}`]) continue
    if (!answers[`global_uncertain_${link.targetId}`] || answers[`global_uncertain_${link.anchorId}`] || (!answers[`relationship_applied_${link.anchorId}`] && !answers[`relationship_confirmed_${link.anchorId}`]) || evaluateSpeakerDecisionAnswer(anchor, plan.optionSpeakerIds).identity !== link.identity) continue
    answers[`relationship_original_${link.targetId}`] = answers[`speech_${link.targetId}`]
    answers[`speech_${link.targetId}`] = anchor
    answers[`focused_fallback_${link.targetId}`] = result
    answers[`relationship_continuity_${link.targetId}`] = anchor
    answers[`relationship_global_${link.targetId}`] = anchor
    delete answers[`global_uncertain_${link.targetId}`]
  }
}

export function applyOpeningBacklinkReview(plan: SpeakerDecisionPlan, answers: Record<string, SpeakerDecisionChoice>, reviewed: Record<string, SpeakerDecisionChoice>, links: Record<string, { targetId: string; anchorId: string; identity: string }>): void {
  const checked: Array<{ id: string; link: { targetId: string; anchorId: string; identity: string }; decision: string | null; result: SpeakerDecisionChoice }> = []
  for (const [id, link] of Object.entries(links)) {
    const result = reviewed[id]
    if (!result) continue
    answers[`${id.startsWith('forwardlink_') ? 'forwardlink' : 'backlink'}_review_${link.targetId}`] = result
    const decision = evaluateSpeakerDecisionAnswer(result, { same: 'same', different_or_unclear: 'different_or_unclear' }, { probability: 0.85, confidence: 0.8, margin: 0.3 })
    const anchor = answers[`speech_${link.anchorId}`]
    if (link.identity === USER_SPEAKER_ID && plan.state.messageRole === 'assistant' && answers.persona_phase_complete && !answers[`persona_confirmed_${link.targetId}`]) continue
    if (!answers[`global_uncertain_${link.targetId}`] || answers[`global_uncertain_${link.anchorId}`] || (!answers[`relationship_applied_${link.anchorId}`] && !answers[`relationship_confirmed_${link.anchorId}`]) || evaluateSpeakerDecisionAnswer(anchor, plan.optionSpeakerIds).identity !== link.identity) continue
    checked.push({ id, link, decision: decision.identity, result })
  }
  for (const { id, link, result } of checked.filter(item => item.decision === 'same')) {
    if (checked.some(other => other.link.targetId === link.targetId && ((other.decision === 'same' && other.link.identity !== link.identity) || (other.decision === 'different_or_unclear' && other.link.identity === link.identity)))) continue
    if (!answers[`global_uncertain_${link.targetId}`]) continue
    const anchor = answers[`speech_${link.anchorId}`]
    answers[`relationship_original_${link.targetId}`] = answers[`speech_${link.targetId}`]
    answers[`speech_${link.targetId}`] = anchor
    answers[`relationship_${id.startsWith('forwardlink_') ? 'forwardlink' : 'backlink'}_${link.targetId}`] = result
    answers[`relationship_continuity_${link.targetId}`] = anchor
    answers[`relationship_global_${link.targetId}`] = anchor
    delete answers[`global_uncertain_${link.targetId}`]
  }
}

/** A strong independent decision is required before relationship evidence changes routing. */
export function applyRelationshipSpeakerReview(plan: SpeakerDecisionPlan, answers: Record<string, SpeakerDecisionChoice>, reviewed: Record<string, SpeakerDecisionChoice>, ghostOptions: Record<string, string>, cardSpeakerId: string | null = null, continuitySpeakerId: string | null = null, globalMode = false): void {
  const options = { ...plan.optionSpeakerIds, ...ghostOptions }
  if (globalMode) Object.assign(plan.optionSpeakerIds, ghostOptions)
  if (globalMode && reviewed.boundary_relation) answers.boundary_relation = reviewed.boundary_relation
  if (globalMode && reviewed.boundary_addressee) answers.boundary_addressee = reviewed.boundary_addressee
  if (globalMode) for (const run of plan.state.runs) {
    if (reviewed[`run_channel_${run.id}`]) answers[`run_channel_${run.id}`] = reviewed[`run_channel_${run.id}`]
    if (reviewed[`run_participant_${run.id}`]) answers[`run_participant_${run.id}`] = reviewed[`run_participant_${run.id}`]
  }
  const scene = reviewed.relationship_scene
  const sceneEvaluation = scene ? evaluateSpeakerDecisionAnswer(scene, options, { probability: 0.6, confidence: 0.45, margin: 0.3 }) : null
  const sceneOptionIdentity = scene ? options[scene.choice] : null
  const sceneIdentity = (!cardSpeakerId || (continuitySpeakerId && sceneOptionIdentity === continuitySpeakerId)) && scene && sceneOptionIdentity && sceneEvaluation?.leadingChoice === scene.choice
    ? sceneEvaluation.identity : null
  const speakers = plan.state.speakers.map(speaker => ({ id: speaker.id, name: speaker.name }))
  const conflictingAttribution = plan.state.speeches.some(speech => narrativeAttributionSpeaker(`${speech.narrativeBefore} ${speech.narrativeAfter}`, speakers))
  const conflictingTurn = plan.state.turns.some(turn => {
    const answer = answers[`turn_${turn.speechId}`]
    return !!answer && (answer.choice === TURN_RESPOND_OPTION || answer.choice === TURN_OTHER_OPTION) && answer.confidence >= 0.65 && (answer.probabilities[answer.choice] ?? 0) >= 0.7
  })
  const otherNamedSpeakers = speakers.filter(speaker => speaker.id !== USER_SPEAKER_ID && speaker.id !== continuitySpeakerId && !/^(?:what|who|where|when|why|how)$/iu.test(speaker.name.trim()))
  const namedChange = otherNamedSpeakers.length > 0 && hasNamedSpeakerSubject(plan.state.message, otherNamedSpeakers)
  const newUncastSubject = hasExplicitUncastCue(plan.state.message, '')
  const continuityOption = Object.entries(options).find(([, id]) => id === continuitySpeakerId)?.[0]
  const cardOption = Object.entries(options).find(([, id]) => id === cardSpeakerId)?.[0]
  const sceneContradicts = scene && scene.choice !== 'no_clear_identity' && sceneOptionIdentity !== continuitySpeakerId && sceneEvaluation?.resolved
  const cardAlternatives = speakers.filter(speaker => speaker.id !== USER_SPEAKER_ID && speaker.id !== cardSpeakerId)
  const cardNamedChange = cardAlternatives.length > 0 && hasNamedSpeakerSubject(plan.state.message, cardAlternatives)
  const preferredCard = cardOption && !cardNamedChange && !newUncastSubject && !conflictingAttribution && !conflictingTurn
    ? { choice: cardOption, probabilities: { [cardOption]: 1 }, confidence: 1 } : null
  const inherited = !preferredCard && continuityOption && !namedChange && !newUncastSubject && !conflictingAttribution && !conflictingTurn && !sceneContradicts
    ? { choice: continuityOption, probabilities: { [continuityOption]: 1 }, confidence: 1 } : null
  for (const speech of plan.state.speeches) {
    const result = reviewed[`relationship_${speech.id}`]
    const original = answers[`speech_${speech.id}`]
    const originalIdentity = evaluateSpeakerDecisionAnswer(original, plan.optionSpeakerIds).identity
    if (globalMode) {
      const reference = reviewed[`scene_reference_${speech.id}`]
      const secondary = reviewed[`scene_secondary_${speech.id}`]
      const link = reviewed[`scene_link_${speech.id}`]
      if (reference) answers[`scene_reference_${speech.id}`] = reference
      if (secondary) answers[`scene_secondary_${speech.id}`] = secondary
      if (link) answers[`scene_link_${speech.id}`] = link
      const referenceIdentity = evaluateSpeakerDecisionAnswer(reference, options, { probability: 0.8, confidence: 0.75, margin: 0.3 }).identity
      const linkIdentity = evaluateSpeakerDecisionAnswer(link, { same_speaker: 'same_speaker', different_person: 'different_person' }, { probability: 0.85, confidence: 0.8, margin: 0.3 }).identity
      const speechIdentity = evaluateSpeakerDecisionAnswer(result, options).identity
      if ((!originalIdentity || originalIdentity === UNCAST_SPEAKER_ID) && reference && referenceIdentity && referenceIdentity !== UNCAST_SPEAKER_ID && linkIdentity === 'same_speaker' && (!speechIdentity || speechIdentity === referenceIdentity)) {
        Object.assign(plan.optionSpeakerIds, ghostOptions)
        if (original) answers[`relationship_original_${speech.id}`] = original
        if (result) answers[`relationship_review_${speech.id}`] = result
        answers[`speech_${speech.id}`] = reference
        answers[`relationship_applied_${speech.id}`] = reference
        answers[`relationship_global_${speech.id}`] = reference
        answers[`relationship_continuity_${speech.id}`] = reference
        answers[`scene_applied_${speech.id}`] = reference
        continue
      }
    }
    const chosen = globalMode ? null : preferredCard || inherited || (sceneIdentity && !conflictingAttribution && !conflictingTurn ? scene : null)
    if (chosen) {
      Object.assign(plan.optionSpeakerIds, ghostOptions)
      if (original) answers[`relationship_original_${speech.id}`] = original
      answers[`speech_${speech.id}`] = chosen
      answers[`relationship_review_${speech.id}`] = chosen
      answers[`relationship_applied_${speech.id}`] = chosen
      answers[`relationship_continuity_${speech.id}`] = chosen
      if (inherited) answers[`relationship_inherited_${speech.id}`] = chosen
      continue
    }
    if (!result) continue
    answers[`relationship_review_${speech.id}`] = result
    // Agreement is not an override. Apply the ordinary acceptance gates to a
    // confirming review, rather than the stricter gates for changing identity.
    // Missing, unclear or conflicting reviews still follow the uncertainty path.
    const localOriginal = evaluateSpeakerDecisionAnswer(original, plan.optionSpeakerIds, { probability: 0.6, confidence: 0.55, margin: 0.3 }).identity
    const weakAgreement = evaluateSpeakerDecisionAnswer(result, options, { probability: 0.45, confidence: 0.4, margin: 0.05 }).identity
    const explicitAttribution = narrativeAttributionSpeaker(`${speech.narrativeBefore} ${speech.narrativeAfter}`, speakers)
    const confirmingIdentity = evaluateSpeakerDecisionAnswer(result, options, SPEAKER_DECISION_THRESHOLDS.local).identity
      ?? (localOriginal && (localOriginal !== USER_SPEAKER_ID || plan.state.messageRole === 'user') && weakAgreement === localOriginal && (!explicitAttribution || explicitAttribution === localOriginal) ? localOriginal : null)
    if (globalMode && plan.state.messageRole === 'assistant' && answers.persona_phase_complete
      && !answers[`persona_confirmed_${speech.id}`]
      && explicitAttribution !== USER_SPEAKER_ID
      && (confirmingIdentity === USER_SPEAKER_ID || evaluateSpeakerDecisionAnswer(result, options).identity === USER_SPEAKER_ID)) {
      answers[`global_uncertain_${speech.id}`] = result
      continue
    }
    if (globalMode && originalIdentity && originalIdentity !== UNCAST_SPEAKER_ID && confirmingIdentity === originalIdentity) {
      delete answers[`global_uncertain_${speech.id}`]
      answers[`relationship_confirmed_${speech.id}`] = result
      continue
    }
    const reviewedIdentity = evaluateSpeakerDecisionAnswer(result, options, globalMode && (!originalIdentity || originalIdentity === UNCAST_SPEAKER_ID) ? SPEAKER_DECISION_THRESHOLDS.local : { probability: 0.85, confidence: 0.8, margin: 0.3 }).identity
    if (globalMode && !reviewedIdentity && (!originalIdentity || originalIdentity === UNCAST_SPEAKER_ID || explicitAttribution !== originalIdentity)) {
      answers[`global_uncertain_${speech.id}`] = result
    }
    if (!reviewedIdentity || reviewedIdentity === originalIdentity) continue
    if (originalIdentity && originalIdentity !== UNCAST_SPEAKER_ID) {
      if (narrativeAttributionSpeaker(`${speech.narrativeBefore} ${speech.narrativeAfter}`, speakers) === originalIdentity) continue
    }
    Object.assign(plan.optionSpeakerIds, ghostOptions)
    if (original) answers[`relationship_original_${speech.id}`] = original
    delete answers[`global_uncertain_${speech.id}`]
    answers[`speech_${speech.id}`] = result
    answers[`relationship_applied_${speech.id}`] = result
    if (globalMode) answers[`relationship_global_${speech.id}`] = result
    if (globalMode || reviewedIdentity === continuitySpeakerId) answers[`relationship_continuity_${speech.id}`] = result
  }
}

/** Carry a clearly established speaker into an unresolved closing line when
 * a bystander merely enters, rather than attributing speech to that person. */
export function continueUncastClosingSpeech(plan: SpeakerDecisionPlan, answers: Record<string, SpeakerDecisionChoice>): void {
  const speeches = plan.state.speeches
  if (speeches.length < 3) return
  const last = speeches.at(-1)!
  const previous = speeches.at(-2)!
  const before = speeches.at(-3)!
  const current = evaluateSpeakerDecisionAnswer(answers[`speech_${last.id}`], plan.optionSpeakerIds).identity
  const previousAnswer = answers[`speech_${previous.id}`]
  const previousId = evaluateSpeakerDecisionAnswer(previousAnswer, plan.optionSpeakerIds).identity
  const beforeId = evaluateSpeakerDecisionAnswer(answers[`speech_${before.id}`], plan.optionSpeakerIds).identity
  if ((current !== UNCAST_SPEAKER_ID && current !== null) || !previousId || previousId === UNCAST_SPEAKER_ID || previousId === USER_SPEAKER_ID || previousId !== beforeId || !previousAnswer) return
  const start = plan.state.paragraphs.findIndex(paragraph => paragraph.id === previous.paragraphId)
  const end = plan.state.paragraphs.findIndex(paragraph => paragraph.id === last.paragraphId)
  const bridge = plan.state.turns.find(turn => turn.speechId === last.id)?.bridge || (start >= 0 && end >= start ? plan.state.paragraphs.slice(start + 1, end + 1).map(paragraph => paragraph.text).join('\n\n') : last.narrativeBefore)
  const turn = answers[`turn_${last.id}`]
  if (!/\b(?:enter(?:s|ed|ing)?|arriv(?:es|ed|ing)|steps?|mov(?:es|ed|ing)|walks?)\b/iu.test(bridge)
    || hasAnonymousSpeechAttribution(bridge) || narrativeAttributionSpeaker(bridge, plan.state.speakers) || (turn && turn.confidence >= 0.65 && (turn.choice === TURN_RESPOND_OPTION || turn.choice === TURN_OTHER_OPTION))) return
  answers[`relationship_original_${last.id}`] = answers[`speech_${last.id}`]
  answers[`speech_${last.id}`] = previousAnswer
  answers[`relationship_applied_${last.id}`] = previousAnswer
  answers[`relationship_continuity_${last.id}`] = previousAnswer
}

export type TtsTagStyle = 'off' | 'gemini' | 'gemini38' | 'fish'

export interface TtsTagThresholds {
  probability: number
  confidence: number
  margin: number
}

export const TTS_TAG_THRESHOLDS: TtsTagThresholds = {
  probability: 0.65,
  confidence: 0.6,
  margin: 0.2,
}

export const TTS_TAG_POSITION_THRESHOLDS: TtsTagThresholds = {
  probability: 0.5,
  confidence: 0.5,
  margin: 0.1,
}

/**
 * Internal marker used only between Jev and the Fish placement LLM. It is
 * replaced by the generated modulation tag, or removed on fallback, before
 * any text reaches TTS.
 */
export const TTS_MODULATION_MARKER = '[modulationmarker]'

/**
 * The primary emotion is mandatory, but a weak winner falls back to calm
 * instead of forcing an arbitrary expression onto the line.
 */
export const TTS_EMOTION_THRESHOLDS: TtsTagThresholds = {
  probability: 0.4,
  confidence: 0.35,
  margin: 0.1,
}

export interface TtsTagOption {
  value: string
  description: string
}

/**
 * Sentence-level emotions. Fish S2 documents this vocabulary directly; legacy
 * Gemini accepts the same square-bracket cues as natural-language style
 * descriptors. Gemini 3.8 has no inline emotion cue.
 */
export const TTS_EMOTION_OPTIONS: readonly TtsTagOption[] = [
  { value: 'happy', description: 'Cheerful, upbeat.' },
  { value: 'sad', description: 'Melancholic, downcast.' },
  { value: 'angry', description: 'Frustrated or aggressive.' },
  { value: 'excited', description: 'Energetic and enthusiastic.' },
  { value: 'calm', description: 'Peaceful and relaxed.' },
  { value: 'nervous', description: 'Anxious and uncertain.' },
  { value: 'confident', description: 'Assertive and self-assured.' },
  { value: 'surprised', description: 'Shocked or amazed.' },
  { value: 'satisfied', description: 'Content and pleased.' },
  { value: 'delighted', description: 'Very pleased and joyful.' },
  { value: 'scared', description: 'Frightened or fearful.' },
  { value: 'worried', description: 'Concerned and troubled.' },
  { value: 'upset', description: 'Disturbed or distressed.' },
  { value: 'frustrated', description: 'Annoyed or exasperated.' },
  { value: 'depressed', description: 'Very sad and hopeless.' },
  { value: 'empathetic', description: 'Understanding and caring.' },
  { value: 'embarrassed', description: 'Ashamed or awkward.' },
  { value: 'disgusted', description: 'Repelled or revolted.' },
  { value: 'moved', description: 'Emotionally touched.' },
  { value: 'proud', description: 'Accomplished and pleased.' },
  { value: 'relaxed', description: 'At ease and casual.' },
  { value: 'grateful', description: 'Thankful and appreciative.' },
  { value: 'curious', description: 'Inquisitive and interested.' },
  { value: 'sarcastic', description: 'Ironic or mocking.' },
  { value: 'disdainful', description: 'Contemptuous or scornful.' },
  { value: 'unhappy', description: 'Discontent or dissatisfied.' },
  { value: 'anxious', description: 'Very worried and uneasy.' },
  { value: 'hysterical', description: 'Uncontrollably emotional.' },
  { value: 'indifferent', description: 'Uncaring or neutral.' },
  { value: 'uncertain', description: 'Doubtful or unsure.' },
  { value: 'doubtful', description: 'Skeptical or questioning.' },
  { value: 'confused', description: 'Puzzled or perplexed.' },
  { value: 'disappointed', description: 'Let down or dissatisfied.' },
  { value: 'regretful', description: 'Sorry or remorseful.' },
  { value: 'guilty', description: 'Culpable or responsible.' },
  { value: 'ashamed', description: 'Deeply embarrassed.' },
  { value: 'jealous', description: 'Envious or resentful.' },
  { value: 'envious', description: 'Wanting what others have.' },
  { value: 'hopeful', description: 'Optimistic about the future.' },
  { value: 'optimistic', description: 'Positive outlook.' },
  { value: 'pessimistic', description: 'Negative outlook.' },
  { value: 'nostalgic', description: 'Longing for the past.' },
  { value: 'lonely', description: 'Isolated or alone.' },
  { value: 'bored', description: 'Uninterested or weary.' },
  { value: 'contemptuous', description: 'Showing contempt.' },
  { value: 'sympathetic', description: 'Showing sympathy.' },
  { value: 'compassionate', description: 'Showing deep care.' },
  { value: 'determined', description: 'Resolved and decided.' },
  { value: 'resigned', description: 'Accepting defeat.' },
] as const

/**
 * The 24 basic emotions are the automatic Jev menu. Keeping the menu smaller
 * lets the Decision provider return a complete distribution that sums to one.
 * Existing cues using any of the 49 documented emotions are still recognized.
 */
const TTS_AUTO_EMOTION_VALUES = new Set([
  'happy', 'sad', 'angry', 'excited', 'calm', 'nervous', 'confident', 'surprised',
  'satisfied', 'delighted', 'scared', 'worried', 'upset', 'frustrated', 'depressed',
  'empathetic', 'embarrassed', 'disgusted', 'moved', 'proud', 'relaxed', 'grateful',
  'curious', 'sarcastic',
])
export const TTS_AUTO_EMOTION_OPTIONS: readonly TtsTagOption[] = TTS_EMOTION_OPTIONS
  .filter(option => TTS_AUTO_EMOTION_VALUES.has(option.value))

/** Last-resort menu used only when the basic menu still fails validation. */
const TTS_COMPACT_EMOTION_VALUES = new Set([
  'happy', 'sad', 'angry', 'excited', 'calm', 'nervous',
  'scared', 'worried', 'moved', 'frustrated', 'confident', 'surprised',
])
export const TTS_COMPACT_EMOTION_OPTIONS: readonly TtsTagOption[] = TTS_EMOTION_OPTIONS
  .filter(option => TTS_COMPACT_EMOTION_VALUES.has(option.value))

/** Optional momentary sound effects. */
export const TTS_TAG_OPTIONS: readonly TtsTagOption[] = [
  { value: 'laugh', description: 'A brief laugh.' },
  { value: 'chuckle', description: 'A soft, low laugh.' },
  { value: 'giggle', description: 'A light, high giggle.' },
  { value: 'snicker', description: 'A half-suppressed laugh.' },
  { value: 'cackle', description: 'A sharp, harsh laugh.' },
  { value: 'cheer', description: 'A short cheer or whoop.' },
  { value: 'gasp', description: 'A sharp intake of breath.' },
  { value: 'sigh', description: 'A long exhale of relief, frustration, or resignation.' },
  { value: 'groan', description: 'A low sound of pain or dismay.' },
  { value: 'grunt', description: 'A short, effortful grunt.' },
  { value: 'grr', description: 'A low, frustrated growl-like sound.' },
  { value: 'growl', description: 'A menacing growl.' },
  { value: 'hiss', description: 'A sharp hiss.' },
  { value: 'moan', description: 'A low moan of pain or pleasure.' },
  { value: 'pant', description: 'A few panting breaths.' },
  { value: 'pff', description: 'A dismissive puff of breath.' },
  { value: 'phew', description: 'A relieved phew.' },
  { value: 'tsk', description: 'A disapproving tsk.' },
  { value: 'whispers', description: 'A whispered delivery.' },
  { value: 'shout', description: 'A sudden shout.' },
  { value: 'argh', description: 'A frustrated argh.' },
  { value: 'whimper', description: 'A small whimper.' },
  { value: 'cry', description: 'A brief cry.' },
  { value: 'sob', description: 'A sob.' },
  { value: 'scream', description: 'A scream.' },
  { value: 'shriek', description: 'A high shriek.' },
  { value: 'snort', description: 'A snort of amusement or contempt.' },
  { value: 'breath', description: 'A single audible breath.' },
  { value: 'heavy breath', description: 'A heavy breath.' },
  { value: 'exhales', description: 'A deliberate exhale.' },
  { value: 'cough', description: 'A cough.' },
  { value: 'throat-clearing', description: 'A throat-clearing sound.' },
  { value: 'sneeze', description: 'A sneeze.' },
  { value: 'yawn', description: 'A yawn.' },
  { value: 'snore', description: 'A sleeping snore.' },
] as const

export interface TtsPauseOption {
  value: 'short' | 'long'
  label: string
  description: string
}

export const TTS_PAUSE_OPTIONS: readonly TtsPauseOption[] = [
  { value: 'short', label: 'Short pause', description: 'A brief dramatic pause.' },
  { value: 'long', label: 'Long pause', description: 'An extended dramatic pause.' },
] as const

/** Fish S2 leading voice-style cues. These apply to the speech, not one word. */
export const TTS_STYLE_OPTIONS: readonly TtsTagOption[] = [
  { value: 'whispering', description: 'Hushed and breathy.' },
  { value: 'soft voice', description: 'Quiet and gentle.' },
  { value: 'low voice', description: 'A deeper register.' },
  { value: 'loud voice', description: 'Raised volume without shouting.' },
  { value: 'shouting', description: 'Full-volume shouting.' },
  { value: 'screaming', description: 'Panicked or extreme volume.' },
] as const

/** Styles that must lead the speech instead of being placed as momentary sounds. */
const TTS_STYLE_LIKE_SOUNDS = new Set(['whispers', 'shout', 'scream'])

export const TTS_FISH_SOUND_OPTIONS: readonly TtsTagOption[] = TTS_TAG_OPTIONS
  .filter(option => !TTS_STYLE_LIKE_SOUNDS.has(option.value))

/** Gemini 3.8 documents these vocal events; snore is not in its tag list. */
export const TTS_GEMINI38_SOUND_OPTIONS: readonly TtsTagOption[] = TTS_TAG_OPTIONS
  .filter(option => option.value !== 'snore')

const TTS_EMOTION_NAMES = new Set(TTS_EMOTION_OPTIONS.map(option => option.value))
const TTS_SOUND_NAMES = new Set(TTS_TAG_OPTIONS.map(option => option.value))
const TTS_PAUSE_NAMES = new Set<string>(TTS_PAUSE_OPTIONS.map(option => option.value))
const TTS_STYLE_NAMES = new Set(TTS_STYLE_OPTIONS.map(option => option.value))
const TTS_TAG_ALIASES = new Map<string, string>([
  // Sound aliases.
  ['laughter', 'laugh'], ['laughs', 'laugh'], ['laughing', 'laugh'],
  ['chuckles', 'chuckle'], ['chuckling', 'chuckle'], ['giggles', 'giggle'],
  ['snickers', 'snicker'], ['cackles', 'cackle'], ['cheers', 'cheer'],
  ['gasps', 'gasp'], ['gasping', 'gasp'], ['sighs', 'sigh'], ['sighing', 'sigh'],
  ['groans', 'groan'], ['groaning', 'groan'], ['grunts', 'grunt'], ['growls', 'growl'],
  ['hisses', 'hiss'], ['moans', 'moan'], ['pants', 'pant'], ['panting', 'pant'],
  ['whisper', 'whispering'], ['whispering', 'whispering'],
  ['shouts', 'shout'], ['shouting', 'shouting'], ['screaming', 'screaming'],
  ['cries', 'cry'], ['crying', 'cry'], ['crying loudly', 'cry'],
  ['sobs', 'sob'], ['sobbing', 'sob'],
  ['screams', 'scream'], ['shrieks', 'shriek'],
  ['snorts', 'snort'], ['breaths', 'breath'], ['inhale', 'breath'], ['exhale', 'exhales'],
  ['coughs', 'cough'], ['clear throat', 'throat-clearing'], ['clears throat', 'throat-clearing'],
  ['sneezes', 'sneeze'], ['yawns', 'yawn'], ['yawning', 'yawn'], ['snoring', 'snore'],
  // Style aliases.
  ['soft', 'soft voice'], ['loud', 'loud voice'], ['low', 'low voice'],
  // Pause aliases.
  ['break', 'short'], ['short pause', 'short'],
  ['long-break', 'long'], ['long pause', 'long'],
  // Emotion aliases used by common prompts.
  ['furious', 'angry'], ['terrified', 'scared'], ['ecstatic', 'excited'],
  ['relieved', 'calm'], ['enthusiastic', 'excited'], ['friendly', 'calm'],
  ['encouraging', 'hopeful'], ['mysterious', 'uncertain'],
])

const TTS_TAG_NAMES = new Set<string>([
  ...TTS_EMOTION_NAMES,
  ...TTS_SOUND_NAMES,
  ...TTS_PAUSE_NAMES,
  ...TTS_STYLE_NAMES,
])

const TTS_FISH_SOUND_MAP: Record<string, string> = {
  laugh: 'laughing',
  chuckle: 'chuckling',
  sob: 'sobbing',
  cry: 'crying',
  sigh: 'sigh',
  groan: 'groan',
  pant: 'panting',
  gasp: 'gasp',
  yawn: 'yawning',
  snore: 'snoring',
  'throat-clearing': 'clears throat',
  whispers: 'whispering',
  shout: 'shouting',
  scream: 'screaming',
  breath: 'inhale',
  'heavy breath': 'panting',
  exhales: 'exhale',
}

const TTS_TAG_TOKEN_RE = /\[\s*([a-z][a-z -]*?)\s*\]|<\s*([a-z][a-z -]*?)\s*>/giu

export type TtsTagCategory = 'emotion' | 'style' | 'sound' | 'pause'

export function normalizeTtsTagName(value: string): string | null {
  const tag = value.trim().toLowerCase()
  if (TTS_TAG_NAMES.has(tag)) return tag
  return TTS_TAG_ALIASES.get(tag) ?? null
}

export function ttsTagCategory(value: string): TtsTagCategory | null {
  const tag = normalizeTtsTagName(value)
  if (!tag) return null
  if (TTS_EMOTION_NAMES.has(tag)) return 'emotion'
  if (TTS_STYLE_NAMES.has(tag)) return 'style'
  if (TTS_PAUSE_NAMES.has(tag)) return 'pause'
  return 'sound'
}

/**
 * Fish S2 and the legacy Gemini path use bracket cues. Gemini 3.8 uses
 * angle-bracket vocal events and pauses, and has no inline emotion/style cue.
 */
export function formatTtsTag(tag: string, style: Exclude<TtsTagStyle, 'off'>): string {
  const canonical = normalizeTtsTagName(tag) ?? tag
  const category = ttsTagCategory(canonical)
  if (style === 'gemini38') {
    if (category === 'emotion' || category === 'style' || canonical === 'snore') return ''
    if (category === 'pause') {
      return canonical === 'long' ? '<long pause>' : '<short pause>'
    }
    return `<${canonical}>`
  }
  if (category === 'style') {
    return `[${canonical}]`
  }
  if (category === 'pause') {
    if (style === 'fish') {
      return canonical === 'long' ? '[long pause]' : '[short pause]'
    }
    return canonical === 'long' ? '[long-break]' : '[break]'
  }
  if (category === 'sound' && style === 'fish') {
    return `[${TTS_FISH_SOUND_MAP[canonical] ?? canonical}]`
  }
  return `[${canonical}]`
}

function replaceTtsTags(
  text: string,
  replacer: (tag: string, match: string) => string,
): string {
  return text.replace(TTS_TAG_TOKEN_RE, (match, square: string | undefined, angle: string | undefined) => {
    const tag = normalizeTtsTagName(square ?? angle ?? '')
    return tag ? replacer(tag, match) : match
  })
}

/** Normalize recognized tags to the requested provider style, preserving placement. */
export function normalizeTtsTags(text: string, style: Exclude<TtsTagStyle, 'off'>): string {
  return replaceTtsTags(text, (tag) => formatTtsTag(tag, style))
}

/** Remove recognized tags for validation and comparison. */
export function stripTtsTags(text: string): string {
  return replaceTtsTags(text, () => '')
}

export function extractTtsTags(text: string): string[] {
  const tags: string[] = []
  replaceTtsTags(text, (tag) => {
    tags.push(tag)
    return ''
  })
  return tags
}

export function countTtsTag(text: string, tag: string): number {
  let count = 0
  replaceTtsTags(text, (candidate) => {
    if (candidate === tag) count += 1
    return ''
  })
  return count
}

/**
 * Validate LLM placement for one speech: the leading emotion is unchanged,
 * and only the requested sound and pause cues may be added, each exactly once.
 * Removing all recognized tags must leave the original wording.
 */
export interface TtsSpeechPlacementRequest {
  emotions: string[]
  styles: string[]
  sounds: string[]
  pauses: Array<'short' | 'long'>
}

export function validateTtsSpeechPlacement(
  original: string,
  tagged: string,
  request: TtsSpeechPlacementRequest,
  style: Exclude<TtsTagStyle, 'off'>,
): boolean {
  const emotions = [...new Set(
    request.emotions
      .map(value => normalizeTtsTagName(value))
      .filter((value): value is string => !!value && ttsTagCategory(value) === 'emotion'),
  )].slice(0, 2)
  if (emotions.length === 0 && style !== 'gemini38') return false
  const styles = [...new Set(
    request.styles
      .map(value => normalizeTtsTagName(value))
      .filter((value): value is string => !!value && ttsTagCategory(value) === 'style'),
  )].slice(0, 1)
  if (styles.length !== request.styles.length) return false
  const sounds = request.sounds
    .map(value => normalizeTtsTagName(value))
    .filter((value): value is string => !!value && ttsTagCategory(value) === 'sound')
  if (sounds.length !== request.sounds.length || sounds.length > 2) return false
  const pauses = request.pauses
    .map(value => normalizeTtsTagName(value))
    .filter((value): value is string => !!value && ttsTagCategory(value) === 'pause')
  if (pauses.length !== request.pauses.length || pauses.length > 2) return false

  const originalMarkerCount = original.split(TTS_MODULATION_MARKER).length - 1
  const taggedMarkerCount = tagged.split(TTS_MODULATION_MARKER).length - 1
  if (originalMarkerCount > 1 || originalMarkerCount !== taggedMarkerCount) return false
  if (originalMarkerCount === 1) {
    const originalBeforeMarker = stripTtsTags(original.split(TTS_MODULATION_MARKER)[0])
      .replace(/\s+/gu, ' ')
      .trim()
    const taggedBeforeMarker = stripTtsTags(tagged.split(TTS_MODULATION_MARKER)[0])
      .replace(/\s+/gu, ' ')
      .trim()
    if (originalBeforeMarker !== taggedBeforeMarker) return false
  }
  const originalWithoutMarker = original.split(TTS_MODULATION_MARKER).join(' ')
  const taggedWithoutMarker = tagged.split(TTS_MODULATION_MARKER).join(' ')
  const normalizedOriginal = stripTtsTags(originalWithoutMarker).replace(/\s+/gu, ' ').trim()
  const normalizedTagged = stripTtsTags(taggedWithoutMarker).replace(/\s+/gu, ' ').trim()
  if (normalizedOriginal !== normalizedTagged) return false
  const emotionPrefix = [...emotions, ...styles]
    .map(tag => formatTtsTag(tag, style))
    .filter(Boolean)
    .join(' ')
  if (emotionPrefix && !tagged.trimStart().startsWith(emotionPrefix)) return false

  const originalTags = new Map<string, number>()
  const taggedTags = new Map<string, number>()
  replaceTtsTags(original, (candidate) => {
    originalTags.set(candidate, (originalTags.get(candidate) ?? 0) + 1)
    return ''
  })
  replaceTtsTags(tagged, (candidate) => {
    taggedTags.set(candidate, (taggedTags.get(candidate) ?? 0) + 1)
    return ''
  })
  const expected = new Map<string, number>()
  for (const sound of sounds) expected.set(sound, (expected.get(sound) ?? 0) + 1)
  for (const pause of pauses) expected.set(pause, (expected.get(pause) ?? 0) + 1)
  const names = new Set([...originalTags.keys(), ...taggedTags.keys(), ...expected.keys()])
  for (const name of names) {
    const delta = (taggedTags.get(name) ?? 0) - (originalTags.get(name) ?? 0)
    if (ttsTagCategory(name) === 'emotion' || ttsTagCategory(name) === 'style') {
      if (delta !== 0) return false
    } else if (delta !== (expected.get(name) ?? 0)) {
      return false
    }
  }
  return true
}

/**
 * Validate LLM placement of one tag. Retained for single-tag callers and tests.
 */
export function validateTtsTagPlacement(original: string, tagged: string, tag: string): boolean {
  const canonical = normalizeTtsTagName(tag)
  if (!canonical) return false
  const normalizedOriginal = stripTtsTags(original).replace(/\s+/gu, ' ').trim()
  const normalizedTagged = stripTtsTags(tagged).replace(/\s+/gu, ' ').trim()
  if (normalizedOriginal !== normalizedTagged) return false

  const originalTags = new Map<string, number>()
  const taggedTags = new Map<string, number>()
  replaceTtsTags(original, (candidate) => {
    originalTags.set(candidate, (originalTags.get(candidate) ?? 0) + 1)
    return ''
  })
  replaceTtsTags(tagged, (candidate) => {
    taggedTags.set(candidate, (taggedTags.get(candidate) ?? 0) + 1)
    return ''
  })
  for (const [name, count] of originalTags) {
    if (name === canonical) continue
    if ((taggedTags.get(name) ?? 0) !== count) return false
  }
  if ((taggedTags.get(canonical) ?? 0) - (originalTags.get(canonical) ?? 0) !== 1) return false
  for (const [name, count] of taggedTags) {
    if (name === canonical) continue
    if (!originalTags.has(name) || originalTags.get(name) !== count) return false
  }
  return true
}

export interface TtsTagPositionOption {
  id: string
  charIndex: number
  description: string
}

function ttsTagPositionOptions(text: string): TtsTagPositionOption[] {
  const options: TtsTagPositionOption[] = [{
    id: 'start',
    charIndex: 0,
    description: 'At the very start of the quotation.',
  }]
  const boundaries: number[] = []
  for (const match of text.matchAll(/[.!?…]+["'”’)]*\s+/gu)) {
    if (match.index === undefined) continue
    const charIndex = match.index + match[0].length
    if (charIndex > 0 && charIndex < text.length && !boundaries.includes(charIndex)) {
      boundaries.push(charIndex)
    }
  }
  for (const [index, charIndex] of boundaries.slice(0, 4).entries()) {
    const snippet = text.slice(charIndex, charIndex + 48).trim()
    options.push({
      id: `b${index + 1}`,
      charIndex,
      description: `Just before "${snippet}${snippet.length >= 48 ? '…' : ''}".`,
    })
  }
  options.push({
    id: 'end',
    charIndex: text.length,
    description: 'At the very end of the quotation.',
  })
  return options
}

function insertTtsTag(text: string, token: string, charIndex: number): string {
  if (charIndex <= 0) return `${token} ${text}`
  if (charIndex >= text.length) return `${text} ${token}`
  const before = text.slice(0, charIndex).trimEnd()
  const after = text.slice(charIndex).trimStart()
  return `${before} ${token} ${after}`
}

const TTS_MODULATION_MAX_POSITIONS = 8
const TTS_MODULATION_MIN_BEFORE_WORDS = 2
const TTS_MODULATION_MIN_REMAINDER_WORDS = 4

function ttsWordCount(text: string): number {
  return text.trim().split(/\s+/u).filter(Boolean).length
}

function ttsPositionDescription(text: string, charIndex: number): string {
  const snippet = text.slice(charIndex, charIndex + 48).trim()
  return `Just before "${snippet}${snippet.length >= 48 ? '…' : ''}".`
}

/**
 * Mid-speech modulation can occur inside a sentence, so unlike sound/pause
 * placement this offers clause boundaries and a few evenly spaced word
 * boundaries. Start/end and points with too little context are excluded.
 */
function ttsModulationPositionOptions(text: string): TtsTagPositionOption[] {
  const candidates: number[] = []
  const add = (charIndex: number) => {
    if (charIndex <= 0 || charIndex >= text.length) return
    if (ttsWordCount(stripTtsTags(text.slice(0, charIndex))) < TTS_MODULATION_MIN_BEFORE_WORDS) return
    if (ttsWordCount(stripTtsTags(text.slice(charIndex))) < TTS_MODULATION_MIN_REMAINDER_WORDS) return
    if (!candidates.includes(charIndex)) candidates.push(charIndex)
  }

  for (const match of text.matchAll(/[,.!?;:…—–]+["'”’)]*\s+/gu)) {
    if (match.index === undefined) continue
    add(match.index + match[0].length)
  }

  const words = [...text.matchAll(/\S+/gu)]
  for (let index = 6; index < words.length - TTS_MODULATION_MIN_REMAINDER_WORDS; index += 6) {
    const charIndex = words[index].index
    if (charIndex !== undefined) add(charIndex)
  }

  candidates.sort((left, right) => left - right)
  const selected = candidates.length <= TTS_MODULATION_MAX_POSITIONS
    ? candidates
    : Array.from({ length: TTS_MODULATION_MAX_POSITIONS }, (_, index) => (
        candidates[Math.floor(index * (candidates.length - 1) / (TTS_MODULATION_MAX_POSITIONS - 1))]
      )).filter((charIndex, index, values) => values.indexOf(charIndex) === index)
  return selected.map((charIndex, index) => ({
    id: `m${index + 1}`,
    charIndex,
    description: ttsPositionDescription(text, charIndex),
  }))
}

export interface TtsTagPlan {
  state: {
    messageRole: 'assistant' | 'user'
    message: string
    speeches: Array<{
      id: string
      paragraphId: string
      text: string
      narrativeBefore: string
      narrativeAfter: string
    }>
  }
  questions: SpeakerDecisionPlan['questions']
  /** Sound position options per speech. */
  positions: Record<string, TtsTagPositionOption[]>
  /** Pause position options per speech. */
  pausePositions: Record<string, TtsTagPositionOption[]>
  /** Optional mid-speech modulation position options per speech. */
  modulationPositions: Record<string, TtsTagPositionOption[]>
}

const TTS_NO_TAG_OPTION = 'no_tag'
const TTS_NO_PAUSE_OPTION = 'no_pause'
const TTS_NO_EMOTION_OPTION = 'no_emotion'
const TTS_NO_STYLE_OPTION = 'no_style'
const TTS_MODULATION_OPTION = 'modulation'
const TTS_NO_MODULATION_OPTION = 'no_modulation'

function ttsEmotionCriteria(options: readonly TtsTagOption[]): Record<string, string> {
  return Object.fromEntries(options.map(option => [option.value, option.description]))
}

function ttsSoundCriteria(options: readonly TtsTagOption[]): Record<string, string> {
  return Object.fromEntries([
    ...options.map(option => [option.value, option.description]),
    [TTS_NO_TAG_OPTION, 'No momentary sound effect. Most lines should choose this.'],
  ])
}

function ttsStyleCriteria(): Record<string, string> {
  return Object.fromEntries(TTS_STYLE_OPTIONS.map(option => [option.value, option.description]))
}

function ttsPauseCriteria(): Record<string, string> {
  return Object.fromEntries([
    ...TTS_PAUSE_OPTIONS.map(option => [option.value, option.description]),
    [TTS_NO_PAUSE_OPTION, 'No inserted pause. Most lines should choose this.'],
  ])
}

/**
 * Build the batched tag questions. Every speech gets a mandatory emotion, an
 * optional sound, and an optional pause, plus fallback placement boundaries.
 * Fish S2 with LLM placement also gets an optional mid-speech modulation and
 * its position when the speech is long enough to have a useful remainder.
 */
export function buildTtsTagPlan(
  plan: SpeakerDecisionPlan,
  speechIds?: readonly string[],
  emotionOptions: readonly TtsTagOption[] = TTS_AUTO_EMOTION_OPTIONS,
  style: Exclude<TtsTagStyle, 'off'> = 'gemini',
  enableModulation = false,
): TtsTagPlan {
  const allowed = speechIds ? new Set(speechIds) : null
  const speeches = plan.state.speeches
    .filter(speech => !allowed || allowed.has(speech.id))
    .map(speech => ({
      id: speech.id,
      paragraphId: speech.paragraphId,
      text: speech.text,
      narrativeBefore: speech.narrativeBefore,
      narrativeAfter: speech.narrativeAfter,
    }))
  const emotionCriteria = ttsEmotionCriteria(emotionOptions)
  const soundOptions = style === 'fish'
    ? TTS_FISH_SOUND_OPTIONS
    : style === 'gemini38'
      ? TTS_GEMINI38_SOUND_OPTIONS
      : TTS_TAG_OPTIONS
  const soundCriteria = ttsSoundCriteria(soundOptions)
  const styleCriteria = ttsStyleCriteria()
  const pauseCriteria = ttsPauseCriteria()
  const questions: SpeakerDecisionPlan['questions'] = {}
  const positions: Record<string, TtsTagPositionOption[]> = {}
  const pausePositions: Record<string, TtsTagPositionOption[]> = {}
  const modulationPositions: Record<string, TtsTagPositionOption[]> = {}
  for (const speech of speeches) {
    if (style !== 'gemini38') {
      questions[`emotion_${speech.id}`] = {
        type: 'choice',
        instructions: `Which emotion best describes how quotation ${speech.id} is delivered? Use the quotation and its surrounding narration. Every quotation receives exactly one primary emotion; choose calm for neutral delivery.`,
        criteria: emotionCriteria,
      }
      questions[`emotion2_${speech.id}`] = {
        type: 'choice',
        instructions: `Is there a distinct secondary emotion layered into quotation ${speech.id}? Choose no_emotion unless a second emotion is clearly present and compatible with the primary.`,
        criteria: {
          ...emotionCriteria,
          [TTS_NO_EMOTION_OPTION]: 'No distinct secondary emotion. Most lines should choose this.',
        },
      }
    }
    if (style === 'fish') {
      questions[`style_${speech.id}`] = {
        type: 'choice',
        instructions: `Does quotation ${speech.id} have a sustained voice style that should lead the speech? Choose no_style unless a whisper, soft/loud/low voice, shout, or scream clearly applies to the whole quotation. Do not use this for a momentary sound.`,
        criteria: {
          ...styleCriteria,
          [TTS_NO_STYLE_OPTION]: 'No sustained voice style. Most lines should choose this.',
        },
      }
      if (enableModulation) {
        const modulationOptions = ttsModulationPositionOptions(speech.text)
        if (modulationOptions.length > 0) {
          modulationPositions[speech.id] = modulationOptions
          questions[`modulation_${speech.id}`] = {
            type: 'choice',
            instructions: `Does quotation ${speech.id} have a clear internal emotional turn that should change delivery before the quotation ends? Choose modulation only when the emotion genuinely shifts and the new delivery should continue to the end. Ignore momentary sounds, ordinary punctuation, and small intensity changes.`,
            criteria: {
              modulation: 'A clear, sustained emotional turn inside the quotation.',
              no_modulation: 'No clear internal emotional turn. Most lines should choose this.',
            },
          }
          questions[`modulationpos_${speech.id}`] = {
            type: 'choice',
            instructions: `If quotation ${speech.id} receives a modulation, where should the new emotion begin? Choose the boundary closest to the emotional turn.`,
            criteria: Object.fromEntries(modulationOptions.map(option => [option.id, option.description])),
          }
        }
      }
    }
    questions[`tag_${speech.id}`] = {
      type: 'choice',
      instructions: `Does quotation ${speech.id} contain one momentary sound effect that should be performed? Use the quotation and its surrounding narration. Most quotations need none; choose no_tag unless the sound is unmistakable. Never use ambient sound, sustained mood, or hesitation.`,
      criteria: soundCriteria,
    }
    questions[`tag2_${speech.id}`] = {
      type: 'choice',
      instructions: `Does quotation ${speech.id} contain a second distinct momentary sound effect? Choose no_tag unless a second sound is clearly present near a different moment.`,
      criteria: soundCriteria,
    }
    const speechPositions = ttsTagPositionOptions(speech.text)
    positions[speech.id] = speechPositions
    questions[`tagpos_${speech.id}`] = {
      type: 'choice',
      instructions: `If quotation ${speech.id} receives a sound effect, where should it be inserted? Choose the boundary closest to the exact sound.`,
      criteria: Object.fromEntries(speechPositions.map(option => [option.id, option.description])),
    }
    questions[`pause_${speech.id}`] = {
      type: 'choice',
      instructions: `Does quotation ${speech.id} need one inserted dramatic pause? Choose no_pause unless a pause clearly improves timing.`,
      criteria: pauseCriteria,
    }
    questions[`pause2_${speech.id}`] = {
      type: 'choice',
      instructions: `Does quotation ${speech.id} need a second distinct pause at another moment? Choose no_pause unless a second pause clearly improves timing.`,
      criteria: pauseCriteria,
    }
    pausePositions[speech.id] = speechPositions
    questions[`pausepos_${speech.id}`] = {
      type: 'choice',
      instructions: `If quotation ${speech.id} receives a pause, where should it be inserted? Choose the boundary closest to the intended pause.`,
      criteria: Object.fromEntries(speechPositions.map(option => [option.id, option.description])),
    }
  }
  return {
    state: {
      messageRole: plan.state.messageRole,
      message: plan.state.message,
      speeches,
    },
    questions,
    positions,
    pausePositions,
    modulationPositions,
  }
}

export interface TtsTagSelection {
  speechId: string
  /** Leading emotions, including existing ones. At most two. */
  emotions: string[]
  /** Leading Fish S2 voice styles. At most one. */
  styles: string[]
  /** New sound cues to place. At most two total including existing sounds. */
  sounds: string[]
  /** New pause cues to place. At most two total including existing pauses. */
  pauses: Array<'short' | 'long'>
  soundPositions: string[]
  pausePositions: string[]
  /** True when Jev selected a mid-speech modulation. */
  modulation: boolean
  /** Jev position option ID for the modulation point, when active. */
  modulationPoint: string | null
  /** Character offset of the modulation point in the original speech. */
  modulationCharIndex: number | null
  /** Emotion-bearing text without new sound/pause; used by the placement LLM. */
  baseText: string
  /** Full deterministic fallback text with the provider-supported leading cues. */
  ttsText: string
  narrativeBefore: string
  narrativeAfter: string
  emotionProbability: number
  emotionConfidence: number
  emotionMargin: number
  emotion2Probability: number
  emotion2Confidence: number
  styleProbability: number
  styleConfidence: number
  styleMargin: number
  soundProbability: number
  soundConfidence: number
  soundMargin: number
  sound2Probability: number
  sound2Confidence: number
  sound2Margin: number
  soundPositionConfidence: number
  pauseProbability: number
  pauseConfidence: number
  pauseMargin: number
  pause2Probability: number
  pause2Confidence: number
  pause2Margin: number
  pausePositionConfidence: number
  modulationProbability: number
  modulationConfidence: number
  modulationMargin: number
  modulationPositionConfidence: number
  existingTags: string[]
  /** True when this speech used the neutral fallback because its batch failed. */
  fallback?: boolean
  /** Explanation of the same-speaker continuity decision, for diagnostics. */
  continuity?: string
}

function clearTagChoice(
  answer: SpeakerDecisionChoice | undefined,
  thresholds: TtsTagThresholds,
  category: TtsTagCategory,
): { tag: string | null; probability: number; confidence: number; margin: number } {
  if (!answer) return { tag: null, probability: 0, confidence: 0, margin: 0 }
  const ranked = Object.entries(answer.probabilities)
    .filter((entry): entry is [string, number] => Number.isFinite(entry[1]))
    .sort((left, right) => right[1] - left[1])
  const probability = answer.probabilities[answer.choice] ?? 0
  const runnerUp = ranked.find(([option]) => option !== answer.choice)?.[1] ?? 0
  const confidence = answer.confidence
  const margin = probability - runnerUp
  const tag = answer.choice === TTS_NO_TAG_OPTION
    || answer.choice === TTS_NO_PAUSE_OPTION
    || answer.choice === TTS_NO_EMOTION_OPTION
    || answer.choice === TTS_NO_STYLE_OPTION
    ? null
    : normalizeTtsTagName(answer.choice)
  if (
    !tag
    || ttsTagCategory(tag) !== category
    || probability < thresholds.probability
    || confidence < thresholds.confidence
    || margin < thresholds.margin
  ) {
    return { tag: null, probability, confidence, margin }
  }
  return { tag, probability, confidence, margin }
}

function clearModulationChoice(
  answer: SpeakerDecisionChoice | undefined,
  thresholds: TtsTagThresholds,
): { active: boolean; probability: number; confidence: number; margin: number } {
  if (!answer) return { active: false, probability: 0, confidence: 0, margin: 0 }
  const ranked = Object.entries(answer.probabilities)
    .filter((entry): entry is [string, number] => Number.isFinite(entry[1]))
    .sort((left, right) => right[1] - left[1])
  const probability = answer.probabilities[answer.choice] ?? 0
  const runnerUp = ranked.find(([option]) => option !== answer.choice)?.[1] ?? 0
  const margin = probability - runnerUp
  return {
    active: answer.choice === TTS_MODULATION_OPTION
      && probability >= thresholds.probability
      && answer.confidence >= thresholds.confidence
      && margin >= thresholds.margin,
    probability,
    confidence: answer.confidence,
    margin,
  }
}

function resolveModulationPosition(
  answer: SpeakerDecisionChoice | undefined,
  options: TtsTagPositionOption[],
  thresholds: TtsTagThresholds,
): { option: TtsTagPositionOption | null; confidence: number } {
  if (!answer || options.length === 0) return { option: null, confidence: 0 }
  const ranked = Object.entries(answer.probabilities)
    .filter((entry): entry is [string, number] => Number.isFinite(entry[1]))
    .sort((left, right) => right[1] - left[1])
  const probability = answer.probabilities[answer.choice] ?? 0
  const runnerUp = ranked.find(([option]) => option !== answer.choice)?.[1] ?? 0
  const selected = options.find(option => option.id === answer.choice) ?? null
  if (
    !selected
    || probability < thresholds.probability
    || answer.confidence < thresholds.confidence
    || probability - runnerUp < thresholds.margin
  ) {
    return { option: null, confidence: answer.confidence }
  }
  return { option: selected, confidence: answer.confidence }
}

function resolveEmotionChoice(
  answer: SpeakerDecisionChoice | undefined,
): { emotion: string; probability: number; confidence: number; margin: number } {
  if (!answer) return { emotion: 'calm', probability: 0, confidence: 0, margin: 0 }
  const ranked = Object.entries(answer.probabilities)
    .filter((entry): entry is [string, number] => Number.isFinite(entry[1]))
    .sort((left, right) => right[1] - left[1])
  const selected = normalizeTtsTagName(answer.choice)
  const chosen = selected && ttsTagCategory(selected) === 'emotion'
    ? selected
    : ranked.map(([name]) => normalizeTtsTagName(name))
        .find((name): name is string => !!name && ttsTagCategory(name) === 'emotion')
      ?? 'calm'
  const probability = answer.probabilities[chosen] ?? 0
  const runnerUp = ranked.find(([name]) => (
    normalizeTtsTagName(name) !== chosen
  ))?.[1] ?? 0
  const confidence = answer.confidence
  const margin = probability - runnerUp
  const emotion = (
    probability >= TTS_EMOTION_THRESHOLDS.probability
    && confidence >= TTS_EMOTION_THRESHOLDS.confidence
    && margin >= TTS_EMOTION_THRESHOLDS.margin
  ) ? chosen : 'calm'
  return { emotion, probability, confidence, margin }
}

function resolvePositionChoice(
  answer: SpeakerDecisionChoice | undefined,
  options: TtsTagPositionOption[],
  thresholds: TtsTagThresholds,
  fallback: TtsTagPositionOption,
): { option: TtsTagPositionOption; probability: number; confidence: number } {
  if (!answer) return { option: fallback, probability: 0, confidence: 0 }
  const ranked = Object.entries(answer.probabilities)
    .filter((entry): entry is [string, number] => Number.isFinite(entry[1]))
    .sort((left, right) => right[1] - left[1])
  const probability = answer.probabilities[answer.choice] ?? 0
  const runnerUp = ranked.find(([option]) => option !== answer.choice)?.[1] ?? 0
  const confidence = answer.confidence
  if (
    probability >= thresholds.probability
    && confidence >= thresholds.confidence
    && probability - runnerUp >= thresholds.margin
  ) {
    return {
      option: options.find(option => option.id === answer.choice) ?? fallback,
      probability,
      confidence,
    }
  }
  return { option: fallback, probability, confidence }
}

function removeTtsTagsByCategory(
  text: string,
  category: TtsTagCategory,
): string {
  return replaceTtsTags(text, (tag, match) => (
    ttsTagCategory(tag) === category ? '' : match
  ))
}

function renderLeadingCues(
  body: string,
  prefix: string,
  repeatPerSentence: boolean,
): string {
  if (!body) return prefix
  if (!repeatPerSentence) return prefix ? `${prefix} ${body}` : body
  const rendered: string[] = []
  for (const sentence of body.split(/(?<=[.!?…])\s+/u).filter(Boolean)) {
    const words = stripTtsTags(sentence).replace(/\s+/gu, ' ').trim()
    if (!words && rendered.length > 0) {
      rendered[rendered.length - 1] += ` ${sentence}`
    } else {
      rendered.push(words && prefix ? `${prefix} ${sentence}` : sentence)
    }
  }
  return rendered.join(' ')
}

/**
 * Rebuild the Fish leading cues after placement. The placement LLM receives
 * only the first prefix, which keeps its output small; this restores the
 * sentence-level S2 scoping deterministically. Gemini 3.8 uses this to strip
 * unsupported emotion/style cues while keeping its angle-bracket events.
 */
export function applyLeadingTtsCues(
  text: string,
  emotions: readonly string[],
  styles: readonly string[],
  style: Exclude<TtsTagStyle, 'off'>,
): string {
  const normalized = normalizeTtsTags(stripTtsModulationMarker(text), style)
  const body = style === 'fish' || style === 'gemini38'
    ? removeTtsTagsByCategory(removeTtsTagsByCategory(normalized, 'emotion'), 'style')
    : normalized
  const prefix = [...emotions, ...styles]
    .map(tag => formatTtsTag(tag, style))
    .filter(Boolean)
    .join(' ')
  return renderLeadingCues(
    body.replace(/[ \t]+/gu, ' ').trim(),
    prefix,
    style === 'fish',
  )
}

const CUSTOM_EMOTION_MAX_WORDS = 9
const CUSTOM_EMOTION_MAX_CHARS = 80

/** Validate a free-form Fish S2 emotion cue before using it in place of the fixed tag. */
export function normalizeCustomTtsEmotionTag(value: string): string | null {
  let tag = value.trim()
  if (!tag) return null
  if (tag.startsWith('[') && tag.endsWith(']')) {
    tag = tag.slice(1, -1).trim()
  }
  if (!tag || tag.includes('[') || tag.includes(']') || /["“”\r\n]/u.test(tag)) return null
  tag = tag.replace(/\s+/gu, ' ').trim()
  if (tag.length === 0 || tag.length > CUSTOM_EMOTION_MAX_CHARS) return null
  const words = tag.split(' ').filter(Boolean)
  if (words.length < 1 || words.length > CUSTOM_EMOTION_MAX_WORDS) return null
  const canonical = normalizeTtsTagName(tag)
  if (canonical && ttsTagCategory(canonical) !== 'emotion') return null
  return tag
}

/** Remove the internal modulation marker before text can reach TTS. */
export function stripTtsModulationMarker(text: string): string {
  return text.split(TTS_MODULATION_MARKER).join('')
}

/** Replace the fixed leading emotion with a validated Fish S2 custom cue. */
export function applyCustomTtsEmotionCues(
  text: string,
  customTag: string,
  styles: readonly string[],
  style: Exclude<TtsTagStyle, 'off'>,
): string {
  const normalized = normalizeTtsTags(stripTtsModulationMarker(text), style)
  const body = style === 'fish'
    ? removeTtsTagsByCategory(removeTtsTagsByCategory(normalized, 'emotion'), 'style')
    : normalized
  const prefix = [formatTtsTag(customTag, style), ...styles.map(tag => formatTtsTag(tag, style))]
    .filter(Boolean)
    .join(' ')
  return renderLeadingCues(
    body.replace(/[ \t]+/gu, ' ').trim(),
    prefix,
    style === 'fish',
  )
}

/**
 * Replace the leading Fish cue and insert a second free-form cue at the Jev
 * modulation point. The modulation remains active at later sentence starts,
 * matching Fish S2's sentence-scoped cue behavior.
 */
export function applyCustomTtsEmotionCuesWithModulation(
  text: string,
  customTag: string,
  styles: readonly string[],
  modulationTag: string,
  style: Exclude<TtsTagStyle, 'off'>,
): string {
  const normalized = normalizeTtsTags(text, style)
  const body = style === 'fish'
    ? removeTtsTagsByCategory(removeTtsTagsByCategory(normalized, 'emotion'), 'style')
    : normalized
  const stylePrefix = styles.map(tag => formatTtsTag(tag, style)).filter(Boolean).join(' ')
  const leadingPrefix = [formatTtsTag(customTag, style), stylePrefix].filter(Boolean).join(' ')
  const modulationPrefix = [formatTtsTag(modulationTag, style), stylePrefix].filter(Boolean).join(' ')
  const rendered: string[] = []
  let activePrefix = leadingPrefix
  const cleanBody = body.replace(/[ \t]+/gu, ' ').trim()

  for (const sentence of cleanBody.split(/(?<=[.!?…])\s+/u).filter(Boolean)) {
    const markerIndex = sentence.indexOf(TTS_MODULATION_MARKER)
    const sentenceWords = stripTtsTags(
      sentence.split(TTS_MODULATION_MARKER).join(' '),
    ).replace(/\s+/gu, ' ').trim()
    if (!sentenceWords) {
      if (rendered.length > 0) rendered[rendered.length - 1] += ` ${sentence}`
      else rendered.push(sentence)
      continue
    }
    if (markerIndex < 0) {
      rendered.push(activePrefix ? `${activePrefix} ${sentence}` : sentence)
      continue
    }

    const before = sentence.slice(0, markerIndex).trim()
    const after = sentence.slice(markerIndex + TTS_MODULATION_MARKER.length).trim()
    const beforeWords = stripTtsTags(before).replace(/\s+/gu, ' ').trim()
    const afterWords = stripTtsTags(after).replace(/\s+/gu, ' ').trim()
    if (!afterWords) {
      const withoutMarker = stripTtsModulationMarker(sentence).trim()
      rendered.push(activePrefix ? `${activePrefix} ${withoutMarker}` : withoutMarker)
      continue
    }
    if (!beforeWords) {
      rendered.push(
        [before, modulationPrefix, after].filter(Boolean).join(' ').replace(/\s+/gu, ' ').trim(),
      )
    } else {
      rendered.push(
        [activePrefix, before, modulationPrefix, after]
          .filter(Boolean)
          .join(' ')
          .replace(/\s+/gu, ' ')
          .trim(),
      )
    }
    activePrefix = modulationPrefix
  }
  return rendered.join(' ')
}

/**
 * Normalize tag answers into a leading emotion plus optional sound and pause.
 * Every speech gets a selection so the deterministic fallback always has an
 * emotion even if the placement LLM never runs.
 */
export function resolveTtsTagAnswers(
  plan: TtsTagPlan,
  answers: Record<string, SpeakerDecisionChoice>,
  style: Exclude<TtsTagStyle, 'off'>,
  thresholds: TtsTagThresholds = TTS_TAG_THRESHOLDS,
  positionThresholds: TtsTagThresholds = TTS_TAG_POSITION_THRESHOLDS,
): Map<string, TtsTagSelection> {
  const selections = new Map<string, TtsTagSelection>()
  for (const speech of plan.state.speeches) {
    const emotionChoice = resolveEmotionChoice(answers[`emotion_${speech.id}`])
    const emotion2Choice = clearTagChoice(answers[`emotion2_${speech.id}`], thresholds, 'emotion')
    const styleChoice = style === 'fish'
      ? clearTagChoice(answers[`style_${speech.id}`], thresholds, 'style')
      : { tag: null, probability: 0, confidence: 0, margin: 0 }
    const soundChoice = clearTagChoice(answers[`tag_${speech.id}`], thresholds, 'sound')
    const sound2Choice = clearTagChoice(answers[`tag2_${speech.id}`], thresholds, 'sound')
    const pauseChoice = clearTagChoice(answers[`pause_${speech.id}`], thresholds, 'pause')
    const pause2Choice = clearTagChoice(answers[`pause2_${speech.id}`], thresholds, 'pause')
    const modulationOptions = plan.modulationPositions[speech.id] ?? []
    const modulationChoice = clearModulationChoice(
      answers[`modulation_${speech.id}`],
      thresholds,
    )
    const modulationPosition = modulationChoice.active
      ? resolveModulationPosition(
          answers[`modulationpos_${speech.id}`],
          modulationOptions,
          positionThresholds,
        )
      : { option: null, confidence: 0 }
    const modulation = modulationChoice.active && modulationPosition.option !== null
    const soundPositions = plan.positions[speech.id]
      ?? [{ id: 'start', charIndex: 0, description: '' }]
    const pausePositions = plan.pausePositions[speech.id] ?? soundPositions
    const soundPosition = resolvePositionChoice(
      answers[`tagpos_${speech.id}`],
      soundPositions,
      positionThresholds,
      soundPositions[0],
    )
    const pausePosition = resolvePositionChoice(
      answers[`pausepos_${speech.id}`],
      pausePositions,
      positionThresholds,
      pausePositions[pausePositions.length - 1],
    )

    const existingTags = extractTtsTags(speech.text)
    const emotions: string[] = []
    if (style !== 'gemini38') {
      const existingEmotions = [...new Set(
        existingTags.filter(tag => ttsTagCategory(tag) === 'emotion'),
      )].slice(0, 2)
      emotions.push(...existingEmotions)
      if (emotions.length === 0) {
        emotions.push(emotionChoice.emotion)
        if (emotion2Choice.tag && !emotions.includes(emotion2Choice.tag)) {
          emotions.push(emotion2Choice.tag)
        }
      } else if (
        emotions.length === 1
        && emotion2Choice.tag
        && !emotions.includes(emotion2Choice.tag)
      ) {
        emotions.push(emotion2Choice.tag)
      }
    }

    const existingStyles = style === 'fish'
      ? [...new Set(
          existingTags.filter(tag => ttsTagCategory(tag) === 'style'),
        )].slice(0, 1)
      : []
    const styles = [...existingStyles]
    if (style === 'fish' && styles.length === 0 && styleChoice.tag) {
      styles.push(styleChoice.tag)
    }

    const sounds = [...new Set(
      existingTags.filter(tag => ttsTagCategory(tag) === 'sound'),
    )].slice(0, 2)
    const newSounds: string[] = []
    for (const candidate of [soundChoice.tag, sound2Choice.tag]) {
      if (!candidate || sounds.length >= 2 || sounds.includes(candidate)) continue
      sounds.push(candidate)
      newSounds.push(candidate)
    }
    const newSoundPositions = newSounds.map((_, index) => (
      index === 0 ? soundPosition.option : soundPositions[soundPositions.length - 1]
    ))

    const pauses = existingTags
      .filter(tag => ttsTagCategory(tag) === 'pause')
      .slice(0, 2) as Array<'short' | 'long'>
    const newPauses: Array<'short' | 'long'> = []
    for (const candidate of [pauseChoice.tag, pause2Choice.tag]) {
      if (!candidate || pauses.length >= 2) continue
      const pause = candidate as 'short' | 'long'
      pauses.push(pause)
      newPauses.push(pause)
    }
    const newPausePositions = newPauses.map((_, index) => (
      index === 0 ? pausePosition.option : pausePositions[pausePositions.length - 1]
    ))

    const leadingPrefix = [...emotions, ...styles]
      .map(tag => formatTtsTag(tag, style))
      .filter(Boolean)
      .join(' ')
    const removeLeadingCues = (text: string) => {
      const withoutEmotions = removeTtsTagsByCategory(text, 'emotion')
      return style === 'fish' || style === 'gemini38'
        ? removeTtsTagsByCategory(withoutEmotions, 'style')
        : withoutEmotions
    }
    const baseSource = modulation && modulationPosition.option
      ? insertTtsTag(speech.text, TTS_MODULATION_MARKER, modulationPosition.option.charIndex)
      : speech.text
    const baseBody = normalizeTtsTags(
      removeLeadingCues(baseSource),
      style,
    ).replace(/[ \t]+/gu, ' ').trim()
    const baseText = leadingPrefix
      ? (baseBody ? `${leadingPrefix} ${baseBody}` : leadingPrefix)
      : baseBody

    const insertions: Array<{ token: string; charIndex: number }> = []
    newSounds.forEach((sound, index) => insertions.push({
      token: formatTtsTag(sound, style),
      charIndex: newSoundPositions[index].charIndex,
    }))
    newPauses.forEach((pause, index) => insertions.push({
      token: formatTtsTag(pause, style),
      charIndex: newPausePositions[index].charIndex,
    }))
    let fallback = speech.text
    for (const insertion of insertions.sort((left, right) => right.charIndex - left.charIndex)) {
      fallback = insertTtsTag(fallback, insertion.token, insertion.charIndex)
    }
    const fallbackBody = normalizeTtsTags(
      removeLeadingCues(fallback),
      style,
    ).replace(/[ \t]+/gu, ' ').trim()
    const ttsText = renderLeadingCues(fallbackBody, leadingPrefix, style === 'fish')

    selections.set(speech.id, {
      speechId: speech.id,
      emotions,
      styles,
      sounds: newSounds,
      pauses: newPauses,
      soundPositions: newSoundPositions.map(option => option.id),
      pausePositions: newPausePositions.map(option => option.id),
      modulation,
      modulationPoint: modulation ? modulationPosition.option?.id ?? null : null,
      modulationCharIndex: modulation ? modulationPosition.option?.charIndex ?? null : null,
      baseText,
      ttsText,
      narrativeBefore: speech.narrativeBefore,
      narrativeAfter: speech.narrativeAfter,
      emotionProbability: emotionChoice.probability,
      emotionConfidence: emotionChoice.confidence,
      emotionMargin: emotionChoice.margin,
      emotion2Probability: emotion2Choice.probability,
      emotion2Confidence: emotion2Choice.confidence,
      styleProbability: styleChoice.probability,
      styleConfidence: styleChoice.confidence,
      styleMargin: styleChoice.margin,
      soundProbability: soundChoice.probability,
      soundConfidence: soundChoice.confidence,
      soundMargin: soundChoice.margin,
      sound2Probability: sound2Choice.probability,
      sound2Confidence: sound2Choice.confidence,
      sound2Margin: sound2Choice.margin,
      soundPositionConfidence: soundPosition.confidence,
      pauseProbability: pauseChoice.probability,
      pauseConfidence: pauseChoice.confidence,
      pauseMargin: pauseChoice.margin,
      pause2Probability: pause2Choice.probability,
      pause2Confidence: pause2Choice.confidence,
      pause2Margin: pause2Choice.margin,
      pausePositionConfidence: pausePosition.confidence,
      modulationProbability: modulationChoice.probability,
      modulationConfidence: modulationChoice.confidence,
      modulationMargin: modulationChoice.margin,
      modulationPositionConfidence: modulationPosition.confidence,
      existingTags,
    })
  }
  return selections
}

/**
 * Attach tagged text to the matching speech segments. Speech segments are
 * matched by their cleaned quotation text in plan order, which keeps narration
 * and unresolved speech separate without adding a second segment kind.
 */
export function applyTtsTagSelections(
  segments: PlaybackSegment[],
  plan: TtsTagPlan,
  selections: ReadonlyMap<string, TtsTagSelection>,
  includeDebug: boolean,
): PlaybackSegment[] {
  const queues = new Map<string, TtsTagSelection[]>()
  for (const speech of plan.state.speeches) {
    const selection = selections.get(speech.id)
    if (!selection) continue
    const queue = queues.get(speech.text) ?? []
    queue.push(selection)
    queues.set(speech.text, queue)
  }
  return segments.map(segment => {
    const queue = queues.get(segment.text)
    const selection = queue?.shift()
    if (!selection) return segment
    const debugPath = includeDebug && segment.debugPath
      ? [
          ...segment.debugPath,
          `tts-emotions:${JSON.stringify(selection.emotions)}`,
          `tts-emotion-probability:${selection.emotionProbability.toFixed(3)}`,
          `tts-emotion-confidence:${selection.emotionConfidence.toFixed(3)}`,
          `tts-emotion-margin:${selection.emotionMargin.toFixed(3)}`,
          ...(selection.continuity ? [`tts-continuity:${selection.continuity}`] : []),
          `tts-emotion2-probability:${selection.emotion2Probability.toFixed(3)}`,
          `tts-emotion2-confidence:${selection.emotion2Confidence.toFixed(3)}`,
          `tts-styles:${JSON.stringify(selection.styles)}`,
          `tts-style-probability:${selection.styleProbability.toFixed(3)}`,
          `tts-style-confidence:${selection.styleConfidence.toFixed(3)}`,
          `tts-style-margin:${selection.styleMargin.toFixed(3)}`,
          `tts-sounds:${JSON.stringify(selection.sounds)}`,
          `tts-sound-probability:${selection.soundProbability.toFixed(3)}`,
          `tts-sound-confidence:${selection.soundConfidence.toFixed(3)}`,
          `tts-sound-margin:${selection.soundMargin.toFixed(3)}`,
          `tts-sound2-probability:${selection.sound2Probability.toFixed(3)}`,
          `tts-sound2-confidence:${selection.sound2Confidence.toFixed(3)}`,
          `tts-sound2-margin:${selection.sound2Margin.toFixed(3)}`,
          `tts-sound-positions:${JSON.stringify(selection.soundPositions)}`,
          `tts-sound-position-confidence:${selection.soundPositionConfidence.toFixed(3)}`,
          `tts-pauses:${JSON.stringify(selection.pauses)}`,
          `tts-pause-probability:${selection.pauseProbability.toFixed(3)}`,
          `tts-pause-confidence:${selection.pauseConfidence.toFixed(3)}`,
          `tts-pause-margin:${selection.pauseMargin.toFixed(3)}`,
          `tts-pause2-probability:${selection.pause2Probability.toFixed(3)}`,
          `tts-pause2-confidence:${selection.pause2Confidence.toFixed(3)}`,
          `tts-pause2-margin:${selection.pause2Margin.toFixed(3)}`,
          `tts-pause-positions:${JSON.stringify(selection.pausePositions)}`,
          `tts-pause-position-confidence:${selection.pausePositionConfidence.toFixed(3)}`,
          `tts-modulation:${selection.modulation}`,
          `tts-modulation-probability:${selection.modulationProbability.toFixed(3)}`,
          `tts-modulation-confidence:${selection.modulationConfidence.toFixed(3)}`,
          `tts-modulation-margin:${selection.modulationMargin.toFixed(3)}`,
          `tts-modulation-point:${JSON.stringify(selection.modulationPoint)}`,
          `tts-modulation-char-index:${selection.modulationCharIndex ?? 'null'}`,
          `tts-modulation-position-confidence:${selection.modulationPositionConfidence.toFixed(3)}`,
          `tts-tag-source:jev`,
          ...(selection.fallback ? ['tts-tag-evaluation:neutral-fallback'] : []),
          `tts-text:${selection.ttsText}`,
        ]
      : segment.debugPath
    return {
      ...segment,
      ttsText: selection.ttsText,
      ttsTag: {
        id: selection.speechId,
        emotions: selection.emotions,
        styles: selection.styles,
        sounds: selection.sounds,
        pauses: selection.pauses,
        source: 'jev' as const,
        baseText: selection.baseText,
        modulation: selection.modulation,
        ...(selection.modulationPoint ? { modulationPoint: selection.modulationPoint } : {}),
        ...(selection.modulationCharIndex !== null
          ? { modulationCharIndex: selection.modulationCharIndex }
          : {}),
        narrativeBefore: selection.narrativeBefore,
        narrativeAfter: selection.narrativeAfter,
      },
      ...(debugPath ? { debugPath } : {}),
    }
  })
}

/** Smooth only weak emotion fallbacks using recent reliable speech by the same speaker. */
export function applyTtsSpeakerContinuity(
  segments: PlaybackSegment[],
  plan: SpeakerDecisionPlan,
  selections: ReadonlyMap<string, TtsTagSelection>,
  style: Exclude<TtsTagStyle, 'off'>,
): Map<string, TtsTagSelection> {
  const result = new Map(selections)
  const quotes = playbackQuotes(plan.state.message)
  const speechSegments: PlaybackSegment[] = []
  let cursor = 0
  for (const speech of plan.state.speeches) {
    while (cursor < segments.length && segments[cursor].text !== speech.text) cursor += 1
    if (cursor === segments.length) return result
    speechSegments.push(segments[cursor++])
  }
  // Do not guess at alignment: a bad match could carry emotion to another person.
  if (speechSegments.length !== plan.state.speeches.length
    || speechSegments.some((segment, index) => segment.text !== plan.state.speeches[index].text)) return result
  const history = new Map<string, { emotion: string; styles: string[]; index: number; speechId: string }>()
  for (let index = 0; index < plan.state.speeches.length; index++) {
    const speech = plan.state.speeches[index]
    const selection = result.get(speech.id)
    const speaker = speechSegments[index].speakerId
    const bridge = narrationBridge(plan.state.message, quotes[index - 1], quotes[index])
    const boundary = SPEAKER_HARD_BOUNDARY_PATTERNS.find(item => item.pattern.test(bridge))
    if (boundary) history.clear()
    if (!selection) continue
    if (!speaker || speaker === UNCAST_SPEAKER_ID || speaker === UNRESOLVED_SPEAKER_ID) {
      result.set(speech.id, { ...selection, continuity: 'skipped: unresolved or uncast speaker' })
      continue
    }
    const previous = history.get(speaker)
    const recent = previous && index - previous.index <= 3 ? previous : undefined
    const explicitEmotion = selection.existingTags.some(tag => ttsTagCategory(tag) === 'emotion')
    const strong = !selection.fallback && selection.emotionProbability >= TTS_EMOTION_THRESHOLDS.probability
      && selection.emotionConfidence >= TTS_EMOTION_THRESHOLDS.confidence
      && selection.emotionMargin >= TTS_EMOTION_THRESHOLDS.margin
    let updated = selection
    if (style !== 'gemini38' && recent && !explicitEmotion && !strong && selection.emotions.length === 1) {
      const emotions = [recent.emotion]
      // A missing/failed evaluation has no reliable style decision. A clear
      // no-style choice remains authoritative and does not inherit a style.
      const styles = style === 'fish' && selection.fallback && selection.styles.length === 0
        ? recent.styles : selection.styles
      const prefix = [...emotions, ...styles].map(tag => formatTtsTag(tag, style)).filter(Boolean).join(' ')
      const replaceLeading = (text: string, repeat: boolean) => {
        const withoutEmotion = removeTtsTagsByCategory(text, 'emotion')
        const body = style === 'fish' ? removeTtsTagsByCategory(withoutEmotion, 'style') : withoutEmotion
        return renderLeadingCues(body.replace(/[ \t]+/gu, ' ').trim(), prefix, repeat)
      }
      updated = {
        ...selection, emotions, styles,
        baseText: replaceLeading(selection.baseText, false),
        ttsText: replaceLeading(selection.ttsText, style === 'fish'),
        continuity: `inherited ${recent.emotion} from ${recent.speechId} for ${speaker}; local emotion was weak`,
      }
    } else {
      const reason = boundary ? `reset at ${boundary.name}` : !recent && previous ? 'prior emotion expired'
        : explicitEmotion ? 'explicit emotion' : strong ? 'strong local emotion' : 'no recent reliable emotion'
      updated = { ...selection, continuity: `${reason}; speaker=${speaker}, local=${selection.emotions.join('/') || 'none'}` }
    }
    result.set(speech.id, updated)
    if ((strong || explicitEmotion) && selection.emotions[0]) {
      history.set(speaker, { emotion: selection.emotions[0], styles: selection.styles, index, speechId: speech.id })
    }
  }
  return result
}

function narrationBridge(
  message: string,
  previous: PlaybackQuote | undefined,
  current: PlaybackQuote | undefined,
): string {
  if (!previous || !current || current.start <= previous.end) return ''
  return cleanPlaybackText(narrativeOnly(message.slice(previous.end, current.start)))
}

export interface SpeakerDecisionThresholds {
  probability: number
  confidence: number
  margin: number
}

/**
 * Gates stay constants instead of becoming settings so the regression corpus
 * can be compared across releases. Discourse escalation is stricter than the
 * local pass, and replacing an already-clear local answer is stricter still.
 */
export const SPEAKER_DECISION_THRESHOLDS: Record<'local' | 'discourse' | 'override', SpeakerDecisionThresholds> = {
  local: { probability: 0.5, confidence: 0.5, margin: 0.15 },
  discourse: { probability: 0.6, confidence: 0.55, margin: 0.2 },
  override: { probability: 0.7, confidence: 0.65, margin: 0.25 },
}

export const TTS_TAG_SCHEMA = 'tts-tags-7'

/** Bump a version whenever a stage changes the output stored in the cache. */
export const SPEAKER_DECISION_SCHEMA = {
  classifier: 'jev-7-named-subjects',
  discourse: 'discourse-1',
  hardBoundary: 'boundary-1',
  turns: 'turn-1',
  chain: 'chain-1',
  narrative: 'narrative-1',
  thresholds: {
    local: 'local-thresholds-1',
    discourse: 'discourse-thresholds-1',
    override: 'discourse-override-thresholds-1',
    chain: 'chain-thresholds-1',
    chainOverride: 'chain-override-thresholds-1',
    card: 'card-thresholds-1',
  },
} as const

/**
 * A card-title match may own a message only when no identity clears these
 * thresholds. One weak guess must not block the fallback for the whole message.
 */
export const SPEAKER_CARD_THRESHOLDS = {
  probability: 0.65,
  confidence: 0.6,
  margin: 0.25,
} as const

export interface SpeakerDecisionEvaluation {
  choice: string | null
  /** Clear identity from the selected option; null when the answer is unresolved. */
  identity: string | null
  resolved: boolean
  leadingChoice: string | null
  leadingIdentity: string | null
  leadingProbability: number
  leadingMargin: number
  choiceProbability: number
  margin: number
  confidence: number
  probabilities: Array<[string, number]>
}

function decisionIdentity(
  option: string | null,
  optionSpeakerIds: Record<string, string>,
): string | null {
  if (option === DECISION_UNCAST_OPTION) return UNCAST_SPEAKER_ID
  if (!option || option === DECISION_UNCLEAR_OPTION) return null
  return optionSpeakerIds[option] ?? null
}

/**
 * Normalize one Jev answer into a clear identity or an unresolved state. The
 * selected option, its probability, Jev's confidence, and the winner margin are
 * independent signals; all must clear the configured gates.
 */
export function evaluateSpeakerDecisionAnswer(
  answer: SpeakerDecisionChoice | undefined,
  optionSpeakerIds: Record<string, string>,
  thresholds: SpeakerDecisionThresholds = SPEAKER_DECISION_THRESHOLDS.local,
): SpeakerDecisionEvaluation {
  const probabilities = answer?.probabilities && typeof answer.probabilities === 'object' && !Array.isArray(answer.probabilities) ? answer.probabilities : {}
  const validScores = Boolean(answer && answer.probabilities === probabilities && Number.isFinite(answer.confidence) && answer.confidence >= 0 && answer.confidence <= 1
    && Object.values(probabilities).every(value => Number.isFinite(value) && value >= 0 && value <= 1))
  const ranked = answer
    ? Object.entries(probabilities)
      .filter((entry): entry is [string, number] => Number.isFinite(entry[1]))
      .sort((left, right) => right[1] - left[1])
    : []
  const choice = answer?.choice ?? null
  const choiceProbability = choice === null ? 0 : probabilities[choice] ?? 0
  const runnerUpProbability = ranked.find(([option]) => option !== choice)?.[1] ?? 0
  const leadingChoice = ranked[0]?.[0] ?? null
  const leadingProbability = ranked[0]?.[1] ?? 0
  const confidence = answer?.confidence ?? 0
  const usableChoice = choice === DECISION_UNCAST_OPTION
    || choice === DECISION_UNCLEAR_OPTION
    || (choice !== null && optionSpeakerIds[choice] !== undefined)
  const clearsGates = Boolean(
    answer && validScores
    && usableChoice
    && choice !== DECISION_UNCLEAR_OPTION
    && choiceProbability >= thresholds.probability
    && confidence >= thresholds.confidence
    && choiceProbability - runnerUpProbability >= thresholds.margin,
  )
  const identity = clearsGates ? decisionIdentity(choice, optionSpeakerIds) : null
  return {
    choice,
    identity,
    resolved: identity !== null,
    leadingChoice,
    leadingIdentity: decisionIdentity(leadingChoice, optionSpeakerIds),
    leadingProbability,
    leadingMargin: leadingProbability - (ranked[1]?.[1] ?? 0),
    choiceProbability,
    margin: choiceProbability - runnerUpProbability,
    confidence,
    probabilities: ranked,
  }
}

function clearDecisionSpeaker(
  answer: SpeakerDecisionChoice | undefined,
  optionSpeakerIds: Record<string, string>,
): string | null | undefined {
  return evaluateSpeakerDecisionAnswer(answer, optionSpeakerIds).identity ?? undefined
}

function decisionDebugIdentity(identity: string | null): string {
  if (identity === null) return 'unclear'
  return identity === UNCAST_SPEAKER_ID ? 'uncast-character' : identity
}

function describeDecisionThresholds(thresholds: SpeakerDecisionThresholds): string {
  return `probability>=${thresholds.probability},confidence>=${thresholds.confidence},margin>=${thresholds.margin}`
}

function decisionAnswerDebug(
  scope: string,
  answer: SpeakerDecisionChoice | undefined,
  optionSpeakerIds: Record<string, string>,
  thresholds: SpeakerDecisionThresholds = SPEAKER_DECISION_THRESHOLDS.local,
  includeThresholds = false,
): string[] {
  const thresholdLines = includeThresholds
    ? [`${scope}-thresholds:${describeDecisionThresholds(thresholds)}`]
    : []
  if (!answer) {
    return [
      `${scope}:missing`,
      `${scope}-normalized:unclear (missing answer)`,
      ...thresholdLines,
    ]
  }
  const evaluation = evaluateSpeakerDecisionAnswer(answer, optionSpeakerIds, thresholds)
  return [
    `${scope}-choice:${answer.choice}`,
    `${scope}-probabilities:${evaluation.probabilities.map(([option, probability]) => `${option}=${probability.toFixed(3)}`).join(',') || 'none'}`,
    `${scope}-confidence:${evaluation.confidence.toFixed(3)}`,
    `${scope}-margin:${evaluation.margin.toFixed(3)}`,
    `${scope}-normalized:${decisionDebugIdentity(evaluation.identity)}`,
    ...thresholdLines,
  ]
}

const MAX_TRANSPARENT_RUN_NARRATION = 160
const MAX_DISCOURSE_QUESTIONS = 256
/** A leading candidate this close to the runner-up cannot drive precedence alone. */
const DISCOURSE_BRITTLE_MARGIN = 0.3

/**
 * Communication channels whose interleaving defeats local inheritance. A
 * channel mention is a discourse cue rather than a run boundary, so interleaved
 * dialogue can still be reviewed as one sequence.
 */
const SPEAKER_CHANNEL_CUES: Array<{ channel: string; pattern: RegExp }> = [
  {
    channel: 'telephone',
    pattern: /\b(?:telephone|phone|landline|handset|receiver|voicemail|dial tone|speakerphone)\b/iu,
  },
  {
    channel: 'radio',
    pattern: /\b(?:radio|walkie[- ]talkie|intercom|two-way|dispatch)\b/iu,
  },
  {
    channel: 'text',
    pattern: /\b(?:text message|texted|texting|typed (?:out|back)|phone screen|message notification|over text)\b/iu,
  },
  {
    channel: 'overheard',
    pattern: /\b(?:overheard|through the wall|muffled (?:voice|voices)|from the (?:hallway|next room|other room))\b/iu,
  },
]

/** Structural boundaries that end a dialogue run instead of bridging it. */
const SPEAKER_HARD_BOUNDARY_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  {
    name: 'time-jump',
    pattern: /\b(?:(?:moments?|minutes?|hours?|days?|weeks?|months?|years?|a while|an hour|a moment)\s+(?:later|before|after)|(?:the|that) (?:next|following) (?:morning|afternoon|evening|night|day|week|month|year)|later that (?:day|night|morning|evening|week|month|year))\b/iu,
  },
  {
    name: 'scene-change',
    pattern: /\b(?:meanwhile|elsewhere|when they (?:arrived|returned|reached)|returns? (?:home|to the)|steps? (?:into|out of) the (?:room|building|hall|office)|enters? the (?:room|building|hall|office))\b/iu,
  },
]

/** A different, unnamed participant taking a turn inside the run. */
const SPEAKER_TURN_SWITCH_PATTERN = /\b(?:(?:another|a second|a third|a new|the other)\s+(?:voice|woman|man|person|speaker|figure|kid|girl|boy)|(?:someone|somebody)\s+(?:else\s+)?(?:says|said|asks|asked|replies|replied|answers|answered|calls|called|whispers|whispered|shouts|shouted)|(?:a|another)\s+voice\s+(?:from|behind|near|across)|from (?:across the room|the (?:hallway|doorway|next room|other room|shadows)))\b/iu

// These state records are type aliases rather than interfaces so the Decision
// state object satisfies the host's JSON value type.
export type SpeakerDiscourseEvidence = {
  choice: string | null
  normalized: 'clear-known' | 'clear-uncast' | 'unresolved'
  identity: string | null
  probabilities: Record<string, number>
  confidence: number
  margin: number
}

export type SpeakerDiscourseTriggerCode =
  | 'adjacent-unresolved'
  | 'unattributed-replies-after-anchor'
  | 'between-anchors'
  | 'paragraph-speech-conflict'
  | 'alternating-participants'
  | 'turn-switch-cue'
  | 'interleaved-channels'
  | 'known-uncast-transition'
  | 'chain-ambiguity'

export type SpeakerDiscourseTrigger = {
  code: SpeakerDiscourseTriggerCode
  detail: string
}

export type SpeakerDiscourseRun = {
  id: string
  paragraphIds: string[]
  speechIds: string[]
  targets: string[]
  triggers: SpeakerDiscourseTrigger[]
  boundaryBeforeParagraphId: string | null
  boundaryAfterParagraphId: string | null
  boundaryBeforeIdentity: string | null
  boundaryAfterIdentity: string | null
  hardBoundaries: string[]
  channels: string[]
}

export interface SpeakerDiscourseRunAssessment extends SpeakerDiscourseRun {
  /** Null when the run escalates; otherwise why first-pass policy stays authoritative. */
  rejection: string | null
}

export type SpeakerDiscourseEvidenceRecord = {
  speechId: string
  paragraphId: string
  speech: SpeakerDiscourseEvidence
  paragraph: SpeakerDiscourseEvidence
  /** Chain evidence produced after the first pass, when available. */
  chain: {
    identity: string | null
    directIdentity: string | null
    margin: number
    filled: boolean
    overrode: boolean
    narrativeAttribution: string | null
  } | null
}

export interface SpeakerDiscoursePlan {
  state: {
    messageRole: 'assistant' | 'user'
    message: string
    speakers: SpeakerDecisionPlan['state']['speakers']
    paragraphs: SpeakerDecisionPlan['state']['paragraphs']
    speeches: SpeakerDecisionPlan['state']['speeches']
    runs: SpeakerDiscourseRun[]
    firstPass: SpeakerDiscourseEvidenceRecord[]
    establishedIdentities: Array<{ identity: string; source: string }>
    cues: string[]
  }
  questions: SpeakerDecisionPlan['questions']
  optionSpeakerIds: Record<string, string>
  runIds: string[]
  targets: string[]
}

export interface SpeakerDiscourseAssessment {
  plan: SpeakerDiscoursePlan | null
  runs: SpeakerDiscourseRunAssessment[]
}

interface SpeakerDecisionSpeechEvidence {
  speechId: string
  paragraphId: string
  speech: SpeakerDecisionEvaluation
  paragraph: SpeakerDecisionEvaluation
}

interface DiscourseParagraph {
  id: string
  index: number
  speechIds: string[]
  narration: string
  channels: string[]
  hardBoundaries: string[]
  turnSwitch: boolean
}

function discourseParagraphs(plan: SpeakerDecisionPlan): DiscourseParagraph[] {
  const speechIdsByParagraph = new Map<string, string[]>()
  for (const speech of plan.state.speeches) {
    const existing = speechIdsByParagraph.get(speech.paragraphId) ?? []
    existing.push(speech.id)
    speechIdsByParagraph.set(speech.paragraphId, existing)
  }
  return plan.state.paragraphs.map((paragraph, index) => {
    const narration = cleanPlaybackText(narrativeOnly(paragraph.text))
    return {
      id: paragraph.id,
      index,
      speechIds: speechIdsByParagraph.get(paragraph.id) ?? [],
      narration,
      channels: SPEAKER_CHANNEL_CUES
        .filter(cue => cue.pattern.test(narration))
        .map(cue => cue.channel),
      hardBoundaries: SPEAKER_HARD_BOUNDARY_PATTERNS
        .filter(boundary => boundary.pattern.test(narration))
        .map(boundary => boundary.name),
      turnSwitch: SPEAKER_TURN_SWITCH_PATTERN.test(narration),
    }
  })
}

function discourseEvidence(evaluation: SpeakerDecisionEvaluation): SpeakerDiscourseEvidence {
  return {
    choice: evaluation.choice,
    normalized: evaluation.identity === null
      ? 'unresolved'
      : evaluation.identity === UNCAST_SPEAKER_ID
        ? 'clear-uncast'
        : 'clear-known',
    identity: evaluation.identity,
    // Only the leading candidates are resent; the complete distribution is
    // already implied by the normalized state and would bloat large rosters.
    probabilities: Object.fromEntries(evaluation.probabilities.slice(0, 5)),
    confidence: evaluation.confidence,
    margin: evaluation.margin,
  }
}

function paragraphAnchorIdentity(
  paragraph: DiscourseParagraph,
  speechEvidence: ReadonlyMap<string, SpeakerDecisionSpeechEvidence>,
  paragraphEvaluations: ReadonlyMap<string, SpeakerDecisionEvaluation>,
  chainDecisions: ReadonlyMap<string, SpeakerChainDecision> = new Map(),
): string | null {
  const paragraphIdentity = paragraphEvaluations.get(paragraph.id)?.identity ?? null
  if (paragraphIdentity) return paragraphIdentity
  const speechIdentities = new Set<string>()
  for (const speechId of paragraph.speechIds) {
    const identity = speechEvidence.get(speechId)?.speech.identity
      ?? chainDecisions.get(speechId)?.identity
      ?? null
    if (identity) speechIdentities.add(identity)
  }
  return speechIdentities.size === 1 ? [...speechIdentities][0] : null
}

interface DiscourseAnchor {
  paragraphId: string
  identity: string
}

function nearestAnchor(
  paragraphs: DiscourseParagraph[],
  speechEvidence: ReadonlyMap<string, SpeakerDecisionSpeechEvidence>,
  paragraphEvaluations: ReadonlyMap<string, SpeakerDecisionEvaluation>,
  startIndex: number,
  step: 1 | -1,
  chainDecisions: ReadonlyMap<string, SpeakerChainDecision> = new Map(),
): DiscourseAnchor | null {
  for (let index = startIndex; index >= 0 && index < paragraphs.length; index += step) {
    const paragraph = paragraphs[index]
    const identity = paragraphAnchorIdentity(paragraph, speechEvidence, paragraphEvaluations, chainDecisions)
    if (identity) return { paragraphId: paragraph.id, identity }
  }
  return null
}

interface DialogueRunDraft {
  paragraphs: string[]
  speeches: string[]
  hard: string[]
}

/**
 * Group speech-bearing paragraphs into structural runs. Short narration beats
 * stay inside a run; hard boundaries or sustained narration split it. This is
 * shared by the first-pass turn questions and the discourse assessment so both
 * stages agree on run membership.
 */
function dialogueRunDrafts(plan: SpeakerDecisionPlan): DialogueRunDraft[] {
  const paragraphs = discourseParagraphs(plan)
  const drafts: DialogueRunDraft[] = []
  let draft: DialogueRunDraft | null = null
  let gap: { paragraphs: string[]; hard: string[]; narrationLength: number } | null = null
  for (const paragraph of paragraphs) {
    if (paragraph.speechIds.length === 0) {
      if (!draft) continue
      gap = gap ?? { paragraphs: [], hard: [], narrationLength: 0 }
      gap.paragraphs.push(paragraph.id)
      gap.hard.push(...paragraph.hardBoundaries)
      gap.narrationLength += paragraph.narration.length
      continue
    }
    if (draft && gap && (gap.hard.length > 0 || gap.narrationLength > MAX_TRANSPARENT_RUN_NARRATION)) {
      drafts.push(draft)
      draft = null
      gap = null
    }
    if (draft && paragraph.hardBoundaries.length > 0) {
      drafts.push(draft)
      draft = null
      gap = null
    }
    if (!draft) draft = { paragraphs: [], speeches: [], hard: [] }
    if (gap) {
      draft.paragraphs.push(...gap.paragraphs)
      gap = null
    }
    draft.paragraphs.push(paragraph.id)
    draft.speeches.push(...paragraph.speechIds)
    draft.hard.push(...paragraph.hardBoundaries)
  }
  if (draft) drafts.push(draft)
  return drafts
}

/**
 * Decide which dialogue runs need a second, discourse-level evaluation.
 *
 * The first pass deliberately asks only local questions, so turn-taking across
 * paragraphs can leave every local answer unresolved or self-contradictory.
 * Detection here is purely structural plus the normalized first-pass evidence;
 * it never assigns a speaker and never alternates turns from paragraph order.
 */
export function assessSpeakerDiscourseEscalation(
  plan: SpeakerDecisionPlan,
  answers: Record<string, SpeakerDecisionChoice>,
  options: { questionLimit?: number } = {},
): SpeakerDiscourseAssessment {
  const questionLimit = Math.min(
    Math.max(Math.floor(options.questionLimit ?? MAX_DISCOURSE_QUESTIONS), 1),
    MAX_DISCOURSE_QUESTIONS,
  )
  const paragraphs = discourseParagraphs(plan)
  const paragraphById = new Map(paragraphs.map(paragraph => [paragraph.id, paragraph]))
  const paragraphEvaluations = new Map(plan.state.paragraphs.map(paragraph => [
    paragraph.id,
    evaluateSpeakerDecisionAnswer(answers[`paragraph_${paragraph.id}`], plan.optionSpeakerIds),
  ]))
  const speechEvidence = new Map<string, SpeakerDecisionSpeechEvidence>()
  for (const speech of plan.state.speeches) {
    speechEvidence.set(speech.id, {
      speechId: speech.id,
      paragraphId: speech.paragraphId,
      speech: evaluateSpeakerDecisionAnswer(answers[`speech_${speech.id}`], plan.optionSpeakerIds),
      paragraph: paragraphEvaluations.get(speech.paragraphId)
        ?? evaluateSpeakerDecisionAnswer(undefined, plan.optionSpeakerIds),
    })
  }
  const chainDecisions = decodeSpeakerChain(plan, answers)
  const effectiveIdentity = (evidence: SpeakerDecisionSpeechEvidence): string | null => (
    evidence.speech.identity ?? chainDecisions.get(evidence.speechId)?.identity ?? null
  )

  const drafts = dialogueRunDrafts(plan)

  const runs: SpeakerDiscourseRunAssessment[] = []
  const escalated: SpeakerDiscourseRun[] = []
  const escalatedTargets: string[] = []
  const cues: string[] = []

  drafts.forEach((runDraft, runIndex) => {
    const runId = `run_${runIndex}`
    const runParagraphs = runDraft.paragraphs
      .map(id => paragraphById.get(id))
      .filter((paragraph): paragraph is DiscourseParagraph => paragraph !== undefined)
    const evidences = runDraft.speeches
      .map(id => speechEvidence.get(id))
      .filter((evidence): evidence is SpeakerDecisionSpeechEvidence => evidence !== undefined)
    const speechParagraphIds = [...new Set(evidences.map(evidence => evidence.paragraphId))]
    const evidenceByParagraph = new Map<string, SpeakerDecisionSpeechEvidence[]>()
    for (const evidence of evidences) {
      const existing = evidenceByParagraph.get(evidence.paragraphId) ?? []
      existing.push(evidence)
      evidenceByParagraph.set(evidence.paragraphId, existing)
    }
    const clearIdentityFor = (paragraphId: string): string | null => {
      const direct = paragraphEvaluations.get(paragraphId)?.identity ?? null
      if (direct) return direct
      const identities = new Set(
        (evidenceByParagraph.get(paragraphId) ?? [])
          .map(evidence => effectiveIdentity(evidence))
          .filter((identity): identity is string => identity !== null),
      )
      return identities.size === 1 ? [...identities][0] : null
    }

    const firstIndex = runParagraphs[0]?.index ?? 0
    const lastIndex = runParagraphs[runParagraphs.length - 1]?.index ?? firstIndex
    const before = nearestAnchor(paragraphs, speechEvidence, paragraphEvaluations, firstIndex - 1, -1, chainDecisions)
    const after = nearestAnchor(paragraphs, speechEvidence, paragraphEvaluations, lastIndex + 1, 1, chainDecisions)
    const channels = [...new Set(runParagraphs.flatMap(paragraph => paragraph.channels))]
    const turnSwitchParagraphs = runParagraphs
      .filter(paragraph => paragraph.turnSwitch)
      .map(paragraph => paragraph.id)

    const hardConflicts = evidences.filter(evidence => {
      const identity = effectiveIdentity(evidence)
      return identity !== null
        && evidence.paragraph.resolved
        && identity !== evidence.paragraph.identity
    })
    const brittleConflicts = evidences.filter(evidence => (
      effectiveIdentity(evidence) === null
      && evidence.paragraph.resolved
      && evidence.speech.leadingIdentity !== null
      && evidence.speech.leadingIdentity !== evidence.paragraph.identity
      && evidence.speech.leadingProbability >= 0.25
      && evidence.speech.leadingMargin < DISCOURSE_BRITTLE_MARGIN
    ))
    const targets = evidences
      // An established continuation has already passed the scene and local
      // speaker-change guards. The discourse roster does not include temporary
      // ghosts, so reviewing it here would force an unrelated cast choice.
      .filter(evidence => !answers[`relationship_continuity_${evidence.speechId}`]
        && (effectiveIdentity(evidence) === null || hardConflicts.includes(evidence)))
      .map(evidence => evidence.speechId)

    const triggers: SpeakerDiscourseTrigger[] = []
    const weakParagraphs = speechParagraphIds.filter(paragraphId => (
      (evidenceByParagraph.get(paragraphId) ?? []).every(evidence => effectiveIdentity(evidence) === null)
    ))
    for (let index = 1; index < weakParagraphs.length; index += 1) {
      const previousPosition = speechParagraphIds.indexOf(weakParagraphs[index - 1])
      const position = speechParagraphIds.indexOf(weakParagraphs[index])
      if (position - previousPosition === 1) {
        triggers.push({
          code: 'adjacent-unresolved',
          detail: `${weakParagraphs[index - 1]} and ${weakParagraphs[index]} both lack clear local identities`,
        })
        break
      }
    }

    let anchored = false
    let unattributedRun = 0
    for (const paragraphId of speechParagraphIds) {
      if (clearIdentityFor(paragraphId)) {
        anchored = true
        unattributedRun = 0
        continue
      }
      if (!anchored) continue
      unattributedRun += 1
      if (unattributedRun >= 2) {
        triggers.push({
          code: 'unattributed-replies-after-anchor',
          detail: `${unattributedRun} unattributed replies ending at ${paragraphId}`,
        })
        break
      }
    }

    if (before && after) {
      triggers.push({
        code: 'between-anchors',
        detail: `between ${before.paragraphId}=${before.identity} and ${after.paragraphId}=${after.identity}`,
      })
    }

    if (hardConflicts.length > 0 || brittleConflicts.length > 0) {
      triggers.push({
        code: 'paragraph-speech-conflict',
        detail: [
          ...(hardConflicts.length > 0
            ? [`clear conflict on ${hardConflicts.map(evidence => evidence.speechId).join(', ')}`]
            : []),
          ...(brittleConflicts.length > 0
            ? [`brittle precedence on ${brittleConflicts.map(evidence => evidence.speechId).join(', ')}`]
            : []),
        ].join('; '),
      })
    }

    const sceneIdentities = new Set<string>()
    for (const evidence of evidences) {
      const identity = effectiveIdentity(evidence)
      if (identity) sceneIdentities.add(identity)
      if (evidence.paragraph.identity) sceneIdentities.add(evidence.paragraph.identity)
    }
    if (before) sceneIdentities.add(before.identity)
    if (after) sceneIdentities.add(after.identity)
    if (sceneIdentities.size >= 2 && targets.length >= 2) {
      triggers.push({
        code: 'alternating-participants',
        detail: `${sceneIdentities.size} participants established around ${targets.length} unresolved speeches`,
      })
    }

    if (turnSwitchParagraphs.length > 0) {
      triggers.push({
        code: 'turn-switch-cue',
        detail: `unnamed turn switch in ${turnSwitchParagraphs.join(', ')}`,
      })
    }

    if (channels.length >= 2) {
      triggers.push({
        code: 'interleaved-channels',
        detail: channels.join(' + '),
      })
    }

    const runIdentities = new Set<string>()
    for (const evidence of evidences) {
      const identity = effectiveIdentity(evidence)
      if (identity) runIdentities.add(identity)
      if (evidence.paragraph.identity) runIdentities.add(evidence.paragraph.identity)
    }
    const hasKnownRunIdentity = [...runIdentities].some(identity => identity !== UNCAST_SPEAKER_ID)
    if (
      hasKnownRunIdentity
      && runIdentities.has(UNCAST_SPEAKER_ID)
      && evidences.some(evidence => effectiveIdentity(evidence) === null)
    ) {
      triggers.push({
        code: 'known-uncast-transition',
        detail: 'known and uncast identities share an ambiguous sequence',
      })
    }

    const chainOverrides = evidences.filter(evidence => chainDecisions.get(evidence.speechId)?.overrode)
    const chainLowMargin = evidences.filter(evidence => {
      const decision = chainDecisions.get(evidence.speechId)
      return decision !== undefined && decision.margin < SPEAKER_CHAIN_THRESHOLDS.acceptMargin
    })
    if (chainOverrides.length > 0 || chainLowMargin.length > 0) {
      triggers.push({
        code: 'chain-ambiguity',
        detail: [
          ...(chainOverrides.length > 0
            ? [`chain overrode ${chainOverrides.map(evidence => evidence.speechId).join(', ')}`]
            : []),
          ...(chainLowMargin.length > 0
            ? [`low chain margin on ${chainLowMargin.map(evidence => evidence.speechId).join(', ')}`]
            : []),
        ].join('; '),
      })
    }

    let rejection: string | null = null
    if (targets.length === 0) {
      rejection = 'no unresolved or conflicting speech'
    } else if (
      targets.length === 1
      && hardConflicts.length === 0
      && brittleConflicts.length === 0
      && !after
      && turnSwitchParagraphs.length === 0
      && channels.length < 2
    ) {
      // A single low-confidence quotation with only upstream evidence keeps
      // ordinary inheritance instead of paying for a discourse pass.
      rejection = 'isolated low-confidence speech with only upstream evidence'
    } else if (triggers.length === 0) {
      rejection = 'no escalation trigger'
    } else if (escalatedTargets.length + targets.length > questionLimit) {
      rejection = `question budget exceeded (${escalatedTargets.length + targets.length}/${questionLimit})`
    }

    const run: SpeakerDiscourseRun = {
      id: runId,
      paragraphIds: runDraft.paragraphs,
      speechIds: runDraft.speeches,
      targets,
      triggers,
      boundaryBeforeParagraphId: before?.paragraphId ?? null,
      boundaryAfterParagraphId: after?.paragraphId ?? null,
      boundaryBeforeIdentity: before?.identity ?? null,
      boundaryAfterIdentity: after?.identity ?? null,
      hardBoundaries: [...new Set(runDraft.hard)],
      channels,
    }
    runs.push({ ...run, rejection })
    if (rejection !== null) return
    escalated.push(run)
    escalatedTargets.push(...targets)
    for (const boundary of run.hardBoundaries) cues.push(`${runId}:hard-boundary:${boundary}`)
    for (const channel of run.channels) cues.push(`${runId}:channel:${channel}`)
    for (const paragraphId of turnSwitchParagraphs) cues.push(`${runId}:turn-switch:${paragraphId}`)
  })

  if (escalated.length === 0) return { plan: null, runs }

  const establishedIdentities: Array<{ identity: string; source: string }> = []
  const seenIdentities = new Set<string>()
  const addIdentity = (identity: string | null, source: string) => {
    if (!identity || seenIdentities.has(identity)) return
    seenIdentities.add(identity)
    establishedIdentities.push({ identity, source })
  }
  for (const paragraph of plan.state.paragraphs) {
    addIdentity(paragraphEvaluations.get(paragraph.id)?.identity ?? null, `paragraph-${paragraph.id}`)
  }
  for (const speech of plan.state.speeches) {
    const evidence = speechEvidence.get(speech.id)
    addIdentity(evidence ? effectiveIdentity(evidence) : null, `speech-${speech.id}`)
  }

  const criteria = speakerDecisionCriteria(plan.state.speakers)
  const questions: SpeakerDecisionPlan['questions'] = {}
  for (const run of escalated) {
    for (const speechId of run.targets) {
      questions[`discourse_${speechId}`] = {
        type: 'choice',
        instructions: `Who speaks quotation ${speechId} in dialogue run ${run.id}? Use the complete dialogue sequence, names, action ownership, pronoun references, response relationships, turn continuity, channel changes, and both boundary anchors. Distinguish speakers from addressees and bystanders. Pronouns are contextual clues, not proof of gender or identity. First-pass answers are evidence, not fixed answers. Do not alternate speakers from paragraph order alone.`,
        criteria,
      }
    }
  }

  const firstPass: SpeakerDiscourseEvidenceRecord[] = escalated.flatMap(run => (
    run.speechIds.flatMap(speechId => {
      const evidence = speechEvidence.get(speechId)
      if (!evidence) return []
      const decision = chainDecisions.get(speechId)
      return [{
        speechId,
        paragraphId: evidence.paragraphId,
        speech: discourseEvidence(evidence.speech),
        paragraph: discourseEvidence(evidence.paragraph),
        chain: decision
          ? {
              identity: decision.identity,
              directIdentity: decision.directIdentity,
              margin: decision.margin,
              filled: decision.filled,
              overrode: decision.overrode,
              narrativeAttribution: decision.narrativeAttribution,
            }
          : null,
      }]
    })
  ))

  return {
    plan: {
      state: {
        messageRole: plan.state.messageRole,
        message: plan.state.message,
        speakers: plan.state.speakers,
        paragraphs: plan.state.paragraphs,
        speeches: plan.state.speeches,
        runs: escalated,
        firstPass,
        establishedIdentities,
        cues,
      },
      questions,
      optionSpeakerIds: plan.optionSpeakerIds,
      runIds: escalated.map(run => run.id),
      targets: escalatedTargets,
    },
    runs,
  }
}

export type SpeakerDiscourseOutcomeReason =
  | 'filled-unresolved'
  | 'overrode-conflict'
  | 'rejected-missing-answer'
  | 'rejected-gates'
  | 'rejected-override-threshold'

export interface SpeakerDiscourseOutcome {
  speechId: string
  runId: string
  applied: boolean
  reason: SpeakerDiscourseOutcomeReason
  identity: string | null
  conflict: boolean
  evaluation: SpeakerDecisionEvaluation
  overrideEvaluation: SpeakerDecisionEvaluation | null
}

/**
 * Apply discourse answers to the first-pass evidence. A discourse answer may
 * fill an unresolved span directly; it may only replace a clear first-pass
 * answer when paragraph and speech disagreed and it clears the higher
 * override threshold.
 */
export function resolveSpeakerDiscourseAnswers(
  discourse: SpeakerDiscoursePlan,
  answers: Record<string, SpeakerDecisionChoice>,
): Map<string, SpeakerDiscourseOutcome> {
  const outcomes = new Map<string, SpeakerDiscourseOutcome>()
  const evidenceById = new Map(discourse.state.firstPass.map(entry => [entry.speechId, entry]))
  const runIdBySpeech = new Map<string, string>()
  for (const run of discourse.state.runs) {
    for (const speechId of run.speechIds) runIdBySpeech.set(speechId, run.id)
  }
  for (const speechId of discourse.targets) {
    const evidence = evidenceById.get(speechId)
    const runId = runIdBySpeech.get(speechId) ?? 'run_unknown'
    const answer = answers[`discourse_${speechId}`]
    const evaluation = evaluateSpeakerDecisionAnswer(
      answer,
      discourse.optionSpeakerIds,
      SPEAKER_DECISION_THRESHOLDS.discourse,
    )
    const speechIdentity = evidence?.speech.identity ?? evidence?.chain?.identity ?? null
    const paragraphIdentity = evidence?.paragraph.identity ?? null
    const conflict = speechIdentity !== null
      && paragraphIdentity !== null
      && speechIdentity !== paragraphIdentity
    if (!answer) {
      outcomes.set(speechId, {
        speechId, runId, conflict, evaluation, overrideEvaluation: null,
        applied: false, reason: 'rejected-missing-answer', identity: null,
      })
      continue
    }
    if (!evaluation.resolved) {
      outcomes.set(speechId, {
        speechId, runId, conflict, evaluation, overrideEvaluation: null,
        applied: false, reason: 'rejected-gates', identity: null,
      })
      continue
    }
    if (!conflict) {
      outcomes.set(speechId, {
        speechId, runId, conflict, evaluation, overrideEvaluation: null,
        applied: true, reason: 'filled-unresolved', identity: evaluation.identity,
      })
      continue
    }
    const overrideEvaluation = evaluateSpeakerDecisionAnswer(
      answer,
      discourse.optionSpeakerIds,
      SPEAKER_DECISION_THRESHOLDS.override,
    )
    outcomes.set(speechId, overrideEvaluation.resolved
      ? {
          speechId, runId, conflict, evaluation, overrideEvaluation,
          applied: true, reason: 'overrode-conflict', identity: overrideEvaluation.identity,
        }
      : {
          speechId, runId, conflict, evaluation, overrideEvaluation,
          applied: false, reason: 'rejected-override-threshold', identity: null,
        })
  }
  return outcomes
}

export const SPEAKER_CHAIN_THRESHOLDS = {
  /** Minimum identity probability for filling an unresolved span. */
  acceptEmission: 0.15,
  /** Minimum path margin for filling an unresolved span. */
  acceptMargin: 1,
  /** Minimum identity probability for overriding a clear answer. */
  overrideEmission: 0.25,
  /** Minimum path margin for overriding a clear answer. */
  overrideMargin: 2,
  /** Switch prior used when a relation answer is missing. */
  neutralSwitch: 0.4,
  /** Floor for the switch probability derived from a relation answer. */
  baseSwitch: 0.15,
  /** Switch probability imposed by an unnamed turn-switch cue in the bridge. */
  turnSwitchCue: 0.7,
  /** Emission bonus for an unambiguous narrative attribution. */
  narrativeAttributionBonus: 0.75,
  /** Identity candidates considered per speech. */
  candidates: 4,
} as const

export interface SpeakerChainDecision {
  speechId: string
  /** Final identity after the decode: direct answer, filled, or overridden. */
  identity: string | null
  /** Best-path identity before acceptance and override gates. */
  decodedIdentity: string | null
  /** Probability of the decoded identity in its speech answer. */
  identityProbability: number
  /** Jev confidence of the speech answer behind the decoded identity. */
  identityConfidence: number
  directIdentity: string | null
  changed: boolean
  filled: boolean
  overrode: boolean
  /** Smaller of the per-position and whole-path margins. */
  margin: number
  relationChoice: string | null
  switchProbability: number
  narrativeAttribution: string | null
}

const NARRATIVE_SPEECH_VERB_PATTERN = new RegExp(
  `\\b(?:${SPEECH_VERBS}|blurt(?:s|ed)|laugh(?:s|ed)|mutter(?:s|ed)|hiss(?:es|ed)|snap(?:s|ped))\\b`,
  'iu',
)

/**
 * Read an unambiguous attribution from a paragraph's narration: a speech verb
 * plus exactly one clean known-speaker mention. This is evidence for the chain,
 * never an assignment on its own.
 */
function narrativeAttributionSpeaker(
  paragraphText: string,
  speakers: CharacterLike[],
): string | null {
  const narration = cleanPlaybackText(narrativeOnly(paragraphText))
  if (!narration || !NARRATIVE_SPEECH_VERB_PATTERN.test(narration)) return null
  const mentions = mentionedSpeakers(narration, speakers)
  if (mentions.clean.size !== 1 || mentions.possessive.size > 0) return null
  return [...mentions.clean][0] ?? null
}

function chainSwitchProbability(
  answer: SpeakerDecisionChoice | undefined,
  bridge: string,
): number {
  let probability: number
  if (!answer) {
    probability = SPEAKER_CHAIN_THRESHOLDS.neutralSwitch
  } else {
    const respond = Math.max(0, answer.probabilities[TURN_RESPOND_OPTION] ?? 0)
    const other = Math.max(0, answer.probabilities[TURN_OTHER_OPTION] ?? 0)
    const unclear = Math.max(0, answer.probabilities[TURN_UNCLEAR_OPTION] ?? 0)
    probability = respond + 0.5 * (other + unclear)
  }
  if (bridge && SPEAKER_TURN_SWITCH_PATTERN.test(bridge)) {
    probability = Math.max(probability, SPEAKER_CHAIN_THRESHOLDS.turnSwitchCue)
  }
  return Math.min(0.95, Math.max(SPEAKER_CHAIN_THRESHOLDS.baseSwitch, probability))
}

/**
 * Jointly decode every dialogue run from identity emissions, turn-relation
 * transitions, and narrative attribution evidence.
 *
 * A decoded identity fills a span whose direct answer is unresolved. A direct
 * clear answer may be overridden only when the chain strongly disagrees and the
 * higher override constants pass. The decode is deterministic and never throws
 * for missing or malformed answers.
 */
export function decodeSpeakerChain(
  plan: SpeakerDecisionPlan,
  answers: Record<string, SpeakerDecisionChoice>,
): Map<string, SpeakerChainDecision> {
  const decisions = new Map<string, SpeakerChainDecision>()
  if (plan.state.turns.length === 0 || plan.state.runs.length === 0) return decisions

  const speakers: CharacterLike[] = plan.state.speakers.map(speaker => ({
    id: speaker.id,
    name: speaker.name,
  }))
  const speechById = new Map(plan.state.speeches.map(speech => [speech.id, speech]))
  const paragraphEvaluations = new Map(plan.state.paragraphs.map(paragraph => [
    paragraph.id,
    evaluateSpeakerDecisionAnswer(answers[`paragraph_${paragraph.id}`], plan.optionSpeakerIds),
  ]))
  const paragraphAttributions = new Map(plan.state.paragraphs.map(paragraph => [
    paragraph.id,
    narrativeAttributionSpeaker(paragraph.text, speakers),
  ]))
  const turnBySpeech = new Map(plan.state.turns.map(turn => [turn.speechId, turn]))
  const speechEvaluations = new Map<string, SpeakerDecisionEvaluation>()
  for (const speech of plan.state.speeches) {
    speechEvaluations.set(
      speech.id,
      evaluateSpeakerDecisionAnswer(answers[`speech_${speech.id}`], plan.optionSpeakerIds),
    )
  }

  const identityProbabilities = new Map<string, Map<string, number>>()
  const candidates = new Map<string, string[]>()
  const emissions = new Map<string, Map<string, number>>()
  for (const speech of plan.state.speeches) {
    const evaluation = speechEvaluations.get(speech.id)
    if (!evaluation) continue
    const byIdentity = new Map<string, number>()
    for (const [option, probability] of evaluation.probabilities) {
      const identity = decisionIdentity(option, plan.optionSpeakerIds)
      if (!identity) continue
      byIdentity.set(identity, (byIdentity.get(identity) ?? 0) + probability)
    }
    const paragraphIdentity = paragraphEvaluations.get(speech.paragraphId)?.identity ?? null
    const attribution = paragraphAttributions.get(speech.paragraphId) ?? null
    const candidateIds = [...byIdentity.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, SPEAKER_CHAIN_THRESHOLDS.candidates)
      .map(([identity]) => identity)
    for (const identity of [paragraphIdentity, attribution, evaluation.identity]) {
      if (identity && !candidateIds.includes(identity)) candidateIds.push(identity)
    }
    if (candidateIds.length === 0) continue
    const emission = new Map<string, number>()
    for (const identity of candidateIds) {
      let score = Math.log(Math.max(byIdentity.get(identity) ?? 0, 1e-6))
      if (identity === attribution) score += SPEAKER_CHAIN_THRESHOLDS.narrativeAttributionBonus
      emission.set(identity, score)
    }
    identityProbabilities.set(speech.id, byIdentity)
    candidates.set(speech.id, candidateIds)
    emissions.set(speech.id, emission)
  }

  const decodeSegment = (speechIds: string[]) => {
    const positionScores: Array<Map<string, number>> = []
    const backPointers: Array<Map<string, string | null>> = []
    speechIds.forEach((speechId, index) => {
      const candidateIds = candidates.get(speechId) ?? []
      const emission = emissions.get(speechId) ?? new Map<string, number>()
      const scores = new Map<string, number>()
      const back = new Map<string, string | null>()
      if (index === 0) {
        for (const identity of candidateIds) {
          scores.set(identity, emission.get(identity) ?? Math.log(1e-6))
          back.set(identity, null)
        }
      } else {
        const previousScores = positionScores[index - 1] ?? new Map<string, number>()
        const previousCandidates = candidates.get(speechIds[index - 1]) ?? []
        const switchProbability = chainSwitchProbability(
          answers[`turn_${speechId}`],
          turnBySpeech.get(speechId)?.bridge ?? '',
        )
        for (const identity of candidateIds) {
          let best = Number.NEGATIVE_INFINITY
          let bestPrevious: string | null = null
          for (const previousIdentity of previousCandidates) {
            const previousScore = previousScores.get(previousIdentity)
            if (previousScore === undefined) continue
            const transition = Math.log(
              identity === previousIdentity ? 1 - switchProbability : switchProbability,
            )
            const score = previousScore + transition
            if (score > best) {
              best = score
              bestPrevious = previousIdentity
            }
          }
          scores.set(identity, best + (emission.get(identity) ?? Math.log(1e-6)))
          back.set(identity, bestPrevious)
        }
      }
      positionScores.push(scores)
      backPointers.push(back)
    })

    const finalScores = [...(positionScores[positionScores.length - 1] ?? new Map<string, number>()).entries()]
      .sort((left, right) => right[1] - left[1])
    if (finalScores.length === 0) return
    const bestTotal = finalScores[0][1]
    const path: string[] = new Array(speechIds.length)
    let state = finalScores[0][0]
    for (let index = speechIds.length - 1; index >= 0; index -= 1) {
      path[index] = state
      state = backPointers[index]?.get(state) ?? state
    }

    // Backward scores turn each position margin into the true decision margin:
    // how much better the best complete path is than the best path that commits
    // to a different identity at this speech.
    const backward: Array<Map<string, number>> = new Array(speechIds.length)
    for (let index = speechIds.length - 1; index >= 0; index -= 1) {
      const scores = new Map<string, number>()
      const candidateIds = candidates.get(speechIds[index]) ?? []
      if (index === speechIds.length - 1) {
        for (const identity of candidateIds) scores.set(identity, 0)
      } else {
        const nextCandidates = candidates.get(speechIds[index + 1]) ?? []
        const nextEmission = emissions.get(speechIds[index + 1]) ?? new Map<string, number>()
        const switchProbability = chainSwitchProbability(
          answers[`turn_${speechIds[index + 1]}`],
          turnBySpeech.get(speechIds[index + 1])?.bridge ?? '',
        )
        for (const identity of candidateIds) {
          let best = Number.NEGATIVE_INFINITY
          for (const nextIdentity of nextCandidates) {
            const score = Math.log(
              identity === nextIdentity ? 1 - switchProbability : switchProbability,
            ) + (nextEmission.get(nextIdentity) ?? Math.log(1e-6))
              + (backward[index + 1]?.get(nextIdentity) ?? 0)
            if (score > best) best = score
          }
          scores.set(identity, best)
        }
      }
      backward[index] = scores
    }

    speechIds.forEach((speechId, index) => {
      const evaluation = speechEvaluations.get(speechId)
      if (!evaluation) return
      const speech = speechById.get(speechId)
      const candidateIds = candidates.get(speechId) ?? []
      const decoded = path[index]
      const probability = identityProbabilities.get(speechId)?.get(decoded) ?? 0
      const direct = evaluation.identity
      const switchProbability = chainSwitchProbability(
        answers[`turn_${speechId}`],
        turnBySpeech.get(speechId)?.bridge ?? '',
      )
      let alternative = Number.NEGATIVE_INFINITY
      for (const identity of candidateIds) {
        if (identity === decoded) continue
        const constrained = (positionScores[index]?.get(identity) ?? Number.NEGATIVE_INFINITY)
          + (backward[index]?.get(identity) ?? Number.NEGATIVE_INFINITY)
        if (constrained > alternative) alternative = constrained
      }
      const margin = alternative === Number.NEGATIVE_INFINITY
        ? Number.POSITIVE_INFINITY
        : bestTotal - alternative
      let identity = direct
      let filled = false
      let overrode = false
      if (direct === null) {
        if (
          probability >= SPEAKER_CHAIN_THRESHOLDS.acceptEmission
          && margin >= SPEAKER_CHAIN_THRESHOLDS.acceptMargin
        ) {
          identity = decoded
          filled = true
        }
      } else if (decoded !== direct) {
        if (
          probability >= SPEAKER_CHAIN_THRESHOLDS.overrideEmission
          && margin >= SPEAKER_CHAIN_THRESHOLDS.overrideMargin
          && switchProbability >= 0.5
        ) {
          identity = decoded
          overrode = true
        }
      }
      decisions.set(speechId, {
        speechId,
        identity,
        decodedIdentity: decoded,
        identityProbability: probability,
        identityConfidence: evaluation.confidence,
        directIdentity: direct,
        changed: identity !== direct,
        filled,
        overrode,
        margin,
        relationChoice: answers[`turn_${speechId}`]?.choice ?? null,
        switchProbability,
        narrativeAttribution: speech
          ? paragraphAttributions.get(speech.paragraphId) ?? null
          : null,
      })
    })
  }

  for (const run of plan.state.runs) {
    let segment: string[] = []
    const flush = () => {
      if (segment.length > 0) decodeSegment(segment)
      segment = []
    }
    for (const speechId of run.speechIds) {
      if (!candidates.has(speechId)) {
        flush()
        continue
      }
      if (segment.length > 0 && !turnBySpeech.has(speechId)) flush()
      segment.push(speechId)
    }
    flush()
  }
  return decisions
}

/**
 * Whether the text explicitly establishes a person other than the card through
 * an anonymous role or an unnamed turn. Pronoun-only scenes do not count, so a
 * unique card can still own a whole-message uncast identity.
 */
function hasExplicitUncastCue(content: string, skippedTrackerTagPairs = ''): boolean {
  const playbackContent = preparePlaybackContent(content, skippedTrackerTagPairs)
  const narration = cleanPlaybackText(narrativeOnly(playbackContent))
  return ANONYMOUS_ROLE_IDENTITY_PATTERN.test(narration)
    || hasAnonymousHumanSubject(narration)
    || SPEAKER_TURN_SWITCH_PATTERN.test(narration)
}

/**
 * Whether a span is written in the first person. In a user message that
 * first-person voice is the user persona; in narration it is the persona
 * narrating their own actions.
 */
function hasFirstPersonPronoun(text: string): boolean {
  return /\b(?:i|me|my|mine|myself)(?:'(?:m|ve|ll|d|re))?\b/iu.test(text)
}

/** Whether a span invokes one of the speaker's name aliases. */
function invokesSpeakerName(text: string, aliases: readonly string[]): boolean {
  return aliases.some(alias => {
    const value = alias.trim()
    return value.length >= 2 && new RegExp(`(^|[^\\p{L}\\p{N}])${escapedPattern(value)}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(text)
  })
}

/**
 * User-message evidence for one speech: first-person "I" in the quotation,
 * or first-person/named narration immediately around it. Per the user's
 * usage policy this is only evidence — Jev still evaluates every speech —
 * but it boosts the user candidate's confidence.
 */
function userCueForSpeech(plan: SpeakerDecisionPlan, speech: SpeakerDecisionPlan['state']['speeches'][number]): boolean {
  const userSpeaker = plan.state.speakers.find(speaker => speaker.id === USER_SPEAKER_ID)
  const aliases = userSpeaker ? speakerAliases(userSpeaker.name) : []
  const narration = `${speech.narrativeBefore} ${speech.narrativeAfter}`
  return hasFirstPersonPronoun(speech.text)
    || hasFirstPersonPronoun(narration)
    || invokesSpeakerName(narration, aliases)
}

/**
 * Deterministic confidence boost for user messages: when a speech carries
 * first-person "I" evidence or a user-name invocation in nearby narration,
 * shift probability toward the user persona option (and lift confidence)
 * before thresholds, chain decoding, and best-available guesses read it.
 * Jev's choice only flips when the boosted user option becomes the strict
 * leader, so a clear Jev verdict for another speaker still stands.
 */
export function applyUserCueConfidenceBoost(plan: SpeakerDecisionPlan, answers: Record<string, SpeakerDecisionChoice>): Set<string> {
  const boosted = new Set<string>()
  const userOption = Object.keys(plan.optionSpeakerIds).find(option => plan.optionSpeakerIds[option] === USER_SPEAKER_ID)
  if (!userOption) return boosted
  for (const speech of plan.state.speeches) {
    if (!userCueForSpeech(plan, speech)) continue
    for (const key of [`speech_${speech.id}`, `best_guess_${speech.id}`]) {
      const answer = answers[key]
      if (!answer || !Object.hasOwn(answer.probabilities, userOption)) continue
      const probabilities = { ...answer.probabilities }
      const current = probabilities[userOption] ?? 0
      const boostedProbability = Math.min(0.99, current + 0.25)
      if (boostedProbability <= current) continue
      const others = 1 - current
      const scale = others > 0 ? (1 - boostedProbability) / others : 0
      for (const option of Object.keys(probabilities)) {
        probabilities[option] = option === userOption ? boostedProbability : (probabilities[option] ?? 0) * scale
      }
      const runnerUp = Math.max(0, ...Object.entries(probabilities).filter(([option]) => option !== userOption).map(([, value]) => value))
      const becomesUser = answer.choice === userOption || boostedProbability > runnerUp
      answers[key] = {
        choice: becomesUser ? userOption : answer.choice,
        probabilities,
        confidence: becomesUser ? Math.min(1, answer.confidence + 0.15) : answer.confidence,
      }
      boosted.add(speech.id)
    }
  }
  return boosted
}

export function resolveSpeakerDecisionSegments(
  content: string,
  plan: SpeakerDecisionPlan,
  answers: Record<string, SpeakerDecisionChoice>,
  speakers: CharacterLike[],
  options: {
    isUserMessage: boolean
    cardSpeakerId: string | null
    historicalSpeakerId: string | null
    evidenceOnly?: boolean
    skippedTrackerTagPairs?: string
    includeDebug?: boolean
    /**
     * Discourse escalation results. The assessment keeps rejected runs so
     * diagnostics can explain why a run stayed on first-pass policy.
     */
    discourse?: {
      assessment: SpeakerDiscourseAssessment
      answers: Record<string, SpeakerDecisionChoice> | null
      status?: string | null
    }
  },
): PlaybackSegment[] {
  // User messages share the assistant pipeline; the only deviations are
  // that first-person/name cues boost the user candidate, and the user
  // (not the card title character) takes the default below.
  const userCueBoosted = options.isUserMessage ? applyUserCueConfidenceBoost(plan, answers) : new Set<string>()
  const paragraphIdentities = new Map(plan.state.paragraphs.map(paragraph => [
    paragraph.id,
    clearDecisionSpeaker(answers[`paragraph_${paragraph.id}`], plan.optionSpeakerIds),
  ]))
  const firstPassSpeechIdentities = plan.state.speeches.map(speech => (
    clearDecisionSpeaker(answers[`speech_${speech.id}`], plan.optionSpeakerIds)
  ))
  const chain = decodeSpeakerChain(plan, answers)
  const discoursePlan = options.discourse?.assessment.plan ?? null
  const discourseAnswers = options.discourse?.answers ?? null
  const discourseOutcomes = discoursePlan && discourseAnswers
    ? resolveSpeakerDiscourseAnswers(discoursePlan, discourseAnswers)
    : new Map<string, SpeakerDiscourseOutcome>()
  const discourseRunBySpeech = new Map<string, SpeakerDiscourseRunAssessment>()
  for (const run of options.discourse?.assessment.runs ?? []) {
    for (const speechId of run.speechIds) discourseRunBySpeech.set(speechId, run)
  }
  const discoursePathBySpeechIndex = new Map<number, string>()
  const chainPathBySpeechIndex = new Map<number, string>()
  const speechIdentities = firstPassSpeechIdentities.map((identity, index) => {
    const speech = plan.state.speeches[index]
    if (options.evidenceOnly && answers[`global_uncertain_${speech.id}`]) {
      const guessed = answers[`best_guess_${speech.id}`]
      const guessedIdentity = guessed ? plan.optionSpeakerIds[guessed.choice] : null
      if (guessedIdentity) {
        discoursePathBySpeechIndex.set(index, 'resolution:best-available speaker (low-confidence guess; not an anchor)')
        return guessedIdentity
      }
      discoursePathBySpeechIndex.set(index, 'resolution:global-context unresolved (chain fill suppressed)')
      return undefined
    }
    const chainDecision = speech ? chain.get(speech.id) : undefined
    if (chainDecision?.filled || chainDecision?.overrode) {
      chainPathBySpeechIndex.set(index, chainDecision.overrode
        ? 'resolution:chain-identity (overrode clear answer)'
        : 'resolution:chain-identity (filled unresolved span)')
    }
    const baseIdentity = (chainDecision?.identity ?? undefined) ?? identity
    if (answers[`relationship_confirmed_${speech.id}`]) {
      discoursePathBySpeechIndex.set(index, 'resolution:global-context confirmed current identity (protected from local override)')
      return identity
    }
    if (answers[`relationship_continuity_${speech.id}`]) {
      discoursePathBySpeechIndex.set(index, answers[`relationship_global_${speech.id}`]
        ? 'resolution:global-context review (protected from local override)'
        : 'resolution:inherited previous assistant speaker (protected from discourse override)')
      return identity
    }
    const outcome = speech ? discourseOutcomes.get(speech.id) : undefined
    if (!outcome?.applied) return baseIdentity
    discoursePathBySpeechIndex.set(index, outcome.reason === 'overrode-conflict'
      ? 'resolution:discourse-identity (overrode paragraph/speech conflict)'
      : 'resolution:discourse-identity (filled unresolved first pass)')
    return outcome.identity ?? undefined
  })
  const hasLocalIdentity = [...paragraphIdentities.values(), ...speechIdentities]
    .some(identity => identity !== undefined)
  const hasUncastIdentity = [...paragraphIdentities.values(), ...speechIdentities]
    .some(identity => identity === UNCAST_SPEAKER_ID)
  const explicitUncastCue = hasExplicitUncastCue(content, options.skippedTrackerTagPairs ?? '')
  const alternativeSpeakers = plan.state.speakers
    .filter(speaker => speaker.id !== options.cardSpeakerId)
    .map(speaker => ({ id: speaker.id, name: speaker.name }))
  const namedAlternative = alternativeSpeakers.length > 0
    && hasNamedSpeakerSubject(content, alternativeSpeakers, options.skippedTrackerTagPairs ?? '')
  const speechEvaluations = new Map(plan.state.speeches.map(speech => [
    speech.id,
    evaluateSpeakerDecisionAnswer(answers[`speech_${speech.id}`], plan.optionSpeakerIds),
  ]))
  const clearsCardThresholds = (evaluation: SpeakerDecisionEvaluation): boolean => (
    evaluation.identity !== null
    && evaluation.choiceProbability >= SPEAKER_CARD_THRESHOLDS.probability
    && evaluation.confidence >= SPEAKER_CARD_THRESHOLDS.confidence
    && evaluation.margin >= SPEAKER_CARD_THRESHOLDS.margin
  )
  const identityStrengths: number[] = []
  let hasStrongIdentity = false
  for (const evaluation of speechEvaluations.values()) {
    if (evaluation.identity === null) continue
    identityStrengths.push(Math.min(evaluation.choiceProbability, evaluation.confidence))
    if (clearsCardThresholds(evaluation)) hasStrongIdentity = true
  }
  for (const decision of chain.values()) {
    if (decision.identity === null) continue
    identityStrengths.push(Math.min(decision.identityProbability, decision.identityConfidence))
    if (decision.overrode || (
      decision.identityProbability >= SPEAKER_CARD_THRESHOLDS.probability
      && decision.identityConfidence >= SPEAKER_CARD_THRESHOLDS.confidence
    )) {
      hasStrongIdentity = true
    }
  }
  for (const outcome of discourseOutcomes.values()) {
    if (!outcome.applied || outcome.identity === null) continue
    identityStrengths.push(Math.min(outcome.evaluation.choiceProbability, outcome.evaluation.confidence))
    if (outcome.reason === 'overrode-conflict' || clearsCardThresholds(outcome.evaluation)) {
      hasStrongIdentity = true
    }
  }
  const maxIdentityStrength = identityStrengths.length > 0 ? Math.max(...identityStrengths) : 0
  const cardBlockDescription = `p>=${SPEAKER_CARD_THRESHOLDS.probability}`
    + `,c>=${SPEAKER_CARD_THRESHOLDS.confidence}`
    + `,m>=${SPEAKER_CARD_THRESHOLDS.margin}`
  const cardReason = explicitUncastCue
    ? 'explicit anonymous role or unnamed turn in narration'
    : namedAlternative
      ? 'narration names another known speaker'
      : hasStrongIdentity
        ? `an identity cleared ${cardBlockDescription}`
        : `no identity cleared ${cardBlockDescription} (max strength ${maxIdentityStrength.toFixed(2)})`
  // A card-title match owns a message only when no speech identity is strong
  // enough to contest it. One weak guess must not veto the fallback, and in
  // a user message the default belongs to the user persona, never the card.
  const cardIdentity = options.cardSpeakerId
    && !options.isUserMessage
    && !explicitUncastCue
    && !namedAlternative
    && !hasStrongIdentity
    ? options.cardSpeakerId
    : null
  const deferredUncast = Boolean(cardIdentity && hasUncastIdentity)
  const routingIdentity = (identity: string | null | undefined): string | undefined => {
    if (identity === undefined || identity === null) return undefined
    return deferredUncast && identity === UNCAST_SPEAKER_ID ? undefined : identity
  }
  const routingIdentities = speechIdentities.map(identity => routingIdentity(identity))
  const resolved: Array<string | null> = []
  const resolutionPaths: string[][] = []
  let upstreamIdentity: string | null = null
  let upstreamSource = 'none'
  let processedParagraphIndex = -1
  for (let index = 0; index < plan.state.speeches.length; index += 1) {
    const speech = plan.state.speeches[index]
    const turnAnswer = answers[`turn_${speech.id}`]
    const clearSpeakerSwitch = turnAnswer?.choice === TURN_RESPOND_OPTION
      && turnAnswer.confidence >= 0.65 && (turnAnswer.probabilities[TURN_RESPOND_OPTION] ?? 0) >= 0.7
    const currentParagraphIndex = Number.parseInt(speech.paragraphId.slice(1), 10)
    while (processedParagraphIndex < currentParagraphIndex) {
      processedParagraphIndex += 1
      const paragraphIdentity = routingIdentity(paragraphIdentities.get(`p${processedParagraphIndex}`))
      if (paragraphIdentity !== undefined) {
        upstreamIdentity = paragraphIdentity
        upstreamSource = `paragraph-p${processedParagraphIndex}`
      }
    }
    const direct = routingIdentities[index]
    if (clearSpeakerSwitch && direct === undefined) {
      upstreamIdentity = null
      upstreamSource = 'speaker-switch'
    }
    let speakerId: string | null
    if (direct !== undefined) {
      speakerId = direct
      upstreamIdentity = direct
      upstreamSource = `speech-s${index}`
      resolutionPaths.push([
        discoursePathBySpeechIndex.get(index)
          ?? chainPathBySpeechIndex.get(index)
          ?? 'resolution:direct-speech-identity',
      ])
    } else if (upstreamIdentity && !clearSpeakerSwitch && !options.evidenceOnly) {
      speakerId = upstreamIdentity
      resolutionPaths.push([`resolution:upstream-identity (${upstreamSource})`])
    } else if (
      options.historicalSpeakerId && !clearSpeakerSwitch
      && (
        routingIdentities.slice(index + 1).some(identity => identity !== undefined)
        || plan.state.paragraphs.slice(currentParagraphIndex + 1)
          .some(paragraph => routingIdentity(paragraphIdentities.get(paragraph.id)) !== undefined)
      )
    ) {
      speakerId = options.historicalSpeakerId
      resolutionPaths.push(['resolution:previous-assistant opening inheritance before later local identity'])
    } else if (cardIdentity) {
      speakerId = cardIdentity
      resolutionPaths.push([
        deferredUncast
          ? 'resolution:unique card-title match (uncast identity had no explicit role cue)'
          : 'resolution:unique card-title match (no local known or uncast identity)',
      ])
    } else if (!hasLocalIdentity && options.historicalSpeakerId && !clearSpeakerSwitch) {
      speakerId = options.historicalSpeakerId
      resolutionPaths.push(['resolution:previous-assistant identity (no local identity or card match)'])
    } else {
      speakerId = options.evidenceOnly ? UNRESOLVED_SPEAKER_ID : (options.isUserMessage ? USER_SPEAKER_ID : null)
      resolutionPaths.push([
        options.evidenceOnly
          ? 'resolution:unresolved speech (connection-default fallback)'
          : options.isUserMessage
          ? 'resolution:user-role fallback (no clear identity)'
          : 'resolution:assistant connection-default fallback (no clear identity)',
      ])
    }
    resolved.push(speakerId)
  }

  let speechIndex = 0
  return parseRosterVoiceSegments(
    content,
    null,
    speakers,
    options.skippedTrackerTagPairs ?? '',
    null,
    true,
  ).map(segment => {
    if (!segment.debugPath?.some(step => step.startsWith('segment-type:speech'))) {
      return options.includeDebug ? segment : { text: segment.text, speakerId: segment.speakerId }
    }
    const index = speechIndex++
    const speakerId = resolved[index] ?? null
    const answer = answers[`speech_s${index}`]
    const speech = plan.state.speeches[index]
    const paragraphAnswer = speech ? answers[`paragraph_${speech.paragraphId}`] : undefined
    const run = speech ? discourseRunBySpeech.get(speech.id) : undefined
    const outcome = speech ? discourseOutcomes.get(speech.id) : undefined
    const discourseAnswer = speech && options.discourse?.answers
      ? options.discourse.answers[`discourse_${speech.id}`]
      : undefined
    const chainDecision = speech ? chain.get(speech.id) : undefined
    const turn = speech
      ? plan.state.turns.find(candidate => candidate.speechId === speech.id)
      : undefined
    return {
      text: segment.text,
      speakerId,
      ...(options.includeDebug ? {
        debugPath: [
          `segment-type:speech (quote ${index + 1})`,
          ...(answers[`first_pass_${speech.id}`] ? decisionAnswerDebug('jev-first-pass-speech', answers[`first_pass_${speech.id}`], plan.optionSpeakerIds) : []),
          ...decisionAnswerDebug('jev-speech', answer, plan.optionSpeakerIds),
          ...(userCueBoosted.has(speech.id) ? ['user-cue-boost: first-person pronoun or user-name invocation shifts confidence toward user persona'] : []),
          ...decisionAnswerDebug('jev-ungrounded-first-pass', answers[`ungrounded_original_${speech.id}`], plan.optionSpeakerIds),
          ...(answers[`ungrounded_original_${speech.id}`] ? ['jev-grounding:unsupported cast identity excluded from first-pass anchor'] : []),
          ...decisionAnswerDebug('jev-relationship-original', answers[`relationship_original_${speech.id}`], plan.optionSpeakerIds),
          ...decisionAnswerDebug('jev-relationship-review', answers[`relationship_review_${speech.id}`], plan.optionSpeakerIds),
          ...decisionAnswerDebug('jev-scene-reference', answers[`scene_reference_${speech.id}`], plan.optionSpeakerIds),
          ...decisionAnswerDebug('jev-scene-secondary', answers[`scene_secondary_${speech.id}`], plan.optionSpeakerIds),
          ...decisionAnswerDebug('jev-scene-link', answers[`scene_link_${speech.id}`], { same_speaker: 'same_speaker', different_person: 'different_person' }),
          ...(index === 0 ? decisionAnswerDebug('jev-boundary-relation', answers.boundary_relation, { continuation: 'continuation', response: 'response', interjection: 'interjection', new_exchange: 'new_exchange' }) : []),
          ...(index === 0 ? decisionAnswerDebug('jev-boundary-addressee', answers.boundary_addressee, plan.optionSpeakerIds) : []),
          ...(run && run.speechIds[0] === speech.id ? decisionAnswerDebug(`jev-run-${run.id}-channel`, answers[`run_channel_${run.id}`], { in_person: 'in_person', phone: 'phone', text_message: 'text_message' }) : []),
          ...(run && run.speechIds[0] === speech.id ? decisionAnswerDebug(`jev-run-${run.id}-participant`, answers[`run_participant_${run.id}`], plan.optionSpeakerIds) : []),
          ...(answers[`scene_applied_${speech.id}`] ? ['jev-scene-reference:actor linked to this speech by independent review'] : []),
          ...(answers[`relationship_inherited_${speech.id}`] ? ['jev-relationship-review:inherited established previous speaker'] : []),
          ...(answers[`relationship_applied_${speech.id}`] ? ['jev-relationship-review:strong alternative applied'] : []),
          ...(answers[`self_intro_reconciled_${speech.id}`] ? ['jev-self-introduction:strongly linked to a verified self-introduction'] : []),
          ...(answers[`explicit_voice_attribution_${speech.id}`] ? ['explicit-voice-attribution:immediate post-quote named voice'] : []),
          ...decisionAnswerDebug('jev-speaker-switch-review', answers[`switch_reconciled_${speech.id}`], plan.optionSpeakerIds),
          ...decisionAnswerDebug('jev-narrative-role-review', answers[`narrative_role_reconciled_${speech.id}`], { role: 'role', other_or_unclear: 'other_or_unclear' }),
          ...decisionAnswerDebug('jev-narrative-exchange-review', answers[`narrative_exchange_reconciled_${speech.id}`], { role: 'role', anchor: 'anchor', other_or_unclear: 'other_or_unclear' }),
          ...decisionAnswerDebug('jev-narrative-local-review', answers[`narrative_local_reconciled_${speech.id}`], { role: 'role', other_or_unclear: 'other_or_unclear' }),
          ...(answers[`joint_chain_${speech.id}`] ? [`joint-chain:heuristic path margin/4=${answers[`joint_chain_${speech.id}`].confidence.toFixed(3)} (not a model probability)`] : []),
          ...(answers[`joint_chain_detail_${speech.id}`] ? [`joint-chain-evidence:${answers[`joint_chain_detail_${speech.id}`].choice}`] : []),
          ...decisionAnswerDebug('jev-speaker-switch-link', answers[`switch_link_reconciled_${speech.id}`], { previous: 'previous', current: 'current', other_or_unclear: 'other_or_unclear' }),
          ...(answers[`relationship_confirmed_${speech.id}`] ? ['jev-relationship-review:accepted first-pass identity confirmed'] : []),
          ...decisionAnswerDebug('jev-contextual-user-review', answers[`persona_check_${speech.id}`], { user: USER_SPEAKER_ID, other: 'other' }),
          ...decisionAnswerDebug('jev-contextual-user-original', answers[`persona_original_${speech.id}`], plan.optionSpeakerIds),
          ...(answers[`persona_confirmed_${speech.id}`] ? ['jev-contextual-user-review:user assignment confirmed'] : []),
          ...decisionAnswerDebug('jev-opening-backlink', answers[`backlink_review_${speech.id}`], { same: 'same', different_or_unclear: 'different_or_unclear' }),
          ...(answers[`relationship_backlink_${speech.id}`] ? ['jev-opening-backlink:accepted same-speaker link to later validated quote'] : []),
          ...decisionAnswerDebug('jev-opening-forwardlink', answers[`forwardlink_review_${speech.id}`], { same: 'same', different_or_unclear: 'different_or_unclear' }),
          ...(answers[`relationship_forwardlink_${speech.id}`] ? ['jev-opening-forwardlink:accepted same-speaker link to earlier validated quote'] : []),
          ...(answers[`relationship_exchange_${speech.id}`] ? ['jev-opening-exchange:strong single-speaker review applied'] : []),
          ...decisionAnswerDebug('jev-opening-exchange-pattern', answers[`opening_pattern_${speech.id}`], { single_speaker: 'single_speaker', multiple_speakers: 'multiple_speakers' }),
          ...decisionAnswerDebug('jev-opening-exchange-speaker', answers[`opening_speaker_${speech.id}`], plan.optionSpeakerIds),
          ...(answers[`global_uncertain_${speech.id}`] ? ['jev-global-review:uncertain; unsupported identity and chain fill suppressed'] : []),
          ...decisionAnswerDebug('jev-best-available-guess', answers[`best_guess_${speech.id}`], plan.optionSpeakerIds),
          ...decisionAnswerDebug('jev-user-review-original', answers[`user_review_original_${speech.id}`], plan.optionSpeakerIds),
          ...decisionAnswerDebug('jev-user-review', answers[`user_review_${speech.id}`], plan.optionSpeakerIds),
          ...(answers[`user_review_applied_${speech.id}`] ? ['jev-user-review:strong alternative applied'] : []),
          ...decisionAnswerDebug(`jev-${speech?.paragraphId ?? 'paragraph'}`, paragraphAnswer, plan.optionSpeakerIds),
          `jev-local-thresholds:${describeDecisionThresholds(SPEAKER_DECISION_THRESHOLDS.local)}`,
          ...(index === 0
            ? [`card-deference:${cardIdentity ? 'eligible' : 'blocked'} (${cardReason})`]
            : []),
          ...(index === 0 && plan.state.turnQuestionsOmitted
            ? ['jev-turn-questions:omitted (first-pass question budget)']
            : []),
          ...relationAnswerDebug(turn, speech ? answers[`turn_${speech.id}`] : undefined),
          ...chainSpeechDebug(chainDecision, speech?.paragraphId),
          ...discourseSpeechDebug({
            run,
            evaluated: Boolean(options.discourse),
            lead: Boolean(speech && run && run.speechIds[0] === speech.id),
            outcome,
            discourseAnswer,
            optionSpeakerIds: plan.optionSpeakerIds,
            status: options.discourse?.status ?? null,
          }),
          ...(resolutionPaths[index] ?? ['resolution:unavailable']),
          `jev-final-speaker:${speakerId ?? 'none'}`,
        ],
      } : {}),
    }
  })
}

function relationAnswerDebug(
  turn: SpeakerDecisionPlan['state']['turns'][number] | undefined,
  answer: SpeakerDecisionChoice | undefined,
): string[] {
  if (!turn) return ['jev-turn:not-applicable (run start or turn questions omitted)']
  if (!answer) return [`jev-turn-${turn.speechId}:missing`]
  const ranked = Object.entries(answer.probabilities)
    .filter((entry): entry is [string, number] => Number.isFinite(entry[1]))
    .sort((left, right) => right[1] - left[1])
  return [
    `jev-turn-${turn.speechId}-choice:${answer.choice}`,
    `jev-turn-${turn.speechId}-probabilities:${ranked.map(([option, probability]) => `${option}=${probability.toFixed(3)}`).join(',') || 'none'}`,
    `jev-turn-${turn.speechId}-confidence:${answer.confidence.toFixed(3)}`,
    `jev-turn-bridge:${turn.bridge || '(none)'}`,
  ]
}

function chainSpeechDebug(
  decision: SpeakerChainDecision | undefined,
  paragraphId?: string,
): string[] {
  if (!decision) return ['chain:not-considered']
  const outcome = decision.overrode
    ? 'overrode-clear'
    : decision.filled
      ? 'filled-unresolved'
      : decision.identity === null
        ? 'retained-unresolved'
        : decision.decodedIdentity !== null && decision.decodedIdentity !== decision.directIdentity
          ? 'override-rejected'
          : 'direct'
  return [
    `chain-decode:${outcome} identity=${decision.identity ?? 'none'}`
      + ` candidate=${decision.decodedIdentity ?? 'none'}`
      + ` direct=${decision.directIdentity ?? 'none'}`
      + ` margin=${Number.isFinite(decision.margin) ? decision.margin.toFixed(2) : 'inf'}`,
    `chain-switch:${decision.switchProbability.toFixed(2)}`
      + ` relation=${decision.relationChoice ?? 'none'}`,
    `chain-narrative:${decision.narrativeAttribution
      ? `attribution=${decision.narrativeAttribution} (paragraph ${paragraphId ?? 'unknown'})`
      : 'none'}`,
  ]
}

function discourseSpeechDebug(input: {
  run: SpeakerDiscourseRunAssessment | undefined
  /** False when the caller did not run the discourse assessment at all. */
  evaluated: boolean
  /** Only the first speech of a run repeats the run-level evidence. */
  lead: boolean
  outcome: SpeakerDiscourseOutcome | undefined
  discourseAnswer: SpeakerDecisionChoice | undefined
  optionSpeakerIds: Record<string, string>
  status: string | null
}): string[] {
  const { run, evaluated, lead, outcome, discourseAnswer, optionSpeakerIds, status } = input
  if (!run) {
    return [evaluated
      ? 'discourse:not-considered (outside a dialogue run)'
      : 'discourse:not-evaluated (no discourse assessment for this request)']
  }
  const lines = lead
    ? [
        `discourse-run:${run.id} speeches=${run.speechIds.join(',')} targets=${run.targets.join(',') || 'none'}`,
        `discourse-triggers:${run.triggers.map(trigger => `${trigger.code} (${trigger.detail})`).join('; ') || 'none'}`,
        `discourse-anchors:before=${run.boundaryBeforeParagraphId ?? 'none'}=${run.boundaryBeforeIdentity ?? 'none'}`
          + ` after=${run.boundaryAfterParagraphId ?? 'none'}=${run.boundaryAfterIdentity ?? 'none'}`,
        `discourse-hard-boundaries:${run.hardBoundaries.join(',') || 'none'}`,
        `discourse-channels:${run.channels.join(',') || 'none'}`,
        run.rejection
          ? `discourse-decision:rejected (${run.rejection})`
          : 'discourse-decision:escalated',
        ...(status ? [`discourse-request:${status}`] : []),
      ]
    : [`discourse-run:${run.id}${run.rejection ? ' (not escalated)' : ''}`]
  if (outcome) {
    lines.push(
      ...decisionAnswerDebug(
        `jev-discourse-${outcome.speechId}`,
        discourseAnswer,
        optionSpeakerIds,
        SPEAKER_DECISION_THRESHOLDS.discourse,
        true,
      ),
      `discourse-conflict:${outcome.conflict}`,
      `discourse-outcome:${outcome.reason}`,
      ...(outcome.overrideEvaluation
        ? [`discourse-override-thresholds:${describeDecisionThresholds(SPEAKER_DECISION_THRESHOLDS.override)}`]
        : []),
    )
  } else if (!run.rejection) {
    lines.push('discourse-outcome:not-a-target (first-pass identity retained)')
  }
  return lines
}

export function needsLlmSpeakerReview(
  content: string,
  defaultSpeakerId: string | null,
  speakers: CharacterLike[],
  skippedTrackerTagPairs = '',
  historicalSpeakerId: string | null = null,
): boolean {
  return speakerReviewQuoteIndexes(
    content,
    defaultSpeakerId,
    speakers,
    skippedTrackerTagPairs,
    historicalSpeakerId,
  ).length > 0
}

export function speakerReviewQuoteIndexes(
  content: string,
  defaultSpeakerId: string | null,
  speakers: CharacterLike[],
  skippedTrackerTagPairs = '',
  historicalSpeakerId: string | null = null,
): number[] {
  const indexes = new Set<number>()
  parseRosterVoiceSegmentsInternal(
    content,
    defaultSpeakerId,
    speakers,
    skippedTrackerTagPairs,
    undefined,
    historicalSpeakerId,
    false,
    indexes,
  )
  return [...indexes]
}

function parseRosterVoiceSegmentsInternal(
  content: string,
  defaultSpeakerId: string | null,
  speakers: CharacterLike[],
  skippedTrackerTagPairs = '',
  quoteSpeakerOverrides?: ReadonlyMap<number, string | null>,
  historicalSpeakerId: string | null = null,
  preserveLocalOnNullOverride = false,
  lowConfidenceQuoteIndexes?: Set<number>,
  includeDebug = false,
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
    if (narration) result.push({
      text: narration,
      speakerId: null,
      ...(includeDebug ? { debugPath: ['segment-type:narration', 'routing:narrator-voice'] } : {}),
    })
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
      const frontedPossessiveSpeakerId = (inference.source === 'history' || inference.source === 'fallback')
        ? frontedPrepositionalPossessiveSubject(bridge, speakers)
        : null
      const previousParagraph = paragraphs[paragraphIndex - 1]
      const currentParagraph = paragraphs[paragraphIndex]
      const currentNarrativePrefix = currentParagraph
        ? currentParagraph.text.slice(0, Math.max(0, quote.start - currentParagraph.start))
        : ''
      const nextQuote = quotes[currentQuoteIndex + 1]
      const downstreamNarrationEnd = currentParagraph
        ? Math.min(
            currentParagraph.end,
            nextQuote && nextQuote.start < currentParagraph.end ? nextQuote.start : currentParagraph.end,
          )
        : quote.end
      const immediateDownstreamNarration = playbackContent.slice(quote.end, downstreamNarrationEnd)
      const anonymousLocalSpeakerId = (inference.source === 'history' || inference.source === 'fallback')
        && paragraphSpeakers[paragraphIndex] === null
        && (
          hasAnonymousHumanSubject(currentNarrativePrefix)
          || !!(
            previousParagraph
            && playbackQuotes(previousParagraph.text).length === 0
            && paragraphSpeakers[paragraphIndex - 1] === null
            && hasAnonymousHumanSubject(previousParagraph.text)
          )
        )
        ? UNCAST_SPEAKER_ID
        : null
      const anonymousDownstreamSpeakerId = (inference.source === 'history' || inference.source === 'fallback')
        && paragraphSpeakers[paragraphIndex] === null
        && hasAnonymousSpeechAttribution(immediateDownstreamNarration)
        ? UNCAST_SPEAKER_ID
        : null
      const anonymousPronounContinuationId: string | null = (inference.source === 'history' || inference.source === 'fallback')
        && paragraphSpeakers[paragraphIndex] === null
        && lastAssignedSpeakerId === UNCAST_SPEAKER_ID
        && hasLeadingPronounSubject(currentNarrativePrefix)
        ? UNCAST_SPEAKER_ID
        : null
      const currentEvidenceSpeakerId = paragraphSpeakers[paragraphIndex]
        ?? frontedPossessiveSpeakerId
        ?? anonymousLocalSpeakerId
        ?? anonymousDownstreamSpeakerId
        ?? anonymousPronounContinuationId
        ?? (inference.confident ? inference.speakerId : null)
      if (
        historicalPrefixActive
        && (
          inference.source === 'explicit'
          || inference.source === 'paragraph'
          || frontedPossessiveSpeakerId !== null
          || anonymousLocalSpeakerId !== null
          || anonymousDownstreamSpeakerId !== null
          || anonymousPronounContinuationId !== null
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
      const adjacentNarrativeSpeakerId = previousParagraph
        && playbackQuotes(previousParagraph.text).length === 0
        ? mainClausePossessiveSubject(
            previousParagraph.text,
            speakers,
            mentionedSpeakers(previousParagraph.text, speakers).possessive,
          )
        : null
      const adjacentNarrativeEvidenceId = previousParagraph
        && playbackQuotes(previousParagraph.text).length === 0
        ? paragraphSpeakers[paragraphIndex - 1]
        : null
      const adjacentNarrativeVoiceSpeakerId = adjacentNarrativeEvidenceId
        && previousParagraph
        && /\b(?:voice|speaks?|spoke|says?|said|asks?|asked|answers?|answered|replies|replied|whispers?|whispered|calls?|called|shouts?|shouted|murmurs?|murmured)\b/iu.test(previousParagraph.text)
        ? adjacentNarrativeEvidenceId
        : null
      const localCandidates: Array<[string, string | null]> = [
        ['current-paragraph-subject', paragraphSpeakers[paragraphIndex]],
        ['preceding-possessive-subject', adjacentNarrativeSpeakerId],
        ['preceding-narrative-voice-subject', adjacentNarrativeVoiceSpeakerId],
        ['fronted-prepositional-possessive-subject', frontedPossessiveSpeakerId],
        ['anonymous-local-subject', anonymousLocalSpeakerId],
        ['anonymous-downstream-attribution', anonymousDownstreamSpeakerId],
        ['anonymous-pronoun-continuation', anonymousPronounContinuationId],
        ['downstream-reply', downstreamReplies.get(paragraphIndex) ?? null],
        ['speaker-continuation', continuedSpeakerId],
        ['dialogue-turn-alternation', inferredTurnSpeakerId],
        ['previous-message-history', historicalFallbackId],
        ['opening-dialogue-backfill', openingSpeakerId],
        [`quote-inference:${inference.source}`, inference.speakerId],
      ]
      const selectedLocalCandidate = localCandidates.find(([, speakerId]) => speakerId !== null)
      const localSpeakerId: string | null = selectedLocalCandidate?.[1] ?? null
      const confidentLocalSpeakerId: string | null = paragraphSpeakers[paragraphIndex]
        ?? adjacentNarrativeEvidenceId
        ?? frontedPossessiveSpeakerId
        ?? anonymousLocalSpeakerId
        ?? anonymousDownstreamSpeakerId
        ?? anonymousPronounContinuationId
        ?? (inference.source === 'explicit' || inference.source === 'paragraph'
          ? inference.speakerId
          : null)
      if (!localSpeakerId || confidentLocalSpeakerId !== localSpeakerId) {
        lowConfidenceQuoteIndexes?.add(currentQuoteIndex)
      }
      const overrideSpeakerId = quoteSpeakerOverrides?.get(currentQuoteIndex) ?? null
      const hasOverride = quoteSpeakerOverrides?.has(currentQuoteIndex) === true
      const speakerId: string | null = hasOverride
        && (!preserveLocalOnNullOverride
          || (overrideSpeakerId !== null && confidentLocalSpeakerId === null)
          || localSpeakerId === null)
        ? overrideSpeakerId
        : localSpeakerId
      result.push({
        text: speech,
        speakerId,
        ...(includeDebug ? {
          debugPath: [
            `segment-type:speech (quote ${currentQuoteIndex + 1})`,
            ...localCandidates.map(([rule, candidate]) => `${rule}:${candidate ?? 'none'}`),
            `local-selection:${selectedLocalCandidate?.[0] ?? 'none'} -> ${localSpeakerId ?? 'none'}`,
            `local-confidence:${confidentLocalSpeakerId === localSpeakerId && localSpeakerId !== null ? 'high' : 'low'}`,
            hasOverride
              ? `llm-override:${overrideSpeakerId ?? 'none'} (${speakerId === overrideSpeakerId ? 'applied' : 'rejected'})`
              : 'llm-override:not-present',
            `parser-result:${speakerId ?? 'none'}`,
          ],
        } : {}),
      })
      if ((inference.confident || openingSpeakerId) && speakerId) lastConfidentSpeakerId = speakerId
      if (speakerId) lastAssignedSpeakerId = speakerId
    }
    cursor = quote.end
  }
  const narration = cleanPlaybackText(playbackContent.slice(cursor))
  if (narration) result.push({
    text: narration,
    speakerId: null,
    ...(includeDebug ? { debugPath: ['segment-type:narration', 'routing:narrator-voice'] } : {}),
  })
  return result
}

export function parseRosterVoiceSegments(
  content: string,
  defaultSpeakerId: string | null,
  speakers: CharacterLike[],
  skippedTrackerTagPairs = '',
  historicalSpeakerId: string | null = null,
  includeDebug = false,
): PlaybackSegment[] {
  return parseRosterVoiceSegmentsInternal(
    content,
    defaultSpeakerId,
    speakers,
    skippedTrackerTagPairs,
    undefined,
    historicalSpeakerId,
    false,
    undefined,
    includeDebug,
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
  includeDebug = false,
): PlaybackSegment[] {
  return parseRosterVoiceSegmentsInternal(
    content,
    defaultSpeakerId,
    speakers,
    skippedTrackerTagPairs,
    new Map(assignments.map(assignment => [assignment.quote, assignment.speakerId])),
    historicalSpeakerId,
    preserveLocalOnNullOverride,
    undefined,
    includeDebug,
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

  // A previous speaker is only a fallback, not evidence that the person in a
  // new opening scene is the same person. Compare explicit subject pronouns
  // near the name; never infer gender from the name or from a voice category.
  const previousSpeaker = speakers.find(speaker => speaker.id === previousSpeakerId)
  const aliases = previousSpeaker ? speakerAliases(previousSpeaker.name) : []
  let priorPronoun: string | null = null
  for (let index = 0; index < previousParagraphs.length; index++) {
    const paragraph = previousParagraphs[index]
    const narrative = narrativeOnly(paragraph.text)
    if (!aliases.some(alias => new RegExp(`\\b${escapedPattern(alias)}\\b`, 'iu').test(narrative))) continue
    const pronouns = new Set([...narrative.matchAll(/\b(he|she|they)\b/giu)].map(match => match[1].toLowerCase()))
    if (pronouns.size === 1) priorPronoun = [...pronouns][0]
    else if (pronouns.size === 0) {
      const following = narrativeOnly(previousParagraphs[index + 1]?.text ?? '').trimStart().match(/^(he|she|they)\b/iu)
      if (following) priorPronoun = following[1].toLowerCase()
    }
  }
  const opening = playbackContent.slice(0, Math.min(playbackContent.length, (quoteMatches[1]?.start ?? quoteMatches[0].end) + 300))
  const openingNarration = narrativeOnly(opening)
  const openingPronouns = new Set([...openingNarration.matchAll(/\b(he|she|they)\b/giu)].map(match => match[1].toLowerCase()))
  if (priorPronoun && openingPronouns.size === 1 && !openingPronouns.has(priorPronoun)) return null

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
