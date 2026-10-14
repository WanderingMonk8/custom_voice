import assert from 'node:assert/strict'
import test from 'node:test'
import {
  adaptiveGenerationConcurrency,
  addScannedFirstNameAliases,
  mergeScannedCardCast,
  applyConfigToMetadata,
  clampMessageLimit,
  clampSavedAudioLimit,
  detectCharacters,
  encodeConcatenatedWav,
  expiredSavedAudioRecords,
  hashMessageContent,
  mergeVoicePlan,
  npcSpeakerId,
  needsLlmSpeakerReview,
  parseCardCast,
  parseLlmSegmentation,
  parseLlmSpeakerAssignments,
  parseMultiVoiceSegments,
  parseRosterVoiceSegments,
  parseRosterVoiceSegmentsWithAssignments,
  parseSkippedTrackerTags,
  previousAssistantSpeakerFallback,
  readConfig,
  readSavedAudioHistory,
  speakerAliases,
  stripSkippedTrackerBlocks,
  upsertSavedAudioRecord,
  type ChatVoiceConfig,
} from './core'

test('combines decoded segments into one resampled PCM WAV', () => {
  const wav = encodeConcatenatedWav([
    { sampleRate: 8_000, channels: [new Float32Array([0, 0.5, -0.5, 1])] },
    { sampleRate: 16_000, channels: [new Float32Array([0.25, -0.25, 0.75, -0.75])] },
  ])
  const view = new DataView(wav)
  const text = (offset: number, length: number) => String.fromCharCode(
    ...new Uint8Array(wav, offset, length),
  )

  assert.equal(text(0, 4), 'RIFF')
  assert.equal(text(8, 4), 'WAVE')
  assert.equal(text(36, 4), 'data')
  assert.equal(view.getUint16(20, true), 1)
  assert.equal(view.getUint16(22, true), 1)
  assert.equal(view.getUint32(24, true), 16_000)
  assert.equal(view.getUint32(40, true), 24)
  assert.equal(wav.byteLength, 68)
})

test('applies per-segment gain while assembling PCM WAV audio', () => {
  const wav = encodeConcatenatedWav([
    { sampleRate: 8_000, channels: [new Float32Array([0.5, -0.5])], gain: 0.5 },
  ])
  const view = new DataView(wav)

  assert.equal(view.getInt16(44, true), 8191)
  assert.equal(view.getInt16(46, true), -8192)
})

test('forces fragmented generation windows to one despite long outliers', () => {
  assert.deepEqual(
    adaptiveGenerationConcurrency(3, 3, [80, 90, 500, 100, 450, 110]),
    { concurrency: 1, shortCooldown: 6, longWindowStreak: 0 },
  )
})

test('requires sustained long windows before raising concurrency to its configured ceiling', () => {
  const first = adaptiveGenerationConcurrency(1, 3, [400, 500, 600], 0, 0)
  assert.deepEqual(first, { concurrency: 1, shortCooldown: 0, longWindowStreak: 1 })
  assert.deepEqual(
    adaptiveGenerationConcurrency(
      first.concurrency,
      3,
      [420, 520, 620],
      first.shortCooldown,
      first.longWindowStreak,
    ),
    { concurrency: 2, shortCooldown: 0, longWindowStreak: 0 },
  )
  assert.deepEqual(
    adaptiveGenerationConcurrency(1, 1, [400, 500, 600], 0, 1),
    { concurrency: 1, shortCooldown: 0, longWindowStreak: 0 },
  )
})

test('holds concurrency at one during the short-segment cooldown', () => {
  assert.deepEqual(
    adaptiveGenerationConcurrency(1, 4, [250, 260, 270], 6, 0),
    { concurrency: 1, shortCooldown: 5, longWindowStreak: 0 },
  )
})

test('merges adjacent segments that use the same voice', () => {
  assert.deepEqual(mergeVoicePlan([
    { text: 'First sentence.', voice: 'narrator' },
    { text: ' Second sentence. ', voice: 'narrator' },
    { text: 'Hello.', voice: 'alice' },
    { text: '', voice: 'alice' },
    { text: 'Back to narration.', voice: 'narrator' },
  ]), [
    { text: 'First sentence. Second sentence.', voice: 'narrator' },
    { text: 'Hello.', voice: 'alice' },
    { text: 'Back to narration.', voice: 'narrator' },
  ])
})

