import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyConfigToMetadata,
  clampMessageLimit,
  detectCharacters,
  readConfig,
  type ChatVoiceConfig,
} from './core'

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
    version: 3,
    messageLimit: 20,
    connectionId: 'shared',
    narratorVoice: 'narrator',
    characterVoices: { alice: 'alice-voice', bob: '' },
    detectedCharacters: [{ id: 'alice', messageCount: 4 }, { id: 'bob', messageCount: 2 }],
    managedCharacterIds: ['alice', 'bob'],
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
    version: 3,
    messageLimit: 35,
    connectionId: '',
    narratorVoice: '',
    characterVoices: { alice: 'voice-a' },
    detectedCharacters: [{ id: 'alice', messageCount: 7 }],
    managedCharacterIds: [],
  })
  const restored = readConfig(metadata, ['alice'])
  assert.equal(restored.messageLimit, 35)
  assert.deepEqual(restored.detectedCharacters, [{ id: 'alice', messageCount: 7 }])
  assert.equal(restored.characterVoices.alice, 'voice-a')
})
