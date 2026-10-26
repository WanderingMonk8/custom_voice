import type {
  SpindleFrontendContext,
  SpindleTextInputHandle,
} from 'lumiverse-spindle-types'
import {
  adaptiveGenerationConcurrency,
  addUnconfiguredDialogueSpeakers,
  bufferAwareGenerationConcurrency,
  clampSavedAudioLimit,
  DEFAULT_SAVED_AUDIO_LIMIT,
  eligibleCardFallbackSpeakerId,
  encodeConcatenatedWav,
  expiredSavedAudioRecords,
  hashMessageContent,
  mergeVoicePlan,
  npcSpeakerId,
  normalizeSpeakerName,
  parseRosterVoiceSegments,
  playbackVoiceForSpeaker,
  preferredCardSpeakerId,
  readSavedAudioHistory,
  reducedRequestWindowLimit,
  rollingRequestWindowDelay,
  speakerAliases,
  speakerAliasIdLookup,
  speakersForMessageRole,
  splitLargeVoicePlanSegments,
  shouldPersistMessageAudio,
  UNCAST_SPEAKER_ID,
  USER_SPEAKER_ID,
  upsertSavedAudioRecord,
  type PlaybackSegment,
  type SavedAudioRecord,
} from './core'

interface TtsConnection {
  id: string
  name: string
  provider?: string
  model?: string
  voice?: string
  is_default?: boolean
}

interface ConnectionPage {
  data?: TtsConnection[]
  total?: number
}

interface SynthesisPacer {
  nextStartAt: number
  startQueue: Promise<void>
  recentStarts: number[]
  windowRequestLimit: number
}

interface RateLimitBudget {
  blockedUntil: number
  cumulativeWaitMs: number
  consecutiveResponses: number
  maximumWaitMs: number
  recovering: boolean
  recoveryTail: Promise<void>
}

interface VoiceGateWaiter {
  voice: string
  signal: AbortSignal
  resolve: (release: () => void) => void
  reject: (error: DOMException) => void
  abort: () => void
}

/**
 * Some TTS providers apply a request's voice through mutable connection state.
 * Keep different voices from overlapping on one connection while still allowing
 * the configured concurrency for adjacent segments that use the same voice.
 */
class ConnectionVoiceGate {
  private activeVoice: string | null = null
  private activeCount = 0
  private readonly queue: VoiceGateWaiter[] = []

  acquire(voice: string, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new DOMException('Playback stopped.', 'AbortError'))
    const voiceKey = voice.trim()
    return new Promise((resolve, reject) => {
      const waiter: VoiceGateWaiter = {
        voice: voiceKey,
        signal,
        resolve,
        reject,
        abort: () => {
          const index = this.queue.indexOf(waiter)
          if (index >= 0) this.queue.splice(index, 1)
          reject(new DOMException('Playback stopped.', 'AbortError'))
          this.drain()
        },
      }
      if (this.activeCount === 0 && this.queue.length === 0) {
        this.activate(waiter)
      } else if (this.activeVoice === voiceKey && this.queue.length === 0) {
        this.activate(waiter)
      } else {
        this.queue.push(waiter)
        signal.addEventListener('abort', waiter.abort, { once: true })
      }
    })
  }

  private activate(waiter: VoiceGateWaiter): void {
    waiter.signal.removeEventListener('abort', waiter.abort)
    if (waiter.signal.aborted) {
      waiter.reject(new DOMException('Playback stopped.', 'AbortError'))
      this.drain()
      return
    }
    this.activeVoice = waiter.voice
    this.activeCount += 1
    let released = false
    waiter.resolve(() => {
      if (released) return
      released = true
      this.activeCount -= 1
      if (this.activeCount === 0) {
        this.activeVoice = null
        this.drain()
      }
    })
  }

  private drain(): void {
    if (this.activeCount !== 0) return
    while (this.queue[0]?.signal.aborted) {
      const waiter = this.queue.shift()!
      waiter.signal.removeEventListener('abort', waiter.abort)
      waiter.reject(new DOMException('Playback stopped.', 'AbortError'))
    }
    const nextVoice = this.queue[0]?.voice
    if (nextVoice === undefined) return
    const batch: VoiceGateWaiter[] = []
    while (this.queue[0]?.voice === nextVoice) batch.push(this.queue.shift()!)
    for (const waiter of batch) this.activate(waiter)
  }
}

const MIN_SYNTHESIS_START_INTERVAL_MS = 1_250
const SYNTHESIS_REQUEST_WINDOW_MS = 60_000
const DEFAULT_SYNTHESIS_REQUESTS_PER_WINDOW = 18
const MIN_SYNTHESIS_REQUESTS_PER_WINDOW = 6
const DEFAULT_PLAYBACK_BUFFER_SEGMENTS = 2
const DEFAULT_CONCURRENT_GENERATIONS = 4
const DEFAULT_RATE_LIMIT_WAIT_SECONDS = 60
const MAX_PLAYBACK_BUFFER_SEGMENTS = 20
const MAX_CONCURRENT_GENERATIONS = 10
const MAX_RATE_LIMIT_WAIT_SECONDS = 3_600
const NORMALIZATION_TARGET_RMS = 0.1
const NORMALIZATION_SILENCE_GATE = 0.01
const NORMALIZATION_MIN_DURATION_SECONDS = 0.6
const NORMALIZATION_MIN_ACTIVE_SECONDS = 0.25
const NORMALIZATION_PROFILE_WEIGHT = 0.75
const NORMALIZATION_MIN_GAIN = 10 ** (-6 / 20)
const NORMALIZATION_MAX_GAIN = 10 ** (6 / 20)
const NORMALIZATION_PEAK_CEILING = 10 ** (-1 / 20)

/** Stable short fingerprint for comparing generated audio in debug logs. */
function fingerprintAudio(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data)
  let hash = 0x811c9dc5
  for (const byte of bytes) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

interface DetectedCharacterState {
  id: string
  name: string
  messageCount: number
  voice: string
}

interface ActiveChatState {
  id: string
  name: string
  messageLimit: number
  connectionId: string
  narratorVoice: string
  userVoice: string
  useGlobalNarratorVoice: boolean
  useGlobalUserVoice: boolean
  cardCharacterIds: string[]
  characters: DetectedCharacterState[]
}

interface StatePayload {
  type: 'chat_voice_state'
  chat: ActiveChatState | null
  clientRevision?: number
  requestId?: string
}

interface ErrorPayload {
  type: 'chat_voice_error'
  error: string
  clientRevision?: number
  requestId?: string
}

interface ScanCompletePayload {
  type: 'chat_voice_scan_complete'
  chatId: string
  cardParserFallback?: boolean
}

interface MessagePayload {
  type: 'chat_voice_message'
  requestId: string
  chatId: string
  message: PlaybackMessage | null
  error?: string
}

interface ParsedMessagePayload {
  type: 'chat_voice_parsed_message'
  requestId: string
  chatId: string
  messageId: string
  segments?: PlaybackSegment[]
  usedLlm?: boolean
  error?: string
}

interface DecisionConnectionStatus {
  available: boolean
  hasConnection: boolean
  defaultConnectionName: string | null
}

interface DecisionStatusPayload extends DecisionConnectionStatus {
  type: 'chat_voice_decision_status'
  requestId?: string
}

interface LlmConnection {
  id: string
  name: string
  provider: string
  model: string
  is_default: boolean
}

interface LlmConnectionsPayload {
  type: 'chat_voice_llm_connections'
  requestId: string
  connections: LlmConnection[]
  error?: string
}

interface TagPlacementPayload {
  type: 'chat_voice_tag_placement'
  requestId: string
  placements: Array<{ id: string; text: string; emotionTag?: string; modulationTag?: string }>
  error?: string
}

/** Result of asking the backend for reviewed speaker assignments. */
interface SpeakerParseReview {
  segments: PlaybackSegment[]
  /** Whether Jev supplied the assignments; null when the backend did not say. */
  usedLlm: boolean | null
  /** True when the backend request failed and the message-local parser was used. */
  failed: boolean
}

interface PlaybackMessage {
  id: string
  is_user: boolean
  name: string
  content: string
  swipe_id?: number
  extra?: Record<string, unknown>
}

interface SynthesizedVoiceSegment {
  data: ArrayBuffer
  mime: string
  /** Short content fingerprint used only for diagnostics across replays. */
  fingerprint?: string
  decodedBuffer?: AudioBuffer
  normalizationGain?: number
}

interface SavedAudioAttachment {
  type?: string
  image_id?: string
  swipe_id?: number
}

interface SavedMessageAudioResult {
  message?: {
    id?: string
    extra?: { attachments?: SavedAudioAttachment[] }
  }
  audio?: {
    id?: string
    mime_type?: string
    size_bytes?: number
  }
  muxed_with_ffmpeg?: boolean
  swipe_id?: number
}

interface PlaybackPreferences {
  speed: number
  volume: number
  connectionId: string
  saveGeneratedAudio: boolean
  savedAudioLimit: number
  skippedTrackerTags: string
  speakerParsingMode: 'off' | 'ambiguous'
  ttsTagStyle: 'off' | 'gemini' | 'gemini38' | 'fish'
  ttsTagPlacement: 'jev' | 'llm'
  tagLlmConnectionId: string
  tagLlmModel: string
  playbackBufferSegments: number
  concurrentGenerations: number
  rateLimitWaitSeconds: number
  speakerAssignmentDebug: boolean
  defaultNarratorVoice: string
  defaultUserVoice: string
}

function clampIntegerSetting(value: unknown, fallback: number, maximum: number): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(maximum, Math.max(1, Math.round(numeric)))
}

const VOICE_ICON = `
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M5 10v4M9 7v10M13 4v16M17 8v8M21 10v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  </svg>
`

const STOP_ACTION_ICON = `<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>`
const PLAY_TTS_ACTION_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5Z" fill="currentColor"/><path d="M15 9.5a4 4 0 0 1 0 5M18 7a7.5 7.5 0 0 1 0 10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`
const RENAME_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true"><path d="M4 20h4l11-11-4-4L4 16v4Zm9.5-13.5 4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`

async function listAllTtsConnections(): Promise<TtsConnection[]> {
  const pageSize = 200
  const connections: TtsConnection[] = []
  let offset = 0
  while (true) {
    const response = await fetch(`/api/v1/tts-connections?limit=${pageSize}&offset=${offset}`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`Could not load TTS connections (${response.status}).`)
    const page = await response.json() as ConnectionPage
    const items = Array.isArray(page.data) ? page.data : []
    connections.push(...items)
    offset += items.length
    if (items.length === 0 || offset >= (page.total ?? items.length)) break
  }
  return connections
}

async function loadPlaybackPreferences(): Promise<PlaybackPreferences> {
  const response = await fetch('/api/v1/settings/voiceSettings', {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) return {
    speed: 1,
    volume: 1,
    connectionId: '',
    saveGeneratedAudio: false,
    savedAudioLimit: DEFAULT_SAVED_AUDIO_LIMIT,
    skippedTrackerTags: '',
    speakerParsingMode: 'ambiguous',
    ttsTagStyle: 'off',
    ttsTagPlacement: 'jev',
    tagLlmConnectionId: '',
    tagLlmModel: '',
    playbackBufferSegments: DEFAULT_PLAYBACK_BUFFER_SEGMENTS,
    concurrentGenerations: DEFAULT_CONCURRENT_GENERATIONS,
    rateLimitWaitSeconds: DEFAULT_RATE_LIMIT_WAIT_SECONDS,
    speakerAssignmentDebug: false,
    defaultNarratorVoice: '',
    defaultUserVoice: '',
  }
  const row = await response.json() as { value?: Record<string, unknown> }
  const speed = typeof row.value?.ttsSpeed === 'number' ? row.value.ttsSpeed : 1
  const volume = typeof row.value?.ttsVolume === 'number' ? row.value.ttsVolume : 1
  const speakerParsingMode = row.value?.chatVoiceSpeakerParsingMode === 'off'
    ? 'off'
    : 'ambiguous'
  const ttsTagStyle = row.value?.chatVoiceTtsTagStyle === 'gemini'
    || row.value?.chatVoiceTtsTagStyle === 'gemini38'
    || row.value?.chatVoiceTtsTagStyle === 'fish'
    ? row.value.chatVoiceTtsTagStyle
    : 'off'
  const ttsTagPlacement = row.value?.chatVoiceTtsTagPlacement === 'llm' ? 'llm' : 'jev'
  return {
    speed: Math.min(4, Math.max(0.25, speed)),
    volume: Math.min(1, Math.max(0, volume)),
    connectionId: typeof row.value?.ttsConnectionId === 'string'
      ? row.value.ttsConnectionId.trim()
      : '',
    saveGeneratedAudio: row.value?.chatVoiceSaveGeneratedAudio === true,
    savedAudioLimit: clampSavedAudioLimit(row.value?.chatVoiceSavedAudioLimit),
    skippedTrackerTags: typeof row.value?.chatVoiceSkippedTrackerTags === 'string'
      ? row.value.chatVoiceSkippedTrackerTags.slice(0, 4_000)
      : '',
    speakerParsingMode,
    ttsTagStyle,
    ttsTagPlacement,
    tagLlmConnectionId: typeof row.value?.chatVoiceTagLlmConnectionId === 'string'
      ? row.value.chatVoiceTagLlmConnectionId.trim().slice(0, 128)
      : '',
    tagLlmModel: typeof row.value?.chatVoiceTagLlmModel === 'string'
      ? row.value.chatVoiceTagLlmModel.trim().slice(0, 256)
      : '',
    playbackBufferSegments: clampIntegerSetting(
      row.value?.chatVoicePlaybackBufferSegments,
      DEFAULT_PLAYBACK_BUFFER_SEGMENTS,
      MAX_PLAYBACK_BUFFER_SEGMENTS,
    ),
    concurrentGenerations: clampIntegerSetting(
      row.value?.chatVoiceConcurrentGenerations,
      DEFAULT_CONCURRENT_GENERATIONS,
      MAX_CONCURRENT_GENERATIONS,
    ),
    rateLimitWaitSeconds: clampIntegerSetting(
      row.value?.chatVoiceRateLimitWaitSeconds,
      DEFAULT_RATE_LIMIT_WAIT_SECONDS,
      MAX_RATE_LIMIT_WAIT_SECONDS,
    ),
    speakerAssignmentDebug: row.value?.chatVoiceSpeakerAssignmentDebug === true,
    defaultNarratorVoice: typeof row.value?.chatVoiceDefaultNarratorVoice === 'string'
      ? row.value.chatVoiceDefaultNarratorVoice.trim().slice(0, 512)
      : '',
    defaultUserVoice: typeof row.value?.chatVoiceDefaultUserVoice === 'string'
      ? row.value.chatVoiceDefaultUserVoice.trim().slice(0, 512)
      : '',
  }
}

let voiceSettingsWriteQueue = Promise.resolve()

function updateVoiceSettings(
  update: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const task = voiceSettingsWriteQueue.then(async () => {
    const response = await fetch('/api/v1/settings/voiceSettings', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`Could not load global voice settings (${response.status}).`)
    const row = await response.json() as { value?: Record<string, unknown> }
    const current = row.value && typeof row.value === 'object' ? row.value : {}
    const saved = await fetch('/api/v1/settings/voiceSettings', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ value: update(current) }),
    })
    if (!saved.ok) throw new Error(`Could not save global voice settings (${saved.status}).`)
  })
  voiceSettingsWriteQueue = task.catch(() => undefined)
  return task
}

function saveGeneratedAudioPreference(enabled: boolean): Promise<void> {
  return updateVoiceSettings(current => ({
    ...current,
    chatVoiceSaveGeneratedAudio: enabled,
  }))
}

function saveGeneratedAudioLimit(limit: number): Promise<void> {
  return updateVoiceSettings(current => ({
    ...current,
    chatVoiceSavedAudioLimit: clampSavedAudioLimit(limit),
  }))
}

function saveSkippedTrackerTagsPreference(value: string): Promise<void> {
  return updateVoiceSettings(current => ({
    ...current,
    chatVoiceSkippedTrackerTags: value.slice(0, 4_000),
  }))
}

function saveLlmParsingPreferences(
  mode: 'off' | 'ambiguous',
): Promise<void> {
  return updateVoiceSettings(current => ({
    ...current,
    chatVoiceSpeakerParsingMode: mode,
  }))
}

function saveTtsTagPreferences(
  style: 'off' | 'gemini' | 'gemini38' | 'fish',
  placement: 'jev' | 'llm',
  connectionId: string,
  model: string,
): Promise<void> {
  return updateVoiceSettings(current => ({
    ...current,
    chatVoiceTtsTagStyle: style,
    chatVoiceTtsTagPlacement: placement,
    chatVoiceTagLlmConnectionId: connectionId.trim().slice(0, 128),
    chatVoiceTagLlmModel: model.trim().slice(0, 256),
  }))
}

function saveAdvancedPlaybackPreferences(
  bufferSegments: number,
  concurrentGenerations: number,
  rateLimitWaitSeconds: number,
  speakerAssignmentDebug: boolean,
): Promise<void> {
  return updateVoiceSettings(current => ({
    ...current,
    chatVoicePlaybackBufferSegments: clampIntegerSetting(
      bufferSegments,
      DEFAULT_PLAYBACK_BUFFER_SEGMENTS,
      MAX_PLAYBACK_BUFFER_SEGMENTS,
    ),
    chatVoiceConcurrentGenerations: clampIntegerSetting(
      concurrentGenerations,
      DEFAULT_CONCURRENT_GENERATIONS,
      MAX_CONCURRENT_GENERATIONS,
    ),
    chatVoiceRateLimitWaitSeconds: clampIntegerSetting(
      rateLimitWaitSeconds,
      DEFAULT_RATE_LIMIT_WAIT_SECONDS,
      MAX_RATE_LIMIT_WAIT_SECONDS,
    ),
    chatVoiceSpeakerAssignmentDebug: speakerAssignmentDebug,
  }))
}

function saveDefaultRoleVoice(role: 'narrator' | 'user', voice: string): Promise<void> {
  const key = role === 'narrator'
    ? 'chatVoiceDefaultNarratorVoice'
    : 'chatVoiceDefaultUserVoice'
  return updateVoiceSettings((current) => {
    const next = { ...current }
    next[key] = voice.trim().slice(0, 512)
    return next
  })
}

async function deleteSavedAudioRecord(record: SavedAudioRecord): Promise<boolean> {
  const response = await fetch(
    `/api/v1/chats/${encodeURIComponent(record.chatId)}/messages/${encodeURIComponent(record.messageId)}/attachments/${encodeURIComponent(record.audioId)}`,
    { method: 'DELETE', credentials: 'same-origin', headers: { Accept: 'application/json' } },
  )
  return response.ok || response.status === 404
}