test('keeps separate paragraphs as independently generated voice segments', () => {
  assert.deepEqual(mergeVoicePlan([
    { text: 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.', voice: 'narrator' },
  ]), [
    { text: 'First paragraph.', voice: 'narrator' },
    { text: 'Second paragraph.', voice: 'narrator' },
    { text: 'Third paragraph.', voice: 'narrator' },
  ])
})

test('parses comma-separated tracker tag names and removes their contents before playback', () => {
  const tagNames = 'tracker, status, tracker, o_scene'
  assert.deepEqual(parseSkippedTrackerTags(tagNames), ['tracker', 'status', 'o_scene'])
  const content = 'Spoken before. <tracker> Date: 1/2/2026 <status>Hidden state</status> </tracker> Spoken after.'
  assert.equal(stripSkippedTrackerBlocks(content, tagNames), 'Spoken before.   Spoken after.')
  assert.deepEqual(
    parseRosterVoiceSegments(
      '"Keep this." <tracker>"Do not synthesize this."</tracker> Narration remains.',
      'alice',
      [{ id: 'alice', name: 'Alice' }],
      'tracker',
    ),
    [
      { text: 'Keep this.', speakerId: 'alice' },
      { text: 'Narration remains.', speakerId: null },
    ],
  )
})

test('continues to accept previously saved paired tracker tags', () => {
  assert.deepEqual(
    parseSkippedTrackerTags('<tracker></tracker>, <status>example</status>'),
    ['tracker', 'status'],
  )
})

test('removes escaped and nested configured tracker blocks', () => {
  assert.equal(
    stripSkippedTrackerBlocks(
      'Before &lt;tracker&gt;outer <tracker>inner</tracker> tail&lt;/tracker&gt; After',
      '&lt;tracker&gt;&lt;/tracker&gt;',
    ),
    'Before   After',
  )
})

test('automatically removes raw and escaped HTML comments before playback', () => {
  const content = [
    'Spoken before.',
    '<!-- VEIL: Ruby on the balcony | Ken cannot see her -->',
    '&lt;!-- multiline hidden state:\nRuby remembers the reset --&gt;',
    'Spoken after.',
  ].join('\n')
  assert.equal(
    stripSkippedTrackerBlocks(content, ''),
    'Spoken before.\n \n \nSpoken after.',
  )
  assert.deepEqual(
    parseRosterVoiceSegments(content, 'ruby', [{ id: 'ruby', name: 'Ruby' }]),
    [{ text: 'Spoken before.\n\nSpoken after.', speakerId: null }],
  )
})

test('leaves an unclosed HTML comment intact', () => {
  assert.equal(
    stripSkippedTrackerBlocks('Before <!-- incomplete tracker After', ''),
    'Before <!-- incomplete tracker After',
  )
})

test('clamps the configurable message window', () => {
  assert.equal(clampMessageLimit(undefined), 20)
  assert.equal(clampMessageLimit(0), 1)
  assert.equal(clampMessageLimit(20.4), 20)
  assert.equal(clampMessageLimit(999), 500)
})

test('defaults and clamps the global saved audio limit', () => {
  assert.equal(clampSavedAudioLimit(undefined), 50)
  assert.equal(clampSavedAudioLimit(0), 1)
  assert.equal(clampSavedAudioLimit('75'), 75)
  assert.equal(clampSavedAudioLimit(50_000), 10_000)
})

test('replaces a saved swipe record and expires the oldest recordings', () => {
  const original = readSavedAudioHistory([
    { chatId: 'chat', messageId: 'one', audioId: 'old-one', swipeId: 0, savedAt: 10 },
    { chatId: 'chat', messageId: 'two', audioId: 'two', swipeId: 0, savedAt: 20 },
  ])
  const history = upsertSavedAudioRecord(original, {
    chatId: 'chat', messageId: 'one', audioId: 'new-one', swipeId: 0, savedAt: 30,
  })
  assert.deepEqual(history.map(record => record.audioId), ['two', 'new-one'])
  assert.deepEqual(expiredSavedAudioRecords(history, 1).map(record => record.audioId), ['two'])
})

test('detects recent assistant speakers and ignores user messages', () => {
  const messages = [
    { is_user: false, name: 'Alice' },
    { is_user: false, name: 'Bob' },
    { is_user: true, name: 'User' },
    { is_user: true, name: 'User' },
    { is_user: true, name: 'User' },
    { is_user: false, name: 'alice' },
  ]
  const detected = detectCharacters(
    messages,
    [{ id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }],
    3,
    null,
  )
  assert.deepEqual(detected, [
    { id: 'alice', name: 'Alice', messageCount: 2 },
    { id: 'bob', name: 'Bob', messageCount: 1 },
  ])
})

test('keeps a solo-chat character available before it has spoken', () => {
  assert.deepEqual(
    detectCharacters([], [{ id: 'alice', name: 'Alice' }], 20, 'alice'),
    [{ id: 'alice', name: 'Alice', messageCount: 0 }],
  )
})

test('migrates existing native voice overrides into extension config', () => {
  const config = readConfig({
    voiceOverrides: {
      narrator: { connectionId: 'tts', voice: 'narrator' },
      characters: { alice: { connectionId: 'tts', voice: 'alice-voice' } },
    },
  }, ['alice'])
  assert.equal(config.connectionId, 'tts')
  assert.equal(config.narratorVoice, 'narrator')
  assert.equal(config.characterVoices.alice, 'alice-voice')
})

test('writes native overrides while preserving unrelated character voices', () => {
  const config: ChatVoiceConfig = {
    version: 5,
    messageLimit: 20,
    connectionId: 'shared',
    narratorVoice: 'narrator',
    characterVoices: { alice: 'alice-voice', bob: '' },
    detectedCharacters: [
      { id: 'alice', name: 'Alice', messageCount: 4 },
      { id: 'bob', name: 'Bob', messageCount: 2 },
    ],
    managedCharacterIds: ['alice', 'bob'],
    parsedMessages: {},
  }
  const metadata = applyConfigToMetadata({
    untouched: true,
    voiceOverrides: {
      characters: {
        outsider: { connectionId: 'other', voice: 'other-voice' },
        bob: { connectionId: 'old', voice: 'old-bob' },
      },
    },
  }, config)
  assert.equal(metadata.untouched, true)
  assert.deepEqual(metadata.voiceOverrides, {
    narrator: { connectionId: 'shared', voice: 'narrator' },
    characters: {
      outsider: { connectionId: 'other', voice: 'other-voice' },
      alice: { connectionId: 'shared', voice: 'alice-voice' },
    },
  })
})

test('persists manual scan results for loading without rescanning messages', () => {
  const metadata = applyConfigToMetadata({}, {
    version: 5,
    messageLimit: 35,
    connectionId: '',
    narratorVoice: '',
    characterVoices: { alice: 'voice-a' },
    detectedCharacters: [{ id: 'alice', name: 'Alice', messageCount: 7 }],
    managedCharacterIds: [],
    parsedMessages: {
      message1: {
        contentHash: hashMessageContent('Alice said, "Hello."'),
        segments: [
          { text: 'Alice said,', speakerId: null },
          { text: 'Hello.', speakerId: npcSpeakerId('Alice') },
        ],
      },
    },
  })
  const restored = readConfig(metadata, ['alice'])
  assert.equal(restored.messageLimit, 35)
  assert.deepEqual(restored.detectedCharacters, [{ id: 'alice', name: 'Alice', messageCount: 7 }])
  assert.equal(restored.characterVoices.alice, 'voice-a')
  assert.deepEqual(restored.parsedMessages, metadata.chat_voice && (metadata.chat_voice as ChatVoiceConfig).parsedMessages)
})

test('validates fenced LLM segmentation and rejects unknown message IDs', () => {
  const parsed = parseLlmSegmentation({
    content: '```json\n{"messages":[{"id":"known","segments":[{"type":"narration","text":"The door opened.","speaker":null},{"type":"speech","text":"Hello.","speaker":"Alice"}]},{"id":"injected","segments":[{"type":"speech","text":"Nope","speaker":"Mallory"}]}]}\n```',
  }, new Set(['known']))
  assert.deepEqual(parsed, [{
    id: 'known',
    segments: [
      { type: 'narration', text: 'The door opened.', speaker: null },
      { type: 'speech', text: 'Hello.', speaker: 'Alice' },
    ],
  }])
})

test('validates LLM quote assignments and applies only known speaker IDs', () => {
  const assignments = parseLlmSpeakerAssignments({
    content: '```json\n{"assignments":[{"quote":0,"speakerId":"grace"},{"quote":1,"speakerId":"katie"},{"quote":2,"speakerId":"unknown"}]}\n```',
  }, new Set(['grace', 'katie']), 3)
  assert.deepEqual(assignments, [
    { quote: 0, speakerId: 'grace' },
    { quote: 1, speakerId: 'katie' },
  ])
  assert.deepEqual(
    parseRosterVoiceSegmentsWithAssignments(
      '"First."\n\n"Second."',
      'grace',
      [{ id: 'grace', name: 'Grace' }, { id: 'katie', name: 'Katie' }],
      assignments,
    ).filter(segment => segment.speakerId !== null),
    [
      { text: 'First.', speakerId: 'grace' },
      { text: 'Second.', speakerId: 'katie' },
    ],
  )
})

test('requests LLM review only for dialogue requiring historical or fallback attribution', () => {
  const speakers = [{ id: 'grace', name: 'Grace' }, { id: 'katie', name: 'Katie' }]
  assert.equal(needsLlmSpeakerReview('Grace said, "Clearly attributed."', 'grace', speakers), false)
  assert.equal(needsLlmSpeakerReview('Grace watched the door.\n\n"Who is there?"', 'grace', speakers), true)
})

test('message content hashes change when playback content changes', () => {
  assert.equal(hashMessageContent('same'), hashMessageContent('same'))
  assert.notEqual(hashMessageContent('same'), hashMessageContent('changed'))
})

test('validates card-cast extraction and rejects unknown card IDs', () => {
  const parsed = parseCardCast({
    content: '{"characters":[{"cardId":"card","name":"Alice"},{"cardId":"card","name":"Bob"},{"cardId":"other","name":"Mallory"}]}',
  }, new Set(['card']))
  assert.deepEqual(parsed, [
    { cardId: 'card', name: 'Alice' },
    { cardId: 'card', name: 'Bob' },
  ])
})

test('assigns quoted output to saved cast members using dialogue tags', () => {
  const segments = parseRosterVoiceSegments(
    'Alice said, "Hello." Bob replied, “Welcome.” The room fell quiet.',
    'card',
    [
      { id: npcSpeakerId('Alice'), name: 'Alice' },
      { id: npcSpeakerId('Bob'), name: 'Bob' },
    ],
  )
  assert.deepEqual(segments, [
    { text: 'Alice said,', speakerId: null },
    { text: 'Hello.', speakerId: npcSpeakerId('Alice') },
    { text: 'Bob replied,', speakerId: null },
    { text: 'Welcome.', speakerId: npcSpeakerId('Bob') },
    { text: 'The room fell quiet.', speakerId: null },
  ])
})

test('normalizes slash-separated speaker aliases without duplicates', () => {
  assert.deepEqual(speakerAliases(' Scott / The sergeant / scott / '), ['Scott', 'The sergeant'])
})

test('adds unique first-name aliases to scanned full names', () => {
  assert.deepEqual(addScannedFirstNameAliases([
    { id: 'al', name: 'Al Neko' },
    { id: 'sarah', name: 'Dr. Sarah Connor' },
    { id: 'zuri', name: 'Zuri' },
  ]), [
    { id: 'al', name: 'Al Neko / Al' },
    { id: 'sarah', name: 'Dr. Sarah Connor / Sarah' },
    { id: 'zuri', name: 'Zuri' },
  ])
})

test('does not add ambiguous or already-owned first-name aliases', () => {
  assert.deepEqual(addScannedFirstNameAliases([
    { id: 'john-smith', name: 'John Smith' },
    { id: 'john-doe', name: 'John Doe' },
    { id: 'al', name: 'Al' },
    { id: 'al-neko', name: 'Al Neko' },
  ]), [
    { id: 'john-smith', name: 'John Smith' },
    { id: 'john-doe', name: 'John Doe' },
    { id: 'al', name: 'Al' },
    { id: 'al-neko', name: 'Al Neko' },
  ])
})

test('merges a full scanned name into a first-name card identity', () => {
  assert.deepEqual(mergeScannedCardCast(
    [{ id: 'hailey-card', name: 'Hailey' }],
    [
      { cardId: 'hailey-card', name: 'Hailey Mercer' },
      { cardId: 'hailey-card', name: 'Zuri Vale' },
    ],
  ), [
    { id: 'hailey-card', name: 'Hailey Mercer / Hailey' },
    { id: npcSpeakerId('Zuri Vale'), name: 'Zuri Vale / Zuri' },
  ])
})

test('merges a first scanned name into a full-name card identity', () => {
  assert.deepEqual(mergeScannedCardCast(
    [{ id: 'hailey-card', name: 'Hailey Mercer' }],
    [{ cardId: 'hailey-card', name: 'Hailey' }],
  ), [
    { id: 'hailey-card', name: 'Hailey Mercer / Hailey' },
  ])
})

test('assigns every slash-separated alias to the same saved NPC voice', () => {
  const speakerId = npcSpeakerId('Scott')
  assert.deepEqual(
    parseRosterVoiceSegments(
      'Scott said, "Ready." The sergeant replied, "Move out."',
      'card',
      [{ id: speakerId, name: 'Scott / The sergeant' }],
    ),
    [
      { text: 'Scott said,', speakerId: null },
      { text: 'Ready.', speakerId },
      { text: 'The sergeant replied,', speakerId: null },
      { text: 'Move out.', speakerId },
    ],
  )
})

test('never assigns unquoted output to a character voice', () => {
  assert.deepEqual(
    parseRosterVoiceSegments('Alice said hello without quotation marks.', 'card', [{ id: 'alice', name: 'Alice' }]),
    [{ text: 'Alice said hello without quotation marks.', speakerId: null }],
  )
})

test('supports speaker attribution after a quote', () => {
  assert.deepEqual(
    parseRosterVoiceSegments('"We should go," whispered Alice.', 'card', [{ id: 'alice', name: 'Alice' }]),
    [
      { text: 'We should go,', speakerId: 'alice' },
      { text: 'whispered Alice.', speakerId: null },
    ],
  )
})

test('uses a comma-ended quote action beat to identify its speaker', () => {
  assert.deepEqual(
    parseRosterVoiceSegments(
      '"I am speaking here," Sarah looks unamused, "Please listen to me."',
      'card',
      [
        { id: 'bob', name: 'Bob' },
        { id: 'sarah', name: 'Sarah' },
        { id: 'card', name: 'Narrator Card' },
      ],
    ),
    [
      { text: 'I am speaking here,', speakerId: 'sarah' },
      { text: 'Sarah looks unamused,', speakerId: null },
      { text: 'Please listen to me.', speakerId: 'sarah' },
    ],
  )
})

test('assigns every quote to the sole character named in its paragraph', () => {
  assert.deepEqual(
    parseRosterVoiceSegments(
      '"Then take them out on him!" Zuri is already crawling aside, surrendering her place at his left hand. "Talk your talk, captain. I\'ll hold his hand and be the gauge."',
      'card',
      [
        { id: 'zuri', name: 'Zuri' },
        { id: 'card', name: 'Narrator Card' },
      ],
    ),
    [
      { text: 'Then take them out on him!', speakerId: 'zuri' },
      {
        text: 'Zuri is already crawling aside, surrendering her place at his left hand.',
        speakerId: null,
      },
      { text: "Talk your talk, captain. I'll hold his hand and be the gauge.", speakerId: 'zuri' },
    ],
  )
})

test('uses a clear main-clause subject when narration names multiple characters', () => {
  assert.deepEqual(
    parseRosterVoiceSegments(
      '"Move!" Zuri watches Alma cross the room.',
      'card',
      [{ id: 'zuri', name: 'Zuri' }, { id: 'alma', name: 'Alma' }],
    )[0],
    { text: 'Move!', speakerId: 'zuri' },
  )
})

test('continues a confidently identified speaker across same-paragraph narration', () => {
  const content = '"The board\'s right here," Alma said. She was already at the kit-roll with her good hand on the coupling block, the splinted arm holding the coil against her ribs. "But the mast is up there and we are down here. Anybody want to volunteer?"'
  assert.deepEqual(
    parseRosterVoiceSegments(content, 'card', [
      { id: 'alma', name: 'Alma' },
      { id: 'card', name: 'Narrator Card' },
    ]),
    [
      { text: "The board's right here,", speakerId: 'alma' },
      {
        text: 'Alma said. She was already at the kit-roll with her good hand on the coupling block, the splinted arm holding the coil against her ribs.',
        speakerId: null,
      },
      {
        text: 'But the mast is up there and we are down here. Anybody want to volunteer?',
        speakerId: 'alma',
      },
    ],
  )
})

test('inherits the nearest confident speaker across an unnamed paragraph break', () => {
  assert.deepEqual(
    parseRosterVoiceSegments(
      '"First," Alma said.\n\nThe scene changes. "Unattributed."',
      'card',
      [{ id: 'alma', name: 'Alma' }, { id: 'card', name: 'Narrator Card' }],
    ),
    [
      { text: 'First,', speakerId: 'alma' },
      { text: 'Alma said.\n\nThe scene changes.', speakerId: null },
      { text: 'Unattributed.', speakerId: 'alma' },
    ],
  )
})

test('searches upward through unnamed paragraphs for the nearest confident speaker', () => {
  const segments = parseRosterVoiceSegments(
    '"Third thing." Hailey settles back and finishes her explanation.\n\n"The fourth thing I cannot say. I have to show it."\n\nHer hands move with calm purpose and she considers the next step.\n\n"I do not know how to do this part without a plan," she says. "So watch me while it happens."',
    'card',
    [
      { id: 'hailey', name: 'Hailey' },
      { id: 'card', name: 'Narrator Card' },
    ],
  )
  assert.deepEqual(
    segments.filter(segment => segment.speakerId !== null),
    [
      { text: 'Third thing.', speakerId: 'hailey' },
      { text: 'The fourth thing I cannot say. I have to show it.', speakerId: 'hailey' },
      { text: 'I do not know how to do this part without a plan,', speakerId: 'hailey' },
      { text: 'So watch me while it happens.', speakerId: 'hailey' },
    ],
  )
})

test('prefers a clean character name over another character possessive', () => {
  const segments = parseRosterVoiceSegments(
    'Kansai watched her go. At the sink, Al Neko\'s hands rested under the running water.\n\n"She will be back at midnight," she said. "For the ramen. Just so you know."',
    'card',
    [
      { id: 'kansai', name: 'Kansai' },
      { id: 'al-neko', name: 'Al Neko' },
    ],
  )
  assert.deepEqual(
    segments.filter(segment => segment.speakerId !== null),
    [
      { text: 'She will be back at midnight,', speakerId: 'kansai' },
      { text: 'For the ramen. Just so you know.', speakerId: 'kansai' },
    ],
  )
})

test('uses a sole possessive name when no clean character name is present', () => {
  assert.deepEqual(
    parseRosterVoiceSegments(
      'Al Neko’s hands rested under the running water.\n\n"Ready."',
      'card',
      [{ id: 'al-neko', name: 'Al Neko' }],
    ).at(-1),
    { text: 'Ready.', speakerId: 'al-neko' },
  )
})

test('backfills opening dialogue from a main-clause speech possessor', () => {
  const content = '"And there is one star in Sweetwater."\n\n"That is how it has been. That is how it is."\n\nColton\'s voice comes off the porch before Tess can tap the tablet. He sits with the pocket watch still open in his palm and looks at Ken across the width of the street.\n\nTess glances toward the porch, then back to Ken.\n\n"The badge is a standard guest selection, Sheriff." She pitches her voice to carry the ten yards.'
  const segments = parseRosterVoiceSegments(content, 'card', [
    { id: 'colton', name: 'Colton' },
    { id: 'tess', name: 'Tess' },
    { id: 'ken', name: 'Ken' },
    { id: 'card', name: 'Narrator Card' },
  ])
  assert.deepEqual(segments.filter(segment => segment.speakerId !== null), [
    { text: 'And there is one star in Sweetwater.', speakerId: 'colton' },
    { text: 'That is how it has been. That is how it is.', speakerId: 'colton' },
    { text: 'The badge is a standard guest selection, Sheriff.', speakerId: 'tess' },
  ])
})

test('does not use downstream backfill after a preceding character is established', () => {
  const segments = parseRosterVoiceSegments(
    'Alma checks the road.\n\n"Opening speech."\n\nColton\'s voice comes from the porch before Tess can answer.',
    'card',
    [
      { id: 'alma', name: 'Alma' },
      { id: 'colton', name: 'Colton' },
      { id: 'tess', name: 'Tess' },
      { id: 'card', name: 'Narrator Card' },
    ],
  )
  assert.deepEqual(segments.find(segment => segment.text === 'Opening speech.'), {
    text: 'Opening speech.', speakerId: 'alma',
  })
})

test('uses a downstream narrative subject for an ambiguous reply in a dialogue chain', () => {
  const content = 'Tess glances toward the porch, then back to Ken. Her thumb hovers over the screen.\n\n"The badge is a standard guest selection, Sheriff." She pitches her voice to carry the ten yards. "Guest wants it, guest gets it. That is the arrangement."\n\n"Did not say he could not."\n\nColton closes the watch with a click and stands. Taller sitting than standing.'
  const segments = parseRosterVoiceSegments(content, 'card', [
    { id: 'tess', name: 'Tess' },
    { id: 'ken', name: 'Ken' },
    { id: 'colton', name: 'Colton' },
    { id: 'card', name: 'Narrator Card' },
  ])
  assert.deepEqual(segments.find(segment => segment.text === 'Did not say he could not.'), {
    text: 'Did not say he could not.', speakerId: 'colton',
  })
})

test('keeps dialogue with a configured role named in the preceding paragraph', () => {
  const content = 'Tess studies the screen.\n\n"The coat and the star are with the Sheriff."\n\nFrom the general store across the way, a shopkeeper in a leather apron comes out carrying a wooden case. He crosses the street and sets it at Ken\'s feet, then walks back.\n\n"Coat is in the office. Been worn before—but it will fit."\n\nColton stands in the open doorway now, waiting.\n\n"Well? You coming or not?"'
  const segments = parseRosterVoiceSegments(content, 'tess', [
    { id: 'tess', name: 'Tess' },
    { id: 'ken', name: 'Ken' },
    { id: 'shopkeeper', name: 'Shopkeeper' },
    { id: 'colton', name: 'Colton' },
  ])
  assert.deepEqual(
    segments.filter(segment => segment.speakerId !== null).slice(-2),
    [
      { text: 'Coat is in the office. Been worn before—but it will fit.', speakerId: 'shopkeeper' },
      { text: 'Well? You coming or not?', speakerId: 'colton' },
    ],
  )
})

test('anchors leading dialogue to the sole character in the preceding paragraph', () => {
  const content = 'Toggard rode the last hundred yards out ahead without being asked, dropped from the bay at the bank stones, and stood looking at the water a long moment before he came back.\n\n"It\'s up. The crossing is possible, but it is a ford you walk, not a ford you ride." He wiped his wet hands on his breeches. "There\'s flat ground back under the alders."'
  assert.deepEqual(
    parseRosterVoiceSegments(content, 'card', [
      { id: 'toggard', name: 'Toggard' },
      { id: 'card', name: 'Narrator Card' },
    ]),
    [
      {
        text: 'Toggard rode the last hundred yards out ahead without being asked, dropped from the bay at the bank stones, and stood looking at the water a long moment before he came back.',
        speakerId: null,
      },
      {
        text: "It's up. The crossing is possible, but it is a ford you walk, not a ford you ride.",
        speakerId: 'toggard',
      },
      { text: 'He wiped his wet hands on his breeches.', speakerId: null },
      { text: "There's flat ground back under the alders.", speakerId: 'toggard' },
    ],
  )
})

test('inherits a clear main-clause subject from a paragraph with multiple characters', () => {
  assert.deepEqual(
    parseRosterVoiceSegments(
      'Alma watched Bob cross the room.\n\n"Unattributed."',
      'card',
      [{ id: 'alma', name: 'Alma' }, { id: 'bob', name: 'Bob' }],
    ).at(-1),
    { text: 'Unattributed.', speakerId: 'alma' },
  )
})

test('keeps coordinated main-clause subjects ambiguous', () => {
  assert.deepEqual(
    parseRosterVoiceSegments(
      'Yaniko and Kansai raise their cups together.\n\n"Unattributed."',
      'card',
      [{ id: 'yaniko', name: 'Yaniko' }, { id: 'kansai', name: 'Kansai' }],
    ).at(-1),
    { text: 'Unattributed.', speakerId: 'card' },
  )
})

test('prefers the main subject over a name in a reduced relative clause', () => {
  const segments = parseRosterVoiceSegments(
    'Yaniko opened her mouth, closed it, and reached for the paper cup Kansai had given her. She drank and set it down.\n\n"Yaku is coming later," she said. "For the ramen. Just so you know."',
    'card',
    [{ id: 'yaniko', name: 'Yaniko' }, { id: 'kansai', name: 'Kansai' }],
  )
  assert.deepEqual(segments.filter(segment => segment.speakerId !== null), [
    { text: 'Yaku is coming later,', speakerId: 'yaniko' },
    { text: 'For the ramen. Just so you know.', speakerId: 'yaniko' },
  ])
})

test('keeps every unattributed quote on the inherited discourse subject', () => {
  const segments = parseRosterVoiceSegments(
    'Yaniko opened her mouth. Closed it. Opened it again. She reached for the paper cup Kansai had given her. She drank and set it down.\n\n"Yaku is coming later, nya," she said to no one. "She was feeding someone\'s cat, nya. That\'s why she\'s not here." A pause.\n\n"Hame\'s not coming. Her stream went long. Like I said."',
    'card',
    [{ id: 'yaniko', name: 'Yaniko' }, { id: 'kansai', name: 'Kansai' }],
  )
  assert.deepEqual(segments.filter(segment => segment.speakerId !== null), [
    { text: 'Yaku is coming later, nya,', speakerId: 'yaniko' },
    { text: "She was feeding someone's cat, nya. That's why she's not here.", speakerId: 'yaniko' },
    { text: "Hame's not coming. Her stream went long. Like I said.", speakerId: 'yaniko' },
  ])
})

test('does not let a nearby secondary name override the paragraph subject for one quote', () => {
  assert.deepEqual(
    parseRosterVoiceSegments(
      'Yaniko picked up the cup Kansai had given her. "First." She paused. "Second."',
      'card',
      [{ id: 'yaniko', name: 'Yaniko' }, { id: 'kansai', name: 'Kansai' }],
    ).filter(segment => segment.speakerId !== null),
    [
      { text: 'First.', speakerId: 'yaniko' },
      { text: 'Second.', speakerId: 'yaniko' },
    ],
  )
})

test('does not treat a name addressed inside dialogue as the speaker', () => {
  const segments = parseRosterVoiceSegments(
    '"He said my name." Zuri\'s whisper arrives from the pillow, small and stunned, her grip on his hand slackening by a fraction. "He\'s holding it for me. He\'s— Hailey, I don\'t need it, I don\'t, he can give it to you, I just—"\n\n"Stop offering yourself away." Grace, dry from the headboard, one green eye open. "You did it with your turn. You\'re doing it again. Take the gift, Zuri."',
    'card',
    [
      { id: 'zuri', name: 'Zuri' },
      { id: 'grace', name: 'Grace' },
      { id: 'hailey', name: 'Hailey' },
    ],
  )
  assert.deepEqual(segments.filter(segment => segment.speakerId !== null), [
    { text: 'He said my name.', speakerId: 'zuri' },
    {
      text: "He's holding it for me. He's— Hailey, I don't need it, I don't, he can give it to you, I just—",
      speakerId: 'zuri',
    },
    { text: 'Stop offering yourself away.', speakerId: 'grace' },
    { text: "You did it with your turn. You're doing it again. Take the gift, Zuri.", speakerId: 'grace' },
  ])
})

test('keeps an appositive speaker across stored rich-text variants', () => {
  const speakers = [
    { id: 'zuri', name: 'Zuri' },
    { id: 'grace', name: 'Grace' },
    { id: 'hailey', name: 'Hailey' },
  ]
  const variants = [
    '"First." Zuri\'s hand relaxes. "Still Zuri."\n"Stop." Grace, dry from the headboard. "Take the gift, Zuri."',
    '"First." Zuri\'s hand relaxes. "Still Zuri."\n\n"Stop." {Grace, dry from the headboard. "Take the gift, Zuri."',
    '<font color="#f0f">"First."</font> Zuri\'s hand relaxes. <font color="#f0f">"Still Zuri."</font><br><br><font color="#0f0">"Stop."</font> Grace, dry from the headboard. <font color="#0f0">"Take the gift, Zuri."</font>',
    '&lt;font color=&quot;#f0f&quot;&gt;"First."&lt;/font&gt; Zuri\'s hand relaxes. "Still Zuri."&lt;br&gt;&lt;br&gt;"Stop." Grace, dry from the headboard. "Take the gift, Zuri."',
    '“First.” Zuri’s hand relaxes. “Still Zuri.”\n\n“Stop.” Grace, dry from the headboard. “Take the gift, Zuri.”',
  ]
  for (const content of variants) {
    assert.deepEqual(
      parseRosterVoiceSegments(content, 'zuri', speakers).filter(segment => segment.speakerId !== null).at(-1),
      { text: 'Take the gift, Zuri.', speakerId: 'grace' },
    )
  }
})

test('alternates unresolved turns in a confidently seeded dialogue chain', () => {
  const segments = parseRosterVoiceSegments(
    '"It is working, but hear me first," Alma called down. "Receiving is clean."\n\n"One hop reaches who?" Vahn said.\n\n"The repeater broadcasts what it receives. A reply takes a person on the other end." A pause. "So we can send two sentences before going mute."\n\n"Then I understand."',
    'card',
    [{ id: 'alma', name: 'Alma' }, { id: 'vahn', name: 'Vahn' }],
  )
  assert.deepEqual(segments.filter(segment => segment.speakerId !== null), [
    { text: 'It is working, but hear me first,', speakerId: 'alma' },
    { text: 'Receiving is clean.', speakerId: 'alma' },
    { text: 'One hop reaches who?', speakerId: 'vahn' },
    {
      text: 'The repeater broadcasts what it receives. A reply takes a person on the other end.',
      speakerId: 'alma',
    },
    { text: 'So we can send two sentences before going mute.', speakerId: 'alma' },
    { text: 'Then I understand.', speakerId: 'vahn' },
  ])
})

test('preserves a dialogue seed across a history-attributed continuation before alternating', () => {
  const segments = parseRosterVoiceSegments(
    `"Rugged, honest, and made for the work," Grace repeats from the other side of the glass. "You just described a pen and accidentally described yourself."

"I say that with authority," she adds, quieter. "I have bought instruments. The pretty ones hang on the wall."

"Then that is the one." Katie unfolds from the wall and arrives at the case. "Household lists, the treaty, the cursive. It all goes through that pen."

"I would never."

"You were three sentences from it."`,
    'card',
    [{ id: 'grace', name: 'Grace' }, { id: 'katie', name: 'Katie' }],
  )
  assert.deepEqual(segments.filter(segment => segment.speakerId !== null), [
    { text: 'Rugged, honest, and made for the work,', speakerId: 'grace' },
    { text: 'You just described a pen and accidentally described yourself.', speakerId: 'grace' },
    { text: 'I say that with authority,', speakerId: 'grace' },
    { text: 'I have bought instruments. The pretty ones hang on the wall.', speakerId: 'grace' },
    { text: 'Then that is the one.', speakerId: 'katie' },
    { text: 'Household lists, the treaty, the cursive. It all goes through that pen.', speakerId: 'katie' },
    { text: 'I would never.', speakerId: 'grace' },
    { text: 'You were three sentences from it.', speakerId: 'katie' },
  ])
})

test('seeds a dialogue chain from a confidently inherited speaker before a named reply', () => {
  const segments = parseRosterVoiceSegments(
    '"Do not talk," Alma called down. Not to anyone.\n\nThe yard obeyed. Frost ticked on the tarp ropes. Somewhere behind the pile of roped crates a civilian shifted in his blanket and stopped himself.\n\nThen Alma\'s good hand came down over the rail and made a shape in the lantern light: hold, hold, hold.\n\n"Logistics net, same as before," she said, finally. "But it is not fragments anymore. Somebody up the line is running an open schedule."\n\nVahn came off the pump. "Which posts still talk."\n\n"Seven through 14. We are eleven. So the order is addressed to us." Her voice thinned at the edges. "Nobody accuses me later of sugar."',
    'card',
    [{ id: 'alma', name: 'Alma' }, { id: 'vahn', name: 'Vahn' }],
  )
  assert.deepEqual(segments.filter(segment => segment.speakerId !== null).slice(-5), [
    { text: 'Logistics net, same as before,', speakerId: 'alma' },
    {
      text: 'But it is not fragments anymore. Somebody up the line is running an open schedule.',
      speakerId: 'alma',
    },
    { text: 'Which posts still talk.', speakerId: 'vahn' },
    { text: 'Seven through 14. We are eleven. So the order is addressed to us.', speakerId: 'alma' },
    { text: 'Nobody accuses me later of sugar.', speakerId: 'alma' },
  ])
})

test('keeps a dialogue chain across a short unnamed narrative beat', () => {
  assert.deepEqual(
    parseRosterVoiceSegments(
      '"First," Alma said.\n\n"Second," Vahn replied.\n\nA pause.\n\n"Third."',
      'card',
      [{ id: 'alma', name: 'Alma' }, { id: 'vahn', name: 'Vahn' }],
    ).at(-1),
    { text: 'Third.', speakerId: 'alma' },
  )
})

test('keeps the last clear speaker across a downstream narrative-heavy ambiguous run', () => {
  const segments = parseRosterVoiceSegments(
    '"Kid is right." Grace watches Hailey. "You made the confession."\n\n"It is not a slide—" Hailey stops. Her hands go still on him, both of them resting against him while she considers what to say next.\n\n"Fine. No steps." Her forehead presses against his shoulder, the position she chose holding her up while a wall holds up a person who has stopped bracing. "The fourth thing, I learned watching the footage is that when you came on their faces, you looked at each of them. All four. Before you let go." Her thumb traces the vein beneath her fist, slow, once. "Nobody in my life has ever looked at me before letting go."\n\nHer mouth finds the place where his shoulder meets his chest—not the crown, not the shaft, the wrong place entirely for worship and the exact right place for what she is actually doing—and she presses her lips there and holds, breathing through the contact.\n\n"So that is the fourth item." The words arrive against his skin. "You look at me when you are close, and I will know I am not the girl someone leaves in a room afterward."',
    'card',
    [{ id: 'grace', name: 'Grace' }, { id: 'hailey', name: 'Hailey' }],
  )
  assert.deepEqual(
    segments.filter(segment => segment.speakerId !== null).slice(3),
    [
      { text: 'Fine. No steps.', speakerId: 'hailey' },
      {
        text: 'The fourth thing, I learned watching the footage is that when you came on their faces, you looked at each of them. All four. Before you let go.',
        speakerId: 'hailey',
      },
      { text: 'Nobody in my life has ever looked at me before letting go.', speakerId: 'hailey' },
      { text: 'So that is the fourth item.', speakerId: 'hailey' },
      {
        text: 'You look at me when you are close, and I will know I am not the girl someone leaves in a room afterward.',
        speakerId: 'hailey',
      },
    ],
  )
})

test('explicitly attributed dialogue overrides surrounding Hailey and Grace context', () => {
  const segments = parseRosterVoiceSegments(
    'Hailey\'s breath fractures when his hands close over her breasts, and she has not once acknowledged them.\n\n"You are supposed to be losing control at my pace," she manages. "Not while I am trying to demonstrate the fourth item."\n\n"She is stalling," Zuri whispers into the pillow, her eyes enormous, his hand still white-knuckled in hers. "The fourth item is not a sequence. It is the thing she is afraid of."\n\n"Kid is right." Grace, against the headboard, her green eyes open now, tracking the flush climbing Hailey\'s collarbone. "Captain, you have been counting steps."',
    'hailey',
    [
      { id: 'hailey', name: 'Hailey' },
      { id: 'zuri', name: 'Zuri' },
      { id: 'grace', name: 'Grace' },
    ],
  )
  assert.deepEqual(segments.filter(segment => segment.speakerId !== null), [
    { text: 'You are supposed to be losing control at my pace,', speakerId: 'hailey' },
    { text: 'Not while I am trying to demonstrate the fourth item.', speakerId: 'hailey' },
    { text: 'She is stalling,', speakerId: 'zuri' },
    { text: 'The fourth item is not a sequence. It is the thing she is afraid of.', speakerId: 'zuri' },
    { text: 'Kid is right.', speakerId: 'grace' },
    { text: 'Captain, you have been counting steps.', speakerId: 'grace' },
  ])
})

test('breaks dialogue alternation after substantive pure narration', () => {
  assert.deepEqual(
    parseRosterVoiceSegments(
      '"First," Alma said.\n\n"Second," Vahn replied.\n\nThe group crossed the valley in silence while the weather worsened around them and the road disappeared beneath fresh snow for the rest of the afternoon.\n\n"Unattributed."',
      'card',
      [{ id: 'alma', name: 'Alma' }, { id: 'vahn', name: 'Vahn' }],
    ).at(-1),
    { text: 'Unattributed.', speakerId: 'vahn' },
  )
})

test('distinguishes main subjects from objects and passive agents', () => {
  const speakers = [{ id: 'yaniko', name: 'Yaniko' }, { id: 'kansai', name: 'Kansai' }]
  for (const narration of [
    'Yaniko takes the cup that Kansai had given her.',
    'Yaniko receives the cup from Kansai.',
    'Yaniko is handed the cup by Kansai.',
  ]) {
    assert.deepEqual(
      parseRosterVoiceSegments(`${narration}\n\n"Thank you."`, 'card', speakers).at(-1),
      { text: 'Thank you.', speakerId: 'yaniko' },
    )
  }
  assert.deepEqual(
    parseRosterVoiceSegments('Kansai gives Yaniko the cup.\n\n"There."', 'card', speakers).at(-1),
    { text: 'There.', speakerId: 'kansai' },
  )
})

test('does not continue a speaker after another roster character is introduced', () => {
  assert.deepEqual(
    parseRosterVoiceSegments(
      '"First," Alma said. Bob entered the workshop, checked every latch along the far wall, and silently pointed toward the exit. "Unattributed."',
      'card',
      [
        { id: 'alma', name: 'Alma' },
        { id: 'bob', name: 'Bob' },
        { id: 'card', name: 'Narrator Card' },
      ],
    ).at(-1),
    { text: 'Unattributed.', speakerId: 'card' },
  )
})

test('strips HTML tags and emphasis markers before TTS segmentation', () => {
  assert.deepEqual(
    parseRosterVoiceSegments('<font color="#4169E1">"One more,"</font> *she whispered.*', 'alice', []),
    [
      { text: 'One more,', speakerId: 'alice' },
      { text: 'she whispered.', speakerId: null },
    ],
  )
  assert.deepEqual(
    parseRosterVoiceSegments('&lt;font color=&quot;#4169E1&quot;&gt;"Again."&lt;/font&gt;', 'alice', []),
    [{ text: 'Again.', speakerId: 'alice' }],
  )
})

test('inherits an identity-free single speaker from the previous assistant message', () => {
  const speakers = [
    { id: 'mara', name: 'Mara' },
    { id: 'jayden', name: 'Jayden' },
  ]
  const current = [
    'Her hand closes over his.',
    '',
    '"That is my hand."',
    '',
    'She says it low, to nobody.',
    '',
    '"Do not mess this up."',
    '',
    '"Get the book first, Jayden."',
  ].join('\n')
  const historicalSpeakerId = previousAssistantSpeakerFallback(
    current,
    'Mara pulls the blanket over one shoulder. "I should go."',
    null,
    speakers,
  )
  assert.equal(historicalSpeakerId, 'mara')
  assert.deepEqual(
    parseRosterVoiceSegments(current, null, speakers, '', historicalSpeakerId)
      .filter(segment => segment.speakerId !== null)
      .map(segment => segment.speakerId),
    ['mara', 'mara', 'mara'],
  )
})

test('does not inherit history over current attribution or conflicting anonymous speakers', () => {
  const speakers = [
    { id: 'mara', name: 'Mara' },
    { id: 'grace', name: 'Grace' },
  ]
  assert.equal(
    previousAssistantSpeakerFallback(
      'Grace said, "I have this."',
      'Mara watched the door.',
      null,
      speakers,
    ),
    null,
  )
  assert.equal(
    previousAssistantSpeakerFallback(
      '"Wait," she said. "No," he replied.',
      'Mara watched the door.',
      null,
      speakers,
    ),
    null,
  )
})

test('detects multiple named NPCs written by one character card', () => {
  const detected = detectCharacters([{
    is_user: false,
    name: 'World Narrator',
    content: 'Alice: "Hello there."\nBob: “Welcome inside.”',
  }], [{ id: 'card', name: 'World Narrator' }], 20, 'card')

  assert.deepEqual(detected, [
    { id: npcSpeakerId('Bob'), name: 'Bob', messageCount: 1 },
    { id: npcSpeakerId('Alice'), name: 'Alice', messageCount: 1 },
    { id: 'card', name: 'World Narrator', messageCount: 1 },
  ])
})

test('builds ordered narrator and named-NPC playback segments', () => {
  const segments = parseMultiVoiceSegments(
    'The door opens.\nAlice: "Hello there."\nBob: “Welcome inside.”\nThe room falls quiet.',
    'card',
  )
  assert.deepEqual(segments, [
    { text: 'The door opens.', speakerId: null },
    { text: 'Hello there.', speakerId: npcSpeakerId('Alice') },
    { text: 'Welcome inside.', speakerId: npcSpeakerId('Bob') },
    { text: 'The room falls quiet.', speakerId: null },
  ])
})

test('uses group message character IDs before ambiguous display names', () => {
  const detected = detectCharacters([{
    is_user: false,
    name: 'Shared Name',
    extra: { character_id: 'second' },
  }], [
    { id: 'first', name: 'Shared Name' },
    { id: 'second', name: 'Shared Name' },
  ], 20, null)
  assert.deepEqual(detected, [{ id: 'second', name: 'Shared Name', messageCount: 1 }])
})
