import {
  applyConfigToMetadata,
  clampMessageLimit,
  detectCharacters,
  readConfig,
  type CharacterLike,
  type ChatVoiceConfig,
} from './core'

declare const spindle: import('lumiverse-spindle-types').SpindleAPI

interface ChatLike {
  id: string
  name: string
  character_id: string | null
  metadata?: Record<string, unknown>
}

type FrontendMessage =
  | { type: 'chat_voice_refresh' }
  | { type: 'chat_voice_scan'; chatId: string; messageLimit: number }
  | {
      type: 'chat_voice_save'
      chatId: string
      clientRevision: number
      config: {
        messageLimit: number
        connectionId: string
        narratorVoice: string
        characterVoices: Record<string, string>
      }
    }

function chatMemberIds(chat: ChatLike): string[] {
  const rawIds = chat.metadata?.character_ids
  if (chat.metadata?.group === true && Array.isArray(rawIds)) {
    return [...new Set(rawIds.filter((id): id is string => typeof id === 'string' && !!id))]
  }
  return chat.character_id ? [chat.character_id] : []
}

async function loadCharacters(chat: ChatLike, userId?: string): Promise<CharacterLike[]> {
  const results = await Promise.all(
    chatMemberIds(chat).map((id) => spindle.characters.get(id, userId)),
  )
  return results
    .filter((character): character is NonNullable<typeof character> => !!character)
    .map((character) => ({ id: character.id, name: character.name }))
}

async function buildState(chat: ChatLike, userId?: string) {
  const metadata = chat.metadata ?? {}
  const candidates = await loadCharacters(chat, userId)
  const config = readConfig(metadata, candidates.map((character) => character.id))
  const candidatesById = new Map(candidates.map((character) => [character.id, character] as const))
  const detected = config.detectedCharacters.flatMap(({ id, name, messageCount }) => {
    const character = candidatesById.get(id)
    const savedName = name || (id.startsWith('npc:') ? id.slice(4) : '')
    return character
      ? [{ ...character, messageCount }]
      : savedName ? [{ id, name: savedName, messageCount }] : []
  })

  return {
    id: chat.id,
    name: chat.name,
    messageLimit: config.messageLimit,
    connectionId: config.connectionId,
    narratorVoice: config.narratorVoice,
    characters: detected.map((character) => ({
      ...character,
      voice: config.characterVoices[character.id] ?? '',
    })),
  }
}

async function sendState(userId?: string, clientRevision?: number): Promise<void> {
  try {
    const chat = await spindle.chats.getActive(userId) as ChatLike | null
    spindle.sendToFrontend({
      type: 'chat_voice_state',
      chat: chat ? await buildState(chat, userId) : null,
      ...(clientRevision !== undefined ? { clientRevision } : {}),
    }, userId)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not load chat voice settings.'
    spindle.sendToFrontend({ type: 'chat_voice_error', error: message }, userId)
  }
}

function sanitizeSaveConfig(
  previous: ChatVoiceConfig,
  input: Extract<FrontendMessage, { type: 'chat_voice_save' }>['config'],
): ChatVoiceConfig {
  const characterVoices = { ...previous.characterVoices }
  if (input.characterVoices && typeof input.characterVoices === 'object') {
    for (const [id, voice] of Object.entries(input.characterVoices)) {
      if (!id || typeof voice !== 'string') continue
      characterVoices[id] = voice.trim().slice(0, 512)
    }
  }
  return {
    version: 4,
    messageLimit: clampMessageLimit(input.messageLimit),
    connectionId: typeof input.connectionId === 'string'
      ? input.connectionId.trim().slice(0, 128)
      : '',
    narratorVoice: typeof input.narratorVoice === 'string'
      ? input.narratorVoice.trim().slice(0, 512)
      : '',
    characterVoices,
    detectedCharacters: previous.detectedCharacters,
    managedCharacterIds: previous.managedCharacterIds,
  }
}

