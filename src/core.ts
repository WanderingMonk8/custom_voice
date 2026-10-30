export const CONFIG_KEY = 'chat_voice'
export const USER_SPEAKER_ID = '__chat_voice_user__'
export const UNCAST_SPEAKER_ID = '__chat_voice_uncast__'
export const DEFAULT_MESSAGE_LIMIT = 20
export const MIN_MESSAGE_LIMIT = 1
export const MAX_MESSAGE_LIMIT = 500
export const DEFAULT_SAVED_AUDIO_LIMIT = 50
export const MAX_SAVED_AUDIO_LIMIT = 10_000

export interface FavoriteVoice {
  id: string
  name: string
  category: 'male' | 'female' | 'unspecified'
  description: string
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
      category: row.category === 'male' || row.category === 'female' ? row.category : 'unspecified',
      description: typeof row.description === 'string' ? row.description.trim().slice(0, 500) : '',
    })
  }
  return result
}

/** Reject duplicate provider IDs while preserving all existing favorites. */
export function addFavoriteVoice(existing: FavoriteVoice[], voice: FavoriteVoice): FavoriteVoice[] {
  const id = voice.id.trim().slice(0, 512)
  if (!id) throw new Error('Enter a voice ID to add a favorite.')
  if (existing.some(item => item.id === id)) throw new Error('That voice ID is already a favorite.')
  if (existing.length >= 500) throw new Error('The favorites list is limited to 500 voices.')
  return [...existing, { ...voice, id }]
}

export interface UncastVoiceGroup { id: string; speakerId: string; segmentIndexes: number[]; speeches: string[]; context: string[] }
export interface GhostVoice { id: string; speakerId: string; voiceId: string; context: string; occurrenceKeys: string[]; lastSeenMessageId: string; label?: string }
export const GHOST_VOICE_LIFETIME_MESSAGES = 10

export function readGhostVoices(value: unknown): GhostVoice[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 200).flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const row = item as Record<string, unknown>
    if (typeof row.id !== 'string' || typeof row.speakerId !== 'string' || typeof row.voiceId !== 'string' || !row.id || !row.voiceId) return []
    return [{ id: row.id.slice(0, 128), speakerId: row.speakerId.slice(0, 256), voiceId: row.voiceId.slice(0, 512),
      label: typeof row.label === 'string' ? row.label.trim().slice(0, 100) : '',
      context: typeof row.context === 'string' ? row.context.slice(0, 2_000) : '',
      occurrenceKeys: Array.isArray(row.occurrenceKeys) ? row.occurrenceKeys.filter((key): key is string => typeof key === 'string').slice(-100) : [],
      lastSeenMessageId: typeof row.lastSeenMessageId === 'string' ? row.lastSeenMessageId : '' }]
  })
}

/** The caller supplies assistant-message IDs only, in chronological order. */
export function activeGhostVoices(ghosts: GhostVoice[], assistantMessageIds: readonly string[], targetId: string, lifetime = GHOST_VOICE_LIFETIME_MESSAGES): GhostVoice[] {
  const target = assistantMessageIds.indexOf(targetId)
  if (target < 0) return []
  return ghosts.filter(ghost => {
    if (ghost.occurrenceKeys.some(key => key.startsWith(`${targetId}:`))) return true
    const lastSeen = ghost.lastSeenMessageId ? assistantMessageIds.indexOf(ghost.lastSeenMessageId) : -1
    return (lastSeen >= 0 || !ghost.lastSeenMessageId) && lastSeen <= target && target - lastSeen <= Math.max(1, lifetime)
  })
}

/** Group named unconfigured speakers by identity; anonymous runs stay separate. */
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
    if (id !== UNCAST_SPEAKER_ID && !id.startsWith('unconfigured:')) { anonymous = null; continue }
    if (id !== UNCAST_SPEAKER_ID) anonymous = null
    // A substantial intervening narrative can introduce a different uncast
    // speaker even without an intervening cast quotation. Review each side.
    if (id === UNCAST_SPEAKER_ID && segments[index - 1]?.speakerId === null && segments[index - 1].text.length > 240) anonymous = null
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
  return groups
}

/** Reserve a favorite only while it is unused; a character may keep its own voice. */
export function canReserveAutomaticVoice(voiceId: string, reserved: ReadonlySet<string>, ghosts: readonly GhostVoice[], existingGhostId = ''): boolean {
  return !!voiceId && !reserved.has(voiceId) && !ghosts.some(ghost => ghost.voiceId === voiceId && ghost.id !== existingGhostId)
}

