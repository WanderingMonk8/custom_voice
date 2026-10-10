import type {
  SpindleFrontendContext,
  SpindleTextInputHandle,
} from 'lumiverse-spindle-types'
import {
  mergeVoicePlan,
  npcSpeakerId,
  normalizeSpeakerName,
  parseRosterVoiceSegments,
} from './core'

interface TtsConnection {
  id: string
  name: string
  provider?: string
}

interface ConnectionPage {
  data?: TtsConnection[]
  total?: number
}

interface SynthesisPacer {
  nextStartAt: number
  startQueue: Promise<void>
}

const MIN_SYNTHESIS_START_INTERVAL_MS = 1_250
const MAX_RATE_LIMIT_RETRIES = 3
const PLAYBACK_BUFFER_SEGMENTS = 2

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
  characters: DetectedCharacterState[]
}

interface StatePayload {
  type: 'chat_voice_state'
  chat: ActiveChatState | null
  clientRevision?: number
}

interface ErrorPayload {
  type: 'chat_voice_error'
  error: string
  clientRevision?: number
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
}

interface PlaybackPreferences {
  speed: number
  volume: number
}

const VOICE_ICON = `
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M5 10v4M9 7v10M13 4v16M17 8v8M21 10v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  </svg>
`

const STOP_ACTION_ICON = `<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>`

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
  if (!response.ok) return { speed: 1, volume: 1 }
  const row = await response.json() as { value?: Record<string, unknown> }
  const speed = typeof row.value?.ttsSpeed === 'number' ? row.value.ttsSpeed : 1
  const volume = typeof row.value?.ttsVolume === 'number' ? row.value.ttsVolume : 1
  return {
    speed: Math.min(4, Math.max(0.25, speed)),
    volume: Math.min(1, Math.max(0, volume)),
  }
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

async function waitForSynthesisSlot(pacer: SynthesisPacer, signal: AbortSignal): Promise<void> {
  const turn = pacer.startQueue.then(async () => {
    while (true) {
      await abortableDelay(Math.max(0, pacer.nextStartAt - Date.now()), signal)
      if (Date.now() < pacer.nextStartAt) continue
      pacer.nextStartAt = Date.now() + MIN_SYNTHESIS_START_INTERVAL_MS
      return
    }
  })
  pacer.startQueue = turn.catch(() => undefined)
  await turn
}