const saveQueues = new Map<string, Promise<void>>()

function queueSave(
  payload: Extract<FrontendMessage, { type: 'chat_voice_save' }>,
  userId?: string,
): Promise<void> {
  const queueKey = `${userId ?? 'user'}:${payload.chatId}`
  const previousTask = saveQueues.get(queueKey) ?? Promise.resolve()
  const nextTask = previousTask.catch(() => undefined).then(async () => {
    const chat = await spindle.chats.get(payload.chatId, userId) as ChatLike | null
    if (!chat) throw new Error('The chat is no longer available.')
    const candidateIds = chatMemberIds(chat)
    const previousConfig = readConfig(chat.metadata ?? {}, candidateIds)
    const config = sanitizeSaveConfig(previousConfig, payload.config)
    const metadata = applyConfigToMetadata(chat.metadata ?? {}, config)
    await spindle.chats.update(chat.id, { metadata }, userId)

    const active = await spindle.chats.getActive(userId) as ChatLike | null
    if (active?.id === chat.id) await sendState(userId, payload.clientRevision)
  }).finally(() => {
    if (saveQueues.get(queueKey) === nextTask) saveQueues.delete(queueKey)
  })
  saveQueues.set(queueKey, nextTask)
  return nextTask
}

function queueScan(
  payload: Extract<FrontendMessage, { type: 'chat_voice_scan' }>,
  userId?: string,
): Promise<void> {
  const queueKey = `${userId ?? 'user'}:${payload.chatId}`
  const previousTask = saveQueues.get(queueKey) ?? Promise.resolve()
  const nextTask = previousTask.catch(() => undefined).then(async () => {
    const chat = await spindle.chats.get(payload.chatId, userId) as ChatLike | null
    if (!chat) throw new Error('The chat is no longer available.')
    const candidates = await loadCharacters(chat, userId)
    const messageLimit = clampMessageLimit(payload.messageLimit)
    const messages = await spindle.chat.getMessages(chat.id)
    const detected = detectCharacters(
      messages,
      candidates,
      messageLimit,
      chat.metadata?.group === true ? null : chat.character_id,
    )
    const config = readConfig(chat.metadata ?? {}, candidates.map((character) => character.id))
    const nextConfig: ChatVoiceConfig = {
      ...config,
      version: 4,
      messageLimit,
      detectedCharacters: detected.map(({ id, name, messageCount }) => ({ id, name, messageCount })),
    }
    const metadata = applyConfigToMetadata(chat.metadata ?? {}, nextConfig)
    await spindle.chats.update(chat.id, { metadata }, userId)

    const active = await spindle.chats.getActive(userId) as ChatLike | null
    if (active?.id === chat.id) {
      await sendState(userId)
      spindle.sendToFrontend({ type: 'chat_voice_scan_complete', chatId: chat.id }, userId)
    }
  }).finally(() => {
    if (saveQueues.get(queueKey) === nextTask) saveQueues.delete(queueKey)
  })
  saveQueues.set(queueKey, nextTask)
  return nextTask
}

spindle.onFrontendMessage(async (rawPayload: unknown, userId) => {
  const payload = rawPayload as FrontendMessage
  try {
    if (payload?.type === 'chat_voice_refresh') {
      await sendState(userId)
    } else if (payload?.type === 'chat_voice_scan') {
      await queueScan(payload, userId)
    } else if (payload?.type === 'chat_voice_save') {
      await queueSave(payload, userId)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not save chat voice settings.'
    spindle.sendToFrontend({
      type: 'chat_voice_error',
      error: message,
      clientRevision: payload?.type === 'chat_voice_save' ? payload.clientRevision : undefined,
    }, userId)
  }
})

spindle.on('CHAT_SWITCHED', async (_payload, userId) => {
  await sendState(userId)
})

spindle.log.info('Chat Voice 3.0 loaded.')
