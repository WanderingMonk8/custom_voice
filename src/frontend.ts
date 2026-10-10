import type {
  SpindleFrontendContext,
  SpindleTextInputHandle,
} from 'lumiverse-spindle-types'

interface TtsConnection {
  id: string
  name: string
  provider?: string
}

interface ConnectionPage {
  data?: TtsConnection[]
  total?: number
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

const VOICE_ICON = `
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M5 10v4M9 7v10M13 4v16M17 8v8M21 10v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  </svg>
`

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
    .chat-voice-character-name { color:var(--lumiverse-text); font-size:12px; font-weight:600; }
    .chat-voice-character-count { color:var(--lumiverse-text-muted); font-size:11px; white-space:nowrap; }
    .chat-voice-empty {
      padding:12px; text-align:center; color:var(--lumiverse-text-muted); font-size:12px;
      border:1px dashed var(--lumiverse-border); border-radius:var(--lumiverse-radius);
    }
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
  const messageLimitField = createField('Messages to scan')
  const narratorField = createField('Narrator voice')
  const routingHint = document.createElement('div')
  routingHint.className = 'chat-voice-hint'
  routingHint.textContent = 'Text inside quotation marks uses the speaking character’s voice. Everything outside quotation marks uses the narrator voice.'
  const characterTitle = document.createElement('div')
  characterTitle.className = 'chat-voice-section-title'
  characterTitle.textContent = 'Detected characters'
  const characterList = document.createElement('div')
  characterList.className = 'chat-voice-character-list'
  const status = document.createElement('div')
  status.className = 'chat-voice-status'
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')

  panel.append(
    context,
    connectionField.field,
    messageLimitField.field,
    narratorField.field,
    routingHint,
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
  const inFlight = new Set<number>()
  const characterInputs = new Map<string, SpindleTextInputHandle>()

  const setStatus = (message: string, state: 'normal' | 'saved' | 'error' = 'normal') => {
    status.textContent = message
    status.dataset.state = state
  }

  const connectionPicker = ctx.components.mountSelect(connectionField.slot, {
    value: '', options: [], placeholder: 'Loading connections…',
    searchPlaceholder: 'Search TTS connections…', emptyMessage: 'No TTS connections found.',
    clearable: true, clearLabel: 'Disable custom chat voices', ariaLabel: 'TTS connection',
    disabled: true,
    onChange: () => markChanged(),
  })

  const messageLimitInput = ctx.components.mountNumericInput(messageLimitField.slot, {
    value: 20, min: 1, max: 500, step: 1, integer: true,
    ariaLabel: 'Number of recent messages to scan', disabled: true,
    onChange: () => markChanged(500),
  })

  const narratorInput = ctx.components.mountTextInput(narratorField.slot, {
    value: '', placeholder: 'Enter the narrator voice name or ID',
    ariaLabel: 'Narrator voice', disabled: true,
    onChange: () => markChanged(),
  })

  function collectConfig() {
    return {
      messageLimit: messageLimitInput.getValue() ?? 20,
      connectionId: connectionPicker.getValue(),
      narratorVoice: narratorInput.getValue(),
      characterVoices: Object.fromEntries(
        [...characterInputs.entries()].map(([id, input]) => [id, input.getValue()]),
      ),
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

  function renderCharacters(characters: DetectedCharacterState[]) {
    for (const input of characterInputs.values()) input.destroy()
    characterInputs.clear()
    characterList.replaceChildren()
    if (characters.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'chat-voice-empty'
      empty.textContent = 'No character speakers were found in the selected message window.'
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
      count.textContent = `${character.messageCount} message${character.messageCount === 1 ? '' : 's'}`
      const slot = document.createElement('div')
      heading.append(name, count)
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
    messageLimitInput.update({ value: next?.messageLimit ?? 20, disabled: !next })
    narratorInput.update({ value: next?.narratorVoice ?? '', disabled: !next })
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

  const unsubscribeBackend = ctx.onBackendMessage((rawPayload: unknown) => {
    const payload = rawPayload as StatePayload | ErrorPayload
    if (payload.type === 'chat_voice_error') {
      if (payload.clientRevision !== undefined) inFlight.delete(payload.clientRevision)
      setStatus(payload.error || 'Could not save chat voice settings.', 'error')
      return
    }
    if (payload.type !== 'chat_voice_state') return

    const incomingChatId = payload.chat?.id ?? null
    const currentChatId = activeChat?.id ?? null
    if (incomingChatId !== currentChatId) {
      flushSave()
      dirty = false
      inFlight.clear()
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
    flushSave()
    if (saveTimer) clearTimeout(saveTimer)
    unsubscribeActivate()
    unsubscribeBackend()
    for (const input of characterInputs.values()) input.destroy()
    connectionPicker.destroy()
    messageLimitInput.destroy()
    narratorInput.destroy()
    tab.destroy()
    removeStyle()
  }
}
