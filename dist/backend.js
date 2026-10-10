// src/core.ts
var CONFIG_KEY = "chat_voice";
var DEFAULT_MESSAGE_LIMIT = 20;
var MIN_MESSAGE_LIMIT = 1;
var MAX_MESSAGE_LIMIT = 500;
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function clampMessageLimit(value) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_MESSAGE_LIMIT;
  return Math.min(MAX_MESSAGE_LIMIT, Math.max(MIN_MESSAGE_LIMIT, Math.round(numeric)));
}
function readVoiceRef(value) {
  if (!isRecord(value)) return null;
  if (typeof value.connectionId !== "string" || !value.connectionId.trim()) return null;
  return {
    connectionId: value.connectionId.trim(),
    voice: typeof value.voice === "string" ? value.voice.trim() : ""
  };
}
function readStringMap(value) {
  if (!isRecord(value)) return {};
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (key && typeof item === "string") result[key] = item.trim().slice(0, 512);
  }
  return result;
}
function readVoiceOverrides(metadata) {
  const raw = metadata.voiceOverrides;
  if (!isRecord(raw)) return {};
  const narrator = readVoiceRef(raw.narrator) ?? void 0;
  const characters = {};
  if (isRecord(raw.characters)) {
    for (const [id, value] of Object.entries(raw.characters)) {
      const ref = readVoiceRef(value);
      if (id && ref) characters[id] = ref;
    }
  }
  return {
    ...narrator ? { narrator } : {},
    ...Object.keys(characters).length > 0 ? { characters } : {}
  };
}
function readConfig(metadata, candidateCharacterIds) {
  const raw = isRecord(metadata[CONFIG_KEY]) ? metadata[CONFIG_KEY] : {};
  const overrides = readVoiceOverrides(metadata);
  const storedVoices = readStringMap(raw.characterVoices);
  const characterVoices = { ...storedVoices };
  for (const characterId of candidateCharacterIds) {
    if (!(characterId in characterVoices)) {
      characterVoices[characterId] = overrides.characters?.[characterId]?.voice ?? "";
    }
  }
  const managedCharacterIds = Array.isArray(raw.managedCharacterIds) ? raw.managedCharacterIds.filter((id) => typeof id === "string" && !!id) : Object.keys(storedVoices);
  const inferredConnection = overrides.narrator?.connectionId ?? candidateCharacterIds.map((id) => overrides.characters?.[id]?.connectionId).find((id) => !!id) ?? "";
  return {
    version: 2,
    messageLimit: clampMessageLimit(raw.messageLimit),
    connectionId: typeof raw.connectionId === "string" ? raw.connectionId.trim().slice(0, 128) : inferredConnection,
    narratorVoice: typeof raw.narratorVoice === "string" ? raw.narratorVoice.trim().slice(0, 512) : overrides.narrator?.voice ?? "",
    characterVoices,
    managedCharacterIds: [...new Set(managedCharacterIds)]
  };
}
function detectCharacters(messages, candidates, messageLimit, fallbackCharacterId) {
  const byName = /* @__PURE__ */ new Map();
  for (const character of candidates) {
    const normalizedName = character.name.trim().toLowerCase();
    if (normalizedName && !byName.has(normalizedName)) {
      byName.set(normalizedName, character);
    }
  }
  const byId = new Map(candidates.map((character) => [character.id, character]));
  const counts = /* @__PURE__ */ new Map();
  const order = [];
  const window = messages.slice(-clampMessageLimit(messageLimit));
  for (let index = window.length - 1; index >= 0; index--) {
    const message = window[index];
    if (message.is_user) continue;
    const normalizedName = message.name?.trim().toLowerCase() ?? "";
    let character = normalizedName ? byName.get(normalizedName) : void 0;
    if (!character && candidates.length === 1 && fallbackCharacterId) {
      character = byId.get(fallbackCharacterId);
    }
    if (!character) continue;
    if (!counts.has(character.id)) order.push(character.id);
    counts.set(character.id, (counts.get(character.id) ?? 0) + 1);
  }
  if (order.length === 0 && fallbackCharacterId && byId.has(fallbackCharacterId)) {
    order.push(fallbackCharacterId);
    counts.set(fallbackCharacterId, 0);
  }
  return order.map((id) => ({
    ...byId.get(id),
    messageCount: counts.get(id) ?? 0
  }));
}
function applyConfigToMetadata(metadata, config) {
  const previousOverrides = readVoiceOverrides(metadata);
  const characters = { ...previousOverrides.characters ?? {} };
  const nextManagedIds = Object.keys(config.characterVoices);
  for (const characterId of /* @__PURE__ */ new Set([...config.managedCharacterIds, ...nextManagedIds])) {
    delete characters[characterId];
  }
  if (config.connectionId) {
    for (const [characterId, voice] of Object.entries(config.characterVoices)) {
      if (voice) characters[characterId] = { connectionId: config.connectionId, voice };
    }
  }
  const voiceOverrides = {};
  if (config.connectionId && config.narratorVoice) {
    voiceOverrides.narrator = { connectionId: config.connectionId, voice: config.narratorVoice };
  }
  if (Object.keys(characters).length > 0) voiceOverrides.characters = characters;
  const storedConfig = {
    ...config,
    managedCharacterIds: [...new Set(nextManagedIds)]
  };
  const result = { ...metadata, [CONFIG_KEY]: storedConfig };
  if (voiceOverrides.narrator || voiceOverrides.characters) result.voiceOverrides = voiceOverrides;
  else delete result.voiceOverrides;
  return result;
}