async function synthesizeVoiceSegment(
  connectionId: string,
  text: string,
  voice: string,
  speed: number,
  signal: AbortSignal,
  pacer: SynthesisPacer,
  onRateLimit: (delayMs: number, retry: number) => void,
): Promise<SynthesizedVoiceSegment> {
  for (let attempt = 0; ; attempt += 1) {
    await waitForSynthesisSlot(pacer, signal)
    const response = await fetch('/api/v1/tts/synthesize', {
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
    if (response.ok) {
      return {
        data: await response.arrayBuffer(),
        mime: response.headers.get('content-type') || 'audio/mpeg',
      }
    }
    if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      const retryDelay = retryAfterMilliseconds(response.headers.get('Retry-After'))
        ?? Math.min(15_000, 2_000 * (2 ** attempt))
      pacer.nextStartAt = Math.max(pacer.nextStartAt, Date.now() + retryDelay)
      onRateLimit(retryDelay, attempt + 1)
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
): Promise<void> {
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
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null
    throw new Error(body?.error || `Could not save generated audio (${response.status}).`)
  }
}

/** Force the host TTS parser to route only quoted text to character voices. */
async function ensureQuotationRouting(): Promise<void> {
  const response = await fetch('/api/v1/settings/voiceSettings', {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) return
  const row = await response.json() as { value?: Record<string, unknown> }
  const current = row.value && typeof row.value === 'object' ? row.value : {}
  const currentRules = current.speechDetectionRules && typeof current.speechDetectionRules === 'object'
    ? current.speechDetectionRules as Record<string, unknown>
    : {}
  const alreadyConfigured = currentRules.quoted === 'speech'
    && currentRules.undecorated === 'narration'
    && currentRules.asterisked === 'narration'
  if (alreadyConfigured) return

  await fetch('/api/v1/settings/voiceSettings', {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      value: {
        ...current,
        speechDetectionRules: {
          ...currentRules,
          quoted: 'speech',
          undecorated: 'narration',
          asterisked: 'narration',
        },
      },
    }),
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
    .chat-voice-add-button, .chat-voice-delete-button {
      border:1px solid var(--lumiverse-border); border-radius:6px; background:var(--lumiverse-fill-subtle);
      color:var(--lumiverse-text); font:inherit; cursor:pointer;
    }
    .chat-voice-add-button { min-width:58px; padding:0 12px; font-size:12px; font-weight:600; }
    .chat-voice-delete-button { width:24px; height:24px; padding:0; font-size:16px; line-height:1; }
    .chat-voice-add-button:disabled, .chat-voice-delete-button:disabled { opacity:.5; cursor:not-allowed; }
    .chat-voice-status { min-height:18px; }
    .chat-voice-status[data-state="saved"] { color:var(--lumiverse-success, #65b97a); }
    .chat-voice-status[data-state="error"] { color:var(--lumiverse-danger, #ef6464); }
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
    return { field, slot }
  }

  const connectionField = createField('TTS connection')
  const scanField = createField('Character card cast')
  const scanRow = scanField.slot
  scanRow.className = 'chat-voice-scan-row'
  const scanButton = document.createElement('button')
  scanButton.type = 'button'
  scanButton.className = 'chat-voice-scan-button'
  scanButton.textContent = 'Scan'
  scanButton.disabled = true
  scanRow.append(scanButton)
  const narratorField = createField('Narrator voice')
  const routingHint = document.createElement('div')
  routingHint.className = 'chat-voice-hint'
  routingHint.textContent = 'Scan reads the character card, not chat history. During playback, quoted dialogue is matched to the saved cast using names and dialogue tags; everything outside quotes uses the narrator voice.'
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

  panel.append(
    context,
    connectionField.field,
    scanField.field,
    narratorField.field,
    routingHint,
    addNpcField.field,
    characterTitle,
    characterList,
    status,
  )
  tab.root.appendChild(panel)

  let applyingState = false
  let activeChat: ActiveChatState | null = null
  let connections: TtsConnection[] = []
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let editRevision = 0
  let dirty = false
  let scanning = false
  let activePlayback: {
    messageId: string
    controller: AbortController
    context: AudioContext
    source: AudioBufferSourceNode | null
  } | null = null
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
  let messageRequestSequence = 0

  const setStatus = (message: string, state: 'normal' | 'saved' | 'error' = 'normal') => {
    status.textContent = message
    status.dataset.state = state
  }

  function nativeTtsMessageId(button: HTMLButtonElement): string | null {
    if (button.closest('[data-spindle-extension-root]')) return null
    const known = button.dataset.chatVoiceNativeTts === 'true'
    const label = [
      button.getAttribute('title'),
      button.getAttribute('aria-label'),
      button.textContent,
    ].filter(Boolean).join(' ').toLowerCase()
    const iconClass = button.querySelector('svg')?.getAttribute('class')?.toLowerCase() ?? ''
    const hasNativeTtsIcon = iconClass.includes('volume-2')
      || iconClass.includes('volume2')
      || iconClass.includes('volume-high')
    const hasNativeTtsLabel = /\btts\b|text[ -]to[ -]speech|stop playback|regenerate.+audio/.test(label)
    const bubbleActions = button.closest('[data-component="BubbleActions"]')
    const bubbleButtons = bubbleActions
      ? [...bubbleActions.children].filter((child): child is HTMLButtonElement => child.tagName === 'BUTTON')
      : []
    const isBubbleTtsPosition = bubbleButtons.length >= 3 && bubbleButtons[2] === button
    if (!known && !hasNativeTtsIcon && !hasNativeTtsLabel && !isBubbleTtsPosition) return null

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
    onChange: () => markChanged(),
  })

  const addNpcInput = ctx.components.mountTextInput(addNpcInputSlot, {
    value: '', placeholder: 'NPC name', ariaLabel: 'NPC name to add', disabled: true,
    onChange: () => undefined,
  })

  function collectConfig() {
    return {
      messageLimit: activeChat?.messageLimit ?? 20,
      connectionId: connectionPicker.getValue(),
      narratorVoice: narratorInput.getValue(),
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
      config: collectConfig(),
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

  function stopPlayback() {
    const playback = activePlayback
    activePlayback = null
    if (!playback) return
    playback.controller.abort()
    try { playback.source?.stop() } catch { /* already stopped */ }
    void playback.context.close().catch(() => undefined)
    updatePlaybackButtons()
  }

  async function playDecodedBuffer(
    playback: NonNullable<typeof activePlayback>,
    data: ArrayBuffer,
    volume: number,
  ): Promise<void> {
    if (playback.controller.signal.aborted) throw new DOMException('Playback stopped.', 'AbortError')
    const buffer = await playback.context.decodeAudioData(data.slice(0))
    if (playback.controller.signal.aborted) throw new DOMException('Playback stopped.', 'AbortError')
    await new Promise<void>((resolve, reject) => {
      const source = playback.context.createBufferSource()
      const gain = playback.context.createGain()
      gain.gain.value = volume
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
  }

  async function playMessage(messageId: string): Promise<void> {
    if (activePlayback) {
      const wasSameMessage = activePlayback.messageId === messageId
      stopPlayback()
      if (wasSameMessage) {
        setStatus('Playback stopped.')
        return
      }
    }
    if (!activeChat) return
    const playbackChat = activeChat
    const config = collectConfig()
    if (!config.connectionId) {
      setStatus('Choose a TTS connection before playing.', 'error')
      return
    }
    const contextClass = window.AudioContext
      ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!contextClass) {
      setStatus('Web Audio is unavailable in this browser.', 'error')
      return
    }
    const audioContext = new contextClass()
    await audioContext.resume()
    const playback = {
      messageId,
      controller: new AbortController(),
      context: audioContext,
      source: null as AudioBufferSourceNode | null,
    }
    activePlayback = playback
    updatePlaybackButtons()

    try {
      const message = await requestPlaybackMessage(playbackChat.id, messageId)
      if (message.is_user) throw new Error('Custom voice playback is only available for character messages.')
      const explicitId = typeof message.extra?.character_id === 'string' ? message.extra.character_id : ''
      const defaultSpeakerId = explicitId || playbackChat.characters.find((character) => (
        !character.id.startsWith('npc:')
        && normalizeSpeakerName(character.name).toLowerCase()
          === normalizeSpeakerName(message.name).toLowerCase()
      ))?.id || null
      const aliases = new Map(
        playbackChat.characters.map((character) => [npcSpeakerId(character.name), character.id] as const),
      )
      const segments = parseRosterVoiceSegments(message.content, defaultSpeakerId, playbackChat.characters)
      const plan = mergeVoicePlan(segments.map((segment) => {
        const speakerId = segment.speakerId
          ? aliases.get(segment.speakerId) ?? segment.speakerId
          : null
        const voice = speakerId
          ? config.characterVoices[speakerId] || (defaultSpeakerId ? config.characterVoices[defaultSpeakerId] : '') || ''
          : config.narratorVoice
        return { text: segment.text, voice }
      }))
      if (plan.length === 0) throw new Error('This message has no playable narration or dialogue.')

      const preferences = await loadPlaybackPreferences()
      const pacer: SynthesisPacer = { nextStartAt: 0, startQueue: Promise.resolve() }
      type PreparedSegment = { segment: SynthesizedVoiceSegment; error?: never } | { segment?: never; error: unknown }
      const prepare = async (index: number): Promise<PreparedSegment> => {
        try {
          const segment = await synthesizeVoiceSegment(
            config.connectionId,
            plan[index].text,
            plan[index].voice,
            preferences.speed,
            playback.controller.signal,
            pacer,
            (delayMs, retry) => setStatus(
              `Rate limited; retry ${retry} in ${Math.max(1, Math.ceil(delayMs / 1_000))}s…`,
            ),
          )
          return { segment }
        } catch (error) {
          return { error }
        }
      }

      const prepared = new Map<number, Promise<PreparedSegment>>()
      const schedule = (index: number) => {
        if (index < plan.length && !prepared.has(index)) prepared.set(index, prepare(index))
      }
      const initialBufferSize = Math.min(PLAYBACK_BUFFER_SEGMENTS, plan.length)
      for (let index = 0; index < initialBufferSize; index += 1) schedule(index)
      setStatus(
        `Buffering ${initialBufferSize} voice segment${initialBufferSize === 1 ? '' : 's'} before playback…`,
      )
      await Promise.all(prepared.values())

      const captured = new Array<SynthesizedVoiceSegment>(plan.length)
      for (let index = 0; index < plan.length; index += 1) {
        const current = await prepared.get(index)!
        prepared.delete(index)
        if ('error' in current) throw current.error
        captured[index] = current.segment
        schedule(index + PLAYBACK_BUFFER_SEGMENTS)
        setStatus(`Playing ${index + 1} of ${plan.length} voice segment${plan.length === 1 ? '' : 's'}…`)
        await playDecodedBuffer(playback, current.segment.data, preferences.volume)
      }
      setStatus('Saving generated audio…')
      await saveMessageAudio(
        playbackChat.id,
        messageId,
        message.swipe_id,
        captured,
        playback.controller.signal,
      )
      setStatus('Playback complete and audio saved.', 'saved')
    } catch (error) {
      if ((error as { name?: string })?.name !== 'AbortError') {
        setStatus(error instanceof Error ? error.message : 'Custom voice playback failed.', 'error')
      }
    } finally {
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
    const name = normalizeSpeakerName(addNpcInput.getValue()).slice(0, 128)
    if (!name) {
      setStatus('Enter an NPC name first.', 'error')
      return
    }
    const id = npcSpeakerId(name)
    if (activeChat.characters.some((character) => character.id === id)) {
      setStatus(`${name} is already in this chat's voice roster.`, 'error')
      return
    }
    activeChat = {
      ...activeChat,
      characters: [...activeChat.characters, { id, name, messageCount: 0, voice: '' }],
    }
    addNpcInput.update({ value: '' })
    renderCharacters(activeChat.characters)
    markChanged(0)
  }

  function removeNpc(characterId: string) {
    if (!activeChat || !characterId.startsWith('npc:')) return
    activeChat = {
      ...activeChat,
      characters: activeChat.characters.filter((character) => character.id !== characterId),
    }
    renderCharacters(activeChat.characters)
    markChanged(0)
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
      if (character.id.startsWith('npc:')) {
        const remove = document.createElement('button')
        remove.type = 'button'
        remove.className = 'chat-voice-delete-button'
        remove.textContent = '×'
        remove.title = `Delete ${character.name}`
        remove.setAttribute('aria-label', remove.title)
        remove.disabled = !activeChat
        remove.addEventListener('click', () => removeNpc(character.id))
        meta.append(remove)
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
    connectionPicker.update({
      value: next?.connectionId ?? '',
      options: connectionOptions(next?.connectionId),
      placeholder: connections.length ? 'Choose a TTS connection' : 'No TTS connections found',
      disabled: !next || connections.length === 0,
    })
    scanButton.disabled = !next || scanning
    narratorInput.update({ value: next?.narratorVoice ?? '', disabled: !next })
    addNpcInput.update({ value: '', disabled: !next })
    addNpcButton.disabled = !next
    renderCharacters(next?.characters ?? [])
    applyingState = false
    if (!next) setStatus('Open a chat to edit its voices.')
    else if (connections.length === 0) setStatus('Create a TTS connection in Lumiverse first.')
    else setStatus('All changes save automatically.', 'saved')
  }

  async function loadConnections() {
    try {
      connections = await listAllTtsConnections()
      connectionPicker.update({
        options: connectionOptions(activeChat?.connectionId),
        placeholder: connections.length ? 'Choose a TTS connection' : 'No TTS connections found',
        disabled: !activeChat || connections.length === 0,
      })
      if (connections.length === 0) setStatus('Create a TTS connection in Lumiverse first.')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not load TTS connections.'
      connectionPicker.update({ placeholder: 'Connections unavailable', disabled: true })
      setStatus(message, 'error')
    }
  }

  const onNativeContextMenu = (event: MouseEvent) => {
    const target = event.target && typeof (event.target as Element).closest === 'function'
      ? event.target as Element
      : null
    lastContextMessageId = target?.closest<HTMLElement>('[data-message-id]')?.dataset.messageId ?? null
    hostWindow.requestAnimationFrame(updatePlaybackButtons)
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
    void playMessage(messageId)
  }

  hostWindow.addEventListener('contextmenu', onNativeContextMenu, true)
  hostWindow.addEventListener('click', onNativeTtsClick, true)
  hostWindow.requestAnimationFrame(updatePlaybackButtons)

  const unsubscribeBackend = ctx.onBackendMessage((rawPayload: unknown) => {
    const payload = rawPayload as StatePayload | ErrorPayload | ScanCompletePayload | MessagePayload
    if (payload.type === 'chat_voice_message') {
      const pending = pendingMessageRequests.get(payload.requestId)
      if (!pending) return
      clearTimeout(pending.timer)
      pendingMessageRequests.delete(payload.requestId)
      if (payload.error || !payload.message) pending.reject(new Error(payload.error || 'The message is unavailable.'))
      else pending.resolve(payload.message)
      return
    }
    if (payload.type === 'chat_voice_error') {
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
    const currentChatId = activeChat?.id ?? null
    if (incomingChatId !== currentChatId) {
      for (const pending of pendingMessageRequests.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error('The active chat changed before playback started.'))
      }
      pendingMessageRequests.clear()
      flushSave()
      dirty = false
      inFlight.clear()
      scanning = false
      scanButton.textContent = 'Scan'
      renderState(payload.chat)
      return
    }

    if (payload.clientRevision !== undefined) {
      inFlight.delete(payload.clientRevision)
      if (payload.clientRevision !== editRevision || dirty) return
      renderState(payload.chat)
      setStatus('Saved.', 'saved')
      return
    }

    if (dirty || inFlight.size > 0) return
    renderState(payload.chat)
  })

  const unsubscribeActivate = tab.onActivate(() => {
    void loadConnections()
    void ensureQuotationRouting().catch(() => undefined)
    ctx.sendToBackend({ type: 'chat_voice_refresh' })
  })

  void loadConnections()
  void ensureQuotationRouting().catch(() => undefined)
  ctx.sendToBackend({ type: 'chat_voice_refresh' })

  return () => {
    stopPlayback()
    flushSave()
    if (saveTimer) clearTimeout(saveTimer)
    unsubscribeActivate()
    unsubscribeBackend()
    for (const input of characterInputs.values()) input.destroy()
    for (const pending of pendingMessageRequests.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Chat Voice was closed.'))
    }
    pendingMessageRequests.clear()
    connectionPicker.destroy()
    narratorInput.destroy()
    addNpcInput.destroy()
    addNpcButton.removeEventListener('click', onAddNpc)
    addNpcInputSlot.removeEventListener('keydown', onAddNpcKeyDown)
    scanButton.removeEventListener('click', scanMessages)
    hostWindow.removeEventListener('contextmenu', onNativeContextMenu, true)
    hostWindow.removeEventListener('click', onNativeTtsClick, true)
    restoreNativePlaybackButtons()
    tab.destroy()
    removeStyle()
  }
}