async function enforceSavedAudioRetention(nextRecord?: SavedAudioRecord): Promise<number> {
  let expired: SavedAudioRecord[] = []
  await updateVoiceSettings(current => {
    const limit = clampSavedAudioLimit(current.chatVoiceSavedAudioLimit)
    const history = nextRecord
      ? upsertSavedAudioRecord(readSavedAudioHistory(current.chatVoiceSavedAudioHistory), nextRecord)
      : readSavedAudioHistory(current.chatVoiceSavedAudioHistory)
    expired = expiredSavedAudioRecords(history, limit)
    return { ...current, chatVoiceSavedAudioHistory: history }
  })
  if (expired.length === 0) return 0

  const deletedAudioIds: string[] = []
  for (const record of expired) {
    if (await deleteSavedAudioRecord(record)) deletedAudioIds.push(record.audioId)
  }
  if (deletedAudioIds.length > 0) {
    const deleted = new Set(deletedAudioIds)
    await updateVoiceSettings(current => ({
      ...current,
      chatVoiceSavedAudioHistory: readSavedAudioHistory(current.chatVoiceSavedAudioHistory)
        .filter(record => !deleted.has(record.audioId)),
    }))
  }
  if (deletedAudioIds.length !== expired.length) {
    throw new Error('Some older recordings could not be removed; cleanup will retry after the next save.')
  }
  return deletedAudioIds.length
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    const abort = () => {
      window.clearTimeout(timer)
      reject(new DOMException('Playback stopped.', 'AbortError'))
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

function retryAfterMilliseconds(value: string | null): number | null {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : null
}

function normalizedVoiceGain(
  buffer: AudioBuffer,
  voiceKey: string,
  profiles: Map<string, number>,
): number {
  let peak = 0
  let gatedSquareSum = 0
  let gatedSampleCount = 0
  let activeFrames = 0
  const channels = Array.from(
    { length: buffer.numberOfChannels },
    (_, channel) => buffer.getChannelData(channel),
  )
  for (let frame = 0; frame < buffer.length; frame += 1) {
    let framePeak = 0
    let frameSquareSum = 0
    for (const channel of channels) {
      const sample = channel[frame] ?? 0
      const magnitude = Math.abs(sample)
      framePeak = Math.max(framePeak, magnitude)
      peak = Math.max(peak, magnitude)
      frameSquareSum += sample * sample
    }
    if (framePeak < NORMALIZATION_SILENCE_GATE) continue
    activeFrames += 1
    gatedSquareSum += frameSquareSum
    gatedSampleCount += channels.length
  }

  const measuredRms = gatedSampleCount > 0 ? Math.sqrt(gatedSquareSum / gatedSampleCount) : 0
  const substantial = buffer.duration >= NORMALIZATION_MIN_DURATION_SECONDS
    && activeFrames >= buffer.sampleRate * NORMALIZATION_MIN_ACTIVE_SECONDS
    && measuredRms > 0
  const previousRms = profiles.get(voiceKey)
  if (substantial) {
    profiles.set(
      voiceKey,
      previousRms === undefined
        ? measuredRms
        : previousRms * NORMALIZATION_PROFILE_WEIGHT + measuredRms * (1 - NORMALIZATION_PROFILE_WEIGHT),
    )
  }

  const referenceRms = profiles.get(voiceKey)
  let gain = referenceRms === undefined
    ? 1
    : Math.min(NORMALIZATION_MAX_GAIN, Math.max(NORMALIZATION_MIN_GAIN, NORMALIZATION_TARGET_RMS / referenceRms))
  if (peak > 0) gain = Math.min(gain, NORMALIZATION_PEAK_CEILING / peak)
  return Math.max(0, gain)
}

async function waitForSynthesisSlot(pacer: SynthesisPacer, signal: AbortSignal): Promise<void> {
  const turn = pacer.startQueue.then(async () => {
    while (true) {
      const now = Date.now()
      pacer.recentStarts = pacer.recentStarts.filter(start => start > now - SYNTHESIS_REQUEST_WINDOW_MS)
      const windowDelay = rollingRequestWindowDelay(
        pacer.recentStarts,
        now,
        pacer.windowRequestLimit,
        SYNTHESIS_REQUEST_WINDOW_MS,
      )
      const delay = Math.max(0, pacer.nextStartAt - now, windowDelay)
      await abortableDelay(delay, signal)
      const readyAt = Date.now()
      if (readyAt < pacer.nextStartAt) continue
      if (rollingRequestWindowDelay(
        pacer.recentStarts,
        readyAt,
        pacer.windowRequestLimit,
        SYNTHESIS_REQUEST_WINDOW_MS,
      ) > 0) continue
      pacer.recentStarts.push(readyAt)
      pacer.nextStartAt = readyAt + MIN_SYNTHESIS_START_INTERVAL_MS
      return
    }
  })
  pacer.startQueue = turn.catch(() => undefined)
  await turn
}

async function acquireRateLimitRecoverySlot(
  budget: RateLimitBudget,
  signal: AbortSignal,
): Promise<() => void> {
  if (!budget.recovering) return () => undefined
  let releaseSlot!: () => void
  const slot = new Promise<void>((resolve) => { releaseSlot = resolve })
  const previous = budget.recoveryTail
  budget.recoveryTail = previous.catch(() => undefined).then(() => slot)
  try {
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(new DOMException('Playback stopped.', 'AbortError'))
      if (signal.aborted) {
        abort()
        return
      }
      signal.addEventListener('abort', abort, { once: true })
      void previous.catch(() => undefined).then(() => {
        signal.removeEventListener('abort', abort)
        resolve()
      })
    })
  } catch (error) {
    releaseSlot()
    throw error
  }
  if (signal.aborted) {
    releaseSlot()
    throw new DOMException('Playback stopped.', 'AbortError')
  }
  let released = false
  return () => {
    if (released) return
    released = true
    releaseSlot()
  }
}

async function synthesizeVoiceSegment(
  connectionId: string,
  text: string,
  voice: string,
  speed: number,
  signal: AbortSignal,
  pacer: SynthesisPacer,
  rateLimitBudget: RateLimitBudget,
  voiceGate: ConnectionVoiceGate,
  onRateLimit: (delayMs: number, cumulativeWaitMs: number) => void,
): Promise<SynthesizedVoiceSegment> {
  while (true) {
    const releaseRecovery = await acquireRateLimitRecoverySlot(rateLimitBudget, signal)
    let releaseVoice: (() => void) | null = null
    let response: Response
    let audioData: ArrayBuffer | null = null
    try {
      releaseVoice = await voiceGate.acquire(voice, signal)
      await waitForSynthesisSlot(pacer, signal)
      response = await fetch('/api/v1/tts/synthesize', {
        method: 'POST',
        credentials: 'same-origin',
        signal,
        headers: { 'Content-Type': 'application/json', Accept: 'audio/*' },
        body: JSON.stringify({
          connectionId,
          text,
          voice: voice || undefined,
          parameters: { speed },
        }),
      })
      if (response.ok) audioData = await response.arrayBuffer()
    } finally {
      releaseVoice?.()
      releaseRecovery()
    }
    if (response.ok) {
      if (!rateLimitBudget.recovering) rateLimitBudget.consecutiveResponses = 0
      return {
        data: audioData!,
        mime: response.headers.get('content-type') || 'audio/mpeg',
        fingerprint: fingerprintAudio(audioData!),
      }
    }
    if (response.status === 429) {
      rateLimitBudget.recovering = true
      const now = Date.now()
      pacer.windowRequestLimit = reducedRequestWindowLimit(
        pacer.windowRequestLimit,
        MIN_SYNTHESIS_REQUESTS_PER_WINDOW,
      )
      const rollingDelay = rollingRequestWindowDelay(
        pacer.recentStarts,
        now,
        pacer.windowRequestLimit,
        SYNTHESIS_REQUEST_WINDOW_MS,
      )
      const requestedDelay = Math.max(
        retryAfterMilliseconds(response.headers.get('Retry-After')) ?? 0,
        Math.min(15_000, 2_000 * (2 ** rateLimitBudget.consecutiveResponses)),
        rollingDelay,
      )
      rateLimitBudget.consecutiveResponses += 1
      const currentBlockEnd = Math.max(now, rateLimitBudget.blockedUntil)
      const desiredBlockEnd = now + requestedDelay
      const requestedExtension = Math.max(0, desiredBlockEnd - currentBlockEnd)
      const remainingBudget = rateLimitBudget.maximumWaitMs - rateLimitBudget.cumulativeWaitMs
      if (remainingBudget <= 0 && requestedExtension > 0) {
        throw new Error('TTS rate limiting reached the configured wait limit. Try playback again in a moment.')
      }
      const addedWait = Math.min(requestedExtension, Math.max(0, remainingBudget))
      rateLimitBudget.cumulativeWaitMs += addedWait
      rateLimitBudget.blockedUntil = currentBlockEnd + addedWait
      const retryDelay = Math.max(0, rateLimitBudget.blockedUntil - now)
      pacer.nextStartAt = Math.max(pacer.nextStartAt, rateLimitBudget.blockedUntil)
      onRateLimit(retryDelay, rateLimitBudget.cumulativeWaitMs)
      continue
    }
    const detail = await response.text().catch(() => '')
    throw new Error(detail || `TTS synthesis failed (${response.status}).`)
  }
}

async function saveMessageAudio(
  chatId: string,
  messageId: string,
  swipeId: number | undefined,
  segments: SynthesizedVoiceSegment[],
  signal: AbortSignal,
): Promise<SavedMessageAudioResult> {
  const form = new FormData()
  form.append('chatId', chatId)
  form.append('messageId', messageId)
  if (typeof swipeId === 'number') form.append('swipeId', String(swipeId))
  segments.forEach((segment, index) => {
    const blob = new Blob([segment.data], { type: segment.mime || 'audio/mpeg' })
    form.append('segment', blob, `seg-${String(index).padStart(4, '0')}`)
  })
  const response = await fetch('/api/v1/tts/save-message-audio', {
    method: 'POST',
    credentials: 'same-origin',
    signal,
    body: form,
  })
  const responseText = await response.text()
  if (!response.ok) {
    let body: { error?: string } | null = null
    try { body = JSON.parse(responseText) as { error?: string } } catch { /* non-JSON server error */ }
    throw new Error(body?.error || `Could not save generated audio (${response.status}).`)
  }

  let result: SavedMessageAudioResult
  try {
    result = JSON.parse(responseText) as SavedMessageAudioResult
  } catch {
    throw new Error('Lumiverse returned an invalid response after saving generated audio.')
  }
  const savedAudioId = result.audio?.id
  const attachments = result.message?.extra?.attachments
  const attached = Array.isArray(attachments) && attachments.some(attachment => (
    attachment?.type === 'audio' && attachment.image_id === savedAudioId
  ))
  if (result.message?.id !== messageId || !savedAudioId || !attached) {
    throw new Error('Lumiverse did not confirm the generated audio attachment on the message.')
  }
  return result
}

/** Force the host TTS parser to route only quoted text to character voices. */
async function ensureQuotationRouting(): Promise<void> {
  await updateVoiceSettings(current => {
    const currentRules = current.speechDetectionRules && typeof current.speechDetectionRules === 'object'
      ? current.speechDetectionRules as Record<string, unknown>
      : {}
    return {
      ...current,
      speechDetectionRules: {
        ...currentRules,
        quoted: 'speech',
        undecorated: 'narration',
        asterisked: 'narration',
      },
    }
  })
}

