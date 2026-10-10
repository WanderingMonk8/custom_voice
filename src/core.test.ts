import assert from 'node:assert/strict'
import test from 'node:test'
import {
  addScannedFirstNameAliases,
  applyConfigToMetadata,
  clampMessageLimit,
  detectCharacters,
  encodeConcatenatedWav,
  hashMessageContent,
  mergeVoicePlan,
  npcSpeakerId,
  parseCardCast,
  parseLlmSegmentation,
  parseMultiVoiceSegments,
  parseRosterVoiceSegments,
  readConfig,
  speakerAliases,
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

test('clamps the configurable message window', () => {
  assert.equal(clampMessageLimit(undefined), 20)
  assert.equal(clampMessageLimit(0), 1)
  assert.equal(clampMessageLimit(20.4), 20)
  assert.equal(clampMessageLimit(999), 500)
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
