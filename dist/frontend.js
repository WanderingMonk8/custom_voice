// src/core.ts
function encodeConcatenatedWav(segments) {
  const usable = segments.filter((segment) => Number.isFinite(segment.sampleRate) && segment.sampleRate > 0 && segment.channels.length > 0 && segment.channels.some((channel) => channel.length > 0));
  if (usable.length === 0) throw new Error("No decoded audio is available to save.");
  const sampleRate = Math.max(...usable.map((segment) => Math.round(segment.sampleRate)));
  const channelCount = Math.max(...usable.map((segment) => segment.channels.length));
  const frameCounts = usable.map((segment) => {
    const sourceFrames = Math.max(...segment.channels.map((channel) => channel.length));
    return Math.max(1, Math.round(sourceFrames * sampleRate / segment.sampleRate));
  });
  const totalFrames = frameCounts.reduce((sum, count) => sum + count, 0);
  const bytesPerSample = 2;
  const dataLength = totalFrames * channelCount * bytesPerSample;
  const output = new ArrayBuffer(44 + dataLength);
  const view = new DataView(output);
  const writeText = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * bytesPerSample, true);
  view.setUint16(32, channelCount * bytesPerSample, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeText(36, "data");
  view.setUint32(40, dataLength, true);
  let writeOffset = 44;
  usable.forEach((segment, segmentIndex) => {
    const outputFrames = frameCounts[segmentIndex];
    const sourceFrames = Math.max(...segment.channels.map((channel) => channel.length));
    for (let frame = 0; frame < outputFrames; frame += 1) {
      const sourcePosition = outputFrames === 1 ? 0 : frame * (sourceFrames - 1) / (outputFrames - 1);
      const lower = Math.floor(sourcePosition);
      const upper = Math.min(sourceFrames - 1, lower + 1);
      const fraction = sourcePosition - lower;
      for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
        const channel = segment.channels[Math.min(channelIndex, segment.channels.length - 1)];
        const lowerValue = channel[Math.min(lower, channel.length - 1)] ?? 0;
        const upperValue = channel[Math.min(upper, channel.length - 1)] ?? lowerValue;
        const sample = Math.max(-1, Math.min(1, lowerValue + (upperValue - lowerValue) * fraction));
        view.setInt16(writeOffset, sample < 0 ? sample * 32768 : sample * 32767, true);
        writeOffset += bytesPerSample;
      }
    }
  });
  return output;
}
function mergeVoicePlan(segments) {
  const result = [];
  for (const segment of segments) {
    const paragraphs = segment.text.trim().split(/\n\s*\n+/).map((paragraph) => paragraph.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean);
    for (let index = 0; index < paragraphs.length; index += 1) {
      const text = paragraphs[index];
      const previous = result.at(-1);
      if (index === 0 && previous?.voice === segment.voice) {
        previous.text = `${previous.text} ${text}`;
      } else {
        result.push({ text, voice: segment.voice });
      }
    }
  }
  return result;
}
function normalizeSpeakerName(value) {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}
function speakerAliases(value) {
  const aliases = [];
  const seen = /* @__PURE__ */ new Set();
  for (const part of value.split("/")) {
    const alias = normalizeSpeakerName(part);
    const key = alias.toLowerCase();
    if (!alias || seen.has(key)) continue;
    seen.add(key);
    aliases.push(alias);
  }
  return aliases;
}
function npcSpeakerId(name) {
  return `npc:${normalizeSpeakerName(name).toLowerCase()}`;
}
function stripPlaybackMarkup(value) {
  return value.replace(/&lt;\/?(?:p|div|br)(?:\s[\s\S]*?)?&gt;/gi, "\n\n").replace(/\\?<\/?(?:p|div|br)(?:\s[^>]*)?>/gi, "\n\n").replace(/&lt;\/?[a-z][\s\S]*?&gt;/gi, " ").replace(/\\?<\/?[a-z][^>]*>/gi, " ").replace(/\[\/?(?:font|color|size|style|span|div|p|b|i|u|em|strong)(?:=[^\]]*)?\]/gi, " ").replace(/[*_~]+/g, " ");
}
function decodePlaybackEntities(value) {
  return value.replace(/&nbsp;/gi, " ").replace(/&quot;|&#34;|&#x22;/gi, '"').replace(/&apos;|&#39;|&#x27;/gi, "'").replace(/&lt;|&#60;|&#x3c;/gi, "<").replace(/&gt;|&#62;|&#x3e;/gi, ">").replace(/&amp;|&#38;|&#x26;/gi, "&");
}
function cleanPlaybackText(value) {
  return decodePlaybackEntities(stripPlaybackMarkup(value)).replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ").replace(/\r\n?/g, "\n").replace(/[^\S\n]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
var SPEECH_VERBS = "(?:said|says|asked|asks|replied|replies|whispered|whispers|shouted|shouts|yelled|yells|called|calls|murmured|murmurs|answered|answers|added|adds|continued|continues|remarked|remarks|cried|cries|growled|growls|sighed|sighs)";
function escapedPattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function soleMentionedSpeaker(text, speakers) {
  const narrative = text.replace(/["“][\s\S]*?["”]/gu, " ");
  const mentionedSpeakerIds = /* @__PURE__ */ new Set();
  for (const speaker of speakers) {
    for (const alias of speakerAliases(speaker.name)) {
      if (new RegExp(`\\b${escapedPattern(alias)}\\b`, "iu").test(narrative)) {
        mentionedSpeakerIds.add(speaker.id);
        break;
      }
    }
  }
  return mentionedSpeakerIds.size === 1 ? [...mentionedSpeakerIds][0] : null;
}
function currentParagraphSpeaker(before, after, speakers) {
  let paragraphStart = 0;
  for (const match of before.matchAll(/\n[^\S\n]*\n/gu)) {
    if (match.index !== void 0) paragraphStart = match.index + match[0].length;
  }
  const nextBreak = /\n[^\S\n]*\n/u.exec(after);
  const paragraphEnd = nextBreak?.index ?? after.length;
  return soleMentionedSpeaker(
    `${before.slice(paragraphStart)}
${after.slice(0, paragraphEnd)}`,
    speakers
  );
}
function precedingParagraphSpeaker(before, speakers) {
  let lastBreak = null;
  for (const match of before.matchAll(/\n[^\S\n]*\n/gu)) lastBreak = match;
  if (!lastBreak || lastBreak.index === void 0) return null;
  const breakEnd = lastBreak.index + lastBreak[0].length;
  if (cleanPlaybackText(before.slice(breakEnd))) return null;
  const earlierText = before.slice(0, lastBreak.index).trimEnd();
  let previousBreakEnd = 0;
  for (const match of earlierText.matchAll(/\n[^\S\n]*\n/gu)) {
    if (match.index !== void 0) previousBreakEnd = match.index + match[0].length;
  }
  return soleMentionedSpeaker(earlierText.slice(previousBreakEnd), speakers);
}
function inferQuotedSpeaker(before, after, quotedText, speakers, defaultSpeakerId) {
  if (/[,]\s*$/u.test(quotedText)) {
    const actionBeat = after.slice(0, 140).split(/["“\n]/u, 1)[0];
    let nearest = null;
    for (const speaker of speakers) {
      for (const alias of speakerAliases(speaker.name)) {
        const name = escapedPattern(alias);
        const index = actionBeat.search(new RegExp(`\\b${name}\\b`, "iu"));
        if (index >= 0 && (!nearest || index < nearest.index)) nearest = { id: speaker.id, index };
      }
    }
    if (nearest) return { speakerId: nearest.id, confident: true };
  }
  let best = null;
  for (const speaker of speakers) {
    for (const alias of speakerAliases(speaker.name)) {
      const name = escapedPattern(alias);
      const tests = [
        [new RegExp(`(?:^|\\n)\\s*(?:[-*]\\s*)?(?:\\*\\*)?${name}(?:\\*\\*)?\\s*:\\s*[^"\u201C\\n]{0,120}$`, "iu"), before.slice(-220), 100],
        [new RegExp(`\\b${name}\\b[^\\n.!?]{0,60}\\b${SPEECH_VERBS}\\b[^\\n.!?]{0,20}$`, "iu"), before.slice(-180), 90],
        [new RegExp(`\\b${SPEECH_VERBS}\\b\\s+(?:to\\s+)?${name}\\b[^\\n.!?]{0,20}$`, "iu"), before.slice(-180), 90],
        [new RegExp(`^\\s*[,;:.!?\u2014-]*\\s*${name}\\b[^\\n.!?]{0,50}\\b${SPEECH_VERBS}\\b`, "iu"), after.slice(0, 180), 85],
        [new RegExp(`^\\s*[,;:.!?\u2014-]*\\s*${SPEECH_VERBS}\\b\\s+(?:to\\s+)?${name}\\b`, "iu"), after.slice(0, 180), 85],
        [new RegExp(`\\b${name}\\b[^\\n]{0,70}$`, "iu"), before.slice(-140), 86]
      ];
      for (const [pattern, sample, score] of tests) {
        if (pattern.test(sample) && (!best || score > best.score)) best = { id: speaker.id, score };
      }
    }
  }
  if (best) return { speakerId: best.id, confident: true };
  const currentSpeakerId = currentParagraphSpeaker(before, after, speakers);
  if (currentSpeakerId) return { speakerId: currentSpeakerId, confident: true };
  const paragraphSpeakerId = precedingParagraphSpeaker(before, speakers);
  return paragraphSpeakerId ? { speakerId: paragraphSpeakerId, confident: true } : { speakerId: defaultSpeakerId, confident: false };
}
function canContinueSpeaker(bridge, previousSpeakerId, speakers) {
  if (/\n\s*\n/u.test(bridge)) return false;
  for (const speaker of speakers) {
    if (speaker.id === previousSpeakerId) continue;
    for (const alias of speakerAliases(speaker.name)) {
      const name = escapedPattern(alias);
      if (new RegExp(`\\b${name}\\b`, "iu").test(bridge)) return false;
    }
  }
  return true;
}
function parseRosterVoiceSegments(content, defaultSpeakerId, speakers) {
  const playbackContent = stripPlaybackMarkup(content);
  const result = [];
  const quotePattern = /["“]([\s\S]*?)["”]/g;
  let cursor = 0;
  let lastConfidentSpeakerId = null;
  for (const match of playbackContent.matchAll(quotePattern)) {
    if (match.index === void 0) continue;
    const bridge = playbackContent.slice(cursor, match.index);
    const narration2 = cleanPlaybackText(bridge);
    if (narration2) result.push({ text: narration2, speakerId: null });
    const speech = cleanPlaybackText(match[1] ?? "");
    if (speech) {
      const quoteEnd = match.index + match[0].length;
      const inference = inferQuotedSpeaker(
        playbackContent.slice(0, match.index),
        playbackContent.slice(quoteEnd),
        match[1] ?? "",
        speakers,
        defaultSpeakerId
      );
      const continuedSpeakerId = !inference.confident && lastConfidentSpeakerId && canContinueSpeaker(bridge, lastConfidentSpeakerId, speakers) ? lastConfidentSpeakerId : null;
      const speakerId = continuedSpeakerId ?? inference.speakerId;
      result.push({
        text: speech,
        speakerId
      });
      if (inference.confident && speakerId) lastConfidentSpeakerId = speakerId;
    }
    cursor = match.index + match[0].length;
  }
  const narration = cleanPlaybackText(playbackContent.slice(cursor));
  if (narration) result.push({ text: narration, speakerId: null });
  return result;
}

// src/frontend.ts
var MIN_SYNTHESIS_START_INTERVAL_MS = 1250;
var MAX_RATE_LIMIT_RETRIES = 3;
var PLAYBACK_BUFFER_SEGMENTS = 4;
var VOICE_ICON = `
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M5 10v4M9 7v10M13 4v16M17 8v8M21 10v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  </svg>
`;
var STOP_ACTION_ICON = `<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>`;
var RENAME_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true"><path d="M4 20h4l11-11-4-4L4 16v4Zm9.5-13.5 4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
async function listAllTtsConnections() {
  const pageSize = 200;
  const connections = [];
  let offset = 0;
  while (true) {
    const response = await fetch(`/api/v1/tts-connections?limit=${pageSize}&offset=${offset}`, {
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    });
    if (!response.ok) throw new Error(`Could not load TTS connections (${response.status}).`);
    const page = await response.json();
    const items = Array.isArray(page.data) ? page.data : [];
    connections.push(...items);
    offset += items.length;
    if (items.length === 0 || offset >= (page.total ?? items.length)) break;
  }
  return connections;
}
async function loadPlaybackPreferences() {
  const response = await fetch("/api/v1/settings/voiceSettings", {
    credentials: "same-origin",
    headers: { Accept: "application/json" }
  });
  if (!response.ok) return { speed: 1, volume: 1, connectionId: "" };
  const row = await response.json();
  const speed = typeof row.value?.ttsSpeed === "number" ? row.value.ttsSpeed : 1;
  const volume = typeof row.value?.ttsVolume === "number" ? row.value.ttsVolume : 1;
  return {
    speed: Math.min(4, Math.max(0.25, speed)),
    volume: Math.min(1, Math.max(0, volume)),
    connectionId: typeof row.value?.ttsConnectionId === "string" ? row.value.ttsConnectionId.trim() : ""
  };
}
function abortableDelay(milliseconds, signal) {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("Playback stopped.", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
function retryAfterMilliseconds(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1e3;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : null;
}
async function waitForSynthesisSlot(pacer, signal) {
  const turn = pacer.startQueue.then(async () => {
    while (true) {
      await abortableDelay(Math.max(0, pacer.nextStartAt - Date.now()), signal);
      if (Date.now() < pacer.nextStartAt) continue;
      pacer.nextStartAt = Date.now() + MIN_SYNTHESIS_START_INTERVAL_MS;
      return;
    }
  });
  pacer.startQueue = turn.catch(() => void 0);
  await turn;
}
async function synthesizeVoiceSegment(connectionId, text, voice, speed, signal, pacer, onRateLimit) {
  for (let attempt = 0; ; attempt += 1) {
    await waitForSynthesisSlot(pacer, signal);
    const response = await fetch("/api/v1/tts/synthesize", {
      method: "POST",
      credentials: "same-origin",
      signal,
      headers: { "Content-Type": "application/json", Accept: "audio/*" },
      body: JSON.stringify({
        connectionId,
        text,
        voice: voice || void 0,
        parameters: { speed }
      })
    });
    if (response.ok) {
      return {
        data: await response.arrayBuffer(),
        mime: response.headers.get("content-type") || "audio/mpeg"
      };
    }
    if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      const retryDelay = retryAfterMilliseconds(response.headers.get("Retry-After")) ?? Math.min(15e3, 2e3 * 2 ** attempt);
      pacer.nextStartAt = Math.max(pacer.nextStartAt, Date.now() + retryDelay);
      onRateLimit(retryDelay, attempt + 1);
      continue;
    }
    const detail = await response.text().catch(() => "");
    throw new Error(detail || `TTS synthesis failed (${response.status}).`);
  }
}
async function saveMessageAudio(chatId, messageId, swipeId, segments, signal) {
  const form = new FormData();
  form.append("chatId", chatId);
  form.append("messageId", messageId);
  if (typeof swipeId === "number") form.append("swipeId", String(swipeId));
  segments.forEach((segment, index) => {
    const blob = new Blob([segment.data], { type: segment.mime || "audio/mpeg" });
    form.append("segment", blob, `seg-${String(index).padStart(4, "0")}`);
  });
  const response = await fetch("/api/v1/tts/save-message-audio", {
    method: "POST",
    credentials: "same-origin",
    signal,
    body: form
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || `Could not save generated audio (${response.status}).`);
  }
}
async function ensureQuotationRouting() {
  const response = await fetch("/api/v1/settings/voiceSettings", {
    credentials: "same-origin",
    headers: { Accept: "application/json" }
  });
  if (!response.ok) return;
  const row = await response.json();
  const current = row.value && typeof row.value === "object" ? row.value : {};
  const currentRules = current.speechDetectionRules && typeof current.speechDetectionRules === "object" ? current.speechDetectionRules : {};
  const alreadyConfigured = currentRules.quoted === "speech" && currentRules.undecorated === "narration" && currentRules.asterisked === "narration";
  if (alreadyConfigured) return;
  await fetch("/api/v1/settings/voiceSettings", {
    method: "PUT",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      value: {
        ...current,
        speechDetectionRules: {
          ...currentRules,
          quoted: "speech",
          undecorated: "narration",
          asterisked: "narration"
        }
      }
    })
  });
}
function setup(ctx) {
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
  `);
  const tab = ctx.ui.registerDrawerTab({
    id: "chat-voice",
    title: "Chat Voice",
    shortName: "Voice",
    headerTitle: "Chat Voice",
    description: "Assign one TTS connection and individual voices to detected chat characters",
    keywords: ["tts", "speech", "narrator", "characters", "custom voice"],
    iconSvg: VOICE_ICON
  });
  const hostDocument = tab.root.ownerDocument;
  const hostWindow = hostDocument.defaultView ?? window;
  const panel = document.createElement("div");
  panel.className = "chat-voice-panel";
  const context = document.createElement("div");
  context.className = "chat-voice-context";
  context.textContent = "Open a chat to configure its voices.";
  function createField(labelText) {
    const field = document.createElement("div");
    field.className = "chat-voice-field";
    const label = document.createElement("div");
    label.className = "chat-voice-label";
    label.textContent = labelText;
    const slot = document.createElement("div");
    field.append(label, slot);
    return { field, slot };
  }
  const connectionField = createField("TTS connection");
  const scanField = createField("Character card cast");
  const scanRow = scanField.slot;
  scanRow.className = "chat-voice-scan-row";
  const scanButton = document.createElement("button");
  scanButton.type = "button";
  scanButton.className = "chat-voice-scan-button";
  scanButton.textContent = "Scan";
  scanButton.disabled = true;
  scanRow.append(scanButton);
  const narratorField = createField("Narrator voice");
  const routingHint = document.createElement("div");
  routingHint.className = "chat-voice-hint";
  routingHint.textContent = "Scan reads the character card, not chat history. During playback, quoted dialogue is matched to the saved cast using names and dialogue tags; everything outside quotes uses the narrator voice.";
  const addNpcField = createField("Add NPC manually");
  addNpcField.slot.className = "chat-voice-add-row";
  const addNpcInputSlot = document.createElement("div");
  const addNpcButton = document.createElement("button");
  addNpcButton.type = "button";
  addNpcButton.className = "chat-voice-add-button";
  addNpcButton.textContent = "Add";
  addNpcButton.disabled = true;
  addNpcField.slot.append(addNpcInputSlot, addNpcButton);
  const characterTitle = document.createElement("div");
  characterTitle.className = "chat-voice-section-title";
  characterTitle.textContent = "Detected voices";
  const characterList = document.createElement("div");
  characterList.className = "chat-voice-character-list";
  const status = document.createElement("div");
  status.className = "chat-voice-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  panel.append(
    context,
    connectionField.field,
    scanField.field,
    narratorField.field,
    routingHint,
    addNpcField.field,
    characterTitle,
    characterList,
    status
  );
  tab.root.appendChild(panel);
  let applyingState = false;
  let activeChat = null;
  let connections = [];
  let lumiverseConnectionId = "";
  let saveTimer = null;
  let editRevision = 0;
  let dirty = false;
  let scanning = false;
  let activePlayback = null;
  const inFlight = /* @__PURE__ */ new Set();
  const characterInputs = /* @__PURE__ */ new Map();
  let lastContextMessageId = null;
  const nativeButtonStates = /* @__PURE__ */ new Map();
  const pendingMessageRequests = /* @__PURE__ */ new Map();
  const pendingStateRequests = /* @__PURE__ */ new Map();
  let messageRequestSequence = 0;
  let stateRequestSequence = 0;
  const setStatus = (message, state = "normal") => {
    status.textContent = message;
    status.dataset.state = state;
  };
  function nativeTtsMessageId(button) {
    if (button.closest("[data-spindle-extension-root]")) return null;
    const known = button.dataset.chatVoiceNativeTts === "true";
    const label = [
      button.getAttribute("title"),
      button.getAttribute("aria-label"),
      button.textContent
    ].filter(Boolean).join(" ").toLowerCase();
    const iconClass = button.querySelector("svg")?.getAttribute("class")?.toLowerCase() ?? "";
    const hasNativeTtsIcon = iconClass.includes("volume-2") || iconClass.includes("volume2") || iconClass.includes("volume-high");
    const hasNativeTtsLabel = /\btts\b|text[ -]to[ -]speech|stop playback|regenerate.+audio/.test(label);
    const bubbleActions = button.closest('[data-component="BubbleActions"]');
    const bubbleButtons = bubbleActions ? [...bubbleActions.children].filter((child) => child.tagName === "BUTTON") : [];
    const isBubbleTtsPosition = bubbleButtons.length >= 3 && bubbleButtons[2] === button;
    if (!known && !hasNativeTtsIcon && !hasNativeTtsLabel && !isBubbleTtsPosition) return null;
    const messageElement = button.closest("[data-message-id]");
    if (messageElement?.dataset.messageId) return messageElement.dataset.messageId;
    const isPortalMenuAction = button.parentElement?.parentElement === button.ownerDocument.body && !!button.querySelector(":scope > span");
    return isPortalMenuAction ? lastContextMessageId : null;
  }
  const connectionPicker = ctx.components.mountSelect(connectionField.slot, {
    value: "",
    options: [],
    placeholder: "Loading connections\u2026",
    searchPlaceholder: "Search TTS connections\u2026",
    emptyMessage: "No TTS connections found.",
    clearable: true,
    clearLabel: "Disable custom chat voices",
    ariaLabel: "TTS connection",
    disabled: true,
    onChange: () => markChanged()
  });
  const narratorInput = ctx.components.mountTextInput(narratorField.slot, {
    value: "",
    placeholder: "Enter the narrator voice name or ID",
    ariaLabel: "Narrator voice",
    disabled: true,
    onChange: () => markChanged()
  });
  const addNpcInput = ctx.components.mountTextInput(addNpcInputSlot, {
    value: "",
    placeholder: "NPC name / aliases",
    ariaLabel: "NPC name and aliases to add",
    disabled: true,
    onChange: () => void 0
  });
  function collectConfig() {
    return {
      messageLimit: activeChat?.messageLimit ?? 20,
      connectionId: connectionPicker.getValue(),
      narratorVoice: narratorInput.getValue(),
      characterVoices: Object.fromEntries(
        [...characterInputs.entries()].map(([id, input]) => [id, input.getValue()])
      ),
      characters: activeChat?.characters.map(({ id, name, messageCount }) => ({ id, name, messageCount })) ?? []
    };
  }
  function flushSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    if (!dirty || !activeChat) return;
    const clientRevision = editRevision;
    dirty = false;
    inFlight.add(clientRevision);
    setStatus("Saving\u2026");
    ctx.sendToBackend({
      type: "chat_voice_save",
      chatId: activeChat.id,
      clientRevision,
      config: collectConfig()
    });
  }
  function markChanged(delay = 350) {
    if (applyingState || !activeChat) return;
    dirty = true;
    editRevision += 1;
    setStatus("Saving\u2026");
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, delay);
  }
  function updatePlaybackButtons() {
    for (const button of hostDocument.querySelectorAll("button")) {
      const messageId = nativeTtsMessageId(button);
      if (!messageId) continue;
      const playing = activePlayback?.messageId === messageId;
      const idle = nativeButtonStates.get(button);
      if (!playing) {
        if (!idle) continue;
        button.innerHTML = idle.html;
        if (idle.title === null) button.removeAttribute("title");
        else button.setAttribute("title", idle.title);
        if (idle.ariaLabel === null) button.removeAttribute("aria-label");
        else button.setAttribute("aria-label", idle.ariaLabel);
        if (idle.ariaPressed === null) button.removeAttribute("aria-pressed");
        else button.setAttribute("aria-pressed", idle.ariaPressed);
        delete button.dataset.chatVoiceNativeTts;
        delete button.dataset.playing;
        nativeButtonStates.delete(button);
        continue;
      }
      if (!idle) {
        nativeButtonStates.set(button, {
          html: button.innerHTML,
          title: button.getAttribute("title"),
          ariaLabel: button.getAttribute("aria-label"),
          ariaPressed: button.getAttribute("aria-pressed")
        });
      }
      const label = "Stop custom voice playback";
      const hasText = !!button.querySelector(":scope > span");
      button.dataset.chatVoiceNativeTts = "true";
      button.dataset.playing = "true";
      button.innerHTML = `${STOP_ACTION_ICON}${hasText ? `<span>${label}</span>` : ""}`;
      button.title = label;
      button.setAttribute("aria-label", label);
      button.setAttribute("aria-pressed", "true");
    }
  }
  function restoreNativePlaybackButtons() {
    activePlayback = null;
    updatePlaybackButtons();
    nativeButtonStates.clear();
  }
  function requestPlaybackMessage(chatId, messageId) {
    const requestId = `${Date.now().toString(36)}-${++messageRequestSequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingMessageRequests.delete(requestId);
        reject(new Error("Timed out while loading the message for playback."));
      }, 15e3);
      pendingMessageRequests.set(requestId, { resolve, reject, timer });
      ctx.sendToBackend({ type: "chat_voice_get_message", chatId, messageId, requestId });
    });
  }
  function refreshLocalState() {
    ctx.sendToBackend({
      type: "chat_voice_refresh",
      chatId: ctx.getActiveChat().chatId
    });
  }
  function requestLocalState() {
    const chatId = ctx.getActiveChat().chatId;
    const requestId = `state-${Date.now().toString(36)}-${++stateRequestSequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingStateRequests.delete(requestId);
        reject(new Error("Timed out while loading the active chat voice settings."));
      }, 15e3);
      pendingStateRequests.set(requestId, { chatId, resolve, reject, timer });
      ctx.sendToBackend({ type: "chat_voice_refresh", chatId, requestId });
    });
  }
  function stopPlayback() {
    const playback = activePlayback;
    activePlayback = null;
    if (!playback) return;
    playback.controller.abort();
    try {
      playback.source?.stop();
    } catch {
    }
    void playback.context.close().catch(() => void 0);
    updatePlaybackButtons();
  }
  async function playDecodedBuffer(playback, data, volume) {
    if (playback.controller.signal.aborted) throw new DOMException("Playback stopped.", "AbortError");
    const buffer = await playback.context.decodeAudioData(data.slice(0));
    if (playback.controller.signal.aborted) throw new DOMException("Playback stopped.", "AbortError");
    await new Promise((resolve, reject) => {
      const source = playback.context.createBufferSource();
      const gain = playback.context.createGain();
      gain.gain.value = volume;
      source.buffer = buffer;
      source.connect(gain);
      gain.connect(playback.context.destination);
      playback.source = source;
      const abort = () => {
        try {
          source.stop();
        } catch {
        }
        reject(new DOMException("Playback stopped.", "AbortError"));
      };
      playback.controller.signal.addEventListener("abort", abort, { once: true });
      source.onended = () => {
        playback.controller.signal.removeEventListener("abort", abort);
        playback.source = null;
        resolve();
      };
      source.start();
    });
    return buffer;
  }
  async function playMessage(messageId) {
    if (activePlayback) {
      const wasSameMessage = activePlayback.messageId === messageId;
      stopPlayback();
      if (wasSameMessage) {
        setStatus("Playback stopped.");
        return;
      }
    }
    const localChatId = ctx.getActiveChat().chatId;
    if (activeChat?.id !== localChatId) {
      setStatus("Loading this chat\u2019s voice settings\u2026");
      try {
        await requestLocalState();
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Could not load this chat\u2019s voice settings.", "error");
        return;
      }
    }
    if (!activeChat || activeChat.id !== ctx.getActiveChat().chatId) return;
    const playbackChat = activeChat;
    const config = collectConfig();
    const preferences = await loadPlaybackPreferences();
    const connectionId = config.connectionId || (connections.some((connection) => connection.id === preferences.connectionId) ? preferences.connectionId : connections.find((connection) => connection.is_default)?.id ?? lumiverseConnectionId);
    if (!connectionId) {
      setStatus("Choose a TTS connection before playing.", "error");
      return;
    }
    const contextClass = window.AudioContext ?? window.webkitAudioContext;
    if (!contextClass) {
      setStatus("Web Audio is unavailable in this browser.", "error");
      return;
    }
    const audioContext = new contextClass();
    await audioContext.resume();
    const playback = {
      messageId,
      controller: new AbortController(),
      context: audioContext,
      source: null
    };
    activePlayback = playback;
    updatePlaybackButtons();
    try {
      const message = await requestPlaybackMessage(playbackChat.id, messageId);
      if (message.is_user) throw new Error("Custom voice playback is only available for character messages.");
      const explicitId = typeof message.extra?.character_id === "string" ? message.extra.character_id : "";
      const messageName = normalizeSpeakerName(message.name).toLowerCase();
      const defaultSpeakerId = explicitId || playbackChat.characters.find((character) => !character.id.startsWith("npc:") && speakerAliases(character.name).some((alias) => alias.toLowerCase() === messageName))?.id || null;
      const aliases = new Map(
        playbackChat.characters.flatMap((character) => speakerAliases(character.name).map((alias) => [npcSpeakerId(alias), character.id]))
      );
      const segments = parseRosterVoiceSegments(message.content, defaultSpeakerId, playbackChat.characters);
      const plan = mergeVoicePlan(segments.map((segment) => {
        const speakerId = segment.speakerId ? aliases.get(segment.speakerId) ?? segment.speakerId : null;
        const voice = speakerId ? config.characterVoices[speakerId] || (defaultSpeakerId ? config.characterVoices[defaultSpeakerId] : "") || "" : config.narratorVoice;
        return { text: segment.text, voice };
      }));
      if (plan.length === 0) throw new Error("This message has no playable narration or dialogue.");
      const pacer = { nextStartAt: 0, startQueue: Promise.resolve() };
      const prepare = async (index) => {
        try {
          const segment = await synthesizeVoiceSegment(
            connectionId,
            plan[index].text,
            plan[index].voice,
            preferences.speed,
            playback.controller.signal,
            pacer,
            (delayMs, retry) => setStatus(
              `Rate limited; retry ${retry} in ${Math.max(1, Math.ceil(delayMs / 1e3))}s\u2026`
            )
          );
          return { segment };
        } catch (error) {
          return { error };
        }
      };
      const prepared = /* @__PURE__ */ new Map();
      const schedule = (index) => {
        if (index < plan.length && !prepared.has(index)) prepared.set(index, prepare(index));
      };
      const initialBufferSize = Math.min(PLAYBACK_BUFFER_SEGMENTS, plan.length);
      for (let index = 0; index < initialBufferSize; index += 1) schedule(index);
      setStatus(
        `Buffering ${initialBufferSize} voice segment${initialBufferSize === 1 ? "" : "s"} before playback\u2026`
      );
      await Promise.all(prepared.values());
      const decoded = new Array(plan.length);
      for (let index = 0; index < plan.length; index += 1) {
        const current = await prepared.get(index);
        prepared.delete(index);
        if ("error" in current) throw current.error;
        schedule(index + PLAYBACK_BUFFER_SEGMENTS);
        setStatus(`Playing ${index + 1} of ${plan.length} voice segment${plan.length === 1 ? "" : "s"}\u2026`);
        decoded[index] = await playDecodedBuffer(playback, current.segment.data, preferences.volume);
      }
      if (activePlayback === playback) {
        activePlayback = null;
        updatePlaybackButtons();
        await playback.context.close().catch(() => void 0);
      }
      const wav = encodeConcatenatedWav(decoded.map((buffer) => ({
        sampleRate: buffer.sampleRate,
        channels: Array.from(
          { length: buffer.numberOfChannels },
          (_, channel) => buffer.getChannelData(channel)
        )
      })));
      setStatus("Playback complete. Saving generated audio\u2026");
      try {
        await saveMessageAudio(
          playbackChat.id,
          messageId,
          message.swipe_id,
          [{ data: wav, mime: "audio/wav" }],
          playback.controller.signal
        );
        setStatus("Playback complete and audio saved.", "saved");
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        const detail = error instanceof Error ? error.message : "Unknown save error.";
        setStatus(`Playback completed, but its audio could not be saved: ${detail}`, "error");
      }
    } catch (error) {
      if (error?.name !== "AbortError") {
        setStatus(error instanceof Error ? error.message : "Custom voice playback failed.", "error");
      }
    } finally {
      if (activePlayback === playback) {
        activePlayback = null;
        await playback.context.close().catch(() => void 0);
        updatePlaybackButtons();
      }
    }
  }
  function scanMessages() {
    if (!activeChat || scanning) return;
    flushSave();
    scanning = true;
    scanButton.disabled = true;
    scanButton.textContent = "Scanning\u2026";
    setStatus("Reading the active character card cast\u2026");
    ctx.sendToBackend({
      type: "chat_voice_scan",
      chatId: activeChat.id,
      messageLimit: activeChat.messageLimit
    });
  }
  scanButton.addEventListener("click", scanMessages);
  function connectionOptions(selectedId = "") {
    const options = connections.map((connection) => ({
      value: connection.id,
      label: connection.name,
      sublabel: connection.provider
    }));
    if (selectedId && !connections.some((connection) => connection.id === selectedId)) {
      options.unshift({ value: selectedId, label: "Missing connection", sublabel: selectedId });
    }
    return options;
  }
  function addManualNpc() {
    if (!activeChat) return;
    const aliases = speakerAliases(addNpcInput.getValue().slice(0, 128));
    if (aliases.length === 0) {
      setStatus("Enter an NPC name first.", "error");
      return;
    }
    const existingAliases = new Set(activeChat.characters.flatMap((character) => speakerAliases(character.name).map((alias) => alias.toLowerCase())));
    const duplicateAlias = aliases.find((alias) => existingAliases.has(alias.toLowerCase()));
    if (duplicateAlias) {
      setStatus(`${duplicateAlias} is already in this chat's voice roster.`, "error");
      return;
    }
    const name = aliases.join(" / ");
    const id = npcSpeakerId(aliases[0]);
    activeChat = {
      ...activeChat,
      characters: [...activeChat.characters, { id, name, messageCount: 0, voice: "" }]
    };
    addNpcInput.update({ value: "" });
    renderCharacters(activeChat.characters);
    markChanged(0);
  }
  function removeNpc(characterId) {
    if (!activeChat || !characterId.startsWith("npc:")) return;
    activeChat = {
      ...activeChat,
      characters: activeChat.characters.filter((character) => character.id !== characterId)
    };
    renderCharacters(activeChat.characters);
    markChanged(0);
  }
  function renameNpc(characterId) {
    if (!activeChat || !characterId.startsWith("npc:")) return null;
    const character = activeChat.characters.find((item) => item.id === characterId);
    if (!character) return null;
    const response = hostWindow.prompt(
      "Rename this NPC or add aliases separated by \u201C/\u201D.",
      character.name
    );
    if (response === null) return null;
    const aliases = speakerAliases(response.slice(0, 128));
    if (aliases.length === 0) {
      setStatus("Enter an NPC name first.", "error");
      return null;
    }
    const existingAliases = new Set(activeChat.characters.filter((item) => item.id !== characterId).flatMap((item) => speakerAliases(item.name).map((alias) => alias.toLowerCase())));
    const duplicateAlias = aliases.find((alias) => existingAliases.has(alias.toLowerCase()));
    if (duplicateAlias) {
      setStatus(`${duplicateAlias} is already in this chat's voice roster.`, "error");
      return null;
    }
    const name = aliases.join(" / ");
    activeChat = {
      ...activeChat,
      characters: activeChat.characters.map((item) => item.id === characterId ? { ...item, name } : item)
    };
    markChanged(0);
    return name;
  }
  const onAddNpc = () => addManualNpc();
  const onAddNpcKeyDown = (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    addManualNpc();
  };
  addNpcButton.addEventListener("click", onAddNpc);
  addNpcInputSlot.addEventListener("keydown", onAddNpcKeyDown);
  function renderCharacters(characters) {
    for (const input of characterInputs.values()) input.destroy();
    characterInputs.clear();
    characterList.replaceChildren();
    if (characters.length === 0) {
      const empty = document.createElement("div");
      empty.className = "chat-voice-empty";
      empty.textContent = "No saved characters yet. Click Scan to read the active character card.";
      characterList.appendChild(empty);
      return;
    }
    for (const character of characters) {
      const card = document.createElement("div");
      card.className = "chat-voice-character";
      const heading = document.createElement("div");
      heading.className = "chat-voice-character-heading";
      const name = document.createElement("span");
      name.className = "chat-voice-character-name";
      name.textContent = character.name;
      const count = document.createElement("span");
      count.className = "chat-voice-character-count";
      count.textContent = character.messageCount > 0 ? `${character.messageCount} occurrence${character.messageCount === 1 ? "" : "s"}` : "Card cast";
      const meta = document.createElement("span");
      meta.className = "chat-voice-character-meta";
      meta.append(count);
      if (character.id.startsWith("npc:")) {
        const rename = document.createElement("button");
        rename.type = "button";
        rename.className = "chat-voice-rename-button";
        rename.innerHTML = RENAME_ICON;
        rename.title = `Rename ${character.name} or edit aliases`;
        rename.setAttribute("aria-label", rename.title);
        rename.disabled = !activeChat;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "chat-voice-delete-button";
        remove.textContent = "\xD7";
        remove.title = `Delete ${character.name}`;
        remove.setAttribute("aria-label", remove.title);
        remove.disabled = !activeChat;
        rename.addEventListener("click", () => {
          const renamed = renameNpc(character.id);
          if (!renamed) return;
          name.textContent = renamed;
          rename.title = `Rename ${renamed} or edit aliases`;
          rename.setAttribute("aria-label", rename.title);
          remove.title = `Delete ${renamed}`;
          remove.setAttribute("aria-label", remove.title);
          input.update({
            placeholder: `Voice name or ID for ${renamed}`,
            ariaLabel: `Custom voice for ${renamed}`
          });
        });
        remove.addEventListener("click", () => removeNpc(character.id));
        meta.append(rename, remove);
      }
      const slot = document.createElement("div");
      heading.append(name, meta);
      card.append(heading, slot);
      characterList.appendChild(card);
      const input = ctx.components.mountTextInput(slot, {
        value: character.voice,
        placeholder: `Voice name or ID for ${character.name}`,
        ariaLabel: `Custom voice for ${character.name}`,
        disabled: !activeChat,
        onChange: () => markChanged()
      });
      characterInputs.set(character.id, input);
    }
  }
  function renderState(next) {
    applyingState = true;
    activeChat = next;
    context.textContent = next ? `Active chat: ${next.name}` : "Open a chat to configure its voices.";
    const selectedConnectionId = next?.connectionId || lumiverseConnectionId;
    connectionPicker.update({
      value: selectedConnectionId,
      options: connectionOptions(selectedConnectionId),
      placeholder: connections.length ? "Choose a TTS connection" : "No TTS connections found",
      disabled: !next || connections.length === 0
    });
    scanButton.disabled = !next || scanning;
    narratorInput.update({ value: next?.narratorVoice ?? "", disabled: !next });
    addNpcInput.update({ value: "", disabled: !next });
    addNpcButton.disabled = !next;
    renderCharacters(next?.characters ?? []);
    applyingState = false;
    if (!next) setStatus("Open a chat to edit its voices.");
    else if (connections.length === 0) setStatus("Create a TTS connection in Lumiverse first.");
    else setStatus("All changes save automatically.", "saved");
  }
  async function loadConnections() {
    try {
      const [loadedConnections, preferences] = await Promise.all([
        listAllTtsConnections(),
        loadPlaybackPreferences()
      ]);
      connections = loadedConnections;
      lumiverseConnectionId = connections.some((connection) => connection.id === preferences.connectionId) ? preferences.connectionId : connections.find((connection) => connection.is_default)?.id ?? "";
      const selectedConnectionId = activeChat?.connectionId || lumiverseConnectionId;
      connectionPicker.update({
        value: selectedConnectionId,
        options: connectionOptions(selectedConnectionId),
        placeholder: connections.length ? "Choose a TTS connection" : "No TTS connections found",
        disabled: !activeChat || connections.length === 0
      });
      if (connections.length === 0) setStatus("Create a TTS connection in Lumiverse first.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not load TTS connections.";
      connectionPicker.update({ placeholder: "Connections unavailable", disabled: true });
      setStatus(message, "error");
    }
  }
  const onNativeContextMenu = (event) => {
    const target = event.target && typeof event.target.closest === "function" ? event.target : null;
    lastContextMessageId = target?.closest("[data-message-id]")?.dataset.messageId ?? null;
    hostWindow.requestAnimationFrame(updatePlaybackButtons);
  };
  const onNativeTtsClick = (event) => {
    const target = event.target && typeof event.target.closest === "function" ? event.target : null;
    const button = target?.closest("button");
    if (!button) return;
    const messageId = nativeTtsMessageId(button);
    if (!messageId) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (button.parentElement?.parentElement === button.ownerDocument.body) {
      hostDocument.dispatchEvent(new hostWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }
    void playMessage(messageId);
  };
  hostWindow.addEventListener("contextmenu", onNativeContextMenu, true);
  hostWindow.addEventListener("click", onNativeTtsClick, true);
  hostWindow.requestAnimationFrame(updatePlaybackButtons);
  const unsubscribeBackend = ctx.onBackendMessage((rawPayload) => {
    const payload = rawPayload;
    if (payload.type === "chat_voice_message") {
      const pending = pendingMessageRequests.get(payload.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingMessageRequests.delete(payload.requestId);
      if (payload.error || !payload.message) pending.reject(new Error(payload.error || "The message is unavailable."));
      else pending.resolve(payload.message);
      return;
    }
    if (payload.type === "chat_voice_error") {
      if (payload.requestId) {
        const pending = pendingStateRequests.get(payload.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingStateRequests.delete(payload.requestId);
          pending.reject(new Error(payload.error || "Could not load chat voice settings."));
        }
      }
      if (payload.clientRevision !== void 0) inFlight.delete(payload.clientRevision);
      scanning = false;
      scanButton.textContent = "Scan";
      scanButton.disabled = !activeChat;
      setStatus(payload.error || "Could not save chat voice settings.", "error");
      return;
    }
    if (payload.type === "chat_voice_scan_complete") {
      if (payload.chatId !== activeChat?.id) return;
      scanning = false;
      scanButton.textContent = "Scan";
      scanButton.disabled = false;
      setStatus(payload.cardParserFallback ? "Card parsing was unavailable; the primary card character was saved." : "Scan complete. Character-card cast saved.", "saved");
      return;
    }
    if (payload.type !== "chat_voice_state") return;
    const incomingChatId = payload.chat?.id ?? null;
    const localChatId = ctx.getActiveChat().chatId;
    const pendingState = payload.requestId ? pendingStateRequests.get(payload.requestId) : void 0;
    if (pendingState) {
      clearTimeout(pendingState.timer);
      pendingStateRequests.delete(payload.requestId);
    }
    if (incomingChatId !== localChatId) {
      pendingState?.reject(new Error("The active chat changed while its voice settings were loading."));
      return;
    }
    const currentChatId = activeChat?.id ?? null;
    if (incomingChatId !== currentChatId) {
      for (const pending of pendingMessageRequests.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("The active chat changed before playback started."));
      }
      pendingMessageRequests.clear();
      stopPlayback();
      flushSave();
      dirty = false;
      inFlight.clear();
      scanning = false;
      scanButton.textContent = "Scan";
      renderState(payload.chat);
      pendingState?.resolve(payload.chat);
      return;
    }
    if (payload.clientRevision !== void 0) {
      inFlight.delete(payload.clientRevision);
      if (payload.clientRevision !== editRevision || dirty) return;
      renderState(payload.chat);
      setStatus("Saved.", "saved");
      pendingState?.resolve(payload.chat);
      return;
    }
    if (dirty || inFlight.size > 0) {
      pendingState?.resolve(payload.chat);
      return;
    }
    renderState(payload.chat);
    pendingState?.resolve(payload.chat);
  });
  const unsubscribeChatSwitched = ctx.events.on("CHAT_SWITCHED", (rawPayload) => {
    const switchedChatId = rawPayload?.chatId ?? null;
    hostWindow.requestAnimationFrame(() => {
      if (ctx.getActiveChat().chatId === switchedChatId) refreshLocalState();
    });
  });
  const unsubscribeActivate = tab.onActivate(() => {
    void loadConnections();
    void ensureQuotationRouting().catch(() => void 0);
    refreshLocalState();
  });
  void loadConnections();
  void ensureQuotationRouting().catch(() => void 0);
  refreshLocalState();
  return () => {
    stopPlayback();
    flushSave();
    if (saveTimer) clearTimeout(saveTimer);
    unsubscribeActivate();
    unsubscribeChatSwitched();
    unsubscribeBackend();
    for (const input of characterInputs.values()) input.destroy();
    for (const pending of pendingMessageRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Chat Voice was closed."));
    }
    pendingMessageRequests.clear();
    for (const pending of pendingStateRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Chat Voice was closed."));
    }
    pendingStateRequests.clear();
    connectionPicker.destroy();
    narratorInput.destroy();
    addNpcInput.destroy();
    addNpcButton.removeEventListener("click", onAddNpc);
    addNpcInputSlot.removeEventListener("keydown", onAddNpcKeyDown);
    scanButton.removeEventListener("click", scanMessages);
    hostWindow.removeEventListener("contextmenu", onNativeContextMenu, true);
    hostWindow.removeEventListener("click", onNativeTtsClick, true);
    restoreNativePlaybackButtons();
    tab.destroy();
    removeStyle();
  };
}
export {
  setup
};