export function setup(ctx: SpindleFrontendContext) {
  const removeStyle = ctx.dom.addStyle(`
    .chat-voice-panel { display:flex; flex-direction:column; gap:16px; padding:16px; }
    .chat-voice-context, .chat-voice-hint, .chat-voice-status {
      color:var(--lumiverse-text-muted); font-size:12px; line-height:1.45;
    }
    .chat-voice-context { min-height:18px; }
    .chat-voice-field { display:flex; flex-direction:column; gap:7px; }
    .chat-voice-scan-row { display:grid; grid-template-columns:minmax(0, 1fr) auto; gap:8px; align-items:center; }
    .chat-voice-scan-button {
      min-height:36px; padding:0 14px; border:1px solid var(--lumiverse-border);
      border-radius:var(--lumiverse-radius); background:var(--lumiverse-accent, #7c6df2);
      color:#fff; font:inherit; font-size:12px; font-weight:700; cursor:pointer;
    }
    .chat-voice-scan-button:hover:not(:disabled) { filter:brightness(1.08); }
    .chat-voice-scan-button:disabled { cursor:not-allowed; opacity:.5; }
    .chat-voice-label { color:var(--lumiverse-text); font-size:12px; font-weight:600; }
    .chat-voice-role-heading { display:flex; align-items:center; justify-content:space-between; gap:10px; }
    .chat-voice-role-default {
      display:flex; align-items:center; gap:5px; color:var(--lumiverse-text-muted);
      font-size:11px; font-weight:400; cursor:pointer;
    }
    .chat-voice-role-default input { margin:0; accent-color:var(--lumiverse-accent, #7c6df2); }
    .chat-voice-role-default:has(input:disabled) { cursor:not-allowed; opacity:.55; }
    .chat-voice-toggle {
      display:flex; align-items:flex-start; gap:9px; color:var(--lumiverse-text); font-size:12px;
      cursor:pointer;
    }
    .chat-voice-toggle input { margin:2px 0 0; accent-color:var(--lumiverse-accent, #7c6df2); }
    .chat-voice-toggle-copy { display:flex; flex-direction:column; gap:2px; }
    .chat-voice-toggle-hint { color:var(--lumiverse-text-muted); font-size:11px; line-height:1.4; }
    .chat-voice-debug-output {
      width:100%; min-height:220px; box-sizing:border-box; resize:vertical; padding:9px 10px;
      border:1px solid var(--lumiverse-border); border-radius:var(--lumiverse-radius);
      background:var(--lumiverse-fill-subtle); color:var(--lumiverse-text); font:11px/1.45 monospace;
      white-space:pre; overflow:auto;
    }
    .chat-voice-debug-output[hidden] { display:none; }
    .chat-voice-storage { display:flex; flex-direction:column; gap:9px; }
    .chat-voice-retention { display:flex; align-items:center; justify-content:space-between; gap:12px; }
    .chat-voice-retention-copy { color:var(--lumiverse-text-muted); font-size:11px; line-height:1.4; }
    .chat-voice-retention-input {
      width:82px; min-height:34px; box-sizing:border-box; padding:6px 9px;
      border:1px solid var(--lumiverse-border); border-radius:var(--lumiverse-radius);
      background:var(--lumiverse-fill-subtle); color:var(--lumiverse-text); font:inherit;
    }
    .chat-voice-section-title {
      margin:2px 0 0; color:var(--lumiverse-text); font-size:13px; font-weight:700;
    }
    .chat-voice-character-list { display:flex; flex-direction:column; gap:10px; }
    .chat-voice-character {
      display:flex; flex-direction:column; gap:7px; padding:11px;
      border:1px solid var(--lumiverse-border); border-radius:var(--lumiverse-radius);
      background:var(--lumiverse-fill-subtle);
    }
    .chat-voice-character-heading { display:flex; justify-content:space-between; gap:8px; align-items:baseline; }
    .chat-voice-character-meta { display:flex; align-items:center; gap:6px; }
    .chat-voice-character-name { color:var(--lumiverse-text); font-size:12px; font-weight:600; }
    .chat-voice-character-count { color:var(--lumiverse-text-muted); font-size:11px; white-space:nowrap; }
    .chat-voice-empty {
      padding:12px; text-align:center; color:var(--lumiverse-text-muted); font-size:12px;
      border:1px dashed var(--lumiverse-border); border-radius:var(--lumiverse-radius);
    }
    .chat-voice-add-row { display:grid; grid-template-columns:minmax(0, 1fr) auto; gap:8px; }
    .chat-voice-add-button, .chat-voice-rename-button, .chat-voice-delete-button {
      border:1px solid var(--lumiverse-border); border-radius:6px; background:var(--lumiverse-fill-subtle);
      color:var(--lumiverse-text); font:inherit; cursor:pointer;
    }
    .chat-voice-add-button { min-width:58px; padding:0 12px; font-size:12px; font-weight:600; }
    .chat-voice-rename-button, .chat-voice-delete-button {
      display:inline-flex; align-items:center; justify-content:center; width:24px; height:24px; padding:0;
    }
    .chat-voice-delete-button { font-size:16px; line-height:1; }
    .chat-voice-add-button:disabled, .chat-voice-rename-button:disabled, .chat-voice-delete-button:disabled {
      opacity:.5; cursor:not-allowed;
    }
    .chat-voice-status { min-height:18px; }
    .chat-voice-status[data-state="saved"] { color:var(--lumiverse-success, #65b97a); }
    .chat-voice-status[data-state="error"] { color:var(--lumiverse-danger, #ef6464); }
    .chat-voice-advanced-section { border-top:1px solid var(--lumiverse-border); padding-top:12px; }
    .chat-voice-advanced-summary {
      display:flex; align-items:center; justify-content:space-between; cursor:pointer;
      font-weight:700; list-style:none; user-select:none;
    }
    .chat-voice-advanced-summary::-webkit-details-marker { display:none; }
    .chat-voice-advanced-summary::after { content:'›'; color:var(--lumiverse-text-muted); transform:rotate(90deg); }
    .chat-voice-advanced-section[open] .chat-voice-advanced-summary::after { transform:rotate(-90deg); }
    .chat-voice-advanced { display:flex; flex-direction:column; gap:12px; padding-top:16px; }
    .chat-voice-number-input {
      box-sizing:border-box; width:100%; min-height:36px; padding:7px 10px;
      border:1px solid var(--lumiverse-border); border-radius:var(--lumiverse-radius);
      background:var(--lumiverse-bg-secondary, transparent); color:var(--lumiverse-text-primary); font:inherit;
    }
  `)

  const tab = ctx.ui.registerDrawerTab({
    id: 'chat-voice',
    title: 'Chat Voice',
    shortName: 'Voice',
    headerTitle: 'Chat Voice',
    description: 'Assign one TTS connection and individual voices to detected chat characters',
    keywords: ['tts', 'speech', 'narrator', 'characters', 'custom voice'],
    iconSvg: VOICE_ICON,
  })
  const hostDocument = tab.root.ownerDocument
  const hostWindow = hostDocument.defaultView ?? window

  const panel = document.createElement('div')
  panel.className = 'chat-voice-panel'
  const context = document.createElement('div')
  context.className = 'chat-voice-context'
  context.textContent = 'Open a chat to configure its voices.'

  function createField(labelText: string) {
    const field = document.createElement('div')
    field.className = 'chat-voice-field'
    const label = document.createElement('div')
    label.className = 'chat-voice-label'
    label.textContent = labelText
    const slot = document.createElement('div')
    field.append(label, slot)
    return { field, label, slot }
  }

  const connectionField = createField('TTS connection')
  const saveAudioField = createField('Audio storage')
  saveAudioField.slot.className = 'chat-voice-storage'
  const saveAudioLabel = document.createElement('label')
  saveAudioLabel.className = 'chat-voice-toggle'
  const saveAudioToggle = document.createElement('input')
  saveAudioToggle.type = 'checkbox'
  saveAudioToggle.checked = false
  saveAudioToggle.setAttribute('aria-label', 'Save generated audio to messages')
  const saveAudioCopy = document.createElement('span')
  saveAudioCopy.className = 'chat-voice-toggle-copy'
  const saveAudioText = document.createElement('span')
  saveAudioText.textContent = 'Save generated audio'
  const saveAudioHint = document.createElement('span')
  saveAudioHint.className = 'chat-voice-toggle-hint'
  saveAudioHint.textContent = 'Attach completed assistant-message recordings. User-message audio is never saved.'
  saveAudioCopy.append(saveAudioText, saveAudioHint)
  saveAudioLabel.append(saveAudioToggle, saveAudioCopy)
  const saveAudioRetention = document.createElement('label')
  saveAudioRetention.className = 'chat-voice-retention'
  const saveAudioRetentionCopy = document.createElement('span')
  saveAudioRetentionCopy.className = 'chat-voice-retention-copy'
  saveAudioRetentionCopy.textContent = 'Maximum saved recordings'
  const saveAudioLimitInput = document.createElement('input')
  saveAudioLimitInput.className = 'chat-voice-retention-input'
  saveAudioLimitInput.type = 'number'
  saveAudioLimitInput.min = '1'
  saveAudioLimitInput.max = '10000'
  saveAudioLimitInput.step = '1'
  saveAudioLimitInput.value = String(DEFAULT_SAVED_AUDIO_LIMIT)
  saveAudioLimitInput.setAttribute('aria-label', 'Maximum saved recordings')
  saveAudioRetention.append(saveAudioRetentionCopy, saveAudioLimitInput)
  saveAudioField.slot.append(saveAudioLabel, saveAudioRetention)
  const scanField = createField('Character card cast')
  const scanRow = scanField.slot
  scanRow.className = 'chat-voice-scan-row'
  const scanButton = document.createElement('button')
  scanButton.type = 'button'
  scanButton.className = 'chat-voice-scan-button'
  scanButton.textContent = 'Scan'
  scanButton.disabled = true
  scanRow.append(scanButton)
  const skippedTagsField = createField('Skipped tracker tags (global)')
  const speakerParsingField = createField('Jev speaker assignment (global)')
  const ttsTagField = createField('TTS vocal tags (global)')
  const ttsTagPlacementField = createField('Vocal tag placement')
  const tagLlmConnectionField = createField('Vocal tag LLM connection')
  const tagLlmModelField = createField('Vocal tag model (optional)')
  const narratorField = createField('Narrator voice')
  const userVoiceField = createField('User voice')

  function addDefaultRoleToggle(
    field: ReturnType<typeof createField>,
    titleText: string,
    ariaLabel: string,
  ): HTMLInputElement {
    field.label.textContent = ''
    field.label.classList.add('chat-voice-role-heading')
    const title = document.createElement('span')
    title.textContent = titleText
    const toggle = document.createElement('label')
    toggle.className = 'chat-voice-role-default'
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.setAttribute('aria-label', ariaLabel)
    const copy = document.createElement('span')
    copy.textContent = 'Use global'
    toggle.append(checkbox, copy)
    field.label.append(title, toggle)
    return checkbox
  }

  const narratorDefaultToggle = addDefaultRoleToggle(
    narratorField,
    'Narrator voice',
    'Use the global narrator voice for this chat',
  )
  const userDefaultToggle = addDefaultRoleToggle(
    userVoiceField,
    'User voice',
    'Use the global user voice for this chat',
  )
  const routingHint = document.createElement('div')
  routingHint.className = 'chat-voice-hint'
  routingHint.textContent = 'Scan reads the character card, not chat history. During playback, Jev uses Lumiverse’s default Decision connection to classify paragraph and dialogue identities; everything outside quotes uses the narrator voice.'
  const addNpcField = createField('Add NPC manually')
  addNpcField.slot.className = 'chat-voice-add-row'
  const addNpcInputSlot = document.createElement('div')
  const addNpcButton = document.createElement('button')
  addNpcButton.type = 'button'
  addNpcButton.className = 'chat-voice-add-button'
  addNpcButton.textContent = 'Add'
  addNpcButton.disabled = true
  addNpcField.slot.append(addNpcInputSlot, addNpcButton)
  const characterTitle = document.createElement('div')
  characterTitle.className = 'chat-voice-section-title'
  characterTitle.textContent = 'Detected voices'
  const characterList = document.createElement('div')
  characterList.className = 'chat-voice-character-list'
  const status = document.createElement('div')
  status.className = 'chat-voice-status'
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  const advancedSection = document.createElement('details')
  advancedSection.className = 'chat-voice-advanced-section'
  const advancedSummary = document.createElement('summary')
  advancedSummary.className = 'chat-voice-advanced-summary'
  advancedSummary.textContent = 'Advanced settings'
  const advancedBody = document.createElement('div')
  advancedBody.className = 'chat-voice-advanced'
  advancedSection.append(advancedSummary, advancedBody)

  panel.append(
    context,
    connectionField.field,
    saveAudioField.field,
    scanField.field,
    skippedTagsField.field,
    speakerParsingField.field,
    ttsTagField.field,
    ttsTagPlacementField.field,
    tagLlmConnectionField.field,
    tagLlmModelField.field,
    narratorField.field,
    userVoiceField.field,
    routingHint,
    addNpcField.field,
    characterTitle,
    characterList,
    status,
    advancedSection,
  )
  tab.root.appendChild(panel)

  const playbackBufferField = createField('Playback buffer segments')
  const concurrentGenerationField = createField('Maximum concurrent generations')
  const rateLimitWaitField = createField('Rate-limit wait budget (seconds)')
  const speakerDebugLabel = document.createElement('label')
  speakerDebugLabel.className = 'chat-voice-toggle'
  const speakerDebugToggle = document.createElement('input')
  speakerDebugToggle.type = 'checkbox'
  speakerDebugToggle.setAttribute('aria-label', 'Show speaker assignment debug log')
  const speakerDebugCopy = document.createElement('span')
  speakerDebugCopy.className = 'chat-voice-toggle-copy'
  const speakerDebugText = document.createElement('span')
  speakerDebugText.textContent = 'Speaker assignment debug'
  const speakerDebugHint = document.createElement('span')
  speakerDebugHint.className = 'chat-voice-toggle-hint'
  speakerDebugHint.textContent = 'Records both Jev passes, the turn matrix, narrative cues, dialogue-run review, inheritance, fallbacks, aliases, and the final voice route for every segment.'
  speakerDebugCopy.append(speakerDebugText, speakerDebugHint)
  speakerDebugLabel.append(speakerDebugToggle, speakerDebugCopy)
  const speakerDebugOutput = document.createElement('textarea')
  speakerDebugOutput.className = 'chat-voice-debug-output'
  speakerDebugOutput.readOnly = true
  speakerDebugOutput.hidden = true
  speakerDebugOutput.placeholder = 'Generate TTS to see the turn matrix, discourse review, inheritance, and voice-route trace.'
  speakerDebugOutput.setAttribute('aria-label', 'Speaker assignment debug log')
  const advancedHint = document.createElement('div')
  advancedHint.className = 'chat-voice-hint'
  advancedHint.textContent = 'Concurrency starts at one and adapts up to the selected maximum. Dense short-segment runs stay at one request at a time, while sustained long runs increase gradually. Larger buffers reduce pauses but delay playback. The wait budget controls cumulative rate-limit cooldowns.'
  advancedBody.append(
    playbackBufferField.field,
    concurrentGenerationField.field,
    rateLimitWaitField.field,
    speakerDebugLabel,
    speakerDebugOutput,
    advancedHint,
  )

  let applyingState = false
  let activeChat: ActiveChatState | null = null
  let connections: TtsConnection[] = []
  let lumiverseConnectionId = ''
  let defaultNarratorVoice = ''
  let defaultUserVoice = ''
  let localNarratorVoice = ''
  let localUserVoice = ''
  let useGlobalNarratorVoice = true
  let useGlobalUserVoice = true
  let narratorGlobalSaveTimer: ReturnType<typeof setTimeout> | null = null
  let userGlobalSaveTimer: ReturnType<typeof setTimeout> | null = null
  let savingNarratorGlobalVoice = false
  let savingUserGlobalVoice = false
  let saveGeneratedAudio = false
  let savedAudioLimit = DEFAULT_SAVED_AUDIO_LIMIT
  let savingAudioPreference = false
  let savingAudioLimit = false
  let skippedTrackerTags = ''
  let skippedTrackerTagsDirty = false
  let savingSkippedTrackerTags = false
  let skippedTrackerTagsSaveTimer: ReturnType<typeof setTimeout> | null = null
  let speakerParsingMode: 'off' | 'ambiguous' = 'ambiguous'
  let ttsTagStyle: 'off' | 'gemini' | 'gemini38' | 'fish' = 'off'
  let ttsTagPlacement: 'jev' | 'llm' = 'jev'
  let tagLlmConnectionId = ''
  let tagLlmModel = ''
  let llmConnections: LlmConnection[] = []
  /** Connection the vocal-tag model combobox is currently bound to. */
  let tagLlmModelConnectionId = ''
  let tagLlmModelComboboxEnabled = false
  const tagPlacementCache = new Map<string, string>()
  let decisionConnectionsKnown = false
  let decisionConnectionAvailable = false
  let decisionConnectionName = ''
  let decisionStatusFailed = false
  let llmSettingsSaveTimer: ReturnType<typeof setTimeout> | null = null
  let savingLlmSettings = false
  let playbackBufferSegments = DEFAULT_PLAYBACK_BUFFER_SEGMENTS
  let concurrentGenerationLimit = DEFAULT_CONCURRENT_GENERATIONS
  let rateLimitWaitSeconds = DEFAULT_RATE_LIMIT_WAIT_SECONDS
  let speakerAssignmentDebug = false
  let advancedSettingsSaveTimer: ReturnType<typeof setTimeout> | null = null
  let savingAdvancedSettings = false
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let editRevision = 0
  let dirty = false
  let scanning = false
  let activePlayback: {
    messageId: string
    controller: AbortController
    synthesisController: AbortController | null
    context: AudioContext
    source: AudioBufferSourceNode | null
    persistenceState: 'disabled' | 'not-started' | 'pending' | 'saved' | 'failed'
    persistenceError: string | null
    playbackStopped: boolean
    playbackFinished: boolean
    audibleDone: Promise<void>
    finishAudible: () => void
  } | null = null
  const backgroundSynthesisControllers = new Set<AbortController>()
  const backgroundSynthesisByMessage = new Map<string, AbortController>()
  const sharedSynthesisPacer: SynthesisPacer = {
    nextStartAt: 0,
    startQueue: Promise.resolve(),
    recentStarts: [],
    windowRequestLimit: DEFAULT_SYNTHESIS_REQUESTS_PER_WINDOW,
  }
  const connectionVoiceGates = new Map<string, ConnectionVoiceGate>()
  type SynthesisTask = () => Promise<void>
  const foregroundSynthesisQueue: SynthesisTask[] = []
  const backgroundSynthesisQueue: SynthesisTask[] = []
  const adaptiveSynthesisLimits = new Map<symbol, number>()
  let activeSynthesisTasks = 0

  function effectiveSynthesisLimit(): number {
    return adaptiveSynthesisLimits.size > 0
      ? Math.max(...adaptiveSynthesisLimits.values())
      : concurrentGenerationLimit
  }

  function drainSynthesisQueue(): void {
    while (activeSynthesisTasks < effectiveSynthesisLimit()) {
      const next = foregroundSynthesisQueue.shift() ?? backgroundSynthesisQueue.shift()
      if (!next) return
      activeSynthesisTasks += 1
      void next().finally(() => {
        activeSynthesisTasks -= 1
        drainSynthesisQueue()
      })
    }
  }

  function runSynthesisTask<T>(task: () => Promise<T>, foreground: boolean): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const queued = async () => {
        try {
          resolve(await task())
        } catch (error) {
          reject(error)
        }
      }
      const queue = foreground ? foregroundSynthesisQueue : backgroundSynthesisQueue
      queue.push(queued)
      drainSynthesisQueue()
    })
  }
  const inFlight = new Set<number>()
  const characterInputs = new Map<string, SpindleTextInputHandle>()
  let lastContextMessageId: string | null = null
  const nativeButtonStates = new Map<HTMLButtonElement, {
    html: string
    title: string | null
    ariaLabel: string | null
    ariaPressed: string | null
  }>()
  const pendingMessageRequests = new Map<string, {
    resolve: (message: PlaybackMessage) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  const pendingStateRequests = new Map<string, {
    chatId: string | null
    resolve: (chat: ActiveChatState | null) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  const pendingSpeakerParseRequests = new Map<string, {
    resolve: (review: SpeakerParseReview) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  const pendingDecisionStatusRequests = new Map<string, {
    resolve: (status: DecisionConnectionStatus) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  const pendingLlmConnectionRequests = new Map<string, {
    resolve: (connections: LlmConnection[]) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  const pendingTagPlacementRequests = new Map<string, {
    resolve: (placements: Array<{
      id: string
      text: string
      emotionTag?: string
      modulationTag?: string
    }>) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  let messageRequestSequence = 0
  let stateRequestSequence = 0
  let speakerParseRequestSequence = 0
  let decisionStatusRequestSequence = 0
  let llmConnectionRequestSequence = 0
  let tagPlacementRequestSequence = 0

  const setStatus = (message: string, state: 'normal' | 'saved' | 'error' = 'normal') => {
    status.textContent = message
    status.dataset.state = state
  }

  function nativeTtsButtonLabel(button: HTMLButtonElement): string {
    return [
      button.getAttribute('title'),
      button.getAttribute('aria-label'),
      button.textContent,
    ].filter(Boolean).join(' ').toLowerCase()
  }

  function isExplicitTtsButton(button: HTMLButtonElement): boolean {
    const label = nativeTtsButtonLabel(button)
    const iconClass = button.querySelector('svg')?.getAttribute('class')?.toLowerCase() ?? ''
    return button.dataset.chatVoiceNativeTts === 'true'
      || iconClass.includes('volume-2')
      || iconClass.includes('volume2')
      || iconClass.includes('volume-high')
      || /\btts\b|text[ -]to[ -]speech|stop playback|regenerate.+audio/.test(label)
  }

  function preferredTtsActionIndex(): number {
    for (const actions of hostDocument.querySelectorAll<HTMLElement>('[data-component="BubbleActions"]')) {
      const buttons = [...actions.children].filter((child): child is HTMLButtonElement => child.tagName === 'BUTTON')
      const index = buttons.findIndex(button => isExplicitTtsButton(button))
      if (index >= 0) return index
    }
    return 3
  }

  function insertAtActionIndex(container: HTMLElement, action: HTMLElement, index: number): void {
    const actions = [...container.children].filter(child => (
      child.tagName === 'BUTTON' || child.getAttribute('role') === 'menuitem'
    ))
    container.insertBefore(action, actions[index] ?? null)
  }

  function nativeTtsMessageId(button: HTMLButtonElement): string | null {
    if (button.closest('[data-spindle-extension-root]')) return null
    const explicitTtsButton = isExplicitTtsButton(button)
    if (!explicitTtsButton) return null

    const messageElement = button.closest<HTMLElement>('[data-message-id]')
    if (messageElement?.dataset.messageId) return messageElement.dataset.messageId

    const isPortalMenuAction = button.parentElement?.parentElement === button.ownerDocument.body
      && !!button.querySelector(':scope > span')
    return isPortalMenuAction ? lastContextMessageId : null
  }

  const connectionPicker = ctx.components.mountSelect(connectionField.slot, {
    value: '', options: [], placeholder: 'Loading connections…',
    searchPlaceholder: 'Search TTS connections…', emptyMessage: 'No TTS connections found.',
    clearable: true, clearLabel: 'Disable custom chat voices', ariaLabel: 'TTS connection',
    disabled: true,
    onChange: () => markChanged(),
  })

  const narratorInput = ctx.components.mountTextInput(narratorField.slot, {
    value: '', placeholder: 'Enter the narrator voice name or ID',
    ariaLabel: 'Narrator voice', disabled: true,
    onChange: () => {
      if (applyingState) return
      if (useGlobalNarratorVoice) {
        defaultNarratorVoice = narratorInput.getValue()
        scheduleGlobalRoleVoiceSave('narrator')
      } else {
        localNarratorVoice = narratorInput.getValue()
        markChanged()
      }
    },
  })

  const userVoiceInput = ctx.components.mountTextInput(userVoiceField.slot, {
    value: '', placeholder: 'Enter the user voice name or ID',
    ariaLabel: 'User voice', disabled: true,
    onChange: () => {
      if (applyingState) return
      if (useGlobalUserVoice) {
        defaultUserVoice = userVoiceInput.getValue()
        scheduleGlobalRoleVoiceSave('user')
      } else {
        localUserVoice = userVoiceInput.getValue()
        markChanged()
      }
    },
  })

  const skippedTrackerTagsInput = ctx.components.mountTextArea(skippedTagsField.slot, {
    value: '',
    placeholder: 'tracker, status, <o_ledger></o_l>',
    rows: 3,
    ariaLabel: 'Tracker tag names or full asymmetric tag pairs to skip globally',
    onChange: () => scheduleSkippedTrackerTagsSave(),
  })
  const skippedTagsHint = document.createElement('div')
  skippedTagsHint.className = 'chat-voice-hint'
  skippedTagsHint.textContent = 'Enter tag names, or full pairs for asymmetric tags such as <o_ledger></o_l>.'
  skippedTagsField.slot.append(skippedTagsHint)

  const speakerParsingPicker = ctx.components.mountSelect(speakerParsingField.slot, {
    value: 'ambiguous',
    options: [
      { value: 'off', label: 'Off', sublabel: 'Use the local parser only' },
      {
        value: 'ambiguous',
        label: 'On',
        sublabel: 'Checking for a Decision model connection…',
        disabled: true,
      },
    ],
    ariaLabel: 'Jev speaker assignment mode',
    onChange: value => onSpeakerParsingModeChanged(value),
  })
  const speakerParsingHint = document.createElement('div')
  speakerParsingHint.className = 'chat-voice-hint'
  speakerParsingHint.hidden = true
  speakerParsingField.slot.append(speakerParsingHint)

  const ttsTagPicker = ctx.components.mountSelect(ttsTagField.slot, {
    value: 'off',
    options: [
      { value: 'off', label: 'Off', sublabel: 'Do not add inline vocal tags' },
      { value: 'gemini', label: 'Gemini', sublabel: 'Bracketed cues, for example [happy] and [gasp]' },
      { value: 'gemini38', label: 'Gemini 3.8', sublabel: 'Angle-bracket events, for example <sigh> and <short pause>' },
      { value: 'fish', label: 'Fish S2', sublabel: 'Fish cues, for example [happy] and [laughing]' },
    ],
    ariaLabel: 'TTS vocal tag style',
    onChange: value => onTtsTagStyleChanged(value),
  })
  const ttsTagHint = document.createElement('div')
  ttsTagHint.className = 'chat-voice-hint'
  ttsTagHint.textContent = 'Every speech gets one or two leading emotions. Up to two sounds and two pauses may be added; all cues for a speech share the same grouped placement request.'
  ttsTagField.slot.append(ttsTagHint)

  const ttsTagPlacementPicker = ctx.components.mountSelect(ttsTagPlacementField.slot, {
    value: 'jev',
    options: [
      { value: 'jev', label: 'Jev sentence boundaries', sublabel: 'Fast, approximate placement' },
      { value: 'llm', label: 'LLM exact placement', sublabel: 'Place each chosen tag at the exact word' },
    ],
    ariaLabel: 'Vocal tag placement',
    onChange: value => onTtsTagPlacementChanged(value),
  })

  const tagLlmConnectionPicker = ctx.components.mountSelect(tagLlmConnectionField.slot, {
    value: '',
    options: [],
    placeholder: 'Use the active Lumiverse LLM connection',
    searchPlaceholder: 'Search LLM connections…',
    emptyMessage: 'No LLM connections found.',
    clearable: true,
    clearLabel: 'Use the active LLM connection',
    ariaLabel: 'Vocal tag LLM connection',
    disabled: true,
    onChange: value => onTagLlmConnectionChanged(value),
  })

  const tagLlmModelInput = ctx.components.mountModelCombobox(tagLlmModelField.slot, {
    value: '',
    connection: { kind: 'llm' },
    appearance: 'standard',
    placeholder: 'Use the connection model or search available models',
    emptyMessage: 'No models reported for this connection.',
    loadingMessage: 'Loading models for this connection…',
    browseHint: 'Search models available to the selected connection.',
    disabled: true,
    onChange: value => onTagLlmModelChanged(value),
  })

  function createNumberInput(value: number, maximum: number, ariaLabel: string): HTMLInputElement {
    const input = document.createElement('input')
    input.className = 'chat-voice-number-input'
    input.type = 'number'
    input.value = String(value)
    input.min = '1'
    input.max = String(maximum)
    input.step = '1'
    input.inputMode = 'numeric'
    input.setAttribute('aria-label', ariaLabel)
    return input
  }

  const playbackBufferInput = createNumberInput(
    DEFAULT_PLAYBACK_BUFFER_SEGMENTS,
    MAX_PLAYBACK_BUFFER_SEGMENTS,
    'Playback buffer segments',
  )
  const concurrentGenerationInput = createNumberInput(
    DEFAULT_CONCURRENT_GENERATIONS,
    MAX_CONCURRENT_GENERATIONS,
    'Maximum concurrent generations',
  )
  const rateLimitWaitInput = createNumberInput(
    DEFAULT_RATE_LIMIT_WAIT_SECONDS,
    MAX_RATE_LIMIT_WAIT_SECONDS,
    'Rate-limit wait budget in seconds',
  )
  playbackBufferField.slot.appendChild(playbackBufferInput)
  concurrentGenerationField.slot.appendChild(concurrentGenerationInput)
  rateLimitWaitField.slot.appendChild(rateLimitWaitInput)
  const onPlaybackBufferInput = () => onPlaybackBufferChanged(playbackBufferInput.valueAsNumber)
  const onConcurrentGenerationInput = () => onConcurrentGenerationsChanged(concurrentGenerationInput.valueAsNumber)
  const onRateLimitWaitInput = () => onRateLimitWaitChanged(rateLimitWaitInput.valueAsNumber)
  playbackBufferInput.addEventListener('change', onPlaybackBufferInput)
  concurrentGenerationInput.addEventListener('change', onConcurrentGenerationInput)
  rateLimitWaitInput.addEventListener('change', onRateLimitWaitInput)
  speakerDebugToggle.addEventListener('change', onSpeakerDebugChanged)

  const addNpcInput = ctx.components.mountTextInput(addNpcInputSlot, {
    value: '', placeholder: 'NPC name / aliases', ariaLabel: 'NPC name and aliases to add', disabled: true,
    onChange: () => undefined,
  })

  function collectConfig(forSave = false) {
    return {
      messageLimit: activeChat?.messageLimit ?? 20,
      connectionId: connectionPicker.getValue(),
      narratorVoice: forSave ? localNarratorVoice : narratorInput.getValue(),
      userVoice: forSave ? localUserVoice : userVoiceInput.getValue(),
      useGlobalNarratorVoice,
      useGlobalUserVoice,
      characterVoices: Object.fromEntries(
        [...characterInputs.entries()].map(([id, input]) => [id, input.getValue()]),
      ),
      characters: activeChat?.characters.map(({ id, name, messageCount }) => ({ id, name, messageCount })) ?? [],
    }
  }

  function flushSave() {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
    if (!dirty || !activeChat) return
    const clientRevision = editRevision
    dirty = false
    inFlight.add(clientRevision)
    setStatus('Saving…')
    ctx.sendToBackend({
      type: 'chat_voice_save',
      chatId: activeChat.id,
      clientRevision,
      config: collectConfig(true),
    })
  }

  function markChanged(delay = 350) {
    if (applyingState || !activeChat) return
    dirty = true
    editRevision += 1
    setStatus('Saving…')
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(flushSave, delay)
  }

  function updateRoleDefaultControls(): void {
    narratorDefaultToggle.checked = useGlobalNarratorVoice
    userDefaultToggle.checked = useGlobalUserVoice
    narratorDefaultToggle.disabled = !activeChat
    userDefaultToggle.disabled = !activeChat
  }

  function scheduleGlobalRoleVoiceSave(role: 'narrator' | 'user'): void {
    const currentTimer = role === 'narrator' ? narratorGlobalSaveTimer : userGlobalSaveTimer
    if (currentTimer) clearTimeout(currentTimer)
    setStatus(`Saving global ${role} voice…`)
    const timer = setTimeout(() => {
      if (role === 'narrator') narratorGlobalSaveTimer = null
      else userGlobalSaveTimer = null
      const voice = role === 'narrator' ? defaultNarratorVoice : defaultUserVoice
      if (role === 'narrator') savingNarratorGlobalVoice = true
      else savingUserGlobalVoice = true
      void saveDefaultRoleVoice(role, voice).then(
        () => setStatus(`Global ${role} voice saved.`, 'saved'),
        error => setStatus(error instanceof Error ? error.message : `Could not save the global ${role} voice.`, 'error'),
      ).finally(() => {
        if (role === 'narrator') savingNarratorGlobalVoice = false
        else savingUserGlobalVoice = false
      })
    }, 350)
    if (role === 'narrator') narratorGlobalSaveTimer = timer
    else userGlobalSaveTimer = timer
  }

  function changeDefaultRoleVoice(role: 'narrator' | 'user', checked: boolean): void {
    const input = role === 'narrator' ? narratorInput : userVoiceInput
    if (role === 'narrator') useGlobalNarratorVoice = checked
    else useGlobalUserVoice = checked
    input.update({ value: role === 'narrator'
      ? checked ? defaultNarratorVoice : localNarratorVoice
      : checked ? defaultUserVoice : localUserVoice })
    updateRoleDefaultControls()
    markChanged()
  }

  const onNarratorDefaultChange = () => {
    changeDefaultRoleVoice('narrator', narratorDefaultToggle.checked)
  }
  const onUserDefaultChange = () => {
    changeDefaultRoleVoice('user', userDefaultToggle.checked)
  }
  narratorDefaultToggle.addEventListener('change', onNarratorDefaultChange)
  userDefaultToggle.addEventListener('change', onUserDefaultChange)

  function updatePlaybackButtons() {
    for (const button of hostDocument.querySelectorAll<HTMLButtonElement>('button')) {
      const messageId = nativeTtsMessageId(button)
      if (!messageId) continue
      const playing = activePlayback?.messageId === messageId
      const idle = nativeButtonStates.get(button)
      if (!playing) {
        if (!idle) continue
        button.innerHTML = idle.html
        if (idle.title === null) button.removeAttribute('title')
        else button.setAttribute('title', idle.title)
        if (idle.ariaLabel === null) button.removeAttribute('aria-label')
        else button.setAttribute('aria-label', idle.ariaLabel)
        if (idle.ariaPressed === null) button.removeAttribute('aria-pressed')
        else button.setAttribute('aria-pressed', idle.ariaPressed)
        delete button.dataset.chatVoiceNativeTts
        delete button.dataset.playing
        nativeButtonStates.delete(button)
        continue
      }
      if (!idle) {
        nativeButtonStates.set(button, {
          html: button.innerHTML,
          title: button.getAttribute('title'),
          ariaLabel: button.getAttribute('aria-label'),
          ariaPressed: button.getAttribute('aria-pressed'),
        })
      }
      const label = 'Stop custom voice playback'
      const hasText = !!button.querySelector(':scope > span')
      button.dataset.chatVoiceNativeTts = 'true'
      button.dataset.playing = 'true'
      button.innerHTML = `${STOP_ACTION_ICON}${hasText ? `<span>${label}</span>` : ''}`
      button.title = label
      button.setAttribute('aria-label', label)
      button.setAttribute('aria-pressed', 'true')
    }
  }

  function restoreNativePlaybackButtons() {
    activePlayback = null
    updatePlaybackButtons()
    nativeButtonStates.clear()
  }

  function requestPlaybackMessage(chatId: string, messageId: string): Promise<PlaybackMessage> {
    const requestId = `${Date.now().toString(36)}-${++messageRequestSequence}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingMessageRequests.delete(requestId)
        reject(new Error('Timed out while loading the message for playback.'))
      }, 15_000)
      pendingMessageRequests.set(requestId, { resolve, reject, timer })
      ctx.sendToBackend({ type: 'chat_voice_get_message', chatId, messageId, requestId })
    })
  }

  function requestSpeakerReviewedSegments(
    chatId: string,
    messageId: string,
    preferences: PlaybackPreferences,
  ): Promise<SpeakerParseReview> {
    const requestId = `parse-${Date.now().toString(36)}-${++speakerParseRequestSequence}`
    return new Promise((resolve, reject) => {
      // Jev may run a local pass and one discourse escalation back to back, and
      // each host evaluation has its own 30-second deadline.
      const timer = setTimeout(() => {
        pendingSpeakerParseRequests.delete(requestId)
        reject(new Error('Jev speaker assignment timed out.'))
      }, 70_000)
      pendingSpeakerParseRequests.set(requestId, { resolve, reject, timer })
      ctx.sendToBackend({
        type: 'chat_voice_parse_message',
        chatId,
        messageId,
        requestId,
        mode: preferences.speakerParsingMode,
        tagStyle: preferences.ttsTagStyle,
        tagPlacement: preferences.ttsTagPlacement,
        tagLlmConnectionId: preferences.tagLlmConnectionId,
        tagLlmModel: preferences.tagLlmModel,
        skippedTrackerTags: preferences.skippedTrackerTags,
        debug: preferences.speakerAssignmentDebug,
      })
    })
  }

  function speakerDebugName(speakerId: string | null, speakers: Array<{ id: string; name: string }>): string {
    if (speakerId === null) return 'narrator'
    if (speakerId === USER_SPEAKER_ID) return 'user persona'
    if (speakerId === UNCAST_SPEAKER_ID) return 'uncast character'
    const speaker = speakers.find(candidate => candidate.id === speakerId)
    return speaker ? `${speaker.name} [${speakerId}]` : speakerId
  }

  type SpeakerAssignmentSource =
    | 'first-pass'
    | 'chain-fill'
    | 'chain-override'
    | 'discourse-fill'
    | 'discourse-override'
    | 'inheritance'
    | 'previous-assistant'
    | 'card-title'
    | 'role-fallback'
    | 'local-parser'
    | 'unreported'

  const SPEAKER_SOURCE_LABELS: Record<SpeakerAssignmentSource, string> = {
    'first-pass': 'first pass',
    'chain-fill': 'turn chain fill',
    'chain-override': 'turn chain override',
    'discourse-fill': 'discourse fill',
    'discourse-override': 'discourse override',
    inheritance: 'in-message inheritance',
    'previous-assistant': 'previous assistant',
    'card-title': 'card title',
    'role-fallback': 'role fallback',
    'local-parser': 'local parser',
    unreported: 'unreported',
  }

  function speakerDebugLine(steps: string[], prefix: string): string | undefined {
    return steps.find(step => step.startsWith(prefix))
  }

  function speakerDebugStep(segment: PlaybackSegment, prefix: string): string | undefined {
    return speakerDebugLine(segment.debugPath ?? [], prefix)
  }

  /** Which pipeline stage produced the final speaker for one segment. */
  function speakerAssignmentSource(
    segment: PlaybackSegment,
    parsingMode: PlaybackPreferences['speakerParsingMode'],
    review: SpeakerParseReview,
  ): SpeakerAssignmentSource {
    const resolution = speakerDebugStep(segment, 'resolution:')
    if (resolution?.startsWith('resolution:chain-identity (overrode')) return 'chain-override'
    if (resolution?.startsWith('resolution:chain-identity')) return 'chain-fill'
    if (resolution?.startsWith('resolution:discourse-identity (overrode')) return 'discourse-override'
    if (resolution?.startsWith('resolution:discourse-identity')) return 'discourse-fill'
    if (resolution === 'resolution:direct-speech-identity') return 'first-pass'
    if (resolution?.startsWith('resolution:upstream-identity')) return 'inheritance'
    if (resolution?.startsWith('resolution:previous-assistant')) return 'previous-assistant'
    if (resolution?.startsWith('resolution:unique card-title')) return 'card-title'
    if (resolution?.startsWith('resolution:user-role')) return 'role-fallback'
    if (resolution?.startsWith('resolution:assistant connection-default')) return 'role-fallback'
    if (review.failed || review.usedLlm === false || parsingMode === 'off') return 'local-parser'
    if (speakerDebugStep(segment, 'jev-fallback:') || speakerDebugStep(segment, 'jev-disabled:')) {
      return 'local-parser'
    }
    return 'unreported'
  }

  function speakerSourceDetail(
    segment: PlaybackSegment,
    source: SpeakerAssignmentSource,
    parsingMode: PlaybackPreferences['speakerParsingMode'],
    review: SpeakerParseReview,
  ): string {
    if (source !== 'local-parser') return SPEAKER_SOURCE_LABELS[source]
    if (parsingMode === 'off') return 'local parser (Jev disabled)'
    if (review.failed) return 'local parser (backend review unavailable)'
    const fallback = speakerDebugStep(segment, 'jev-fallback:')
    if (fallback) return `local parser fallback (${fallback.slice('jev-fallback:'.length).trim()})`
    return 'local parser'
  }

  function describeBackendReview(
    localSpeakerId: string | null,
    rawSpeakerId: string | null,
    parsingMode: PlaybackPreferences['speakerParsingMode'],
    review: SpeakerParseReview,
  ): string {
    const before = localSpeakerId ?? 'none'
    const after = rawSpeakerId ?? 'none'
    if (parsingMode === 'off') {
      return localSpeakerId === rawSpeakerId
        ? 'backend-result:matches message-local parser (Jev disabled)'
        : `backend-result:changed message-local ${before} -> ${after} (Jev disabled)`
    }
    if (review.failed) return `backend-result:unavailable (message-local parser: ${after})`
    if (review.usedLlm === false) {
      return localSpeakerId === rawSpeakerId
        ? 'backend-result:local-parser fallback (matches message-local parser)'
        : `backend-result:local-parser fallback (changed message-local ${before} -> ${after})`
    }
    return localSpeakerId === rawSpeakerId
      ? `backend/Jev-result:matches message-local parser (${after})`
      : `backend/Jev-result:changed message-local ${before} -> Jev ${after}`
  }

  /** Two-pass status for the message header, derived from the backend trace. */
  function speakerPipelineHeader(
    segments: PlaybackSegment[],
    parsingMode: PlaybackPreferences['speakerParsingMode'],
    review: SpeakerParseReview,
  ): string[] {
    if (parsingMode === 'off') return ['Jev pipeline: off (attribution is entirely local)']
    if (review.failed) {
      return ['Jev pipeline: unavailable (backend review did not answer; message-local parser used)']
    }
    const steps = segments.flatMap(segment => segment.debugPath ?? [])
    if (review.usedLlm === null) {
      return ['Jev pipeline: status unknown (the backend did not report whether Jev answered)']
    }
    if (review.usedLlm === false) {
      const fallback = steps.find(step => step.startsWith('jev-fallback:') || step.startsWith('jev-disabled:'))
      const reason = fallback?.replace(/^jev-(?:fallback|disabled):/u, '').trim() || 'reason not reported'
      return [`Jev pipeline: first pass not used (${reason}); deterministic parser output used`]
    }
    const lines = ['Jev pipeline: first pass answered; deterministic policy applied after normalization']
    const speechSegments = segments.filter(segment => speakerDebugStep(segment, 'segment-type:speech'))
    const normalized = speechSegments
      .map(segment => speakerDebugStep(segment, 'jev-speech-normalized:'))
      .filter((step): step is string => step !== undefined)
    if (normalized.length > 0) {
      const clear = normalized.filter(step => !step.includes(':unclear')).length
      lines.push(
        `First pass: ${clear} clear / ${normalized.length} quotations`
        + ` (${normalized.length - clear} unresolved or low-confidence)`,
      )
    }
    const turnOmitted = steps.includes('jev-turn-questions:omitted (first-pass question budget)')
    const relations = steps
      .filter(step => step.startsWith('jev-turn-') && step.includes('-choice:'))
      .length
    const chainDecisions = steps
      .filter(step => step.startsWith('chain-decode:'))
      .map(step => step.slice('chain-decode:'.length))
    if (turnOmitted) {
      lines.push('Turn matrix: omitted (first-pass question budget); first-pass policy retained')
    } else if (relations > 0 || chainDecisions.length > 0) {
      const filled = chainDecisions.filter(step => step.startsWith('filled-unresolved')).length
      const overrode = chainDecisions.filter(step => step.startsWith('overrode-clear')).length
      const retained = chainDecisions.filter(step => step.startsWith('retained-unresolved')).length
      const direct = chainDecisions.filter(step => step.startsWith('direct')).length
      const overrideRejected = chainDecisions.filter(step => step.startsWith('override-rejected')).length
      lines.push(
        `Turn matrix: ${relations} relations · ${filled} chain-filled`
        + ` · ${overrode} chain-overrode · ${direct} direct retained`
        + (retained > 0 ? ` · ${retained} unresolved retained` : '')
        + (overrideRejected > 0 ? ` · ${overrideRejected} override rejected` : ''),
      )
    }
    const narrativeAttributions = new Set(
      steps.filter(step => step.startsWith('chain-narrative:attribution=')),
    ).size
    if (narrativeAttributions > 0) {
      lines.push(`Narrative cues: ${narrativeAttributions} unambiguous attributions`)
    }
    const cardDeference = speakerDebugLine(steps, 'card-deference:')
      ?.slice('card-deference:'.length).trim()
    if (cardDeference) lines.push(`Card deference: ${cardDeference}`)
    const request = speakerDebugLine(steps, 'discourse-request:')
      ?.slice('discourse-request:'.length).trim()
    const escalated = steps.includes('discourse-decision:escalated')
    const runIds = [...new Set(steps
      .filter(step => step.startsWith('discourse-run:'))
      .map(step => step.slice('discourse-run:'.length).split(' ')[0] ?? '')
      .filter(runId => runId.length > 0))]
    const triggerCodes = [...new Set(steps
      .filter(step => step.startsWith('discourse-triggers:'))
      .flatMap(step => step.slice('discourse-triggers:'.length).split('; '))
      .map(trigger => trigger.split(' (')[0]?.trim() ?? '')
      .filter(trigger => trigger.length > 0 && trigger !== 'none'))]
    const rejectedRuns = [...new Set(steps
      .filter(step => step.startsWith('discourse-decision:rejected'))
      .map(step => step.slice('discourse-decision:rejected'.length).trim().replace(/^\(|\)$/gu, ''))
      .filter(reason => reason.length > 0))]
    const outcomes = steps.filter(step => step.startsWith('discourse-outcome:'))
    const countOutcome = (name: string) => outcomes
      .filter(step => step === `discourse-outcome:${name}` || step.startsWith(`discourse-outcome:${name} `))
      .length
    if (escalated) {
      lines.push(
        `Discourse review: escalated ${runIds.join(', ') || 'one run'}`
        + ` (triggers: ${triggerCodes.join(', ') || 'not reported'})`,
        `Discourse review result: ${countOutcome('filled-unresolved')} filled`
        + `, ${countOutcome('overrode-conflict')} overrode`
        + `, ${countOutcome('not-a-target')} retained`
        + `, ${outcomes.filter(step => step.startsWith('discourse-outcome:rejected')).length} rejected`,
      )
    } else if (request?.startsWith('failed')) {
      lines.push(`Discourse review: ${request}`)
    } else if (rejectedRuns.length > 0) {
      lines.push(`Discourse review: not escalated (${rejectedRuns.join('; ')})`)
    } else {
      lines.push('Discourse review: not requested')
    }
    return lines
  }

  function updateSpeakerDebugLog(
    messageId: string,
    isUserMessage: boolean,
    defaultSpeakerId: string | null,
    parserSpeakers: Array<{ id: string; name: string }>,
    configuredSpeakers: Array<{ id: string; name: string }>,
    localSegments: PlaybackSegment[],
    finalSegments: PlaybackSegment[],
    aliases: ReadonlyMap<string, string>,
    config: ReturnType<typeof collectConfig>,
    parsingMode: PlaybackPreferences['speakerParsingMode'],
    review: SpeakerParseReview,
  ): void {
    if (!speakerAssignmentDebug) return
    const lines = [
      `Message ${messageId} (${isUserMessage ? 'user' : 'assistant'})`,
      `Parsing mode: ${parsingMode === 'off' ? 'local parser only' : 'Jev with local fallback'}`,
      `TTS tags: ${ttsTagStyle === 'off'
        ? 'off'
        : `${ttsTagStyle === 'gemini38' ? 'Gemini 3.8' : ttsTagStyle} (${ttsTagPlacement === 'llm' ? 'LLM placement' : 'Jev placement'})`}`,
      ...speakerPipelineHeader(finalSegments, parsingMode, review),
      `Default speaker: ${speakerDebugName(defaultSpeakerId, parserSpeakers)}`,
      `Parser roster: ${parserSpeakers.map(speaker => `${speaker.name} [${speaker.id}]`).join(', ') || '(empty)'}`,
      '',
    ]
    const sourceCounts = new Map<SpeakerAssignmentSource, number>()
    let narratorCount = 0
    finalSegments.forEach((segment, index) => {
      const local = localSegments[index]?.text === segment.text
        ? localSegments[index]
        : localSegments.find(candidate => candidate.text === segment.text)
      const rawSpeakerId = segment.speakerId
      const mappedSpeakerId = rawSpeakerId ? aliases.get(rawSpeakerId) ?? rawSpeakerId : null
      const voice = playbackVoiceForSpeaker(
        mappedSpeakerId,
        isUserMessage,
        config.characterVoices,
        config.narratorVoice,
        config.userVoice,
      )
      const localSpeaker = local?.speakerId ?? null
      const isSpeech = segment.debugPath?.some(step => step.startsWith('segment-type:speech')) ?? false
      const source = speakerAssignmentSource(segment, parsingMode, review)
      if (isSpeech) {
        sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1)
      } else {
        narratorCount += 1
      }
      const aliasPath = rawSpeakerId && mappedSpeakerId !== rawSpeakerId
        ? `alias-map:${rawSpeakerId} -> ${mappedSpeakerId}`
        : `alias-map:${rawSpeakerId ?? 'none'} (unchanged)`
      const routeName = speakerDebugName(mappedSpeakerId, configuredSpeakers)
      const voicePath = voice
        ? `voice-route:${routeName} -> configured voice ${JSON.stringify(voice)}`
        : `voice-route:${routeName} -> connection default voice`
      lines.push(
        `[${index + 1}] ${JSON.stringify(segment.text.length > 180 ? `${segment.text.slice(0, 177)}...` : segment.text)}`,
        ...((segment.debugPath ?? local?.debugPath ?? ['parser-trace:unavailable']).map(step => `  ${step}`)),
        `  ${describeBackendReview(localSpeaker, rawSpeakerId, parsingMode, review)}`,
        `  source:${isSpeech ? speakerSourceDetail(segment, source, parsingMode, review) : 'narrator'}`,
        ...(segment.ttsText && segment.ttsText !== segment.text
          ? [`  tts-tagged:${JSON.stringify(segment.ttsText.length > 180
              ? `${segment.ttsText.slice(0, 177)}...`
              : segment.ttsText)}`]
          : []),
        `  ${aliasPath}`,
        `  final-speaker:${speakerDebugName(mappedSpeakerId, configuredSpeakers)}`,
        `  ${voicePath}`,
        '',
      )
    })
    const sourceSummary = [...sourceCounts.entries()]
      .map(([source, count]) => `${SPEAKER_SOURCE_LABELS[source]} ${count}`)
      .join(' · ')
    lines.push(
      `Assignment sources: ${sourceSummary || 'no speech segments'} · narrator segments ${narratorCount}`,
      'Legend: jev-* first pass · jev-turn-* and chain-* turn matrix · jev-discourse-* and discourse-* cross-paragraph review · resolution:* deterministic policy · voice-route:* final routing',
    )
    const log = lines.join('\n')
    speakerDebugOutput.value = log
    console.debug('[Chat Voice] Speaker assignment trace\n' + log)
  }

  function appendSpeakerDebugLog(line: string): void {
    if (!speakerAssignmentDebug) return
    speakerDebugOutput.value += `${speakerDebugOutput.value ? '\n' : ''}${line}`
    console.debug(`[Chat Voice] ${line}`)
  }

  function requestDecisionStatus(): Promise<DecisionConnectionStatus> {
    const requestId = `decision-${Date.now().toString(36)}-${++decisionStatusRequestSequence}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingDecisionStatusRequests.delete(requestId)
        reject(new Error('Timed out while checking Decision connections.'))
      }, 10_000)
      pendingDecisionStatusRequests.set(requestId, { resolve, reject, timer })
      ctx.sendToBackend({ type: 'chat_voice_decision_status', requestId })
    })
  }

  async function refreshDecisionStatus(): Promise<DecisionConnectionStatus | null> {
    try {
      const status = await requestDecisionStatus()
      decisionConnectionsKnown = true
      decisionConnectionAvailable = status.available && status.hasConnection
      decisionConnectionName = status.defaultConnectionName ?? ''
      decisionStatusFailed = false
      updateSpeakerParsingControls()
      return status
    } catch (error) {
      decisionConnectionsKnown = true
      decisionConnectionAvailable = false
      decisionConnectionName = ''
      decisionStatusFailed = true
      updateSpeakerParsingControls()
      console.warn('[Chat Voice] Could not check Decision connections.', error)
      return null
    }
  }

  function updateSpeakerParsingControls(): void {
    const description = decisionStatusFailed
      ? 'Could not check Decision connections'
      : !decisionConnectionsKnown
        ? 'Checking for a Decision model connection…'
        : decisionConnectionAvailable
          ? (decisionConnectionName
              ? `Uses ${decisionConnectionName} as the default Decision connection`
              : 'Uses the default Lumiverse Decision connection')
          : 'Create a Decision model connection in Lumiverse first'
    speakerParsingPicker.update({
      options: [
        { value: 'off', label: 'Off', sublabel: 'Use the local parser only' },
        {
          value: 'ambiguous',
          label: 'On',
          sublabel: description,
          disabled: decisionStatusFailed || (decisionConnectionsKnown && !decisionConnectionAvailable),
        },
      ],
    })
    const warning = decisionStatusFailed
      ? 'Could not verify a Decision model connection. Jev speaker assignment is unavailable until Lumiverse responds.'
      : decisionConnectionsKnown && !decisionConnectionAvailable
        ? 'Jev speaker assignment needs a Decision model connection. Create one in Lumiverse, then reopen this panel.'
        : ''
    speakerParsingHint.textContent = warning
    speakerParsingHint.hidden = warning === ''
  }

  function requestLlmConnections(): Promise<LlmConnection[]> {
    const requestId = `llm-connections-${Date.now().toString(36)}-${++llmConnectionRequestSequence}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingLlmConnectionRequests.delete(requestId)
        reject(new Error('Timed out while loading Lumiverse LLM connections.'))
      }, 15_000)
      pendingLlmConnectionRequests.set(requestId, { resolve, reject, timer })
      ctx.sendToBackend({ type: 'chat_voice_list_llm_connections', requestId })
    })
  }

  function requestTagPlacements(
    message: string,
    style: Exclude<PlaybackPreferences['ttsTagStyle'], 'off'>,
    connectionId: string,
    model: string,
    items: Array<{
      id: string
      text: string
      emotions: string[]
      styles: string[]
      sounds: string[]
      pauses: Array<'short' | 'long'>
      modulation: boolean
      modulationPoint?: string
      modulationCharIndex?: number
      narrativeBefore: string
      narrativeAfter: string
    }>,
  ): Promise<Array<{ id: string; text: string; emotionTag?: string; modulationTag?: string }>> {
    const requestId = `tag-placement-${Date.now().toString(36)}-${++tagPlacementRequestSequence}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingTagPlacementRequests.delete(requestId)
        reject(new Error('Timed out while placing TTS vocal tags.'))
      }, 60_000)
      pendingTagPlacementRequests.set(requestId, { resolve, reject, timer })
      ctx.sendToBackend({
        type: 'chat_voice_place_tags',
        requestId,
        message,
        style,
        connectionId,
        model,
        items,
      })
    })
  }

  function llmConnectionOptions(selectedId = '') {
    const options = llmConnections.map(connection => ({
      value: connection.id,
      label: connection.name,
      sublabel: `${connection.provider}${connection.model ? ` · ${connection.model}` : ''}`,
    }))
    if (selectedId && !llmConnections.some(connection => connection.id === selectedId)) {
      options.unshift({ value: selectedId, label: 'Missing connection', sublabel: selectedId })
    }
    return options
  }

  function updateTtsTagControls(): void {
    ttsTagHint.textContent = ttsTagStyle === 'gemini38'
      ? 'Gemini 3.8 uses angle-bracket vocal events and pauses. Sustained emotion and style require speech_metadata, which the current TTS request does not expose.'
      : ttsTagStyle === 'fish' && ttsTagPlacement === 'llm'
        ? 'Every speech gets one or two leading emotions. Fish can also select one mid-speech modulation; up to two sounds and two pauses may be added. All cues for a speech share the grouped placement request.'
        : 'Every speech gets one or two leading emotions. Up to two sounds and two pauses may be added; all cues for a speech share the same grouped placement request.'
    const tagEnabled = ttsTagStyle !== 'off'
    const llmEnabled = tagEnabled && ttsTagPlacement === 'llm'
    ttsTagPlacementPicker.update({
      value: ttsTagPlacement,
      disabled: !tagEnabled,
    })
    tagLlmConnectionPicker.update({
      value: tagLlmConnectionId,
      options: llmConnectionOptions(tagLlmConnectionId),
      disabled: !llmEnabled,
      placeholder: llmConnections.length
        ? 'Use the active Lumiverse LLM connection'
        : 'No LLM connections found; the active connection will be used',
    })
    const modelConnectionId = tagLlmConnectionId || llmConnections.find(
      connection => connection.is_default,
    )?.id || llmConnections[0]?.id || ''
    tagLlmModelInput.update({
      value: tagLlmModel,
      disabled: !llmEnabled,
      connection: modelConnectionId
        ? { kind: 'llm', id: modelConnectionId }
        : { kind: 'llm' },
      refreshKey: modelConnectionId || 'active',
      placeholder: modelConnectionId
        ? 'Use the connection model or search available models'
        : 'Use the active connection model or search available models',
    })
    // Reload the catalog only when the bound connection changes or the picker
    // becomes enabled, so unrelated control updates do not refetch models.
    const connectionChanged = tagLlmModelConnectionId !== modelConnectionId
    const becameEnabled = llmEnabled && !tagLlmModelComboboxEnabled
    tagLlmModelConnectionId = modelConnectionId
    tagLlmModelComboboxEnabled = llmEnabled
    if (llmEnabled && (connectionChanged || becameEnabled)) tagLlmModelInput.refresh()
  }

  function onTtsTagStyleChanged(value: string): void {
    ttsTagStyle = value === 'gemini' || value === 'gemini38' || value === 'fish' ? value : 'off'
    ttsTagPicker.update({ value: ttsTagStyle })
    updateTtsTagControls()
    scheduleLlmSettingsSave()
  }

  function onTtsTagPlacementChanged(value: string): void {
    ttsTagPlacement = value === 'llm' ? 'llm' : 'jev'
    ttsTagPlacementPicker.update({ value: ttsTagPlacement })
    updateTtsTagControls()
    scheduleLlmSettingsSave()
  }

  function onTagLlmConnectionChanged(value: string): void {
    tagLlmConnectionId = value.trim().slice(0, 128)
    updateTtsTagControls()
    scheduleLlmSettingsSave()
  }

  function onTagLlmModelChanged(value: string): void {
    tagLlmModel = value.trim().slice(0, 256)
    scheduleLlmSettingsSave()
  }

  function refreshLocalState(): void {
    ctx.sendToBackend({
      type: 'chat_voice_refresh',
      chatId: ctx.getActiveChat().chatId,
    })
  }

  function requestLocalState(): Promise<ActiveChatState | null> {
    const chatId = ctx.getActiveChat().chatId
    const requestId = `state-${Date.now().toString(36)}-${++stateRequestSequence}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingStateRequests.delete(requestId)
        reject(new Error('Timed out while loading the active chat voice settings.'))
      }, 15_000)
      pendingStateRequests.set(requestId, { chatId, resolve, reject, timer })
      ctx.sendToBackend({ type: 'chat_voice_refresh', chatId, requestId })
    })
  }

  function stopPlayback(): boolean {
    const playback = activePlayback
    activePlayback = null
    if (!playback) return false
    playback.playbackStopped = true
    playback.finishAudible()
    playback.controller.abort()
    if (playback.persistenceState === 'not-started' || playback.persistenceState === 'disabled') {
      playback.synthesisController?.abort()
    }
    try { playback.source?.stop() } catch { /* already stopped */ }
    void playback.context.close().catch(() => undefined)
    updatePlaybackButtons()
    return playback.persistenceState === 'pending'
  }

  async function playDecodedBuffer(
    playback: NonNullable<typeof activePlayback>,
    segment: SynthesizedVoiceSegment,
    volume: number,
  ): Promise<AudioBuffer> {
    if (playback.controller.signal.aborted) throw new DOMException('Playback stopped.', 'AbortError')
    const buffer = segment.decodedBuffer
      ?? await playback.context.decodeAudioData(segment.data.slice(0))
    if (playback.controller.signal.aborted) throw new DOMException('Playback stopped.', 'AbortError')
    await new Promise<void>((resolve, reject) => {
      const source = playback.context.createBufferSource()
      const gain = playback.context.createGain()
      gain.gain.value = volume * (segment.normalizationGain ?? 1)
      source.buffer = buffer
      source.connect(gain)
      gain.connect(playback.context.destination)
      playback.source = source
      const abort = () => {
        try { source.stop() } catch { /* already stopped */ }
        reject(new DOMException('Playback stopped.', 'AbortError'))
      }
      playback.controller.signal.addEventListener('abort', abort, { once: true })
      source.onended = () => {
        playback.controller.signal.removeEventListener('abort', abort)
        playback.source = null
        resolve()
      }
      source.start()
    })
    return buffer
  }

  async function encodeCapturedWav(
    segments: SynthesizedVoiceSegment[],
    contextClass: typeof AudioContext,
  ): Promise<ArrayBuffer> {
    const decodeContext = new contextClass()
    try {
      const decoded: AudioBuffer[] = []
      for (const segment of segments) {
        decoded.push(segment.decodedBuffer ?? await decodeContext.decodeAudioData(segment.data.slice(0)))
      }
      return encodeConcatenatedWav(decoded.map((buffer, index) => ({
        sampleRate: buffer.sampleRate,
        channels: Array.from(
          { length: buffer.numberOfChannels },
          (_, channel) => buffer.getChannelData(channel),
        ),
        gain: segments[index]?.normalizationGain ?? 1,
      })))
    } finally {
      await decodeContext.close().catch(() => undefined)
    }
  }

  async function persistCapturedAudio(
    chatId: string,
    messageId: string,
    swipeId: number | undefined,
    segments: SynthesizedVoiceSegment[],
    contextClass: typeof AudioContext,
    signal: AbortSignal,
    waitForSafeFallback: () => Promise<void>,
    onWavAssembly: (normalized: boolean) => void,
  ): Promise<SavedMessageAudioResult> {
    const normalized = segments.some(segment => segment.normalizationGain !== undefined)
    if (normalized) {
      onWavAssembly(true)
      const wav = await encodeCapturedWav(segments, contextClass)
      return saveMessageAudio(
        chatId,
        messageId,
        swipeId,
        [{ data: wav, mime: 'audio/wav' }],
        signal,
      )
    }
    try {
      return await saveMessageAudio(chatId, messageId, swipeId, segments, signal)
    } catch (segmentSaveError) {
      if ((segmentSaveError as { name?: string })?.name === 'AbortError') throw segmentSaveError
      await waitForSafeFallback()
      if (signal.aborted) throw new DOMException('Audio saving stopped.', 'AbortError')
      onWavAssembly(false)
      const wav = await encodeCapturedWav(segments, contextClass)
      return saveMessageAudio(
        chatId,
        messageId,
        swipeId,
        [{ data: wav, mime: 'audio/wav' }],
        signal,
      )
    }
  }

  function hasSavedAudioForCurrentSwipe(message: PlaybackMessage): boolean {
    const attachments = message.extra?.attachments
    if (!Array.isArray(attachments)) return false
    return attachments.some((candidate) => {
      if (!candidate || typeof candidate !== 'object') return false
      const attachment = candidate as SavedAudioAttachment
      return attachment.type === 'audio'
        && (attachment.swipe_id === undefined || attachment.swipe_id === message.swipe_id)
    })
  }

  async function playMessage(messageId: string, nativeRegenerationAction = false): Promise<void> {
    if (activePlayback?.messageId === messageId) {
      const finishingSave = stopPlayback()
      setStatus(finishingSave ? 'Playback stopped; finishing saved audio…' : 'Playback stopped.')
      return
    }

    const requestedChatId = ctx.getActiveChat().chatId
    if (!requestedChatId) {
      setStatus('Open a chat before starting voice playback.', 'error')
      return
    }
    let message: PlaybackMessage
    try {
      message = await requestPlaybackMessage(requestedChatId, messageId)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not load this message.', 'error')
      return
    }
    if (ctx.getActiveChat().chatId !== requestedChatId) return

    const regeneratingSavedAudio = !message.is_user
      && (nativeRegenerationAction || hasSavedAudioForCurrentSwipe(message))
    if (regeneratingSavedAudio) {
      const { confirmed } = await ctx.ui.showConfirm({
        title: 'Regenerate TTS audio?',
        message: 'This will replace the saved audio attached to this message with a new TTS synthesis. The current recording will be deleted.',
        confirmLabel: 'Regenerate',
        cancelLabel: 'Keep current',
        variant: 'warning',
      })
      if (!confirmed || ctx.getActiveChat().chatId !== requestedChatId) return
    }

    if (activePlayback) {
      stopPlayback()
    }
    const localChatId = ctx.getActiveChat().chatId
    if (activeChat?.id !== localChatId) {
      setStatus('Loading this chat’s voice settings…')
      try {
        await requestLocalState()
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'Could not load this chat’s voice settings.', 'error')
        return
      }
    }
    if (!activeChat || activeChat.id !== ctx.getActiveChat().chatId) return
    const playbackChat = activeChat
    const config = collectConfig()
    const preferences = await loadPlaybackPreferences()
    if (llmSettingsSaveTimer || savingLlmSettings) {
      preferences.speakerParsingMode = speakerParsingMode
      preferences.ttsTagStyle = ttsTagStyle
      preferences.ttsTagPlacement = ttsTagPlacement
      preferences.tagLlmConnectionId = tagLlmConnectionId
      preferences.tagLlmModel = tagLlmModel
    }
    if (advancedSettingsSaveTimer || savingAdvancedSettings) {
      preferences.playbackBufferSegments = playbackBufferSegments
      preferences.concurrentGenerations = concurrentGenerationLimit
      preferences.rateLimitWaitSeconds = rateLimitWaitSeconds
      preferences.speakerAssignmentDebug = speakerAssignmentDebug
    } else {
      playbackBufferSegments = preferences.playbackBufferSegments
      concurrentGenerationLimit = preferences.concurrentGenerations
      rateLimitWaitSeconds = preferences.rateLimitWaitSeconds
      speakerAssignmentDebug = preferences.speakerAssignmentDebug
    }
    const connectionId = config.connectionId
      || (connections.some(connection => connection.id === preferences.connectionId)
        ? preferences.connectionId
        : connections.find(connection => connection.is_default)?.id ?? lumiverseConnectionId)
    if (!connectionId) {
      setStatus('Choose a TTS connection before playing.', 'error')
      return
    }
    // Fall back explicitly to the connection profile's voice instead of
    // omitting the field. A provider that applies voice through mutable
    // connection state can otherwise replay whichever voice was last used by
    // another playback or chat.
    const connectionProfileVoice = (
      connections.find(connection => connection.id === connectionId)?.voice ?? ''
    ).trim()
    if (preferences.speakerAssignmentDebug) {
      const profile = connections.find(connection => connection.id === connectionId)
      appendSpeakerDebugLog(
        `TTS connection profile: id=${JSON.stringify(connectionId)}, `
          + `provider=${JSON.stringify(profile?.provider ?? '')}, `
          + `model=${JSON.stringify(profile?.model ?? '')}, `
          + `defaultVoice=${JSON.stringify(profile?.voice ?? '')}, `
          + `narratorVoice=${JSON.stringify(config.narratorVoice || '<connection default>')}, `
          + `userVoice=${JSON.stringify(config.userVoice || '<none>')}`,
      )
    }
    const contextClass = window.AudioContext
      ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!contextClass) {
      setStatus('Web Audio is unavailable in this browser.', 'error')
      return
    }
    const audioContext = new contextClass()
    await audioContext.resume()
    let audibleFinished = false
    let resolveAudibleDone: (() => void) | null = null
    const audibleDone = new Promise<void>((resolve) => {
      resolveAudibleDone = resolve
    })
    const playback = {
      messageId,
      controller: new AbortController(),
      synthesisController: null as AbortController | null,
      context: audioContext,
      source: null as AudioBufferSourceNode | null,
      persistenceState: 'not-started' as const as 'disabled' | 'not-started' | 'pending' | 'saved' | 'failed',
      persistenceError: null as string | null,
      playbackStopped: false,
      playbackFinished: false,
      audibleDone,
      finishAudible: () => {
        if (audibleFinished) return
        audibleFinished = true
        resolveAudibleDone?.()
      },
    }
    activePlayback = playback
    updatePlaybackButtons()

    try {
      if (playback.controller.signal.aborted) throw new DOMException('Playback stopped.', 'AbortError')
      const playbackSpeakers = addUnconfiguredDialogueSpeakers(
        message.content,
        speakersForMessageRole(
          playbackChat.characters,
          message.is_user,
          message.name,
        ),
      )
      const defaultSpeakerId = message.is_user
        ? USER_SPEAKER_ID
        : eligibleCardFallbackSpeakerId(
            message.content,
            preferredCardSpeakerId(
              message,
              playbackChat.characters,
              playbackChat.cardCharacterIds ?? [],
            ),
            playbackSpeakers,
            preferences.skippedTrackerTags,
          )
      const aliases = speakerAliasIdLookup(playbackChat.characters)
      const localSegments = parseRosterVoiceSegments(
        message.content,
        defaultSpeakerId,
        playbackSpeakers,
        preferences.skippedTrackerTags,
        null,
        preferences.speakerAssignmentDebug,
      )
      let review: SpeakerParseReview = { segments: localSegments, usedLlm: null, failed: false }
      if (preferences.speakerParsingMode !== 'off' || preferences.ttsTagStyle !== 'off') {
        setStatus(
          preferences.speakerParsingMode !== 'off'
            ? 'Classifying dialogue speakers with Jev…'
            : 'Adding TTS vocal tags…',
        )
      }
      try {
        review = await requestSpeakerReviewedSegments(playbackChat.id, messageId, preferences)
      } catch (error) {
        console.warn('[Chat Voice] Backend speaker parsing failed; using the message-local parser.', error)
        if (playback.controller.signal.aborted) throw new DOMException('Playback stopped.', 'AbortError')
        review = { segments: localSegments, usedLlm: null, failed: true }
        setStatus('Historical speaker lookup unavailable; using the message-local parser.')
      }
      const segments = review.segments
      updateSpeakerDebugLog(
        messageId,
        message.is_user,
        defaultSpeakerId,
        playbackSpeakers,
        playbackChat.characters,
        localSegments,
        segments,
        aliases,
        config,
        preferences.speakerParsingMode,
        review,
      )
      let explicitVoiceCount = 0
      let connectionVoiceFallbacks = 0
      const plan = mergeVoicePlan(segments.map((segment) => {
        const speakerId = segment.speakerId
          ? aliases.get(segment.speakerId) ?? segment.speakerId
          : null
        const configuredVoice = playbackVoiceForSpeaker(
          speakerId,
          message.is_user,
          config.characterVoices,
          config.narratorVoice,
          config.userVoice,
        )
        const voice = configuredVoice || connectionProfileVoice
        if (configuredVoice) explicitVoiceCount += 1
        else if (connectionProfileVoice) connectionVoiceFallbacks += 1
        return {
          text: segment.ttsText ?? segment.text,
          voice,
          ...(segment.ttsTag ? { tagId: segment.ttsTag.id } : {}),
        }
      }))
      appendSpeakerDebugLog(
        `TTS voice resolution: explicit=${explicitVoiceCount}, `
          + `connectionDefaultFallback=${connectionVoiceFallbacks}`
          + `${connectionVoiceFallbacks > 0
            ? ` (explicit default voice ${JSON.stringify(connectionProfileVoice || '<connection default>')})`
            : ''}.`,
      )
      const tagIndexes = new Map<string, number[]>()
      plan.forEach((entry, index) => {
        if (!entry.tagId) return
        const indexes = tagIndexes.get(entry.tagId) ?? []
        indexes.push(index)
        tagIndexes.set(entry.tagId, indexes)
      })
      const tagSources = new Map<string, {
        text: string
        emotions: string[]
        styles: string[]
        sounds: string[]
        pauses: Array<'short' | 'long'>
        modulation: boolean
        modulationPoint?: string
        modulationCharIndex?: number
        narrativeBefore: string
        narrativeAfter: string
      }>()
      let synthesisPlanFrozen = false
      for (const segment of segments) {
        // Multi-paragraph speeches are split into separate TTS requests. Keep
        // the deterministic placement there so one speech-level placement
        // result is not duplicated across every paragraph.
        if (
          segment.ttsTag
          && (
            preferences.ttsTagStyle === 'fish'
            || segment.ttsTag.sounds.length > 0
            || segment.ttsTag.pauses.length > 0
          )
          && !/\n\s*\n/u.test(segment.text.trim())
        ) {
          tagSources.set(segment.ttsTag.id, {
            text: segment.ttsTag.baseText ?? segment.ttsText ?? segment.text,
            emotions: segment.ttsTag.emotions,
            styles: segment.ttsTag.styles,
            sounds: segment.ttsTag.sounds,
            pauses: segment.ttsTag.pauses,
            modulation: segment.ttsTag.modulation === true,
            ...(segment.ttsTag.modulationPoint
              ? { modulationPoint: segment.ttsTag.modulationPoint }
              : {}),
            ...(segment.ttsTag.modulationCharIndex !== undefined
              ? { modulationCharIndex: segment.ttsTag.modulationCharIndex }
              : {}),
            narrativeBefore: segment.ttsTag.narrativeBefore ?? '',
            narrativeAfter: segment.ttsTag.narrativeAfter ?? '',
          })
        }
      }
      const applyTagPlacements = (
        placements: Array<{ id: string; text: string; emotionTag?: string; modulationTag?: string }>,
        origin: 'cache' | 'llm',
      ) => {
        for (const placement of placements) {
          const source = tagSources.get(placement.id)
          if (!source) continue
          tagPlacementCache.set(
            `${playbackChat.id}\u0000${messageId}\u0000${preferences.ttsTagStyle}\u0000${preferences.tagLlmConnectionId}`
              + `\u0000${preferences.tagLlmModel}\u0000${placement.id}`
              + `\u0000${JSON.stringify(source.emotions)}`
              + `\u0000${JSON.stringify(source.styles)}`
              + `\u0000${JSON.stringify(source.sounds)}`
              + `\u0000${JSON.stringify(source.pauses)}`
              + `\u0000${source.modulation ? '1' : '0'}`
              + `\u0000${source.modulationPoint ?? ''}`
              + `\u0000${source.modulationCharIndex ?? ''}`
              + `\u0000${source.text}`
              + `\u0000${source.narrativeBefore}\u0000${source.narrativeAfter}`,
            placement.text,
          )
          if (synthesisPlanFrozen) {
            appendSpeakerDebugLog(
              `TTS tag placement [${placement.id}] arrived after synthesis-plan freeze; `
                + 'cached for the next playback without changing the active plan.',
            )
            continue
          }
          for (const index of tagIndexes.get(placement.id) ?? []) {
            plan[index] = { ...plan[index], text: placement.text }
          }
          for (const segment of segments) {
            if (segment.ttsTag?.id !== placement.id) continue
            segment.ttsText = placement.text
            segment.ttsTag = { ...segment.ttsTag, source: 'llm' }
          }
          appendSpeakerDebugLog(
            `TTS tag placement [${placement.id}] emotions=${JSON.stringify(source.emotions)}, `
              + `styles=${JSON.stringify(source.styles)}, `
              + `sounds=${JSON.stringify(source.sounds)}, `
              + `pauses=${JSON.stringify(source.pauses)}, `
              + `modulation=${source.modulation}`
              + `${source.modulationPoint ? ` at ${source.modulationPoint}` : ''}`
              + `${source.modulationCharIndex !== undefined
                ? ` char=${source.modulationCharIndex}`
                : ''}`
              + `${placement.emotionTag ? `, custom=${JSON.stringify(placement.emotionTag)}` : ''}`
              + `${placement.modulationTag
                ? `, modulationTag=${JSON.stringify(placement.modulationTag)}`
                : ''} `
              + `via ${origin}: `
              + JSON.stringify(placement.text.length > 180
                ? `${placement.text.slice(0, 177)}...`
                : placement.text),
          )
        }
      }
      if (
        preferences.ttsTagStyle !== 'off'
        && preferences.ttsTagPlacement === 'llm'
        && tagSources.size > 0
      ) {
        const placementStyle = preferences.ttsTagStyle as 'gemini' | 'gemini38' | 'fish'
        appendSpeakerDebugLog(
          `\nTTS tag placement: style=${placementStyle}, mode=llm, `
            + `speeches=${tagSources.size}, `
            + `connection=${JSON.stringify(preferences.tagLlmConnectionId || '<active>')}, `
            + `model=${JSON.stringify(preferences.tagLlmModel || '<connection default>')}`,
        )
        const keyFor = (id: string, source: {
          text: string
          emotions: string[]
          styles: string[]
          sounds: string[]
          pauses: Array<'short' | 'long'>
          modulation: boolean
          modulationPoint?: string
          modulationCharIndex?: number
          narrativeBefore: string
          narrativeAfter: string
        }) => (
          `${playbackChat.id}\u0000${messageId}\u0000${placementStyle}\u0000${preferences.tagLlmConnectionId}`
            + `\u0000${preferences.tagLlmModel}\u0000${id}`
            + `\u0000${JSON.stringify(source.emotions)}`
            + `\u0000${JSON.stringify(source.styles)}`
            + `\u0000${JSON.stringify(source.sounds)}`
            + `\u0000${JSON.stringify(source.pauses)}`
            + `\u0000${source.modulation ? '1' : '0'}`
            + `\u0000${source.modulationPoint ?? ''}`
            + `\u0000${source.modulationCharIndex ?? ''}`
            + `\u0000${source.text}`
            + `\u0000${source.narrativeBefore}\u0000${source.narrativeAfter}`
        )
        const cachedPlacements: Array<{ id: string; text: string }> = []
        for (const [id, source] of tagSources) {
          const cached = tagPlacementCache.get(keyFor(id, source))
          if (cached) cachedPlacements.push({ id, text: cached })
        }
        if (cachedPlacements.length > 0) {
          appendSpeakerDebugLog(
            `TTS tag placement cache hits: ${cachedPlacements.length}/${tagSources.size}.`,
          )
          applyTagPlacements(cachedPlacements, 'cache')
        }
        const items = [...tagSources.entries()]
          .filter(([id, source]) => !tagPlacementCache.has(keyFor(id, source)))
          .map(([id, source]) => ({
            id,
            text: source.text,
            emotions: source.emotions,
            styles: source.styles,
            sounds: source.sounds,
            pauses: source.pauses,
            modulation: source.modulation,
            ...(source.modulationPoint ? { modulationPoint: source.modulationPoint } : {}),
            ...(source.modulationCharIndex !== undefined
              ? { modulationCharIndex: source.modulationCharIndex }
              : {}),
            narrativeBefore: source.narrativeBefore,
            narrativeAfter: source.narrativeAfter,
          }))
        const chunks: Array<Array<{
          id: string
          text: string
          emotions: string[]
          styles: string[]
          sounds: string[]
          pauses: Array<'short' | 'long'>
          modulation: boolean
          modulationPoint?: string
          modulationCharIndex?: number
          narrativeBefore: string
          narrativeAfter: string
        }>> = []
        for (let index = 0; index < items.length; index += 4) {
          chunks.push(items.slice(index, index + 4))
        }
        if (chunks.length > 0) {
          appendSpeakerDebugLog(
            `TTS tag placement chunks: ${chunks.length} pending `
              + `(first chunk ${chunks[0].length} speeches, later chunks of up to 4).`,
          )
          let firstSettled = false
          appendSpeakerDebugLog(
            `TTS tag placement chunk 1/${chunks.length} started with ${chunks[0].length} speeches.`,
          )
          const firstPlacement = requestTagPlacements(
            message.content,
            placementStyle,
            preferences.tagLlmConnectionId,
            preferences.tagLlmModel,
            chunks[0],
          ).then((placements) => {
            firstSettled = true
            appendSpeakerDebugLog(
              `TTS tag placement chunk 1/${chunks.length} resolved with `
                + `${placements.length}/${chunks[0].length} placements.`,
            )
            applyTagPlacements(placements, 'llm')
            return placements
          }).catch((error) => {
            firstSettled = true
            appendSpeakerDebugLog(
              `TTS tag placement chunk 1/${chunks.length} failed; `
                + `deterministic Jev placement remains: `
                + `${error instanceof Error ? error.message : String(error)}`,
            )
            console.warn('[Chat Voice] First vocal tag placement chunk failed.', error)
            return []
          })
          setStatus('Placing vocal tags…')
          await Promise.race([
            firstPlacement,
            new Promise<void>(resolve => setTimeout(resolve, 8_000)),
          ])
          if (!firstSettled) {
            appendSpeakerDebugLog(
              'TTS tag placement chunk 1 is still pending after 8s; '
                + 'starting playback with deterministic Jev placement for unresolved segments.',
            )
          }
          void (async () => {
            let chunkNumber = 2
            for (const chunk of chunks.slice(1)) {
              if (playback.controller.signal.aborted) {
                appendSpeakerDebugLog(
                  `TTS tag placement chunk ${chunkNumber}/${chunks.length} skipped because playback stopped.`,
                )
                return
              }
              appendSpeakerDebugLog(
                `TTS tag placement chunk ${chunkNumber}/${chunks.length} started with ${chunk.length} speeches.`,
              )
              try {
                const placements = await requestTagPlacements(
                  message.content,
                  placementStyle,
                  preferences.tagLlmConnectionId,
                  preferences.tagLlmModel,
                  chunk,
                )
                appendSpeakerDebugLog(
                  `TTS tag placement chunk ${chunkNumber}/${chunks.length} resolved with `
                    + `${placements.length}/${chunk.length} placements.`,
                )
                applyTagPlacements(placements, 'llm')
              } catch (error) {
                appendSpeakerDebugLog(
                  `TTS tag placement chunk ${chunkNumber}/${chunks.length} failed; `
                    + `deterministic Jev placement remains: `
                    + `${error instanceof Error ? error.message : String(error)}`,
                )
                console.warn('[Chat Voice] Vocal tag placement chunk failed.', error)
              }
              chunkNumber += 1
            }
          })()
        }
      }
      synthesisPlanFrozen = true
      const splitPlan = splitLargeVoicePlanSegments(plan)
      if (splitPlan.length !== plan.length) {
        appendSpeakerDebugLog(
          `Split ${plan.length} paragraph-level TTS job${plan.length === 1 ? '' : 's'} into `
            + `${splitPlan.length} latency-sized segments.`,
        )
        plan.splice(0, plan.length, ...splitPlan)
      }
      if (plan.length === 0) throw new Error('This message has no playable narration or dialogue.')
      if (preferences.speakerAssignmentDebug) {
        appendSpeakerDebugLog('\nSynthesis plan')
        plan.forEach((segment, index) => appendSpeakerDebugLog(
          `  [${index + 1}] voice=${JSON.stringify(segment.voice || '<connection default>')} text=${JSON.stringify(segment.text.length > 120 ? `${segment.text.slice(0, 117)}...` : segment.text)}`,
        ))
      }

      const synthesisMessageKey = `${playbackChat.id}\u0000${messageId}`
      const previousSynthesis = backgroundSynthesisByMessage.get(synthesisMessageKey)
      if (previousSynthesis) {
        previousSynthesis.abort()
        backgroundSynthesisByMessage.delete(synthesisMessageKey)
        appendSpeakerDebugLog('Cancelled an older unfinished synthesis/save for this message.')
      }
      const synthesisController = new AbortController()
      const rateLimitBudget: RateLimitBudget = {
        blockedUntil: 0,
        cumulativeWaitMs: 0,
        consecutiveResponses: 0,
        maximumWaitMs: preferences.rateLimitWaitSeconds * 1_000,
        recovering: false,
        recoveryTail: Promise.resolve(),
      }
      playback.synthesisController = synthesisController
      backgroundSynthesisControllers.add(synthesisController)
      backgroundSynthesisByMessage.set(synthesisMessageKey, synthesisController)
      type PreparedSegment =
        | { ok: true; segment: SynthesizedVoiceSegment }
        | { ok: false; error: unknown }
      const adaptiveLimitToken = Symbol('playback-concurrency')
      let adaptiveConcurrency = 1
      let shortConcurrencyCooldown = 0
      let longWindowStreak = 0
      let rateLimitedForRemainder = false
      const prepare = async (index: number): Promise<PreparedSegment> => {
        try {
          appendSpeakerDebugLog(
            `Synthesis request [${index + 1}] started with voice=${JSON.stringify(plan[index].voice || '<connection default>')}.`,
          )
          const segment = await runSynthesisTask(() => {
            const text = plan[index].text
            const voice = plan[index].voice
            appendSpeakerDebugLog(
              `Synthesis dispatch [${index + 1}] voice=${JSON.stringify(voice || '<connection default>')}, `
                + `textHash=${hashMessageContent(text)}, chars=${text.length}.`,
            )
            return synthesizeVoiceSegment(
              connectionId,
              text,
              voice,
              preferences.speed,
              synthesisController.signal,
              sharedSynthesisPacer,
              rateLimitBudget,
              connectionVoiceGates.get(connectionId) ?? (() => {
                const gate = new ConnectionVoiceGate()
                connectionVoiceGates.set(connectionId, gate)
                return gate
              })(),
              (delayMs, cumulativeWaitMs) => {
                rateLimitedForRemainder = true
                adaptiveConcurrency = 1
                shortConcurrencyCooldown = 0
                longWindowStreak = 0
                adaptiveSynthesisLimits.set(adaptiveLimitToken, 1)
                drainSynthesisQueue()
                if (ctx.getActiveChat().chatId === playbackChat.id && (!activePlayback || activePlayback === playback)) {
                setStatus(
                  `Rate limited; resuming in ${Math.max(1, Math.ceil(delayMs / 1_000))}s… `
                  + `(${Math.ceil(cumulativeWaitMs / 1_000)}s of ${preferences.rateLimitWaitSeconds}s wait budget)`,
                )
              }
            },
          )
        }, activePlayback === playback && !playback.playbackStopped)
          appendSpeakerDebugLog(
            `Synthesis request [${index + 1}] completed with voice=${JSON.stringify(plan[index].voice || '<connection default>')} `
              + `(${segment.data.byteLength} bytes, ${segment.mime}, fingerprint=${segment.fingerprint ?? '<none>'}).`,
          )
          return { ok: true, segment }
        } catch (error) {
          appendSpeakerDebugLog(
            `Synthesis request [${index + 1}] failed for voice=${JSON.stringify(plan[index].voice || '<connection default>')}: ${error instanceof Error ? error.message : String(error)}`,
          )
          return { ok: false, error }
        }
      }

      const preparedResolvers: Array<(value: PreparedSegment) => void> = []
      const prepared = plan.map(() => new Promise<PreparedSegment>((resolve) => {
        preparedResolvers.push(resolve)
      }))
      const synthesizedIndexes = new Set<number>()
      let playbackCursor = 0
      const readySynthesisAhead = () => {
        let index = playbackCursor
        while (synthesizedIndexes.has(index)) index += 1
        return index - playbackCursor
      }
      let synthesisCursor = 0
      let localSynthesisTasks = 0
      const initialAdaptiveState = adaptiveGenerationConcurrency(
        adaptiveConcurrency,
        preferences.concurrentGenerations,
        plan.slice(0, 6).map(segment => segment.text.length),
        shortConcurrencyCooldown,
        longWindowStreak,
        MAX_CONCURRENT_GENERATIONS,
        plan.slice(1, 6).filter((segment, index) => (
          segment.voice !== plan[index]?.voice
        )).length,
      )
      adaptiveConcurrency = bufferAwareGenerationConcurrency(
        adaptiveConcurrency,
        preferences.concurrentGenerations,
        readySynthesisAhead(),
        preferences.playbackBufferSegments,
        initialAdaptiveState.concurrency,
        rateLimitedForRemainder,
        MAX_CONCURRENT_GENERATIONS,
      )
      shortConcurrencyCooldown = initialAdaptiveState.shortCooldown
      longWindowStreak = initialAdaptiveState.longWindowStreak
      adaptiveSynthesisLimits.set(adaptiveLimitToken, adaptiveConcurrency)
      appendSpeakerDebugLog(
        `Initial synthesis concurrency=${adaptiveConcurrency}, readyAhead=${readySynthesisAhead()}, `
          + `bufferTarget=${preferences.playbackBufferSegments}, configuredMax=${preferences.concurrentGenerations}.`,
      )
      const scheduleSynthesis = () => {
        while (localSynthesisTasks < adaptiveConcurrency && synthesisCursor < plan.length) {
          const index = synthesisCursor++
          localSynthesisTasks += 1
          void prepare(index).then(result => {
            if (result.ok) synthesizedIndexes.add(index)
            preparedResolvers[index](result)
          }).finally(() => {
            localSynthesisTasks -= 1
            if (!rateLimitedForRemainder) {
              const nextState = adaptiveGenerationConcurrency(
                adaptiveConcurrency,
                preferences.concurrentGenerations,
                plan
                  .slice(index + 1, Math.min(plan.length, index + 7))
                  .map(segment => segment.text.length),
                shortConcurrencyCooldown,
                longWindowStreak,
                MAX_CONCURRENT_GENERATIONS,
                plan
                  .slice(index + 2, Math.min(plan.length, index + 7))
                  .filter((segment, offset) => segment.voice !== plan[index + 1 + offset]?.voice)
                  .length,
              )
              const previousConcurrency = adaptiveConcurrency
              adaptiveConcurrency = bufferAwareGenerationConcurrency(
                adaptiveConcurrency,
                preferences.concurrentGenerations,
                readySynthesisAhead(),
                preferences.playbackBufferSegments,
                nextState.concurrency,
                rateLimitedForRemainder,
                MAX_CONCURRENT_GENERATIONS,
              )
              if (adaptiveConcurrency !== previousConcurrency) {
                appendSpeakerDebugLog(
                  `Synthesis concurrency ${previousConcurrency}->${adaptiveConcurrency} after request ${index + 1}; `
                    + `readyAhead=${readySynthesisAhead()}, bufferTarget=${preferences.playbackBufferSegments}.`,
                )
              }
              shortConcurrencyCooldown = nextState.shortCooldown
              longWindowStreak = nextState.longWindowStreak
              adaptiveSynthesisLimits.set(adaptiveLimitToken, adaptiveConcurrency)
              drainSynthesisQueue()
            }
            scheduleSynthesis()
          })
        }
      }
      scheduleSynthesis()
      void Promise.all(prepared).finally(() => {
        adaptiveSynthesisLimits.delete(adaptiveLimitToken)
        drainSynthesisQueue()
      })
      const normalizationContext = new contextClass()
      const voiceLoudnessProfiles = new Map<string, number>()
      let normalizationChain: Promise<void> = Promise.resolve()
      const processed = prepared.map((pending, index) => {
        const processing = normalizationChain.then(async (): Promise<PreparedSegment> => {
          const result = await pending
          if (!result.ok) return result
          const decodedBuffer = await normalizationContext.decodeAudioData(result.segment.data.slice(0))
          const voiceKey = plan[index].voice.trim().toLowerCase() || '__connection-default__'
          const normalizationGain = normalizedVoiceGain(decodedBuffer, voiceKey, voiceLoudnessProfiles)
          return {
            ok: true,
            segment: { ...result.segment, decodedBuffer, normalizationGain },
          }
        })
        normalizationChain = processing.then(() => undefined, () => undefined)
        return processing
      })
      void Promise.all(processed)
        .finally(() => normalizationContext.close().catch(() => undefined))
        .catch(() => undefined)
      if (shouldPersistMessageAudio(
        message.is_user,
        preferences.saveGeneratedAudio,
        regeneratingSavedAudio,
      )) {
        playback.persistenceState = 'pending'
        void Promise.all(processed).then(async (results) => {
          const failed = results.find((result): result is { ok: false; error: unknown } => !result.ok)
          if (failed) throw failed.error
          const captured = results.filter(
            (result): result is { ok: true; segment: SynthesizedVoiceSegment } => result.ok,
          ).map(result => ({
            data: result.segment.data.slice(0),
            mime: result.segment.mime,
            decodedBuffer: result.segment.decodedBuffer,
            normalizationGain: result.segment.normalizationGain,
          }))
          const saved = await persistCapturedAudio(
            playbackChat.id,
            messageId,
            message.swipe_id,
            captured,
            contextClass,
            synthesisController.signal,
            () => playback.audibleDone,
            (normalized) => {
              if (ctx.getActiveChat().chatId === playbackChat.id && (!activePlayback || activePlayback === playback)) {
                setStatus(normalized
                  ? 'Preparing normalized saved audio…'
                  : 'Server could not combine the source audio; retrying as WAV…')
              }
            },
          )
          const savedAudioId = saved.audio?.id
          if (savedAudioId) {
            try {
              await enforceSavedAudioRetention({
                chatId: playbackChat.id,
                messageId,
                audioId: savedAudioId,
                swipeId: saved.swipe_id ?? message.swipe_id ?? 0,
                savedAt: Date.now(),
              })
            } catch (error) {
              console.warn('[Chat Voice] Saved audio retention cleanup failed.', error)
            }
          }
          playback.persistenceState = 'saved'
          console.info('[Chat Voice] Saved generated message audio.', {
            messageId,
            swipeId: saved.swipe_id,
            audioId: saved.audio?.id,
            mime: saved.audio?.mime_type,
            sizeBytes: saved.audio?.size_bytes,
            muxedWithFfmpeg: saved.muxed_with_ffmpeg,
          })
          if (ctx.getActiveChat().chatId === playbackChat.id && (!activePlayback || activePlayback === playback)) {
            if (playback.playbackStopped) setStatus('Playback stopped; audio saved.', 'saved')
            else if (playback.playbackFinished) setStatus('Playback complete and audio saved.', 'saved')
          }
        }).catch((error) => {
          playback.persistenceState = 'failed'
          playback.persistenceError = error instanceof Error ? error.message : 'Unknown save error.'
          if (
            (error as { name?: string })?.name !== 'AbortError'
            && ctx.getActiveChat().chatId === playbackChat.id
            && (!activePlayback || activePlayback === playback)
            && (playback.playbackStopped || playback.playbackFinished)
          ) {
            setStatus(`Audio could not be saved: ${playback.persistenceError}`, 'error')
          }
        }).finally(() => {
          backgroundSynthesisControllers.delete(synthesisController)
          if (backgroundSynthesisByMessage.get(synthesisMessageKey) === synthesisController) {
            backgroundSynthesisByMessage.delete(synthesisMessageKey)
          }
        })
      } else {
        playback.persistenceState = 'disabled'
        void Promise.all(processed)
          .catch(() => undefined)
          .finally(() => {
            backgroundSynthesisControllers.delete(synthesisController)
            if (backgroundSynthesisByMessage.get(synthesisMessageKey) === synthesisController) {
              backgroundSynthesisByMessage.delete(synthesisMessageKey)
            }
          })
      }

      const initialBufferSize = Math.min(preferences.playbackBufferSegments, plan.length)
      setStatus(
        `Buffering ${initialBufferSize} voice segment${initialBufferSize === 1 ? '' : 's'} before playback…`,
      )
      await Promise.all(processed.slice(0, initialBufferSize))

      for (let index = 0; index < plan.length; index += 1) {
        const current = await processed[index]
        if (!current.ok) throw current.error
        playbackCursor = index + 1
        if (synthesisCursor < plan.length || localSynthesisTasks > 0) {
          const pressuredConcurrency = bufferAwareGenerationConcurrency(
            adaptiveConcurrency,
            preferences.concurrentGenerations,
            readySynthesisAhead(),
            preferences.playbackBufferSegments,
            adaptiveConcurrency,
            rateLimitedForRemainder,
            MAX_CONCURRENT_GENERATIONS,
          )
          if (pressuredConcurrency !== adaptiveConcurrency) {
            appendSpeakerDebugLog(
              `Synthesis concurrency ${adaptiveConcurrency}->${pressuredConcurrency} at playback ${index + 1}; `
                + `readyAhead=${readySynthesisAhead()}, bufferTarget=${preferences.playbackBufferSegments}.`,
            )
            adaptiveConcurrency = pressuredConcurrency
            adaptiveSynthesisLimits.set(adaptiveLimitToken, adaptiveConcurrency)
            drainSynthesisQueue()
            scheduleSynthesis()
          }
        }
        appendSpeakerDebugLog(
          `Playback [${index + 1}] using voice=${JSON.stringify(plan[index].voice || '<connection default>')}.`,
        )
        setStatus(`Playing ${index + 1} of ${plan.length} voice segment${plan.length === 1 ? '' : 's'}…`)
        await playDecodedBuffer(playback, current.segment, preferences.volume)
      }
      adaptiveSynthesisLimits.delete(adaptiveLimitToken)
      drainSynthesisQueue()
      playback.playbackFinished = true
      playback.finishAudible()
      if (activePlayback === playback) {
        activePlayback = null
        updatePlaybackButtons()
        await playback.context.close().catch(() => undefined)
      }
      const persistenceState = playback.persistenceState as 'disabled' | 'not-started' | 'pending' | 'saved' | 'failed'
      if (persistenceState === 'saved') setStatus('Playback complete and audio saved.', 'saved')
      else if (persistenceState === 'failed') {
        setStatus(`Playback completed, but its audio could not be saved: ${playback.persistenceError}`, 'error')
      } else if (persistenceState === 'pending') setStatus('Playback complete; finishing saved audio…')
      else setStatus('Playback complete.', 'saved')
    } catch (error) {
      if ((error as { name?: string })?.name !== 'AbortError') {
        setStatus(error instanceof Error ? error.message : 'Custom voice playback failed.', 'error')
      }
    } finally {
      playback.finishAudible()
      if (activePlayback === playback) {
        activePlayback = null
        await playback.context.close().catch(() => undefined)
        updatePlaybackButtons()
      }
    }
  }

  function scanMessages() {
    if (!activeChat || scanning) return
    flushSave()
    scanning = true
    scanButton.disabled = true
    scanButton.textContent = 'Scanning…'
    setStatus('Reading the active character card cast…')
    ctx.sendToBackend({
      type: 'chat_voice_scan',
      chatId: activeChat.id,
      messageLimit: activeChat.messageLimit,
    })
  }

  scanButton.addEventListener('click', scanMessages)

  function connectionOptions(selectedId = '') {
    const options = connections.map((connection) => ({
      value: connection.id,
      label: connection.name,
      sublabel: connection.provider,
    }))
    if (selectedId && !connections.some((connection) => connection.id === selectedId)) {
      options.unshift({ value: selectedId, label: 'Missing connection', sublabel: selectedId })
    }
    return options
  }

  function addManualNpc() {
    if (!activeChat) return
    const aliases = speakerAliases(addNpcInput.getValue().slice(0, 128))
    if (aliases.length === 0) {
      setStatus('Enter an NPC name first.', 'error')
      return
    }
    const existingAliases = new Set(activeChat.characters.flatMap((character) => (
      speakerAliases(character.name).map(alias => alias.toLowerCase())
    )))
    const duplicateAlias = aliases.find(alias => existingAliases.has(alias.toLowerCase()))
    if (duplicateAlias) {
      setStatus(`${duplicateAlias} is already in this chat's voice roster.`, 'error')
      return
    }
    const name = aliases.join(' / ')
    const id = npcSpeakerId(aliases[0])
    activeChat = {
      ...activeChat,
      characters: [...activeChat.characters, { id, name, messageCount: 0, voice: '' }],
    }
    addNpcInput.update({ value: '' })
    renderCharacters(activeChat.characters)
    markChanged(0)
  }

  function removeCharacter(characterId: string) {
    if (!activeChat) return
    activeChat = {
      ...activeChat,
      characters: activeChat.characters.filter((character) => character.id !== characterId),
    }
    renderCharacters(activeChat.characters)
    markChanged(0)
  }

  function renameCharacter(characterId: string): string | null {
    if (!activeChat) return null
    const character = activeChat.characters.find(item => item.id === characterId)
    if (!character) return null
    const response = hostWindow.prompt(
      'Rename this character or add aliases separated by “/”.',
      character.name,
    )
    if (response === null) return null
    const aliases = speakerAliases(response.slice(0, 128))
    if (aliases.length === 0) {
      setStatus('Enter an NPC name first.', 'error')
      return null
    }
    const existingAliases = new Set(activeChat.characters
      .filter(item => item.id !== characterId)
      .flatMap(item => speakerAliases(item.name).map(alias => alias.toLowerCase())))
    const duplicateAlias = aliases.find(alias => existingAliases.has(alias.toLowerCase()))
    if (duplicateAlias) {
      setStatus(`${duplicateAlias} is already in this chat's voice roster.`, 'error')
      return null
    }
    const name = aliases.join(' / ')
    activeChat = {
      ...activeChat,
      characters: activeChat.characters.map(item => (
        item.id === characterId ? { ...item, name } : item
      )),
    }
    markChanged(0)
    return name
  }

  const onAddNpc = () => addManualNpc()
  const onAddNpcKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    addManualNpc()
  }
  addNpcButton.addEventListener('click', onAddNpc)
  addNpcInputSlot.addEventListener('keydown', onAddNpcKeyDown)

  function renderCharacters(characters: DetectedCharacterState[]) {
    for (const input of characterInputs.values()) input.destroy()
    characterInputs.clear()
    characterList.replaceChildren()
    if (characters.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'chat-voice-empty'
      empty.textContent = 'No saved characters yet. Click Scan to read the active character card.'
      characterList.appendChild(empty)
      return
    }

    for (const character of characters) {
      const card = document.createElement('div')
      card.className = 'chat-voice-character'
      const heading = document.createElement('div')
      heading.className = 'chat-voice-character-heading'
      const name = document.createElement('span')
      name.className = 'chat-voice-character-name'
      name.textContent = character.name
      const count = document.createElement('span')
      count.className = 'chat-voice-character-count'
      count.textContent = character.messageCount > 0
        ? `${character.messageCount} occurrence${character.messageCount === 1 ? '' : 's'}`
        : 'Card cast'
      const meta = document.createElement('span')
      meta.className = 'chat-voice-character-meta'
      meta.append(count)
      {
        const rename = document.createElement('button')
        rename.type = 'button'
        rename.className = 'chat-voice-rename-button'
        rename.innerHTML = RENAME_ICON
        rename.title = `Rename ${character.name} or edit aliases`
        rename.setAttribute('aria-label', rename.title)
        rename.disabled = !activeChat
        const remove = document.createElement('button')
        remove.type = 'button'
        remove.className = 'chat-voice-delete-button'
        remove.textContent = '×'
        remove.title = `Delete ${character.name}`
        remove.setAttribute('aria-label', remove.title)
        remove.disabled = !activeChat
        rename.addEventListener('click', () => {
          const renamed = renameCharacter(character.id)
          if (!renamed) return
          name.textContent = renamed
          rename.title = `Rename ${renamed} or edit aliases`
          rename.setAttribute('aria-label', rename.title)
          remove.title = `Delete ${renamed}`
          remove.setAttribute('aria-label', remove.title)
          input.update({
            placeholder: `Voice name or ID for ${renamed}`,
            ariaLabel: `Custom voice for ${renamed}`,
          })
        })
        remove.addEventListener('click', () => removeCharacter(character.id))
        meta.append(rename, remove)
      }
      const slot = document.createElement('div')
      heading.append(name, meta)
      card.append(heading, slot)
      characterList.appendChild(card)
      const input = ctx.components.mountTextInput(slot, {
        value: character.voice,
        placeholder: `Voice name or ID for ${character.name}`,
        ariaLabel: `Custom voice for ${character.name}`,
        disabled: !activeChat,
        onChange: () => markChanged(),
      })
      characterInputs.set(character.id, input)
    }
  }

  function renderState(next: ActiveChatState | null) {
    applyingState = true
    activeChat = next
    context.textContent = next ? `Active chat: ${next.name}` : 'Open a chat to configure its voices.'
    const selectedConnectionId = next?.connectionId || lumiverseConnectionId
    connectionPicker.update({
      value: selectedConnectionId,
      options: connectionOptions(selectedConnectionId),
      placeholder: connections.length ? 'Choose a TTS connection' : 'No TTS connections found',
      disabled: !next || connections.length === 0,
    })
    scanButton.disabled = !next || scanning
    localNarratorVoice = next?.narratorVoice ?? ''
    localUserVoice = next?.userVoice ?? ''
    useGlobalNarratorVoice = next?.useGlobalNarratorVoice ?? true
    useGlobalUserVoice = next?.useGlobalUserVoice ?? true
    narratorInput.update({
      value: next ? (useGlobalNarratorVoice ? defaultNarratorVoice : localNarratorVoice) : '',
      disabled: !next,
    })
    userVoiceInput.update({
      value: next ? (useGlobalUserVoice ? defaultUserVoice : localUserVoice) : '',
      disabled: !next,
    })
    addNpcInput.update({ value: '', disabled: !next })
    addNpcButton.disabled = !next
    renderCharacters(next?.characters ?? [])
    updateRoleDefaultControls()
    applyingState = false
    if (!next) setStatus('Open a chat to edit its voices.')
    else if (connections.length === 0) setStatus('Create a TTS connection in Lumiverse first.')
    else setStatus('All changes save automatically.', 'saved')
  }

  async function loadConnections() {
    try {
      const [loadedConnections, loadedLlmConnections, preferences] = await Promise.all([
        listAllTtsConnections(),
        requestLlmConnections().catch((error) => {
          console.warn('[Chat Voice] Could not load Lumiverse LLM connections.', error)
          return [] as LlmConnection[]
        }),
        loadPlaybackPreferences(),
        refreshDecisionStatus(),
      ])
      connections = loadedConnections
      llmConnections = loadedLlmConnections
      updateTtsTagControls()
      if (!narratorGlobalSaveTimer && !savingNarratorGlobalVoice) {
        defaultNarratorVoice = preferences.defaultNarratorVoice
      }
      if (!userGlobalSaveTimer && !savingUserGlobalVoice) {
        defaultUserVoice = preferences.defaultUserVoice
      }
      if (activeChat) {
        narratorInput.update({
          value: useGlobalNarratorVoice ? defaultNarratorVoice : localNarratorVoice,
          disabled: false,
        })
        userVoiceInput.update({
          value: useGlobalUserVoice ? defaultUserVoice : localUserVoice,
          disabled: false,
        })
      }
      updateRoleDefaultControls()
      if (!savingAudioPreference) {
        saveGeneratedAudio = preferences.saveGeneratedAudio
        saveAudioToggle.checked = saveGeneratedAudio
      }
      if (!savingAudioLimit) {
        savedAudioLimit = preferences.savedAudioLimit
        saveAudioLimitInput.value = String(savedAudioLimit)
      }
      if (!savingSkippedTrackerTags && !skippedTrackerTagsDirty) {
        skippedTrackerTags = preferences.skippedTrackerTags
        skippedTrackerTagsInput.update({ value: skippedTrackerTags })
      }
      if (!savingLlmSettings && !llmSettingsSaveTimer) {
        speakerParsingMode = preferences.speakerParsingMode
        ttsTagStyle = preferences.ttsTagStyle
        ttsTagPlacement = preferences.ttsTagPlacement
        tagLlmConnectionId = preferences.tagLlmConnectionId
        tagLlmModel = preferences.tagLlmModel
        speakerParsingPicker.update({ value: speakerParsingMode })
        ttsTagPicker.update({ value: ttsTagStyle })
        updateTtsTagControls()
      }
      if (
        !savingLlmSettings
        && !llmSettingsSaveTimer
        && !decisionStatusFailed
        && decisionConnectionsKnown
        && !decisionConnectionAvailable
        && speakerParsingMode !== 'off'
      ) {
        speakerParsingMode = 'off'
        speakerParsingPicker.update({ value: 'off' })
        try {
          await saveLlmParsingPreferences('off')
        } catch (error) {
          console.warn('[Chat Voice] Could not persist the Jev safeguard.', error)
        }
      }
      if (!savingAdvancedSettings && !advancedSettingsSaveTimer) {
        playbackBufferSegments = preferences.playbackBufferSegments
        concurrentGenerationLimit = preferences.concurrentGenerations
        rateLimitWaitSeconds = preferences.rateLimitWaitSeconds
        speakerAssignmentDebug = preferences.speakerAssignmentDebug
        playbackBufferInput.value = String(playbackBufferSegments)
        concurrentGenerationInput.value = String(concurrentGenerationLimit)
        rateLimitWaitInput.value = String(rateLimitWaitSeconds)
        speakerDebugToggle.checked = speakerAssignmentDebug
        speakerDebugOutput.hidden = !speakerAssignmentDebug
      }
      lumiverseConnectionId = connections.some(connection => connection.id === preferences.connectionId)
        ? preferences.connectionId
        : connections.find(connection => connection.is_default)?.id ?? ''
      const selectedConnectionId = activeChat?.connectionId || lumiverseConnectionId
      connectionPicker.update({
        value: selectedConnectionId,
        options: connectionOptions(selectedConnectionId),
        placeholder: connections.length ? 'Choose a TTS connection' : 'No TTS connections found',
        disabled: !activeChat || connections.length === 0,
      })
      if (connections.length === 0) setStatus('Create a TTS connection in Lumiverse first.')
      else if (decisionStatusFailed) {
        setStatus('Could not verify Decision connections. Jev speaker assignment is unavailable.', 'error')
      } else if (decisionConnectionsKnown && !decisionConnectionAvailable) {
        setStatus('Create a Decision model connection in Lumiverse to enable Jev speaker assignment.')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not load TTS connections.'
      connectionPicker.update({ placeholder: 'Connections unavailable', disabled: true })
      setStatus(message, 'error')
    }
  }

  function scheduleLlmSettingsSave(): void {
    if (llmSettingsSaveTimer) clearTimeout(llmSettingsSaveTimer)
    llmSettingsSaveTimer = setTimeout(() => {
      llmSettingsSaveTimer = null
      void persistLlmSettings()
    }, 400)
  }

  function onSpeakerParsingModeChanged(value: string): void {
    void applySpeakerParsingMode(value === 'ambiguous' ? 'ambiguous' : 'off')
  }

  async function applySpeakerParsingMode(next: 'off' | 'ambiguous'): Promise<void> {
    if (next === 'ambiguous') {
      const status = await refreshDecisionStatus()
      if (!status?.available || !status.hasConnection) {
        speakerParsingPicker.update({ value: speakerParsingMode })
        setStatus(
          status
            ? 'Create a Decision model connection in Lumiverse before turning on Jev speaker assignment.'
            : 'Could not verify a Decision model connection. Jev speaker assignment stays off.',
          'error',
        )
        return
      }
    }
    speakerParsingMode = next
    speakerParsingPicker.update({ value: next })
    scheduleLlmSettingsSave()
  }

  async function persistLlmSettings(): Promise<void> {
    savingLlmSettings = true
    let forcedOff = false
    try {
      if (speakerParsingMode === 'ambiguous') {
        const status = await refreshDecisionStatus()
        if (!status?.available || !status.hasConnection) {
          speakerParsingMode = 'off'
          speakerParsingPicker.update({ value: 'off' })
          forcedOff = true
        }
      }
      setStatus('Saving global speaker and tag settings…')
      await saveLlmParsingPreferences(speakerParsingMode)
      await saveTtsTagPreferences(ttsTagStyle, ttsTagPlacement, tagLlmConnectionId, tagLlmModel)
      setStatus(
        forcedOff
          ? 'Jev speaker assignment was turned off because no Decision model connection is configured.'
          : 'Speaker and tag settings saved globally.',
        forcedOff ? 'error' : 'saved',
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not save speaker and tag settings.', 'error')
    } finally {
      savingLlmSettings = false
    }
  }

  function scheduleAdvancedSettingsSave(): void {
    if (advancedSettingsSaveTimer) clearTimeout(advancedSettingsSaveTimer)
    advancedSettingsSaveTimer = setTimeout(() => {
      advancedSettingsSaveTimer = null
      void persistAdvancedSettings()
    }, 400)
  }

  function onPlaybackBufferChanged(value: number | null): void {
    playbackBufferSegments = clampIntegerSetting(
      value,
      DEFAULT_PLAYBACK_BUFFER_SEGMENTS,
      MAX_PLAYBACK_BUFFER_SEGMENTS,
    )
    playbackBufferInput.value = String(playbackBufferSegments)
    scheduleAdvancedSettingsSave()
  }

  function onConcurrentGenerationsChanged(value: number | null): void {
    concurrentGenerationLimit = clampIntegerSetting(
      value,
      DEFAULT_CONCURRENT_GENERATIONS,
      MAX_CONCURRENT_GENERATIONS,
    )
    concurrentGenerationInput.value = String(concurrentGenerationLimit)
    drainSynthesisQueue()
    scheduleAdvancedSettingsSave()
  }

  function onRateLimitWaitChanged(value: number | null): void {
    rateLimitWaitSeconds = clampIntegerSetting(
      value,
      DEFAULT_RATE_LIMIT_WAIT_SECONDS,
      MAX_RATE_LIMIT_WAIT_SECONDS,
    )
    rateLimitWaitInput.value = String(rateLimitWaitSeconds)
    scheduleAdvancedSettingsSave()
  }

  function onSpeakerDebugChanged(): void {
    speakerAssignmentDebug = speakerDebugToggle.checked
    speakerDebugOutput.hidden = !speakerAssignmentDebug
    scheduleAdvancedSettingsSave()
  }

  async function persistAdvancedSettings(): Promise<void> {
    savingAdvancedSettings = true
    setStatus('Saving global advanced playback settings…')
    try {
      await saveAdvancedPlaybackPreferences(
        playbackBufferSegments,
        concurrentGenerationLimit,
        rateLimitWaitSeconds,
        speakerAssignmentDebug,
      )
      setStatus('Advanced playback settings saved globally.', 'saved')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not save advanced playback settings.', 'error')
    } finally {
      savingAdvancedSettings = false
    }
  }

  const onSaveAudioChanged = async () => {
    const previous = saveGeneratedAudio
    const enabled = saveAudioToggle.checked
    saveGeneratedAudio = enabled
    savingAudioPreference = true
    saveAudioToggle.disabled = true
    setStatus('Saving global audio preference…')
    try {
      await saveGeneratedAudioPreference(enabled)
      setStatus(
        enabled ? 'Generated audio will be saved globally.' : 'Generated audio saving is disabled globally.',
        'saved',
      )
    } catch (error) {
      saveGeneratedAudio = previous
      saveAudioToggle.checked = previous
      setStatus(error instanceof Error ? error.message : 'Could not save the audio preference.', 'error')
    } finally {
      savingAudioPreference = false
      saveAudioToggle.disabled = false
    }
  }

  const onSaveAudioLimitChanged = async () => {
    const previous = savedAudioLimit
    const limit = clampSavedAudioLimit(saveAudioLimitInput.value)
    savedAudioLimit = limit
    saveAudioLimitInput.value = String(limit)
    savingAudioLimit = true
    saveAudioLimitInput.disabled = true
    setStatus('Saving global recording limit…')
    try {
      await saveGeneratedAudioLimit(limit)
    } catch (error) {
      savedAudioLimit = previous
      saveAudioLimitInput.value = String(previous)
      setStatus(error instanceof Error ? error.message : 'Could not update the recording limit.', 'error')
      savingAudioLimit = false
      saveAudioLimitInput.disabled = false
      return
    }
    try {
      const deleted = await enforceSavedAudioRetention()
      setStatus(
        deleted > 0
          ? `Saved recording limit updated; removed ${deleted} old recording${deleted === 1 ? '' : 's'}.`
          : 'Saved recording limit updated.',
        'saved',
      )
    } catch (error) {
      setStatus(
        `Recording limit saved, but cleanup failed: ${error instanceof Error ? error.message : 'Unknown error.'}`,
        'error',
      )
    } finally {
      savingAudioLimit = false
      saveAudioLimitInput.disabled = false
    }
  }

  function scheduleSkippedTrackerTagsSave(): void {
    skippedTrackerTags = skippedTrackerTagsInput.getValue().slice(0, 4_000)
    skippedTrackerTagsDirty = true
    if (skippedTrackerTagsSaveTimer) clearTimeout(skippedTrackerTagsSaveTimer)
    skippedTrackerTagsSaveTimer = setTimeout(() => {
      skippedTrackerTagsSaveTimer = null
      void persistSkippedTrackerTags(skippedTrackerTags)
    }, 500)
  }

  async function persistSkippedTrackerTags(value: string): Promise<void> {
    savingSkippedTrackerTags = true
    setStatus('Saving global tracker exclusions…')
    try {
      await saveSkippedTrackerTagsPreference(value)
      if (skippedTrackerTags === value) skippedTrackerTagsDirty = false
      setStatus('Global tracker exclusions saved.', 'saved')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not save tracker exclusions.', 'error')
    } finally {
      savingSkippedTrackerTags = false
    }
  }

  const onNativeContextMenu = (event: MouseEvent) => {
    const target = event.target && typeof (event.target as Element).closest === 'function'
      ? event.target as Element
      : null
    lastContextMessageId = target?.closest<HTMLElement>('[data-message-id]')?.dataset.messageId ?? null
    hostWindow.requestAnimationFrame(updatePlaybackButtons)
    if (lastContextMessageId) void ensureSavedUserContextAction(lastContextMessageId)
  }

  function hasAnySavedAudio(message: PlaybackMessage): boolean {
    const attachments = message.extra?.attachments
    return Array.isArray(attachments) && attachments.some(candidate => (
      !!candidate && typeof candidate === 'object' && (candidate as SavedAudioAttachment).type === 'audio'
    ))
  }

  function loadMessageForSavedAudioControl(chatId: string, messageId: string): Promise<PlaybackMessage | null> {
    if (ctx.messages.get) return ctx.messages.get(messageId) as Promise<PlaybackMessage | null>
    return requestPlaybackMessage(chatId, messageId)
  }

  async function ensureSavedUserContextAction(messageId: string): Promise<void> {
    const chatId = ctx.getActiveChat().chatId
    if (!chatId) return
    let message: PlaybackMessage
    try {
      const loaded = await loadMessageForSavedAudioControl(chatId, messageId)
      if (!loaded) return
      message = loaded
    } catch {
      return
    }
    if (!message.is_user || !hasAnySavedAudio(message) || lastContextMessageId !== messageId) return
    await new Promise<void>(resolve => hostWindow.requestAnimationFrame(() => resolve()))
    const existing = hostDocument.querySelector<HTMLElement>(`[data-chat-voice-context-tts="${CSS.escape(messageId)}"]`)
    if (existing) return
    const menuItems = [...hostDocument.querySelectorAll<HTMLElement>('button, [role="menuitem"]')]
      .filter(item => item.getClientRects().length > 0 && item.closest('[data-message-id]') === null)
    const template = menuItems.find(item => item.textContent?.trim().toLowerCase() === 'copy')
      ?? menuItems.find(item => item.textContent?.trim().toLowerCase() === 'edit')
    if (!template?.parentElement) return
    const action = template.cloneNode(true) as HTMLElement
    action.removeAttribute('id')
    action.dataset.chatVoiceContextTts = messageId
    action.setAttribute('aria-label', 'Play TTS audio')
    const label = action.querySelector('span')
    if (label) label.textContent = 'Play TTS audio'
    else action.textContent = 'Play TTS audio'
    const icon = action.querySelector('svg')
    if (icon) icon.outerHTML = PLAY_TTS_ACTION_ICON
    action.addEventListener('click', (clickEvent) => {
      clickEvent.preventDefault()
      clickEvent.stopPropagation()
      hostDocument.dispatchEvent(new hostWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      void playMessage(messageId, false)
    })
    insertAtActionIndex(template.parentElement, action, preferredTtsActionIndex())
  }

  const onNativeTtsClick = (event: MouseEvent) => {
    const target = event.target && typeof (event.target as Element).closest === 'function'
      ? event.target as Element
      : null
    const button = target?.closest<HTMLButtonElement>('button')
    if (!button) return
    const messageId = nativeTtsMessageId(button)
    if (!messageId) return
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
    if (button.parentElement?.parentElement === button.ownerDocument.body) {
      hostDocument.dispatchEvent(new hostWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    }
    const nativeRegenerationAction = /regenerate.+audio/.test(nativeTtsButtonLabel(button))
    void playMessage(messageId, nativeRegenerationAction)
  }

  hostWindow.addEventListener('contextmenu', onNativeContextMenu, true)
  hostWindow.addEventListener('click', onNativeTtsClick, true)
  saveAudioToggle.addEventListener('change', onSaveAudioChanged)
  saveAudioLimitInput.addEventListener('change', onSaveAudioLimitChanged)
  hostWindow.requestAnimationFrame(updatePlaybackButtons)

  const unsubscribeBackend = ctx.onBackendMessage((rawPayload: unknown) => {
    const payload = rawPayload as
      | StatePayload
      | ErrorPayload
      | ScanCompletePayload
      | MessagePayload
      | ParsedMessagePayload
      | DecisionStatusPayload
      | LlmConnectionsPayload
      | TagPlacementPayload
    if (payload.type === 'chat_voice_message') {
      const pending = pendingMessageRequests.get(payload.requestId)
      if (!pending) return
      clearTimeout(pending.timer)
      pendingMessageRequests.delete(payload.requestId)
      if (payload.error || !payload.message) pending.reject(new Error(payload.error || 'The message is unavailable.'))
      else pending.resolve(payload.message)
      return
    }
    if (payload.type === 'chat_voice_parsed_message') {
      const pending = pendingSpeakerParseRequests.get(payload.requestId)
      if (!pending) return
      clearTimeout(pending.timer)
      pendingSpeakerParseRequests.delete(payload.requestId)
      if (payload.error || !payload.segments) {
        pending.reject(new Error(payload.error || 'The message speakers could not be assigned.'))
      } else {
        pending.resolve({ segments: payload.segments, usedLlm: payload.usedLlm ?? null, failed: false })
      }
      return
    }
    if (payload.type === 'chat_voice_decision_status') {
      const pending = payload.requestId ? pendingDecisionStatusRequests.get(payload.requestId) : undefined
      if (!pending) return
      clearTimeout(pending.timer)
      pendingDecisionStatusRequests.delete(payload.requestId!)
      pending.resolve({
        available: payload.available,
        hasConnection: payload.hasConnection,
        defaultConnectionName: payload.defaultConnectionName ?? null,
      })
      return
    }
    if (payload.type === 'chat_voice_llm_connections') {
      const pending = pendingLlmConnectionRequests.get(payload.requestId)
      if (!pending) return
      clearTimeout(pending.timer)
      pendingLlmConnectionRequests.delete(payload.requestId)
      if (payload.error) pending.reject(new Error(payload.error))
      else pending.resolve(payload.connections)
      return
    }
    if (payload.type === 'chat_voice_tag_placement') {
      const pending = pendingTagPlacementRequests.get(payload.requestId)
      if (!pending) return
      clearTimeout(pending.timer)
      pendingTagPlacementRequests.delete(payload.requestId)
      if (payload.error) pending.reject(new Error(payload.error))
      else pending.resolve(payload.placements)
      return
    }
    if (payload.type === 'chat_voice_error') {
      if (payload.requestId) {
        const pending = pendingStateRequests.get(payload.requestId)
        if (pending) {
          clearTimeout(pending.timer)
          pendingStateRequests.delete(payload.requestId)
          pending.reject(new Error(payload.error || 'Could not load chat voice settings.'))
        }
      }
      if (payload.clientRevision !== undefined) inFlight.delete(payload.clientRevision)
      scanning = false
      scanButton.textContent = 'Scan'
      scanButton.disabled = !activeChat
      setStatus(payload.error || 'Could not save chat voice settings.', 'error')
      return
    }
    if (payload.type === 'chat_voice_scan_complete') {
      if (payload.chatId !== activeChat?.id) return
      scanning = false
      scanButton.textContent = 'Scan'
      scanButton.disabled = false
      setStatus(payload.cardParserFallback
        ? 'Card parsing was unavailable; the primary card character was saved.'
        : 'Scan complete. Character-card cast saved.', 'saved')
      return
    }
    if (payload.type !== 'chat_voice_state') return

    const incomingChatId = payload.chat?.id ?? null
    const localChatId = ctx.getActiveChat().chatId
    const pendingState = payload.requestId ? pendingStateRequests.get(payload.requestId) : undefined
    if (pendingState) {
      clearTimeout(pendingState.timer)
      pendingStateRequests.delete(payload.requestId!)
    }
    if (incomingChatId !== localChatId) {
      pendingState?.reject(new Error('The active chat changed while its voice settings were loading.'))
      return
    }
    const currentChatId = activeChat?.id ?? null
    if (incomingChatId !== currentChatId) {
      for (const pending of pendingMessageRequests.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error('The active chat changed before playback started.'))
      }
      pendingMessageRequests.clear()
      for (const pending of pendingSpeakerParseRequests.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error('The active chat changed before speaker review completed.'))
      }
      pendingSpeakerParseRequests.clear()
      for (const pending of pendingDecisionStatusRequests.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error('The active chat changed before the Decision connection check completed.'))
      }
      pendingDecisionStatusRequests.clear()
      for (const pending of pendingLlmConnectionRequests.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error('The active chat changed before LLM connections loaded.'))
      }
      pendingLlmConnectionRequests.clear()
      for (const pending of pendingTagPlacementRequests.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error('The active chat changed before vocal tag placement completed.'))
      }
      pendingTagPlacementRequests.clear()
      stopPlayback()
      flushSave()
      dirty = false
      inFlight.clear()
      scanning = false
      scanButton.textContent = 'Scan'
      renderState(payload.chat)
      pendingState?.resolve(payload.chat)
      return
    }

    if (payload.clientRevision !== undefined) {
      inFlight.delete(payload.clientRevision)
      if (payload.clientRevision !== editRevision || dirty) return
      renderState(payload.chat)
      setStatus('Saved.', 'saved')
      pendingState?.resolve(payload.chat)
      return
    }

    if (dirty || inFlight.size > 0) {
      pendingState?.resolve(payload.chat)
      return
    }
    renderState(payload.chat)
    pendingState?.resolve(payload.chat)
  })

  const pendingSavedUserControlChecks = new Set<string>()
  const ensureSavedUserBubbleControls = () => {
    const chatId = ctx.getActiveChat().chatId
    if (!chatId) return
    for (const messageElement of hostDocument.querySelectorAll<HTMLElement>('[data-message-id]')) {
      const messageId = messageElement.dataset.messageId
      const actions = messageElement.querySelector<HTMLElement>('[data-component="BubbleActions"]')
      if (!messageId || !actions || pendingSavedUserControlChecks.has(messageId)) continue
      if (actions.querySelector('[data-chat-voice-saved-user-tts]')) continue
      const hasTtsAction = [...actions.querySelectorAll<HTMLButtonElement>('button')]
        .some(button => isExplicitTtsButton(button))
      if (hasTtsAction) continue
      pendingSavedUserControlChecks.add(messageId)
      void loadMessageForSavedAudioControl(chatId, messageId).then((message) => {
        if (!message?.is_user || !hasAnySavedAudio(message) || !messageElement.isConnected) return
        const currentActions = messageElement.querySelector<HTMLElement>('[data-component="BubbleActions"]')
        if (!currentActions || currentActions.querySelector('[data-chat-voice-saved-user-tts]')) return
        const button = hostDocument.createElement('button')
        button.type = 'button'
        button.className = currentActions.querySelector<HTMLButtonElement>('button')?.className ?? ''
        button.dataset.chatVoiceSavedUserTts = 'true'
        button.dataset.chatVoiceNativeTts = 'true'
        button.title = 'Play TTS audio'
        button.setAttribute('aria-label', 'Play TTS audio')
        button.innerHTML = PLAY_TTS_ACTION_ICON
        insertAtActionIndex(currentActions, button, preferredTtsActionIndex())
      }).catch(() => undefined).finally(() => {
        pendingSavedUserControlChecks.delete(messageId)
      })
    }
  }
  const savedUserControlObserver = new hostWindow.MutationObserver(() => ensureSavedUserBubbleControls())
  savedUserControlObserver.observe(hostDocument.body, { childList: true, subtree: true })
  ensureSavedUserBubbleControls()

  const unsubscribeChatSwitched = ctx.events.on('CHAT_SWITCHED', (rawPayload: unknown) => {
    const switchedChatId = (rawPayload as { chatId?: string | null })?.chatId ?? null
    hostWindow.requestAnimationFrame(() => {
      if (ctx.getActiveChat().chatId === switchedChatId) refreshLocalState()
    })
  })

  const unsubscribeActivate = tab.onActivate(() => {
    void loadConnections()
    void ensureQuotationRouting().catch(() => undefined)
    refreshLocalState()
  })

  void loadConnections()
  void ensureQuotationRouting().catch(() => undefined)
  refreshLocalState()

  return () => {
    stopPlayback()
    for (const controller of backgroundSynthesisControllers) controller.abort()
    backgroundSynthesisControllers.clear()
    backgroundSynthesisByMessage.clear()
    flushSave()
    if (saveTimer) clearTimeout(saveTimer)
    unsubscribeActivate()
    unsubscribeChatSwitched()
    unsubscribeBackend()
    for (const input of characterInputs.values()) input.destroy()
    for (const pending of pendingMessageRequests.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Chat Voice was closed.'))
    }
    pendingMessageRequests.clear()
    for (const pending of pendingSpeakerParseRequests.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Chat Voice was closed.'))
    }
    pendingSpeakerParseRequests.clear()
    for (const pending of pendingDecisionStatusRequests.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Chat Voice was closed.'))
    }
    pendingDecisionStatusRequests.clear()
    for (const pending of pendingLlmConnectionRequests.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Chat Voice was closed.'))
    }
    pendingLlmConnectionRequests.clear()
    for (const pending of pendingTagPlacementRequests.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Chat Voice was closed.'))
    }
    pendingTagPlacementRequests.clear()
    for (const pending of pendingStateRequests.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Chat Voice was closed.'))
    }
    pendingStateRequests.clear()
    connectionPicker.destroy()
    narratorInput.destroy()
    userVoiceInput.destroy()
    narratorDefaultToggle.removeEventListener('change', onNarratorDefaultChange)
    userDefaultToggle.removeEventListener('change', onUserDefaultChange)
    if (narratorGlobalSaveTimer) {
      clearTimeout(narratorGlobalSaveTimer)
      void saveDefaultRoleVoice('narrator', defaultNarratorVoice)
    }
    if (userGlobalSaveTimer) {
      clearTimeout(userGlobalSaveTimer)
      void saveDefaultRoleVoice('user', defaultUserVoice)
    }
    if (skippedTrackerTagsSaveTimer) {
      clearTimeout(skippedTrackerTagsSaveTimer)
      void saveSkippedTrackerTagsPreference(skippedTrackerTags)
    }
    if (llmSettingsSaveTimer) {
      clearTimeout(llmSettingsSaveTimer)
      void saveLlmParsingPreferences(speakerParsingMode)
      void saveTtsTagPreferences(ttsTagStyle, ttsTagPlacement, tagLlmConnectionId, tagLlmModel)
    }
    if (advancedSettingsSaveTimer) {
      clearTimeout(advancedSettingsSaveTimer)
      void saveAdvancedPlaybackPreferences(
        playbackBufferSegments,
        concurrentGenerationLimit,
        rateLimitWaitSeconds,
        speakerAssignmentDebug,
      )
    }
    skippedTrackerTagsInput.destroy()
    speakerParsingPicker.destroy()
    ttsTagPicker.destroy()
    ttsTagPlacementPicker.destroy()
    tagLlmConnectionPicker.destroy()
    tagLlmModelInput.destroy()
    playbackBufferInput.removeEventListener('change', onPlaybackBufferInput)
    concurrentGenerationInput.removeEventListener('change', onConcurrentGenerationInput)
    rateLimitWaitInput.removeEventListener('change', onRateLimitWaitInput)
    speakerDebugToggle.removeEventListener('change', onSpeakerDebugChanged)
    addNpcInput.destroy()
    addNpcButton.removeEventListener('click', onAddNpc)
    addNpcInputSlot.removeEventListener('keydown', onAddNpcKeyDown)
    scanButton.removeEventListener('click', scanMessages)
    saveAudioToggle.removeEventListener('change', onSaveAudioChanged)
    saveAudioLimitInput.removeEventListener('change', onSaveAudioLimitChanged)
    hostWindow.removeEventListener('contextmenu', onNativeContextMenu, true)
    hostWindow.removeEventListener('click', onNativeTtsClick, true)
    savedUserControlObserver.disconnect()
    restoreNativePlaybackButtons()
    tab.destroy()
    removeStyle()
  }
}
