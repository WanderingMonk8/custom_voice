// src/playback-ui.ts
function waitForAutoplayDeadline(deadline, signal) {
  if (signal.aborted) return Promise.resolve(false);
  const remaining = Math.max(0, deadline - Date.now());
  if (!remaining) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (ready) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve(ready);
    };
    const abort = () => finish(false);
    const timer = setTimeout(() => finish(true), remaining);
    signal.addEventListener("abort", abort, { once: true });
  });
}
var AutoplayRequestRegistry = class {
  pending = /* @__PURE__ */ new Map();
  begin(key) {
    this.pending.get(key)?.abort();
    const controller = new AbortController();
    this.pending.set(key, controller);
    return controller.signal;
  }
  finish(key, signal) {
    if (this.pending.get(key)?.signal === signal) this.pending.delete(key);
  }
  cancelAll() {
    for (const controller of this.pending.values()) controller.abort();
    this.pending.clear();
  }
};
function waitForAutoplayWork(work, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    signal.addEventListener("abort", abort, { once: true });
    work.then(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, (error) => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) resolve();
      else reject(error);
    });
  });
}
var PlaybackStartupGuard = class {
  serial = 0;
  pending = null;
  begin(chatId, messageId, automatic) {
    if (this.pending?.chatId === chatId && this.pending.messageId === messageId) {
      if (!automatic) this.cancel();
      return null;
    }
    const token = ++this.serial;
    this.pending = { token, chatId, messageId, automatic };
    return token;
  }
  owns(token) {
    return this.pending?.token === token;
  }
  finish(token) {
    if (this.owns(token)) this.pending = null;
  }
  cancel() {
    this.serial++;
    this.pending = null;
  }
  cancelAutomatic() {
    if (this.pending?.automatic) this.cancel();
  }
  cancelAutomaticFor(chatId, messageId) {
    if (this.pending?.automatic && this.pending.chatId === chatId && this.pending.messageId === messageId) this.cancel();
  }
};
var PlaybackLongPress = class {
  constructor(toggle, delay = 650) {
    this.toggle = toggle;
    this.delay = delay;
  }
  active = null;
  suppressed = null;
  expiry = null;
  start(target, pointerId, x, y) {
    this.cancel();
    this.suppressed = null;
    const active = { target, pointerId, x, y, fired: false, timer: setTimeout(() => {
      if (this.active !== active) return;
      active.fired = true;
      this.suppressed = target;
      this.toggle();
    }, this.delay) };
    this.active = active;
  }
  move(pointerId, x, y) {
    if (this.active?.pointerId === pointerId && !this.active.fired && Math.hypot(x - this.active.x, y - this.active.y) > 10) this.cancel();
  }
  end(pointerId) {
    if (this.active?.pointerId !== pointerId) return;
    const fired = this.active.fired;
    clearTimeout(this.active.timer);
    this.active = null;
    if (fired) this.expiry = setTimeout(() => {
      this.suppressed = null;
      this.expiry = null;
    }, 1e3);
  }
  consumeClick(target) {
    if (this.suppressed !== target) return false;
    this.suppressed = null;
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = null;
    return true;
  }
  isHolding(target) {
    return this.active?.target === target;
  }
  cancel() {
    if (this.active) clearTimeout(this.active.timer);
    if (this.expiry) clearTimeout(this.expiry);
    this.active = null;
    this.expiry = null;
    this.suppressed = null;
  }
};
function syncAutoplayIndicators(buttons, enabled, getMessageId) {
  for (const button of buttons) {
    if (enabled && getMessageId(button)) button.dataset.chatVoiceAutoplay = "true";
    else delete button.dataset.chatVoiceAutoplay;
  }
}
function syncPlaybackButtons(buttons, activeMessageId, getMessageId, states, stopIcon) {
  for (const button of buttons) {
    const messageId = getMessageId(button);
    if (!messageId) continue;
    const playing = activeMessageId === messageId;
    const idle = states.get(button);
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
      states.delete(button);
      continue;
    }
    if (!idle) states.set(button, {
      html: button.innerHTML,
      title: button.getAttribute("title"),
      ariaLabel: button.getAttribute("aria-label"),
      ariaPressed: button.getAttribute("aria-pressed")
    });
    if (button.dataset.playing === "true" && button.querySelector("[data-chat-voice-stop]")) continue;
    const label = "Stop custom voice playback";
    const hasText = !!button.querySelector(":scope > span");
    button.dataset.chatVoiceNativeTts = "true";
    button.dataset.playing = "true";
    button.innerHTML = `${stopIcon}${hasText ? `<span>${label}</span>` : ""}`;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-pressed", "true");
  }
}

// src/core.ts
var USER_SPEAKER_ID = "__chat_voice_user__";
var UNCAST_SPEAKER_ID = "__chat_voice_uncast__";
function standardSpeakerReviewPolicy() {
  return { runReview: true, bestAvailableSpeaker: true, shadowEvaluation: false, focusedOpeningFallback: false };
}
function autoplayGenerationEvent(value, activeChatId) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !activeChatId) return null;
  const event = value;
  if (event.chatId !== activeChatId || typeof event.messageId !== "string" || !event.messageId.trim() || typeof event.generationId !== "string" || !event.generationId.trim() || event.error || event.backgroundSwipe === true) return null;
  const kind = typeof event.generationType === "string" ? event.generationType.trim().toLowerCase() : "";
  if (["continue", "impersonate"].includes(kind)) return null;
  const reroll = kind === "regenerate" || kind === "swipe";
  return {
    chatId: activeChatId,
    messageId: event.messageId,
    generationId: event.generationId,
    ...reroll ? { reroll: true } : {},
    ...typeof event.content === "string" ? { content: event.content } : {}
  };
}
function claimAutoplayGeneration(event, generations, messages) {
  const generationKey = `${event.chatId}\0${event.generationId}`;
  const messageKey = `${event.chatId}\0${event.messageId}`;
  if (generations.has(generationKey)) return false;
  generations.add(generationKey);
  messages.add(messageKey);
  if (generations.size > 512) generations.delete(generations.values().next().value);
  if (messages.size > 512) messages.delete(messages.values().next().value);
  return true;
}
function autoplaySwipeSnapshot(message) {
  const swipeId = message.swipe_id ?? 0;
  const swipeDate = message.swipe_dates?.[swipeId];
  return { swipeId, contentHash: hashMessageContent(message.content), ...typeof swipeDate === "number" && Number.isFinite(swipeDate) ? { swipeDate } : {} };
}
function autoplaySwipeMatches(message, expected) {
  const actual = autoplaySwipeSnapshot(message);
  return actual.swipeId === expected.swipeId && actual.contentHash === expected.contentHash && (expected.swipeDate === void 0 || actual.swipeDate === expected.swipeDate);
}
function refreshAutoplaySwipe(message, original) {
  const current = autoplaySwipeSnapshot(message);
  if (current.swipeId !== original.swipeId) return null;
  if (original.swipeDate !== void 0 && current.swipeDate !== original.swipeDate) return null;
  return current;
}
function swipeSynthesisKey(chatId, messageId, swipeId) {
  return `${chatId}\0${messageId}\0${swipeId}`;
}
function savedAudioMatchesSwipe(result, messageId, swipeId) {
  const audioId = result.audio?.id;
  return result.message?.id === messageId && result.swipe_id === swipeId && !!audioId && !!result.message.extra?.attachments?.some((item) => item?.type === "audio" && item.image_id === audioId && item.swipe_id === swipeId);
}
function automaticPlaybackSkipReason(message, expected) {
  if (message.is_user) return "user-message";
  if (expected && !autoplaySwipeMatches(message, expected)) return "changed-swipe";
  return null;
}
function readAutomaticVoicePreferences(value) {
  return { autoVoiceCasting: value.chatVoiceAutoCasting !== false, autoPlayback: value.chatVoiceAutoPlayback === true };
}
var MAX_AUTOPLAY_DELAY_SECONDS = 3600;
function readAutoplayDelaySeconds(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(MAX_AUTOPLAY_DELAY_SECONDS, Math.max(0, Math.round(value)));
}
function globalTtsConnectionPreference(value) {
  const chosen = typeof value.chatVoiceTtsConnectionId === "string" ? value.chatVoiceTtsConnectionId : value.ttsConnectionId;
  return typeof chosen === "string" ? chosen.trim().slice(0, 128) : "";
}
function resolveGlobalTtsConnection(preference, connections) {
  return preference || connections.find((connection) => connection.is_default)?.id || "";
}
var UNRESOLVED_SPEAKER_ID = "__chat_voice_unresolved__";
var DEFAULT_SAVED_AUDIO_LIMIT = 50;
var MAX_SAVED_AUDIO_LIMIT = 1e4;
function voiceCategoryGender(category) {
  const value = (category ?? "").trim().toLowerCase();
  if (!value) return "unspecified";
  if (/\bfemale\b/.test(value)) return "female";
  if (/\bmale\b/.test(value)) return "male";
  return "unspecified";
}
function voiceGender(voice) {
  if (voice.gender === "male" || voice.gender === "female") return voice.gender;
  const fromCategory = voiceCategoryGender(voice.category);
  if (fromCategory !== "unspecified") return fromCategory;
  for (const tag of voice.tags ?? []) {
    const tagGender = voiceCategoryGender(tag);
    if (tagGender !== "unspecified") return tagGender;
  }
  return "unknown";
}
function voiceAge(voice) {
  for (const tag of voice.tags ?? []) {
    const value = tag.trim().toLowerCase();
    if (value === "young" || value === "middle aged" || value === "old") return value;
  }
  return "unknown";
}
function readFavoriteVoices(value) {
  if (!Array.isArray(value)) return [];
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  for (const item of value.slice(0, 500)) {
    if (!item || typeof item !== "object") continue;
    const row = item;
    if (typeof row.id !== "string") continue;
    const id = row.id.trim().slice(0, 512);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push({
      id,
      name: typeof row.name === "string" ? row.name.trim().slice(0, 128) : "",
      category: typeof row.category === "string" && row.category.trim() ? row.category.trim().slice(0, 64) : "unspecified",
      description: typeof row.description === "string" ? row.description.trim().slice(0, 500) : "",
      ...row.gender === "male" || row.gender === "female" ? { gender: row.gender } : {},
      ...typeof row.author === "string" && row.author.trim() ? { author: row.author.trim().slice(0, 128) } : {},
      ...row.source === "community" || row.source === "favorite" ? { source: row.source } : {},
      ...typeof row.communityLink === "string" && row.communityLink.trim() ? { communityLink: row.communityLink.trim().slice(0, 512) } : {},
      ...Array.isArray(row.tags) ? { tags: row.tags.filter((value2) => typeof value2 === "string").map((value2) => value2.trim().slice(0, 64)).filter(Boolean).slice(0, 32) } : {},
      ...Array.isArray(row.languages) ? { languages: row.languages.filter((value2) => typeof value2 === "string").map((value2) => value2.trim().slice(0, 32)).filter(Boolean).slice(0, 8) } : {}
    });
  }
  return result;
}
var FISH_LANGUAGE_WORDS = /* @__PURE__ */ new Set(["english", "japanese", "chinese", "french", "german", "spanish", "korean", "italian", "russian", "portuguese", "arabic", "hindi", "dutch", "polish", "turkish", "vietnamese", "thai", "indonesian", "en", "ja", "zh", "fr", "de", "es", "ko", "it", "ru", "pt", "ar", "hi", "nl", "pl", "tr", "vi", "th", "id"]);
function readCommunityVoice(row) {
  if (!row || typeof row !== "object") return null;
  const item = row;
  const id = typeof item._id === "string" ? item._id.trim().slice(0, 512) : "";
  if (!id) return null;
  const title = typeof item.title === "string" ? item.title.trim().slice(0, 128) : "";
  const description = typeof item.description === "string" ? item.description.trim().slice(0, 500) : "";
  const tags = Array.isArray(item.tags) ? item.tags.filter((value) => typeof value === "string").map((value) => value.trim().slice(0, 64)).filter(Boolean).slice(0, 16) : [];
  const languages = Array.isArray(item.languages) ? item.languages.filter((value) => typeof value === "string").map((value) => value.trim().slice(0, 32)).filter(Boolean).slice(0, 8) : [];
  const author = item.author && typeof item.author === "object" && typeof item.author.nickname === "string" ? item.author.nickname : "";
  const likeCount = typeof item.like_count === "number" && Number.isFinite(item.like_count) ? Math.max(0, Math.round(item.like_count)) : 0;
  const taskCount = typeof item.task_count === "number" && Number.isFinite(item.task_count) ? Math.max(0, Math.round(item.task_count)) : 0;
  const licensed = item.licensed === true;
  const classification = tags.find((tag) => !["male", "female"].includes(tag.toLowerCase()) && !FISH_LANGUAGE_WORDS.has(tag.toLowerCase()));
  return {
    id,
    title,
    description,
    category: classification ?? "",
    tags,
    languages,
    author: author.trim().slice(0, 128),
    likeCount,
    taskCount,
    licensed,
    licensedNote: licensed ? "Licensed by Fish Audio (rights secured from the voice owner)" : null,
    communityLink: `https://fish.audio/m/${id}`
  };
}
function readCommunityVoicePool(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 500).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item;
    const voice = readCommunityVoice(row);
    if (!voice) {
      const fallback = readFavoriteVoices([row]);
      return fallback;
    }
    return [communityVoiceToFavorite(voice)];
  });
}
function communityVoiceToFavorite(voice) {
  const gender = ["male", "female"].find((tag) => voice.tags.some((item) => item.toLowerCase() === tag));
  return {
    id: voice.id,
    name: voice.title,
    category: voice.category || (gender ?? "unspecified"),
    description: voice.description,
    ...gender ? { gender } : {},
    ...voice.author ? { author: voice.author } : {},
    source: "community",
    communityLink: voice.communityLink,
    ...voice.tags.length ? { tags: voice.tags } : {},
    ...voice.languages.length ? { languages: voice.languages } : {}
  };
}
function upsertCommunityFavorite(existing, voice) {
  const favorite = communityVoiceToFavorite(voice);
  const id = favorite.id.trim().slice(0, 512);
  if (!id) throw new Error("That community voice has no voice ID.");
  if (!existing.some((item) => item.id === id) && existing.length >= 500) throw new Error("The favorites list is limited to 500 voices.");
  if (existing.some((item) => item.id === id)) {
    return existing.map((item) => item.id === id ? { ...item, ...favorite, id } : item);
  }
  return [...existing, favorite];
}
function addFavoriteVoice(existing, voice) {
  const id = voice.id.trim().slice(0, 512);
  if (!id) throw new Error("Enter a voice ID to add a favorite.");
  if (existing.some((item) => item.id === id)) throw new Error("That voice ID is already a favorite.");
  if (existing.length >= 500) throw new Error("The favorites list is limited to 500 voices.");
  return [...existing, { ...voice, id }];
}
var GHOST_VOICE_LIFETIME_MESSAGES = 10;
function activeGhostVoices(ghosts, assistantMessageIds, targetId, lifetime = GHOST_VOICE_LIFETIME_MESSAGES) {
  const target = assistantMessageIds.indexOf(targetId);
  if (target < 0) return [];
  return ghosts.filter((ghost) => {
    if (ghost.occurrenceKeys.some((key) => key.startsWith(`${targetId}:`))) return true;
    const lastSeen = ghost.lastSeenMessageId ? assistantMessageIds.indexOf(ghost.lastSeenMessageId) : -1;
    const createdAt = ghost.createdAtMessageId ? assistantMessageIds.indexOf(ghost.createdAtMessageId) : -1;
    const invokedAt = ghost.lastInvokedAtMessageId ? assistantMessageIds.indexOf(ghost.lastInvokedAtMessageId) : -1;
    const earlierOccurrences = ghost.occurrenceKeys.map((key) => assistantMessageIds.indexOf(key.split(":", 1)[0])).filter((index) => index >= 0 && index <= target);
    const activeSince = Math.max(lastSeen <= target ? lastSeen : -1, createdAt <= target ? createdAt : -1, invokedAt <= target ? invokedAt : -1, ...earlierOccurrences);
    return (activeSince >= 0 || !ghost.lastSeenMessageId) && activeSince <= target && target - activeSince <= Math.max(1, lifetime);
  });
}
function hasStrongNarrativeName(text) {
  const narrative = narrativeOnly(text);
  for (const match of narrative.matchAll(/\b([\p{Lu}][\p{Ll}\p{M}'’-]{1,39})\s+(?:is|was|has|had|stands|stood|sits|sat|turns|turned|looks|looked|says|said|asks|asked|answers|answered|replies|replied|huffs|huffed|slaps|slapped|calls|called|shouts|shouted|speaks|spoke|mutters|muttered|laughs|laughed|glances|glanced|walks|walked|moves|moved|steps|stepped|nods|nodded)\b/gu)) {
    const name = normalizeSpeakerName(match[1]);
    if (name && !NON_NAME_PARAGRAPH_LEADS.has(name.toLowerCase())) return true;
  }
  return false;
}
var STORY_NARRATION_SKIP_STARTERS = /* @__PURE__ */ new Set(["then", "so", "and", "but", "still", "yet", "meanwhile", "now", "anyway"]);
var STORY_MALE_PRONOUNS = /* @__PURE__ */ new Set(["he", "him", "hisself", "himself", "his"]);
var STORY_FEMALE_PRONOUNS = /* @__PURE__ */ new Set(["she", "her", "herself", "hers"]);
function narrationFirstPronounClass(text) {
  const tokens = text.toLowerCase().replace(/[^a-z'-]+/gu, " ").split(/\s+/u).filter(Boolean);
  let head = tokens[0];
  if (!head) return null;
  if (STORY_NARRATION_SKIP_STARTERS.has(head)) head = tokens[1] ?? "";
  if (STORY_MALE_PRONOUNS.has(head)) return "male";
  if (STORY_FEMALE_PRONOUNS.has(head)) return "female";
  return null;
}
function backwardNarrationPronounGender(segments, fromIndex) {
  const castNames = /* @__PURE__ */ new Set();
  for (const segment of segments) {
    const id = segment.speakerId;
    if (id?.startsWith("npc:") || id?.startsWith("unconfigured:")) {
      const name = id.slice(id.indexOf(":") + 1).trim().toLowerCase();
      if (name) castNames.add(name);
    }
  }
  const mentionsCastCharacter = (text) => {
    if (!castNames.size) return false;
    const words = new Set(text.toLowerCase().replace(/[^a-z'-]+/gu, " ").split(/\s+/u).filter(Boolean));
    for (const name of castNames) if (words.has(name)) return true;
    return false;
  };
  for (let index = fromIndex - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (!segment || segment.speakerId !== null) continue;
    const paragraphs = segment.text.split(/\n\s*\n/u).filter((paragraph) => paragraph.trim());
    for (let paragraphIndex = paragraphs.length - 1; paragraphIndex >= 0; paragraphIndex -= 1) {
      const text = paragraphs[paragraphIndex];
      if (mentionsCastCharacter(text)) continue;
      if (/(^|[.!?]\s+)(another|second|third|other)\s+(man|woman|girl|boy|lady|guy)\b/iu.test(text)) return null;
      const introduction = text.match(/(?:^|[.!?]\s+)(?:a|an|the|one)\s+(man|woman|girl|boy|lady|guy)(?:\s+\w+){0,2}?\s+(?:came|entered|arrived|appeared|walked in|stepped in|strode in|drew close)\b/iu);
      if (introduction) return labelGenderHint(`the ${introduction[1]}`);
      const klass = narrationFirstPronounClass(text);
      if (klass) return klass;
    }
  }
  return null;
}
function collectUncastVoiceGroups(segments) {
  const groups = [];
  const named = /* @__PURE__ */ new Map();
  let anonymous = null;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const id = segment.speakerId;
    if (segment.debugPath?.some((step) => step.startsWith("segment-type:narration"))) continue;
    if (id === null) continue;
    if (id !== UNCAST_SPEAKER_ID && !id.startsWith("unconfigured:") && !id.startsWith("ghost:")) {
      anonymous = null;
      continue;
    }
    if (id !== UNCAST_SPEAKER_ID) anonymous = null;
    if (id === UNCAST_SPEAKER_ID && segments[index - 1]?.speakerId === null && segments[index - 1].text.length > 240) anonymous = null;
    if (id === UNCAST_SPEAKER_ID && segments[index - 1]?.speakerId === null && hasStrongNarrativeName(segments[index - 1].text)) anonymous = null;
    if (id === UNCAST_SPEAKER_ID && segments[index - 1]?.speakerId === UNCAST_SPEAKER_ID && segments[index - 2]?.speakerId === null && hasStrongNarrativeName(segments[index - 2].text)) anonymous = null;
    let group = id === UNCAST_SPEAKER_ID ? anonymous : named.get(id);
    if (!group) {
      group = { id: `g${groups.length}`, speakerId: id, segmentIndexes: [], speeches: [], context: [] };
      groups.push(group);
      if (id === UNCAST_SPEAKER_ID) anonymous = group;
      else {
        named.set(id, group);
        anonymous = null;
      }
    }
    group.segmentIndexes.push(index);
    group.speeches.push(segment.text);
    group.context.push([
      segments[index - 1]?.speakerId === null ? segments[index - 1].text : "",
      segment.text,
      segments[index + 1]?.speakerId === null ? segments[index + 1].text : ""
    ].filter(Boolean).join(" ").slice(0, 2e3));
  }
  for (const group of groups) {
    const addressee = addressedNameBeforeGroup(group, segments);
    if (addressee) group.addressee = addressee;
  }
  for (const group of groups) {
    if (group.speakerId === UNCAST_SPEAKER_ID) continue;
    const first = Math.min(...group.segmentIndexes);
    const invokerIndex = adjacentQuoteIndex(segments, first, -1);
    if (invokerIndex < 0 || segments[invokerIndex].speakerId !== UNCAST_SPEAKER_ID) continue;
    const invoked = vocativeNames(segments[invokerIndex].text)[0];
    if (!invoked) continue;
    group.narratedName = invoked;
    const invoker = groups.find((item) => item.speakerId === UNCAST_SPEAKER_ID && item.segmentIndexes.includes(invokerIndex));
    if (!invoker) continue;
    group.flankPartners = [...group.flankPartners ?? [], invoker.id];
    invoker.flankPartners = [...invoker.flankPartners ?? [], group.id];
  }
  for (const group of groups) {
    const first = Math.min(...group.segmentIndexes);
    const lead = segments[first - 1];
    if (!lead || lead.speakerId !== null) continue;
    const named2 = lead.text.match(/^([A-Z][a-z]{2,})\s+(?:says|said|murmurs|murmured|whispers|whispered|mutters|muttered|replies|replied|answers|answered|calls|called)\b/u);
    if (named2) group.narratedName = named2[1].toLowerCase();
  }
  for (const group of groups) {
    if (group.addressee) continue;
    const last = Math.max(...group.segmentIndexes);
    const nextIndex = adjacentQuoteIndex(segments, last, 1);
    const next = nextIndex >= 0 ? segments[nextIndex] : void 0;
    if (!next || next.speakerId === UNCAST_SPEAKER_ID) continue;
    const named2 = vocativeNames(next.text).find((name) => name !== group.speakerId.replace(/^unconfigured:/u, ""));
    if (named2) group.addressee = named2;
  }
  for (const group of groups) {
    const invoking = segments.findIndex((segment, index) => index < Math.min(...group.segmentIndexes) && segment.speakerId !== null && segment.speakerId !== UNCAST_SPEAKER_ID && new RegExp(`(?:^|,\\s*)${group.addressee}\\s*[.!?,]`, "iu").test(segment.text));
    if (invoking < 0) continue;
    const priorSpeech = segments.slice(0, invoking).reduce((found, segment, index) => segment.speakerId === null ? found : index, void 0);
    const before = priorSpeech === void 0 ? void 0 : groups.find((item) => item !== group && item.speakerId === UNCAST_SPEAKER_ID && item.segmentIndexes.includes(priorSpeech) && segments[priorSpeech].speakerId !== segments[invoking].speakerId);
    const after = group;
    if (before) {
      after.flankPartners = [...after.flankPartners ?? [], before.id];
      before.flankPartners = [...before.flankPartners ?? [], after.id];
    }
  }
  const unnamedInOrder = groups.filter((group) => group.speakerId === UNCAST_SPEAKER_ID).sort((a, b) => Math.min(...a.segmentIndexes) - Math.min(...b.segmentIndexes));
  for (const group of unnamedInOrder) {
    group.pronounGender = backwardNarrationPronounGender(segments, Math.min(...group.segmentIndexes)) ?? void 0;
  }
  for (let index = 1; index < unnamedInOrder.length; index += 1) {
    const previous = unnamedInOrder[index - 1];
    const group = unnamedInOrder[index];
    const gender = group.pronounGender;
    if (!gender || gender !== previous.pronounGender) {
      group.pronounGender = void 0;
      continue;
    }
    previous.pronounPartners = [...previous.pronounPartners ?? [], group.id];
    group.pronounPartners = [...group.pronounPartners ?? [], previous.id];
  }
  const unknownGroups = groups.filter((group) => group.speakerId === UNCAST_SPEAKER_ID);
  const invokedByGroup = new Map(unknownGroups.map((group) => [group.id, [...new Set(group.speeches.flatMap((speech) => vocativeNames(speech)))]]));
  const invokingGroups = unknownGroups.filter((group) => invokedByGroup.get(group.id)?.length === 1);
  const knownNames = /* @__PURE__ */ new Set();
  for (const segment of segments) {
    const id = segment.speakerId;
    if (!id || id === UNCAST_SPEAKER_ID || id.startsWith("unconfigured:") || id.startsWith("ghost:") || id === USER_SPEAKER_ID || id === UNRESOLVED_SPEAKER_ID) continue;
    knownNames.add(id.includes(":") ? id.slice(id.indexOf(":") + 1).toLowerCase() : id.toLowerCase());
  }
  const invokedCounts = /* @__PURE__ */ new Map();
  for (const names of invokedByGroup.values()) for (const name of names) invokedCounts.set(name, (invokedCounts.get(name) ?? 0) + 1);
  const nameIsEligible = (name) => !isBroadPersonLabel(name) && !knownNames.has(name) && invokedCounts.get(name) === 1;
  if (invokingGroups.length === 2) {
    const [a, b] = invokingGroups;
    const invokedA = invokedByGroup.get(a.id)[0];
    const invokedB = invokedByGroup.get(b.id)[0];
    if (invokedA !== invokedB && nameIsEligible(invokedA) && nameIsEligible(invokedB)) {
      a.inferredName = invokedB;
      b.inferredName = invokedA;
      a.addressee = invokedB;
      b.addressee = invokedA;
    }
  } else if (invokingGroups.length === 1) {
    const invoker = invokingGroups[0];
    const invoked = invokedByGroup.get(invoker.id)[0];
    if (nameIsEligible(invoked) && unknownGroups.length >= 2) {
      const sorted = [...unknownGroups].sort((x, y) => Math.min(...x.segmentIndexes) - Math.min(...y.segmentIndexes));
      const index = sorted.indexOf(invoker);
      const candidates = [sorted[index + 1], sorted[index - 1]].filter(Boolean);
      const distance = (a, b) => Math.min(...a.segmentIndexes.flatMap((x) => b.segmentIndexes.map((y) => Math.abs(x - y))));
      candidates.sort((x, y) => distance(x, invoker) - distance(y, invoker) || (x === sorted[index + 1] ? -1 : 1) - (y === sorted[index + 1] ? -1 : 1));
      const partner = candidates.find((candidate) => !candidate.inferredName && invokedByGroup.get(candidate.id)?.length === 0);
      if (partner) {
        partner.inferredName = invoked;
        partner.addressee = invoked;
      }
    }
  }
  return groups;
}
function availableUncastVoices(favorites, used) {
  const reserved = new Set(used.map((voice) => voice.trim()).filter(Boolean));
  return favorites.filter((voice) => !reserved.has(voice.id));
}
function adjacentQuoteIndex(segments, from, step) {
  for (let index = from + step; index >= 0 && index < segments.length; index += step) {
    const segment = segments[index];
    if (segment.speakerId !== null) return index;
    if (uncastNarrativeNameCandidates(segment.text).length || /^[A-Z][a-z]{2,}\s+(?:says|said|murmurs|murmured|whispers|whispered|mutters|muttered|replies|replied|answers|answered|calls|called)\b/u.test(segment.text)) {
      if (narrationNamesInvokedSpeaker(segments, index)) continue;
      return -1;
    }
  }
  return -1;
}
function narrationNamesInvokedSpeaker(segments, index) {
  const named = segments[index].text.match(/^([A-Z][a-z]{2,})\s+(?:says|said|murmurs|murmured|whispers|whispered|mutters|muttered|replies|replied|answers|answered|calls|called)\b/u);
  if (!named) return false;
  const name = named[1].toLowerCase();
  return [segments[index - 1], segments[index + 1]].some((quote) => !!quote && quote.speakerId !== null && vocativeNames(quote.text).includes(name));
}
var UNCAST_VOCATIVE_STOPWORDS = /* @__PURE__ */ new Set(["okay", "yeah", "yes", "no", "hello", "hey", "please", "thanks", "sorry", "listen", "look", "wait", "fine", "well", "honey", "sweetie", "darling", "first", "second", "third", "fourth", "fifth", "last", "next", "one", "two", "three", "four", "five", "once", "twice", "again", "then"]);
function vocativeNames(quote) {
  const found = /* @__PURE__ */ new Set();
  const text = quote.trim();
  const push = (raw, prefix) => {
    const name = raw.toLowerCase();
    if (!name || UNCAST_VOCATIVE_STOPWORDS.has(name)) return;
    if (/\b(?:on|at|to|for|with|about|from|of|by)\s*$/iu.test(prefix)) return;
    found.add(name);
  };
  const leading = text.match(/^(?:[A-Za-z' ]+,\s*)?([A-Z][A-Za-z'-]*)\s*([.!?,;:])(?!\w)/u);
  if (leading) push(leading[1], text.slice(0, text.indexOf(leading[1])));
  for (const match of text.matchAll(/,\s*([A-Z][A-Za-z'-]*)\s*[.!?]/gu)) {
    push(match[1], text.slice(0, match.index));
  }
  return [...found];
}
function addressedNameBeforeGroup(group, segments) {
  if (group.speakerId !== UNCAST_SPEAKER_ID) return "";
  const first = Math.min(...group.segmentIndexes);
  const previousIndex = adjacentQuoteIndex(segments, first, -1);
  const previous = previousIndex >= 0 ? segments[previousIndex] : void 0;
  if (!previous || previous.speakerId === UNCAST_SPEAKER_ID) return "";
  for (const name of vocativeNames(previous.text)) {
    if (!UNCAST_VOCATIVE_STOPWORDS.has(name)) return name;
  }
  return "";
}
function uncastNarrativeNameCandidates(message) {
  const names = /* @__PURE__ */ new Map();
  const narrative = narrativeOnly(message);
  const pattern = /\b([\p{Lu}][\p{Ll}\p{M}'’-]{1,39})\s+(?:is|was|has|had|stands|stood|sits|sat|turns|turned|looks|looked|says|said|asks|asked|answers|answered|replies|replied)\b/gu;
  for (const match of narrative.matchAll(pattern)) {
    const name = normalizeSpeakerName(match[1]);
    if (!name || NON_NAME_PARAGRAPH_LEADS.has(name.toLowerCase())) continue;
    names.set(name.toLowerCase(), name);
    if (names.size >= 20) break;
  }
  const actions = /\b([\p{Lu}][\p{Ll}\p{M}'’-]{1,39})\s+(?:huffs|huffed|slaps|slapped|calls|called|shouts|shouted|speaks|spoke|mutters|muttered|laughs|laughed|glances|glanced|walks|walked|moves|moved|steps|stepped|nods|nodded)\b/gu;
  for (const match of narrative.matchAll(actions)) {
    const name = normalizeSpeakerName(match[1]);
    if (!name || NON_NAME_PARAGRAPH_LEADS.has(name.toLowerCase())) continue;
    names.set(name.toLowerCase(), name);
    if (names.size >= 20) break;
  }
  const dashed = /(?:—+|–+|--+|-)\s*([\p{Lu}][\p{Ll}\p{M}'’-]{1,39})\s*(?:—+|–+|--+|-|,)/gu;
  for (const match of narrative.matchAll(dashed)) {
    const name = normalizeSpeakerName(match[1]);
    if (!name || NON_NAME_PARAGRAPH_LEADS.has(name.toLowerCase())) continue;
    names.set(name.toLowerCase(), name);
    if (names.size >= 20) break;
  }
  return [...names.values()];
}
function isBroadPersonLabel(label) {
  return /^(?:(?:the|a|an)\s+)?(?:(?:young|younger|old|older|elderly|middle-aged|tall|short)\s+)*(?:woman|man|person|girl|boy|guy|lady|stranger|someone|somebody)$/iu.test(label.trim());
}
var LABEL_GENDER_TOKENS = new Map(
  [
    ...["girl", "girls", "woman", "women", "lady", "ladies", "female", "females", "mother", "mothers", "mum", "mums", "mom", "moms", "sister", "sisters", "wife", "wives", "daughter", "daughters", "aunt", "aunts", "niece", "nieces", "grandmother", "grandmothers", "grandma", "grandmas", "granny", "grannies", "nanny", "nannies", "maid", "maids", "bride", "brides", "princess", "princesses", "madam", "mrs", "miss", "she", "her", "hers", "herself"].map((token) => [token, "female"]),
    ...["boy", "boys", "man", "men", "gentleman", "gentlemen", "male", "males", "father", "fathers", "dad", "dads", "brother", "brothers", "husband", "husbands", "son", "sons", "uncle", "uncles", "nephew", "nephews", "grandfather", "grandfathers", "grandpa", "grandpas", "groom", "grooms", "prince", "princes", "monk", "monks", "guy", "guys", "mr", "sir", "he", "him", "his", "himself"].map((token) => [token, "male"])
  ]
);
function labelGenderHint(label) {
  const genders = /* @__PURE__ */ new Set();
  for (const token of label.toLowerCase().replace(/[^a-z]+/gu, " ").split(/\s+/u)) {
    if (!token) continue;
    const gender = LABEL_GENDER_TOKENS.get(token);
    if (gender) {
      genders.add(gender);
      if (genders.size > 1) return null;
    }
  }
  return genders.size === 1 ? [...genders][0] : null;
}
function speakersForMessageRole(speakers, _isUserMessage, userName = "User") {
  const nonUserSpeakers = speakers.filter((speaker) => speaker.id !== USER_SPEAKER_ID);
  return [
    ...nonUserSpeakers,
    { id: USER_SPEAKER_ID, name: normalizeSpeakerName(userName) || "User" }
  ];
}
function speakerAssignmentSourceFromTrace(steps, localFallback) {
  const resolution = steps.find((step) => step.startsWith("resolution:"));
  if (resolution?.startsWith("resolution:best-available speaker")) return "best-available";
  if (resolution?.startsWith("resolution:chain-identity (overrode")) return "chain-override";
  if (resolution?.startsWith("resolution:chain-identity")) return "chain-fill";
  if (resolution?.startsWith("resolution:discourse-identity (overrode")) return "discourse-override";
  if (resolution?.startsWith("resolution:discourse-identity")) return "discourse-fill";
  if (resolution?.startsWith("resolution:global-context confirmed")) return "contextual-confirmation";
  if (resolution?.startsWith("resolution:global-context review")) {
    if (steps.includes("jev-opening-exchange:strong single-speaker review applied")) return "opening-exchange";
    if (steps.includes("jev-opening-backlink:accepted same-speaker link to later validated quote")) return "opening-backlink";
    if (steps.includes("jev-opening-forwardlink:accepted same-speaker link to earlier validated quote")) return "opening-forwardlink";
    return "contextual-review";
  }
  if (resolution === "resolution:direct-speech-identity") return steps.includes("jev-user-review:strong alternative applied") ? "contextual-review" : "first-pass";
  if (resolution?.startsWith("resolution:upstream-identity")) return "inheritance";
  if (resolution?.startsWith("resolution:previous-assistant")) return "previous-assistant";
  if (resolution?.startsWith("resolution:unique card-title")) return "card-title";
  if (resolution?.startsWith("resolution:user-role") || resolution?.startsWith("resolution:unresolved speech") || resolution?.startsWith("resolution:assistant connection-default")) return "role-fallback";
  if (localFallback || steps.some((step) => step.startsWith("jev-fallback:") || step.startsWith("jev-disabled:"))) return "local-parser";
  return "unreported";
}
function filterNarrationSegments(segments, skipNarration) {
  return skipNarration ? segments.filter((segment) => segment.speakerId !== null) : segments;
}
function playbackVoiceForSpeaker(speakerId, isUserMessage, characterVoices, narratorVoice, userVoice) {
  if (speakerId === USER_SPEAKER_ID) return userVoice;
  if (speakerId) return characterVoices[speakerId] || "";
  return narratorVoice;
}
function markUnresolvedSpeechSegments(segments, includeDebug = false) {
  return segments.map((segment) => {
    const isSpeech = segment.debugPath?.some((step) => step.startsWith("segment-type:speech")) ?? false;
    const { debugPath, ...plain } = segment;
    const speakerId = isSpeech && segment.speakerId === null ? UNRESOLVED_SPEAKER_ID : segment.speakerId;
    return includeDebug ? { ...segment, speakerId } : { ...plain, speakerId };
  });
}
function shouldPersistMessageAudio(isUserMessage, saveGeneratedAudio, regeneratingSavedAudio) {
  return !isUserMessage && (saveGeneratedAudio || regeneratingSavedAudio);
}
function rollingRequestWindowDelay(recentStarts, now, requestLimit, windowMs = 6e4) {
  const safeLimit = Math.max(1, Math.round(requestLimit));
  const safeWindow = Math.max(1, Math.round(windowMs));
  const activeStarts = recentStarts.filter((start) => Number.isFinite(start) && start > now - safeWindow && start <= now).sort((left, right) => left - right);
  if (activeStarts.length < safeLimit) return 0;
  const limitingStart = activeStarts[activeStarts.length - safeLimit] ?? now;
  return Math.max(0, limitingStart + safeWindow - now);
}
function reducedRequestWindowLimit(current, minimum = 6) {
  const safeMinimum = Math.max(1, Math.round(minimum));
  return Math.max(safeMinimum, Math.floor(Math.max(safeMinimum, current) / 2));
}
function adaptiveGenerationConcurrency(current, configuredMaximum, segmentLengths, shortCooldown = 0, longWindowStreak = 0, maximum = 10, voiceChanges = 0) {
  const safeMaximum = Math.max(1, Math.round(maximum));
  const safeConfiguredMaximum = Math.min(safeMaximum, Math.max(1, Math.round(configuredMaximum)));
  const safeCurrent = Math.min(safeConfiguredMaximum, Math.max(1, Math.round(current)));
  const safeCooldown = Math.max(0, Math.round(shortCooldown));
  const safeLongStreak = Math.max(0, Math.round(longWindowStreak));
  const lengths = segmentLengths.filter((length) => Number.isFinite(length) && length >= 0);
  if (lengths.length === 0) {
    return { concurrency: safeCurrent, shortCooldown: safeCooldown, longWindowStreak: safeLongStreak };
  }
  const sorted = [...lengths].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const medianLength = sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : sorted[middle] ?? 0;
  const lowerQuartileLength = sorted[Math.floor((sorted.length - 1) * 0.25)] ?? 0;
  const shortCount = lengths.filter((length) => length < 160).length;
  const mixedDenseWindow = lengths.length >= 4 && lowerQuartileLength < 220;
  if (shortCount >= 3 || medianLength < 200 || mixedDenseWindow || voiceChanges >= 3) {
    return { concurrency: 1, shortCooldown: 6, longWindowStreak: 0 };
  }
  if (safeCooldown > 0) {
    return { concurrency: 1, shortCooldown: safeCooldown - 1, longWindowStreak: 0 };
  }
  const uniformlyLongWindow = lengths.length >= 3 && Math.min(...lengths) >= 300 && lowerQuartileLength > 320 && medianLength > 420;
  if (uniformlyLongWindow) {
    const nextStreak = safeLongStreak + 1;
    if (nextStreak >= 2) {
      return {
        concurrency: Math.min(safeConfiguredMaximum, safeCurrent + 1),
        shortCooldown: 0,
        longWindowStreak: 0
      };
    }
    return { concurrency: safeCurrent, shortCooldown: 0, longWindowStreak: nextStreak };
  }
  return { concurrency: safeCurrent, shortCooldown: 0, longWindowStreak: 0 };
}
function bufferAwareGenerationConcurrency(current, configuredMaximum, readyAhead, targetBuffer, adaptiveBaseline, rateLimited = false, maximum = 10) {
  if (rateLimited) return 1;
  const ceiling = Math.min(
    Math.max(1, Math.round(maximum)),
    Math.max(1, Math.round(configuredMaximum))
  );
  const safeCurrent = Math.min(ceiling, Math.max(1, Math.round(current)));
  const safeBaseline = Math.min(ceiling, Math.max(1, Math.round(adaptiveBaseline)));
  const ready = Math.max(0, Math.round(readyAhead));
  const target = Math.max(1, Math.round(targetBuffer));
  if (ready >= target || ceiling === 1) return safeBaseline;
  return Math.min(ceiling, Math.max(2, safeCurrent + 1));
}
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
    const gain = Number.isFinite(segment.gain) ? Math.max(0, segment.gain ?? 1) : 1;
    for (let frame = 0; frame < outputFrames; frame += 1) {
      const sourcePosition = outputFrames === 1 ? 0 : frame * (sourceFrames - 1) / (outputFrames - 1);
      const lower = Math.floor(sourcePosition);
      const upper = Math.min(sourceFrames - 1, lower + 1);
      const fraction = sourcePosition - lower;
      for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
        const channel = segment.channels[Math.min(channelIndex, segment.channels.length - 1)];
        const lowerValue = channel[Math.min(lower, channel.length - 1)] ?? 0;
        const upperValue = channel[Math.min(upper, channel.length - 1)] ?? lowerValue;
        const sample = Math.max(-1, Math.min(1, (lowerValue + (upperValue - lowerValue) * fraction) * gain));
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
    for (const text of paragraphs) {
      result.push({
        text,
        voice: segment.voice,
        ...segment.tagId ? { tagId: segment.tagId } : {}
      });
    }
  }
  return result;
}
var DEFAULT_MAX_TTS_SEGMENT_CHARS = 360;
function normalizeSpeechBoundaryDashes(text) {
  return text.replace(/^((?:\s*(?:\[[^\]\r\n]+\]|<[^>\r\n]+>))*\s*)[—–]\s*/u, "$1").trim();
}
function splitLargeVoicePlanSegments(segments, maximumChars = DEFAULT_MAX_TTS_SEGMENT_CHARS) {
  const limit = Math.max(80, Math.round(maximumChars));
  const result = [];
  for (const segment of segments) {
    let remaining = segment.text.trim();
    while (remaining.length > limit) {
      const window2 = remaining.slice(0, limit + 1);
      const sentenceBreaks = [];
      const clauseBreaks = [];
      const wordBreaks = [];
      let bracketDepth = 0;
      for (let index = 0; index < window2.length; index += 1) {
        const character = window2[index];
        if (character === "[") bracketDepth += 1;
        else if (character === "]" && bracketDepth > 0) bracketDepth -= 1;
        if (bracketDepth > 0 || !/\s/u.test(character)) continue;
        wordBreaks.push(index);
        let previousIndex = index - 1;
        while (previousIndex >= 0 && /["”’')\]]/u.test(window2[previousIndex])) previousIndex -= 1;
        const previous = window2[previousIndex] ?? "";
        if (/[.!?…]/u.test(previous)) sentenceBreaks.push(index);
        else if (/[,;:—–]/u.test(previous)) clauseBreaks.push(index);
      }
      const latestAtOrAfter = (candidates, minimum) => [...candidates].reverse().find((position) => position >= minimum);
      const splitAt = latestAtOrAfter(sentenceBreaks, Math.floor(limit * 0.35)) ?? latestAtOrAfter(clauseBreaks, Math.floor(limit * 0.55)) ?? latestAtOrAfter(wordBreaks, Math.floor(limit * 0.7)) ?? wordBreaks.at(-1) ?? limit;
      const text = remaining.slice(0, splitAt).trim();
      if (!text) break;
      result.push({
        text,
        voice: segment.voice,
        ...segment.tagId ? { tagId: segment.tagId } : {}
      });
      remaining = remaining.slice(splitAt).trim();
    }
    if (remaining) {
      result.push({
        text: remaining,
        voice: segment.voice,
        ...segment.tagId ? { tagId: segment.tagId } : {}
      });
    }
  }
  return result;
}
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function clampSavedAudioLimit(value) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_SAVED_AUDIO_LIMIT;
  return Math.min(MAX_SAVED_AUDIO_LIMIT, Math.max(1, Math.round(numeric)));
}
function readSavedAudioHistory(value) {
  if (!Array.isArray(value)) return [];
  const records = [];
  const seenAudioIds = /* @__PURE__ */ new Set();
  for (const item of value.slice(-MAX_SAVED_AUDIO_LIMIT)) {
    if (!isRecord(item)) continue;
    const chatId = typeof item.chatId === "string" ? item.chatId : "";
    const messageId = typeof item.messageId === "string" ? item.messageId : "";
    const audioId = typeof item.audioId === "string" ? item.audioId : "";
    const swipeId = typeof item.swipeId === "number" ? Math.max(0, Math.round(item.swipeId)) : NaN;
    const savedAt = typeof item.savedAt === "number" ? item.savedAt : NaN;
    if (!chatId || !messageId || !audioId || !Number.isFinite(swipeId) || !Number.isFinite(savedAt)) continue;
    if (seenAudioIds.has(audioId)) continue;
    seenAudioIds.add(audioId);
    records.push({ chatId, messageId, audioId, swipeId, savedAt });
  }
  return records;
}
function upsertSavedAudioRecord(records, next) {
  return [
    ...records.filter((record) => record.audioId !== next.audioId && !(record.chatId === next.chatId && record.messageId === next.messageId && record.swipeId === next.swipeId)),
    next
  ];
}
function expiredSavedAudioRecords(records, limit) {
  const overflow = Math.max(0, records.length - clampSavedAudioLimit(limit));
  return [...records].sort((left, right) => left.savedAt - right.savedAt).slice(0, overflow);
}
function hashMessageContent(content) {
  let hash = 2166136261;
  for (let index = 0; index < content.length; index++) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${content.length.toString(36)}-${(hash >>> 0).toString(36)}`;
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
var PREPOSITION_WORDS = [
  "above",
  "across",
  "after",
  "against",
  "along",
  "amid",
  "among",
  "around",
  "as",
  "at",
  "before",
  "behind",
  "below",
  "beneath",
  "beside",
  "between",
  "beyond",
  "by",
  "despite",
  "down",
  "during",
  "except",
  "for",
  "from",
  "in",
  "inside",
  "into",
  "like",
  "near",
  "of",
  "off",
  "on",
  "onto",
  "opposite",
  "out",
  "outside",
  "over",
  "past",
  "since",
  "through",
  "throughout",
  "to",
  "toward",
  "towards",
  "under",
  "underneath",
  "unlike",
  "until",
  "up",
  "upon",
  "via",
  "with",
  "within",
  "without"
];
var NON_NAME_PARAGRAPH_LEADS = /* @__PURE__ */ new Set([
  ...PREPOSITION_WORDS,
  "a",
  "an",
  "although",
  "and",
  "because",
  "but",
  "he",
  "her",
  "here",
  "his",
  "if",
  "it",
  "its",
  "or",
  "she",
  "so",
  "somebody",
  "someone",
  "anybody",
  "anyone",
  "nobody",
  "noone",
  "everybody",
  "everyone",
  "somewhere",
  "that",
  "the",
  "their",
  "then",
  "there",
  "they",
  "this",
  "those",
  "though",
  "unless",
  "we",
  "when",
  "where",
  "whereas",
  "whether",
  "while",
  "who",
  "whom",
  "whose",
  "you",
  "your"
]);
var PREPOSITION_BEFORE_NAME_PATTERN = new RegExp(
  `\\b(?:${PREPOSITION_WORDS.join("|")})\\s*$`,
  "iu"
);
var INTRODUCTORY_PREPOSITIONAL_PHRASE_PATTERN = new RegExp(
  `^\\s*(?:${PREPOSITION_WORDS.join("|")})\\b(?:\\s+[\\p{L}\\p{M}'\u2019-]+){1,7}\\s*,?\\s*$`,
  "iu"
);
function unconfiguredSpeakerId(name) {
  return `unconfigured:${normalizeSpeakerName(name).toLowerCase()}`;
}
function addUnconfiguredDialogueSpeakers(content, speakers, skippedTrackerTagPairs = "") {
  const preparedContent = preparePlaybackContent(content, skippedTrackerTagPairs);
  const result = [...speakers];
  const knownAliases = new Set(result.flatMap((speaker) => speakerAliases(speaker.name).map((alias) => alias.toLowerCase())));
  const addCandidate = (rawName, explicitlyAttributed = false) => {
    const name = normalizeSpeakerName(rawName.replace(/['’]s$/u, ""));
    const aliases = speakerAliases(name);
    const first = aliases[0]?.split(/\s+/u)[0]?.toLowerCase() ?? "";
    if (!name || !first || NON_NAME_PARAGRAPH_LEADS.has(first)) return;
    if (aliases.some((alias) => knownAliases.has(alias.toLowerCase()))) return;
    if (!explicitlyAttributed) {
      const occurrences = [...preparedContent.matchAll(
        // A newly inferred proper name must repeat with the same capitalization.
        // This prevents sentence-leading descriptors such as "Quiet now" from
        // becoming characters merely because the word appears elsewhere in prose.
        new RegExp(`\\b${escapedPattern(name)}(?:['\u2019]s)?\\b`, "gu")
      )].length;
      if (occurrences < 2) return;
    }
    const id = unconfiguredSpeakerId(name);
    if (result.some((speaker) => speaker.id === id)) return;
    result.push({ id, name });
    for (const alias of aliases) knownAliases.add(alias.toLowerCase());
  };
  const narrative = narrativeOnly(preparedContent);
  for (const match of narrative.matchAll(/\b([\p{Lu}][\p{L}\p{M}-]{1,63})['\u2019]s\s+[\p{L}\p{M}-]+/gu)) addCandidate(match[1]);
  for (const match of narrative.matchAll(/\b(?:and|but|then)\s+([\p{Lu}][\p{L}\p{M}-]{1,63})\s+[\p{Ll}][\p{L}\p{M}-]+/gu)) addCandidate(match[1]);
  for (const quote of playbackQuotes(preparedContent)) {
    for (const match of quote.text.matchAll(/\bI(?:'|\u2019)m\s+([\p{Lu}][\p{L}\p{M}-]{1,63})\b/gu)) addCandidate(match[1]);
  }
  const paragraphs = playbackParagraphs(preparedContent);
  for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex += 1) {
    const paragraph = paragraphs[paragraphIndex];
    const quotes = playbackQuotes(paragraph.text);
    if (quotes.length === 0) {
      const nextHasDialogue = paragraphIndex + 1 < paragraphs.length && playbackQuotes(paragraphs[paragraphIndex + 1].text).length > 0;
      if (!nextHasDialogue) continue;
      const narration = paragraph.text.replace(/^[\s,.;:!?—–-]+/u, "");
      const attributedLead = narration.match(
        new RegExp(
          `^([\\p{Lu}][\\p{L}\\p{M}'\u2019.\\-]{1,63})(?:(?:\\s*,\\s*[^,\\n]{1,60},\\s*)|\\s+)${SPEECH_VERBS}\\b`,
          "u"
        )
      )?.[1];
      if (attributedLead) addCandidate(attributedLead, true);
      else {
        const lead = narration.match(/^([\p{Lu}][\p{L}\p{M}'’.\-]{1,63})(?=\s)/u)?.[1];
        if (lead) addCandidate(lead);
      }
      continue;
    }
    let cursor = 0;
    for (const quote of quotes) {
      const narration = paragraph.text.slice(cursor, quote.start).replace(/^[\s,.;:!?—–-]+/u, "");
      const lead = narration.match(/^([\p{Lu}][\p{L}\p{M}'’.\-]{1,63})(?=\s)/u)?.[1];
      if (lead) addCandidate(lead);
      cursor = quote.end;
    }
    const trailingNarration = paragraph.text.slice(cursor).replace(/^[\s,.;:!?—–-]+/u, "");
    const trailingLead = trailingNarration.match(
      /^([\p{Lu}][\p{L}\p{M}'’.\-]{1,63}(?:\s+[\p{Lu}][\p{L}\p{M}'’.\-]{1,63}){0,2})(?=\s+(?:said|asked|answered|replied|whispered|murmured|called|shouted|added|continued|observed|remarked|gasped|breathed)\b)/u
    )?.[1];
    if (trailingLead) addCandidate(trailingLead, true);
    else {
      const lead = trailingNarration.match(/^([\p{Lu}][\p{L}\p{M}'’.\-]{1,63})(?=\s)/u)?.[1];
      if (lead) addCandidate(lead);
    }
  }
  return result;
}
function npcSpeakerId(name) {
  return `npc:${normalizeSpeakerName(name).toLowerCase()}`;
}
function speakerAliasIdLookup(speakers) {
  const aliases = /* @__PURE__ */ new Map();
  for (const speaker of speakers) {
    for (const alias of speakerAliases(speaker.name)) {
      aliases.set(npcSpeakerId(alias), speaker.id);
      aliases.set(unconfiguredSpeakerId(alias), speaker.id);
    }
  }
  return aliases;
}
function stripPlaybackMarkup(value) {
  return value.replace(/&lt;\/?(?:p|div|br)(?:\s[\s\S]*?)?&gt;/gi, "\n\n").replace(/\\?<\/?(?:p|div|br)(?:\s[^>]*)?>/gi, "\n\n").replace(/&lt;\/?[a-z][\s\S]*?&gt;/gi, " ").replace(/\\?<\/?[a-z][^>]*>/gi, " ").replace(/\[\/?(?:font|color|size|style|span|div|p|b|i|u|em|strong)(?:=[^\]]*)?\]/gi, " ").replace(/[*_~]+/g, " ");
}
function decodePlaybackEntities(value) {
  return value.replace(/&nbsp;/gi, " ").replace(/&quot;|&#34;|&#x22;/gi, '"').replace(/&apos;|&#39;|&#x27;/gi, "'").replace(/&lt;|&#60;|&#x3c;/gi, "<").replace(/&gt;|&#62;|&#x3e;/gi, ">").replace(/&amp;|&#38;|&#x26;/gi, "&");
}
var TRACKER_TAG_NAME_RE = /^[a-z][a-z0-9:._-]*$/u;
function normalizeTrackerTagName(value) {
  const tag = value.trim().toLowerCase();
  return TRACKER_TAG_NAME_RE.test(tag) ? tag : null;
}
function parseSkippedTrackerTagPairs(value) {
  const decoded = decodePlaybackEntities(value);
  const pairs = [];
  const seen = /* @__PURE__ */ new Set();
  const addPair = (open, close) => {
    if (!open || !close) return;
    const key = `${open}\0${close}`;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push({ open, close });
  };
  const addSymmetric = (name) => addPair(name, name);
  for (const entry of decoded.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const pairMatch = trimmed.match(
      /^\\?<\s*([a-z][a-z0-9:._-]*)(?=\s|>)[^>]*>\s*\\?<\s*\/\s*([a-z][a-z0-9:._-]*)(?=\s|>)[^>]*>$/iu
    );
    if (pairMatch) {
      addPair(
        normalizeTrackerTagName(pairMatch[1] ?? ""),
        normalizeTrackerTagName(pairMatch[2] ?? "")
      );
      if (pairs.length >= 100) return pairs;
      continue;
    }
    const tagMatch = trimmed.match(/^\\?<\s*([a-z][a-z0-9:._-]*)(?=\s|>)[^>]*>$/iu);
    if (tagMatch) {
      addSymmetric(normalizeTrackerTagName(tagMatch[1] ?? ""));
      if (pairs.length >= 100) return pairs;
      continue;
    }
    addSymmetric(normalizeTrackerTagName(trimmed));
    if (pairs.length >= 100) return pairs;
  }
  const legacyPattern = /\\?<\s*([a-z][a-z0-9:._-]*)(?=\s|>)[^>]*>[\s\S]*?\\?<\s*\/\s*\1\s*>/giu;
  for (const match of decoded.matchAll(legacyPattern)) {
    addSymmetric(normalizeTrackerTagName(match[1] ?? ""));
    if (pairs.length >= 100) break;
  }
  return pairs;
}
function stripTagBlock(value, openTag, closeTag) {
  const open = escapedPattern(openTag);
  const close = escapedPattern(closeTag);
  const tokenPattern = new RegExp(
    `(\\\\?<\\s*${open}(?=\\s|>)[^>]*>)|(\\\\?<\\s*\\/\\s*${close}(?=\\s|>)[^>]*>)`,
    "giu"
  );
  const ranges = [];
  let depth = 0;
  let blockStart = -1;
  for (const match of value.matchAll(tokenPattern)) {
    if (match.index === void 0) continue;
    const opening = match[1] !== void 0;
    if (opening) {
      if (!/\/\s*>$/u.test(match[0])) {
        if (depth === 0) blockStart = match.index;
        depth += 1;
      }
    } else if (depth > 0) {
      depth -= 1;
      if (depth === 0 && blockStart >= 0) {
        ranges.push({ start: blockStart, end: match.index + match[0].length });
        blockStart = -1;
      }
    }
  }
  if (ranges.length === 0) return value;
  let result = value;
  for (let index = ranges.length - 1; index >= 0; index--) {
    result = `${result.slice(0, ranges[index].start)} ${result.slice(ranges[index].end)}`;
  }
  return result;
}
function stripSkippedTrackerBlocks(content, tagPairs) {
  let result = content.replace(/&lt;|&#60;|&#x3c;/gi, "<").replace(/&gt;|&#62;|&#x3e;/gi, ">").replace(/<!--[\s\S]*?-->/g, " ");
  for (const pair of parseSkippedTrackerTagPairs(tagPairs)) {
    result = stripTagBlock(result, pair.open, pair.close);
  }
  return result;
}
function preparePlaybackContent(content, skippedTrackerTagPairs = "") {
  return stripPlaybackMarkup(stripSkippedTrackerBlocks(content, skippedTrackerTagPairs)).replace(/&quot;|&#34;|&#x22;/giu, '"').replace(/["“”]{2,}/gu, '"');
}
function cleanPlaybackText(value) {
  return decodePlaybackEntities(stripPlaybackMarkup(value)).replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ").replace(/\r\n?/g, "\n").replace(/[^\S\n]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
var SPEECH_VERBS = "(?:said|says|asked|asks|replied|replies|whispered|whispers|shouted|shouts|yelled|yells|called|calls|murmured|murmurs|answered|answers|added|adds|continued|continues|remarked|remarks|cried|cries|growled|growls|sighed|sighs)";
function escapedPattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function narrativeOnly(text) {
  const quotes = playbackQuotes(text);
  if (quotes.length === 0) return text;
  let result = "";
  let cursor = 0;
  for (const quote of quotes) {
    result += `${text.slice(cursor, quote.start)} `;
    cursor = quote.end;
  }
  return result + text.slice(cursor);
}
function mentionedSpeakers(text, speakers) {
  const narrative = narrativeOnly(text);
  const mentions = { clean: /* @__PURE__ */ new Set(), possessive: /* @__PURE__ */ new Set() };
  for (const speaker of speakers) {
    for (const alias of speakerAliases(speaker.name)) {
      const pattern = new RegExp(`\\b${escapedPattern(alias)}\\b`, "giu");
      for (const match of narrative.matchAll(pattern)) {
        if (match.index === void 0) continue;
        const suffix = narrative.slice(match.index + match[0].length);
        const collection = /^['’](?:s\b)?/iu.test(suffix) ? mentions.possessive : mentions.clean;
        collection.add(speaker.id);
      }
    }
  }
  return mentions;
}
function discourseSubjectSpeaker(text, speakers, eligibleSpeakerIds) {
  const narrative = narrativeOnly(text);
  const occurrencesByPosition = /* @__PURE__ */ new Map();
  for (const speaker of speakers) {
    if (!eligibleSpeakerIds.has(speaker.id)) continue;
    for (const alias of speakerAliases(speaker.name)) {
      const pattern = new RegExp(`\\b${escapedPattern(alias)}\\b`, "giu");
      for (const match of narrative.matchAll(pattern)) {
        if (match.index === void 0) continue;
        const end = match.index + match[0].length;
        if (/^['’](?:s\b)?/iu.test(narrative.slice(end))) continue;
        const key = `${speaker.id}:${match.index}`;
        const previous = occurrencesByPosition.get(key);
        if (!previous || end > previous.end) {
          occurrencesByPosition.set(key, { speakerId: speaker.id, start: match.index, end });
        }
      }
    }
  }
  const occurrences = [...occurrencesByPosition.values()].sort((left, right) => left.start - right.start || right.end - left.end);
  if (occurrences.length === 0) return null;
  const scores = new Map([...eligibleSpeakerIds].map((id) => [id, 0]));
  const firstMentionStart = occurrences[0].start;
  const clauseStart = (index) => {
    const prefix = narrative.slice(0, index);
    return Math.max(
      prefix.lastIndexOf("."),
      prefix.lastIndexOf("!"),
      prefix.lastIndexOf("?"),
      prefix.lastIndexOf(";"),
      prefix.lastIndexOf("\n")
    ) + 1;
  };
  for (const occurrence of occurrences) {
    const start = clauseStart(occurrence.start);
    const lead = narrative.slice(start, occurrence.start);
    const earlierInClause = occurrences.some((other) => other.start >= start && other.start < occurrence.start);
    let score = occurrence.start === firstMentionStart ? 2 : 0;
    if (!lead.trim() || /^[\s{(\[]*$/u.test(lead)) score += 10;
    else if (!earlierInClause && /^[^,]{1,48},\s*(?:(?:a|an|the)\s+)?$/iu.test(lead)) score += 8;
    if (PREPOSITION_BEFORE_NAME_PATTERN.test(lead)) {
      score -= 6;
    }
    if (/\b(?:that|which|who|whom|whose|because|while|when|if|though|although)\s*$/iu.test(lead)) {
      score -= 5;
    }
    if (earlierInClause && /^\s+(?:had|has|have)\b/iu.test(narrative.slice(occurrence.end))) {
      score -= 5;
    }
    scores.set(occurrence.speakerId, (scores.get(occurrence.speakerId) ?? 0) + score);
  }
  for (let index = 1; index < occurrences.length; index++) {
    const left = occurrences[index - 1];
    const right = occurrences[index];
    if (left.speakerId === right.speakerId || clauseStart(left.start) !== clauseStart(right.start)) continue;
    const between = narrative.slice(left.end, right.start);
    if (/^\s*(?:,\s*)?(?:and|or)\s*$/iu.test(between)) {
      scores.set(right.speakerId, (scores.get(right.speakerId) ?? 0) + 10);
    }
  }
  const ranked = [...scores.entries()].sort((left, right) => right[1] - left[1]);
  const [winnerId, winnerScore] = ranked[0];
  const runnerUpScore = ranked[1]?.[1] ?? Number.NEGATIVE_INFINITY;
  return winnerScore >= 8 && winnerScore - runnerUpScore >= 4 ? winnerId : null;
}
var SPEECH_BEARING_NOUNS = "(?:voice|words?|reply|answer|question|whisper|shout|yell|call|murmur|remark|response)";
function mainClauseSpeechPossessor(text, speakers) {
  const narrative = narrativeOnly(text);
  const matches = /* @__PURE__ */ new Set();
  for (const speaker of speakers) {
    for (const alias of speakerAliases(speaker.name)) {
      const pattern = new RegExp(
        `\\b${escapedPattern(alias)}\\b['\u2019](?:s)?\\s+(?:[\\p{L}\\p{M}'\u2019-]+\\s+){0,3}${SPEECH_BEARING_NOUNS}\\b`,
        "giu"
      );
      for (const match of narrative.matchAll(pattern)) {
        if (match.index === void 0) continue;
        const prefix = narrative.slice(0, match.index);
        const sentenceStart = Math.max(
          prefix.lastIndexOf("."),
          prefix.lastIndexOf("!"),
          prefix.lastIndexOf("?"),
          prefix.lastIndexOf(";"),
          prefix.lastIndexOf("\n")
        ) + 1;
        const lead = prefix.slice(sentenceStart);
        if (!lead.trim() || /^[^,]{1,80},\s*$/u.test(lead)) matches.add(speaker.id);
      }
    }
  }
  return matches.size === 1 ? [...matches][0] : null;
}
function mainClausePossessiveSubject(text, speakers, eligibleSpeakerIds) {
  const narrative = narrativeOnly(text);
  const matches = /* @__PURE__ */ new Set();
  for (const speaker of speakers) {
    if (!eligibleSpeakerIds.has(speaker.id)) continue;
    for (const alias of speakerAliases(speaker.name)) {
      const pattern = new RegExp(`\\b${escapedPattern(alias)}\\b['\u2019]s\\s+`, "giu");
      for (const match of narrative.matchAll(pattern)) {
        if (match.index === void 0) continue;
        const prefix = narrative.slice(0, match.index);
        if (/\b(?:to|from|for|with|by|at|on|of|in|into|beside|behind|under|near|against)\s*$/iu.test(prefix)) {
          continue;
        }
        const sentenceStart = Math.max(
          prefix.lastIndexOf("."),
          prefix.lastIndexOf("!"),
          prefix.lastIndexOf("?"),
          prefix.lastIndexOf(";"),
          prefix.lastIndexOf("\n")
        ) + 1;
        const lead = prefix.slice(sentenceStart);
        if (lead.trim() && !/\b(?:and|but|then)\s*$/iu.test(lead)) continue;
        const clause = narrative.slice(match.index + match[0].length).split(/[.!?;\n]/u, 1)[0];
        const clauseWords = clause.match(/[\p{L}\p{M}'’-]+/gu) ?? [];
        if (clauseWords.length >= 3) matches.add(speaker.id);
      }
    }
  }
  return matches.size === 1 ? [...matches][0] : null;
}
function frontedPrepositionalPossessiveSubject(text, speakers) {
  const narrative = narrativeOnly(text);
  if (mentionedSpeakers(narrative, speakers).clean.size > 0) return null;
  const matches = /* @__PURE__ */ new Set();
  for (const speaker of speakers) {
    for (const alias of speakerAliases(speaker.name)) {
      const pattern = new RegExp(`\\b${escapedPattern(alias)}\\b['\u2019]s\\s+`, "giu");
      for (const match of narrative.matchAll(pattern)) {
        if (match.index === void 0) continue;
        const prefix = narrative.slice(0, match.index);
        const sentenceStart = Math.max(
          prefix.lastIndexOf("."),
          prefix.lastIndexOf("!"),
          prefix.lastIndexOf("?"),
          prefix.lastIndexOf(";"),
          prefix.lastIndexOf("\n")
        ) + 1;
        if (!INTRODUCTORY_PREPOSITIONAL_PHRASE_PATTERN.test(prefix.slice(sentenceStart))) continue;
        const clause = narrative.slice(match.index + match[0].length).split(/[.!?;\n]/u, 1)[0];
        if ((clause.match(/[\p{L}\p{M}'’-]+/gu) ?? []).length >= 3) matches.add(speaker.id);
      }
    }
  }
  return matches.size === 1 ? [...matches][0] : null;
}
function preferredMentionedSpeaker(text, speakers, mentions) {
  const speechPossessor = mainClauseSpeechPossessor(text, speakers);
  if (speechPossessor) return speechPossessor;
  if (mentions.clean.size > 0) return discourseSubjectSpeaker(text, speakers, mentions.clean);
  return mainClausePossessiveSubject(text, speakers, mentions.possessive);
}
function hasSpeakerMentions(mentions) {
  return mentions.clean.size > 0 || mentions.possessive.size > 0;
}
function soleMentionedSpeaker(text, speakers) {
  return preferredMentionedSpeaker(text, speakers, mentionedSpeakers(text, speakers));
}
function unambiguousNarrativeSpeaker(text, speakers) {
  const mentions = mentionedSpeakers(text, speakers);
  if (mentions.clean.size === 1) return discourseSubjectSpeaker(text, speakers, mentions.clean);
  if (mentions.clean.size === 0) {
    return mainClausePossessiveSubject(text, speakers, mentions.possessive);
  }
  return null;
}
var ANONYMOUS_ROLE_NOUNS = [
  "cashier",
  "clerk",
  "customer",
  "driver",
  "employee",
  "guard",
  "passerby",
  "server",
  "shopkeeper",
  "staffer",
  "stranger",
  "waiter",
  "waitress",
  "worker"
];
var ANONYMOUS_HUMAN_NOUNS = [
  ...ANONYMOUS_ROLE_NOUNS,
  "boy",
  "child",
  "girl",
  "guy",
  "kid",
  "lady",
  "man",
  "person",
  "teen",
  "teenager",
  "woman"
];
var ANONYMOUS_HUMAN_SUBJECT_PATTERN = new RegExp(
  `(?:^\\s*|[.!?;]\\s+|^\\s*[^,\\n]{1,120},\\s*)(?:(?:a|an|another|some)\\s+(?:[\\p{L}\\p{M}'\u2019-]+[ -]){0,5}(?:${ANONYMOUS_HUMAN_NOUNS.join("|")})|the\\s+(?:[\\p{L}\\p{M}'\u2019-]+[ -]){0,5}(?:${ANONYMOUS_ROLE_NOUNS.join("|")}))\\b`,
  "iu"
);
var ANONYMOUS_HUMAN_IDENTITY_PATTERN = new RegExp(
  `\\b(?:(?:a|an|another|some)\\s+(?:[\\p{L}\\p{M}'\u2019-]+[ -]){0,5}(?:${ANONYMOUS_HUMAN_NOUNS.join("|")})|the\\s+(?:[\\p{L}\\p{M}'\u2019-]+[ -]){0,5}(?:${ANONYMOUS_ROLE_NOUNS.join("|")}))\\b`,
  "iu"
);
var ANONYMOUS_ROLE_IDENTITY_PATTERN = new RegExp(
  `\\b(?:a|an|another|some|the)\\s+(?:[\\p{L}\\p{M}'\u2019-]+[ -]){0,5}(?:${ANONYMOUS_ROLE_NOUNS.join("|")})\\b`,
  "iu"
);
function hasAnonymousHumanSubject(text) {
  return ANONYMOUS_HUMAN_SUBJECT_PATTERN.test(narrativeOnly(text));
}
function hasAnonymousSpeechAttribution(text) {
  const narrative = narrativeOnly(text);
  return hasAnonymousHumanSubject(narrative) && new RegExp(`\\b${SPEECH_VERBS}\\b`, "iu").test(narrative);
}
function hasLeadingPronounSubject(text) {
  return /^(?:he|she|they)\b/iu.test(narrativeOnly(text).trimStart());
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
  const paragraphs = before.split(/\n[^\S\n]*\n/gu);
  if (paragraphs.length < 2) return null;
  for (let index = paragraphs.length - 2; index >= 0; index--) {
    const paragraph = paragraphs[index];
    const mentions = mentionedSpeakers(paragraph, speakers);
    const speakerId = preferredMentionedSpeaker(paragraph, speakers, mentions);
    if (speakerId) return speakerId;
    if (mentions.clean.size > 0) return null;
  }
  return null;
}
function precedingActionBeatSpeaker(before, speakers) {
  const previousQuoteEnd = Math.max(before.lastIndexOf('"'), before.lastIndexOf("\u201D"));
  const previousParagraphEnd = [...before.matchAll(/\n[^\S\n]*\n/gu)].at(-1);
  const paragraphBoundary = previousParagraphEnd?.index === void 0 ? -1 : previousParagraphEnd.index + previousParagraphEnd[0].length - 1;
  const localNarration = before.slice(Math.max(previousQuoteEnd, paragraphBoundary) + 1).trimStart();
  if (!localNarration) return null;
  const matches = /* @__PURE__ */ new Set();
  for (const speaker of speakers) {
    for (const alias of speakerAliases(speaker.name)) {
      const pattern = new RegExp(
        `^${escapedPattern(alias)}\\b(?!['\u2019](?:s\\b)?)\\s*(?:,|\u2014|-)`,
        "iu"
      );
      if (pattern.test(localNarration)) matches.add(speaker.id);
    }
  }
  return matches.size === 1 ? [...matches][0] : null;
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
    if (nearest) return { speakerId: nearest.id, confident: true, source: "explicit" };
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
        [new RegExp(`^\\s*[,;:.!?\u2014-]*\\s*${SPEECH_VERBS}\\b\\s+(?:to\\s+)?${name}\\b`, "iu"), after.slice(0, 180), 85]
      ];
      for (const [pattern, sample, score] of tests) {
        if (pattern.test(sample) && (!best || score > best.score)) best = { id: speaker.id, score };
      }
    }
  }
  if (best) return { speakerId: best.id, confident: true, source: "explicit" };
  const actionBeatSpeakerId = precedingActionBeatSpeaker(before, speakers);
  if (actionBeatSpeakerId) {
    return { speakerId: actionBeatSpeakerId, confident: true, source: "explicit" };
  }
  const currentSpeakerId = currentParagraphSpeaker(before, after, speakers);
  if (currentSpeakerId) {
    return { speakerId: currentSpeakerId, confident: true, source: "paragraph" };
  }
  const paragraphSpeakerId = precedingParagraphSpeaker(before, speakers);
  return paragraphSpeakerId ? { speakerId: paragraphSpeakerId, confident: true, source: "history" } : { speakerId: defaultSpeakerId, confident: false, source: "fallback" };
}
function playbackParagraphs(content) {
  const paragraphs = [];
  let cursor = 0;
  for (const separator of content.matchAll(/\n[^\S\n]*\n/gu)) {
    if (separator.index === void 0) continue;
    const text2 = content.slice(cursor, separator.index);
    if (text2.trim()) paragraphs.push({ start: cursor, end: separator.index, text: text2 });
    cursor = separator.index + separator[0].length;
  }
  const text = content.slice(cursor);
  if (text.trim()) paragraphs.push({ start: cursor, end: content.length, text });
  return paragraphs;
}
function playbackQuotes(content) {
  const quotes = [];
  for (const paragraph of playbackParagraphs(content)) {
    let matched = false;
    for (const match of paragraph.text.matchAll(/["“]([\s\S]*?)["”]/gu)) {
      if (match.index === void 0) continue;
      matched = true;
      const start = paragraph.start + match.index;
      quotes.push({
        start,
        end: start + match[0].length,
        text: match[1] ?? ""
      });
    }
    if (matched) continue;
    const leadingQuote = paragraph.text.match(/^(\s*)["“]([\s\S]+)$/u);
    if (!leadingQuote) continue;
    const localStart = leadingQuote[1]?.length ?? 0;
    quotes.push({
      start: paragraph.start + localStart,
      end: paragraph.end,
      text: (leadingQuote[2] ?? "").replace(/['’]\s*$/u, "")
    });
  }
  return quotes;
}
function initialDialogueBackfill(paragraphs, speakers) {
  const paragraphIndexes = [];
  let dialogueStarted = false;
  for (let index = 0; index < paragraphs.length; index++) {
    const paragraph = paragraphs[index];
    const hasDialogue = playbackQuotes(paragraph.text).length > 0;
    const mentions = mentionedSpeakers(paragraph.text, speakers);
    const localSpeakerId = preferredMentionedSpeaker(paragraph.text, speakers, mentions);
    if (!dialogueStarted) {
      if (!hasDialogue) {
        if (localSpeakerId || hasSpeakerMentions(mentions)) return null;
        continue;
      }
      dialogueStarted = true;
    }
    if (hasDialogue) {
      if (localSpeakerId || hasSpeakerMentions(mentions)) return null;
      paragraphIndexes.push(index);
      continue;
    }
    if (localSpeakerId) {
      return {
        speakerId: localSpeakerId,
        paragraphIndexes: new Set(paragraphIndexes)
      };
    }
    if (hasSpeakerMentions(mentions)) return null;
  }
  return null;
}
function confidentDialogueParagraphSpeaker(content, paragraph, speakers, defaultSpeakerId) {
  const speakerIds = /* @__PURE__ */ new Set();
  for (const quote of playbackQuotes(paragraph.text)) {
    const quoteStart = paragraph.start + quote.start;
    const quoteEnd = paragraph.start + quote.end;
    const inference = inferQuotedSpeaker(
      content.slice(0, quoteStart),
      content.slice(quoteEnd),
      quote.text,
      speakers,
      defaultSpeakerId
    );
    if (inference.confident && inference.speakerId) speakerIds.add(inference.speakerId);
  }
  return speakerIds.size === 1 ? [...speakerIds][0] : null;
}
function downstreamNarrativeReplySpeakers(content, paragraphs, speakers, defaultSpeakerId) {
  const replies = /* @__PURE__ */ new Map();
  for (let index = 1; index + 1 < paragraphs.length; index++) {
    const previous = paragraphs[index - 1];
    const current = paragraphs[index];
    const next = paragraphs[index + 1];
    if (!/["“][\s\S]*?["”]/u.test(previous.text)) continue;
    if (!/["“][\s\S]*?["”]/u.test(current.text)) continue;
    if (/["“][\s\S]*?["”]/u.test(next.text)) continue;
    if (cleanPlaybackText(narrativeOnly(current.text))) continue;
    if (hasSpeakerMentions(mentionedSpeakers(current.text, speakers))) continue;
    const previousSpeakerId = confidentDialogueParagraphSpeaker(
      content,
      previous,
      speakers,
      defaultSpeakerId
    );
    if (!previousSpeakerId) continue;
    const nextMentions = mentionedSpeakers(next.text, speakers);
    if (nextMentions.clean.size === 0) continue;
    const nextSpeakerId = discourseSubjectSpeaker(next.text, speakers, nextMentions.clean);
    if (!nextSpeakerId || nextSpeakerId === previousSpeakerId) continue;
    replies.set(index, nextSpeakerId);
  }
  return replies;
}
function hasSustainedUnnamedNarration(paragraphs, startIndex, speakers) {
  let narrationLength = 0;
  for (let index = startIndex; index < paragraphs.length; index++) {
    const paragraph = paragraphs[index];
    if (hasSpeakerMentions(mentionedSpeakers(paragraph.text, speakers))) break;
    narrationLength += cleanPlaybackText(narrativeOnly(paragraph.text)).length;
    if (narrationLength >= 160) return true;
  }
  return false;
}
function hasPronounSpeechAttribution(text) {
  const narration = cleanPlaybackText(narrativeOnly(text));
  return new RegExp(`\\b(?:he|she|they)\\b[^.!?\\n]{0,40}\\b${SPEECH_VERBS}\\b`, "iu").test(narration);
}
function paragraphDialogueTurns(content, speakers, defaultSpeakerId) {
  const turns = /* @__PURE__ */ new Map();
  const paragraphs = playbackParagraphs(content);
  let pair = null;
  let previousStrongSpeakerId = null;
  let lastTurnSpeakerId = null;
  for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex++) {
    const paragraph = paragraphs[paragraphIndex];
    const quoteMatches = playbackQuotes(paragraph.text);
    if (quoteMatches.length === 0) {
      const narration = cleanPlaybackText(paragraph.text);
      const transparentBeat = narration.length <= 120 && !hasSpeakerMentions(mentionedSpeakers(paragraph.text, speakers));
      if (!transparentBeat) {
        pair = null;
        previousStrongSpeakerId = null;
        lastTurnSpeakerId = null;
      }
      continue;
    }
    const explicitSpeakerIds = /* @__PURE__ */ new Set();
    const initialHistorySpeakerIds = /* @__PURE__ */ new Set();
    const continuationHistorySpeakerIds = /* @__PURE__ */ new Set();
    for (const quote of quoteMatches) {
      const quoteStart = paragraph.start + quote.start;
      const quoteEnd = paragraph.start + quote.end;
      const inference = inferQuotedSpeaker(
        content.slice(0, quoteStart),
        content.slice(quoteEnd),
        quote.text,
        speakers,
        defaultSpeakerId
      );
      if (inference.source === "explicit" && inference.speakerId) {
        explicitSpeakerIds.add(inference.speakerId);
      } else if (!pair && previousStrongSpeakerId && inference.source === "history" && inference.confident && inference.speakerId === previousStrongSpeakerId) {
        continuationHistorySpeakerIds.add(inference.speakerId);
      } else if (!pair && !previousStrongSpeakerId && inference.source === "history" && inference.confident && inference.speakerId) {
        initialHistorySpeakerIds.add(inference.speakerId);
      }
    }
    if (explicitSpeakerIds.size > 1) {
      pair = null;
      previousStrongSpeakerId = null;
      lastTurnSpeakerId = null;
      continue;
    }
    const explicitSpeakerId = explicitSpeakerIds.size === 1 ? [...explicitSpeakerIds][0] : null;
    const initialHistorySpeakerId = initialHistorySpeakerIds.size === 1 ? [...initialHistorySpeakerIds][0] : null;
    const continuationHistorySpeakerId = continuationHistorySpeakerIds.size === 1 && hasPronounSpeechAttribution(paragraph.text) ? [...continuationHistorySpeakerIds][0] : null;
    const localSpeakerId = explicitSpeakerId ?? soleMentionedSpeaker(paragraph.text, speakers) ?? continuationHistorySpeakerId ?? initialHistorySpeakerId;
    if (localSpeakerId) {
      if (pair && !pair.includes(localSpeakerId)) pair = null;
      if (!pair && previousStrongSpeakerId && previousStrongSpeakerId !== localSpeakerId) {
        pair = [previousStrongSpeakerId, localSpeakerId];
      }
      previousStrongSpeakerId = localSpeakerId;
      lastTurnSpeakerId = localSpeakerId;
      continue;
    }
    if (pair && lastTurnSpeakerId && pair.includes(lastTurnSpeakerId) && hasSustainedUnnamedNarration(paragraphs, paragraphIndex, speakers)) {
      turns.set(paragraphIndex, lastTurnSpeakerId);
      pair = null;
      previousStrongSpeakerId = lastTurnSpeakerId;
    } else if (pair && lastTurnSpeakerId && pair.includes(lastTurnSpeakerId)) {
      const alternatingSpeakerId = pair[0] === lastTurnSpeakerId ? pair[1] : pair[0];
      turns.set(paragraphIndex, alternatingSpeakerId);
      lastTurnSpeakerId = alternatingSpeakerId;
    } else {
      previousStrongSpeakerId = null;
      lastTurnSpeakerId = null;
    }
  }
  return turns;
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
var TURN_CONTINUE_OPTION = "continues_previous_turn";
var TURN_RESPOND_OPTION = "responds_to_previous_speaker";
var TURN_OTHER_OPTION = "responds_to_other_participant";
var TURN_UNCLEAR_OPTION = "no_clear_relation";
var TURN_RELATION_CRITERIA = {
  [TURN_CONTINUE_OPTION]: "The same speaker is still talking; no new speaker has taken over.",
  [TURN_RESPOND_OPTION]: "A different participant answers the immediately preceding speaker.",
  [TURN_OTHER_OPTION]: "A different participant addresses someone else in the scene, a third party, or an off-scene channel.",
  [TURN_UNCLEAR_OPTION]: "The text does not establish whether the speaker continues or changes."
};
var DEFAULT_SPEAKER_LOOKBACK = 6;
var MAX_SPEAKER_LOOKBACK = 100;
var TTS_EMOTION_OPTIONS = [
  { value: "happy", description: "Cheerful, upbeat." },
  { value: "sad", description: "Melancholic, downcast." },
  { value: "angry", description: "Frustrated or aggressive." },
  { value: "excited", description: "Energetic and enthusiastic." },
  { value: "calm", description: "Peaceful and relaxed." },
  { value: "nervous", description: "Anxious and uncertain." },
  { value: "confident", description: "Assertive and self-assured." },
  { value: "surprised", description: "Shocked or amazed." },
  { value: "satisfied", description: "Content and pleased." },
  { value: "delighted", description: "Very pleased and joyful." },
  { value: "scared", description: "Frightened or fearful." },
  { value: "worried", description: "Concerned and troubled." },
  { value: "upset", description: "Disturbed or distressed." },
  { value: "frustrated", description: "Annoyed or exasperated." },
  { value: "depressed", description: "Very sad and hopeless." },
  { value: "empathetic", description: "Understanding and caring." },
  { value: "embarrassed", description: "Ashamed or awkward." },
  { value: "disgusted", description: "Repelled or revolted." },
  { value: "moved", description: "Emotionally touched." },
  { value: "proud", description: "Accomplished and pleased." },
  { value: "relaxed", description: "At ease and casual." },
  { value: "grateful", description: "Thankful and appreciative." },
  { value: "curious", description: "Inquisitive and interested." },
  { value: "sarcastic", description: "Ironic or mocking." },
  { value: "disdainful", description: "Contemptuous or scornful." },
  { value: "unhappy", description: "Discontent or dissatisfied." },
  { value: "anxious", description: "Very worried and uneasy." },
  { value: "hysterical", description: "Uncontrollably emotional." },
  { value: "indifferent", description: "Uncaring or neutral." },
  { value: "uncertain", description: "Doubtful or unsure." },
  { value: "doubtful", description: "Skeptical or questioning." },
  { value: "confused", description: "Puzzled or perplexed." },
  { value: "disappointed", description: "Let down or dissatisfied." },
  { value: "regretful", description: "Sorry or remorseful." },
  { value: "guilty", description: "Culpable or responsible." },
  { value: "ashamed", description: "Deeply embarrassed." },
  { value: "jealous", description: "Envious or resentful." },
  { value: "envious", description: "Wanting what others have." },
  { value: "hopeful", description: "Optimistic about the future." },
  { value: "optimistic", description: "Positive outlook." },
  { value: "pessimistic", description: "Negative outlook." },
  { value: "nostalgic", description: "Longing for the past." },
  { value: "lonely", description: "Isolated or alone." },
  { value: "bored", description: "Uninterested or weary." },
  { value: "contemptuous", description: "Showing contempt." },
  { value: "sympathetic", description: "Showing sympathy." },
  { value: "compassionate", description: "Showing deep care." },
  { value: "determined", description: "Resolved and decided." },
  { value: "resigned", description: "Accepting defeat." }
];
var TTS_AUTO_EMOTION_VALUES = /* @__PURE__ */ new Set([
  "happy",
  "sad",
  "angry",
  "excited",
  "calm",
  "nervous",
  "confident",
  "surprised",
  "satisfied",
  "delighted",
  "scared",
  "worried",
  "upset",
  "frustrated",
  "depressed",
  "empathetic",
  "embarrassed",
  "disgusted",
  "moved",
  "proud",
  "relaxed",
  "grateful",
  "curious",
  "sarcastic"
]);
var TTS_AUTO_EMOTION_OPTIONS = TTS_EMOTION_OPTIONS.filter((option) => TTS_AUTO_EMOTION_VALUES.has(option.value));
var TTS_COMPACT_EMOTION_VALUES = /* @__PURE__ */ new Set([
  "happy",
  "sad",
  "angry",
  "excited",
  "calm",
  "nervous",
  "scared",
  "worried",
  "moved",
  "frustrated",
  "confident",
  "surprised"
]);
var TTS_COMPACT_EMOTION_OPTIONS = TTS_EMOTION_OPTIONS.filter((option) => TTS_COMPACT_EMOTION_VALUES.has(option.value));
var TTS_TAG_OPTIONS = [
  { value: "laugh", description: "A brief laugh." },
  { value: "chuckle", description: "A soft, low laugh." },
  { value: "giggle", description: "A light, high giggle." },
  { value: "snicker", description: "A half-suppressed laugh." },
  { value: "cackle", description: "A sharp, harsh laugh." },
  { value: "cheer", description: "A short cheer or whoop." },
  { value: "gasp", description: "A sharp intake of breath." },
  { value: "sigh", description: "A long exhale of relief, frustration, or resignation." },
  { value: "groan", description: "A low sound of pain or dismay." },
  { value: "grunt", description: "A short, effortful grunt." },
  { value: "grr", description: "A low, frustrated growl-like sound." },
  { value: "growl", description: "A menacing growl." },
  { value: "hiss", description: "A sharp hiss." },
  { value: "moan", description: "A low moan of pain or pleasure." },
  { value: "pant", description: "A few panting breaths." },
  { value: "pff", description: "A dismissive puff of breath." },
  { value: "phew", description: "A relieved phew." },
  { value: "tsk", description: "A disapproving tsk." },
  { value: "whispers", description: "A whispered delivery." },
  { value: "shout", description: "A sudden shout." },
  { value: "argh", description: "A frustrated argh." },
  { value: "whimper", description: "A small whimper." },
  { value: "cry", description: "A brief cry." },
  { value: "sob", description: "A sob." },
  { value: "scream", description: "A scream." },
  { value: "shriek", description: "A high shriek." },
  { value: "snort", description: "A snort of amusement or contempt." },
  { value: "breath", description: "A single audible breath." },
  { value: "heavy breath", description: "A heavy breath." },
  { value: "exhales", description: "A deliberate exhale." },
  { value: "cough", description: "A cough." },
  { value: "throat-clearing", description: "A throat-clearing sound." },
  { value: "sneeze", description: "A sneeze." },
  { value: "yawn", description: "A yawn." },
  { value: "snore", description: "A sleeping snore." }
];
var TTS_PAUSE_OPTIONS = [
  { value: "short", label: "Short pause", description: "A brief dramatic pause." },
  { value: "long", label: "Long pause", description: "An extended dramatic pause." }
];
var TTS_STYLE_OPTIONS = [
  { value: "whispering", description: "Hushed and breathy." },
  { value: "soft voice", description: "Quiet and gentle." },
  { value: "low voice", description: "A deeper register." },
  { value: "loud voice", description: "Raised volume without shouting." },
  { value: "shouting", description: "Full-volume shouting." },
  { value: "screaming", description: "Panicked or extreme volume." }
];
var TTS_STYLE_LIKE_SOUNDS = /* @__PURE__ */ new Set(["whispers", "shout", "scream"]);
var TTS_FISH_SOUND_OPTIONS = TTS_TAG_OPTIONS.filter((option) => !TTS_STYLE_LIKE_SOUNDS.has(option.value));
var TTS_GEMINI38_SOUND_OPTIONS = TTS_TAG_OPTIONS.filter((option) => option.value !== "snore");
var TTS_EMOTION_NAMES = new Set(TTS_EMOTION_OPTIONS.map((option) => option.value));
var TTS_SOUND_NAMES = new Set(TTS_TAG_OPTIONS.map((option) => option.value));
var TTS_PAUSE_NAMES = new Set(TTS_PAUSE_OPTIONS.map((option) => option.value));
var TTS_STYLE_NAMES = new Set(TTS_STYLE_OPTIONS.map((option) => option.value));
var TTS_TAG_NAMES = /* @__PURE__ */ new Set([
  ...TTS_EMOTION_NAMES,
  ...TTS_SOUND_NAMES,
  ...TTS_PAUSE_NAMES,
  ...TTS_STYLE_NAMES
]);
var NARRATIVE_SPEECH_VERB_PATTERN = new RegExp(
  `\\b(?:${SPEECH_VERBS}|blurt(?:s|ed)|laugh(?:s|ed)|mutter(?:s|ed)|hiss(?:es|ed)|snap(?:s|ped))\\b`,
  "iu"
);
function parseRosterVoiceSegmentsInternal(content, defaultSpeakerId, speakers, skippedTrackerTagPairs = "", quoteSpeakerOverrides, historicalSpeakerId = null, preserveLocalOnNullOverride = false, lowConfidenceQuoteIndexes, includeDebug = false) {
  const playbackContent = preparePlaybackContent(content, skippedTrackerTagPairs);
  const result = [];
  const quotes = playbackQuotes(playbackContent);
  const paragraphs = playbackParagraphs(playbackContent);
  const openingBackfill = initialDialogueBackfill(paragraphs, speakers);
  const dialogueTurns = paragraphDialogueTurns(playbackContent, speakers, defaultSpeakerId);
  const downstreamReplies = downstreamNarrativeReplySpeakers(
    playbackContent,
    paragraphs,
    speakers,
    defaultSpeakerId
  );
  const paragraphSpeakers = paragraphs.map((paragraph) => unambiguousNarrativeSpeaker(paragraph.text, speakers));
  let paragraphIndex = 0;
  let cursor = 0;
  let lastConfidentSpeakerId = null;
  let lastAssignedSpeakerId = null;
  let historicalPrefixActive = historicalSpeakerId !== null;
  let quoteIndex = 0;
  for (const quote of quotes) {
    const currentQuoteIndex = quoteIndex;
    quoteIndex += 1;
    while (paragraphIndex + 1 < paragraphs.length && quote.start >= paragraphs[paragraphIndex].end) {
      paragraphIndex += 1;
    }
    const bridge = playbackContent.slice(cursor, quote.start);
    const narration2 = cleanPlaybackText(bridge);
    if (narration2) result.push({
      text: narration2,
      speakerId: null,
      ...includeDebug ? { debugPath: ["segment-type:narration", "routing:narrator-voice"] } : {}
    });
    const speech = cleanPlaybackText(quote.text);
    if (speech) {
      const inference = inferQuotedSpeaker(
        playbackContent.slice(0, quote.start),
        playbackContent.slice(quote.end),
        quote.text,
        speakers,
        defaultSpeakerId
      );
      const continuationCandidate = lastAssignedSpeakerId ?? lastConfidentSpeakerId;
      const continuedSpeakerId = inference.source === "fallback" && continuationCandidate && canContinueSpeaker(bridge, continuationCandidate, speakers) ? continuationCandidate : null;
      const dialogueTurnSpeakerId = dialogueTurns.get(paragraphIndex) ?? null;
      const inferredTurnSpeakerId = inference.source === "history" || inference.source === "fallback" ? dialogueTurnSpeakerId : null;
      const openingSpeakerId = inference.source === "fallback" && openingBackfill?.paragraphIndexes.has(paragraphIndex) ? openingBackfill.speakerId : null;
      const frontedPossessiveSpeakerId = inference.source === "history" || inference.source === "fallback" ? frontedPrepositionalPossessiveSubject(bridge, speakers) : null;
      const previousParagraph = paragraphs[paragraphIndex - 1];
      const currentParagraph = paragraphs[paragraphIndex];
      const currentNarrativePrefix = currentParagraph ? currentParagraph.text.slice(0, Math.max(0, quote.start - currentParagraph.start)) : "";
      const nextQuote = quotes[currentQuoteIndex + 1];
      const downstreamNarrationEnd = currentParagraph ? Math.min(
        currentParagraph.end,
        nextQuote && nextQuote.start < currentParagraph.end ? nextQuote.start : currentParagraph.end
      ) : quote.end;
      const immediateDownstreamNarration = playbackContent.slice(quote.end, downstreamNarrationEnd);
      const anonymousLocalSpeakerId = (inference.source === "history" || inference.source === "fallback") && paragraphSpeakers[paragraphIndex] === null && (hasAnonymousHumanSubject(currentNarrativePrefix) || !!(previousParagraph && playbackQuotes(previousParagraph.text).length === 0 && paragraphSpeakers[paragraphIndex - 1] === null && hasAnonymousHumanSubject(previousParagraph.text))) ? UNCAST_SPEAKER_ID : null;
      const anonymousDownstreamSpeakerId = (inference.source === "history" || inference.source === "fallback") && paragraphSpeakers[paragraphIndex] === null && hasAnonymousSpeechAttribution(immediateDownstreamNarration) ? UNCAST_SPEAKER_ID : null;
      const anonymousPronounContinuationId = (inference.source === "history" || inference.source === "fallback") && paragraphSpeakers[paragraphIndex] === null && lastAssignedSpeakerId === UNCAST_SPEAKER_ID && hasLeadingPronounSubject(currentNarrativePrefix) ? UNCAST_SPEAKER_ID : null;
      const currentEvidenceSpeakerId = paragraphSpeakers[paragraphIndex] ?? frontedPossessiveSpeakerId ?? anonymousLocalSpeakerId ?? anonymousDownstreamSpeakerId ?? anonymousPronounContinuationId ?? (inference.confident ? inference.speakerId : null);
      if (historicalPrefixActive && (inference.source === "explicit" || inference.source === "paragraph" || frontedPossessiveSpeakerId !== null || anonymousLocalSpeakerId !== null || anonymousDownstreamSpeakerId !== null || anonymousPronounContinuationId !== null || paragraphSpeakers[paragraphIndex] !== null && currentEvidenceSpeakerId !== historicalSpeakerId)) {
        historicalPrefixActive = false;
      }
      const historicalFallbackId = historicalPrefixActive && (inference.source === "history" || inference.source === "fallback") ? historicalSpeakerId : null;
      const adjacentNarrativeSpeakerId = previousParagraph && playbackQuotes(previousParagraph.text).length === 0 ? mainClausePossessiveSubject(
        previousParagraph.text,
        speakers,
        mentionedSpeakers(previousParagraph.text, speakers).possessive
      ) : null;
      const adjacentNarrativeEvidenceId = previousParagraph && playbackQuotes(previousParagraph.text).length === 0 ? paragraphSpeakers[paragraphIndex - 1] : null;
      const adjacentNarrativeVoiceSpeakerId = adjacentNarrativeEvidenceId && previousParagraph && /\b(?:voice|speaks?|spoke|says?|said|asks?|asked|answers?|answered|replies|replied|whispers?|whispered|calls?|called|shouts?|shouted|murmurs?|murmured)\b/iu.test(previousParagraph.text) ? adjacentNarrativeEvidenceId : null;
      const localCandidates = [
        ["current-paragraph-subject", paragraphSpeakers[paragraphIndex]],
        ["preceding-possessive-subject", adjacentNarrativeSpeakerId],
        ["preceding-narrative-voice-subject", adjacentNarrativeVoiceSpeakerId],
        ["fronted-prepositional-possessive-subject", frontedPossessiveSpeakerId],
        ["anonymous-local-subject", anonymousLocalSpeakerId],
        ["anonymous-downstream-attribution", anonymousDownstreamSpeakerId],
        ["anonymous-pronoun-continuation", anonymousPronounContinuationId],
        ["downstream-reply", downstreamReplies.get(paragraphIndex) ?? null],
        ["speaker-continuation", continuedSpeakerId],
        ["dialogue-turn-alternation", inferredTurnSpeakerId],
        ["previous-message-history", historicalFallbackId],
        ["opening-dialogue-backfill", openingSpeakerId],
        [`quote-inference:${inference.source}`, inference.speakerId]
      ];
      const selectedLocalCandidate = localCandidates.find(([, speakerId2]) => speakerId2 !== null);
      const localSpeakerId = selectedLocalCandidate?.[1] ?? null;
      const confidentLocalSpeakerId = paragraphSpeakers[paragraphIndex] ?? adjacentNarrativeEvidenceId ?? frontedPossessiveSpeakerId ?? anonymousLocalSpeakerId ?? anonymousDownstreamSpeakerId ?? anonymousPronounContinuationId ?? (inference.source === "explicit" || inference.source === "paragraph" ? inference.speakerId : null);
      if (!localSpeakerId || confidentLocalSpeakerId !== localSpeakerId) {
        lowConfidenceQuoteIndexes?.add(currentQuoteIndex);
      }
      const overrideSpeakerId = quoteSpeakerOverrides?.get(currentQuoteIndex) ?? null;
      const hasOverride = quoteSpeakerOverrides?.has(currentQuoteIndex) === true;
      const speakerId = hasOverride && (!preserveLocalOnNullOverride || overrideSpeakerId !== null && confidentLocalSpeakerId === null || localSpeakerId === null) ? overrideSpeakerId : localSpeakerId;
      result.push({
        text: speech,
        speakerId,
        ...includeDebug ? {
          debugPath: [
            `segment-type:speech (quote ${currentQuoteIndex + 1})`,
            ...localCandidates.map(([rule, candidate]) => `${rule}:${candidate ?? "none"}`),
            `local-selection:${selectedLocalCandidate?.[0] ?? "none"} -> ${localSpeakerId ?? "none"}`,
            `local-confidence:${confidentLocalSpeakerId === localSpeakerId && localSpeakerId !== null ? "high" : "low"}`,
            hasOverride ? `llm-override:${overrideSpeakerId ?? "none"} (${speakerId === overrideSpeakerId ? "applied" : "rejected"})` : "llm-override:not-present",
            `parser-result:${speakerId ?? "none"}`
          ]
        } : {}
      });
      if ((inference.confident || openingSpeakerId) && speakerId) lastConfidentSpeakerId = speakerId;
      if (speakerId) lastAssignedSpeakerId = speakerId;
    }
    cursor = quote.end;
  }
  const narration = cleanPlaybackText(playbackContent.slice(cursor));
  if (narration) result.push({
    text: narration,
    speakerId: null,
    ...includeDebug ? { debugPath: ["segment-type:narration", "routing:narrator-voice"] } : {}
  });
  return result;
}
function parseRosterVoiceSegments(content, defaultSpeakerId, speakers, skippedTrackerTagPairs = "", historicalSpeakerId = null, includeDebug = false) {
  return parseRosterVoiceSegmentsInternal(
    content,
    defaultSpeakerId,
    speakers,
    skippedTrackerTagPairs,
    void 0,
    historicalSpeakerId,
    false,
    void 0,
    includeDebug
  );
}

// src/frontend.ts
var ConnectionVoiceGate = class {
  activeVoice = null;
  activeCount = 0;
  queue = [];
  acquire(voice, signal) {
    if (signal.aborted) return Promise.reject(new DOMException("Playback stopped.", "AbortError"));
    const voiceKey = voice.trim();
    return new Promise((resolve, reject) => {
      const waiter = {
        voice: voiceKey,
        signal,
        resolve,
        reject,
        abort: () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(new DOMException("Playback stopped.", "AbortError"));
          this.drain();
        }
      };
      if (this.activeCount === 0 && this.queue.length === 0) {
        this.activate(waiter);
      } else if (this.activeVoice === voiceKey && this.queue.length === 0) {
        this.activate(waiter);
      } else {
        this.queue.push(waiter);
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
    });
  }
  activate(waiter) {
    waiter.signal.removeEventListener("abort", waiter.abort);
    if (waiter.signal.aborted) {
      waiter.reject(new DOMException("Playback stopped.", "AbortError"));
      this.drain();
      return;
    }
    this.activeVoice = waiter.voice;
    this.activeCount += 1;
    let released = false;
    waiter.resolve(() => {
      if (released) return;
      released = true;
      this.activeCount -= 1;
      if (this.activeCount === 0) {
        this.activeVoice = null;
        this.drain();
      }
    });
  }
  drain() {
    if (this.activeCount !== 0) return;
    while (this.queue[0]?.signal.aborted) {
      const waiter = this.queue.shift();
      waiter.signal.removeEventListener("abort", waiter.abort);
      waiter.reject(new DOMException("Playback stopped.", "AbortError"));
    }
    const nextVoice = this.queue[0]?.voice;
    if (nextVoice === void 0) return;
    const batch = [];
    while (this.queue[0]?.voice === nextVoice) batch.push(this.queue.shift());
    for (const waiter of batch) this.activate(waiter);
  }
};
var MIN_SYNTHESIS_START_INTERVAL_MS = 1250;
var SYNTHESIS_REQUEST_WINDOW_MS = 6e4;
var DEFAULT_SYNTHESIS_REQUESTS_PER_WINDOW = 18;
var MIN_SYNTHESIS_REQUESTS_PER_WINDOW = 6;
var DEFAULT_PLAYBACK_BUFFER_SEGMENTS = 2;
var DEFAULT_CONCURRENT_GENERATIONS = 4;
var DEFAULT_RATE_LIMIT_WAIT_SECONDS = 60;
var MAX_PLAYBACK_BUFFER_SEGMENTS = 20;
var MAX_CONCURRENT_GENERATIONS = 10;
var MAX_RATE_LIMIT_WAIT_SECONDS = 3600;
var NORMALIZATION_TARGET_RMS = 0.1;
var NORMALIZATION_SILENCE_GATE = 0.01;
var NORMALIZATION_MIN_DURATION_SECONDS = 0.6;
var NORMALIZATION_MIN_ACTIVE_SECONDS = 0.25;
var NORMALIZATION_PROFILE_WEIGHT = 0.75;
var NORMALIZATION_MIN_GAIN = 10 ** (-6 / 20);
var NORMALIZATION_MAX_GAIN = 10 ** (6 / 20);
var NORMALIZATION_PEAK_CEILING = 10 ** (-1 / 20);
function fingerprintAudio(data) {
  const bytes = new Uint8Array(data);
  let hash = 2166136261;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
function clampIntegerSetting(value, fallback, maximum) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(1, Math.round(numeric)));
}
var VOICE_ICON = `
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M5 10v4M9 7v10M13 4v16M17 8v8M21 10v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  </svg>
`;
var MICROPHONE_ICON = `
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
    <rect x="9" y="2" width="6" height="12" rx="3" stroke="currentColor" stroke-width="1.8"/>
    <path d="M5 11a7 7 0 0 0 14 0M12 18v4M9 22h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
  </svg>
`;
var STOP_ACTION_ICON = `<svg data-chat-voice-stop="true" viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>`;
var PLAY_TTS_ACTION_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5Z" fill="currentColor"/><path d="M15 9.5a4 4 0 0 1 0 5M18 7a7.5 7.5 0 0 1 0 10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
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
  if (!response.ok) return {
    speed: 1,
    volume: 1,
    connectionId: "",
    saveGeneratedAudio: true,
    savedAudioLimit: DEFAULT_SAVED_AUDIO_LIMIT,
    skippedTrackerTags: "",
    speakerParsingMode: "ambiguous",
    ttsTagStyle: "off",
    ttsTagPlacement: "jev",
    tagLlmConnectionId: "",
    tagLlmModel: "",
    playbackBufferSegments: DEFAULT_PLAYBACK_BUFFER_SEGMENTS,
    concurrentGenerations: DEFAULT_CONCURRENT_GENERATIONS,
    rateLimitWaitSeconds: DEFAULT_RATE_LIMIT_WAIT_SECONDS,
    autoPlaybackDelaySeconds: 0,
    ghostVoiceLifetime: GHOST_VOICE_LIFETIME_MESSAGES,
    speakerLookback: DEFAULT_SPEAKER_LOOKBACK,
    ...readAutomaticVoicePreferences({}),
    speakerAssignmentDebug: false,
    skipNarration: false,
    defaultNarratorVoice: "",
    defaultUserVoice: "",
    favoriteVoices: [],
    fishApiKey: "",
    communityVoicePool: [],
    communityVoicePoolAt: "",
    communityVoiceLanguage: "",
    autoVoiceCastingPool: "favorite"
  };
  const row = await response.json();
  const speed = typeof row.value?.ttsSpeed === "number" ? row.value.ttsSpeed : 1;
  const volume = typeof row.value?.ttsVolume === "number" ? row.value.ttsVolume : 1;
  const speakerParsingMode = row.value?.chatVoiceSpeakerParsingMode === "off" ? "off" : "ambiguous";
  const ttsTagStyle = row.value?.chatVoiceTtsTagStyle === "gemini" || row.value?.chatVoiceTtsTagStyle === "gemini38" || row.value?.chatVoiceTtsTagStyle === "fish" ? row.value.chatVoiceTtsTagStyle : "off";
  const ttsTagPlacement = row.value?.chatVoiceTtsTagPlacement === "llm" ? "llm" : "jev";
  return {
    speed: Math.min(4, Math.max(0.25, speed)),
    volume: Math.min(1, Math.max(0, volume)),
    connectionId: globalTtsConnectionPreference(row.value ?? {}),
    saveGeneratedAudio: row.value?.chatVoiceSaveGeneratedAudio !== false,
    savedAudioLimit: clampSavedAudioLimit(row.value?.chatVoiceSavedAudioLimit),
    skippedTrackerTags: typeof row.value?.chatVoiceSkippedTrackerTags === "string" ? row.value.chatVoiceSkippedTrackerTags.slice(0, 4e3) : "",
    speakerParsingMode,
    ttsTagStyle,
    ttsTagPlacement,
    tagLlmConnectionId: typeof row.value?.chatVoiceTagLlmConnectionId === "string" ? row.value.chatVoiceTagLlmConnectionId.trim().slice(0, 128) : "",
    tagLlmModel: typeof row.value?.chatVoiceTagLlmModel === "string" ? row.value.chatVoiceTagLlmModel.trim().slice(0, 256) : "",
    playbackBufferSegments: clampIntegerSetting(
      row.value?.chatVoicePlaybackBufferSegments,
      DEFAULT_PLAYBACK_BUFFER_SEGMENTS,
      MAX_PLAYBACK_BUFFER_SEGMENTS
    ),
    concurrentGenerations: clampIntegerSetting(
      row.value?.chatVoiceConcurrentGenerations,
      DEFAULT_CONCURRENT_GENERATIONS,
      MAX_CONCURRENT_GENERATIONS
    ),
    rateLimitWaitSeconds: clampIntegerSetting(
      row.value?.chatVoiceRateLimitWaitSeconds,
      DEFAULT_RATE_LIMIT_WAIT_SECONDS,
      MAX_RATE_LIMIT_WAIT_SECONDS
    ),
    autoPlaybackDelaySeconds: readAutoplayDelaySeconds(row.value?.chatVoiceAutoPlaybackDelaySeconds),
    ghostVoiceLifetime: clampIntegerSetting(row.value?.chatVoiceGhostVoiceLifetime, GHOST_VOICE_LIFETIME_MESSAGES, 1e3),
    speakerLookback: clampIntegerSetting(row.value?.chatVoiceSpeakerLookback, DEFAULT_SPEAKER_LOOKBACK, MAX_SPEAKER_LOOKBACK),
    ...readAutomaticVoicePreferences(row.value ?? {}),
    speakerAssignmentDebug: row.value?.chatVoiceSpeakerAssignmentDebug === true,
    skipNarration: row.value?.chatVoiceSkipNarration === true,
    defaultNarratorVoice: typeof row.value?.chatVoiceDefaultNarratorVoice === "string" ? row.value.chatVoiceDefaultNarratorVoice.trim().slice(0, 512) : "",
    defaultUserVoice: typeof row.value?.chatVoiceDefaultUserVoice === "string" ? row.value.chatVoiceDefaultUserVoice.trim().slice(0, 512) : "",
    favoriteVoices: readFavoriteVoices(row.value?.chatVoiceFavoriteVoices),
    fishApiKey: typeof row.value?.chatVoiceFishApiKey === "string" ? row.value.chatVoiceFishApiKey.trim().slice(0, 512) : "",
    communityVoicePool: readFavoriteVoices(row.value?.chatVoiceCommunityVoicePool),
    communityVoicePoolAt: typeof row.value?.chatVoiceCommunityVoicePoolAt === "string" ? row.value.chatVoiceCommunityVoicePoolAt.slice(0, 32) : "",
    communityVoiceLanguage: typeof row.value?.chatVoiceCommunityVoiceLanguage === "string" ? row.value.chatVoiceCommunityVoiceLanguage.trim().slice(0, 32).toLowerCase() : "",
    autoVoiceCastingPool: row.value?.chatVoiceAutoCastPool === "community" ? "community" : "favorite"
  };
}
var voiceSettingsWriteQueue = Promise.resolve();
function updateVoiceSettings(update) {
  const task = voiceSettingsWriteQueue.then(async () => {
    const response = await fetch("/api/v1/settings/voiceSettings", {
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    });
    if (!response.ok) throw new Error(`Could not load global voice settings (${response.status}).`);
    const row = await response.json();
    const current = row.value && typeof row.value === "object" ? row.value : {};
    const saved = await fetch("/api/v1/settings/voiceSettings", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ value: update(current) })
    });
    if (!saved.ok) throw new Error(`Could not save global voice settings (${saved.status}).`);
  });
  voiceSettingsWriteQueue = task.catch(() => void 0);
  return task;
}
function saveGeneratedAudioPreference(enabled) {
  return updateVoiceSettings((current) => ({
    ...current,
    chatVoiceSaveGeneratedAudio: enabled
  }));
}
function saveGlobalTtsConnection(connectionId) {
  return updateVoiceSettings((current) => ({ ...current, chatVoiceTtsConnectionId: connectionId.trim().slice(0, 128) }));
}
function saveGeneratedAudioLimit(limit) {
  return updateVoiceSettings((current) => ({
    ...current,
    chatVoiceSavedAudioLimit: clampSavedAudioLimit(limit)
  }));
}
function saveSkippedTrackerTagsPreference(value) {
  return updateVoiceSettings((current) => ({
    ...current,
    chatVoiceSkippedTrackerTags: value.slice(0, 4e3)
  }));
}
function saveLlmParsingPreferences(mode) {
  return updateVoiceSettings((current) => ({
    ...current,
    chatVoiceSpeakerParsingMode: mode
  }));
}
function saveTtsTagPreferences(style, placement, connectionId, model) {
  return updateVoiceSettings((current) => ({
    ...current,
    chatVoiceTtsTagStyle: style,
    chatVoiceTtsTagPlacement: placement,
    chatVoiceTagLlmConnectionId: connectionId.trim().slice(0, 128),
    chatVoiceTagLlmModel: model.trim().slice(0, 256)
  }));
}
function saveAdvancedPlaybackPreferences(bufferSegments, concurrentGenerations, rateLimitWaitSeconds, speakerAssignmentDebug, ghostVoiceLifetime, autoVoiceCasting, autoPlayback, autoPlaybackDelaySeconds, speakerLookback, skipNarration, autoVoiceCastingPool) {
  return updateVoiceSettings((current) => ({
    ...current,
    chatVoicePlaybackBufferSegments: clampIntegerSetting(
      bufferSegments,
      DEFAULT_PLAYBACK_BUFFER_SEGMENTS,
      MAX_PLAYBACK_BUFFER_SEGMENTS
    ),
    chatVoiceConcurrentGenerations: clampIntegerSetting(
      concurrentGenerations,
      DEFAULT_CONCURRENT_GENERATIONS,
      MAX_CONCURRENT_GENERATIONS
    ),
    chatVoiceRateLimitWaitSeconds: clampIntegerSetting(
      rateLimitWaitSeconds,
      DEFAULT_RATE_LIMIT_WAIT_SECONDS,
      MAX_RATE_LIMIT_WAIT_SECONDS
    ),
    chatVoiceSpeakerAssignmentDebug: speakerAssignmentDebug,
    chatVoiceSkipNarration: skipNarration,
    chatVoiceAutoCasting: autoVoiceCasting,
    chatVoiceAutoPlayback: autoPlayback,
    chatVoiceAutoPlaybackDelaySeconds: readAutoplayDelaySeconds(autoPlaybackDelaySeconds),
    chatVoiceAutoCastPool: autoVoiceCastingPool,
    chatVoiceGhostVoiceLifetime: clampIntegerSetting(ghostVoiceLifetime, GHOST_VOICE_LIFETIME_MESSAGES, 1e3),
    chatVoiceSpeakerLookback: clampIntegerSetting(speakerLookback, DEFAULT_SPEAKER_LOOKBACK, MAX_SPEAKER_LOOKBACK)
  }));
}
function saveDefaultRoleVoice(role, voice) {
  const key = role === "narrator" ? "chatVoiceDefaultNarratorVoice" : "chatVoiceDefaultUserVoice";
  return updateVoiceSettings((current) => {
    const next = { ...current };
    next[key] = voice.trim().slice(0, 512);
    return next;
  });
}
async function deleteSavedAudioRecord(record) {
  const response = await fetch(
    `/api/v1/chats/${encodeURIComponent(record.chatId)}/messages/${encodeURIComponent(record.messageId)}/attachments/${encodeURIComponent(record.audioId)}`,
    { method: "DELETE", credentials: "same-origin", headers: { Accept: "application/json" } }
  );
  return response.ok || response.status === 404;
}
async function enforceSavedAudioRetention(nextRecord) {
  let expired = [];
  await updateVoiceSettings((current) => {
    const limit = clampSavedAudioLimit(current.chatVoiceSavedAudioLimit);
    const history = nextRecord ? upsertSavedAudioRecord(readSavedAudioHistory(current.chatVoiceSavedAudioHistory), nextRecord) : readSavedAudioHistory(current.chatVoiceSavedAudioHistory);
    expired = expiredSavedAudioRecords(history, limit);
    return { ...current, chatVoiceSavedAudioHistory: history };
  });
  if (expired.length === 0) return 0;
  const deletedAudioIds = [];
  for (const record of expired) {
    if (await deleteSavedAudioRecord(record)) deletedAudioIds.push(record.audioId);
  }
  if (deletedAudioIds.length > 0) {
    const deleted = new Set(deletedAudioIds);
    await updateVoiceSettings((current) => ({
      ...current,
      chatVoiceSavedAudioHistory: readSavedAudioHistory(current.chatVoiceSavedAudioHistory).filter((record) => !deleted.has(record.audioId))
    }));
  }
  if (deletedAudioIds.length !== expired.length) {
    throw new Error("Some older recordings could not be removed; cleanup will retry after the next save.");
  }
  return deletedAudioIds.length;
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
function normalizedVoiceGain(buffer, voiceKey, profiles) {
  let peak = 0;
  let gatedSquareSum = 0;
  let gatedSampleCount = 0;
  let activeFrames = 0;
  const channels = Array.from(
    { length: buffer.numberOfChannels },
    (_, channel) => buffer.getChannelData(channel)
  );
  for (let frame = 0; frame < buffer.length; frame += 1) {
    let framePeak = 0;
    let frameSquareSum = 0;
    for (const channel of channels) {
      const sample = channel[frame] ?? 0;
      const magnitude = Math.abs(sample);
      framePeak = Math.max(framePeak, magnitude);
      peak = Math.max(peak, magnitude);
      frameSquareSum += sample * sample;
    }
    if (framePeak < NORMALIZATION_SILENCE_GATE) continue;
    activeFrames += 1;
    gatedSquareSum += frameSquareSum;
    gatedSampleCount += channels.length;
  }
  const measuredRms = gatedSampleCount > 0 ? Math.sqrt(gatedSquareSum / gatedSampleCount) : 0;
  const substantial = buffer.duration >= NORMALIZATION_MIN_DURATION_SECONDS && activeFrames >= buffer.sampleRate * NORMALIZATION_MIN_ACTIVE_SECONDS && measuredRms > 0;
  const previousRms = profiles.get(voiceKey);
  if (substantial) {
    profiles.set(
      voiceKey,
      previousRms === void 0 ? measuredRms : previousRms * NORMALIZATION_PROFILE_WEIGHT + measuredRms * (1 - NORMALIZATION_PROFILE_WEIGHT)
    );
  }
  const referenceRms = profiles.get(voiceKey);
  let gain = referenceRms === void 0 ? 1 : Math.min(NORMALIZATION_MAX_GAIN, Math.max(NORMALIZATION_MIN_GAIN, NORMALIZATION_TARGET_RMS / referenceRms));
  if (peak > 0) gain = Math.min(gain, NORMALIZATION_PEAK_CEILING / peak);
  return Math.max(0, gain);
}
async function waitForSynthesisSlot(pacer, signal) {
  const turn = pacer.startQueue.then(async () => {
    while (true) {
      const now = Date.now();
      pacer.recentStarts = pacer.recentStarts.filter((start) => start > now - SYNTHESIS_REQUEST_WINDOW_MS);
      const windowDelay = rollingRequestWindowDelay(
        pacer.recentStarts,
        now,
        pacer.windowRequestLimit,
        SYNTHESIS_REQUEST_WINDOW_MS
      );
      const delay = Math.max(0, pacer.nextStartAt - now, windowDelay);
      await abortableDelay(delay, signal);
      const readyAt = Date.now();
      if (readyAt < pacer.nextStartAt) continue;
      if (rollingRequestWindowDelay(
        pacer.recentStarts,
        readyAt,
        pacer.windowRequestLimit,
        SYNTHESIS_REQUEST_WINDOW_MS
      ) > 0) continue;
      pacer.recentStarts.push(readyAt);
      pacer.nextStartAt = readyAt + MIN_SYNTHESIS_START_INTERVAL_MS;
      return;
    }
  });
  pacer.startQueue = turn.catch(() => void 0);
  await turn;
}
async function acquireRateLimitRecoverySlot(budget, signal) {
  if (!budget.recovering) return () => void 0;
  let releaseSlot;
  const slot = new Promise((resolve) => {
    releaseSlot = resolve;
  });
  const previous = budget.recoveryTail;
  budget.recoveryTail = previous.catch(() => void 0).then(() => slot);
  try {
    await new Promise((resolve, reject) => {
      const abort = () => reject(new DOMException("Playback stopped.", "AbortError"));
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
      void previous.catch(() => void 0).then(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      });
    });
  } catch (error) {
    releaseSlot();
    throw error;
  }
  if (signal.aborted) {
    releaseSlot();
    throw new DOMException("Playback stopped.", "AbortError");
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseSlot();
  };
}
async function synthesizeVoiceSegment(connectionId, text, voice, speed, signal, pacer, rateLimitBudget, voiceGate, onRateLimit) {
  while (true) {
    const releaseRecovery = await acquireRateLimitRecoverySlot(rateLimitBudget, signal);
    let releaseVoice = null;
    let response;
    let audioData = null;
    try {
      releaseVoice = await voiceGate.acquire(voice, signal);
      await waitForSynthesisSlot(pacer, signal);
      response = await fetch("/api/v1/tts/synthesize", {
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
      if (response.ok) audioData = await response.arrayBuffer();
    } finally {
      releaseVoice?.();
      releaseRecovery();
    }
    if (response.ok) {
      if (!rateLimitBudget.recovering) rateLimitBudget.consecutiveResponses = 0;
      return {
        data: audioData,
        mime: response.headers.get("content-type") || "audio/mpeg",
        fingerprint: fingerprintAudio(audioData)
      };
    }
    if (response.status === 429) {
      rateLimitBudget.recovering = true;
      const now = Date.now();
      pacer.windowRequestLimit = reducedRequestWindowLimit(
        pacer.windowRequestLimit,
        MIN_SYNTHESIS_REQUESTS_PER_WINDOW
      );
      const rollingDelay = rollingRequestWindowDelay(
        pacer.recentStarts,
        now,
        pacer.windowRequestLimit,
        SYNTHESIS_REQUEST_WINDOW_MS
      );
      const requestedDelay = Math.max(
        retryAfterMilliseconds(response.headers.get("Retry-After")) ?? 0,
        Math.min(15e3, 2e3 * 2 ** rateLimitBudget.consecutiveResponses),
        rollingDelay
      );
      rateLimitBudget.consecutiveResponses += 1;
      const currentBlockEnd = Math.max(now, rateLimitBudget.blockedUntil);
      const desiredBlockEnd = now + requestedDelay;
      const requestedExtension = Math.max(0, desiredBlockEnd - currentBlockEnd);
      const remainingBudget = rateLimitBudget.maximumWaitMs - rateLimitBudget.cumulativeWaitMs;
      if (remainingBudget <= 0 && requestedExtension > 0) {
        throw new Error("TTS rate limiting reached the configured wait limit. Try playback again in a moment.");
      }
      const addedWait = Math.min(requestedExtension, Math.max(0, remainingBudget));
      rateLimitBudget.cumulativeWaitMs += addedWait;
      rateLimitBudget.blockedUntil = currentBlockEnd + addedWait;
      const retryDelay = Math.max(0, rateLimitBudget.blockedUntil - now);
      pacer.nextStartAt = Math.max(pacer.nextStartAt, rateLimitBudget.blockedUntil);
      onRateLimit(retryDelay, rateLimitBudget.cumulativeWaitMs);
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
  if (!Number.isInteger(swipeId) || (swipeId ?? -1) < 0) throw new Error("Cannot safely save audio: the target swipe ID is unavailable.");
  form.append("swipeId", String(swipeId));
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
  const responseText = await response.text();
  if (!response.ok) {
    let body = null;
    try {
      body = JSON.parse(responseText);
    } catch {
    }
    throw new Error(body?.error || `Could not save generated audio (${response.status}).`);
  }
  let result;
  try {
    result = JSON.parse(responseText);
  } catch {
    throw new Error("Lumiverse returned an invalid response after saving generated audio.");
  }
  if (typeof swipeId !== "number" || !savedAudioMatchesSwipe(result, messageId, swipeId)) {
    const error = new Error("Lumiverse did not confirm the generated audio attachment on the requested swipe.");
    error.name = "AudioSaveVerificationError";
    throw error;
  }
  return result;
}
async function ensureQuotationRouting() {
  await updateVoiceSettings((current) => {
    const currentRules = current.speechDetectionRules && typeof current.speechDetectionRules === "object" ? current.speechDetectionRules : {};
    return {
      ...current,
      speechDetectionRules: {
        ...currentRules,
        quoted: "speech",
        undecorated: "narration",
        asterisked: "narration"
      }
    };
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
    .chat-voice-character-list, .chat-voice-favorite-list {
      display:flex; flex-direction:column; gap:10px; max-height:320px; overflow-y:auto;
      box-sizing:border-box; padding:9px; border:1px solid var(--lumiverse-border);
      border-radius:var(--lumiverse-radius); background:var(--lumiverse-fill-subtle);
    }
    .chat-voice-character {
      display:flex; flex-direction:column; gap:7px; padding:11px;
      border:1px solid var(--lumiverse-border); border-radius:var(--lumiverse-radius);
      background:var(--lumiverse-fill-subtle);
    }
    .chat-voice-character-temporary { border:1px dashed #e05b5b; }
    .chat-voice-character-heading { display:flex; justify-content:space-between; gap:8px; align-items:baseline; }
    .chat-voice-character-title { display:flex; align-items:center; gap:6px; min-width:0; }
    .chat-voice-cast-preview { display:inline-flex; flex:none; align-items:center; justify-content:center; width:24px; height:24px; padding:3px; border:1px solid var(--lumiverse-border); border-radius:6px; background:var(--lumiverse-fill-subtle); color:var(--lumiverse-text); cursor:pointer; }
    .chat-voice-cast-preview svg { width:100%; height:100%; }
    .chat-voice-favorite-picker { position:relative; width:100%; }
    .chat-voice-favorite-picker summary { display:flex; align-items:center; justify-content:space-between; cursor:pointer; list-style:none; }
    .chat-voice-favorite-picker summary::-webkit-details-marker { display:none; }
    .chat-voice-favorite-picker summary::after { content:'\u2304'; font-size:16px; }
    .chat-voice-favorite-picker[aria-disabled="true"] summary { opacity:.55; cursor:not-allowed; }
    .chat-voice-favorite-options { max-height:240px; overflow:auto; border:1px solid var(--lumiverse-border); border-radius:var(--lumiverse-radius); background:var(--lumiverse-bg-secondary, #222); }
    .chat-voice-favorite-category { padding:7px 9px 3px; color:var(--lumiverse-text-muted); font-size:11px; font-weight:700; }
    .chat-voice-favorite-option { display:flex; align-items:center; gap:4px; padding:2px 4px; }
    .chat-voice-favorite-option:hover, .chat-voice-favorite-option:focus-within { background:var(--lumiverse-fill-subtle); }
    .chat-voice-favorite-option-name { flex:1; min-width:0; border:0; background:transparent; color:var(--lumiverse-text); font:inherit; font-size:12px; text-align:left; padding:7px; cursor:pointer; overflow-wrap:anywhere; }
    .chat-voice-favorite-option .chat-voice-cast-preview { opacity:0; pointer-events:none; }
    .chat-voice-favorite-option:hover .chat-voice-cast-preview, .chat-voice-favorite-option:focus-within .chat-voice-cast-preview { opacity:1; pointer-events:auto; }
    @media (hover:none) { .chat-voice-favorite-option .chat-voice-cast-preview { opacity:1; pointer-events:auto; } }
    .chat-voice-character-meta { display:flex; align-items:center; gap:6px; }
    .chat-voice-character-name { color:var(--lumiverse-text); font-size:12px; font-weight:600; }
    .chat-voice-character-count { color:var(--lumiverse-text-muted); font-size:11px; white-space:nowrap; }
    .chat-voice-selected-voice { width:100%; min-height:36px; padding:7px 9px; text-align:left;
      border:1px solid var(--lumiverse-border); border-radius:var(--lumiverse-radius);
      background:var(--lumiverse-fill-subtle); color:var(--lumiverse-text); font:inherit; font-size:12px;
      cursor:text; overflow-wrap:anywhere; }
    .chat-voice-empty {
      padding:12px; text-align:center; color:var(--lumiverse-text-muted); font-size:12px;
      border:1px dashed var(--lumiverse-border); border-radius:var(--lumiverse-radius);
    }
    .chat-voice-add-row { display:grid; grid-template-columns:minmax(0, 1fr) auto; gap:8px; }
    .chat-voice-favorites { display:flex; flex-direction:column; gap:8px; }
    .chat-voice-favorite-form { display:grid; grid-template-columns:1fr 1fr; gap:8px; padding:12px; border:1px solid var(--lumiverse-border); border-radius:var(--lumiverse-radius); background:var(--lumiverse-fill-subtle); box-sizing:border-box; }
    .chat-voice-favorite-form input, .chat-voice-rename-input, .chat-voice-favorite-select, .chat-voice-favorite-form select {
      min-width:0; width:100%; box-sizing:border-box; min-height:36px; padding:7px 9px;
      border:1px solid var(--lumiverse-border); border-radius:var(--lumiverse-radius);
      background:var(--lumiverse-bg-secondary, #222); color:var(--lumiverse-text); font:inherit; font-size:12px;
    }
    .chat-voice-favorite-span { grid-column: 1 / -1; }
    .chat-voice-favorite-add { grid-column: 1 / -1; justify-self: center; min-width: 168px; min-height: 42px; padding: 10px 28px; font-size: 13px; }
    .chat-voice-favorite-row { display:flex; flex-wrap:wrap; align-items:center; gap:8px;
      padding:8px; border:1px solid var(--lumiverse-border); border-radius:var(--lumiverse-radius); }
    .chat-voice-favorite-edit { flex:1 0 100%; display:flex; flex-wrap:wrap; gap:6px; }
    .chat-voice-favorite-edit[hidden] { display:none; }
    .chat-voice-favorite-edit input, .chat-voice-favorite-edit textarea { box-sizing:border-box; width:100%; min-width:0; padding:7px 9px; border:1px solid var(--lumiverse-border); border-radius:var(--lumiverse-radius); background:var(--lumiverse-bg-secondary, #222); color:var(--lumiverse-text); font:inherit; font-size:12px; }
    .chat-voice-favorite-edit textarea { min-height:72px; resize:vertical; }
    .chat-voice-favorite-copy { flex:1 1 100px; min-width:0; overflow-wrap:anywhere; color:var(--lumiverse-text); font-size:12px; }
    .chat-voice-favorite-copy small { display:block; color:var(--lumiverse-text-muted); }
    .chat-voice-favorite-basics { flex:1 0 100%; display:flex; flex-wrap:wrap; gap:8px; align-items:flex-end; }
    .chat-voice-favorite-basic { display:flex; flex-direction:column; gap:2px; flex:1 1 110px; min-width:0; }
    .chat-voice-favorite-basic > span { color:var(--lumiverse-text-muted); font-size:11px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; }
    .chat-voice-favorite-basic select { min-width:0; width:100%; box-sizing:border-box; min-height:32px; padding:5px 7px; border:1px solid var(--lumiverse-border); border-radius:var(--lumiverse-radius); background:var(--lumiverse-bg-secondary, #222); color:var(--lumiverse-text); font:inherit; font-size:12px; }
    .chat-voice-favorite-details { flex:1 0 100%; display:flex; flex-direction:column; gap:10px; border-top:1px solid var(--lumiverse-border); padding-top:8px; }
    .chat-voice-favorite-details[hidden] { display:none; }
    .chat-voice-favorite-details input { min-width:0; width:100%; box-sizing:border-box; min-height:34px; padding:6px 9px; border:1px solid var(--lumiverse-border); border-radius:var(--lumiverse-radius); background:var(--lumiverse-bg-secondary, #222); color:var(--lumiverse-text); font:inherit; font-size:12px; }
    .chat-voice-preview-button { min-height:28px; padding:0 8px; border:1px solid var(--lumiverse-border);
      border-radius:6px; background:var(--lumiverse-fill-subtle); color:var(--lumiverse-text); font:inherit; font-size:11px; cursor:pointer; }
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
    .chat-voice-advanced-summary::after { content:'\u203A'; color:var(--lumiverse-text-muted); transform:rotate(90deg); }
    .chat-voice-advanced-section[open] .chat-voice-advanced-summary::after { transform:rotate(-90deg); }
    .chat-voice-advanced { display:flex; flex-direction:column; gap:12px; padding-top:16px; }
    .chat-voice-number-input {
      box-sizing:border-box; width:100%; min-height:36px; padding:7px 10px;
      border:1px solid var(--lumiverse-border); border-radius:var(--lumiverse-radius);
      background:var(--lumiverse-bg-secondary, transparent); color:var(--lumiverse-text-primary); font:inherit;
    }
    .chat-voice-debug-actions { display:flex; gap:8px; }
    .chat-voice-copy-report-button {
      min-height:30px; padding:0 12px; border:1px solid var(--lumiverse-border);
      border-radius:6px; background:var(--lumiverse-fill-subtle); color:var(--lumiverse-text);
      font:inherit; font-size:12px; font-weight:600; cursor:pointer;
    }
    .chat-voice-copy-report-button:hover:not(:disabled) { filter:brightness(1.08); }
    .chat-voice-copy-report-button:disabled { cursor:not-allowed; opacity:.5; }
    .chat-voice-voices-tabs { display:flex; gap:4px; }
    .chat-voice-voices-tabs[hidden], .chat-voice-favorites[hidden], .chat-voice-community[hidden] { display:none; }
    .chat-voice-voices-tab { flex:1; min-height:36px; padding:7px 10px; border:1px solid var(--lumiverse-border);
      border-radius:var(--lumiverse-radius); background:var(--lumiverse-fill-subtle); color:var(--lumiverse-text);
      font:inherit; font-size:12px; font-weight:600; cursor:pointer; }
    .chat-voice-voices-tab[aria-selected="true"] { background:var(--lumiverse-accent, #7a68f4); color:#fff; }
    .chat-voice-community { display:flex; flex-direction:column; gap:8px; }
    .chat-voice-community-toolbar { display:grid; grid-template-columns:minmax(0, 2fr) minmax(0, 1fr) auto; gap:8px; }
    .chat-voice-community-toolbar input, .chat-voice-community-toolbar select {
      min-width:0; width:100%; box-sizing:border-box; min-height:36px; padding:7px 9px;
      border:1px solid var(--lumiverse-border); border-radius:var(--lumiverse-radius);
      background:var(--lumiverse-bg-secondary, #222); color:var(--lumiverse-text); font:inherit; font-size:12px;
    }
    .chat-voice-community-subtoolbar { display:grid; grid-template-columns:minmax(0, 1fr) minmax(0, 1fr) auto auto; gap:8px; align-items:center; }
    .chat-voice-community-subtoolbar input, .chat-voice-community-subtoolbar select {
      min-width:0; width:100%; box-sizing:border-box; min-height:36px; padding:7px 9px;
      border:1px solid var(--lumiverse-border); border-radius:var(--lumiverse-radius);
      background:var(--lumiverse-bg-secondary, #222); color:var(--lumiverse-text); font:inherit; font-size:12px;
    }
    .chat-voice-community-row { display:flex; flex-wrap:wrap; align-items:center; gap:8px;
      padding:8px; border:1px solid var(--lumiverse-border); border-radius:var(--lumiverse-radius); }
    .chat-voice-community-copy { flex:1 1 220px; min-width:0; overflow-wrap:anywhere; color:var(--lumiverse-text); font-size:12px; }
    .chat-voice-community-copy small { display:block; color:var(--lumiverse-text-muted); }
    .chat-voice-community-stats { color:var(--lumiverse-text-muted); font-size:11px; white-space:nowrap; }
    .chat-voice-pool-row { display:grid; grid-template-columns:minmax(0, 1fr) auto; gap:8px; align-items:center; }
    .chat-voice-pool-refresh-row { display:flex; align-items:center; flex-wrap:wrap; gap:8px; }
    .chat-voice-pool-language-row { display:grid; grid-template-columns:auto minmax(0, 1fr); gap:8px; align-items:center; }
    .chat-voice-pool-language-row .chat-voice-toggle-hint { grid-column: 1 / -1; }
    .chat-voice-filter-panel { display:flex; flex-direction:column; gap:10px; }
    .chat-voice-filter-group { display:flex; flex-direction:column; gap:6px; }
    .chat-voice-filter-title { color:var(--lumiverse-text-muted); font-size:11px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; }
    .chat-voice-filter-chips { display:flex; flex-wrap:wrap; gap:6px; }
    .chat-voice-filter-chip { border-radius:999px !important; font-size:11px !important; }
    .chat-voice-filter-chip[aria-pressed="true"] { background:var(--lumiverse-accent, #7a68f4); color:#fff; }
    .chat-voice-expand-more { border:0; background:transparent; color:var(--lumiverse-text-muted); font:inherit; font-size:11px; cursor:pointer; align-self:flex-start; }
    .chat-voice-community-pager { display:flex; align-items:center; gap:8px; }
    .chat-voice-community-pager .chat-voice-add-button { min-width:48px; }
    @media (max-width: 560px) {
      .chat-voice-favorite-form { grid-template-columns: minmax(0, 1fr); }
      .chat-voice-community-toolbar { grid-template-columns: minmax(0, 1fr) minmax(0, auto); }
      .chat-voice-community-toolbar .chat-voice-add-button { grid-column: 1 / -1; }
      .chat-voice-community-subtoolbar { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
      .chat-voice-community-stats { white-space: normal; overflow-wrap: anywhere; }
    }
    .chat-voice-pool-row select {
      min-width:0; min-height:36px; padding:7px 9px; border:1px solid var(--lumiverse-border);
      border-radius:var(--lumiverse-radius); background:var(--lumiverse-bg-secondary, #222); color:var(--lumiverse-text); font:inherit; font-size:12px;
    }
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
  const autoplayIndicatorStyle = hostDocument.createElement("style");
  autoplayIndicatorStyle.textContent = `button[data-chat-voice-autoplay="true"] { color: #a89bff !important; background-color: rgba(122, 104, 244, .2) !important; box-shadow: inset 0 0 0 1px rgba(168, 155, 255, .8), 0 0 8px rgba(122, 104, 244, .35) !important; border-radius: 6px; }`;
  hostDocument.head.appendChild(autoplayIndicatorStyle);
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
    return { field, label, slot };
  }
  const connectionField = createField("TTS connection (global)");
  const saveAudioField = createField("Audio storage");
  saveAudioField.slot.className = "chat-voice-storage";
  const saveAudioLabel = document.createElement("label");
  saveAudioLabel.className = "chat-voice-toggle";
  const saveAudioToggle = document.createElement("input");
  saveAudioToggle.type = "checkbox";
  saveAudioToggle.checked = true;
  saveAudioToggle.setAttribute("aria-label", "Save generated audio to messages");
  const saveAudioCopy = document.createElement("span");
  saveAudioCopy.className = "chat-voice-toggle-copy";
  const saveAudioText = document.createElement("span");
  saveAudioText.textContent = "Save generated audio";
  const saveAudioHint = document.createElement("span");
  saveAudioHint.className = "chat-voice-toggle-hint";
  saveAudioHint.textContent = "Attach completed assistant-message recordings. User-message audio is never saved.";
  saveAudioCopy.append(saveAudioText, saveAudioHint);
  saveAudioLabel.append(saveAudioToggle, saveAudioCopy);
  const saveAudioRetention = document.createElement("label");
  saveAudioRetention.className = "chat-voice-retention";
  const saveAudioRetentionCopy = document.createElement("span");
  saveAudioRetentionCopy.className = "chat-voice-retention-copy";
  saveAudioRetentionCopy.textContent = "Maximum saved recordings";
  const saveAudioLimitInput = document.createElement("input");
  saveAudioLimitInput.className = "chat-voice-retention-input";
  saveAudioLimitInput.type = "number";
  saveAudioLimitInput.min = "1";
  saveAudioLimitInput.max = "10000";
  saveAudioLimitInput.step = "1";
  saveAudioLimitInput.value = String(DEFAULT_SAVED_AUDIO_LIMIT);
  saveAudioLimitInput.setAttribute("aria-label", "Maximum saved recordings");
  saveAudioRetention.append(saveAudioRetentionCopy, saveAudioLimitInput);
  saveAudioField.slot.append(saveAudioLabel, saveAudioRetention);
  const scanField = createField("Character card cast");
  const scanRow = scanField.slot;
  scanRow.className = "chat-voice-scan-row";
  const scanButton = document.createElement("button");
  scanButton.type = "button";
  scanButton.className = "chat-voice-scan-button";
  scanButton.textContent = "Scan";
  scanButton.disabled = true;
  scanRow.append(scanButton);
  const skippedTagsField = createField("Skipped tracker tags (global)");
  const speakerParsingField = createField("Jev speaker assignment (global)");
  const ttsTagField = createField("TTS vocal tags (global)");
  const ttsTagPlacementField = createField("Vocal tag placement");
  const tagLlmConnectionField = createField("Vocal tag LLM connection");
  const tagLlmModelField = createField("Vocal tag model (optional)");
  const narratorField = createField("Narrator voice");
  const userVoiceField = createField("User voice");
  function addDefaultRoleToggle(field, titleText, ariaLabel) {
    field.label.textContent = "";
    field.label.classList.add("chat-voice-role-heading");
    const title = document.createElement("span");
    title.textContent = titleText;
    const titleGroup = document.createElement("span");
    titleGroup.className = "chat-voice-character-title";
    const preview = createCastPreviewButton(() => titleText, () => titleText === "Narrator voice" ? narratorInput.getValue() : userVoiceInput.getValue());
    titleGroup.append(preview, title);
    const toggle = document.createElement("label");
    toggle.className = "chat-voice-role-default";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.setAttribute("aria-label", ariaLabel);
    const copy = document.createElement("span");
    copy.textContent = "Use global";
    toggle.append(checkbox, copy);
    field.label.append(titleGroup, toggle);
    return checkbox;
  }
  const narratorDefaultToggle = addDefaultRoleToggle(
    narratorField,
    "Narrator voice",
    "Use the global narrator voice for this chat"
  );
  const userDefaultToggle = addDefaultRoleToggle(
    userVoiceField,
    "User voice",
    "Use the global user voice for this chat"
  );
  const routingHint = document.createElement("div");
  routingHint.className = "chat-voice-hint";
  routingHint.textContent = "Scan reads the character card, not chat history. During playback, Jev uses Lumiverse\u2019s default Decision connection to classify paragraph and dialogue identities; everything outside quotes uses the narrator voice.";
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
  characterList.setAttribute("role", "region");
  characterList.setAttribute("aria-label", "Detected voices");
  characterList.tabIndex = 0;
  const favoritesTitle = document.createElement("div");
  favoritesTitle.className = "chat-voice-section-title";
  favoritesTitle.textContent = "Favorite voices";
  const voicesTabStrip = document.createElement("div");
  voicesTabStrip.className = "chat-voice-voices-tabs";
  voicesTabStrip.setAttribute("role", "tablist");
  voicesTabStrip.setAttribute("aria-label", "Voice library");
  const communityTabButton = document.createElement("button");
  communityTabButton.type = "button";
  communityTabButton.className = "chat-voice-voices-tab";
  communityTabButton.textContent = "Community";
  communityTabButton.setAttribute("role", "tab");
  const favoriteTabButton = document.createElement("button");
  favoriteTabButton.type = "button";
  favoriteTabButton.className = "chat-voice-voices-tab";
  favoriteTabButton.textContent = "Favorite";
  favoriteTabButton.setAttribute("role", "tab");
  voicesTabStrip.append(communityTabButton, favoriteTabButton);
  const communitySection = document.createElement("div");
  communitySection.className = "chat-voice-community";
  const communityKeyRow = document.createElement("div");
  communityKeyRow.className = "chat-voice-invisible";
  communityKeyRow.hidden = true;
  const communityKeyInput = document.createElement("input");
  communityKeyInput.type = "password";
  communityKeyInput.autocomplete = "off";
  communityKeyInput.spellcheck = false;
  communityKeyInput.placeholder = "Fish Audio API key";
  communityKeyInput.setAttribute("aria-label", "Fish Audio API key");
  const communityKeySave = document.createElement("button");
  communityKeySave.type = "button";
  communityKeySave.className = "chat-voice-add-button";
  communityKeySave.textContent = "Save key";
  communityKeyRow.append(communityKeyInput, communityKeySave);
  communitySection.appendChild(communityKeyRow);
  const communityError = document.createElement("div");
  communityError.className = "chat-voice-status";
  communityError.dataset.state = "error";
  communityError.setAttribute("role", "alert");
  communityError.hidden = true;
  communitySection.appendChild(communityError);
  const communityToolbar = document.createElement("div");
  communityToolbar.className = "chat-voice-community-toolbar";
  const communitySearch = document.createElement("input");
  communitySearch.placeholder = "Search community voices";
  communitySearch.setAttribute("aria-label", "Search community voices");
  const communitySort = document.createElement("select");
  communitySort.setAttribute("aria-label", "Sort community voices");
  for (const [value, label] of [["score", "Best score"], ["task_count", "Most played"], ["created_at", "Newest"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    communitySort.appendChild(option);
  }
  const communitySearchButton = document.createElement("button");
  communitySearchButton.type = "button";
  communitySearchButton.className = "chat-voice-add-button";
  communitySearchButton.textContent = "Search";
  communityToolbar.append(communitySearch, communitySort, communitySearchButton);
  const communityPrev = document.createElement("button");
  communityPrev.type = "button";
  communityPrev.className = "chat-voice-add-button";
  communityPrev.textContent = "\u2190";
  communityPrev.setAttribute("aria-label", "Previous results page");
  const communityNext = document.createElement("button");
  communityNext.type = "button";
  communityNext.className = "chat-voice-add-button";
  communityNext.textContent = "\u2192";
  communityNext.setAttribute("aria-label", "Next results page");
  const communityPageLabel = document.createElement("span");
  communityPageLabel.className = "chat-voice-community-stats";
  communityPageLabel.textContent = "";
  const communityPager = document.createElement("div");
  communityPager.className = "chat-voice-community-pager";
  communityPager.append(communityPrev, communityPageLabel, communityNext);
  const communityTags = document.createElement("input");
  communityTags.placeholder = "Tags (comma-separated)";
  communityTags.setAttribute("aria-label", "Community voice tags");
  const communityFilterPanel = document.createElement("div");
  communityFilterPanel.className = "chat-voice-filter-panel";
  const communityLanguagesSection = document.createElement("div");
  communityLanguagesSection.className = "chat-voice-filter-group";
  const communityLanguagesTitle = document.createElement("div");
  communityLanguagesTitle.className = "chat-voice-filter-title";
  communityLanguagesTitle.textContent = "Languages";
  const communityLanguagesHint = document.createElement("div");
  communityLanguagesHint.className = "chat-voice-hint";
  communityLanguagesHint.textContent = "Models must match the selected language.";
  const communityLanguage = document.createElement("select");
  communityLanguage.setAttribute("aria-label", "Community voice language");
  for (const [value, label] of [["", "Any language"], ["en", "\u{1F1FA}\u{1F1F8} English"], ["es", "\u{1F1EA}\u{1F1F8} Spanish"], ["ar", "\u{1F1F8}\u{1F1E6} Arabic"], ["ru", "\u{1F1F7}\u{1F1FA} Russian"], ["ja", "\u{1F1EF}\u{1F1F5} Japanese"], ["pt", "\u{1F1E7}\u{1F1F7} Portuguese"], ["zh", "\u{1F1E8}\u{1F1F3} Chinese"], ["fr", "\u{1F1EB}\u{1F1F7} French"], ["it", "\u{1F1EE}\u{1F1F9} Italian"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    communityLanguage.appendChild(option);
  }
  communityLanguagesSection.append(communityLanguagesTitle, communityLanguagesHint, communityLanguage);
  const communityFilterTags = document.createElement("div");
  communityFilterTags.className = "chat-voice-filter-group";
  const communityFilterTagsTitle = document.createElement("div");
  communityFilterTagsTitle.className = "chat-voice-filter-title";
  communityFilterTagsTitle.textContent = "Tags";
  communityTags.placeholder = "Tags (comma-separated)";
  communityTags.setAttribute("aria-label", "Community voice tags");
  communityFilterTags.append(communityFilterTagsTitle, communityTags);
  const communityFilterGroups = [
    { title: "Gender", tags: [["male", "Male"], ["female", "Female"]], exclusive: true },
    { title: "Age", tags: [["young", "Young"], ["middle aged", "Middle Aged"], ["old", "Old"]], exclusive: true },
    { title: "Use Case", tags: [["conversational", "Conversational"], ["narration", "Narration"], ["character voice", "Character Voice"], ["social media", "Social Media"], ["educational", "Educational"], ["advertisement", "Advertisement"], ["entertainment", "Entertainment"]] },
    { title: "Voice Qualities", tags: [["deep", "Deep"], ["low", "Low"], ["medium", "Medium"], ["high", "High"], ["soft", "Soft"], ["bright", "Bright"]] }
  ];
  const communityFilterQualityExtended = [
    ["warm", "Warm"],
    ["dark", "Dark"],
    ["raspy", "Raspy"],
    ["smooth", "Smooth"],
    ["breathy", "Breathy"],
    ["husky", "Husky"],
    ["energetic", "Energetic"],
    ["calm", "Calm"],
    ["relaxed", "Relaxed"],
    ["fast", "Fast"],
    ["slow", "Slow"],
    ["measured", "Measured"],
    ["dynamic", "Dynamic"],
    ["sexy", "Sexy"],
    ["friendly", "Friendly"],
    ["professional", "Professional"],
    ["serious", "Serious"],
    ["cheerful", "Cheerful"],
    ["enthusiastic", "Enthusiastic"],
    ["confident", "Confident"],
    ["authoritative", "Authoritative"],
    ["gentle", "Gentle"],
    ["empathetic", "Empathetic"],
    ["playful", "Playful"],
    ["dramatic", "Dramatic"],
    ["intimate", "Intimate"],
    ["mysterious", "Mysterious"],
    ["sad", "Sad"],
    ["angry", "Angry"],
    ["clear", "Clear"],
    ["crisp", "Crisp"],
    ["neutral tone", "Neutral Tone"],
    ["expressive", "Expressive"],
    ["monotone", "Monotone"],
    ["animated", "Animated"],
    ["storytelling", "Storytelling"],
    ["narrative", "Narrative"],
    ["character", "Character"],
    ["announcer", "Announcer"],
    ["host", "Host"],
    ["teacher", "Teacher"],
    ["coach", "Coach"],
    ["anime", "Anime"],
    ["gaming", "Gaming"],
    ["cinematic", "Cinematic"],
    ["documentary", "Documentary"],
    ["radio", "Radio"],
    ["podcast", "Podcast"]
  ];
  const communityAdvancedFilters = document.createElement("div");
  communityAdvancedFilters.className = "chat-voice-filter-advanced";
  communityAdvancedFilters.hidden = true;
  communityFilterPanel.append(communityLanguagesSection, communityFilterTags, communityAdvancedFilters);
  const communityExpandMore = document.createElement("button");
  communityExpandMore.type = "button";
  communityExpandMore.className = "chat-voice-expand-more";
  communityExpandMore.textContent = "\u22EF More filters";
  const communityBestButton = document.createElement("button");
  communityBestButton.type = "button";
  communityBestButton.className = "chat-voice-add-button";
  communityBestButton.textContent = "Community Best";
  communityBestButton.title = "Load the cached top community voices for browsing";
  communityFilterPanel.append(communityLanguagesSection, communityFilterTags, communityBestButton);
  for (const group of communityFilterGroups) {
    const section = document.createElement("div");
    section.className = "chat-voice-filter-group";
    const title = document.createElement("div");
    title.className = "chat-voice-filter-title";
    title.textContent = group.title ?? "";
    section.appendChild(title);
    const chips = document.createElement("div");
    chips.className = "chat-voice-filter-chips";
    for (const [tag, label] of group.tags) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chat-voice-add-button chat-voice-filter-chip";
      chip.dataset.tag = tag;
      chip.dataset.group = group.title ?? "";
      chip.setAttribute("aria-pressed", "false");
      chip.textContent = `+ ${label}`;
      chip.addEventListener("click", () => {
        const engaged = chip.getAttribute("aria-pressed") === "true";
        if (group.exclusive) {
          for (const other of chips.querySelectorAll(".chat-voice-filter-chip")) {
            other.setAttribute("aria-pressed", "false");
            other.textContent = other.textContent.replace(/^✓ /, "+ ");
          }
        }
        chip.setAttribute("aria-pressed", String(!engaged));
        chip.textContent = `${engaged ? "+" : "\u2713"} ${label}`;
      });
      chips.appendChild(chip);
    }
    if (group.title === "Voice Qualities") {
      for (const [tag, label] of communityFilterQualityExtended) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "chat-voice-add-button chat-voice-filter-chip";
        chip.dataset.tag = tag;
        chip.dataset.group = group.title;
        chip.hidden = true;
        chip.setAttribute("aria-pressed", "false");
        chip.textContent = `+ ${label}`;
        chip.addEventListener("click", () => {
          const engaged = chip.getAttribute("aria-pressed") === "true";
          chip.setAttribute("aria-pressed", String(!engaged));
          chip.textContent = `${engaged ? "+" : "\u2713"} ${label}`;
        });
        chips.appendChild(chip);
      }
      const more = document.createElement("button");
      more.type = "button";
      more.className = "chat-voice-expand-more";
      more.textContent = `+ ${communityFilterQualityExtended.length} more`;
      let qualityExpanded = false;
      more.addEventListener("click", () => {
        qualityExpanded = !qualityExpanded;
        for (const chip of chips.querySelectorAll(".chat-voice-filter-chip")) {
          if ((chip.dataset.group ?? "") !== "Voice Qualities") continue;
          if (qualityExpanded) chip.hidden = false;
          else if (!["deep", "low", "medium", "high", "soft", "bright"].includes(chip.dataset.tag ?? "")) chip.hidden = true;
        }
        more.textContent = qualityExpanded ? "Show less" : `+ ${communityFilterQualityExtended.length} more`;
      });
      chips.appendChild(more);
    }
    section.appendChild(chips);
    communityAdvancedFilters.appendChild(section);
  }
  communityExpandMore.addEventListener("click", () => {
    communityAdvancedFilters.hidden = !communityAdvancedFilters.hidden;
    communityExpandMore.textContent = communityAdvancedFilters.hidden ? "\u22EF More filters" : "Show less";
  });
  communityFilterPanel.appendChild(communityExpandMore);
  communitySection.append(communityToolbar, communityFilterPanel, communityPager);
  const communityList = document.createElement("div");
  communityList.className = "chat-voice-favorite-list";
  communityList.setAttribute("role", "region");
  communityList.setAttribute("aria-label", "Community voices");
  communityList.tabIndex = 0;
  communitySection.appendChild(communityList);
  const favoritesSection = document.createElement("div");
  favoritesSection.className = "chat-voice-favorites";
  const favoriteForm = document.createElement("div");
  favoriteForm.className = "chat-voice-favorite-form";
  const favoriteName = document.createElement("input");
  favoriteName.placeholder = "Name (optional)";
  favoriteName.setAttribute("aria-label", "Favorite voice name");
  const favoriteId = document.createElement("input");
  favoriteId.placeholder = "Voice ID";
  favoriteId.maxLength = 512;
  favoriteId.setAttribute("aria-label", "Favorite voice ID");
  const favoriteDescription = document.createElement("input");
  favoriteDescription.placeholder = "Description (e.g. gentle, tired)";
  favoriteDescription.maxLength = 500;
  favoriteDescription.setAttribute("aria-label", "Favorite voice description");
  favoriteDescription.classList.add("chat-voice-favorite-span");
  const favoriteMetaExpand = document.createElement("button");
  favoriteMetaExpand.type = "button";
  favoriteMetaExpand.className = "chat-voice-expand-more";
  favoriteMetaExpand.textContent = "\u22EF Metadata";
  const favoriteMetaPanel = document.createElement("div");
  favoriteMetaPanel.className = "chat-voice-filter-panel";
  favoriteMetaPanel.hidden = true;
  favoriteMetaPanel.classList.add("chat-voice-favorite-span");
  const favoriteLanguages = document.createElement("select");
  favoriteLanguages.className = "chat-voice-favorite-select";
  favoriteLanguages.setAttribute("aria-label", "Favorite voice language");
  for (const [value, label] of [["", "Any language"], ["en", "\u{1F1FA}\u{1F1F8} English"], ["es", "\u{1F1EA}\u{1F1F8} Spanish"], ["ar", "\u{1F1F8}\u{1F1E6} Arabic"], ["ru", "\u{1F1F7}\u{1F1FA} Russian"], ["ja", "\u{1F1EF}\u{1F1F5} Japanese"], ["pt", "\u{1F1E7}\u{1F1F7} Portuguese"], ["zh", "\u{1F1E8}\u{1F1F3} Chinese"], ["fr", "\u{1F1EB}\u{1F1F7} French"], ["it", "\u{1F1EE}\u{1F1F9} Italian"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    favoriteLanguages.appendChild(option);
  }
  const favoriteMetaGroups = [
    { title: "Gender", tags: [["male", "Male"], ["female", "Female"]], exclusive: true },
    { title: "Age", tags: [["young", "Young"], ["middle aged", "Middle Aged"], ["old", "Old"]], exclusive: true },
    { title: "Use Case", tags: [["conversational", "Conversational"], ["narration", "Narration"], ["character voice", "Character Voice"], ["social media", "Social Media"], ["educational", "Educational"], ["advertisement", "Advertisement"], ["entertainment", "Entertainment"]] },
    { title: "Voice Qualities", tags: [["deep", "Deep"], ["low", "Low"], ["medium", "Medium"], ["high", "High"], ["soft", "Soft"], ["bright", "Bright"]] }
  ];
  for (const group of favoriteMetaGroups) {
    const section = document.createElement("div");
    section.className = "chat-voice-filter-group";
    const title = document.createElement("div");
    title.className = "chat-voice-filter-title";
    title.textContent = group.title ?? "";
    section.appendChild(title);
    const chips = document.createElement("div");
    chips.className = "chat-voice-filter-chips";
    for (const [tag, label] of group.tags) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chat-voice-add-button chat-voice-filter-chip";
      chip.dataset.tag = tag;
      chip.dataset.group = group.title ?? "";
      chip.setAttribute("aria-pressed", "false");
      chip.textContent = `+ ${label}`;
      chip.addEventListener("click", () => {
        const engaged = chip.getAttribute("aria-pressed") === "true";
        if (group.exclusive) {
          for (const other of chips.querySelectorAll(".chat-voice-filter-chip")) {
            other.setAttribute("aria-pressed", "false");
            other.textContent = other.textContent.replace(/^✓ /, "+ ");
          }
        }
        chip.setAttribute("aria-pressed", String(!engaged));
        chip.textContent = `${engaged ? "+" : "\u2713"} ${label}`;
      });
      chips.appendChild(chip);
    }
    if (group.title === "Voice Qualities") {
      for (const [tag, label] of communityFilterQualityExtended) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "chat-voice-add-button chat-voice-filter-chip";
        chip.dataset.tag = tag;
        chip.dataset.group = group.title;
        chip.hidden = true;
        chip.setAttribute("aria-pressed", "false");
        chip.textContent = `+ ${label}`;
        chip.addEventListener("click", () => {
          const engaged = chip.getAttribute("aria-pressed") === "true";
          chip.setAttribute("aria-pressed", String(!engaged));
          chip.textContent = `${engaged ? "+" : "\u2713"} ${label}`;
        });
        chips.appendChild(chip);
      }
      const more = document.createElement("button");
      more.type = "button";
      more.className = "chat-voice-expand-more";
      more.textContent = `+ ${communityFilterQualityExtended.length} more`;
      let qualityExpanded = false;
      more.addEventListener("click", () => {
        qualityExpanded = !qualityExpanded;
        for (const chip of chips.querySelectorAll(".chat-voice-filter-chip")) {
          if ((chip.dataset.group ?? "") !== "Voice Qualities") continue;
          if (qualityExpanded) chip.hidden = false;
          else if (!["deep", "low", "medium", "high", "soft", "bright"].includes(chip.dataset.tag ?? "")) chip.hidden = true;
        }
        more.textContent = qualityExpanded ? "Show less" : `+ ${communityFilterQualityExtended.length} more`;
      });
      chips.appendChild(more);
    }
    section.appendChild(chips);
    favoriteMetaPanel.appendChild(section);
  }
  const favoriteLanguageSection = document.createElement("div");
  favoriteLanguageSection.className = "chat-voice-filter-group";
  const favoriteLanguageTitle = document.createElement("div");
  favoriteLanguageTitle.className = "chat-voice-filter-title";
  favoriteLanguageTitle.textContent = "Languages";
  const favoriteLanguageHint = document.createElement("div");
  favoriteLanguageHint.className = "chat-voice-hint";
  favoriteLanguageHint.textContent = "Models must match the selected language.";
  favoriteLanguageSection.append(favoriteLanguageTitle, favoriteLanguageHint, favoriteLanguages);
  favoriteMetaPanel.prepend(favoriteLanguageSection);
  favoriteMetaExpand.addEventListener("click", () => {
    favoriteMetaPanel.hidden = !favoriteMetaPanel.hidden;
    favoriteMetaExpand.textContent = favoriteMetaPanel.hidden ? "\u22EF Metadata" : "Show less";
  });
  const favoriteAdd = document.createElement("button");
  favoriteAdd.type = "button";
  favoriteAdd.className = "chat-voice-add-button chat-voice-favorite-add";
  favoriteAdd.textContent = "Add favorite";
  favoriteForm.append(favoriteName, favoriteId, favoriteDescription, favoriteMetaExpand, favoriteMetaPanel, favoriteAdd);
  const favoriteFilter = document.createElement("select");
  favoriteFilter.className = "chat-voice-favorite-select";
  favoriteFilter.setAttribute("aria-label", "Filter favorite voices");
  for (const [value, label] of [["unspecified", "Unspecified (all voices)"], ["male", "Male"], ["female", "Female"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    favoriteFilter.appendChild(option);
  }
  favoriteFilter.addEventListener("change", () => renderFavoriteVoices());
  const favoriteList = document.createElement("div");
  favoriteList.className = "chat-voice-favorite-list";
  favoriteList.setAttribute("role", "region");
  favoriteList.setAttribute("aria-label", "Favorite voices");
  favoriteList.tabIndex = 0;
  const favoriteError = document.createElement("div");
  favoriteError.className = "chat-voice-status";
  favoriteError.dataset.state = "error";
  favoriteError.setAttribute("role", "alert");
  favoriteError.hidden = true;
  favoritesSection.append(favoriteForm, favoriteError, favoriteFilter, favoriteList);
  const status = document.createElement("div");
  status.className = "chat-voice-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const advancedSection = document.createElement("details");
  advancedSection.className = "chat-voice-advanced-section";
  const advancedSummary = document.createElement("summary");
  advancedSummary.className = "chat-voice-advanced-summary";
  advancedSummary.textContent = "Advanced settings";
  const advancedBody = document.createElement("div");
  advancedBody.className = "chat-voice-advanced";
  advancedSection.append(advancedSummary, advancedBody);
  panel.append(
    context,
    connectionField.field,
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
    favoritesTitle,
    voicesTabStrip,
    favoritesSection,
    communitySection,
    status,
    advancedSection
  );
  tab.root.appendChild(panel);
  const playbackBufferField = createField("Playback buffer segments");
  const concurrentGenerationField = createField("Maximum concurrent generations");
  const rateLimitWaitField = createField("Rate-limit wait budget (seconds)");
  const autoPlaybackDelayField = createField("Autoplay delay (seconds)");
  const ghostLifetimeField = createField("Uncast voice lifetime (assistant messages)");
  const speakerLookbackField = createField("Global speaker context (messages)");
  const autoCastingLabel = document.createElement("label");
  autoCastingLabel.className = "chat-voice-toggle";
  const autoCastingToggle = document.createElement("input");
  autoCastingToggle.type = "checkbox";
  autoCastingToggle.checked = true;
  const autoCastingText = document.createElement("span");
  autoCastingText.textContent = "Automatically cast voices";
  autoCastingLabel.append(autoCastingToggle, autoCastingText);
  const autoVoicePoolField = createField("Auto-cast voice pool");
  const autoVoicePoolText = document.createElement("span");
  autoVoicePoolText.textContent = "Auto-cast voice pool";
  const autoVoicePoolSelect = document.createElement("select");
  autoVoicePoolSelect.className = "chat-voice-favorite-select";
  autoVoicePoolSelect.setAttribute("aria-label", "Auto-cast voice pool");
  for (const [value, label] of [["favorite", "Favorites"], ["community", "Community snapshot"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    autoVoicePoolSelect.appendChild(option);
  }
  const autoVoicePoolHint = document.createElement("span");
  autoVoicePoolHint.className = "chat-voice-hint";
  autoVoicePoolHint.textContent = "Choose Favorites or the cached Fish community snapshot when auto-casting. The Community tab is available with Fish vocal tags; this pool only samples snapshot voices.";
  autoVoicePoolField.slot.append(autoVoicePoolSelect, autoVoicePoolHint);
  const autoVoicePoolActions = document.createElement("div");
  autoVoicePoolActions.className = "chat-voice-pool-refresh-row";
  const autoVoicePoolRefresh = document.createElement("button");
  autoVoicePoolRefresh.type = "button";
  autoVoicePoolRefresh.className = "chat-voice-add-button";
  autoVoicePoolRefresh.textContent = "Refresh snapshot";
  const communityPoolStatus = document.createElement("span");
  communityPoolStatus.className = "chat-voice-hint";
  communityPoolStatus.textContent = "";
  const snapshotLanguageRow = document.createElement("label");
  snapshotLanguageRow.className = "chat-voice-pool-language-row";
  const snapshotLanguageText = document.createElement("span");
  snapshotLanguageText.textContent = "Snapshot language";
  const snapshotLanguageSelect = document.createElement("select");
  snapshotLanguageSelect.className = "chat-voice-favorite-select";
  snapshotLanguageSelect.setAttribute("aria-label", "Community snapshot language");
  for (const [value, label] of [["", "All languages"], ["en", "\u{1F1FA}\u{1F1F8} English"], ["es", "\u{1F1EA}\u{1F1F8} Spanish"], ["ar", "\u{1F1F8}\u{1F1E6} Arabic"], ["ru", "\u{1F1F7}\u{1F1FA} Russian"], ["ja", "\u{1F1EF}\u{1F1F5} Japanese"], ["pt", "\u{1F1E7}\u{1F1F7} Portuguese"], ["zh", "\u{1F1E8}\u{1F1F3} Chinese"], ["fr", "\u{1F1EB}\u{1F1F7} French"], ["it", "\u{1F1EE}\u{1F1F9} Italian"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    snapshotLanguageSelect.appendChild(option);
  }
  const snapshotLanguageHint = document.createElement("span");
  snapshotLanguageHint.className = "chat-voice-toggle-hint";
  snapshotLanguageHint.textContent = "Top-100 snapshot is drawn only from voices matching this language (all = any language).";
  snapshotLanguageRow.append(snapshotLanguageText, snapshotLanguageSelect, snapshotLanguageHint);
  autoVoicePoolActions.append(autoVoicePoolRefresh, communityPoolStatus);
  const autoPlaybackLabel = document.createElement("label");
  autoPlaybackLabel.className = "chat-voice-toggle";
  const autoPlaybackToggle = document.createElement("input");
  autoPlaybackToggle.type = "checkbox";
  const autoPlaybackCopy = document.createElement("span");
  autoPlaybackCopy.className = "chat-voice-toggle-copy";
  const autoPlaybackText = document.createElement("span");
  autoPlaybackText.textContent = "Automatically play new messages and rerolls";
  const autoPlaybackHint = document.createElement("span");
  autoPlaybackHint.className = "chat-voice-toggle-hint";
  autoPlaybackHint.textContent = "Play new assistant messages and foreground rerolls as they arrive. You can also hold a message play button to toggle this. Your browser may require a click before audio can start.";
  autoPlaybackCopy.append(autoPlaybackText, autoPlaybackHint);
  autoPlaybackLabel.append(autoPlaybackToggle, autoPlaybackCopy);
  const speakerDebugLabel = document.createElement("label");
  speakerDebugLabel.className = "chat-voice-toggle";
  const speakerDebugToggle = document.createElement("input");
  speakerDebugToggle.type = "checkbox";
  speakerDebugToggle.setAttribute("aria-label", "Show speaker assignment debug log");
  const speakerDebugCopy = document.createElement("span");
  speakerDebugCopy.className = "chat-voice-toggle-copy";
  const speakerDebugText = document.createElement("span");
  speakerDebugText.textContent = "Speaker assignment debug";
  const speakerDebugHint = document.createElement("span");
  speakerDebugHint.className = "chat-voice-toggle-hint";
  speakerDebugHint.textContent = "Records both Jev passes, the turn matrix, narrative cues, dialogue-run review, inheritance, fallbacks, aliases, and the final voice route for every segment.";
  speakerDebugCopy.append(speakerDebugText, speakerDebugHint);
  speakerDebugLabel.append(speakerDebugToggle, speakerDebugCopy);
  const skipNarrationLabel = document.createElement("label");
  skipNarrationLabel.className = "chat-voice-toggle";
  const skipNarrationToggle = document.createElement("input");
  skipNarrationToggle.type = "checkbox";
  const skipNarrationCopy = document.createElement("span");
  skipNarrationCopy.className = "chat-voice-toggle-copy";
  const skipNarrationText = document.createElement("span");
  skipNarrationText.textContent = "Skip narration audio";
  const skipNarrationHint = document.createElement("span");
  skipNarrationHint.className = "chat-voice-toggle-hint";
  skipNarrationHint.textContent = "Generate dialogue only. Narration still provides speaker context; existing saved audio is unchanged until regenerated.";
  skipNarrationCopy.append(skipNarrationText, skipNarrationHint);
  skipNarrationLabel.append(skipNarrationToggle, skipNarrationCopy);
  const speakerDebugOutput = document.createElement("textarea");
  speakerDebugOutput.className = "chat-voice-debug-output";
  speakerDebugOutput.readOnly = true;
  speakerDebugOutput.hidden = true;
  speakerDebugOutput.placeholder = "Generate TTS to see the turn matrix, discourse review, inheritance, and voice-route trace.";
  speakerDebugOutput.setAttribute("aria-label", "Speaker assignment debug log");
  const debugActions = document.createElement("div");
  debugActions.className = "chat-voice-debug-actions";
  const copyReportButton = document.createElement("button");
  copyReportButton.type = "button";
  copyReportButton.className = "chat-voice-copy-report-button";
  copyReportButton.textContent = "Copy Report";
  copyReportButton.addEventListener("click", () => {
    void copyDebugReport();
  });
  debugActions.append(copyReportButton);
  const advancedHint = document.createElement("div");
  advancedHint.className = "chat-voice-hint";
  advancedHint.textContent = "Concurrency starts at one and adapts up to the selected maximum. Dense short-segment runs stay at one request at a time, while sustained long runs increase gradually. Larger buffers reduce pauses but delay playback. The wait budget controls cumulative rate-limit cooldowns.";
  advancedBody.append(
    saveAudioField.field,
    playbackBufferField.field,
    concurrentGenerationField.field,
    rateLimitWaitField.field,
    ghostLifetimeField.field,
    speakerLookbackField.field,
    autoCastingLabel,
    autoVoicePoolField.field,
    snapshotLanguageRow,
    autoVoicePoolActions,
    autoPlaybackLabel,
    autoPlaybackDelayField.field,
    skipNarrationLabel,
    speakerDebugLabel,
    debugActions,
    speakerDebugOutput,
    advancedHint
  );
  let applyingState = false;
  let activeChat = null;
  const autoPlaybackSeenGenerations = /* @__PURE__ */ new Set();
  const autoPlaybackSeenMessages = /* @__PURE__ */ new Set();
  let autoPlaybackQueue = Promise.resolve();
  const autoPlaybackRequests = new AutoplayRequestRegistry();
  let autoPlaybackDisposed = false;
  let autoPlaybackEpoch = 0;
  let connections = [];
  let lumiverseConnectionId = "";
  let savingGlobalConnection = false;
  let globalConnectionVersion = 0;
  let defaultNarratorVoice = "";
  let defaultUserVoice = "";
  let favoriteVoices = [];
  let favoritesSaving = false;
  let editingFavoriteVoiceId = null;
  const favoriteDetailsOpen = /* @__PURE__ */ new Set();
  let fishApiKey = "";
  let communityVoiceLanguage = "";
  let autoVoiceCastingPool = "favorite";
  let communityVoices = [];
  let communityVoicesAt = "";
  let voicesTab = "community";
  let communitySearchTitle = "";
  let communitySearchTags = [];
  let communitySearchLanguage = [];
  let communitySortBy = "score";
  let communityPage = 1;
  let communityItems = [];
  let communityTotal = 0;
  let communityHasMore = false;
  let communityLoading = false;
  let communityBest = false;
  let communityBestItems = [];
  let communityAutoSeeded = false;
  let previewController = null;
  let previewAudio = null;
  let previewUrl = null;
  const favoritePickers = /* @__PURE__ */ new Set();
  const favoritePickerViews = /* @__PURE__ */ new WeakMap();
  let openFavoritePicker = null;
  const closeFavoritePickerOnOutsideClick = (event) => {
    if (openFavoritePicker && !event.composedPath().includes(openFavoritePicker)) openFavoritePicker.open = false;
  };
  const closeFavoritePickerOnEscape = (event) => {
    if (event.key !== "Escape" || !openFavoritePicker) return;
    const summary = openFavoritePicker.querySelector("summary");
    openFavoritePicker.open = false;
    summary?.focus();
  };
  hostDocument.addEventListener("pointerdown", closeFavoritePickerOnOutsideClick);
  hostDocument.addEventListener("keydown", closeFavoritePickerOnEscape);
  let localNarratorVoice = "";
  let localUserVoice = "";
  let useGlobalNarratorVoice = true;
  let useGlobalUserVoice = true;
  let narratorGlobalSaveTimer = null;
  let userGlobalSaveTimer = null;
  let savingNarratorGlobalVoice = false;
  let savingUserGlobalVoice = false;
  let saveGeneratedAudio = true;
  let savedAudioLimit = DEFAULT_SAVED_AUDIO_LIMIT;
  let savingAudioPreference = false;
  let savingAudioLimit = false;
  let skippedTrackerTags = "";
  let skippedTrackerTagsDirty = false;
  let savingSkippedTrackerTags = false;
  let skippedTrackerTagsSaveTimer = null;
  let speakerParsingMode = "ambiguous";
  let ttsTagStyle = "off";
  let ttsTagPlacement = "jev";
  let tagLlmConnectionId = "";
  let tagLlmModel = "";
  let llmConnections = [];
  let tagLlmModelConnectionId = "";
  let tagLlmModelComboboxEnabled = false;
  const tagPlacementCache = /* @__PURE__ */ new Map();
  let decisionConnectionsKnown = false;
  let decisionConnectionAvailable = false;
  let decisionConnectionName = "";
  let decisionStatusFailed = false;
  let llmSettingsSaveTimer = null;
  let savingLlmSettings = false;
  let playbackBufferSegments = DEFAULT_PLAYBACK_BUFFER_SEGMENTS;
  let concurrentGenerationLimit = DEFAULT_CONCURRENT_GENERATIONS;
  let rateLimitWaitSeconds = DEFAULT_RATE_LIMIT_WAIT_SECONDS;
  let autoVoiceCasting = true;
  let autoPlayback = false;
  let autoPlaybackDelaySeconds = 0;
  const playbackStartup = new PlaybackStartupGuard();
  let ghostVoiceLifetime = GHOST_VOICE_LIFETIME_MESSAGES;
  let speakerLookback = DEFAULT_SPEAKER_LOOKBACK;
  let ghostLifetimeLoaded = false;
  let speakerAssignmentDebug = false;
  let skipNarration = false;
  let advancedSettingsSaveTimer = null;
  let savingAdvancedSettings = false;
  let saveTimer = null;
  let editRevision = 0;
  let dirty = false;
  let scanning = false;
  let activePlayback = null;
  const backgroundSynthesisControllers = /* @__PURE__ */ new Set();
  const backgroundSynthesisByMessage = /* @__PURE__ */ new Map();
  const sharedSynthesisPacer = {
    nextStartAt: 0,
    startQueue: Promise.resolve(),
    recentStarts: [],
    windowRequestLimit: DEFAULT_SYNTHESIS_REQUESTS_PER_WINDOW
  };
  const connectionVoiceGates = /* @__PURE__ */ new Map();
  const foregroundSynthesisQueue = [];
  const backgroundSynthesisQueue = [];
  const adaptiveSynthesisLimits = /* @__PURE__ */ new Map();
  let activeSynthesisTasks = 0;
  function effectiveSynthesisLimit() {
    return adaptiveSynthesisLimits.size > 0 ? Math.max(...adaptiveSynthesisLimits.values()) : concurrentGenerationLimit;
  }
  function drainSynthesisQueue() {
    while (activeSynthesisTasks < effectiveSynthesisLimit()) {
      const next = foregroundSynthesisQueue.shift() ?? backgroundSynthesisQueue.shift();
      if (!next) return;
      activeSynthesisTasks += 1;
      void next().finally(() => {
        activeSynthesisTasks -= 1;
        drainSynthesisQueue();
      });
    }
  }
  function runSynthesisTask(task, foreground) {
    return new Promise((resolve, reject) => {
      const queued = async () => {
        try {
          resolve(await task());
        } catch (error) {
          reject(error);
        }
      };
      const queue = foreground ? foregroundSynthesisQueue : backgroundSynthesisQueue;
      queue.push(queued);
      drainSynthesisQueue();
    });
  }
  const inFlight = /* @__PURE__ */ new Set();
  const characterInputs = /* @__PURE__ */ new Map();
  const characterVoiceDisplays = /* @__PURE__ */ new Map();
  const ghostVoiceEditors = /* @__PURE__ */ new Map();
  let editingCharacterVoiceId = null;
  let lastContextMessageId = null;
  const nativeButtonStates = /* @__PURE__ */ new Map();
  const pendingMessageRequests = /* @__PURE__ */ new Map();
  const pendingStateRequests = /* @__PURE__ */ new Map();
  const pendingSpeakerParseRequests = /* @__PURE__ */ new Map();
  const pendingDecisionStatusRequests = /* @__PURE__ */ new Map();
  const pendingLlmConnectionRequests = /* @__PURE__ */ new Map();
  const pendingTagPlacementRequests = /* @__PURE__ */ new Map();
  const pendingUncastRequests = /* @__PURE__ */ new Map();
  let uncastRequestSequence = 0;
  let messageRequestSequence = 0;
  let stateRequestSequence = 0;
  let speakerParseRequestSequence = 0;
  let decisionStatusRequestSequence = 0;
  let llmConnectionRequestSequence = 0;
  let tagPlacementRequestSequence = 0;
  const setStatus = (message, state = "normal") => {
    status.textContent = message;
    status.dataset.state = state;
  };
  function nativeTtsButtonLabel(button) {
    return [
      button.getAttribute("title"),
      button.getAttribute("aria-label"),
      button.textContent
    ].filter(Boolean).join(" ").toLowerCase();
  }
  function isExplicitTtsButton(button) {
    const label = nativeTtsButtonLabel(button);
    const iconClass = button.querySelector("svg")?.getAttribute("class")?.toLowerCase() ?? "";
    return button.dataset.chatVoiceNativeTts === "true" || iconClass.includes("volume-2") || iconClass.includes("volume2") || iconClass.includes("volume-high") || /\btts\b|text[ -]to[ -]speech|stop playback|regenerate.+audio/.test(label);
  }
  function preferredTtsActionIndex() {
    for (const actions of hostDocument.querySelectorAll('[data-component="BubbleActions"]')) {
      const buttons = [...actions.children].filter((child) => child.tagName === "BUTTON");
      const index = buttons.findIndex((button) => isExplicitTtsButton(button));
      if (index >= 0) return index;
    }
    return 3;
  }
  function insertAtActionIndex(container, action, index) {
    const actions = [...container.children].filter((child) => child.tagName === "BUTTON" || child.getAttribute("role") === "menuitem");
    container.insertBefore(action, actions[index] ?? null);
  }
  function nativeTtsMessageId(button) {
    if (button.closest("[data-spindle-extension-root]")) return null;
    const explicitTtsButton = isExplicitTtsButton(button);
    if (!explicitTtsButton) return null;
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
    clearLabel: "Use default TTS connection",
    ariaLabel: "Global TTS connection",
    disabled: true,
    onChange: () => {
      void onGlobalConnectionChanged();
    }
  });
  async function onGlobalConnectionChanged() {
    if (applyingState) return;
    const previous = lumiverseConnectionId;
    const selected = connectionPicker.getValue();
    const version = ++globalConnectionVersion;
    lumiverseConnectionId = resolveGlobalTtsConnection(selected, connections);
    savingGlobalConnection = true;
    setStatus("Saving global TTS connection\u2026");
    try {
      await saveGlobalTtsConnection(selected);
      if (version === globalConnectionVersion) setStatus("Global TTS connection saved.", "saved");
    } catch (error) {
      if (version === globalConnectionVersion) {
        lumiverseConnectionId = previous;
        connectionPicker.update({ value: previous, options: connectionOptions(previous) });
        setStatus(error instanceof Error ? error.message : "Could not save global TTS connection.", "error");
      }
    } finally {
      if (version === globalConnectionVersion) savingGlobalConnection = false;
    }
  }
  const narratorEditSlot = document.createElement("div");
  const userEditSlot = document.createElement("div");
  narratorEditSlot.hidden = true;
  userEditSlot.hidden = true;
  const narratorVoiceDisplay = document.createElement("button");
  const userVoiceDisplay = document.createElement("button");
  for (const [display, role] of [[narratorVoiceDisplay, "narrator"], [userVoiceDisplay, "user"]]) {
    display.type = "button";
    display.className = "chat-voice-selected-voice";
    display.setAttribute("aria-label", `Selected ${role} voice; press Enter to edit voice ID`);
    display.disabled = true;
  }
  narratorField.slot.append(narratorVoiceDisplay, narratorEditSlot);
  userVoiceField.slot.append(userVoiceDisplay, userEditSlot);
  let editingRoleVoice = null;
  const narratorInput = ctx.components.mountTextInput(narratorEditSlot, {
    value: "",
    placeholder: "Enter the narrator voice name or ID",
    ariaLabel: "Narrator voice",
    disabled: true,
    onChange: () => {
      if (applyingState) return;
      updateRoleVoiceDisplays();
      if (useGlobalNarratorVoice) {
        defaultNarratorVoice = narratorInput.getValue();
        scheduleGlobalRoleVoiceSave("narrator");
      } else {
        localNarratorVoice = narratorInput.getValue();
        markChanged();
      }
    }
  });
  const userVoiceInput = ctx.components.mountTextInput(userEditSlot, {
    value: "",
    placeholder: "Enter the user voice name or ID",
    ariaLabel: "User voice",
    disabled: true,
    onChange: () => {
      if (applyingState) return;
      updateRoleVoiceDisplays();
      if (useGlobalUserVoice) {
        defaultUserVoice = userVoiceInput.getValue();
        scheduleGlobalRoleVoiceSave("user");
      } else {
        localUserVoice = userVoiceInput.getValue();
        markChanged();
      }
    }
  });
  function updateRoleVoiceDisplays() {
    for (const [display, input] of [[narratorVoiceDisplay, narratorInput], [userVoiceDisplay, userVoiceInput]]) {
      const voiceId = input.getValue().trim();
      display.textContent = favoriteVoices.find((voice) => voice.id === voiceId)?.name || voiceId || "Connection default voice";
      display.title = voiceId ? `Voice ID: ${voiceId}. Click to edit.` : "Click to enter a voice ID.";
      display.disabled = !activeChat;
    }
  }
  function bindRoleVoiceEditor(role, display, slot, input) {
    const begin = () => {
      if (!activeChat) return;
      editingRoleVoice = role;
      display.hidden = true;
      slot.hidden = false;
      input.focus();
    };
    const end = () => {
      if (editingRoleVoice === role) editingRoleVoice = null;
      slot.hidden = true;
      display.hidden = false;
      updateRoleVoiceDisplays();
    };
    display.addEventListener("click", begin);
    display.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        begin();
      }
    });
    slot.addEventListener("focusout", (event) => {
      if (event.relatedTarget && slot.contains(event.relatedTarget)) return;
      end();
    });
    slot.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        input.blur();
        end();
        display.focus();
      }
    });
  }
  bindRoleVoiceEditor("narrator", narratorVoiceDisplay, narratorEditSlot, narratorInput);
  bindRoleVoiceEditor("user", userVoiceDisplay, userEditSlot, userVoiceInput);
  function createRoleFavoritePicker(role) {
    const picker = document.createElement("select");
    picker.className = "chat-voice-favorite-select";
    picker.style.marginTop = "7px";
    picker.setAttribute("aria-label", `Favorite voice for ${role}`);
    picker.disabled = true;
    picker.addEventListener("change", () => {
      const voice = picker.value;
      if (!voice || !activeChat) return;
      const input = role === "narrator" ? narratorInput : userVoiceInput;
      input.update({ value: voice });
      updateRoleVoiceDisplays();
      picker.value = "";
      if (role === "narrator") {
        if (useGlobalNarratorVoice) {
          defaultNarratorVoice = voice;
          scheduleGlobalRoleVoiceSave("narrator");
        } else {
          localNarratorVoice = voice;
          markChanged();
        }
      } else {
        if (useGlobalUserVoice) {
          defaultUserVoice = voice;
          scheduleGlobalRoleVoiceSave("user");
        } else {
          localUserVoice = voice;
          markChanged();
        }
      }
    });
    return picker;
  }
  const narratorFavoritePicker = createRoleFavoritePicker("narrator");
  const userFavoritePicker = createRoleFavoritePicker("user");
  narratorField.slot.appendChild(narratorFavoritePicker);
  userVoiceField.slot.appendChild(userFavoritePicker);
  favoritePickers.add(narratorFavoritePicker);
  favoritePickers.add(userFavoritePicker);
  const skippedTrackerTagsInput = ctx.components.mountTextArea(skippedTagsField.slot, {
    value: "",
    placeholder: "tracker, status, <o_ledger></o_l>",
    rows: 3,
    ariaLabel: "Tracker tag names or full asymmetric tag pairs to skip globally",
    onChange: () => scheduleSkippedTrackerTagsSave()
  });
  const skippedTagsHint = document.createElement("div");
  skippedTagsHint.className = "chat-voice-hint";
  skippedTagsHint.textContent = "Enter tag names, or full pairs for asymmetric tags such as <o_ledger></o_l>.";
  skippedTagsField.slot.append(skippedTagsHint);
  const speakerParsingPicker = ctx.components.mountSelect(speakerParsingField.slot, {
    value: "ambiguous",
    options: [
      { value: "off", label: "Off", sublabel: "Use the local parser only" },
      {
        value: "ambiguous",
        label: "On",
        sublabel: "Checking for a Decision model connection\u2026",
        disabled: true
      }
    ],
    ariaLabel: "Jev speaker assignment mode",
    onChange: (value) => onSpeakerParsingModeChanged(value)
  });
  const speakerParsingHint = document.createElement("div");
  speakerParsingHint.className = "chat-voice-hint";
  speakerParsingHint.hidden = true;
  speakerParsingField.slot.append(speakerParsingHint);
  const ttsTagPicker = ctx.components.mountSelect(ttsTagField.slot, {
    value: "off",
    options: [
      { value: "off", label: "Off", sublabel: "Do not add inline vocal tags" },
      { value: "gemini", label: "Gemini", sublabel: "Bracketed cues, for example [happy] and [gasp]" },
      { value: "gemini38", label: "Gemini 3.8", sublabel: "Angle-bracket events, for example <sigh> and <short pause>" },
      { value: "fish", label: "Fish S2", sublabel: "Fish cues, for example [happy] and [laughing]" }
    ],
    ariaLabel: "TTS vocal tag style",
    onChange: (value) => onTtsTagStyleChanged(value)
  });
  const ttsTagHint = document.createElement("div");
  ttsTagHint.className = "chat-voice-hint";
  ttsTagHint.textContent = "Every speech gets one or two leading emotions. Up to two sounds and two pauses may be added; all cues for a speech share the same grouped placement request.";
  ttsTagField.slot.append(ttsTagHint);
  const ttsTagPlacementPicker = ctx.components.mountSelect(ttsTagPlacementField.slot, {
    value: "jev",
    options: [
      { value: "jev", label: "Jev sentence boundaries", sublabel: "Fast, approximate placement" },
      { value: "llm", label: "LLM exact placement", sublabel: "Place each chosen tag at the exact word" }
    ],
    ariaLabel: "Vocal tag placement",
    onChange: (value) => onTtsTagPlacementChanged(value)
  });
  const tagLlmConnectionPicker = ctx.components.mountSelect(tagLlmConnectionField.slot, {
    value: "",
    options: [],
    placeholder: "Use the active Lumiverse LLM connection",
    searchPlaceholder: "Search LLM connections\u2026",
    emptyMessage: "No LLM connections found.",
    clearable: true,
    clearLabel: "Use the active LLM connection",
    ariaLabel: "Vocal tag LLM connection",
    disabled: true,
    onChange: (value) => onTagLlmConnectionChanged(value)
  });
  const tagLlmModelInput = ctx.components.mountModelCombobox(tagLlmModelField.slot, {
    value: "",
    connection: { kind: "llm" },
    appearance: "standard",
    placeholder: "Use the connection model or search available models",
    emptyMessage: "No models reported for this connection.",
    loadingMessage: "Loading models for this connection\u2026",
    browseHint: "Search models available to the selected connection.",
    disabled: true,
    onChange: (value) => onTagLlmModelChanged(value)
  });
  function createNumberInput(value, maximum, ariaLabel) {
    const input = document.createElement("input");
    input.className = "chat-voice-number-input";
    input.type = "number";
    input.value = String(value);
    input.min = "1";
    input.max = String(maximum);
    input.step = "1";
    input.inputMode = "numeric";
    input.setAttribute("aria-label", ariaLabel);
    return input;
  }
  const playbackBufferInput = createNumberInput(
    DEFAULT_PLAYBACK_BUFFER_SEGMENTS,
    MAX_PLAYBACK_BUFFER_SEGMENTS,
    "Playback buffer segments"
  );
  const concurrentGenerationInput = createNumberInput(
    DEFAULT_CONCURRENT_GENERATIONS,
    MAX_CONCURRENT_GENERATIONS,
    "Maximum concurrent generations"
  );
  const rateLimitWaitInput = createNumberInput(
    DEFAULT_RATE_LIMIT_WAIT_SECONDS,
    MAX_RATE_LIMIT_WAIT_SECONDS,
    "Rate-limit wait budget in seconds"
  );
  const autoPlaybackDelayInput = createNumberInput(0, MAX_AUTOPLAY_DELAY_SECONDS, "Autoplay delay in seconds");
  autoPlaybackDelayInput.min = "0";
  autoPlaybackDelayField.slot.appendChild(autoPlaybackDelayInput);
  const autoPlaybackDelayHint = document.createElement("div");
  autoPlaybackDelayHint.className = "chat-voice-hint";
  autoPlaybackDelayHint.textContent = "Wait this long after a message or reroll finishes before starting automatic playback. Default: 0 seconds.";
  autoPlaybackDelayField.slot.appendChild(autoPlaybackDelayHint);
  const onAutoPlaybackDelayInput = () => {
    autoPlaybackDelaySeconds = readAutoplayDelaySeconds(autoPlaybackDelayInput.valueAsNumber);
    autoPlaybackDelayInput.value = String(autoPlaybackDelaySeconds);
    scheduleAdvancedSettingsSave();
  };
  autoPlaybackDelayInput.addEventListener("change", onAutoPlaybackDelayInput);
  const ghostLifetimeInput = createNumberInput(GHOST_VOICE_LIFETIME_MESSAGES, 1e3, "Uncast voice lifetime in assistant messages");
  ghostLifetimeField.slot.appendChild(ghostLifetimeInput);
  const ghostLifetimeHint = document.createElement("div");
  ghostLifetimeHint.className = "chat-voice-hint";
  ghostLifetimeHint.textContent = "Keep a temporary voice for this many new assistant messages after it is last used for audio.";
  ghostLifetimeField.slot.appendChild(ghostLifetimeHint);
  const onGhostLifetimeInput = () => {
    ghostVoiceLifetime = clampIntegerSetting(ghostLifetimeInput.valueAsNumber, GHOST_VOICE_LIFETIME_MESSAGES, 1e3);
    ghostLifetimeInput.value = String(ghostVoiceLifetime);
    if (activeChat) {
      if (editingCharacterVoiceId) removeExpiredGhostCards();
      else renderCharacters(activeChat.characters);
    }
    scheduleAdvancedSettingsSave();
    refreshLocalState();
  };
  ghostLifetimeInput.addEventListener("change", onGhostLifetimeInput);
  const speakerLookbackInput = createNumberInput(DEFAULT_SPEAKER_LOOKBACK, MAX_SPEAKER_LOOKBACK, "Previous messages used for global speaker context");
  speakerLookbackField.slot.appendChild(speakerLookbackInput);
  const speakerLookbackHint = document.createElement("div");
  speakerLookbackHint.className = "chat-voice-hint";
  speakerLookbackHint.textContent = "Include up to this many earlier user and assistant messages as context. Default: 6 messages (roughly 3 exchanges).";
  speakerLookbackField.slot.appendChild(speakerLookbackHint);
  const onSpeakerLookbackInput = () => {
    speakerLookback = clampIntegerSetting(speakerLookbackInput.valueAsNumber, DEFAULT_SPEAKER_LOOKBACK, MAX_SPEAKER_LOOKBACK);
    speakerLookbackInput.value = String(speakerLookback);
    scheduleAdvancedSettingsSave();
  };
  speakerLookbackInput.addEventListener("change", onSpeakerLookbackInput);
  playbackBufferField.slot.appendChild(playbackBufferInput);
  concurrentGenerationField.slot.appendChild(concurrentGenerationInput);
  rateLimitWaitField.slot.appendChild(rateLimitWaitInput);
  const onPlaybackBufferInput = () => onPlaybackBufferChanged(playbackBufferInput.valueAsNumber);
  const onConcurrentGenerationInput = () => onConcurrentGenerationsChanged(concurrentGenerationInput.valueAsNumber);
  const onRateLimitWaitInput = () => onRateLimitWaitChanged(rateLimitWaitInput.valueAsNumber);
  playbackBufferInput.addEventListener("change", onPlaybackBufferInput);
  concurrentGenerationInput.addEventListener("change", onConcurrentGenerationInput);
  rateLimitWaitInput.addEventListener("change", onRateLimitWaitInput);
  speakerDebugToggle.addEventListener("change", onSpeakerDebugChanged);
  skipNarrationToggle.addEventListener("change", onSkipNarrationChanged);
  autoCastingToggle.addEventListener("change", () => {
    autoVoiceCasting = autoCastingToggle.checked;
    updatePoolControls();
    scheduleAdvancedSettingsSave();
  });
  autoPlaybackToggle.addEventListener("change", onAutoPlaybackChanged);
  const addNpcInput = ctx.components.mountTextInput(addNpcInputSlot, {
    value: "",
    placeholder: "NPC name / aliases",
    ariaLabel: "NPC name and aliases to add",
    disabled: true,
    onChange: () => void 0
  });
  function collectConfig(forSave = false) {
    return {
      messageLimit: activeChat?.messageLimit ?? 20,
      connectionId: forSave ? activeChat?.connectionId ?? "" : connectionPicker.getValue() || lumiverseConnectionId,
      narratorVoice: forSave ? localNarratorVoice : narratorInput.getValue(),
      userVoice: forSave ? localUserVoice : userVoiceInput.getValue(),
      useGlobalNarratorVoice,
      useGlobalUserVoice,
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
      config: collectConfig(true)
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
  function updateRoleDefaultControls() {
    narratorDefaultToggle.checked = useGlobalNarratorVoice;
    userDefaultToggle.checked = useGlobalUserVoice;
    narratorDefaultToggle.disabled = !activeChat;
    userDefaultToggle.disabled = !activeChat;
  }
  function scheduleGlobalRoleVoiceSave(role) {
    const currentTimer = role === "narrator" ? narratorGlobalSaveTimer : userGlobalSaveTimer;
    if (currentTimer) clearTimeout(currentTimer);
    setStatus(`Saving global ${role} voice\u2026`);
    const timer = setTimeout(() => {
      if (role === "narrator") narratorGlobalSaveTimer = null;
      else userGlobalSaveTimer = null;
      const voice = role === "narrator" ? defaultNarratorVoice : defaultUserVoice;
      if (role === "narrator") savingNarratorGlobalVoice = true;
      else savingUserGlobalVoice = true;
      void saveDefaultRoleVoice(role, voice).then(
        () => setStatus(`Global ${role} voice saved.`, "saved"),
        (error) => setStatus(error instanceof Error ? error.message : `Could not save the global ${role} voice.`, "error")
      ).finally(() => {
        if (role === "narrator") savingNarratorGlobalVoice = false;
        else savingUserGlobalVoice = false;
      });
    }, 350);
    if (role === "narrator") narratorGlobalSaveTimer = timer;
    else userGlobalSaveTimer = timer;
  }
  function changeDefaultRoleVoice(role, checked) {
    const input = role === "narrator" ? narratorInput : userVoiceInput;
    if (role === "narrator") useGlobalNarratorVoice = checked;
    else useGlobalUserVoice = checked;
    input.update({ value: role === "narrator" ? checked ? defaultNarratorVoice : localNarratorVoice : checked ? defaultUserVoice : localUserVoice });
    updateRoleVoiceDisplays();
    updateRoleDefaultControls();
    markChanged();
  }
  const onNarratorDefaultChange = () => {
    changeDefaultRoleVoice("narrator", narratorDefaultToggle.checked);
  };
  const onUserDefaultChange = () => {
    changeDefaultRoleVoice("user", userDefaultToggle.checked);
  };
  narratorDefaultToggle.addEventListener("change", onNarratorDefaultChange);
  userDefaultToggle.addEventListener("change", onUserDefaultChange);
  function updatePlaybackButtons() {
    const buttons = hostDocument.querySelectorAll("button");
    syncPlaybackButtons(buttons, activePlayback?.messageId ?? null, nativeTtsMessageId, nativeButtonStates, STOP_ACTION_ICON);
    syncAutoplayIndicators(buttons, autoPlayback, nativeTtsMessageId);
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
  function requestSpeakerReviewedSegments(chatId, messageId, preferences) {
    const requestId = `parse-${Date.now().toString(36)}-${++speakerParseRequestSequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingSpeakerParseRequests.delete(requestId);
        reject(new Error("Jev speaker assignment timed out."));
      }, 7e4);
      pendingSpeakerParseRequests.set(requestId, { resolve, reject, timer });
      ctx.sendToBackend({
        type: "chat_voice_parse_message",
        chatId,
        messageId,
        requestId,
        mode: preferences.speakerParsingMode,
        tagStyle: preferences.ttsTagStyle,
        tagPlacement: preferences.ttsTagPlacement,
        tagLlmConnectionId: preferences.tagLlmConnectionId,
        tagLlmModel: preferences.tagLlmModel,
        skippedTrackerTags: preferences.skippedTrackerTags,
        ghostVoiceLifetime: preferences.ghostVoiceLifetime,
        speakerLookback: preferences.speakerLookback,
        debug: preferences.speakerAssignmentDebug,
        ...standardSpeakerReviewPolicy()
      });
    });
  }
  const pendingAutoCast = /* @__PURE__ */ new Map();
  function requestAutoCast(chatId, voices, reserved, narratorMissing, userMissing) {
    const requestId = `auto-${Date.now().toString(36)}-${++uncastRequestSequence}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingAutoCast.delete(requestId);
        resolve({ assignments: {}, diagnostics: ["Automatic casting timed out."] });
      }, 35e3);
      pendingAutoCast.set(requestId, { resolve, timer });
      ctx.sendToBackend({ type: "chat_voice_auto_cast", requestId, chatId, voices, reserved, narratorMissing, userMissing, ghostLifetime: ghostVoiceLifetime });
    });
  }
  function requestUncastVoiceMatches(chatId, messageId, message, sourceHash, groups, voices, reserved, lifetime, speakerLookback2, skippedTrackerTags2) {
    const requestId = `uncast-${Date.now().toString(36)}-${++uncastRequestSequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingUncastRequests.delete(requestId);
        reject(new Error("Uncast voice matching timed out."));
      }, 35e3);
      pendingUncastRequests.set(requestId, { resolve, reject, timer });
      ctx.sendToBackend({ type: "chat_voice_match_uncast", requestId, chatId, messageId, message, sourceHash, groups, voices, reserved, lifetime, speakerLookback: speakerLookback2, skippedTrackerTags: skippedTrackerTags2 });
    });
  }
  const pendingCommunityRequests = /* @__PURE__ */ new Map();
  let communityRequestSequence = 0;
  function requestCommunitySearch(query) {
    const requestId = `community-${Date.now().toString(36)}-${++communityRequestSequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingCommunityRequests.delete(requestId);
        reject(new Error("Community voice search timed out."));
      }, 35e3);
      pendingCommunityRequests.set(requestId, { resolve: (value) => resolve({ items: value.items ?? [], total: value.total ?? 0, hasMore: value.hasMore ?? false }), reject, timer });
      ctx.sendToBackend({ type: "chat_voice_search_community", requestId, fishApiKey, title: query.title ?? "", tags: query.tags ?? [], language: query.language ?? [], sortBy: query.sortBy ?? "score", pageNumber: query.pageNumber ?? 1, pageSize: query.pageSize ?? 20 });
    });
  }
  function requestCommunitySnapshotRefresh() {
    const requestId = `community-snapshot-${Date.now().toString(36)}-${++communityRequestSequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingCommunityRequests.delete(requestId);
        reject(new Error("Community snapshot refresh timed out."));
      }, 35e3);
      pendingCommunityRequests.set(requestId, { resolve: (value) => resolve({ items: value.items ?? [], voices: value.voices ?? [], refreshedAt: value.refreshedAt ?? "" }), reject, timer });
      ctx.sendToBackend({ type: "chat_voice_refresh_community_snapshot", requestId, fishApiKey, language: communityVoiceLanguage });
    });
  }
  function speakerDebugName(speakerId, speakers) {
    if (speakerId === null) return "narrator";
    if (speakerId === USER_SPEAKER_ID) return "user persona";
    if (speakerId === UNCAST_SPEAKER_ID) return "uncast character";
    if (speakerId === UNRESOLVED_SPEAKER_ID) return "unresolved speech";
    const speaker = speakers.find((candidate) => candidate.id === speakerId);
    return speaker ? `${speaker.name} [${speakerId}]` : speakerId;
  }
  const SPEAKER_SOURCE_LABELS = {
    "best-available": "best-available guess (uncertain)",
    "first-pass": "first pass",
    "contextual-confirmation": "contextually confirmed first pass",
    "contextual-review": "contextual review",
    "opening-exchange": "opening exchange review",
    "opening-backlink": "opening backward link",
    "opening-forwardlink": "opening forward link",
    "chain-fill": "turn chain fill",
    "chain-override": "turn chain override",
    "discourse-fill": "discourse fill",
    "discourse-override": "discourse override",
    inheritance: "in-message inheritance",
    "previous-assistant": "previous assistant",
    "card-title": "card title",
    "role-fallback": "role fallback",
    "local-parser": "local parser",
    unreported: "unreported"
  };
  function speakerDebugLine(steps, prefix) {
    return steps.find((step) => step.startsWith(prefix));
  }
  function speakerDebugStep(segment, prefix) {
    return speakerDebugLine(segment.debugPath ?? [], prefix);
  }
  function speakerAssignmentSource(segment, parsingMode, review) {
    return speakerAssignmentSourceFromTrace(segment.debugPath ?? [], review.failed || review.usedLlm === false || parsingMode === "off");
  }
  function speakerSourceDetail(segment, source, parsingMode, review) {
    if (source !== "local-parser") return SPEAKER_SOURCE_LABELS[source];
    if (parsingMode === "off") return "local parser (Jev disabled)";
    if (review.failed) return "local parser (backend review unavailable)";
    const fallback = speakerDebugStep(segment, "jev-fallback:");
    if (fallback) return `local parser fallback (${fallback.slice("jev-fallback:".length).trim()})`;
    return "local parser";
  }
  function describeBackendReview(localSpeakerId, rawSpeakerId, parsingMode, review) {
    const before = localSpeakerId ?? "none";
    const after = rawSpeakerId ?? "none";
    if (parsingMode === "off") {
      return localSpeakerId === rawSpeakerId ? "backend-result:matches message-local parser (Jev disabled)" : `backend-result:changed message-local ${before} -> ${after} (Jev disabled)`;
    }
    if (review.failed) return `backend-result:unavailable (message-local parser: ${after})`;
    if (review.usedLlm === false) {
      return localSpeakerId === rawSpeakerId ? "backend-result:local-parser fallback (matches message-local parser)" : `backend-result:local-parser fallback (changed message-local ${before} -> ${after})`;
    }
    return localSpeakerId === rawSpeakerId ? `backend/Jev-result:matches message-local parser (${after})` : `backend/Jev-result:changed message-local ${before} -> Jev ${after}`;
  }
  function speakerPipelineHeader(segments, parsingMode, review) {
    if (parsingMode === "off") return ["Jev pipeline: off (attribution is entirely local)"];
    if (review.failed) {
      return ["Jev pipeline: unavailable (backend review did not answer; message-local parser used)"];
    }
    const steps = segments.flatMap((segment) => segment.debugPath ?? []);
    if (review.usedLlm === null) {
      return ["Jev pipeline: status unknown (the backend did not report whether Jev answered)"];
    }
    if (review.usedLlm === false) {
      const fallback = steps.find((step) => step.startsWith("jev-fallback:") || step.startsWith("jev-disabled:"));
      const reason = fallback?.replace(/^jev-(?:fallback|disabled):/u, "").trim() || "reason not reported";
      return [`Jev pipeline: first pass not used (${reason}); deterministic parser output used`];
    }
    const lines = ["Jev pipeline: first pass answered; deterministic policy applied after normalization"];
    const speechSegments = segments.filter((segment) => speakerDebugStep(segment, "segment-type:speech"));
    const normalized = speechSegments.map((segment) => speakerDebugStep(segment, "jev-first-pass-speech-normalized:") ?? speakerDebugStep(segment, "jev-speech-normalized:")).filter((step) => step !== void 0);
    if (normalized.length > 0) {
      const clear = normalized.filter((step) => !step.includes(":unclear")).length;
      lines.push(
        `First pass: ${clear} clear / ${normalized.length} quotations (${normalized.length - clear} unresolved or low-confidence)`
      );
    }
    const turnOmitted = steps.includes("jev-turn-questions:omitted (first-pass question budget)");
    const relations = steps.filter((step) => step.startsWith("jev-turn-") && step.includes("-choice:")).length;
    const chainDecisions = steps.filter((step) => step.startsWith("chain-decode:")).map((step) => step.slice("chain-decode:".length));
    if (turnOmitted) {
      lines.push("Turn matrix: omitted (first-pass question budget); first-pass policy retained");
    } else if (relations > 0 || chainDecisions.length > 0) {
      const filled = chainDecisions.filter((step) => step.startsWith("filled-unresolved")).length;
      const overrode = chainDecisions.filter((step) => step.startsWith("overrode-clear")).length;
      const retained = chainDecisions.filter((step) => step.startsWith("retained-unresolved")).length;
      const direct = chainDecisions.filter((step) => step.startsWith("direct")).length;
      const overrideRejected = chainDecisions.filter((step) => step.startsWith("override-rejected")).length;
      lines.push(
        `Turn matrix: ${relations} relations \xB7 ${filled} chain-filled \xB7 ${overrode} chain-overrode \xB7 ${direct} direct retained` + (retained > 0 ? ` \xB7 ${retained} unresolved retained` : "") + (overrideRejected > 0 ? ` \xB7 ${overrideRejected} override rejected` : "")
      );
    }
    const narrativeAttributions = new Set(
      steps.filter((step) => step.startsWith("chain-narrative:attribution="))
    ).size;
    if (narrativeAttributions > 0) {
      lines.push(`Narrative cues: ${narrativeAttributions} unambiguous attributions`);
    }
    const cardDeference = speakerDebugLine(steps, "card-deference:")?.slice("card-deference:".length).trim();
    if (cardDeference) lines.push(`Card deference: ${cardDeference}`);
    const request = speakerDebugLine(steps, "discourse-request:")?.slice("discourse-request:".length).trim();
    const escalated = steps.includes("discourse-decision:escalated");
    const runIds = [...new Set(steps.filter((step) => step.startsWith("discourse-run:")).map((step) => step.slice("discourse-run:".length).split(" ")[0] ?? "").filter((runId) => runId.length > 0))];
    const triggerCodes = [...new Set(steps.filter((step) => step.startsWith("discourse-triggers:")).flatMap((step) => step.slice("discourse-triggers:".length).split("; ")).map((trigger) => trigger.split(" (")[0]?.trim() ?? "").filter((trigger) => trigger.length > 0 && trigger !== "none"))];
    const rejectedRuns = [...new Set(steps.filter((step) => step.startsWith("discourse-decision:rejected")).map((step) => step.slice("discourse-decision:rejected".length).trim().replace(/^\(|\)$/gu, "")).filter((reason) => reason.length > 0))];
    const outcomes = steps.filter((step) => step.startsWith("discourse-outcome:"));
    const countOutcome = (name) => outcomes.filter((step) => step === `discourse-outcome:${name}` || step.startsWith(`discourse-outcome:${name} `)).length;
    if (escalated) {
      lines.push(
        `Discourse review: escalated ${runIds.join(", ") || "one run"} (triggers: ${triggerCodes.join(", ") || "not reported"})`,
        `Discourse review result: ${countOutcome("filled-unresolved")} filled, ${countOutcome("overrode-conflict")} overrode, ${countOutcome("not-a-target")} retained, ${outcomes.filter((step) => step.startsWith("discourse-outcome:rejected")).length} rejected`
      );
    } else if (request?.startsWith("failed")) {
      lines.push(`Discourse review: ${request}`);
    } else if (rejectedRuns.length > 0) {
      lines.push(`Discourse review: not escalated (${rejectedRuns.join("; ")})`);
    } else {
      lines.push("Discourse review: not requested");
    }
    return lines;
  }
  function updateSpeakerDebugLog(messageId, isUserMessage, defaultSpeakerId, parserSpeakers, configuredSpeakers, localSegments, finalSegments, aliases, config, parsingMode, review) {
    if (!speakerAssignmentDebug) return;
    const lines = [
      `Message ${messageId} (${isUserMessage ? "user" : "assistant"})`,
      `Parsing mode: ${parsingMode === "off" ? "local parser only" : "Jev with local fallback"}`,
      `TTS tags: ${ttsTagStyle === "off" ? "off" : `${ttsTagStyle === "gemini38" ? "Gemini 3.8" : ttsTagStyle} (${ttsTagPlacement === "llm" ? "LLM placement" : "Jev placement"})`}`,
      ...speakerPipelineHeader(finalSegments, parsingMode, review),
      `Default speaker: ${speakerDebugName(defaultSpeakerId, parserSpeakers)}`,
      `Parser roster: ${parserSpeakers.map((speaker) => `${speaker.name} [${speaker.id}]`).join(", ") || "(empty)"}`,
      ""
    ];
    const sourceCounts = /* @__PURE__ */ new Map();
    let narratorCount = 0;
    finalSegments.forEach((segment, index) => {
      const local = localSegments[index]?.text === segment.text ? localSegments[index] : localSegments.find((candidate) => candidate.text === segment.text);
      const rawSpeakerId = segment.speakerId;
      const mappedSpeakerId = rawSpeakerId ? aliases.get(rawSpeakerId) ?? rawSpeakerId : null;
      const voice = playbackVoiceForSpeaker(
        mappedSpeakerId,
        isUserMessage,
        config.characterVoices,
        config.narratorVoice,
        config.userVoice
      );
      const localSpeaker = local?.speakerId ?? null;
      const isSpeech = segment.debugPath?.some((step) => step.startsWith("segment-type:speech")) ?? false;
      const source = speakerAssignmentSource(segment, parsingMode, review);
      if (isSpeech) {
        sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
      } else {
        narratorCount += 1;
      }
      const aliasPath = rawSpeakerId && mappedSpeakerId !== rawSpeakerId ? `alias-map:${rawSpeakerId} -> ${mappedSpeakerId}` : `alias-map:${rawSpeakerId ?? "none"} (unchanged)`;
      const routeName = speakerDebugName(mappedSpeakerId, configuredSpeakers);
      const voicePath = voice ? `voice-route:${routeName} -> configured voice ${JSON.stringify(voice)}` : `voice-route:${routeName} -> connection default voice`;
      lines.push(
        `[${index + 1}] ${JSON.stringify(segment.text.length > 180 ? `${segment.text.slice(0, 177)}...` : segment.text)}`,
        ...(segment.debugPath ?? local?.debugPath ?? ["parser-trace:unavailable"]).map((step) => `  ${step}`),
        `  ${describeBackendReview(localSpeaker, rawSpeakerId, parsingMode, review)}`,
        `  source:${isSpeech ? speakerSourceDetail(segment, source, parsingMode, review) : "narrator"}`,
        ...segment.ttsText && segment.ttsText !== segment.text ? [`  tts-tagged:${JSON.stringify(segment.ttsText.length > 180 ? `${segment.ttsText.slice(0, 177)}...` : segment.ttsText)}`] : [],
        `  ${aliasPath}`,
        `  final-speaker:${speakerDebugName(mappedSpeakerId, configuredSpeakers)}`,
        `  ${voicePath}`,
        ""
      );
    });
    const sourceSummary = [...sourceCounts.entries()].map(([source, count]) => `${SPEAKER_SOURCE_LABELS[source]} ${count}`).join(" \xB7 ");
    lines.push(
      `Assignment sources: ${sourceSummary || "no speech segments"} \xB7 narrator segments ${narratorCount}`,
      "Legend: jev-* first pass \xB7 jev-turn-* and chain-* turn matrix \xB7 jev-discourse-* and discourse-* cross-paragraph review \xB7 resolution:* deterministic policy \xB7 voice-route:* final routing"
    );
    const log = lines.join("\n");
    speakerDebugOutput.value = log;
    console.debug("[Chat Voice] Speaker assignment trace\n" + log);
  }
  function appendSpeakerDebugLog(line) {
    if (!speakerAssignmentDebug) return;
    speakerDebugOutput.value += `${speakerDebugOutput.value ? "\n" : ""}${line}`;
    console.debug(`[Chat Voice] ${line}`);
  }
  function requestDecisionStatus() {
    const requestId = `decision-${Date.now().toString(36)}-${++decisionStatusRequestSequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingDecisionStatusRequests.delete(requestId);
        reject(new Error("Timed out while checking Decision connections."));
      }, 1e4);
      pendingDecisionStatusRequests.set(requestId, { resolve, reject, timer });
      ctx.sendToBackend({ type: "chat_voice_decision_status", requestId });
    });
  }
  async function refreshDecisionStatus() {
    try {
      const status2 = await requestDecisionStatus();
      decisionConnectionsKnown = true;
      decisionConnectionAvailable = status2.available && status2.hasConnection;
      decisionConnectionName = status2.defaultConnectionName ?? "";
      decisionStatusFailed = false;
      updateSpeakerParsingControls();
      return status2;
    } catch (error) {
      decisionConnectionsKnown = true;
      decisionConnectionAvailable = false;
      decisionConnectionName = "";
      decisionStatusFailed = true;
      updateSpeakerParsingControls();
      console.warn("[Chat Voice] Could not check Decision connections.", error);
      return null;
    }
  }
  function updateSpeakerParsingControls() {
    const description = decisionStatusFailed ? "Could not check Decision connections" : !decisionConnectionsKnown ? "Checking for a Decision model connection\u2026" : decisionConnectionAvailable ? decisionConnectionName ? `Uses ${decisionConnectionName} as the default Decision connection` : "Uses the default Lumiverse Decision connection" : "Create a Decision model connection in Lumiverse first";
    speakerParsingPicker.update({
      options: [
        { value: "off", label: "Off", sublabel: "Use the local parser only" },
        {
          value: "ambiguous",
          label: "On",
          sublabel: description,
          disabled: decisionStatusFailed || decisionConnectionsKnown && !decisionConnectionAvailable
        }
      ]
    });
    const warning = decisionStatusFailed ? "Could not verify a Decision model connection. Jev speaker assignment is unavailable until Lumiverse responds." : decisionConnectionsKnown && !decisionConnectionAvailable ? "Jev speaker assignment needs a Decision model connection. Create one in Lumiverse, then reopen this panel." : "";
    speakerParsingHint.textContent = warning;
    speakerParsingHint.hidden = warning === "";
  }
  function requestLlmConnections() {
    const requestId = `llm-connections-${Date.now().toString(36)}-${++llmConnectionRequestSequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingLlmConnectionRequests.delete(requestId);
        reject(new Error("Timed out while loading Lumiverse LLM connections."));
      }, 15e3);
      pendingLlmConnectionRequests.set(requestId, { resolve, reject, timer });
      ctx.sendToBackend({ type: "chat_voice_list_llm_connections", requestId });
    });
  }
  async function copyDebugReport() {
    const text = speakerDebugOutput.value;
    if (!text) {
      setStatus("The debug log is empty.");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setStatus("Debug report copied to clipboard.", "saved");
    } catch {
      speakerDebugOutput.focus();
      speakerDebugOutput.select();
      setStatus("Clipboard copy failed; the debug log text is selected for manual copying.", "error");
    }
  }
  function requestTagPlacements(message, style, connectionId, model, items) {
    const requestId = `tag-placement-${Date.now().toString(36)}-${++tagPlacementRequestSequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingTagPlacementRequests.delete(requestId);
        reject(new Error("Timed out while placing TTS vocal tags."));
      }, 6e4);
      pendingTagPlacementRequests.set(requestId, { resolve, reject, timer });
      ctx.sendToBackend({
        type: "chat_voice_place_tags",
        requestId,
        message,
        style,
        connectionId,
        model,
        items
      });
    });
  }
  function llmConnectionOptions(selectedId = "") {
    const options = llmConnections.map((connection) => ({
      value: connection.id,
      label: connection.name,
      sublabel: `${connection.provider}${connection.model ? ` \xB7 ${connection.model}` : ""}`
    }));
    if (selectedId && !llmConnections.some((connection) => connection.id === selectedId)) {
      options.unshift({ value: selectedId, label: "Missing connection", sublabel: selectedId });
    }
    return options;
  }
  function updateTtsTagControls() {
    ttsTagHint.textContent = ttsTagStyle === "gemini38" ? "Gemini 3.8 uses angle-bracket vocal events and pauses. Sustained emotion and style require speech_metadata, which the current TTS request does not expose." : ttsTagStyle === "fish" && ttsTagPlacement === "llm" ? "Every speech gets one or two leading emotions. Fish can also select one mid-speech modulation; up to two sounds and two pauses may be added. All cues for a speech share the grouped placement request." : "Every speech gets one or two leading emotions. Up to two sounds and two pauses may be added; all cues for a speech share the same grouped placement request.";
    const tagEnabled = ttsTagStyle !== "off";
    const llmEnabled = tagEnabled && ttsTagPlacement === "llm";
    ttsTagPlacementPicker.update({
      value: ttsTagPlacement,
      disabled: !tagEnabled
    });
    tagLlmConnectionPicker.update({
      value: tagLlmConnectionId,
      options: llmConnectionOptions(tagLlmConnectionId),
      disabled: !llmEnabled,
      placeholder: llmConnections.length ? "Use the active Lumiverse LLM connection" : "No LLM connections found; the active connection will be used"
    });
    const modelConnectionId = tagLlmConnectionId || llmConnections.find(
      (connection) => connection.is_default
    )?.id || llmConnections[0]?.id || "";
    tagLlmModelInput.update({
      value: tagLlmModel,
      disabled: !llmEnabled,
      connection: modelConnectionId ? { kind: "llm", id: modelConnectionId } : { kind: "llm" },
      refreshKey: modelConnectionId || "active",
      placeholder: modelConnectionId ? "Use the connection model or search available models" : "Use the active connection model or search available models"
    });
    const connectionChanged = tagLlmModelConnectionId !== modelConnectionId;
    const becameEnabled = llmEnabled && !tagLlmModelComboboxEnabled;
    tagLlmModelConnectionId = modelConnectionId;
    tagLlmModelComboboxEnabled = llmEnabled;
    if (llmEnabled && (connectionChanged || becameEnabled)) tagLlmModelInput.refresh();
    updateVoicesTabs();
  }
  function onTtsTagStyleChanged(value) {
    ttsTagStyle = value === "gemini" || value === "gemini38" || value === "fish" ? value : "off";
    ttsTagPicker.update({ value: ttsTagStyle });
    updateTtsTagControls();
    scheduleLlmSettingsSave();
  }
  function onTtsTagPlacementChanged(value) {
    ttsTagPlacement = value === "llm" ? "llm" : "jev";
    ttsTagPlacementPicker.update({ value: ttsTagPlacement });
    updateTtsTagControls();
    scheduleLlmSettingsSave();
  }
  function onTagLlmConnectionChanged(value) {
    tagLlmConnectionId = value.trim().slice(0, 128);
    updateTtsTagControls();
    scheduleLlmSettingsSave();
  }
  function onTagLlmModelChanged(value) {
    tagLlmModel = value.trim().slice(0, 256);
    scheduleLlmSettingsSave();
  }
  function refreshLocalState() {
    ctx.sendToBackend({
      type: "chat_voice_refresh",
      chatId: ctx.getActiveChat().chatId,
      ...ghostLifetimeLoaded ? { ghostLifetime: ghostVoiceLifetime } : {}
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
    if (!playback) return false;
    playback.playbackStopped = true;
    playback.finishAudible();
    playback.controller.abort();
    if (playback.persistenceState === "not-started" || playback.persistenceState === "disabled") {
      playback.synthesisController?.abort();
    }
    try {
      playback.source?.stop();
    } catch {
    }
    void playback.context.close().catch(() => void 0);
    updatePlaybackButtons();
    return playback.persistenceState === "pending";
  }
  async function playDecodedBuffer(playback, segment, volume) {
    if (playback.controller.signal.aborted) throw new DOMException("Playback stopped.", "AbortError");
    const buffer = segment.decodedBuffer ?? await playback.context.decodeAudioData(segment.data.slice(0));
    if (playback.controller.signal.aborted) throw new DOMException("Playback stopped.", "AbortError");
    await new Promise((resolve, reject) => {
      const source = playback.context.createBufferSource();
      const gain = playback.context.createGain();
      gain.gain.value = volume * (segment.normalizationGain ?? 1);
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
  async function encodeCapturedWav(segments, contextClass) {
    const decodeContext = new contextClass();
    try {
      const decoded = [];
      for (const segment of segments) {
        decoded.push(segment.decodedBuffer ?? await decodeContext.decodeAudioData(segment.data.slice(0)));
      }
      return encodeConcatenatedWav(decoded.map((buffer, index) => ({
        sampleRate: buffer.sampleRate,
        channels: Array.from(
          { length: buffer.numberOfChannels },
          (_, channel) => buffer.getChannelData(channel)
        ),
        gain: segments[index]?.normalizationGain ?? 1
      })));
    } finally {
      await decodeContext.close().catch(() => void 0);
    }
  }
  async function persistCapturedAudio(chatId, messageId, swipeId, segments, contextClass, signal, waitForSafeFallback, onWavAssembly, verifyBeforeSave) {
    const normalized = segments.some((segment) => segment.normalizationGain !== void 0);
    if (normalized) {
      onWavAssembly(true);
      const wav = await encodeCapturedWav(segments, contextClass);
      await verifyBeforeSave?.();
      return saveMessageAudio(
        chatId,
        messageId,
        swipeId,
        [{ data: wav, mime: "audio/wav" }],
        signal
      );
    }
    try {
      await verifyBeforeSave?.();
      return await saveMessageAudio(chatId, messageId, swipeId, segments, signal);
    } catch (segmentSaveError) {
      if (["AbortError", "AudioSaveVerificationError"].includes(segmentSaveError?.name ?? "")) throw segmentSaveError;
      await waitForSafeFallback();
      if (signal.aborted) throw new DOMException("Audio saving stopped.", "AbortError");
      onWavAssembly(false);
      const wav = await encodeCapturedWav(segments, contextClass);
      await verifyBeforeSave?.();
      return saveMessageAudio(
        chatId,
        messageId,
        swipeId,
        [{ data: wav, mime: "audio/wav" }],
        signal
      );
    }
  }
  function hasSavedAudioForCurrentSwipe(message) {
    const attachments = message.extra?.attachments;
    if (!Array.isArray(attachments)) return false;
    return attachments.some((candidate) => {
      if (!candidate || typeof candidate !== "object") return false;
      const attachment = candidate;
      return attachment.type === "audio" && (attachment.swipe_id === void 0 || attachment.swipe_id === message.swipe_id);
    });
  }
  async function playMessage(messageId, nativeRegenerationAction = false, automatic = false, expectedSwipe) {
    if (activePlayback?.messageId === messageId) {
      if (automatic) return;
      playbackStartup.cancel();
      const finishingSave = stopPlayback();
      setStatus(finishingSave ? "Playback stopped; finishing saved audio\u2026" : "Playback stopped.");
      return;
    }
    const requestedChatId = ctx.getActiveChat().chatId;
    if (!requestedChatId) {
      setStatus("Open a chat before starting voice playback.", "error");
      return;
    }
    const startupToken = playbackStartup.begin(requestedChatId, messageId, automatic);
    if (startupToken === null) {
      if (!automatic) setStatus("Playback stopped.");
      return;
    }
    const ownsStartup = () => playbackStartup.owns(startupToken) && !autoPlaybackDisposed && ctx.getActiveChat().chatId === requestedChatId && (!automatic || autoPlayback);
    try {
      let message;
      try {
        message = await requestPlaybackMessage(requestedChatId, messageId);
      } catch (error) {
        if (ownsStartup()) setStatus(error instanceof Error ? error.message : "Could not load this message.", "error");
        return;
      }
      if (!ownsStartup()) return;
      const automaticSkip = automatic ? automaticPlaybackSkipReason(message, expectedSwipe) : null;
      if (automaticSkip === "user-message") {
        appendSpeakerDebugLog(`Autoplay skipped: message ${messageId} belongs to the user.`);
        return;
      }
      if (automaticSkip === "changed-swipe") {
        appendSpeakerDebugLog(`Autoplay skipped: message ${messageId} changed swipe or content after generation (expected swipe ${expectedSwipe?.swipeId ?? "unknown"}, active swipe ${message.swipe_id ?? 0}).`);
        return;
      }
      const regeneratingSavedAudio = !message.is_user && (nativeRegenerationAction || !automatic && hasSavedAudioForCurrentSwipe(message));
      if (regeneratingSavedAudio) {
        const { confirmed } = await ctx.ui.showConfirm({
          title: "Regenerate TTS audio?",
          message: "This will replace the saved audio attached to this message with a new TTS synthesis. The current recording will be deleted.",
          confirmLabel: "Regenerate",
          cancelLabel: "Keep current",
          variant: "warning"
        });
        if (!confirmed || !ownsStartup()) return;
      }
      if (activePlayback) {
        stopPlayback();
      }
      const localChatId = ctx.getActiveChat().chatId;
      if (activeChat?.id !== localChatId) {
        setStatus("Loading this chat\u2019s voice settings\u2026");
        try {
          await requestLocalState();
        } catch (error) {
          if (ownsStartup()) setStatus(error instanceof Error ? error.message : "Could not load this chat\u2019s voice settings.", "error");
          return;
        }
      }
      if (!ownsStartup() || !activeChat || activeChat.id !== ctx.getActiveChat().chatId) return;
      const playbackChat = activeChat;
      const config = collectConfig();
      const connectionVersionAtLoad = globalConnectionVersion;
      const preferences = await loadPlaybackPreferences();
      if (!ownsStartup()) return;
      if (llmSettingsSaveTimer || savingLlmSettings) {
        preferences.speakerParsingMode = speakerParsingMode;
        preferences.ttsTagStyle = ttsTagStyle;
        preferences.ttsTagPlacement = ttsTagPlacement;
        preferences.tagLlmConnectionId = tagLlmConnectionId;
        preferences.tagLlmModel = tagLlmModel;
      }
      if (advancedSettingsSaveTimer || savingAdvancedSettings) {
        preferences.playbackBufferSegments = playbackBufferSegments;
        preferences.concurrentGenerations = concurrentGenerationLimit;
        preferences.rateLimitWaitSeconds = rateLimitWaitSeconds;
        preferences.ghostVoiceLifetime = ghostVoiceLifetime;
        preferences.speakerLookback = speakerLookback;
        preferences.autoVoiceCasting = autoVoiceCasting;
        preferences.autoPlayback = autoPlayback;
        preferences.speakerAssignmentDebug = speakerAssignmentDebug;
        preferences.skipNarration = skipNarration;
      } else {
        playbackBufferSegments = preferences.playbackBufferSegments;
        concurrentGenerationLimit = preferences.concurrentGenerations;
        rateLimitWaitSeconds = preferences.rateLimitWaitSeconds;
        speakerAssignmentDebug = preferences.speakerAssignmentDebug;
        skipNarration = preferences.skipNarration;
      }
      const connectionId = savingGlobalConnection || connectionVersionAtLoad !== globalConnectionVersion ? lumiverseConnectionId : resolveGlobalTtsConnection(preferences.connectionId, connections);
      if (!connectionId) {
        setStatus("Choose a TTS connection before playing.", "error");
        return;
      }
      const connectionProfileVoice = (connections.find((connection) => connection.id === connectionId)?.voice ?? "").trim();
      let autoCastDiagnostics = [];
      if (preferences.autoVoiceCasting && poolVoicesForAutoCast().length && (!config.narratorVoice || !config.userVoice || playbackChat.characters.some((character) => !config.characterVoices[character.id]))) {
        flushSave();
        const autoResult = await requestAutoCast(playbackChat.id, poolVoicesForAutoCast(), [connectionProfileVoice, config.narratorVoice, config.userVoice, ...Object.values(config.characterVoices)].filter(Boolean), !config.narratorVoice, !config.userVoice);
        if (!ownsStartup()) return;
        const assigned = autoResult.assignments;
        autoCastDiagnostics = autoResult.diagnostics;
        if (assigned.narrator && !config.narratorVoice) config.narratorVoice = assigned.narrator;
        if (assigned.user && !config.userVoice) config.userVoice = assigned.user;
        for (const [id, voice] of Object.entries(assigned)) if (id !== "narrator" && id !== "user" && !config.characterVoices[id]) config.characterVoices[id] = voice;
      }
      if (preferences.speakerAssignmentDebug) {
        const profile = connections.find((connection) => connection.id === connectionId);
        appendSpeakerDebugLog(
          `TTS connection profile: id=${JSON.stringify(connectionId)}, provider=${JSON.stringify(profile?.provider ?? "")}, model=${JSON.stringify(profile?.model ?? "")}, defaultVoice=${JSON.stringify(profile?.voice ?? "")}, narratorVoice=${JSON.stringify(config.narratorVoice || "<connection default>")}, userVoice=${JSON.stringify(config.userVoice || "<none>")}`
        );
      }
      const contextClass = window.AudioContext ?? window.webkitAudioContext;
      if (!contextClass) {
        setStatus("Web Audio is unavailable in this browser.", "error");
        return;
      }
      const audioContext = new contextClass();
      if (automatic) {
        let timer;
        try {
          await Promise.race([
            audioContext.resume(),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error("Automatic playback needs a browser interaction. Click a play button to enable audio.")), 2e3);
            })
          ]);
        } catch (error) {
          void audioContext.close().catch(() => void 0);
          if (ownsStartup()) setStatus(error instanceof Error ? error.message : "Automatic playback could not start.", "error");
          return;
        } finally {
          if (timer) clearTimeout(timer);
        }
      } else {
        try {
          await audioContext.resume();
        } catch (error) {
          void audioContext.close().catch(() => void 0);
          throw error;
        }
      }
      if (!ownsStartup()) {
        void audioContext.close().catch(() => void 0);
        return;
      }
      let audibleFinished = false;
      let resolveAudibleDone = null;
      const audibleDone = new Promise((resolve) => {
        resolveAudibleDone = resolve;
      });
      const playback = {
        messageId,
        controller: new AbortController(),
        synthesisController: null,
        context: audioContext,
        source: null,
        persistenceState: "not-started",
        persistenceError: null,
        playbackStopped: false,
        playbackFinished: false,
        audibleDone,
        finishAudible: () => {
          if (audibleFinished) return;
          audibleFinished = true;
          resolveAudibleDone?.();
        }
      };
      if (activePlayback) stopPlayback();
      activePlayback = playback;
      playbackStartup.finish(startupToken);
      updatePlaybackButtons();
      const playbackSetupFinishedAt = Date.now();
      try {
        if (playback.controller.signal.aborted) throw new DOMException("Playback stopped.", "AbortError");
        const playbackSpeakers = addUnconfiguredDialogueSpeakers(
          message.content,
          speakersForMessageRole(
            playbackChat.characters,
            message.is_user,
            message.is_user ? message.name : "User"
          ),
          preferences.skippedTrackerTags
        );
        const defaultSpeakerId = message.is_user ? USER_SPEAKER_ID : null;
        const aliases = speakerAliasIdLookup(playbackChat.characters);
        const localSegments = markUnresolvedSpeechSegments(parseRosterVoiceSegments(
          message.content,
          defaultSpeakerId,
          playbackSpeakers,
          preferences.skippedTrackerTags,
          null,
          true
        ), preferences.speakerAssignmentDebug);
        let review = { segments: localSegments, usedLlm: null, failed: false };
        if (preferences.speakerParsingMode !== "off" || preferences.ttsTagStyle !== "off") {
          setStatus(
            preferences.speakerParsingMode !== "off" ? "Classifying dialogue speakers with Jev\u2026" : "Adding TTS vocal tags\u2026"
          );
        }
        try {
          review = await requestSpeakerReviewedSegments(playbackChat.id, messageId, preferences);
        } catch (error) {
          if (playback.controller.signal.aborted) throw new DOMException("Playback stopped.", "AbortError");
          if (error instanceof Error && error.message.includes("changed during speaker review")) throw error;
          console.warn("[Chat Voice] Backend speaker parsing failed; using the message-local parser.", error);
          review = { segments: localSegments, usedLlm: null, failed: true };
          setStatus("Historical speaker lookup unavailable; using the message-local parser.");
        }
        const reviewedSegments = review.segments;
        updateSpeakerDebugLog(
          messageId,
          message.is_user,
          defaultSpeakerId,
          playbackSpeakers,
          playbackChat.characters,
          localSegments,
          reviewedSegments,
          aliases,
          config,
          preferences.speakerParsingMode,
          review
        );
        for (const line of autoCastDiagnostics) appendSpeakerDebugLog(`Automatic casting: ${line}`);
        const segments = filterNarrationSegments(reviewedSegments, preferences.skipNarration);
        if (preferences.skipNarration) appendSpeakerDebugLog(`Narration audio skipped: ${reviewedSegments.length - segments.length} segment(s).`);
        if (!segments.length && preferences.skipNarration) {
          setStatus("No dialogue to play; narration audio is disabled.", "saved");
          return;
        }
        const matchingSegments = segments.map((segment) => ({
          ...segment,
          speakerId: segment.speakerId ? aliases.get(segment.speakerId) ?? segment.speakerId : null
        }));
        const uncastGroups = collectUncastVoiceGroups(matchingSegments);
        const reservedVoices = [
          ...Object.values(config.characterVoices),
          config.narratorVoice,
          config.userVoice,
          connectionProfileVoice
        ];
        const poolVoices = poolVoicesForAutoCast();
        if (preferences.autoVoiceCasting && speakerAssignmentDebug) appendSpeakerDebugLog(`Voice pool: ${autoVoiceCastingPool === "community" && communityIsAvailable() ? `community (${communityVoices.length} snapshot voices)` : "favorites"}.`);
        const uncastVoices = availableUncastVoices(poolVoices, reservedVoices);
        const uncastMatchPromise = preferences.autoVoiceCasting && uncastGroups.length ? requestUncastVoiceMatches(
          playbackChat.id,
          messageId,
          preparePlaybackContent(message.content, preferences.skippedTrackerTags),
          hashMessageContent(message.content),
          uncastGroups,
          uncastVoices,
          reservedVoices,
          preferences.ghostVoiceLifetime,
          preferences.speakerLookback,
          preferences.skippedTrackerTags
        ).catch((error) => {
          appendSpeakerDebugLog(`Uncast voice matching failed; using connection default: ${error instanceof Error ? error.message : String(error)}`);
          return [];
        }) : Promise.resolve([]);
        let explicitVoiceCount = 0;
        let connectionVoiceFallbacks = 0;
        const segmentPlanIndexes = [];
        const rawPlan = segments.map((segment) => {
          const speakerId = segment.speakerId ? aliases.get(segment.speakerId) ?? segment.speakerId : null;
          const configuredVoice = playbackVoiceForSpeaker(
            speakerId,
            message.is_user,
            config.characterVoices,
            config.narratorVoice,
            config.userVoice
          );
          const voice = configuredVoice || connectionProfileVoice;
          if (configuredVoice) explicitVoiceCount += 1;
          else if (connectionProfileVoice) connectionVoiceFallbacks += 1;
          return {
            text: speakerId ? normalizeSpeechBoundaryDashes(segment.ttsText ?? segment.text) : segment.ttsText ?? segment.text,
            voice,
            ...segment.ttsTag ? { tagId: segment.ttsTag.id } : {}
          };
        });
        const plan = mergeVoicePlan(rawPlan);
        let planIndex = 0;
        for (const item of rawPlan) {
          const count = mergeVoicePlan([item]).length;
          segmentPlanIndexes.push(Array.from({ length: count }, (_, offset) => planIndex + offset));
          planIndex += count;
        }
        appendSpeakerDebugLog(
          `TTS voice resolution: explicit=${explicitVoiceCount}, connectionDefaultFallback=${connectionVoiceFallbacks}${connectionVoiceFallbacks > 0 ? ` (explicit default voice ${JSON.stringify(connectionProfileVoice || "<connection default>")})` : ""}.`
        );
        const tagIndexes = /* @__PURE__ */ new Map();
        plan.forEach((entry, index) => {
          if (!entry.tagId) return;
          const indexes = tagIndexes.get(entry.tagId) ?? [];
          indexes.push(index);
          tagIndexes.set(entry.tagId, indexes);
        });
        const tagSources = /* @__PURE__ */ new Map();
        let synthesisPlanFrozen = false;
        for (const segment of segments) {
          if (segment.ttsTag && (preferences.ttsTagStyle === "fish" || segment.ttsTag.sounds.length > 0 || segment.ttsTag.pauses.length > 0) && !/\n\s*\n/u.test(segment.text.trim())) {
            tagSources.set(segment.ttsTag.id, {
              text: segment.ttsTag.baseText ?? segment.ttsText ?? segment.text,
              emotions: segment.ttsTag.emotions,
              styles: segment.ttsTag.styles,
              sounds: segment.ttsTag.sounds,
              pauses: segment.ttsTag.pauses,
              modulation: segment.ttsTag.modulation === true,
              ...segment.ttsTag.modulationPoint ? { modulationPoint: segment.ttsTag.modulationPoint } : {},
              ...segment.ttsTag.modulationCharIndex !== void 0 ? { modulationCharIndex: segment.ttsTag.modulationCharIndex } : {},
              narrativeBefore: segment.ttsTag.narrativeBefore ?? "",
              narrativeAfter: segment.ttsTag.narrativeAfter ?? ""
            });
          }
        }
        const applyTagPlacements = (placements, origin) => {
          for (const placement of placements) {
            const source = tagSources.get(placement.id);
            if (!source) continue;
            tagPlacementCache.set(
              `${playbackChat.id}\0${messageId}\0${preferences.ttsTagStyle}\0${preferences.tagLlmConnectionId}\0${preferences.tagLlmModel}\0${placement.id}\0${JSON.stringify(source.emotions)}\0${JSON.stringify(source.styles)}\0${JSON.stringify(source.sounds)}\0${JSON.stringify(source.pauses)}\0${source.modulation ? "1" : "0"}\0${source.modulationPoint ?? ""}\0${source.modulationCharIndex ?? ""}\0${source.text}\0${source.narrativeBefore}\0${source.narrativeAfter}`,
              placement.text
            );
            if (synthesisPlanFrozen) {
              appendSpeakerDebugLog(
                `TTS tag placement [${placement.id}] arrived after synthesis-plan freeze; cached for the next playback without changing the active plan.`
              );
              continue;
            }
            for (const index of tagIndexes.get(placement.id) ?? []) {
              plan[index] = { ...plan[index], text: normalizeSpeechBoundaryDashes(placement.text) };
            }
            for (const segment of segments) {
              if (segment.ttsTag?.id !== placement.id) continue;
              segment.ttsText = placement.text;
              segment.ttsTag = { ...segment.ttsTag, source: "llm" };
            }
            appendSpeakerDebugLog(
              `TTS tag placement [${placement.id}] emotions=${JSON.stringify(source.emotions)}, styles=${JSON.stringify(source.styles)}, sounds=${JSON.stringify(source.sounds)}, pauses=${JSON.stringify(source.pauses)}, modulation=${source.modulation}${source.modulationPoint ? ` at ${source.modulationPoint}` : ""}${source.modulationCharIndex !== void 0 ? ` char=${source.modulationCharIndex}` : ""}${placement.emotionTag ? `, custom=${JSON.stringify(placement.emotionTag)}` : ""}${placement.modulationTag ? `, modulationTag=${JSON.stringify(placement.modulationTag)}` : ""} via ${origin}: ` + JSON.stringify(placement.text.length > 180 ? `${placement.text.slice(0, 177)}...` : placement.text)
            );
          }
        };
        if (preferences.ttsTagStyle !== "off" && preferences.ttsTagPlacement === "llm" && tagSources.size > 0) {
          const placementStyle = preferences.ttsTagStyle;
          appendSpeakerDebugLog(
            `
TTS tag placement: style=${placementStyle}, mode=llm, speeches=${tagSources.size}, connection=${JSON.stringify(preferences.tagLlmConnectionId || "<active>")}, model=${JSON.stringify(preferences.tagLlmModel || "<connection default>")}`
          );
          const keyFor = (id, source) => `${playbackChat.id}\0${messageId}\0${placementStyle}\0${preferences.tagLlmConnectionId}\0${preferences.tagLlmModel}\0${id}\0${JSON.stringify(source.emotions)}\0${JSON.stringify(source.styles)}\0${JSON.stringify(source.sounds)}\0${JSON.stringify(source.pauses)}\0${source.modulation ? "1" : "0"}\0${source.modulationPoint ?? ""}\0${source.modulationCharIndex ?? ""}\0${source.text}\0${source.narrativeBefore}\0${source.narrativeAfter}`;
          const cachedPlacements = [];
          for (const [id, source] of tagSources) {
            const cached = tagPlacementCache.get(keyFor(id, source));
            if (cached) cachedPlacements.push({ id, text: cached });
          }
          if (cachedPlacements.length > 0) {
            appendSpeakerDebugLog(
              `TTS tag placement cache hits: ${cachedPlacements.length}/${tagSources.size}.`
            );
            applyTagPlacements(cachedPlacements, "cache");
          }
          const items = [...tagSources.entries()].filter(([id, source]) => !tagPlacementCache.has(keyFor(id, source))).map(([id, source]) => ({
            id,
            text: source.text,
            emotions: source.emotions,
            styles: source.styles,
            sounds: source.sounds,
            pauses: source.pauses,
            modulation: source.modulation,
            ...source.modulationPoint ? { modulationPoint: source.modulationPoint } : {},
            ...source.modulationCharIndex !== void 0 ? { modulationCharIndex: source.modulationCharIndex } : {},
            narrativeBefore: source.narrativeBefore,
            narrativeAfter: source.narrativeAfter
          }));
          const chunks = [];
          for (let index = 0; index < items.length; index += 4) {
            chunks.push(items.slice(index, index + 4));
          }
          if (chunks.length > 0) {
            appendSpeakerDebugLog(
              `TTS tag placement chunks: ${chunks.length} pending (first chunk ${chunks[0].length} speeches, later chunks of up to 4).`
            );
            let firstSettled = false;
            appendSpeakerDebugLog(
              `TTS tag placement chunk 1/${chunks.length} started with ${chunks[0].length} speeches.`
            );
            const firstPlacement = requestTagPlacements(
              preparePlaybackContent(message.content, preferences.skippedTrackerTags),
              placementStyle,
              preferences.tagLlmConnectionId,
              preferences.tagLlmModel,
              chunks[0]
            ).then((placements) => {
              firstSettled = true;
              appendSpeakerDebugLog(
                `TTS tag placement chunk 1/${chunks.length} resolved with ${placements.length}/${chunks[0].length} placements.`
              );
              applyTagPlacements(placements, "llm");
              return placements;
            }).catch((error) => {
              firstSettled = true;
              appendSpeakerDebugLog(
                `TTS tag placement chunk 1/${chunks.length} failed; deterministic Jev placement remains: ${error instanceof Error ? error.message : String(error)}`
              );
              console.warn("[Chat Voice] First vocal tag placement chunk failed.", error);
              return [];
            });
            setStatus("Placing vocal tags\u2026");
            await Promise.race([
              firstPlacement,
              new Promise((resolve) => setTimeout(resolve, 8e3))
            ]);
            if (!firstSettled) {
              appendSpeakerDebugLog(
                "TTS tag placement chunk 1 is still pending after 8s; starting playback with deterministic Jev placement for unresolved segments."
              );
            }
            void (async () => {
              let chunkNumber = 2;
              for (const chunk of chunks.slice(1)) {
                if (playback.controller.signal.aborted) {
                  appendSpeakerDebugLog(
                    `TTS tag placement chunk ${chunkNumber}/${chunks.length} skipped because playback stopped.`
                  );
                  return;
                }
                appendSpeakerDebugLog(
                  `TTS tag placement chunk ${chunkNumber}/${chunks.length} started with ${chunk.length} speeches.`
                );
                try {
                  const placements = await requestTagPlacements(
                    preparePlaybackContent(message.content, preferences.skippedTrackerTags),
                    placementStyle,
                    preferences.tagLlmConnectionId,
                    preferences.tagLlmModel,
                    chunk
                  );
                  appendSpeakerDebugLog(
                    `TTS tag placement chunk ${chunkNumber}/${chunks.length} resolved with ${placements.length}/${chunk.length} placements.`
                  );
                  applyTagPlacements(placements, "llm");
                } catch (error) {
                  appendSpeakerDebugLog(
                    `TTS tag placement chunk ${chunkNumber}/${chunks.length} failed; deterministic Jev placement remains: ${error instanceof Error ? error.message : String(error)}`
                  );
                  console.warn("[Chat Voice] Vocal tag placement chunk failed.", error);
                }
                chunkNumber += 1;
              }
            })();
          }
        }
        if (uncastGroups.length) setStatus("Matching uncast characters to favorite voices\u2026");
        const uncastMatches = await uncastMatchPromise;
        if (playback.controller.signal.aborted) throw new DOMException("Playback stopped.", "AbortError");
        for (const match of uncastMatches) {
          const group = uncastGroups.find((item) => item.id === match.groupId);
          if (!group || reservedVoices.includes(match.voiceId)) continue;
          for (const segmentIndex of group.segmentIndexes) {
            for (const index of segmentPlanIndexes[segmentIndex] ?? []) plan[index] = { ...plan[index], voice: match.voiceId };
          }
          appendSpeakerDebugLog(`Uncast voice ${group.id}: gender=${match.gender}, ghost=${match.ghostId ?? "none"}, voice=${JSON.stringify(match.voiceId)}.`);
        }
        synthesisPlanFrozen = true;
        const splitPlan = splitLargeVoicePlanSegments(plan);
        if (splitPlan.length !== plan.length) {
          appendSpeakerDebugLog(
            `Split ${plan.length} paragraph-level TTS job${plan.length === 1 ? "" : "s"} into ${splitPlan.length} latency-sized segments.`
          );
          plan.splice(0, plan.length, ...splitPlan);
        }
        if (plan.length === 0) throw new Error("This message has no playable narration or dialogue.");
        if (preferences.speakerAssignmentDebug) {
          appendSpeakerDebugLog("\nSynthesis plan");
          plan.forEach((segment, index) => appendSpeakerDebugLog(
            `  [${index + 1}] voice=${JSON.stringify(segment.voice || "<connection default>")} text=${JSON.stringify(segment.text.length > 120 ? `${segment.text.slice(0, 117)}...` : segment.text)}`
          ));
        }
        const synthesisMessageKey = swipeSynthesisKey(playbackChat.id, messageId, message.swipe_id ?? 0);
        const previousSynthesis = backgroundSynthesisByMessage.get(synthesisMessageKey);
        if (previousSynthesis) {
          previousSynthesis.abort();
          backgroundSynthesisByMessage.delete(synthesisMessageKey);
          appendSpeakerDebugLog("Cancelled an older unfinished synthesis/save for this message swipe.");
        }
        const synthesisController = new AbortController();
        const rateLimitBudget = {
          blockedUntil: 0,
          cumulativeWaitMs: 0,
          consecutiveResponses: 0,
          maximumWaitMs: preferences.rateLimitWaitSeconds * 1e3,
          recovering: false,
          recoveryTail: Promise.resolve()
        };
        playback.synthesisController = synthesisController;
        backgroundSynthesisControllers.add(synthesisController);
        backgroundSynthesisByMessage.set(synthesisMessageKey, synthesisController);
        const adaptiveLimitToken = Symbol("playback-concurrency");
        let adaptiveConcurrency = 1;
        let shortConcurrencyCooldown = 0;
        let longWindowStreak = 0;
        let rateLimitedForRemainder = false;
        const prepare = async (index) => {
          try {
            appendSpeakerDebugLog(
              `Synthesis request [${index + 1}] started with voice=${JSON.stringify(plan[index].voice || "<connection default>")}.`
            );
            const segment = await runSynthesisTask(() => {
              const text = plan[index].text;
              const voice = plan[index].voice;
              appendSpeakerDebugLog(
                `Synthesis dispatch [${index + 1}] voice=${JSON.stringify(voice || "<connection default>")}, textHash=${hashMessageContent(text)}, chars=${text.length}.`
              );
              return synthesizeVoiceSegment(
                connectionId,
                text,
                voice,
                preferences.speed,
                synthesisController.signal,
                sharedSynthesisPacer,
                rateLimitBudget,
                connectionVoiceGates.get(connectionId) ?? (() => {
                  const gate = new ConnectionVoiceGate();
                  connectionVoiceGates.set(connectionId, gate);
                  return gate;
                })(),
                (delayMs, cumulativeWaitMs) => {
                  rateLimitedForRemainder = true;
                  adaptiveConcurrency = 1;
                  shortConcurrencyCooldown = 0;
                  longWindowStreak = 0;
                  adaptiveSynthesisLimits.set(adaptiveLimitToken, 1);
                  drainSynthesisQueue();
                  if (ctx.getActiveChat().chatId === playbackChat.id && (!activePlayback || activePlayback === playback)) {
                    setStatus(
                      `Rate limited; resuming in ${Math.max(1, Math.ceil(delayMs / 1e3))}s\u2026 (${Math.ceil(cumulativeWaitMs / 1e3)}s of ${preferences.rateLimitWaitSeconds}s wait budget)`
                    );
                  }
                }
              );
            }, activePlayback === playback && !playback.playbackStopped);
            appendSpeakerDebugLog(
              `Synthesis request [${index + 1}] completed with voice=${JSON.stringify(plan[index].voice || "<connection default>")} (${segment.data.byteLength} bytes, ${segment.mime}, fingerprint=${segment.fingerprint ?? "<none>"}).`
            );
            return { ok: true, segment };
          } catch (error) {
            appendSpeakerDebugLog(
              `Synthesis request [${index + 1}] failed for voice=${JSON.stringify(plan[index].voice || "<connection default>")}: ${error instanceof Error ? error.message : String(error)}`
            );
            return { ok: false, error };
          }
        };
        const preparedResolvers = [];
        const prepared = plan.map(() => new Promise((resolve) => {
          preparedResolvers.push(resolve);
        }));
        const synthesizedIndexes = /* @__PURE__ */ new Set();
        let playbackCursor = 0;
        const readySynthesisAhead = () => {
          let index = playbackCursor;
          while (synthesizedIndexes.has(index)) index += 1;
          return index - playbackCursor;
        };
        let synthesisCursor = 0;
        let localSynthesisTasks = 0;
        const initialAdaptiveState = adaptiveGenerationConcurrency(
          adaptiveConcurrency,
          preferences.concurrentGenerations,
          plan.slice(0, 6).map((segment) => segment.text.length),
          shortConcurrencyCooldown,
          longWindowStreak,
          MAX_CONCURRENT_GENERATIONS,
          plan.slice(1, 6).filter((segment, index) => segment.voice !== plan[index]?.voice).length
        );
        adaptiveConcurrency = bufferAwareGenerationConcurrency(
          adaptiveConcurrency,
          preferences.concurrentGenerations,
          readySynthesisAhead(),
          preferences.playbackBufferSegments,
          initialAdaptiveState.concurrency,
          rateLimitedForRemainder,
          MAX_CONCURRENT_GENERATIONS
        );
        shortConcurrencyCooldown = initialAdaptiveState.shortCooldown;
        longWindowStreak = initialAdaptiveState.longWindowStreak;
        adaptiveSynthesisLimits.set(adaptiveLimitToken, adaptiveConcurrency);
        appendSpeakerDebugLog(
          `Initial synthesis concurrency=${adaptiveConcurrency}, readyAhead=${readySynthesisAhead()}, bufferTarget=${preferences.playbackBufferSegments}, configuredMax=${preferences.concurrentGenerations}.`
        );
        const scheduleSynthesis = () => {
          while (localSynthesisTasks < adaptiveConcurrency && synthesisCursor < plan.length) {
            const index = synthesisCursor++;
            localSynthesisTasks += 1;
            void prepare(index).then((result) => {
              if (result.ok) synthesizedIndexes.add(index);
              preparedResolvers[index](result);
            }).finally(() => {
              localSynthesisTasks -= 1;
              if (!rateLimitedForRemainder) {
                const nextState = adaptiveGenerationConcurrency(
                  adaptiveConcurrency,
                  preferences.concurrentGenerations,
                  plan.slice(index + 1, Math.min(plan.length, index + 7)).map((segment) => segment.text.length),
                  shortConcurrencyCooldown,
                  longWindowStreak,
                  MAX_CONCURRENT_GENERATIONS,
                  plan.slice(index + 2, Math.min(plan.length, index + 7)).filter((segment, offset) => segment.voice !== plan[index + 1 + offset]?.voice).length
                );
                const previousConcurrency = adaptiveConcurrency;
                adaptiveConcurrency = bufferAwareGenerationConcurrency(
                  adaptiveConcurrency,
                  preferences.concurrentGenerations,
                  readySynthesisAhead(),
                  preferences.playbackBufferSegments,
                  nextState.concurrency,
                  rateLimitedForRemainder,
                  MAX_CONCURRENT_GENERATIONS
                );
                if (adaptiveConcurrency !== previousConcurrency) {
                  appendSpeakerDebugLog(
                    `Synthesis concurrency ${previousConcurrency}->${adaptiveConcurrency} after request ${index + 1}; readyAhead=${readySynthesisAhead()}, bufferTarget=${preferences.playbackBufferSegments}.`
                  );
                }
                shortConcurrencyCooldown = nextState.shortCooldown;
                longWindowStreak = nextState.longWindowStreak;
                adaptiveSynthesisLimits.set(adaptiveLimitToken, adaptiveConcurrency);
                drainSynthesisQueue();
              }
              scheduleSynthesis();
            });
          }
        };
        scheduleSynthesis();
        void Promise.all(prepared).finally(() => {
          adaptiveSynthesisLimits.delete(adaptiveLimitToken);
          drainSynthesisQueue();
        });
        const normalizationContext = new contextClass();
        const voiceLoudnessProfiles = /* @__PURE__ */ new Map();
        let normalizationChain = Promise.resolve();
        const processed = prepared.map((pending, index) => {
          const processing = normalizationChain.then(async () => {
            const result = await pending;
            if (!result.ok) return result;
            const decodedBuffer = await normalizationContext.decodeAudioData(result.segment.data.slice(0));
            const voiceKey = plan[index].voice.trim().toLowerCase() || "__connection-default__";
            const normalizationGain = normalizedVoiceGain(decodedBuffer, voiceKey, voiceLoudnessProfiles);
            return {
              ok: true,
              segment: { ...result.segment, decodedBuffer, normalizationGain }
            };
          });
          normalizationChain = processing.then(() => void 0, () => void 0);
          return processing;
        });
        void Promise.all(processed).finally(() => normalizationContext.close().catch(() => void 0)).catch(() => void 0);
        if (shouldPersistMessageAudio(
          message.is_user,
          preferences.saveGeneratedAudio,
          regeneratingSavedAudio
        )) {
          playback.persistenceState = "pending";
          void Promise.all(processed).then(async (results) => {
            const failed = results.find((result) => !result.ok);
            if (failed) throw failed.error;
            const captured = results.filter(
              (result) => result.ok
            ).map((result) => ({
              data: result.segment.data.slice(0),
              mime: result.segment.mime,
              decodedBuffer: result.segment.decodedBuffer,
              normalizationGain: result.segment.normalizationGain
            }));
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
                  setStatus(normalized ? "Preparing normalized saved audio\u2026" : "Server could not combine the source audio; retrying as WAV\u2026");
                }
              },
              async () => {
                if (!Number.isInteger(message.swipe_id) || (message.swipe_id ?? -1) < 0) throw new Error("Cannot safely save audio: the target swipe ID is unavailable.");
                const latest = await requestPlaybackMessage(playbackChat.id, messageId);
                const originalSwipe = autoplaySwipeSnapshot(message);
                const refreshedSwipe = refreshAutoplaySwipe(latest, originalSwipe);
                if (synthesisController.signal.aborted || latest.is_user || !refreshedSwipe) {
                  appendSpeakerDebugLog(`Audio save cancelled: message ${messageId}, swipe ${message.swipe_id}, was removed, navigated, or replaced since playback began.`);
                  throw new DOMException("Target swipe changed before audio save.", "AbortError");
                }
                if (refreshedSwipe.contentHash !== originalSwipe.contentHash) {
                  appendSpeakerDebugLog(`Audio save: message ${messageId}, swipe ${message.swipe_id}, message text was refined on the same swipe since playback began; saving the audio of the text as played.`);
                }
              }
            );
            const savedAudioId = saved.audio?.id;
            if (savedAudioId) {
              try {
                await enforceSavedAudioRetention({
                  chatId: playbackChat.id,
                  messageId,
                  audioId: savedAudioId,
                  swipeId: saved.swipe_id ?? message.swipe_id ?? 0,
                  savedAt: Date.now()
                });
              } catch (error) {
                console.warn("[Chat Voice] Saved audio retention cleanup failed.", error);
              }
            }
            playback.persistenceState = "saved";
            console.info("[Chat Voice] Saved generated message audio.", {
              messageId,
              swipeId: saved.swipe_id,
              audioId: saved.audio?.id,
              mime: saved.audio?.mime_type,
              sizeBytes: saved.audio?.size_bytes,
              muxedWithFfmpeg: saved.muxed_with_ffmpeg
            });
            if (ctx.getActiveChat().chatId === playbackChat.id && (!activePlayback || activePlayback === playback)) {
              if (playback.playbackStopped) setStatus("Playback stopped; audio saved.", "saved");
              else if (playback.playbackFinished) setStatus("Playback complete and audio saved.", "saved");
            }
          }).catch((error) => {
            playback.persistenceState = "failed";
            playback.persistenceError = error instanceof Error ? error.message : "Unknown save error.";
            if (error?.name !== "AbortError" && ctx.getActiveChat().chatId === playbackChat.id && (!activePlayback || activePlayback === playback) && (playback.playbackStopped || playback.playbackFinished)) {
              setStatus(`Audio could not be saved: ${playback.persistenceError}`, "error");
            }
          }).finally(() => {
            backgroundSynthesisControllers.delete(synthesisController);
            if (backgroundSynthesisByMessage.get(synthesisMessageKey) === synthesisController) {
              backgroundSynthesisByMessage.delete(synthesisMessageKey);
            }
          });
        } else {
          playback.persistenceState = "disabled";
          void Promise.all(processed).catch(() => void 0).finally(() => {
            backgroundSynthesisControllers.delete(synthesisController);
            if (backgroundSynthesisByMessage.get(synthesisMessageKey) === synthesisController) {
              backgroundSynthesisByMessage.delete(synthesisMessageKey);
            }
          });
        }
        const initialBufferSize = Math.min(preferences.playbackBufferSegments, plan.length);
        setStatus(
          `Buffering ${initialBufferSize} voice segment${initialBufferSize === 1 ? "" : "s"} before playback\u2026`
        );
        await Promise.all(processed.slice(0, initialBufferSize));
        for (let index = 0; index < plan.length; index += 1) {
          const current = await processed[index];
          if (!current.ok) throw current.error;
          playbackCursor = index + 1;
          if (synthesisCursor < plan.length || localSynthesisTasks > 0) {
            const pressuredConcurrency = bufferAwareGenerationConcurrency(
              adaptiveConcurrency,
              preferences.concurrentGenerations,
              readySynthesisAhead(),
              preferences.playbackBufferSegments,
              adaptiveConcurrency,
              rateLimitedForRemainder,
              MAX_CONCURRENT_GENERATIONS
            );
            if (pressuredConcurrency !== adaptiveConcurrency) {
              appendSpeakerDebugLog(
                `Synthesis concurrency ${adaptiveConcurrency}->${pressuredConcurrency} at playback ${index + 1}; readyAhead=${readySynthesisAhead()}, bufferTarget=${preferences.playbackBufferSegments}.`
              );
              adaptiveConcurrency = pressuredConcurrency;
              adaptiveSynthesisLimits.set(adaptiveLimitToken, adaptiveConcurrency);
              drainSynthesisQueue();
              scheduleSynthesis();
            }
          }
          appendSpeakerDebugLog(
            `Playback [${index + 1}] using voice=${JSON.stringify(plan[index].voice || "<connection default>")}.`
          );
          if (index === 0) appendSpeakerDebugLog(`Time from playback setup to first audio dispatch: ${Date.now() - playbackSetupFinishedAt}ms (includes speaker review, tag placement and buffering).`);
          setStatus(`Playing ${index + 1} of ${plan.length} voice segment${plan.length === 1 ? "" : "s"}\u2026`);
          await playDecodedBuffer(playback, current.segment, preferences.volume);
        }
        adaptiveSynthesisLimits.delete(adaptiveLimitToken);
        drainSynthesisQueue();
        playback.playbackFinished = true;
        playback.finishAudible();
        if (activePlayback === playback) {
          activePlayback = null;
          updatePlaybackButtons();
          await playback.context.close().catch(() => void 0);
        }
        const persistenceState = playback.persistenceState;
        if (persistenceState === "saved") setStatus("Playback complete and audio saved.", "saved");
        else if (persistenceState === "failed") {
          setStatus(`Playback completed, but its audio could not be saved: ${playback.persistenceError}`, "error");
        } else if (persistenceState === "pending") setStatus("Playback complete; finishing saved audio\u2026");
        else setStatus("Playback complete.", "saved");
      } catch (error) {
        if (error?.name !== "AbortError") {
          setStatus(error instanceof Error ? error.message : "Custom voice playback failed.", "error");
        }
      } finally {
        playback.finishAudible();
        if (activePlayback === playback) {
          activePlayback = null;
          await playback.context.close().catch(() => void 0);
          updatePlaybackButtons();
        }
      }
    } finally {
      playbackStartup.finish(startupToken);
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
      messageLimit: activeChat.messageLimit,
      tagLlmConnectionId
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
  function removeCharacter(characterId) {
    if (!activeChat) return;
    activeChat = {
      ...activeChat,
      characters: activeChat.characters.filter((character) => character.id !== characterId)
    };
    renderCharacters(activeChat.characters);
    markChanged(0);
  }
  function renameCharacter(characterId, response) {
    if (!activeChat) return null;
    const character = activeChat.characters.find((item) => item.id === characterId);
    if (!character) return null;
    const aliases = speakerAliases(response.slice(0, 4096));
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
  function updateFavoritePickers() {
    for (const picker of favoritePickers) {
      picker.replaceChildren();
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = favoriteVoices.length ? "Choose a favorite voice\u2026" : "No favorite voices yet";
      picker.appendChild(placeholder);
      for (const [category, label] of [["female", "Female"], ["male", "Male"], ["unspecified", "Unspecified"]]) {
        const entries = favoriteVoices.filter((voice) => category === "unspecified" ? voiceGender(voice) === "unknown" : voiceGender(voice) === category);
        if (!entries.length) continue;
        const group = document.createElement("optgroup");
        group.label = label;
        for (const voice of entries) {
          const option = document.createElement("option");
          option.value = voice.id;
          option.textContent = voice.name || voice.id;
          group.appendChild(option);
        }
        picker.appendChild(group);
      }
      picker.disabled = !activeChat || favoriteVoices.length === 0;
      let view = favoritePickerViews.get(picker);
      if (!view) {
        const details = document.createElement("details");
        details.className = "chat-voice-favorite-picker";
        details.style.marginTop = picker.style.marginTop;
        const summary = document.createElement("summary");
        summary.className = "chat-voice-favorite-select";
        summary.setAttribute("aria-label", picker.getAttribute("aria-label") || "Favorite voice");
        const options = document.createElement("div");
        options.className = "chat-voice-favorite-options";
        details.append(summary, options);
        picker.insertAdjacentElement("afterend", details);
        picker.hidden = true;
        picker.tabIndex = -1;
        summary.addEventListener("click", (event) => {
          if (picker.disabled) event.preventDefault();
        });
        details.addEventListener("toggle", () => {
          if (details.open) {
            if (openFavoritePicker && openFavoritePicker !== details) openFavoritePicker.open = false;
            openFavoritePicker = details;
          } else if (openFavoritePicker === details) openFavoritePicker = null;
        });
        view = { details, summary, options };
        favoritePickerViews.set(picker, view);
      }
      view.summary.textContent = placeholder.textContent;
      view.summary.setAttribute("aria-disabled", String(picker.disabled));
      view.details.setAttribute("aria-disabled", String(picker.disabled));
      if (picker.disabled) view.details.open = false;
      view.options.replaceChildren();
      for (const [category, label] of [["female", "Female"], ["male", "Male"], ["unspecified", "Unspecified"]]) {
        const entries = favoriteVoices.filter((voice) => category === "unspecified" ? voiceGender(voice) === "unknown" : voiceGender(voice) === category);
        if (!entries.length) continue;
        const heading = document.createElement("div");
        heading.className = "chat-voice-favorite-category";
        heading.textContent = label;
        view.options.appendChild(heading);
        for (const voice of entries) {
          const row = document.createElement("div");
          row.className = "chat-voice-favorite-option";
          const selectVoice = document.createElement("button");
          selectVoice.type = "button";
          selectVoice.className = "chat-voice-favorite-option-name";
          selectVoice.textContent = voice.name || voice.id;
          const pickerView = view;
          selectVoice.addEventListener("click", () => {
            if (picker.disabled) return;
            picker.value = voice.id;
            picker.dispatchEvent(new Event("change", { bubbles: true }));
            pickerView.details.open = false;
            pickerView.summary.focus();
          });
          const preview = createCastPreviewButton(() => voice.name || voice.id, () => voice.id);
          row.append(preview, selectVoice);
          view.options.appendChild(row);
        }
      }
    }
    updateCharacterVoiceDisplays();
    updateRoleVoiceDisplays();
  }
  function updateCharacterVoiceDisplays() {
    for (const { input, display } of ghostVoiceEditors.values()) {
      const voiceId = input.getValue().trim();
      display.textContent = favoriteVoices.find((voice) => voice.id === voiceId)?.name || voiceId || "Connection default voice";
      display.title = voiceId ? `Voice ID: ${voiceId}. Click to edit.` : "Click to enter a voice ID.";
    }
    for (const [id, display] of characterVoiceDisplays) {
      const voiceId = characterInputs.get(id)?.getValue().trim() ?? "";
      const favorite = favoriteVoices.find((voice) => voice.id === voiceId);
      display.textContent = favorite?.name || voiceId || "Connection default voice";
      display.title = voiceId ? `Voice ID: ${voiceId}. Click to edit.` : "Click to enter a voice ID.";
    }
  }
  function stopVoicePreview() {
    previewController?.abort();
    previewController = null;
    if (previewAudio) {
      previewAudio.pause();
      previewAudio.removeAttribute("src");
      previewAudio.load();
      previewAudio = null;
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  }
  async function previewVoice(voiceId, voiceLabel) {
    const connectionId = connectionPicker.getValue() || lumiverseConnectionId;
    if (!connectionId) {
      setStatus("Choose a TTS connection to preview a voice.", "error");
      return;
    }
    stopVoicePreview();
    const controller = new AbortController();
    previewController = controller;
    setStatus(`Generating preview for ${voiceLabel}\u2026`);
    const budget = {
      blockedUntil: 0,
      cumulativeWaitMs: 0,
      consecutiveResponses: 0,
      maximumWaitMs: rateLimitWaitSeconds * 1e3,
      recovering: false,
      recoveryTail: Promise.resolve()
    };
    const gate = connectionVoiceGates.get(connectionId) ?? new ConnectionVoiceGate();
    connectionVoiceGates.set(connectionId, gate);
    try {
      const segment = await runSynthesisTask(() => synthesizeVoiceSegment(
        connectionId,
        "Hello. This is a preview of my voice.",
        voiceId,
        1,
        controller.signal,
        sharedSynthesisPacer,
        budget,
        gate,
        (delay) => setStatus(`Preview rate limited; retrying in ${Math.ceil(delay / 1e3)}s\u2026`)
      ), true);
      if (controller.signal.aborted || previewController !== controller) return;
      previewUrl = URL.createObjectURL(new Blob([segment.data], { type: segment.mime }));
      const audio = new Audio(previewUrl);
      previewAudio = audio;
      audio.onended = () => {
        if (previewAudio === audio) {
          stopVoicePreview();
          setStatus("Voice preview finished.", "saved");
        }
      };
      await audio.play();
      if (previewController === controller) setStatus(`Playing preview for ${voiceLabel}.`);
    } catch (error) {
      if (controller.signal.aborted) return;
      stopVoicePreview();
      setStatus(error instanceof Error ? `Voice preview failed: ${error.message}` : "Voice preview failed.", "error");
    }
  }
  function createCastPreviewButton(name, voice) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chat-voice-cast-preview";
    button.innerHTML = MICROPHONE_ICON;
    button.title = `Preview voice for ${name()}`;
    button.setAttribute("aria-label", button.title);
    button.addEventListener("click", () => {
      const id = voice().trim();
      const label = favoriteVoices.find((item) => item.id === id)?.name || id || "connection default voice";
      void previewVoice(id, label);
    });
    return button;
  }
  async function saveFavoriteVoices(next, adding) {
    if (favoritesSaving) return false;
    favoritesSaving = true;
    favoriteAdd.disabled = true;
    try {
      let savedVoices = next;
      await updateVoiceSettings((current) => {
        if (adding) savedVoices = addFavoriteVoice(readFavoriteVoices(current.chatVoiceFavoriteVoices), adding);
        return { ...current, chatVoiceFavoriteVoices: savedVoices };
      });
      favoriteVoices = savedVoices;
      favoriteError.hidden = true;
      renderFavoriteVoices();
      updateFavoritePickers();
      setStatus("Favorite voices saved globally.", "saved");
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save favorite voices.";
      if (adding) {
        favoriteError.textContent = message;
        favoriteError.hidden = false;
      }
      setStatus(message, "error");
      return false;
    } finally {
      favoritesSaving = false;
      favoriteAdd.disabled = false;
    }
  }
  function renderFavoriteVoices() {
    editingFavoriteVoiceId = null;
    favoriteList.replaceChildren();
    if (!favoriteVoices.length) {
      const empty = document.createElement("div");
      empty.className = "chat-voice-hint";
      empty.textContent = "Add voice IDs to reuse them in any chat.";
      favoriteList.appendChild(empty);
      return;
    }
    const visibleVoices = favoriteVoices.filter((voice) => favoriteFilter.value === "unspecified" || voiceGender(voice) === favoriteFilter.value);
    if (!visibleVoices.length) {
      const empty = document.createElement("div");
      empty.className = "chat-voice-hint";
      empty.textContent = "No favorite voices match this filter.";
      favoriteList.appendChild(empty);
      return;
    }
    for (const voice of visibleVoices) {
      const row = document.createElement("div");
      row.className = "chat-voice-favorite-row";
      const copy = document.createElement("span");
      copy.className = "chat-voice-favorite-copy";
      copy.textContent = voice.name || voice.id;
      copy.title = voice.id;
      if (voice.description) {
        const description = document.createElement("small");
        description.textContent = voice.description;
        copy.appendChild(description);
      }
      {
        const basicsText = [
          voiceGender(voice) === "male" ? "Male" : voiceGender(voice) === "female" ? "Female" : "",
          voiceAge(voice) === "young" ? "Young" : voiceAge(voice) === "middle aged" ? "Middle Aged" : voiceAge(voice) === "old" ? "Old" : "",
          voice.languages?.length ? voice.languages.map((code) => ({ en: "English", es: "Spanish", ar: "Arabic", ru: "Russian", ja: "Japanese", pt: "Portuguese", zh: "Chinese", fr: "French", it: "Italian" })[code.toLowerCase()] ?? code).join(" + ") : "",
          voice.author ? `by ${voice.author}` : ""
        ].filter(Boolean).join(" \xB7 ");
        if (basicsText) {
          const basics2 = document.createElement("small");
          basics2.textContent = basicsText;
          copy.appendChild(basics2);
        }
      }
      const GENDER_TAGS = ["male", "female"];
      const AGE_TAGS = ["young", "middle aged", "old"];
      const USE_CASE_TAGS = [["conversational", "Conversational"], ["narration", "Narration"], ["character voice", "Character Voice"], ["social media", "Social Media"], ["educational", "Educational"], ["advertisement", "Advertisement"], ["entertainment", "Entertainment"]];
      const QUALITY_TAGS = [["deep", "Deep"], ["low", "Low"], ["medium", "Medium"], ["high", "High"], ["soft", "Soft"], ["bright", "Bright"]];
      const LANGUAGE_OPTIONS = [["en", "\u{1F1FA}\u{1F1F8} English"], ["es", "\u{1F1EA}\u{1F1F8} Spanish"], ["ar", "\u{1F1F8}\u{1F1E6} Arabic"], ["ru", "\u{1F1F7}\u{1F1FA} Russian"], ["ja", "\u{1F1EF}\u{1F1F5} Japanese"], ["pt", "\u{1F1E7}\u{1F1F7} Portuguese"], ["zh", "\u{1F1E8}\u{1F1F3} Chinese"], ["fr", "\u{1F1EB}\u{1F1F7} French"], ["it", "\u{1F1EE}\u{1F1F9} Italian"]];
      const KNOWN_TAGS = /* @__PURE__ */ new Set([...GENDER_TAGS, ...AGE_TAGS, ...USE_CASE_TAGS.map(([tag]) => tag), ...QUALITY_TAGS.map(([tag]) => tag), ...communityFilterQualityExtended.map(([tag]) => tag)]);
      const lowerTags = (item) => new Set((item.tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean));
      const patchVoice = (update) => saveFavoriteVoices(favoriteVoices.map((item) => item.id === voice.id ? update(item) : item));
      const withTags = (item, tags) => {
        const deduped = [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 32);
        return deduped.length ? { ...item, tags: deduped } : { ...item, tags: void 0 };
      };
      const withoutTags = (item, excluded) => withTags(item, (item.tags ?? []).filter((tag) => !excluded.includes(tag.trim().toLowerCase())));
      const basics = document.createElement("div");
      basics.className = "chat-voice-favorite-basics";
      const makeBasic = (label, aria) => {
        const field = document.createElement("label");
        field.className = "chat-voice-favorite-basic";
        const name = document.createElement("span");
        name.textContent = label;
        const select = document.createElement("select");
        select.setAttribute("aria-label", aria);
        field.append(name, select);
        basics.appendChild(field);
        return select;
      };
      const genderSelect = makeBasic("Gender", `Gender for ${voice.name || voice.id}`);
      for (const [value, text] of [["unspecified", "Unspecified"], ["female", "Female"], ["male", "Male"]]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = text;
        genderSelect.appendChild(option);
      }
      if (voice.category && !["unspecified", "male", "female"].includes(voice.category)) {
        const option = document.createElement("option");
        option.value = voice.category;
        option.textContent = voice.category;
        genderSelect.appendChild(option);
      }
      genderSelect.value = voiceGender(voice) === "unknown" ? voice.category || "unspecified" : voiceGender(voice);
      genderSelect.addEventListener("change", () => {
        const next = genderSelect.value;
        genderSelect.disabled = true;
        void patchVoice((item) => {
          const cleared = withoutTags(item, GENDER_TAGS);
          if (next === "male" || next === "female") {
            return { ...cleared, gender: next, category: next, tags: [.../* @__PURE__ */ new Set([...cleared.tags ?? [], next])] };
          }
          const legacy = ["male", "female", "unspecified"].includes(item.category);
          return { ...cleared, gender: void 0, category: legacy ? "unspecified" : item.category || "unspecified" };
        }).then((saved) => {
          if (!saved) genderSelect.disabled = false;
        });
      });
      const ageSelect = makeBasic("Age", `Age for ${voice.name || voice.id}`);
      for (const [value, text] of [["unknown", "Any age"], ["young", "Young"], ["middle aged", "Middle Aged"], ["old", "Old"]]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = text;
        ageSelect.appendChild(option);
      }
      ageSelect.value = voiceAge(voice);
      ageSelect.addEventListener("change", () => {
        const next = ageSelect.value;
        ageSelect.disabled = true;
        void patchVoice((item) => {
          const cleared = withoutTags(item, AGE_TAGS);
          return next === "unknown" ? cleared : withTags(cleared, [...cleared.tags ?? [], next]);
        }).then((saved) => {
          if (!saved) ageSelect.disabled = false;
        });
      });
      const languageSelect = makeBasic("Language", `Language for ${voice.name || voice.id}`);
      for (const [value, text] of [["", "Any language"], ...LANGUAGE_OPTIONS]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = text;
        languageSelect.appendChild(option);
      }
      languageSelect.value = voice.languages?.length === 1 ? voice.languages[0].toLowerCase() : voice.languages?.length ? voice.languages[0].toLowerCase() || "" : "";
      languageSelect.addEventListener("change", () => {
        const next = languageSelect.value;
        languageSelect.disabled = true;
        void patchVoice((item) => ({ ...item, languages: next ? [next] : void 0 })).then((saved) => {
          if (!saved) languageSelect.disabled = false;
        });
      });
      const detailsToggle = document.createElement("button");
      detailsToggle.type = "button";
      detailsToggle.className = "chat-voice-expand-more";
      const detailsOpen = () => favoriteDetailsOpen.has(voice.id);
      detailsToggle.textContent = detailsOpen() ? "Show less" : "\u22EF Details";
      detailsToggle.setAttribute("aria-expanded", String(detailsOpen()));
      const details = document.createElement("div");
      details.className = "chat-voice-favorite-details";
      details.hidden = !detailsOpen();
      detailsToggle.addEventListener("click", () => {
        if (detailsOpen()) favoriteDetailsOpen.delete(voice.id);
        else favoriteDetailsOpen.add(voice.id);
        details.hidden = !detailsOpen();
        detailsToggle.textContent = detailsOpen() ? "Show less" : "\u22EF Details";
        detailsToggle.setAttribute("aria-expanded", String(detailsOpen()));
      });
      const makeChipGroup = (title, entries, isOn, toggle, more) => {
        const section = document.createElement("div");
        section.className = "chat-voice-filter-group";
        const heading = document.createElement("div");
        heading.className = "chat-voice-filter-title";
        heading.textContent = title;
        const chips = document.createElement("div");
        chips.className = "chat-voice-filter-chips";
        const addChip = ([tag, label], hidden) => {
          const chip = document.createElement("button");
          chip.type = "button";
          chip.className = "chat-voice-add-button chat-voice-filter-chip";
          chip.dataset.tag = tag;
          chip.dataset.kind = title;
          chip.hidden = hidden;
          chip.setAttribute("aria-pressed", String(isOn(tag)));
          chip.textContent = `${isOn(tag) ? "\u2713" : "+"} ${label}`;
          chip.addEventListener("click", () => toggle(tag));
          chips.appendChild(chip);
          return chip;
        };
        for (const entry of entries) addChip(entry, false);
        if (more?.length) {
          for (const entry of more) addChip(entry, true);
          const expand = document.createElement("button");
          expand.type = "button";
          expand.className = "chat-voice-expand-more";
          expand.textContent = `+ ${more.length} more`;
          let expanded = false;
          expand.addEventListener("click", () => {
            expanded = !expanded;
            for (const chip of chips.querySelectorAll(".chat-voice-filter-chip")) {
              const tag = chip.dataset.tag ?? "";
              if (more.some(([entryTag]) => entryTag === tag)) chip.hidden = !expanded;
            }
            expand.textContent = expanded ? "Show less" : `+ ${more.length} more`;
          });
          chips.appendChild(expand);
        }
        section.append(heading, chips);
        return section;
      };
      const current = () => favoriteVoices.find((item) => item.id === voice.id) ?? voice;
      details.appendChild(makeChipGroup("Languages", LANGUAGE_OPTIONS, (tag) => (current().languages ?? []).some((code) => code.toLowerCase() === tag), (tag) => {
        patchVoice((item) => {
          const codes = (item.languages ?? []).map((code) => code.toLowerCase());
          const next = codes.includes(tag) ? codes.filter((code) => code !== tag) : [...codes, tag];
          return { ...item, languages: next.length ? next : void 0 };
        });
      }));
      details.appendChild(makeChipGroup("Use Case", USE_CASE_TAGS, (tag) => lowerTags(current()).has(tag), (tag) => {
        patchVoice((item) => {
          const set = lowerTags(item);
          if (set.has(tag)) set.delete(tag);
          else set.add(tag);
          return withTags(item, [...set]);
        });
      }));
      details.appendChild(makeChipGroup("Voice Qualities", QUALITY_TAGS, (tag) => lowerTags(current()).has(tag), (tag) => {
        patchVoice((item) => {
          const set = lowerTags(item);
          if (set.has(tag)) set.delete(tag);
          else set.add(tag);
          return withTags(item, [...set]);
        });
      }, communityFilterQualityExtended));
      const authorGroup = document.createElement("div");
      authorGroup.className = "chat-voice-filter-group";
      const authorTitle = document.createElement("div");
      authorTitle.className = "chat-voice-filter-title";
      authorTitle.textContent = "Author";
      const authorInput = document.createElement("input");
      authorInput.placeholder = "Voice author (optional)";
      authorInput.maxLength = 128;
      authorInput.value = voice.author ?? "";
      authorInput.setAttribute("aria-label", `Author for ${voice.name || voice.id}`);
      authorInput.addEventListener("change", () => {
        const value = authorInput.value.trim().slice(0, 128);
        patchVoice((item) => ({ ...item, author: value || void 0 }));
      });
      authorGroup.append(authorTitle, authorInput);
      details.appendChild(authorGroup);
      const tagsGroup = document.createElement("div");
      tagsGroup.className = "chat-voice-filter-group";
      const tagsTitle = document.createElement("div");
      tagsTitle.className = "chat-voice-filter-title";
      tagsTitle.textContent = "Tags";
      const tagsInput = document.createElement("input");
      tagsInput.placeholder = "Other tags (comma-separated)";
      tagsInput.maxLength = 512;
      tagsInput.value = (voice.tags ?? []).filter((tag) => !KNOWN_TAGS.has(tag.trim().toLowerCase())).join(", ");
      tagsInput.setAttribute("aria-label", `Other tags for ${voice.name || voice.id}`);
      const tagsHint = document.createElement("div");
      tagsHint.className = "chat-voice-hint";
      tagsHint.textContent = "Gender, age, use case, and voice quality chips also count as tags and are managed above.";
      tagsInput.addEventListener("change", () => {
        const custom = tagsInput.value.split(",").map((tag) => tag.trim().slice(0, 64)).filter(Boolean);
        patchVoice((item) => {
          const pressed = [...details.querySelectorAll('.chat-voice-filter-chip[aria-pressed="true"]')].filter((chip) => chip.dataset.kind !== "Languages").map((chip) => chip.dataset.tag ?? "");
          const gendered = [voiceGender(item), voiceAge(item)].filter((value) => value !== "unknown");
          return withTags(item, [...pressed, ...gendered, ...custom]);
        });
      });
      tagsGroup.append(tagsTitle, tagsHint, tagsInput);
      details.appendChild(tagsGroup);
      if (voice.communityLink) {
        const linkLine = document.createElement("div");
        linkLine.className = "chat-voice-hint";
        linkLine.textContent = `Imported from ${voice.communityLink}`;
        details.appendChild(linkLine);
      }
      const preview = createCastPreviewButton(() => voice.name || voice.id, () => voice.id);
      const editForm = document.createElement("form");
      editForm.className = "chat-voice-favorite-edit";
      editForm.hidden = true;
      const editLabel = document.createElement("label");
      editLabel.className = "chat-voice-hint";
      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.maxLength = 128;
      nameInput.setAttribute("aria-label", "Favorite voice name");
      const descriptionInput = document.createElement("textarea");
      descriptionInput.maxLength = 500;
      descriptionInput.setAttribute("aria-label", "Favorite voice description");
      const saveEdit = document.createElement("button");
      saveEdit.type = "submit";
      saveEdit.className = "chat-voice-preview-button";
      saveEdit.textContent = "Save";
      const cancelEdit = document.createElement("button");
      cancelEdit.type = "button";
      cancelEdit.className = "chat-voice-preview-button";
      cancelEdit.textContent = "Cancel";
      let editKind = "name";
      const openEdit = (kind) => {
        const current2 = favoriteVoices.find((item) => item.id === voice.id);
        if (!current2) return;
        for (const other of favoriteList.querySelectorAll(".chat-voice-favorite-edit")) other.hidden = true;
        editKind = kind;
        editingFavoriteVoiceId = voice.id;
        editLabel.textContent = kind === "name" ? "Voice name (leave blank to display the ID)" : "Voice description";
        nameInput.value = current2.name;
        descriptionInput.value = current2.description;
        nameInput.hidden = kind !== "name";
        descriptionInput.hidden = kind !== "description";
        editForm.hidden = false;
        const input = kind === "name" ? nameInput : descriptionInput;
        input.focus();
        input.select();
      };
      cancelEdit.addEventListener("click", () => {
        editForm.hidden = true;
        if (editingFavoriteVoiceId === voice.id) editingFavoriteVoiceId = null;
      });
      editForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const value = (editKind === "name" ? nameInput.value : descriptionInput.value).trim();
        saveEdit.disabled = true;
        void saveFavoriteVoices(favoriteVoices.map((item) => item.id === voice.id ? { ...item, [editKind]: value } : item)).then((saved) => {
          if (saved && editingFavoriteVoiceId === voice.id) editingFavoriteVoiceId = null;
          if (!saved) saveEdit.disabled = false;
        });
      });
      editForm.append(editLabel, nameInput, descriptionInput, saveEdit, cancelEdit);
      const rename = document.createElement("button");
      rename.type = "button";
      rename.className = "chat-voice-rename-button";
      rename.innerHTML = RENAME_ICON;
      rename.title = `Rename favorite ${voice.name || voice.id}`;
      rename.setAttribute("aria-label", rename.title);
      rename.addEventListener("click", () => openEdit("name"));
      const describe = document.createElement("button");
      describe.type = "button";
      describe.className = "chat-voice-preview-button";
      describe.textContent = "Description";
      describe.setAttribute("aria-label", `Edit description for ${voice.name || voice.id}`);
      describe.addEventListener("click", () => openEdit("description"));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "chat-voice-delete-button";
      remove.textContent = "\xD7";
      remove.setAttribute("aria-label", `Remove favorite ${voice.name || voice.id}`);
      remove.addEventListener("click", () => {
        void saveFavoriteVoices(favoriteVoices.filter((item) => item.id !== voice.id));
      });
      row.append(copy, preview, detailsToggle, rename, describe, remove, basics, details, editForm);
      favoriteList.appendChild(row);
    }
  }
  favoriteAdd.addEventListener("click", () => {
    const id = favoriteId.value.trim().slice(0, 512);
    const selectedTags = [...favoriteMetaPanel.querySelectorAll('.chat-voice-filter-chip[aria-pressed="true"]')].map((chip) => chip.dataset.tag ?? "").filter(Boolean);
    const gender = selectedTags.find((tag) => tag === "male" || tag === "female");
    const voice = {
      id,
      name: favoriteName.value.trim().slice(0, 128),
      category: gender ?? "unspecified",
      description: favoriteDescription.value.trim().slice(0, 500),
      ...gender ? { gender } : {},
      ...selectedTags.length ? { tags: selectedTags.slice(0, 32) } : {},
      ...favoriteLanguages.value ? { languages: [favoriteLanguages.value] } : {}
    };
    let next;
    try {
      next = addFavoriteVoice(favoriteVoices, voice);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not add favorite voice.";
      favoriteError.textContent = message;
      favoriteError.hidden = false;
      favoriteId.focus();
      return;
    }
    favoriteError.hidden = true;
    void saveFavoriteVoices(next, voice).then((saved) => {
      if (!saved) return;
      favoriteName.value = "";
      favoriteId.value = "";
      favoriteDescription.value = "";
      favoriteLanguages.value = "";
      for (const chip of favoriteMetaPanel.querySelectorAll(".chat-voice-filter-chip")) {
        chip.setAttribute("aria-pressed", "false");
        chip.textContent = chip.textContent.replace(/^✓ /, "+ ");
      }
    });
  });
  communityBestButton.addEventListener("click", () => void showCommunityBest());
  communityTabButton.addEventListener("click", () => {
    voicesTab = "community";
    updateVoicesTabs();
    renderCommunityBrowse();
    void showCommunityBest();
  });
  favoriteTabButton.addEventListener("click", () => {
    voicesTab = "favorite";
    updateVoicesTabs();
  });
  function readCommunityFilterText(value) {
    return value.split(",").map((item) => item.trim()).filter(Boolean).slice(0, 8);
  }
  communitySearchButton.addEventListener("click", () => {
    communityBest = false;
    communitySearchTitle = communitySearch.value.trim().slice(0, 128);
    communitySearchTags = readCommunityFilterText(communityTags.value);
    for (const chip of communityFilterPanel.querySelectorAll('.chat-voice-filter-chip[aria-pressed="true"]')) {
      const tag = chip.dataset.tag ?? "";
      if (tag && !communitySearchTags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) communitySearchTags.push(tag);
    }
    communitySearchLanguage = communityLanguage.value ? [communityLanguage.value] : [];
    communitySortBy = communitySort.value === "task_count" || communitySort.value === "created_at" ? communitySort.value : "score";
    void runCommunitySearch(1);
  });
  communitySearch.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      communitySearchButton.click();
    }
  });
  communityPrev.addEventListener("click", () => void runCommunitySearch(Math.max(1, communityPage - 1)));
  communityNext.addEventListener("click", () => void runCommunitySearch(communityPage + 1));
  communityKeySave.addEventListener("click", () => {
    const key = communityKeyInput.value.trim().slice(0, 512);
    if (!key) {
      setStatus("Enter your Fish Audio API key first.", "error");
      return;
    }
    communityKeySave.disabled = true;
    updateVoiceSettings((current) => ({ ...current, chatVoiceFishApiKey: key })).then(() => {
      fishApiKey = key;
      communityKeyInput.value = "";
      setStatus("Fish Audio API key saved globally.", "saved");
      updateVoicesTabs();
      maybeAutoSeedSnapshot();
    }).catch((error) => setStatus(error instanceof Error ? error.message : "Could not save the Fish Audio API key.", "error")).finally(() => {
      communityKeySave.disabled = false;
    });
  });
  autoVoicePoolSelect.addEventListener("change", () => {
    autoVoiceCastingPool = autoVoicePoolSelect.value === "community" ? "community" : "favorite";
    scheduleAdvancedSettingsSave();
    if (autoVoiceCastingPool === "community") maybeAutoSeedSnapshot();
  });
  snapshotLanguageSelect.addEventListener("change", () => {
    communityVoiceLanguage = snapshotLanguageSelect.value;
    void updateVoiceSettings((current) => ({ ...current, chatVoiceCommunityVoiceLanguage: communityVoiceLanguage })).then(() => {
      setStatus("Community snapshot language saved.", "saved");
      if (fishApiKey) void refreshCommunitySnapshot();
    }).catch((error) => setStatus(error instanceof Error ? error.message : "Could not save the snapshot language.", "error"));
  });
  autoVoicePoolRefresh.addEventListener("click", () => void refreshCommunitySnapshot());
  function communityIsAvailable() {
    return ttsTagStyle === "fish";
  }
  function updateVoicesTabs() {
    const fish = communityIsAvailable();
    voicesTabStrip.hidden = !fish;
    favoritesTitle.textContent = fish ? "Voice library" : "Favorite voices";
    if (!fish) {
      if (voicesTab === "community") voicesTab = "favorite";
      favoritesSection.hidden = false;
      communitySection.hidden = true;
    } else {
      favoritesSection.hidden = voicesTab !== "favorite";
      communitySection.hidden = voicesTab !== "community";
    }
    communityTabButton.setAttribute("aria-selected", String(voicesTab === "community"));
    favoriteTabButton.setAttribute("aria-selected", String(voicesTab === "favorite"));
    communityKeyRow.hidden = !fish || !!fishApiKey;
    updatePoolControls();
    if (fish) {
      maybeAutoSeedSnapshot();
      renderCommunityBrowse();
    }
  }
  function updatePoolControls() {
    const fish = communityIsAvailable();
    autoVoicePoolField.field.hidden = !fish;
    snapshotLanguageRow.hidden = !fish;
    autoVoicePoolActions.hidden = !fish;
    autoVoicePoolSelect.disabled = !autoCastingToggle.checked || !fish;
    snapshotLanguageSelect.disabled = !fish || !fishApiKey;
    autoVoicePoolRefresh.disabled = !fish || !fishApiKey || communityLoading;
    refreshPoolStatus();
  }
  function communitySnapshotStale() {
    if (!communityVoices.length) return true;
    if (!communityVoicesAt) return true;
    const at = Date.parse(communityVoicesAt);
    return !Number.isFinite(at) || Date.now() - at > 24 * 60 * 60 * 1e3;
  }
  function refreshPoolStatus() {
    if (!communityVoices.length) {
      communityPoolStatus.textContent = "Pool snapshot is empty. Refresh it, or browse the Community tab to import voices into favorites.";
      return;
    }
    const at = communityVoicesAt ? new Date(communityVoicesAt).toLocaleString() : "unknown time";
    communityPoolStatus.textContent = `Pool snapshot: ${communityVoices.length} voices refreshed at ${at}.`;
  }
  function poolVoicesForAutoCast() {
    if (autoVoiceCastingPool === "community" && communityIsAvailable()) {
      if (communityVoices.length) return communityVoices;
      if (speakerAssignmentDebug) appendSpeakerDebugLog("Voice pool: community pool is empty or snapshot unavailable; favorites are used instead.");
    }
    return favoriteVoices;
  }
  async function refreshCommunitySnapshot() {
    if (!fishApiKey) {
      communityPoolStatus.textContent = "Add your Fish Audio API key in the Community tab to refresh the pool.";
      setStatus("Add your Fish Audio API key before refreshing the community voice pool.", "error");
      return;
    }
    if (communityLoading) return;
    communityLoading = true;
    autoVoicePoolRefresh.disabled = true;
    communityPoolStatus.textContent = "Refreshing snapshot\u2026";
    setStatus("Refreshing the community voice pool snapshot\u2026");
    try {
      const { items, voices, refreshedAt } = await requestCommunitySnapshotRefresh();
      if (!voices.length) throw new Error("Fish Audio returned no community voices.");
      communityVoices = voices;
      communityBestItems = items;
      communityVoicesAt = refreshedAt;
      await updateVoiceSettings((current) => ({
        ...current,
        chatVoiceCommunityVoicePool: voices,
        chatVoiceCommunityVoicePoolAt: refreshedAt
      }));
      setStatus("Community voice pool refreshed.", "saved");
      if (communityBest) showSnapshotListing();
    } catch (error) {
      communityPoolStatus.textContent = error instanceof Error ? error.message : "Community pool refresh failed.";
      setStatus(error instanceof Error ? error.message : "Community pool refresh failed.", "error");
    } finally {
      communityLoading = false;
      updatePoolControls();
    }
  }
  function showSnapshotListing() {
    communityBest = communityBestItems.length > 0;
    if (!communityBest) return;
    communityPage = 1;
    communityItems = communityBestItems;
    communityTotal = communityBestItems.length;
    communityHasMore = false;
    renderCommunityBrowse();
  }
  async function showCommunityBest() {
    if (!communityIsAvailable()) return;
    if (!fishApiKey) {
      communityError.textContent = "Add your Fish Audio API key first to load the community snapshot.";
      communityError.hidden = false;
      return;
    }
    if (communityBestItems.length && !communitySnapshotStale()) {
      communityBest = true;
      showSnapshotListing();
      return;
    }
    communityBest = true;
    renderCommunityBrowse();
    await refreshCommunitySnapshot();
    showSnapshotListing();
  }
  function maybeAutoSeedSnapshot() {
    if (communityAutoSeeded || communityLoading || !fishApiKey) return;
    if (!communitySnapshotStale()) {
      communityAutoSeeded = true;
      return;
    }
    communityAutoSeeded = true;
    void refreshCommunitySnapshot();
  }
  function renderCommunityBrowse() {
    communityList.replaceChildren();
    const empty = (text) => {
      const line = document.createElement("div");
      line.className = "chat-voice-hint";
      line.textContent = text;
      communityList.appendChild(line);
    };
    if (communityLoading) {
      empty("Searching Fish community voices\u2026");
    } else if (!fishApiKey) {
      empty("Add your Fish Audio API key above to browse community voices. It is stored only in your global voice settings.");
    } else if (!communityItems.length) {
      empty(communityBest ? "The community snapshot is empty. Refresh it, or search instead." : "No community voices match this search.");
    } else {
      for (const voice of communityItems) {
        const row = document.createElement("div");
        row.className = "chat-voice-community-row";
        const copy = document.createElement("span");
        copy.className = "chat-voice-community-copy";
        copy.textContent = voice.title || voice.id;
        copy.title = voice.id;
        if (voice.author) {
          const author = document.createElement("small");
          author.textContent = `by ${voice.author}`;
          copy.appendChild(author);
        }
        if (voice.description) {
          const description = document.createElement("small");
          description.textContent = voice.description;
          copy.appendChild(description);
        }
        const stats = document.createElement("span");
        stats.className = "chat-voice-community-stats";
        stats.textContent = `${voice.likeCount.toLocaleString()} likes \xB7 ${voice.taskCount.toLocaleString()} plays${voice.licensedNote ? " \xB7 " + voice.licensedNote : ""}${voice.tags.length ? ` \xB7 ${voice.tags.join(", ")}` : ""}`;
        const preview = createCastPreviewButton(() => voice.title || voice.id, () => voice.id);
        const alreadyFavorited = favoriteVoices.some((item) => item.id === voice.id);
        const importButton = document.createElement("button");
        importButton.type = "button";
        importButton.className = "chat-voice-add-button";
        importButton.textContent = alreadyFavorited ? "Favorited" : "Import";
        importButton.disabled = alreadyFavorited;
        importButton.addEventListener("click", () => importCommunityVoice(voice));
        row.append(copy, stats, preview, importButton);
        communityList.appendChild(row);
      }
    }
    communityPageLabel.textContent = communityBest && communityItems.length ? `Community Best \xB7 ${communityItems.length} voices` : communityItems.length ? `Page ${communityPage}${communityTotal > 0 ? ` of ${Math.max(1, Math.ceil(communityTotal / 20))}` : ""}` : "";
    communityPrev.disabled = communityBest || communityPage <= 1 || communityLoading || !fishApiKey;
    communityNext.disabled = communityBest || !communityHasMore || communityLoading || !fishApiKey;
    communitySearchButton.disabled = communityLoading || !fishApiKey;
  }
  async function runCommunitySearch(page) {
    if (!fishApiKey) return;
    communityPage = page;
    communityLoading = true;
    communityError.hidden = true;
    renderCommunityBrowse();
    try {
      const { items, total, hasMore } = await requestCommunitySearch({
        title: communitySearchTitle,
        tags: communitySearchTags,
        language: communitySearchLanguage,
        sortBy: communitySortBy,
        pageNumber: page,
        pageSize: 20
      });
      communityItems = items;
      communityTotal = total;
      communityHasMore = hasMore;
    } catch (error) {
      communityItems = [];
      communityError.textContent = error instanceof Error ? error.message : "Community voice search failed.";
      communityError.hidden = false;
    } finally {
      communityLoading = false;
      renderCommunityBrowse();
    }
  }
  function importCommunityVoice(voice) {
    try {
      const favorite = communityVoiceToFavorite(voice);
      const next = upsertCommunityFavorite(favoriteVoices, voice);
      favoriteError.hidden = true;
      void saveFavoriteVoices(next).then((saved) => {
        if (saved) renderCommunityBrowse();
      }).catch(() => void 0);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "That community voice could not be imported.", "error");
    }
  }
  function removeExpiredGhostCards() {
    if (!activeChat) return;
    const ids = activeChat.assistantMessageIds ?? [];
    const active = new Set(activeGhostVoices(activeChat.ghosts ?? [], ids, ids.at(-1) ?? "", ghostVoiceLifetime).map((ghost) => ghost.id));
    for (const card of characterList.querySelectorAll("[data-ghost-id]")) {
      const id = card.dataset.ghostId;
      if (active.has(id)) continue;
      ghostVoiceEditors.get(id)?.input.destroy();
      ghostVoiceEditors.delete(id);
      const picker = card.querySelector("select");
      if (picker) favoritePickers.delete(picker);
      if (editingCharacterVoiceId === `ghost:${id}`) editingCharacterVoiceId = null;
      card.remove();
    }
  }
  function renderCharacters(characters) {
    for (const input of characterInputs.values()) input.destroy();
    for (const { input } of ghostVoiceEditors.values()) input.destroy();
    ghostVoiceEditors.clear();
    characterInputs.clear();
    characterVoiceDisplays.clear();
    favoritePickers.clear();
    favoritePickers.add(narratorFavoritePicker);
    favoritePickers.add(userFavoritePicker);
    characterList.replaceChildren();
    const ghosts = activeChat ? activeGhostVoices(activeChat.ghosts ?? [], activeChat.assistantMessageIds ?? [], activeChat.assistantMessageIds?.at(-1) ?? "", ghostVoiceLifetime) : [];
    if (characters.length === 0 && ghosts.length === 0) {
      const empty = document.createElement("div");
      empty.className = "chat-voice-empty";
      empty.textContent = "No saved characters yet. Click Scan to read the active character card.";
      characterList.appendChild(empty);
      updateFavoritePickers();
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
      const title = document.createElement("span");
      title.className = "chat-voice-character-title";
      const castPreview = createCastPreviewButton(() => name.textContent || character.name, () => input.getValue());
      title.append(castPreview, name);
      const count = document.createElement("span");
      count.className = "chat-voice-character-count";
      count.textContent = character.messageCount > 0 ? `${character.messageCount} occurrence${character.messageCount === 1 ? "" : "s"}` : "Card cast";
      const meta = document.createElement("span");
      meta.className = "chat-voice-character-meta";
      meta.append(count);
      const renameForm = document.createElement("form");
      renameForm.hidden = true;
      const renameLabel = document.createElement("label");
      renameLabel.textContent = "Name and aliases (separate with /)";
      renameLabel.className = "chat-voice-hint";
      const renameInput = document.createElement("input");
      renameInput.className = "chat-voice-rename-input";
      renameInput.type = "text";
      renameInput.maxLength = 4096;
      renameInput.setAttribute("aria-label", "Character name and aliases");
      const saveRename = document.createElement("button");
      saveRename.type = "submit";
      saveRename.className = "chat-voice-preview-button";
      saveRename.textContent = "Save";
      const cancelRename = document.createElement("button");
      cancelRename.type = "button";
      cancelRename.className = "chat-voice-preview-button";
      cancelRename.textContent = "Cancel";
      renameForm.append(renameLabel, renameInput, saveRename, cancelRename);
      {
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
          const current = activeChat?.characters.find((item) => item.id === character.id);
          if (!current) return;
          renameInput.value = current.name;
          renameForm.hidden = false;
          editingCharacterVoiceId = `rename:${character.id}`;
          renameInput.focus();
          renameInput.select();
        });
        cancelRename.addEventListener("click", () => {
          renameForm.hidden = true;
          if (editingCharacterVoiceId === `rename:${character.id}`) editingCharacterVoiceId = null;
        });
        renameForm.addEventListener("submit", (event) => {
          event.preventDefault();
          const renamed = renameCharacter(character.id, renameInput.value);
          if (!renamed) return;
          renameForm.hidden = true;
          if (editingCharacterVoiceId === `rename:${character.id}`) editingCharacterVoiceId = null;
          name.textContent = renamed;
          castPreview.title = `Preview voice for ${renamed}`;
          castPreview.setAttribute("aria-label", castPreview.title);
          rename.title = `Rename ${renamed} or edit aliases`;
          rename.setAttribute("aria-label", rename.title);
          remove.title = `Delete ${renamed}`;
          remove.setAttribute("aria-label", remove.title);
          input.update({
            placeholder: `Voice name or ID for ${renamed}`,
            ariaLabel: `Custom voice for ${renamed}`
          });
        });
        remove.addEventListener("click", () => removeCharacter(character.id));
        meta.append(rename, remove);
      }
      const slot = document.createElement("div");
      slot.hidden = true;
      const voiceDisplay = document.createElement("button");
      voiceDisplay.type = "button";
      voiceDisplay.className = "chat-voice-selected-voice";
      voiceDisplay.setAttribute("aria-label", `Selected voice for ${character.name}; press Enter to edit voice ID`);
      const picker = document.createElement("select");
      picker.className = "chat-voice-favorite-select";
      picker.setAttribute("aria-label", `Favorite voice for ${character.name}`);
      heading.append(title, meta);
      card.append(heading, renameForm, voiceDisplay, slot, picker);
      characterList.appendChild(card);
      const input = ctx.components.mountTextInput(slot, {
        value: character.voice,
        placeholder: `Voice name or ID for ${character.name}`,
        ariaLabel: `Custom voice for ${character.name}`,
        disabled: !activeChat,
        onChange: () => {
          updateCharacterVoiceDisplays();
          markChanged();
        }
      });
      characterInputs.set(character.id, input);
      characterVoiceDisplays.set(character.id, voiceDisplay);
      const beginEditing = () => {
        if (!activeChat) return;
        editingCharacterVoiceId = character.id;
        voiceDisplay.hidden = true;
        slot.hidden = false;
        input.focus();
      };
      const endEditing = () => {
        if (editingCharacterVoiceId === character.id) editingCharacterVoiceId = null;
        slot.hidden = true;
        voiceDisplay.hidden = false;
        updateCharacterVoiceDisplays();
      };
      voiceDisplay.addEventListener("click", beginEditing);
      voiceDisplay.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          beginEditing();
        }
      });
      slot.addEventListener("focusout", (event) => {
        if (event.relatedTarget && slot.contains(event.relatedTarget)) return;
        endEditing();
      });
      slot.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          input.blur();
          endEditing();
          voiceDisplay.focus();
        }
      });
      picker.addEventListener("change", () => {
        if (!picker.value) return;
        input.update({ value: picker.value });
        picker.value = "";
        updateCharacterVoiceDisplays();
        markChanged();
      });
      favoritePickers.add(picker);
    }
    for (const ghost of ghosts) {
      const card = document.createElement("div");
      card.className = "chat-voice-character chat-voice-character-temporary";
      card.dataset.ghostId = ghost.id;
      const heading = document.createElement("div");
      heading.className = "chat-voice-character-heading";
      const name = document.createElement("button");
      name.type = "button";
      name.className = "chat-voice-character-name";
      name.style.background = "transparent";
      name.style.border = "0";
      name.style.color = "inherit";
      name.textContent = ghost.label || (ghost.speakerId.startsWith("unconfigured:") ? ghost.speakerId.slice(13) : `Unnamed character \xB7 ${ghost.id.replace(/^ghost-/u, "")}`);
      const title = document.createElement("span");
      title.className = "chat-voice-character-title";
      const castPreview = createCastPreviewButton(() => name.textContent || "temporary character", () => input.getValue());
      title.append(castPreview, name);
      name.title = "Double-click to add to the regular cast";
      name.addEventListener("dblclick", () => {
        if (!activeChat) return;
        flushSave();
        ctx.sendToBackend({ type: "chat_voice_ghost_edit", chatId: activeChat.id, ghostId: ghost.id, promote: true });
      });
      const badge = document.createElement("span");
      badge.className = "chat-voice-character-count";
      badge.textContent = "Temporary cast";
      const meta = document.createElement("span");
      meta.className = "chat-voice-character-meta";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "chat-voice-delete-button";
      remove.textContent = "\xD7";
      remove.title = `Delete ${name.textContent}`;
      remove.setAttribute("aria-label", remove.title);
      remove.addEventListener("click", () => {
        if (!activeChat) return;
        flushSave();
        ctx.sendToBackend({ type: "chat_voice_ghost_edit", chatId: activeChat.id, ghostId: ghost.id, remove: true });
      });
      meta.append(badge, remove);
      heading.append(title, meta);
      const slot = document.createElement("div");
      slot.hidden = true;
      const voiceDisplay = document.createElement("button");
      voiceDisplay.type = "button";
      voiceDisplay.className = "chat-voice-selected-voice";
      voiceDisplay.setAttribute("aria-label", `Selected voice for ${name.textContent}; press Enter to edit voice ID`);
      const picker = document.createElement("select");
      picker.className = "chat-voice-favorite-select";
      picker.setAttribute("aria-label", `Favorite voice for ${name.textContent}`);
      card.append(heading, voiceDisplay, slot, picker);
      characterList.appendChild(card);
      const input = ctx.components.mountTextInput(slot, {
        value: ghost.voiceId,
        placeholder: `Voice name or ID for ${name.textContent}`,
        ariaLabel: `Custom voice for ${name.textContent}`,
        disabled: !activeChat,
        onChange: () => updateCharacterVoiceDisplays()
      });
      ghostVoiceEditors.set(ghost.id, { input, display: voiceDisplay });
      const editorId = `ghost:${ghost.id}`;
      const chatId = activeChat?.id;
      const beginEditing = () => {
        if (!activeChat || activeChat.id !== chatId) return;
        editingCharacterVoiceId = editorId;
        voiceDisplay.hidden = true;
        slot.hidden = false;
        input.focus();
      };
      const endEditing = () => {
        if (editingCharacterVoiceId !== editorId) return;
        editingCharacterVoiceId = null;
        slot.hidden = true;
        voiceDisplay.hidden = false;
        const voice = input.getValue().trim();
        if (voice && voice !== ghost.voiceId && activeChat?.id === chatId) {
          ctx.sendToBackend({ type: "chat_voice_ghost_edit", chatId, ghostId: ghost.id, voice });
        } else if (!voice) input.update({ value: ghost.voiceId });
        updateCharacterVoiceDisplays();
      };
      voiceDisplay.addEventListener("click", beginEditing);
      voiceDisplay.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          beginEditing();
        }
      });
      slot.addEventListener("focusout", (event) => {
        if (event.relatedTarget && slot.contains(event.relatedTarget)) return;
        endEditing();
      });
      slot.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          input.blur();
          endEditing();
          voiceDisplay.focus();
        }
      });
      picker.addEventListener("change", () => {
        if (!picker.value || activeChat?.id !== chatId) return;
        input.update({ value: picker.value });
        updateCharacterVoiceDisplays();
        ctx.sendToBackend({ type: "chat_voice_ghost_edit", chatId, ghostId: ghost.id, voice: picker.value });
        picker.value = "";
      });
      favoritePickers.add(picker);
    }
    updateFavoritePickers();
  }
  function renderState(next) {
    applyingState = true;
    const keepVoiceEditor = !!editingCharacterVoiceId && !!next && activeChat?.id === next.id;
    const keepRoleEditor = !!editingRoleVoice && !!next && activeChat?.id === next.id;
    if (!keepVoiceEditor) editingCharacterVoiceId = null;
    if (!keepRoleEditor) {
      editingRoleVoice = null;
      narratorEditSlot.hidden = true;
      userEditSlot.hidden = true;
      narratorVoiceDisplay.hidden = false;
      userVoiceDisplay.hidden = false;
    }
    activeChat = next;
    context.textContent = next ? `Active chat: ${next.name}` : "Open a chat to configure its voices.";
    const selectedConnectionId = lumiverseConnectionId;
    connectionPicker.update({
      value: selectedConnectionId,
      options: connectionOptions(selectedConnectionId),
      placeholder: connections.length ? "Choose a TTS connection" : "No TTS connections found",
      disabled: connections.length === 0
    });
    scanButton.disabled = !next || scanning;
    if (!keepRoleEditor || editingRoleVoice !== "narrator") localNarratorVoice = next?.narratorVoice ?? "";
    if (!keepRoleEditor || editingRoleVoice !== "user") localUserVoice = next?.userVoice ?? "";
    useGlobalNarratorVoice = next?.useGlobalNarratorVoice ?? true;
    useGlobalUserVoice = next?.useGlobalUserVoice ?? true;
    if (!keepRoleEditor || editingRoleVoice !== "narrator") narratorInput.update({
      value: next ? useGlobalNarratorVoice ? defaultNarratorVoice : localNarratorVoice : "",
      disabled: !next
    });
    if (!keepRoleEditor || editingRoleVoice !== "user") userVoiceInput.update({
      value: next ? useGlobalUserVoice ? defaultUserVoice : localUserVoice : "",
      disabled: !next
    });
    addNpcInput.update({ value: "", disabled: !next });
    addNpcButton.disabled = !next;
    if (!keepVoiceEditor) renderCharacters(next?.characters ?? []);
    else removeExpiredGhostCards();
    updateRoleVoiceDisplays();
    updateRoleDefaultControls();
    applyingState = false;
    if (next && !next.castScanned && !scanning) scanMessages();
    if (!next) setStatus("Open a chat to edit its voices.");
    else if (connections.length === 0) setStatus("Create a TTS connection in Lumiverse first.");
    else setStatus("All changes save automatically.", "saved");
  }
  async function loadConnections() {
    const connectionVersionAtLoad = globalConnectionVersion;
    try {
      const [loadedConnections, loadedLlmConnections, preferences] = await Promise.all([
        listAllTtsConnections(),
        requestLlmConnections().catch((error) => {
          console.warn("[Chat Voice] Could not load Lumiverse LLM connections.", error);
          return [];
        }),
        loadPlaybackPreferences(),
        refreshDecisionStatus()
      ]);
      connections = loadedConnections;
      llmConnections = loadedLlmConnections;
      if (!favoritesSaving && !editingFavoriteVoiceId) {
        favoriteVoices = preferences.favoriteVoices;
        renderFavoriteVoices();
        updateFavoritePickers();
      }
      updateTtsTagControls();
      if (!narratorGlobalSaveTimer && !savingNarratorGlobalVoice) {
        defaultNarratorVoice = preferences.defaultNarratorVoice;
      }
      if (!userGlobalSaveTimer && !savingUserGlobalVoice) {
        defaultUserVoice = preferences.defaultUserVoice;
      }
      if (activeChat) {
        if (editingRoleVoice !== "narrator") narratorInput.update({
          value: useGlobalNarratorVoice ? defaultNarratorVoice : localNarratorVoice,
          disabled: false
        });
        if (editingRoleVoice !== "user") userVoiceInput.update({
          value: useGlobalUserVoice ? defaultUserVoice : localUserVoice,
          disabled: false
        });
      }
      updateRoleVoiceDisplays();
      updateRoleDefaultControls();
      if (!savingAudioPreference) {
        saveGeneratedAudio = preferences.saveGeneratedAudio;
        saveAudioToggle.checked = saveGeneratedAudio;
      }
      if (!savingAudioLimit) {
        savedAudioLimit = preferences.savedAudioLimit;
        saveAudioLimitInput.value = String(savedAudioLimit);
      }
      if (!savingSkippedTrackerTags && !skippedTrackerTagsDirty) {
        skippedTrackerTags = preferences.skippedTrackerTags;
        skippedTrackerTagsInput.update({ value: skippedTrackerTags });
      }
      if (!savingLlmSettings && !llmSettingsSaveTimer) {
        speakerParsingMode = preferences.speakerParsingMode;
        ttsTagStyle = preferences.ttsTagStyle;
        ttsTagPlacement = preferences.ttsTagPlacement;
        tagLlmConnectionId = preferences.tagLlmConnectionId;
        tagLlmModel = preferences.tagLlmModel;
        speakerParsingPicker.update({ value: speakerParsingMode });
        ttsTagPicker.update({ value: ttsTagStyle });
        updateTtsTagControls();
      }
      if (!savingLlmSettings && !llmSettingsSaveTimer && !decisionStatusFailed && decisionConnectionsKnown && !decisionConnectionAvailable && speakerParsingMode !== "off") {
        speakerParsingMode = "off";
        speakerParsingPicker.update({ value: "off" });
        try {
          await saveLlmParsingPreferences("off");
        } catch (error) {
          console.warn("[Chat Voice] Could not persist the Jev safeguard.", error);
        }
      }
      if (!savingAdvancedSettings && !advancedSettingsSaveTimer) {
        playbackBufferSegments = preferences.playbackBufferSegments;
        concurrentGenerationLimit = preferences.concurrentGenerations;
        rateLimitWaitSeconds = preferences.rateLimitWaitSeconds;
        ghostVoiceLifetime = preferences.ghostVoiceLifetime;
        speakerLookback = preferences.speakerLookback;
        ghostLifetimeLoaded = true;
        refreshLocalState();
        autoVoiceCasting = preferences.autoVoiceCasting;
        autoCastingToggle.checked = autoVoiceCasting;
        autoVoiceCastingPool = preferences.autoVoiceCastingPool;
        autoVoicePoolSelect.value = autoVoiceCastingPool;
        fishApiKey = preferences.fishApiKey;
        communityVoiceLanguage = preferences.communityVoiceLanguage;
        snapshotLanguageSelect.value = communityVoiceLanguage === "en" || communityVoiceLanguage === "es" || communityVoiceLanguage === "ar" || communityVoiceLanguage === "ru" || communityVoiceLanguage === "ja" || communityVoiceLanguage === "pt" || communityVoiceLanguage === "zh" || communityVoiceLanguage === "fr" || communityVoiceLanguage === "it" ? communityVoiceLanguage : "";
        communityVoices = preferences.communityVoicePool;
        communityVoicesAt = preferences.communityVoicePoolAt;
        refreshPoolStatus();
        if (autoPlayback !== preferences.autoPlayback) {
          autoPlaybackEpoch += 1;
          autoPlaybackRequests.cancelAll();
          if (!preferences.autoPlayback) playbackStartup.cancelAutomatic();
        }
        autoPlayback = preferences.autoPlayback;
        autoPlaybackToggle.checked = autoPlayback;
        autoPlaybackDelaySeconds = preferences.autoPlaybackDelaySeconds;
        autoPlaybackDelayInput.value = String(autoPlaybackDelaySeconds);
        updatePlaybackButtons();
        speakerAssignmentDebug = preferences.speakerAssignmentDebug;
        playbackBufferInput.value = String(playbackBufferSegments);
        concurrentGenerationInput.value = String(concurrentGenerationLimit);
        rateLimitWaitInput.value = String(rateLimitWaitSeconds);
        ghostLifetimeInput.value = String(ghostVoiceLifetime);
        speakerLookbackInput.value = String(speakerLookback);
        speakerDebugToggle.checked = speakerAssignmentDebug;
        skipNarration = preferences.skipNarration;
        skipNarrationToggle.checked = skipNarration;
        speakerDebugOutput.hidden = !speakerAssignmentDebug;
      }
      if (!savingGlobalConnection && connectionVersionAtLoad === globalConnectionVersion) lumiverseConnectionId = resolveGlobalTtsConnection(preferences.connectionId, connections);
      const selectedConnectionId = lumiverseConnectionId;
      connectionPicker.update({
        value: selectedConnectionId,
        options: connectionOptions(selectedConnectionId),
        placeholder: connections.length ? "Choose a TTS connection" : "No TTS connections found",
        disabled: connections.length === 0
      });
      if (connections.length === 0) setStatus("Create a TTS connection in Lumiverse first.");
      else if (decisionStatusFailed) {
        setStatus("Could not verify Decision connections. Jev speaker assignment is unavailable.", "error");
      } else if (decisionConnectionsKnown && !decisionConnectionAvailable) {
        setStatus("Create a Decision model connection in Lumiverse to enable Jev speaker assignment.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not load TTS connections.";
      connectionPicker.update({ placeholder: "Connections unavailable", disabled: true });
      setStatus(message, "error");
    }
  }
  function scheduleLlmSettingsSave() {
    if (llmSettingsSaveTimer) clearTimeout(llmSettingsSaveTimer);
    llmSettingsSaveTimer = setTimeout(() => {
      llmSettingsSaveTimer = null;
      void persistLlmSettings();
    }, 400);
  }
  function onSpeakerParsingModeChanged(value) {
    void applySpeakerParsingMode(value === "ambiguous" ? "ambiguous" : "off");
  }
  async function applySpeakerParsingMode(next) {
    if (next === "ambiguous") {
      const status2 = await refreshDecisionStatus();
      if (!status2?.available || !status2.hasConnection) {
        speakerParsingPicker.update({ value: speakerParsingMode });
        setStatus(
          status2 ? "Create a Decision model connection in Lumiverse before turning on Jev speaker assignment." : "Could not verify a Decision model connection. Jev speaker assignment stays off.",
          "error"
        );
        return;
      }
    }
    speakerParsingMode = next;
    speakerParsingPicker.update({ value: next });
    scheduleLlmSettingsSave();
  }
  async function persistLlmSettings() {
    savingLlmSettings = true;
    let forcedOff = false;
    try {
      if (speakerParsingMode === "ambiguous") {
        const status2 = await refreshDecisionStatus();
        if (!status2?.available || !status2.hasConnection) {
          speakerParsingMode = "off";
          speakerParsingPicker.update({ value: "off" });
          forcedOff = true;
        }
      }
      setStatus("Saving global speaker and tag settings\u2026");
      await saveLlmParsingPreferences(speakerParsingMode);
      await saveTtsTagPreferences(ttsTagStyle, ttsTagPlacement, tagLlmConnectionId, tagLlmModel);
      setStatus(
        forcedOff ? "Jev speaker assignment was turned off because no Decision model connection is configured." : "Speaker and tag settings saved globally.",
        forcedOff ? "error" : "saved"
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save speaker and tag settings.", "error");
    } finally {
      savingLlmSettings = false;
    }
  }
  function scheduleAdvancedSettingsSave() {
    if (advancedSettingsSaveTimer) clearTimeout(advancedSettingsSaveTimer);
    advancedSettingsSaveTimer = setTimeout(() => {
      advancedSettingsSaveTimer = null;
      void persistAdvancedSettings();
    }, 400);
  }
  function onPlaybackBufferChanged(value) {
    playbackBufferSegments = clampIntegerSetting(
      value,
      DEFAULT_PLAYBACK_BUFFER_SEGMENTS,
      MAX_PLAYBACK_BUFFER_SEGMENTS
    );
    playbackBufferInput.value = String(playbackBufferSegments);
    scheduleAdvancedSettingsSave();
  }
  function onConcurrentGenerationsChanged(value) {
    concurrentGenerationLimit = clampIntegerSetting(
      value,
      DEFAULT_CONCURRENT_GENERATIONS,
      MAX_CONCURRENT_GENERATIONS
    );
    concurrentGenerationInput.value = String(concurrentGenerationLimit);
    drainSynthesisQueue();
    scheduleAdvancedSettingsSave();
  }
  function onRateLimitWaitChanged(value) {
    rateLimitWaitSeconds = clampIntegerSetting(
      value,
      DEFAULT_RATE_LIMIT_WAIT_SECONDS,
      MAX_RATE_LIMIT_WAIT_SECONDS
    );
    rateLimitWaitInput.value = String(rateLimitWaitSeconds);
    scheduleAdvancedSettingsSave();
  }
  function onSpeakerDebugChanged() {
    speakerAssignmentDebug = speakerDebugToggle.checked;
    speakerDebugOutput.hidden = !speakerAssignmentDebug;
    scheduleAdvancedSettingsSave();
  }
  function onSkipNarrationChanged() {
    skipNarration = skipNarrationToggle.checked;
    scheduleAdvancedSettingsSave();
  }
  function onAutoPlaybackChanged() {
    autoPlayback = autoPlaybackToggle.checked;
    if (!autoPlayback) playbackStartup.cancelAutomatic();
    autoPlaybackRequests.cancelAll();
    autoPlaybackEpoch += 1;
    updatePlaybackButtons();
    scheduleAdvancedSettingsSave();
  }
  async function persistAdvancedSettings() {
    savingAdvancedSettings = true;
    setStatus("Saving global advanced playback settings\u2026");
    try {
      await saveAdvancedPlaybackPreferences(
        playbackBufferSegments,
        concurrentGenerationLimit,
        rateLimitWaitSeconds,
        speakerAssignmentDebug,
        ghostVoiceLifetime,
        autoVoiceCasting,
        autoPlayback,
        autoPlaybackDelaySeconds,
        speakerLookback,
        skipNarration,
        autoVoiceCastingPool
      );
      setStatus("Advanced playback settings saved globally.", "saved");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save advanced playback settings.", "error");
    } finally {
      savingAdvancedSettings = false;
    }
  }
  const onSaveAudioChanged = async () => {
    const previous = saveGeneratedAudio;
    const enabled = saveAudioToggle.checked;
    saveGeneratedAudio = enabled;
    savingAudioPreference = true;
    saveAudioToggle.disabled = true;
    setStatus("Saving global audio preference\u2026");
    try {
      await saveGeneratedAudioPreference(enabled);
      setStatus(
        enabled ? "Generated audio will be saved globally." : "Generated audio saving is disabled globally.",
        "saved"
      );
    } catch (error) {
      saveGeneratedAudio = previous;
      saveAudioToggle.checked = previous;
      setStatus(error instanceof Error ? error.message : "Could not save the audio preference.", "error");
    } finally {
      savingAudioPreference = false;
      saveAudioToggle.disabled = false;
    }
  };
  const onSaveAudioLimitChanged = async () => {
    const previous = savedAudioLimit;
    const limit = clampSavedAudioLimit(saveAudioLimitInput.value);
    savedAudioLimit = limit;
    saveAudioLimitInput.value = String(limit);
    savingAudioLimit = true;
    saveAudioLimitInput.disabled = true;
    setStatus("Saving global recording limit\u2026");
    try {
      await saveGeneratedAudioLimit(limit);
    } catch (error) {
      savedAudioLimit = previous;
      saveAudioLimitInput.value = String(previous);
      setStatus(error instanceof Error ? error.message : "Could not update the recording limit.", "error");
      savingAudioLimit = false;
      saveAudioLimitInput.disabled = false;
      return;
    }
    try {
      const deleted = await enforceSavedAudioRetention();
      setStatus(
        deleted > 0 ? `Saved recording limit updated; removed ${deleted} old recording${deleted === 1 ? "" : "s"}.` : "Saved recording limit updated.",
        "saved"
      );
    } catch (error) {
      setStatus(
        `Recording limit saved, but cleanup failed: ${error instanceof Error ? error.message : "Unknown error."}`,
        "error"
      );
    } finally {
      savingAudioLimit = false;
      saveAudioLimitInput.disabled = false;
    }
  };
  function scheduleSkippedTrackerTagsSave() {
    skippedTrackerTags = skippedTrackerTagsInput.getValue().slice(0, 4e3);
    skippedTrackerTagsDirty = true;
    if (skippedTrackerTagsSaveTimer) clearTimeout(skippedTrackerTagsSaveTimer);
    skippedTrackerTagsSaveTimer = setTimeout(() => {
      skippedTrackerTagsSaveTimer = null;
      void persistSkippedTrackerTags(skippedTrackerTags);
    }, 500);
  }
  async function persistSkippedTrackerTags(value) {
    savingSkippedTrackerTags = true;
    setStatus("Saving global tracker exclusions\u2026");
    try {
      await saveSkippedTrackerTagsPreference(value);
      if (skippedTrackerTags === value) skippedTrackerTagsDirty = false;
      setStatus("Global tracker exclusions saved.", "saved");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save tracker exclusions.", "error");
    } finally {
      savingSkippedTrackerTags = false;
    }
  }
  const autoplayLongPress = new PlaybackLongPress(() => {
    autoPlaybackToggle.checked = !autoPlayback;
    onAutoPlaybackChanged();
    setStatus(`Automatic playback ${autoPlayback ? "enabled" : "disabled"}.`, "saved");
  });
  const onPlaybackPointerDown = (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    const target = event.target;
    const button = typeof target?.closest === "function" ? target.closest("button") : null;
    if (!button || !nativeTtsMessageId(button)) return;
    autoplayLongPress.start(button, event.pointerId, event.clientX, event.clientY);
  };
  const onPlaybackPointerMove = (event) => autoplayLongPress.move(event.pointerId, event.clientX, event.clientY);
  const onPlaybackPointerUp = (event) => autoplayLongPress.end(event.pointerId);
  const onPlaybackPointerCancel = () => autoplayLongPress.cancel();
  const onNativeContextMenu = (event) => {
    const target = event.target && typeof event.target.closest === "function" ? event.target : null;
    const button = target?.closest("button");
    if (button && autoplayLongPress.isHolding(button)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    lastContextMessageId = target?.closest("[data-message-id]")?.dataset.messageId ?? null;
    hostWindow.requestAnimationFrame(updatePlaybackButtons);
    if (lastContextMessageId) void ensureSavedUserContextAction(lastContextMessageId);
  };
  function hasAnySavedAudio(message) {
    const attachments = message.extra?.attachments;
    return Array.isArray(attachments) && attachments.some((candidate) => !!candidate && typeof candidate === "object" && candidate.type === "audio");
  }
  function loadMessageForSavedAudioControl(chatId, messageId) {
    if (ctx.messages.get) return ctx.messages.get(messageId);
    return requestPlaybackMessage(chatId, messageId);
  }
  async function ensureSavedUserContextAction(messageId) {
    const chatId = ctx.getActiveChat().chatId;
    if (!chatId) return;
    let message;
    try {
      const loaded = await loadMessageForSavedAudioControl(chatId, messageId);
      if (!loaded) return;
      message = loaded;
    } catch {
      return;
    }
    if (!message.is_user || !hasAnySavedAudio(message) || lastContextMessageId !== messageId) return;
    await new Promise((resolve) => hostWindow.requestAnimationFrame(() => resolve()));
    const existing = hostDocument.querySelector(`[data-chat-voice-context-tts="${CSS.escape(messageId)}"]`);
    if (existing) return;
    const menuItems = [...hostDocument.querySelectorAll('button, [role="menuitem"]')].filter((item) => item.getClientRects().length > 0 && item.closest("[data-message-id]") === null);
    const template = menuItems.find((item) => item.textContent?.trim().toLowerCase() === "copy") ?? menuItems.find((item) => item.textContent?.trim().toLowerCase() === "edit");
    if (!template?.parentElement) return;
    const action = template.cloneNode(true);
    action.removeAttribute("id");
    action.dataset.chatVoiceContextTts = messageId;
    action.setAttribute("aria-label", "Play TTS audio");
    const label = action.querySelector("span");
    if (label) label.textContent = "Play TTS audio";
    else action.textContent = "Play TTS audio";
    const icon = action.querySelector("svg");
    if (icon) icon.outerHTML = PLAY_TTS_ACTION_ICON;
    action.addEventListener("click", (clickEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      hostDocument.dispatchEvent(new hostWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      void playMessage(messageId, false);
    });
    insertAtActionIndex(template.parentElement, action, preferredTtsActionIndex());
  }
  const onNativeTtsClick = (event) => {
    const target = event.target && typeof event.target.closest === "function" ? event.target : null;
    const button = target?.closest("button");
    if (!button) return;
    if (event.detail !== 0 && autoplayLongPress.consumeClick(button)) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      return;
    }
    const messageId = nativeTtsMessageId(button);
    if (!messageId) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (button.parentElement?.parentElement === button.ownerDocument.body) {
      hostDocument.dispatchEvent(new hostWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }
    const nativeRegenerationAction = /regenerate.+audio/.test(nativeTtsButtonLabel(button));
    void playMessage(messageId, nativeRegenerationAction);
  };
  hostWindow.addEventListener("contextmenu", onNativeContextMenu, true);
  hostWindow.addEventListener("click", onNativeTtsClick, true);
  hostWindow.addEventListener("pointerdown", onPlaybackPointerDown, true);
  hostWindow.addEventListener("pointermove", onPlaybackPointerMove, true);
  hostWindow.addEventListener("pointerup", onPlaybackPointerUp, true);
  hostWindow.addEventListener("pointercancel", onPlaybackPointerCancel, true);
  hostWindow.addEventListener("blur", onPlaybackPointerCancel);
  saveAudioToggle.addEventListener("change", onSaveAudioChanged);
  saveAudioLimitInput.addEventListener("change", onSaveAudioLimitChanged);
  hostWindow.requestAnimationFrame(updatePlaybackButtons);
  const unsubscribeBackend = ctx.onBackendMessage((rawPayload) => {
    const payload = rawPayload;
    if (payload.type === "chat_voice_community_results") {
      const pending = pendingCommunityRequests.get(payload.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingCommunityRequests.delete(payload.requestId);
      if (payload.error) pending.reject(new Error(payload.error));
      else pending.resolve({ items: payload.items, total: payload.total, hasMore: payload.hasMore });
      return;
    }
    if (payload.type === "chat_voice_community_snapshot_result") {
      const pending = pendingCommunityRequests.get(payload.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingCommunityRequests.delete(payload.requestId);
      if (payload.error) pending.reject(new Error(payload.error));
      else pending.resolve({ items: payload.items, voices: readCommunityVoicePool(payload.voices), refreshedAt: payload.refreshedAt });
      return;
    }
    if (payload.type === "chat_voice_auto_cast_result") {
      const pending = pendingAutoCast.get(payload.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        pendingAutoCast.delete(payload.requestId);
        pending.resolve({ assignments: payload.assignments, diagnostics: payload.diagnostics ?? [] });
      }
      return;
    }
    if (payload.type === "chat_voice_uncast_matches") {
      const pending = pendingUncastRequests.get(payload.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingUncastRequests.delete(payload.requestId);
      if (payload.error) pending.reject(new Error(payload.error));
      else {
        for (const line of payload.diagnostics ?? []) appendSpeakerDebugLog(`Uncast matching: ${line}`);
        pending.resolve(payload.assignments);
      }
      return;
    }
    if (payload.type === "chat_voice_message") {
      const pending = pendingMessageRequests.get(payload.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingMessageRequests.delete(payload.requestId);
      if (payload.error || !payload.message) pending.reject(new Error(payload.error || "The message is unavailable."));
      else pending.resolve(payload.message);
      return;
    }
    if (payload.type === "chat_voice_parsed_message") {
      const pending = pendingSpeakerParseRequests.get(payload.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingSpeakerParseRequests.delete(payload.requestId);
      if (payload.error || !payload.segments) {
        pending.reject(new Error(payload.error || "The message speakers could not be assigned."));
      } else {
        pending.resolve({ segments: payload.segments, usedLlm: payload.usedLlm ?? null, failed: false });
      }
      return;
    }
    if (payload.type === "chat_voice_decision_status") {
      const pending = payload.requestId ? pendingDecisionStatusRequests.get(payload.requestId) : void 0;
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingDecisionStatusRequests.delete(payload.requestId);
      pending.resolve({
        available: payload.available,
        hasConnection: payload.hasConnection,
        defaultConnectionName: payload.defaultConnectionName ?? null
      });
      return;
    }
    if (payload.type === "chat_voice_llm_connections") {
      const pending = pendingLlmConnectionRequests.get(payload.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingLlmConnectionRequests.delete(payload.requestId);
      if (payload.error) pending.reject(new Error(payload.error));
      else pending.resolve(payload.connections);
      return;
    }
    if (payload.type === "chat_voice_tag_placement") {
      const pending = pendingTagPlacementRequests.get(payload.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingTagPlacementRequests.delete(payload.requestId);
      if (payload.error) pending.reject(new Error(payload.error));
      else pending.resolve(payload.placements);
      return;
    }
    if (payload.type === "chat_voice_error") {
      if (payload.requestId && pendingAutoCast.has(payload.requestId)) {
        const pending = pendingAutoCast.get(payload.requestId);
        clearTimeout(pending.timer);
        pendingAutoCast.delete(payload.requestId);
        pending.resolve({ assignments: {}, diagnostics: [`Automatic casting failed: ${payload.error}`] });
      }
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
      for (const pending of pendingSpeakerParseRequests.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("The active chat changed before speaker review completed."));
      }
      pendingSpeakerParseRequests.clear();
      for (const pending of pendingUncastRequests.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("The active chat changed before uncast voice matching completed."));
      }
      pendingUncastRequests.clear();
      for (const pending of pendingCommunityRequests.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("The active chat changed before the community voice request completed."));
      }
      pendingCommunityRequests.clear();
      for (const pending of pendingDecisionStatusRequests.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("The active chat changed before the Decision connection check completed."));
      }
      pendingDecisionStatusRequests.clear();
      for (const pending of pendingLlmConnectionRequests.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("The active chat changed before LLM connections loaded."));
      }
      pendingLlmConnectionRequests.clear();
      for (const pending of pendingTagPlacementRequests.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("The active chat changed before vocal tag placement completed."));
      }
      pendingTagPlacementRequests.clear();
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
      if (activeChat && payload.chat) {
        activeChat.assistantMessageIds = payload.chat.assistantMessageIds;
        activeChat.ghosts = payload.chat.ghosts;
        removeExpiredGhostCards();
      }
      pendingState?.resolve(payload.chat);
      return;
    }
    renderState(payload.chat);
    pendingState?.resolve(payload.chat);
  });
  const pendingSavedUserControlChecks = /* @__PURE__ */ new Set();
  const ensureSavedUserBubbleControls = () => {
    const chatId = ctx.getActiveChat().chatId;
    if (!chatId) return;
    for (const messageElement of hostDocument.querySelectorAll("[data-message-id]")) {
      const messageId = messageElement.dataset.messageId;
      const actions = messageElement.querySelector('[data-component="BubbleActions"]');
      if (!messageId || !actions || pendingSavedUserControlChecks.has(messageId)) continue;
      if (actions.querySelector("[data-chat-voice-saved-user-tts]")) continue;
      const hasTtsAction = [...actions.querySelectorAll("button")].some((button) => isExplicitTtsButton(button));
      if (hasTtsAction) continue;
      pendingSavedUserControlChecks.add(messageId);
      void loadMessageForSavedAudioControl(chatId, messageId).then((message) => {
        if (!message?.is_user || !hasAnySavedAudio(message) || !messageElement.isConnected) return;
        const currentActions = messageElement.querySelector('[data-component="BubbleActions"]');
        if (!currentActions || currentActions.querySelector("[data-chat-voice-saved-user-tts]")) return;
        const button = hostDocument.createElement("button");
        button.type = "button";
        button.className = currentActions.querySelector("button")?.className ?? "";
        button.dataset.chatVoiceSavedUserTts = "true";
        button.dataset.chatVoiceNativeTts = "true";
        button.title = "Play TTS audio";
        button.setAttribute("aria-label", "Play TTS audio");
        button.innerHTML = PLAY_TTS_ACTION_ICON;
        insertAtActionIndex(currentActions, button, preferredTtsActionIndex());
      }).catch(() => void 0).finally(() => {
        pendingSavedUserControlChecks.delete(messageId);
      });
    }
  };
  let playbackButtonsFrame = null;
  const savedUserControlObserver = new hostWindow.MutationObserver(() => {
    ensureSavedUserBubbleControls();
    if ((activePlayback || autoPlayback) && playbackButtonsFrame === null) {
      playbackButtonsFrame = hostWindow.requestAnimationFrame(() => {
        playbackButtonsFrame = null;
        updatePlaybackButtons();
      });
    }
  });
  savedUserControlObserver.observe(hostDocument.body, { childList: true, subtree: true });
  ensureSavedUserBubbleControls();
  const unsubscribeChatSwitched = ctx.events.on("CHAT_SWITCHED", (rawPayload) => {
    const switchedChatId = rawPayload?.chatId ?? null;
    autoPlaybackEpoch += 1;
    autoPlaybackRequests.cancelAll();
    playbackStartup.cancel();
    hostWindow.requestAnimationFrame(() => {
      if (ctx.getActiveChat().chatId === switchedChatId) refreshLocalState();
    });
  });
  const unsubscribeMessageRendered = ctx.events.on("CHARACTER_MESSAGE_RENDERED", () => {
    if (activeChat?.id === ctx.getActiveChat().chatId) refreshLocalState();
  });
  const unsubscribeGenerationEnded = ctx.events.on("GENERATION_ENDED", (payload) => {
    const event = autoplayGenerationEvent(payload, ctx.getActiveChat().chatId);
    if (!event || autoPlaybackDisposed) {
      appendSpeakerDebugLog("Autoplay ignored: generation was ineligible, failed, background, or not in the active chat.");
      return;
    }
    const messageKey = `${event.chatId}\0${event.messageId}`;
    const isReroll = !!event.reroll || autoPlaybackSeenMessages.has(messageKey) || activePlayback?.messageId === event.messageId;
    if (!claimAutoplayGeneration(event, autoPlaybackSeenGenerations, autoPlaybackSeenMessages)) {
      appendSpeakerDebugLog(`Autoplay ignored duplicate generation ${event.generationId}.`);
      return;
    }
    if (!autoPlayback) {
      appendSpeakerDebugLog(`Autoplay ignored generation ${event.generationId}: autoplay is disabled.`);
      return;
    }
    appendSpeakerDebugLog(`Autoplay queued: generation ${event.generationId}, message ${event.messageId}, reroll=${isReroll}, delay=${autoPlaybackDelaySeconds}s.`);
    const requestKey = `${event.chatId}\0${event.messageId}`;
    const requestSignal = autoPlaybackRequests.begin(requestKey);
    if (isReroll) {
      playbackStartup.cancelAutomaticFor(event.chatId, event.messageId);
      if (activePlayback?.messageId === event.messageId) stopPlayback();
    }
    const snapshot = requestPlaybackMessage(event.chatId, event.messageId).then(autoplaySwipeSnapshot).catch((error) => {
      if (!requestSignal.aborted) appendSpeakerDebugLog(`Autoplay skipped: could not snapshot message ${event.messageId}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    const eventEpoch = autoPlaybackEpoch;
    const deadline = Date.now() + autoPlaybackDelaySeconds * 1e3;
    autoPlaybackQueue = autoPlaybackQueue.catch(() => void 0).then(async () => {
      let expectedSwipe = null;
      await waitForAutoplayWork(snapshot.then((value) => {
        expectedSwipe = value;
      }), requestSignal);
      if (!expectedSwipe || requestSignal.aborted) return;
      if (!await waitForAutoplayDeadline(deadline, requestSignal)) {
        appendSpeakerDebugLog(`Autoplay cancelled: generation ${event.generationId} was superseded or disabled.`);
        return;
      }
      while (activePlayback && !requestSignal.aborted && !autoPlaybackDisposed && autoPlayback && eventEpoch === autoPlaybackEpoch && ctx.getActiveChat().chatId === event.chatId) await waitForAutoplayWork(activePlayback.audibleDone, requestSignal);
      if (requestSignal.aborted || autoPlaybackDisposed || !autoPlayback || eventEpoch !== autoPlaybackEpoch || ctx.getActiveChat().chatId !== event.chatId) return;
      let refreshedSwipe = null;
      await waitForAutoplayWork(requestPlaybackMessage(event.chatId, event.messageId).then((message) => {
        if (!message.is_user && expectedSwipe) refreshedSwipe = refreshAutoplaySwipe(message, expectedSwipe);
      }), requestSignal);
      if (!refreshedSwipe || requestSignal.aborted) {
        appendSpeakerDebugLog(`Autoplay skipped: message ${event.messageId} is no longer on the generated swipe.`);
        return;
      }
      await waitForAutoplayWork(playMessage(event.messageId, false, true, refreshedSwipe), requestSignal);
    }).catch((error) => {
      if (!autoPlaybackDisposed && !requestSignal.aborted) setStatus(error instanceof Error ? error.message : "Automatic playback failed.", "error");
    }).finally(() => autoPlaybackRequests.finish(requestKey, requestSignal));
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
    autoPlaybackDisposed = true;
    autoPlaybackRequests.cancelAll();
    playbackStartup.cancel();
    hostDocument.removeEventListener("pointerdown", closeFavoritePickerOnOutsideClick);
    hostDocument.removeEventListener("keydown", closeFavoritePickerOnEscape);
    stopVoicePreview();
    stopPlayback();
    for (const controller of backgroundSynthesisControllers) controller.abort();
    backgroundSynthesisControllers.clear();
    backgroundSynthesisByMessage.clear();
    flushSave();
    if (saveTimer) clearTimeout(saveTimer);
    unsubscribeActivate();
    unsubscribeChatSwitched();
    unsubscribeMessageRendered();
    unsubscribeGenerationEnded();
    unsubscribeBackend();
    for (const input of characterInputs.values()) input.destroy();
    for (const { input } of ghostVoiceEditors.values()) input.destroy();
    for (const pending of pendingMessageRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Chat Voice was closed."));
    }
    pendingMessageRequests.clear();
    for (const pending of pendingSpeakerParseRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Chat Voice was closed."));
    }
    pendingSpeakerParseRequests.clear();
    for (const pending of pendingUncastRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Chat Voice was closed."));
    }
    pendingUncastRequests.clear();
    for (const pending of pendingCommunityRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Chat Voice was closed."));
    }
    pendingCommunityRequests.clear();
    for (const pending of pendingAutoCast.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ assignments: {}, diagnostics: [] });
    }
    pendingAutoCast.clear();
    for (const pending of pendingDecisionStatusRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Chat Voice was closed."));
    }
    pendingDecisionStatusRequests.clear();
    for (const pending of pendingLlmConnectionRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Chat Voice was closed."));
    }
    pendingLlmConnectionRequests.clear();
    for (const pending of pendingTagPlacementRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Chat Voice was closed."));
    }
    pendingTagPlacementRequests.clear();
    for (const pending of pendingStateRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Chat Voice was closed."));
    }
    pendingStateRequests.clear();
    connectionPicker.destroy();
    narratorInput.destroy();
    userVoiceInput.destroy();
    narratorDefaultToggle.removeEventListener("change", onNarratorDefaultChange);
    userDefaultToggle.removeEventListener("change", onUserDefaultChange);
    if (narratorGlobalSaveTimer) {
      clearTimeout(narratorGlobalSaveTimer);
      void saveDefaultRoleVoice("narrator", defaultNarratorVoice);
    }
    if (userGlobalSaveTimer) {
      clearTimeout(userGlobalSaveTimer);
      void saveDefaultRoleVoice("user", defaultUserVoice);
    }
    if (skippedTrackerTagsSaveTimer) {
      clearTimeout(skippedTrackerTagsSaveTimer);
      void saveSkippedTrackerTagsPreference(skippedTrackerTags);
    }
    if (llmSettingsSaveTimer) {
      clearTimeout(llmSettingsSaveTimer);
      void saveLlmParsingPreferences(speakerParsingMode);
      void saveTtsTagPreferences(ttsTagStyle, ttsTagPlacement, tagLlmConnectionId, tagLlmModel);
    }
    if (advancedSettingsSaveTimer) {
      clearTimeout(advancedSettingsSaveTimer);
      void saveAdvancedPlaybackPreferences(
        playbackBufferSegments,
        concurrentGenerationLimit,
        rateLimitWaitSeconds,
        speakerAssignmentDebug,
        ghostVoiceLifetime,
        autoVoiceCasting,
        autoPlayback,
        autoPlaybackDelaySeconds,
        speakerLookback,
        skipNarration,
        autoVoiceCastingPool
      );
    }
    skippedTrackerTagsInput.destroy();
    speakerParsingPicker.destroy();
    ttsTagPicker.destroy();
    ttsTagPlacementPicker.destroy();
    tagLlmConnectionPicker.destroy();
    tagLlmModelInput.destroy();
    playbackBufferInput.removeEventListener("change", onPlaybackBufferInput);
    concurrentGenerationInput.removeEventListener("change", onConcurrentGenerationInput);
    rateLimitWaitInput.removeEventListener("change", onRateLimitWaitInput);
    autoPlaybackDelayInput.removeEventListener("change", onAutoPlaybackDelayInput);
    ghostLifetimeInput.removeEventListener("change", onGhostLifetimeInput);
    speakerLookbackInput.removeEventListener("change", onSpeakerLookbackInput);
    speakerDebugToggle.removeEventListener("change", onSpeakerDebugChanged);
    skipNarrationToggle.removeEventListener("change", onSkipNarrationChanged);
    autoPlaybackToggle.removeEventListener("change", onAutoPlaybackChanged);
    addNpcInput.destroy();
    addNpcButton.removeEventListener("click", onAddNpc);
    addNpcInputSlot.removeEventListener("keydown", onAddNpcKeyDown);
    scanButton.removeEventListener("click", scanMessages);
    saveAudioToggle.removeEventListener("change", onSaveAudioChanged);
    saveAudioLimitInput.removeEventListener("change", onSaveAudioLimitChanged);
    hostWindow.removeEventListener("contextmenu", onNativeContextMenu, true);
    hostWindow.removeEventListener("click", onNativeTtsClick, true);
    hostWindow.removeEventListener("pointerdown", onPlaybackPointerDown, true);
    hostWindow.removeEventListener("pointermove", onPlaybackPointerMove, true);
    hostWindow.removeEventListener("pointerup", onPlaybackPointerUp, true);
    hostWindow.removeEventListener("pointercancel", onPlaybackPointerCancel, true);
    hostWindow.removeEventListener("blur", onPlaybackPointerCancel);
    autoplayLongPress.cancel();
    savedUserControlObserver.disconnect();
    if (playbackButtonsFrame !== null) hostWindow.cancelAnimationFrame(playbackButtonsFrame);
    restoreNativePlaybackButtons();
    syncAutoplayIndicators(hostDocument.querySelectorAll("button"), false, nativeTtsMessageId);
    autoplayIndicatorStyle.remove();
    tab.destroy();
    removeStyle();
  };
}
export {
  setup
};