// src/backend.ts
function chatMemberIds(chat) {
  const rawIds = chat.metadata?.character_ids;
  if (chat.metadata?.group === true && Array.isArray(rawIds)) {
    return [...new Set(rawIds.filter((id) => typeof id === "string" && !!id))];
  }
  return chat.character_id ? [chat.character_id] : [];
}
async function loadCharacters(chat, userId) {
  const results = await Promise.all(
    chatMemberIds(chat).map((id) => spindle.characters.get(id, userId))
  );
  return results.filter((character) => !!character).map((character) => ({ id: character.id, name: character.name }));
}
async function buildState(chat, userId) {
  const metadata = chat.metadata ?? {};
  const candidates = await loadCharacters(chat, userId);
  const initialConfig = readConfig(metadata, candidates.map((character) => character.id));
  const messages = await spindle.chat.getMessages(chat.id);
  const detected = detectCharacters(
    messages,
    candidates,
    initialConfig.messageLimit,
    chat.metadata?.group === true ? null : chat.character_id
  );
  const config = readConfig(metadata, detected.map((character) => character.id));
  return {
    id: chat.id,
    name: chat.name,
    messageLimit: config.messageLimit,
    connectionId: config.connectionId,
    narratorVoice: config.narratorVoice,
    characters: detected.map((character) => ({
      ...character,
      voice: config.characterVoices[character.id] ?? ""
    }))
  };
}
async function sendState(userId, clientRevision) {
  try {
    const chat = await spindle.chats.getActive(userId);
    spindle.sendToFrontend({
      type: "chat_voice_state",
      chat: chat ? await buildState(chat, userId) : null,
      ...clientRevision !== void 0 ? { clientRevision } : {}
    }, userId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load chat voice settings.";
    spindle.sendToFrontend({ type: "chat_voice_error", error: message }, userId);
  }
}
function sanitizeSaveConfig(previous, input) {
  const characterVoices = { ...previous.characterVoices };
  if (input.characterVoices && typeof input.characterVoices === "object") {
    for (const [id, voice] of Object.entries(input.characterVoices)) {
      if (!id || typeof voice !== "string") continue;
      characterVoices[id] = voice.trim().slice(0, 512);
    }
  }
  return {
    version: 2,
    messageLimit: clampMessageLimit(input.messageLimit),
    connectionId: typeof input.connectionId === "string" ? input.connectionId.trim().slice(0, 128) : "",
    narratorVoice: typeof input.narratorVoice === "string" ? input.narratorVoice.trim().slice(0, 512) : "",
    characterVoices,
    managedCharacterIds: previous.managedCharacterIds
  };
}
var saveQueues = /* @__PURE__ */ new Map();
function queueSave(payload, userId) {
  const queueKey = `${userId ?? "user"}:${payload.chatId}`;
  const previousTask = saveQueues.get(queueKey) ?? Promise.resolve();
  const nextTask = previousTask.catch(() => void 0).then(async () => {
    const chat = await spindle.chats.get(payload.chatId, userId);
    if (!chat) throw new Error("The chat is no longer available.");
    const candidateIds = chatMemberIds(chat);
    const previousConfig = readConfig(chat.metadata ?? {}, candidateIds);
    const config = sanitizeSaveConfig(previousConfig, payload.config);
    const metadata = applyConfigToMetadata(chat.metadata ?? {}, config);
    await spindle.chats.update(chat.id, { metadata }, userId);
    const active = await spindle.chats.getActive(userId);
    if (active?.id === chat.id) await sendState(userId, payload.clientRevision);
  }).finally(() => {
    if (saveQueues.get(queueKey) === nextTask) saveQueues.delete(queueKey);
  });
  saveQueues.set(queueKey, nextTask);
  return nextTask;
}
spindle.onFrontendMessage(async (rawPayload, userId) => {
  const payload = rawPayload;
  try {
    if (payload?.type === "chat_voice_refresh") {
      await sendState(userId);
    } else if (payload?.type === "chat_voice_save") {
      await queueSave(payload, userId);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not save chat voice settings.";
    spindle.sendToFrontend({
      type: "chat_voice_error",
      error: message,
      clientRevision: payload?.type === "chat_voice_save" ? payload.clientRevision : void 0
    }, userId);
  }
});
var refreshTimers = /* @__PURE__ */ new Map();
function scheduleStateRefresh(userId) {
  const key = userId ?? "user";
  const existing = refreshTimers.get(key);
  if (existing) clearTimeout(existing);
  refreshTimers.set(key, setTimeout(() => {
    refreshTimers.delete(key);
    void sendState(userId);
  }, 150));
}
spindle.on("CHAT_SWITCHED", async (_payload, userId) => {
  await sendState(userId);
});
for (const event of ["MESSAGE_SENT", "MESSAGE_EDITED", "MESSAGE_SWIPED", "MESSAGE_DELETED"]) {
  spindle.on(event, (_payload, userId) => scheduleStateRefresh(userId));
}
spindle.log.info("Chat Voice 2.0 loaded.");