/** Select a suitable unused favorite from Jev's ranking, respecting known gender. */
export function selectAutomaticVoice(voices: FavoriteVoice[], used: ReadonlySet<string>, answer: SpeakerDecisionChoice, gender: string): string {
  if (answer.choice === 'no_match') return ''
  return voices.map((voice, index) => ({ voice, probability: answer.probabilities[`voice_${index}`] ?? 0 }))
    .filter(item => !used.has(item.voice.id) && item.probability > 0 && (gender === 'unknown' || item.voice.category === 'unspecified' || item.voice.category === gender))
    .sort((a, b) => b.probability - a.probability)[0]?.voice.id ?? ''
}

/** Only unassigned favorites may be used; unspecified categories remain eligible. */
export function availableUncastVoices(favorites: FavoriteVoice[], used: readonly string[]): FavoriteVoice[] {
  const reserved = new Set(used.map(voice => voice.trim()).filter(Boolean))
  return favorites.filter(voice => !reserved.has(voice.id))
}

/** Collect possible descriptive identities; Jev decides whether any refers to a speaker. */
export function uncastIdentityLabels(message: string, ghosts: GhostVoice[]): string[] {
  const labels = new Set<string>()
  for (const ghost of ghosts) if (ghost.label) labels.add(ghost.label.toLowerCase())
  for (const match of message.matchAll(/\b(?:the|an?)\s+([a-z][a-z'-]{2,})(?:['?]s)?\b/giu)) {
    labels.add(`the ${match[1].toLowerCase().replace(/['?]s$/u, '')}`)
    if (labels.size >= 80) break
  }
  return [...labels].slice(0, 80)
}

