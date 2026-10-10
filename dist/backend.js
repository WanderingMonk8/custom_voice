// src/backend.ts
function readVoiceRef(value) {
  if (!value || typeof value !== "object") return null;
  const candidate = value;
  if (typeof candidate.connectionId !== "string" || !candidate.connectionId) return null;
  return {
    connectionId: candidate.connectionId,
    voice: typeof candidate.voice === "string" ? candidate.voice : ""
  };
}
function targetCharacterIds(chat) {
  const rawIds = chat.metadata?.character_ids;
  if (chat.metadata?.group === true && Array.isArray(rawIds)) {
    const ids = rawIds.filter((id) => typeof id === "string" && id.length > 0);
    if (ids.length > 0) return [...new Set(ids)];
  }
  return chat.character_id ? [chat.character_id] : [];
}
function currentVoice(chat) {
  const raw = chat.metadata?.voiceOverrides;
  const overrides = raw && typeof raw === "object" ? raw : {};
  const refs = [];
  const narrator = readVoiceRef(overrides.narrator);
  if (narrator) refs.push(narrator);
  for (const characterId of targetCharacterIds(chat)) {
    const ref = readVoiceRef(overrides.characters?.[characterId]);
    if (ref) refs.push(ref);
  }
  if (refs.length === 0) return { connectionId: "", voice: "", mixed: false };
  const first = refs[0];
  const mixed = refs.some(
    (ref) => ref.connectionId !== first.connectionId || ref.voice !== first.voice
  );
  return { connectionId: first.connectionId, voice: first.voice, mixed };
}
async function sendState(userId) {
  const chat = await spindle.chats.getActive(userId);
  if (!chat) {
    spindle.sendToFrontend({ type: "chat_voice_state", chat: null }, userId);
    return;
  }
  spindle.sendToFrontend({
    type: "chat_voice_state",
    chat: {
      id: chat.id,
      name: chat.name,
      ...currentVoice(chat)
    }
  }, userId);
}
async function saveVoice(connectionIdValue, voiceValue, userId) {
  const connectionId = typeof connectionIdValue === "string" ? connectionIdValue.trim() : "";
  const voice = typeof voiceValue === "string" ? voiceValue.trim() : "";
  if (connectionId.length > 128 || voice.length > 512) {
    throw new Error("The connection or voice name is too long.");
  }
  const chat = await spindle.chats.getActive(userId);
  if (!chat) throw new Error("Open a chat before choosing a voice.");
  const metadata = { ...chat.metadata ?? {} };
  const rawOverrides = metadata.voiceOverrides;
  const previous = rawOverrides && typeof rawOverrides === "object" ? rawOverrides : {};
  const characters = { ...previous.characters ?? {} };
  const characterIds = targetCharacterIds(chat);
  if (connectionId) {
    const next = { connectionId, voice };
    for (const characterId of characterIds) characters[characterId] = next;
    metadata.voiceOverrides = {
      ...previous,
      narrator: next,
      ...Object.keys(characters).length > 0 ? { characters } : {}
    };
  } else {
    for (const characterId of characterIds) delete characters[characterId];
    const nextOverrides = { ...previous };
    delete nextOverrides.narrator;
    if (Object.keys(characters).length > 0) nextOverrides.characters = characters;
    else delete nextOverrides.characters;
    if (nextOverrides.narrator || nextOverrides.characters) {
      metadata.voiceOverrides = nextOverrides;
    } else {
      delete metadata.voiceOverrides;
    }
  }
  await spindle.chats.update(chat.id, { metadata }, userId);
  spindle.toast.success(
    connectionId ? "Chat voice saved." : "Chat voice reset to defaults.",
    { userId }
  );
  await sendState(userId);
}
spindle.onFrontendMessage(async (rawPayload, userId) => {
  try {
    const payload = rawPayload;
    if (payload?.type === "chat_voice_refresh") {
      await sendState(userId);
    } else if (payload?.type === "chat_voice_save") {
      await saveVoice(payload.connectionId, payload.voice, userId);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not update the chat voice.";
    spindle.sendToFrontend({ type: "chat_voice_error", error: message }, userId);
    spindle.toast.error(message, { userId });
  }
});
spindle.on("CHAT_SWITCHED", async (_payload, userId) => {
  await sendState(userId);
});
spindle.on("CHAT_CHANGED", async (_payload, userId) => {
  await sendState(userId);
});
spindle.log.info("Chat Voice loaded.");
