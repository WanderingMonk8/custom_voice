// src/core.ts
var USER_SPEAKER_ID = "__chat_voice_user__";
var UNCAST_SPEAKER_ID = "__chat_voice_uncast__";
var DEFAULT_SAVED_AUDIO_LIMIT = 50;
var MAX_SAVED_AUDIO_LIMIT = 1e4;
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
      category: row.category === "male" || row.category === "female" ? row.category : "unspecified"
    });
  }
  return result;
}
function speakersForMessageRole(speakers, _isUserMessage, userName = "User") {
  const nonUserSpeakers = speakers.filter((speaker) => speaker.id !== USER_SPEAKER_ID);
  return [
    ...nonUserSpeakers,
    { id: USER_SPEAKER_ID, name: normalizeSpeakerName(userName) || "User" }
  ];
}
function playbackVoiceForSpeaker(speakerId, isUserMessage, characterVoices, narratorVoice, userVoice) {
  if (speakerId === USER_SPEAKER_ID) return userVoice;
  if (speakerId) return characterVoices[speakerId] || "";
  return narratorVoice;
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
function preferredCardSpeakerId(message, speakers, cardCharacterIds) {
  const speakerIds = new Set(speakers.map((speaker) => speaker.id));
  const explicitId = typeof message.extra?.character_id === "string" ? message.extra.character_id : "";
  if (explicitId && speakerIds.has(explicitId)) return explicitId;
  const messageName = normalizeSpeakerName(message.name ?? "").toLowerCase();
  const namedSpeaker = messageName ? speakers.find((speaker) => speakerAliases(speaker.name).some((alias) => alias.toLowerCase() === messageName)) : void 0;
  if (namedSpeaker) return namedSpeaker.id;
  const availableCardIds = [...new Set(cardCharacterIds)].filter((characterId) => speakerIds.has(characterId));
  return availableCardIds.length === 1 ? availableCardIds[0] : null;
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
function hasNamedSpeakerSubject(content, speakers, skippedTrackerTagPairs = "") {
  const playbackContent = preparePlaybackContent(content, skippedTrackerTagPairs);
  return playbackParagraphs(playbackContent).some((paragraph) => {
    const mentions = mentionedSpeakers(paragraph.text, speakers);
    return preferredMentionedSpeaker(paragraph.text, speakers, mentions) !== null;
  });
}
function eligibleCardFallbackSpeakerId(content, cardSpeakerId, speakers, skippedTrackerTagPairs = "") {
  if (!cardSpeakerId) return null;
  const alternativeSpeakers = speakers.filter((speaker) => speaker.id !== cardSpeakerId);
  if (hasNamedSpeakerSubject(content, alternativeSpeakers, skippedTrackerTagPairs)) return null;
  return hasExplicitUncastCue(content, skippedTrackerTagPairs) ? null : cardSpeakerId;
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
var SPEAKER_TURN_SWITCH_PATTERN = /\b(?:(?:another|a second|a third|a new|the other)\s+(?:voice|woman|man|person|speaker|figure|kid|girl|boy)|(?:someone|somebody)\s+(?:else\s+)?(?:says|said|asks|asked|replies|replied|answers|answered|calls|called|whispers|whispered|shouts|shouted)|(?:a|another)\s+voice\s+(?:from|behind|near|across)|from (?:across the room|the (?:hallway|doorway|next room|other room|shadows)))\b/iu;
var NARRATIVE_SPEECH_VERB_PATTERN = new RegExp(
  `\\b(?:${SPEECH_VERBS}|blurt(?:s|ed)|laugh(?:s|ed)|mutter(?:s|ed)|hiss(?:es|ed)|snap(?:s|ped))\\b`,
  "iu"
);
function hasExplicitUncastCue(content, skippedTrackerTagPairs = "") {
  const playbackContent = preparePlaybackContent(content, skippedTrackerTagPairs);
  const narration = cleanPlaybackText(narrativeOnly(playbackContent));
  return ANONYMOUS_ROLE_IDENTITY_PATTERN.test(narration) || hasAnonymousHumanSubject(narration) || SPEAKER_TURN_SWITCH_PATTERN.test(narration);
}
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
var STOP_ACTION_ICON = `<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>`;
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
    saveGeneratedAudio: false,
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
    speakerAssignmentDebug: false,
    defaultNarratorVoice: "",
    defaultUserVoice: "",
    favoriteVoices: []
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
    connectionId: typeof row.value?.ttsConnectionId === "string" ? row.value.ttsConnectionId.trim() : "",
    saveGeneratedAudio: row.value?.chatVoiceSaveGeneratedAudio === true,
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
    speakerAssignmentDebug: row.value?.chatVoiceSpeakerAssignmentDebug === true,
    defaultNarratorVoice: typeof row.value?.chatVoiceDefaultNarratorVoice === "string" ? row.value.chatVoiceDefaultNarratorVoice.trim().slice(0, 512) : "",
    defaultUserVoice: typeof row.value?.chatVoiceDefaultUserVoice === "string" ? row.value.chatVoiceDefaultUserVoice.trim().slice(0, 512) : "",
    favoriteVoices: readFavoriteVoices(row.value?.chatVoiceFavoriteVoices)
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
function saveAdvancedPlaybackPreferences(bufferSegments, concurrentGenerations, rateLimitWaitSeconds, speakerAssignmentDebug) {
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
    chatVoiceSpeakerAssignmentDebug: speakerAssignmentDebug
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
  const savedAudioId = result.audio?.id;
  const attachments = result.message?.extra?.attachments;
  const attached = Array.isArray(attachments) && attachments.some((attachment) => attachment?.type === "audio" && attachment.image_id === savedAudioId);
  if (result.message?.id !== messageId || !savedAudioId || !attached) {
    throw new Error("Lumiverse did not confirm the generated audio attachment on the message.");
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
    .chat-voice-favorites { display:flex; flex-direction:column; gap:8px; }
    .chat-voice-favorite-form { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    .chat-voice-favorite-form input, .chat-voice-favorite-select, .chat-voice-favorite-form select {
      min-width:0; width:100%; box-sizing:border-box; min-height:36px; padding:7px 9px;
      border:1px solid var(--lumiverse-border); border-radius:var(--lumiverse-radius);
      background:var(--lumiverse-bg-secondary, #222); color:var(--lumiverse-text); font:inherit; font-size:12px;
    }
    .chat-voice-favorite-row { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
    .chat-voice-favorite-copy { flex:1 1 100px; min-width:0; overflow-wrap:anywhere; color:var(--lumiverse-text); font-size:12px; }
    .chat-voice-favorite-copy small { display:block; color:var(--lumiverse-text-muted); }
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
    return { field, label, slot };
  }
  const connectionField = createField("TTS connection");
  const saveAudioField = createField("Audio storage");
  saveAudioField.slot.className = "chat-voice-storage";
  const saveAudioLabel = document.createElement("label");
  saveAudioLabel.className = "chat-voice-toggle";
  const saveAudioToggle = document.createElement("input");
  saveAudioToggle.type = "checkbox";
  saveAudioToggle.checked = false;
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
    const toggle = document.createElement("label");
    toggle.className = "chat-voice-role-default";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.setAttribute("aria-label", ariaLabel);
    const copy = document.createElement("span");
    copy.textContent = "Use global";
    toggle.append(checkbox, copy);
    field.label.append(title, toggle);
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
  const favoritesTitle = document.createElement("div");
  favoritesTitle.className = "chat-voice-section-title";
  favoritesTitle.textContent = "Favorite voices";
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
  const favoriteCategory = document.createElement("select");
  favoriteCategory.setAttribute("aria-label", "Favorite voice classification");
  for (const [value, label] of [["unspecified", "Unspecified"], ["female", "Female"], ["male", "Male"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    favoriteCategory.appendChild(option);
  }
  const favoriteAdd = document.createElement("button");
  favoriteAdd.type = "button";
  favoriteAdd.className = "chat-voice-add-button";
  favoriteAdd.textContent = "Add favorite";
  favoriteForm.append(favoriteName, favoriteId, favoriteCategory, favoriteAdd);
  const favoriteList = document.createElement("div");
  favoriteList.className = "chat-voice-favorites";
  favoritesSection.append(favoriteForm, favoriteList);
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
    favoritesTitle,
    favoritesSection,
    addNpcField.field,
    characterTitle,
    characterList,
    status,
    advancedSection
  );
  tab.root.appendChild(panel);
  const playbackBufferField = createField("Playback buffer segments");
  const concurrentGenerationField = createField("Maximum concurrent generations");
  const rateLimitWaitField = createField("Rate-limit wait budget (seconds)");
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
  const speakerDebugOutput = document.createElement("textarea");
  speakerDebugOutput.className = "chat-voice-debug-output";
  speakerDebugOutput.readOnly = true;
  speakerDebugOutput.hidden = true;
  speakerDebugOutput.placeholder = "Generate TTS to see the turn matrix, discourse review, inheritance, and voice-route trace.";
  speakerDebugOutput.setAttribute("aria-label", "Speaker assignment debug log");
  const advancedHint = document.createElement("div");
  advancedHint.className = "chat-voice-hint";
  advancedHint.textContent = "Concurrency starts at one and adapts up to the selected maximum. Dense short-segment runs stay at one request at a time, while sustained long runs increase gradually. Larger buffers reduce pauses but delay playback. The wait budget controls cumulative rate-limit cooldowns.";
  advancedBody.append(
    playbackBufferField.field,
    concurrentGenerationField.field,
    rateLimitWaitField.field,
    speakerDebugLabel,
    speakerDebugOutput,
    advancedHint
  );
  let applyingState = false;
  let activeChat = null;
  let connections = [];
  let lumiverseConnectionId = "";
  let defaultNarratorVoice = "";
  let defaultUserVoice = "";
  let favoriteVoices = [];
  let favoritesSaving = false;
  let previewController = null;
  let previewAudio = null;
  let previewUrl = null;
  const favoritePickers = /* @__PURE__ */ new Set();
  let localNarratorVoice = "";
  let localUserVoice = "";
  let useGlobalNarratorVoice = true;
  let useGlobalUserVoice = true;
  let narratorGlobalSaveTimer = null;
  let userGlobalSaveTimer = null;
  let savingNarratorGlobalVoice = false;
  let savingUserGlobalVoice = false;
  let saveGeneratedAudio = false;
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
  let speakerAssignmentDebug = false;
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
  let lastContextMessageId = null;
  const nativeButtonStates = /* @__PURE__ */ new Map();
  const pendingMessageRequests = /* @__PURE__ */ new Map();
  const pendingStateRequests = /* @__PURE__ */ new Map();
  const pendingSpeakerParseRequests = /* @__PURE__ */ new Map();
  const pendingDecisionStatusRequests = /* @__PURE__ */ new Map();
  const pendingLlmConnectionRequests = /* @__PURE__ */ new Map();
  const pendingTagPlacementRequests = /* @__PURE__ */ new Map();
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
    onChange: () => {
      if (applyingState) return;
      if (useGlobalNarratorVoice) {
        defaultNarratorVoice = narratorInput.getValue();
        scheduleGlobalRoleVoiceSave("narrator");
      } else {
        localNarratorVoice = narratorInput.getValue();
        markChanged();
      }
    }
  });
  const userVoiceInput = ctx.components.mountTextInput(userVoiceField.slot, {
    value: "",
    placeholder: "Enter the user voice name or ID",
    ariaLabel: "User voice",
    disabled: true,
    onChange: () => {
      if (applyingState) return;
      if (useGlobalUserVoice) {
        defaultUserVoice = userVoiceInput.getValue();
        scheduleGlobalRoleVoiceSave("user");
      } else {
        localUserVoice = userVoiceInput.getValue();
        markChanged();
      }
    }
  });
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
      connectionId: connectionPicker.getValue(),
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
        debug: preferences.speakerAssignmentDebug
      });
    });
  }
  function speakerDebugName(speakerId, speakers) {
    if (speakerId === null) return "narrator";
    if (speakerId === USER_SPEAKER_ID) return "user persona";
    if (speakerId === UNCAST_SPEAKER_ID) return "uncast character";
    const speaker = speakers.find((candidate) => candidate.id === speakerId);
    return speaker ? `${speaker.name} [${speakerId}]` : speakerId;
  }
  const SPEAKER_SOURCE_LABELS = {
    "first-pass": "first pass",
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
    const resolution = speakerDebugStep(segment, "resolution:");
    if (resolution?.startsWith("resolution:chain-identity (overrode")) return "chain-override";
    if (resolution?.startsWith("resolution:chain-identity")) return "chain-fill";
    if (resolution?.startsWith("resolution:discourse-identity (overrode")) return "discourse-override";
    if (resolution?.startsWith("resolution:discourse-identity")) return "discourse-fill";
    if (resolution === "resolution:direct-speech-identity") return "first-pass";
    if (resolution?.startsWith("resolution:upstream-identity")) return "inheritance";
    if (resolution?.startsWith("resolution:previous-assistant")) return "previous-assistant";
    if (resolution?.startsWith("resolution:unique card-title")) return "card-title";
    if (resolution?.startsWith("resolution:user-role")) return "role-fallback";
    if (resolution?.startsWith("resolution:assistant connection-default")) return "role-fallback";
    if (review.failed || review.usedLlm === false || parsingMode === "off") return "local-parser";
    if (speakerDebugStep(segment, "jev-fallback:") || speakerDebugStep(segment, "jev-disabled:")) {
      return "local-parser";
    }
    return "unreported";
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
    const normalized = speechSegments.map((segment) => speakerDebugStep(segment, "jev-speech-normalized:")).filter((step) => step !== void 0);
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
  async function persistCapturedAudio(chatId, messageId, swipeId, segments, contextClass, signal, waitForSafeFallback, onWavAssembly) {
    const normalized = segments.some((segment) => segment.normalizationGain !== void 0);
    if (normalized) {
      onWavAssembly(true);
      const wav = await encodeCapturedWav(segments, contextClass);
      return saveMessageAudio(
        chatId,
        messageId,
        swipeId,
        [{ data: wav, mime: "audio/wav" }],
        signal
      );
    }
    try {
      return await saveMessageAudio(chatId, messageId, swipeId, segments, signal);
    } catch (segmentSaveError) {
      if (segmentSaveError?.name === "AbortError") throw segmentSaveError;
      await waitForSafeFallback();
      if (signal.aborted) throw new DOMException("Audio saving stopped.", "AbortError");
      onWavAssembly(false);
      const wav = await encodeCapturedWav(segments, contextClass);
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
  async function playMessage(messageId, nativeRegenerationAction = false) {
    if (activePlayback?.messageId === messageId) {
      const finishingSave = stopPlayback();
      setStatus(finishingSave ? "Playback stopped; finishing saved audio\u2026" : "Playback stopped.");
      return;
    }
    const requestedChatId = ctx.getActiveChat().chatId;
    if (!requestedChatId) {
      setStatus("Open a chat before starting voice playback.", "error");
      return;
    }
    let message;
    try {
      message = await requestPlaybackMessage(requestedChatId, messageId);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load this message.", "error");
      return;
    }
    if (ctx.getActiveChat().chatId !== requestedChatId) return;
    const regeneratingSavedAudio = !message.is_user && (nativeRegenerationAction || hasSavedAudioForCurrentSwipe(message));
    if (regeneratingSavedAudio) {
      const { confirmed } = await ctx.ui.showConfirm({
        title: "Regenerate TTS audio?",
        message: "This will replace the saved audio attached to this message with a new TTS synthesis. The current recording will be deleted.",
        confirmLabel: "Regenerate",
        cancelLabel: "Keep current",
        variant: "warning"
      });
      if (!confirmed || ctx.getActiveChat().chatId !== requestedChatId) return;
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
        setStatus(error instanceof Error ? error.message : "Could not load this chat\u2019s voice settings.", "error");
        return;
      }
    }
    if (!activeChat || activeChat.id !== ctx.getActiveChat().chatId) return;
    const playbackChat = activeChat;
    const config = collectConfig();
    const preferences = await loadPlaybackPreferences();
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
      preferences.speakerAssignmentDebug = speakerAssignmentDebug;
    } else {
      playbackBufferSegments = preferences.playbackBufferSegments;
      concurrentGenerationLimit = preferences.concurrentGenerations;
      rateLimitWaitSeconds = preferences.rateLimitWaitSeconds;
      speakerAssignmentDebug = preferences.speakerAssignmentDebug;
    }
    const connectionId = config.connectionId || (connections.some((connection) => connection.id === preferences.connectionId) ? preferences.connectionId : connections.find((connection) => connection.is_default)?.id ?? lumiverseConnectionId);
    if (!connectionId) {
      setStatus("Choose a TTS connection before playing.", "error");
      return;
    }
    const connectionProfileVoice = (connections.find((connection) => connection.id === connectionId)?.voice ?? "").trim();
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
    await audioContext.resume();
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
    activePlayback = playback;
    updatePlaybackButtons();
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
      const defaultSpeakerId = message.is_user ? USER_SPEAKER_ID : eligibleCardFallbackSpeakerId(
        message.content,
        preferredCardSpeakerId(
          message,
          playbackChat.characters,
          playbackChat.cardCharacterIds ?? []
        ),
        playbackSpeakers,
        preferences.skippedTrackerTags
      );
      const aliases = speakerAliasIdLookup(playbackChat.characters);
      const localSegments = parseRosterVoiceSegments(
        message.content,
        defaultSpeakerId,
        playbackSpeakers,
        preferences.skippedTrackerTags,
        null,
        preferences.speakerAssignmentDebug
      );
      let review = { segments: localSegments, usedLlm: null, failed: false };
      if (preferences.speakerParsingMode !== "off" || preferences.ttsTagStyle !== "off") {
        setStatus(
          preferences.speakerParsingMode !== "off" ? "Classifying dialogue speakers with Jev\u2026" : "Adding TTS vocal tags\u2026"
        );
      }
      try {
        review = await requestSpeakerReviewedSegments(playbackChat.id, messageId, preferences);
      } catch (error) {
        console.warn("[Chat Voice] Backend speaker parsing failed; using the message-local parser.", error);
        if (playback.controller.signal.aborted) throw new DOMException("Playback stopped.", "AbortError");
        review = { segments: localSegments, usedLlm: null, failed: true };
        setStatus("Historical speaker lookup unavailable; using the message-local parser.");
      }
      const segments = review.segments;
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
        review
      );
      let explicitVoiceCount = 0;
      let connectionVoiceFallbacks = 0;
      const plan = mergeVoicePlan(segments.map((segment) => {
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
      }));
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
      const synthesisMessageKey = `${playbackChat.id}\0${messageId}`;
      const previousSynthesis = backgroundSynthesisByMessage.get(synthesisMessageKey);
      if (previousSynthesis) {
        previousSynthesis.abort();
        backgroundSynthesisByMessage.delete(synthesisMessageKey);
        appendSpeakerDebugLog("Cancelled an older unfinished synthesis/save for this message.");
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
  function removeCharacter(characterId) {
    if (!activeChat) return;
    activeChat = {
      ...activeChat,
      characters: activeChat.characters.filter((character) => character.id !== characterId)
    };
    renderCharacters(activeChat.characters);
    markChanged(0);
  }
  function renameCharacter(characterId) {
    if (!activeChat) return null;
    const character = activeChat.characters.find((item) => item.id === characterId);
    if (!character) return null;
    const response = hostWindow.prompt(
      "Rename this character or add aliases separated by \u201C/\u201D.",
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
  function updateFavoritePickers() {
    for (const picker of favoritePickers) {
      picker.replaceChildren();
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = favoriteVoices.length ? "Choose a favorite voice\u2026" : "No favorite voices yet";
      picker.appendChild(placeholder);
      for (const [category, label] of [["female", "Female"], ["male", "Male"], ["unspecified", "Unspecified"]]) {
        const entries = favoriteVoices.filter((voice) => voice.category === category);
        if (!entries.length) continue;
        const group = document.createElement("optgroup");
        group.label = label;
        for (const voice of entries) {
          const option = document.createElement("option");
          option.value = voice.id;
          option.textContent = voice.name ? `${voice.name} (${voice.id})` : voice.id;
          group.appendChild(option);
        }
        picker.appendChild(group);
      }
      picker.disabled = !activeChat || favoriteVoices.length === 0;
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
  async function previewFavoriteVoice(voice) {
    const connectionId = connectionPicker.getValue() || lumiverseConnectionId;
    if (!connectionId) {
      setStatus("Choose a TTS connection to preview a voice.", "error");
      return;
    }
    stopVoicePreview();
    const controller = new AbortController();
    previewController = controller;
    setStatus(`Generating preview for ${voice.name || voice.id}\u2026`);
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
        voice.id,
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
      if (previewController === controller) setStatus(`Playing preview for ${voice.name || voice.id}.`);
    } catch (error) {
      if (controller.signal.aborted) return;
      stopVoicePreview();
      setStatus(error instanceof Error ? `Voice preview failed: ${error.message}` : "Voice preview failed.", "error");
    }
  }
  async function saveFavoriteVoices(next) {
    if (favoritesSaving) return false;
    favoritesSaving = true;
    favoriteAdd.disabled = true;
    try {
      await updateVoiceSettings((current) => ({ ...current, chatVoiceFavoriteVoices: next }));
      favoriteVoices = next;
      renderFavoriteVoices();
      updateFavoritePickers();
      setStatus("Favorite voices saved globally.", "saved");
      return true;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save favorite voices.", "error");
      return false;
    } finally {
      favoritesSaving = false;
      favoriteAdd.disabled = false;
    }
  }
  function renderFavoriteVoices() {
    favoriteList.replaceChildren();
    if (!favoriteVoices.length) {
      const empty = document.createElement("div");
      empty.className = "chat-voice-hint";
      empty.textContent = "Add voice IDs to reuse them in any chat.";
      favoriteList.appendChild(empty);
      return;
    }
    for (const voice of favoriteVoices) {
      const row = document.createElement("div");
      row.className = "chat-voice-favorite-row";
      const copy = document.createElement("span");
      copy.className = "chat-voice-favorite-copy";
      copy.textContent = voice.name || voice.id;
      const details = document.createElement("small");
      details.textContent = voice.name ? voice.id : "";
      copy.appendChild(details);
      const category = document.createElement("select");
      category.className = "chat-voice-favorite-select";
      category.style.width = "auto";
      category.setAttribute("aria-label", `Classification for ${voice.name || voice.id}`);
      for (const [value, label] of [["unspecified", "Unspecified"], ["female", "Female"], ["male", "Male"]]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        category.appendChild(option);
      }
      category.value = voice.category;
      category.addEventListener("change", () => {
        const nextCategory = category.value === "male" || category.value === "female" ? category.value : "unspecified";
        category.disabled = true;
        void saveFavoriteVoices(favoriteVoices.map((item) => item.id === voice.id ? { ...item, category: nextCategory } : item)).then((saved) => {
          if (!saved) {
            category.value = voice.category;
            category.disabled = false;
          }
        });
      });
      const preview = document.createElement("button");
      preview.type = "button";
      preview.className = "chat-voice-preview-button";
      preview.textContent = "Preview";
      preview.setAttribute("aria-label", `Preview ${voice.name || voice.id}`);
      preview.addEventListener("click", () => {
        void previewFavoriteVoice(voice);
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "chat-voice-delete-button";
      remove.textContent = "\xD7";
      remove.setAttribute("aria-label", `Remove favorite ${voice.name || voice.id}`);
      remove.addEventListener("click", () => {
        void saveFavoriteVoices(favoriteVoices.filter((item) => item.id !== voice.id));
      });
      row.append(copy, category, preview, remove);
      favoriteList.appendChild(row);
    }
  }
  favoriteAdd.addEventListener("click", () => {
    const id = favoriteId.value.trim().slice(0, 512);
    if (!id) {
      setStatus("Enter a voice ID to add a favorite.", "error");
      return;
    }
    if (favoriteVoices.length >= 500) {
      setStatus("The favorites list is limited to 500 voices.", "error");
      return;
    }
    if (favoriteVoices.some((voice) => voice.id === id)) {
      setStatus("That voice ID is already a favorite.", "error");
      return;
    }
    const category = favoriteCategory.value === "male" || favoriteCategory.value === "female" ? favoriteCategory.value : "unspecified";
    void saveFavoriteVoices([...favoriteVoices, { id, name: favoriteName.value.trim().slice(0, 128), category }]).then((saved) => {
      if (saved) {
        favoriteName.value = "";
        favoriteId.value = "";
      }
    });
  });
  function renderCharacters(characters) {
    for (const input of characterInputs.values()) input.destroy();
    characterInputs.clear();
    favoritePickers.clear();
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
          const renamed = renameCharacter(character.id);
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
        remove.addEventListener("click", () => removeCharacter(character.id));
        meta.append(rename, remove);
      }
      const slot = document.createElement("div");
      const picker = document.createElement("select");
      picker.className = "chat-voice-favorite-select";
      picker.setAttribute("aria-label", `Favorite voice for ${character.name}`);
      heading.append(name, meta);
      card.append(heading, slot, picker);
      characterList.appendChild(card);
      const input = ctx.components.mountTextInput(slot, {
        value: character.voice,
        placeholder: `Voice name or ID for ${character.name}`,
        ariaLabel: `Custom voice for ${character.name}`,
        disabled: !activeChat,
        onChange: () => markChanged()
      });
      characterInputs.set(character.id, input);
      picker.addEventListener("change", () => {
        if (!picker.value) return;
        input.update({ value: picker.value });
        picker.value = "";
        markChanged();
      });
      favoritePickers.add(picker);
    }
    updateFavoritePickers();
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
    localNarratorVoice = next?.narratorVoice ?? "";
    localUserVoice = next?.userVoice ?? "";
    useGlobalNarratorVoice = next?.useGlobalNarratorVoice ?? true;
    useGlobalUserVoice = next?.useGlobalUserVoice ?? true;
    narratorInput.update({
      value: next ? useGlobalNarratorVoice ? defaultNarratorVoice : localNarratorVoice : "",
      disabled: !next
    });
    userVoiceInput.update({
      value: next ? useGlobalUserVoice ? defaultUserVoice : localUserVoice : "",
      disabled: !next
    });
    addNpcInput.update({ value: "", disabled: !next });
    addNpcButton.disabled = !next;
    renderCharacters(next?.characters ?? []);
    updateRoleDefaultControls();
    applyingState = false;
    if (!next) setStatus("Open a chat to edit its voices.");
    else if (connections.length === 0) setStatus("Create a TTS connection in Lumiverse first.");
    else setStatus("All changes save automatically.", "saved");
  }
  async function loadConnections() {
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
      if (!favoritesSaving) {
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
        narratorInput.update({
          value: useGlobalNarratorVoice ? defaultNarratorVoice : localNarratorVoice,
          disabled: false
        });
        userVoiceInput.update({
          value: useGlobalUserVoice ? defaultUserVoice : localUserVoice,
          disabled: false
        });
      }
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
        speakerAssignmentDebug = preferences.speakerAssignmentDebug;
        playbackBufferInput.value = String(playbackBufferSegments);
        concurrentGenerationInput.value = String(concurrentGenerationLimit);
        rateLimitWaitInput.value = String(rateLimitWaitSeconds);
        speakerDebugToggle.checked = speakerAssignmentDebug;
        speakerDebugOutput.hidden = !speakerAssignmentDebug;
      }
      lumiverseConnectionId = connections.some((connection) => connection.id === preferences.connectionId) ? preferences.connectionId : connections.find((connection) => connection.is_default)?.id ?? "";
      const selectedConnectionId = activeChat?.connectionId || lumiverseConnectionId;
      connectionPicker.update({
        value: selectedConnectionId,
        options: connectionOptions(selectedConnectionId),
        placeholder: connections.length ? "Choose a TTS connection" : "No TTS connections found",
        disabled: !activeChat || connections.length === 0
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
  async function persistAdvancedSettings() {
    savingAdvancedSettings = true;
    setStatus("Saving global advanced playback settings\u2026");
    try {
      await saveAdvancedPlaybackPreferences(
        playbackBufferSegments,
        concurrentGenerationLimit,
        rateLimitWaitSeconds,
        speakerAssignmentDebug
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
  const onNativeContextMenu = (event) => {
    const target = event.target && typeof event.target.closest === "function" ? event.target : null;
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
  saveAudioToggle.addEventListener("change", onSaveAudioChanged);
  saveAudioLimitInput.addEventListener("change", onSaveAudioLimitChanged);
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
  const savedUserControlObserver = new hostWindow.MutationObserver(() => ensureSavedUserBubbleControls());
  savedUserControlObserver.observe(hostDocument.body, { childList: true, subtree: true });
  ensureSavedUserBubbleControls();
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
    stopVoicePreview();
    stopPlayback();
    for (const controller of backgroundSynthesisControllers) controller.abort();
    backgroundSynthesisControllers.clear();
    backgroundSynthesisByMessage.clear();
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
    for (const pending of pendingSpeakerParseRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Chat Voice was closed."));
    }
    pendingSpeakerParseRequests.clear();
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
        speakerAssignmentDebug
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
    speakerDebugToggle.removeEventListener("change", onSpeakerDebugChanged);
    addNpcInput.destroy();
    addNpcButton.removeEventListener("click", onAddNpc);
    addNpcInputSlot.removeEventListener("keydown", onAddNpcKeyDown);
    scanButton.removeEventListener("click", scanMessages);
    saveAudioToggle.removeEventListener("change", onSaveAudioChanged);
    saveAudioLimitInput.removeEventListener("change", onSaveAudioLimitChanged);
    hostWindow.removeEventListener("contextmenu", onNativeContextMenu, true);
    hostWindow.removeEventListener("click", onNativeTtsClick, true);
    savedUserControlObserver.disconnect();
    restoreNativePlaybackButtons();
    tab.destroy();
    removeStyle();
  };
}
export {
  setup
};