/** One decision call classifies each uncast group and ranks the available voice descriptions. */
export function buildUncastVoiceDecision(groups: UncastVoiceGroup[], voices: FavoriteVoice[], message: string, ghosts: GhostVoice[] = []) {
  const labels = uncastIdentityLabels(message, ghosts)
  const state = {
    message,
    characters: groups.map(group => ({ id: group.id, identity: group.speakerId, speeches: group.speeches, context: group.context })),
    ghosts: ghosts.map((ghost, index) => ({ option: `ghost_${index}`, identity: ghost.speakerId, label: ghost.label || null, context: ghost.context })),
    voices: voices.map((voice, index) => ({ option: `voice_${index}`, name: voice.name, category: voice.category, description: voice.description })),
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
      criteria: { none: 'No reliable descriptive identity.', ...Object.fromEntries(labels.map((label, index) => [`label_${index}`, label])) },
    }
    const earlier = groups.slice(0, groups.indexOf(group))
    if (ghosts.length || earlier.length) questions[`identity_${group.id}`] = {
      type: 'choice', instructions: `Does character ${group.id} clearly represent the same individual as one prior character? Compare all contexts and dialogue, not just shared gender or voice. Select new_or_unclear unless the identity is clear.`,
      criteria: { new_or_unclear: 'A new character, or identity cannot be reliably established.',
        ...Object.fromEntries(ghosts.map((ghost, index) => [`ghost_${index}`, `Previously seen character ${ghost.label || ghost.speakerId}; context: ${ghost.context}`])),
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
    questions[`voice_${group.id}`] = {
      type: 'choice', instructions: `Rank the available voices for the person who actually speaks the quoted dialogue in ${group.id}. Narration-only bystanders and people merely addressed are not speakers. Use the full scene as context, including other character groups only when clearly the same speaker. Choose no_match if no voice is suitable.`,
      criteria: { ...Object.fromEntries(state.voices.map(voice => [voice.option, `${voice.name || 'Unnamed voice'}; ${voice.category}; ${voice.description || 'No description provided.'}`])), no_match: 'No available voice is suitable.' },
    }
  }
  return { state, questions }
}

export interface UncastVoiceAssignment { groupId: string; voiceId: string; gender: string; ghostId?: string; label?: string }

export function resolveUncastVoiceDecisions(
  groups: UncastVoiceGroup[], voices: FavoriteVoice[], answers: Record<string, SpeakerDecisionChoice>,
  ghosts: GhostVoice[] = [], reserved: readonly string[] = [], messageId = '', message = '', previousMessageIds: readonly string[] = [],
): UncastVoiceAssignment[] {
  const used = new Set<string>(reserved.filter(Boolean))
  const assignments: UncastVoiceAssignment[] = []
  const roots = new Map<string, string>()
  const linkedGhosts = new Map<string, GhostVoice>()
  const labels = uncastIdentityLabels(message, ghosts)
  const groupLabels = new Map<string, string>()
  const rootByLabel = new Map<string, string>()
  const strongChoice = (answer: SpeakerDecisionChoice | undefined): boolean => {
    if (!answer || answer.choice === 'new_or_unclear') return false
    const probability = answer.probabilities[answer.choice] ?? 0
    const runnerUp = Math.max(0, ...Object.entries(answer.probabilities).filter(([key]) => key !== answer.choice).map(([, p]) => p))
    return answer.confidence >= 0.8 && probability >= 0.8 && probability - runnerUp >= 0.25
  }
  // Resolve identity links before choosing voices, so later evidence can help
  // the whole character even when the first group has no suitable match.
  for (const group of groups) {
    let root = group.id
    const occurrenceKey = messageId ? `${messageId}:${hashMessageContent(group.speeches.join('\n'))}` : ''
    const exact = ghosts.find(item => occurrenceKey && item.occurrenceKeys.includes(occurrenceKey))
      ?? (group.speakerId !== UNCAST_SPEAKER_ID ? ghosts.find(item => item.speakerId === group.speakerId) : undefined)
    const identity = answers[`identity_${group.id}`]
    const labelAnswer = answers[`label_${group.id}`]
    const labelIndex = labelAnswer?.choice.match(/^label_(\d+)$/u)
    const labelProbability = labelAnswer ? labelAnswer.probabilities[labelAnswer.choice] ?? 0 : 0
    const labelRunnerUp = labelAnswer ? Math.max(0, ...Object.entries(labelAnswer.probabilities).filter(([key]) => key !== labelAnswer.choice).map(([, probability]) => probability)) : 0
    const label = labelIndex && labelAnswer && labelAnswer.confidence >= 0.7 && labelProbability >= 0.7 && labelProbability - labelRunnerUp >= 0.25 ? labels[Number(labelIndex[1])] : undefined
    if (label) groupLabels.set(group.id, label)
    const previousGroups = groups.slice(0, groups.indexOf(group)).slice(-8)
    const same = previousGroups.flatMap(previous => {
      const answer = answers[`same_${group.id}_${previous.id}`]
      return answer?.choice === 'same' && strongChoice(answer) ? [{ previous, probability: answer.probabilities.same ?? 0 }] : []
    }).sort((a, b) => b.probability - a.probability)
    if (same[0]) root = roots.get(same[0].previous.id) ?? root
    else if (label && rootByLabel.has(label)) root = rootByLabel.get(label)!
    else if (strongChoice(identity) && identity?.choice.startsWith('group_')) root = roots.get(identity.choice.slice(6)) ?? root
    const namedGhosts = label ? ghosts.filter(item => item.label?.toLowerCase() === label) : []
    const rankedGhosts = namedGhosts.map(item => ({ item, recent: Math.max(
      previousMessageIds.indexOf(item.lastSeenMessageId),
      ...item.occurrenceKeys.map(key => previousMessageIds.indexOf(key.split(':', 1)[0])),
    ) })).sort((a, b) => b.recent - a.recent)
    const priorGhost = rankedGhosts[0]?.recent >= 0 && (rankedGhosts.length === 1 || rankedGhosts[0].recent > rankedGhosts[1].recent) ? rankedGhosts[0].item : undefined
    let ghost = namedGhosts.length === 1 ? namedGhosts[0] : priorGhost ?? exact
    if (!ghost && strongChoice(identity) && identity?.choice.startsWith('ghost_')) ghost = ghosts[Number(identity.choice.slice(6))]
    roots.set(group.id, root)
    if (label && !rootByLabel.has(label)) rootByLabel.set(label, root)
    // A matching earlier group owns the voice, even if a previous replay
    // cached a different voice for this individual turn.
    if (ghost && !reserved.includes(ghost.voiceId) && !linkedGhosts.has(root)) linkedGhosts.set(root, ghost)
  }
  for (const root of new Set(roots.values())) {
    const members = groups.filter(group => roots.get(group.id) === root)
    const genderVotes = members.map(group => answers[`gender_${group.id}`]).filter(answer => answer && (answer.choice === 'male' || answer.choice === 'female') && answer.confidence >= 0.6 && (answer.probabilities[answer.choice] ?? 0) >= 0.6)
    const genders = new Set(genderVotes.map(answer => answer.choice))
    const gender = genders.size === 1 ? genderVotes[0].choice : 'unknown'
    let ghost = linkedGhosts.get(root)
    if (!ghost) {
      const matches = members.map(group => answers[`voice_${group.id}`]).filter(answer => answer && answer.choice !== 'no_match')
      const ranked = voices.flatMap((voice, index) => {
        if (used.has(voice.id) || (gender !== 'unknown' && voice.category !== 'unspecified' && voice.category !== gender)) return []
        const scores = matches.map(match => match.probabilities[`voice_${index}`] ?? 0).filter(score => Number.isFinite(score) && score > 0)
        return scores.length ? [{ voice, score: scores.reduce((sum, score) => sum + score, 0) / scores.length, index }] : []
      }).sort((a, b) => b.score - a.score || a.index - b.index)
      if (!ranked[0]) continue
      ghost = { id: `pending:${root}`, speakerId: members[0].speakerId, voiceId: ranked[0].voice.id, context: members.flatMap(group => group.context).join(' ').slice(0, 2_000), occurrenceKeys: [], lastSeenMessageId: messageId }
    }
    used.add(ghost.voiceId)
    const label = ghost.label || members.map(group => groupLabels.get(group.id)).find(Boolean)
    for (const group of members) assignments.push({ groupId: group.id, voiceId: ghost.voiceId, gender, ghostId: ghost.id, ...(label ? { label } : {}) })
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
  'it', 'its', 'or', 'she', 'so', 'somewhere', 'that', 'the', 'their', 'then',
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
      instructions: `Which identity is locally established as the acting or speaking subject of paragraph ${paragraph.id}? Judge the paragraph's narration together with any quotations in it, not card or history preference.`,
      criteria,
    }
  }
  for (const speech of stateSpeeches) {
    questions[`speech_${speech.id}`] = {
      type: 'choice',
      instructions: `Who speaks quotation ${speech.id}? Use the quotation, the narration before and after it, short narration between quotations, attribution, action ownership, pronouns, and dialogue flow. Do not prefer a known speaker merely because they are listed.`,
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
    if (!speaker || speaker === UNCAST_SPEAKER_ID) {
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
  classifier: 'jev-5',
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
  const ranked = answer
    ? Object.entries(answer.probabilities)
      .filter((entry): entry is [string, number] => Number.isFinite(entry[1]))
      .sort((left, right) => right[1] - left[1])
    : []
  const choice = answer?.choice ?? null
  const choiceProbability = choice === null ? 0 : answer?.probabilities[choice] ?? 0
  const runnerUpProbability = ranked.find(([option]) => option !== choice)?.[1] ?? 0
  const leadingChoice = ranked[0]?.[0] ?? null
  const leadingProbability = ranked[0]?.[1] ?? 0
  const confidence = answer?.confidence ?? 0
  const usableChoice = choice === DECISION_UNCAST_OPTION
    || choice === DECISION_UNCLEAR_OPTION
    || (choice !== null && optionSpeakerIds[choice] !== undefined)
  const clearsGates = Boolean(
    answer
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
      .filter(evidence => effectiveIdentity(evidence) === null || hardConflicts.includes(evidence))
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
        instructions: `Who speaks quotation ${speechId} in dialogue run ${run.id}? Use the complete dialogue sequence, response relationships, turn continuity, channel changes, and both boundary anchors. First-pass answers are evidence, not fixed answers. Do not alternate speakers from paragraph order alone.`,
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

export function resolveSpeakerDecisionSegments(
  content: string,
  plan: SpeakerDecisionPlan,
  answers: Record<string, SpeakerDecisionChoice>,
  speakers: CharacterLike[],
  options: {
    isUserMessage: boolean
    cardSpeakerId: string | null
    historicalSpeakerId: string | null
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
    const chainDecision = speech ? chain.get(speech.id) : undefined
    if (chainDecision?.filled || chainDecision?.overrode) {
      chainPathBySpeechIndex.set(index, chainDecision.overrode
        ? 'resolution:chain-identity (overrode clear answer)'
        : 'resolution:chain-identity (filled unresolved span)')
    }
    const baseIdentity = (chainDecision?.identity ?? undefined) ?? identity
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
  // enough to contest it. One weak guess must not veto the fallback.
  const cardIdentity = options.cardSpeakerId
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
    } else if (upstreamIdentity) {
      speakerId = upstreamIdentity
      resolutionPaths.push([`resolution:upstream-identity (${upstreamSource})`])
    } else if (
      options.historicalSpeakerId
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
    } else if (!hasLocalIdentity && options.historicalSpeakerId) {
      speakerId = options.historicalSpeakerId
      resolutionPaths.push(['resolution:previous-assistant identity (no local identity or card match)'])
    } else {
      speakerId = options.isUserMessage ? USER_SPEAKER_ID : null
      resolutionPaths.push([
        options.isUserMessage
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
          ...decisionAnswerDebug('jev-speech', answer, plan.optionSpeakerIds),
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
