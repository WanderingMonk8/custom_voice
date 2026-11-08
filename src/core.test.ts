import assert from 'node:assert/strict'
import test from 'node:test'
import { AutoplayRequestRegistry, PlaybackLongPress, PlaybackStartupGuard, syncAutoplayIndicators, syncPlaybackButtons, waitForAutoplayDeadline, waitForAutoplayWork, type PlaybackButtonState } from './playback-ui'
import { evaluateSpeakerReviews } from './speaker-review-evaluation'
import {
  adaptiveGenerationConcurrency,
  addScannedFirstNameAliases,
  addUnconfiguredDialogueSpeakers,
  addFavoriteVoice,
  mergeScannedCardCast,
  isScenarioCardTitle,
  continueUncastClosingSpeech,
  continuityRosterIdentity,
  applyConfigToMetadata,
  applyCustomTtsEmotionCues,
  applyCustomTtsEmotionCuesWithModulation,
  applyLeadingTtsCues,
  applyTtsSpeakerContinuity,
  applyTtsTagSelections,
  assessSpeakerDiscourseEscalation,
  buildSpeakerDecisionPlan,
  snapshotSpeakerFirstPass,
  speakerAssignmentSourceFromTrace,
  buildAssistantUserSpeakerReview,
  buildContextualUserReconciliation,
  applyContextualUserReconciliation,
  buildRelationshipSpeakerReview,
  independentlyGroundedSpeakerIds,
  suppressUngroundedSpeakerChoices,
  buildOpeningSpeakerReview,
  buildBoundaryExchangeShadowReview,
  applyOpeningExchangeReview,
  buildOpeningBacklinkReview,
  buildContrastiveOpeningLinkReview,
  applyFocusedOpeningFallback,
  standardSpeakerReviewPolicy,
  autoplayGenerationEvent,
  autoplaySwipeSnapshot,
  autoplaySwipeMatches,
  refreshAutoplaySwipe,
  readMessageSwipeContent,
  targetSwipeContentMatches,
  swipeSynthesisKey,
  savedAudioMatchesSwipe,
  automaticPlaybackSkipReason,
  claimAutoplayGeneration,
  hasAudioForActiveSwipe,
  readAutomaticVoicePreferences,
  readAutoplayDelaySeconds,
  globalTtsConnectionPreference,
  resolveGlobalTtsConnection,
  buildBestAvailableSpeakerReview,
  applyBestAvailableSpeakerReview,
  buildSelfIntroductionReview,
  applySelfIntroductionReview,
  applyExplicitPostQuoteVoiceAttributions,
  buildSpeakerSwitchContradictionReview,
  applySpeakerSwitchContradictionReview,
  applyNarrativeRoleSpeakerReview,
  applyNarrativeExchangeSpeakerReview,
  applyNarrativeLocalEvidenceReview,
  applyContestedDialogueChain,
  applyOpeningBacklinkReview,
  invalidSpeakerReviewAnswers,
  applyRelationshipSpeakerReview,
  previousContinuitySpeaker,
  previousNamedGhostContinuity,
  lookbackSpeakerContinuity,
  CONTINUITY_LOOKBACK_BLOCKED,
  recoverPreviousGhostContinuity,
  relationshipReviewContext,
  applyAssistantUserSpeakerReview,
  buildTtsTagPlan,
  bufferAwareGenerationConcurrency,
  availableUncastVoices,
  canReserveAutomaticVoice,
  selectAutomaticVoice,
  activeGhostVoices,
  purgeExpiredGhostContexts,
  markGhostVoiceInvoked,
  collectUncastVoiceGroups,
  ghostCastAliases,
  updateGhostConversationHistory,
  uncastIdentityLabels,
  mergeGhostAliases,
  readGhostVoices,
  recordGhostOccurrence,
  buildUncastVoiceDecision,
  buildUncastIdentityReview,
  resolveUncastVoiceDecisions,
  clampMessageLimit,
  clampSavedAudioLimit,
  detectCharacters,
  decodeSpeakerChain,
  eligibleCardFallbackSpeakerId,
  encodeConcatenatedWav,
  evaluateSpeakerDecisionAnswer,
  expiredSavedAudioRecords,
  formatTtsTag,
  hashMessageContent,
  hasNamedSpeakerMention,
  hasNamedSpeakerSubject,
  mergeVoicePlan,
  filterNarrationSegments,
  markUnresolvedSpeechSegments,
  normalizeSpeechBoundaryDashes,
  normalizeTtsTags,
  normalizeCustomTtsEmotionTag,
  npcSpeakerId,
  needsLlmSpeakerReview,
  parseCardCast,
  parseLlmSegmentation,
  parseLlmSpeakerAssignments,
  parseMultiVoiceSegments,
  parseRosterVoiceSegments,
  parseRosterVoiceSegmentsWithAssignments,
  parseSkippedTrackerTags,
  parseSkippedTrackerTagPairs,
  playbackVoiceForSpeaker,
  preferredCardSpeakerId,
  protectDefaultSpeakerSegments,
  previousAssistantSpeakerFallback,
  reducedRequestWindowLimit,
  readConfig,
  readSavedAudioHistory,
  readFavoriteVoices,
  resolveSpeakerDecisionSegments,
  resolveSpeakerDiscourseAnswers,
  resolveTtsTagAnswers,
  speakerAliases,
  speakerAliasIdLookup,
  speakerIdMatchingCardTitle,
  speakerReviewQuoteIndexes,
  speakersForMessageRole,
  shouldPersistMessageAudio,
  splitLargeVoicePlanSegments,
  rollingRequestWindowDelay,
  SPEAKER_DECISION_THRESHOLDS,
  TTS_MODULATION_MARKER,
  stripSkippedTrackerBlocks,
  stripTtsTags,
  unconfiguredSpeakerId,
  UNCAST_SPEAKER_ID,
  UNRESOLVED_SPEAKER_ID,
  USER_SPEAKER_ID,
  upsertSavedAudioRecord,
  validateTtsSpeechPlacement,
  validateTtsTagPlacement,
  type ChatVoiceConfig,
  type SpeakerDecisionChoice,
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

test('builds batched Jev questions and resolves speaker policy after semantic decisions', () => {
  const content = [
    'Ruby closes the door. "I am staying."',
    '',
    'The clerk checks the register. "That will be all."',
    '',
    '"One more thing."',
  ].join('\n')
  const speakers = [
    { id: 'naomi', name: 'Naomi' },
    { id: 'ruby', name: 'Ruby' },
  ]
  const plan = buildSpeakerDecisionPlan(content, speakers, false)
  const confident = (choice: string) => ({
    type: 'choice' as const,
    choice,
    probabilities: { [choice]: 0.92, no_clear_identity: 0.08 },
    confidence: 0.9,
  })
  const rubyOption = Object.entries(plan.optionSpeakerIds)
    .find(([, speakerId]) => speakerId === 'ruby')?.[0]
  assert.ok(rubyOption)
  assert.equal(plan.state.paragraphs.length, 3)
  assert.equal(plan.state.speeches.length, 3)
  assert.deepEqual(plan.state.turns.map(turn => turn.speechId), ['s1', 's2'])
  assert.ok(plan.questions.turn_s1)
  assert.ok(plan.questions.turn_s2)
  assert.equal(plan.questions.turn_s0, undefined)
  assert.equal(Object.keys(plan.questions).length, 8)

  const segments = resolveSpeakerDecisionSegments(
    content,
    plan,
    {
      paragraph_p0: confident(rubyOption),
      speech_s0: confident(rubyOption),
      paragraph_p1: confident('uncast_character'),
      speech_s1: confident('uncast_character'),
      paragraph_p2: confident('no_clear_identity'),
      speech_s2: confident('no_clear_identity'),
    },
    speakers,
    {
      isUserMessage: false,
      cardSpeakerId: 'naomi',
      historicalSpeakerId: null,
    },
  ).filter(segment => ['I am staying.', 'That will be all.', 'One more thing.'].includes(segment.text))

  assert.deepEqual(segments.map(segment => segment.speakerId), [
    'ruby',
    UNCAST_SPEAKER_ID,
    UNCAST_SPEAKER_ID,
  ])
})

test('Jev resolver carries narration-only identity into later ambiguous speech', () => {
  const content = ['Ruby enters the room.', '', '"I brought the ledger."'].join('\n')
  const speakers = [{ id: 'ruby', name: 'Ruby' }]
  const plan = buildSpeakerDecisionPlan(content, speakers, false)
  const rubyOption = Object.entries(plan.optionSpeakerIds)
    .find(([, speakerId]) => speakerId === 'ruby')?.[0]
  assert.ok(rubyOption)
  const confident = (choice: string) => ({
    choice,
    probabilities: { [choice]: 0.9, no_clear_identity: 0.1 },
    confidence: 0.9,
  })

  const segments = resolveSpeakerDecisionSegments(
    content,
    plan,
    {
      paragraph_p0: confident(rubyOption),
      paragraph_p1: confident('no_clear_identity'),
      speech_s0: confident('no_clear_identity'),
    },
    speakers,
    { isUserMessage: false, cardSpeakerId: null, historicalSpeakerId: null },
  )

  assert.equal(segments.find(segment => segment.text === 'I brought the ledger.')?.speakerId, 'ruby')
})

test('Jev resolver uses role fallbacks only when the complete message has no identity', () => {
  const content = '"No one has named me."'
  const speakers = [{ id: 'ruby', name: 'Ruby' }]
  const plan = buildSpeakerDecisionPlan(content, speakers, false)
  const unclear = {
    choice: 'no_clear_identity',
    probabilities: { no_clear_identity: 0.9, uncast_character: 0.1 },
    confidence: 0.9,
  }
  const answers = { paragraph_p0: unclear, speech_s0: unclear }
  const assistant = resolveSpeakerDecisionSegments(
    content,
    plan,
    answers,
    speakers,
    { isUserMessage: false, cardSpeakerId: 'ruby', historicalSpeakerId: null },
  )
  const user = resolveSpeakerDecisionSegments(
    content,
    plan,
    answers,
    speakers,
    { isUserMessage: true, cardSpeakerId: null, historicalSpeakerId: null },
  )

  assert.equal(assistant.find(segment => segment.text === 'No one has named me.')?.speakerId, 'ruby')
  assert.equal(user.find(segment => segment.text === 'No one has named me.')?.speakerId, USER_SPEAKER_ID)
})

test('Jev uncast identity disables card-title deference and routes to connection default', () => {
  const content = 'The clerk looks up. "Next in line."'
  const speakers = [{ id: 'naomi', name: 'Naomi' }]
  const plan = buildSpeakerDecisionPlan(content, speakers, false)
  const uncast = {
    choice: 'uncast_character',
    probabilities: { uncast_character: 0.91, no_clear_identity: 0.09 },
    confidence: 0.9,
  }
  const segments = resolveSpeakerDecisionSegments(
    content,
    plan,
    { paragraph_p0: uncast, speech_s0: uncast },
    speakers,
    { isUserMessage: false, cardSpeakerId: 'naomi', historicalSpeakerId: null },
  )

  assert.equal(segments.find(segment => segment.text === 'Next in line.')?.speakerId, UNCAST_SPEAKER_ID)
})

const DECISION_UNCAST_CRITERION = 'uncast_character'

function decisionOption(
  plan: ReturnType<typeof buildSpeakerDecisionPlan>,
  speakerId: string,
): string {
  const option = Object.entries(plan.optionSpeakerIds).find(([, id]) => id === speakerId)?.[0]
  assert.ok(option, `missing Jev option for ${speakerId}`)
  return option
}

function confidentDecision(choice: string, probability = 0.92, confidence = 0.9): SpeakerDecisionChoice {
  return {
    choice,
    probabilities: {
      [choice]: probability,
      no_clear_identity: Number(Math.max(0, 1 - probability).toFixed(4)),
    },
    confidence,
  }
}

function turnDecision(choice: string, probability = 0.85, confidence = 0.85): SpeakerDecisionChoice {
  return {
    choice,
    probabilities: {
      [choice]: probability,
      no_clear_relation: Number(Math.max(0, 1 - probability).toFixed(4)),
    },
    confidence,
  }
}

const CALL_AND_RESPONSE = [
  'Ruby looks at the doorway. "You are late."',
  '',
  '"Yes. The bridge was out."',
  '',
  '"And the horses?"',
  '',
  '"Took the long way."',
  '',
  'Vega sighs. "We leave at dawn."',
].join('\n')

const CALL_AND_RESPONSE_SPEAKERS = [
  { id: 'ruby', name: 'Ruby' },
  { id: 'vega', name: 'Vega' },
]

function callAndResponseAnswers(plan: ReturnType<typeof buildSpeakerDecisionPlan>) {
  const ruby = decisionOption(plan, 'ruby')
  const vega = decisionOption(plan, 'vega')
  const unclear = confidentDecision('no_clear_identity')
  return {
    paragraph_p0: confidentDecision(ruby),
    speech_s0: confidentDecision(ruby),
    paragraph_p1: unclear,
    speech_s1: unclear,
    paragraph_p2: unclear,
    speech_s2: unclear,
    paragraph_p3: unclear,
    speech_s3: unclear,
    paragraph_p4: confidentDecision(vega),
    speech_s4: confidentDecision(vega),
  }
}

test('escalates a cross-paragraph call-and-response run and fills unresolved speeches', () => {
  const plan = buildSpeakerDecisionPlan(CALL_AND_RESPONSE, CALL_AND_RESPONSE_SPEAKERS, false)
  const answers = callAndResponseAnswers(plan)
  const assessment = assessSpeakerDiscourseEscalation(plan, answers)

  assert.ok(assessment.plan)
  assert.deepEqual(assessment.plan.targets, ['s1', 's2', 's3'])
  assert.deepEqual(
    Object.keys(assessment.plan.questions),
    ['discourse_s1', 'discourse_s2', 'discourse_s3'],
  )
  const run = assessment.runs[0]
  assert.equal(run.rejection, null)
  assert.ok(run.triggers.some(trigger => trigger.code === 'adjacent-unresolved'))
  assert.ok(run.triggers.some(trigger => trigger.code === 'unattributed-replies-after-anchor'))
  assert.ok(run.triggers.some(trigger => trigger.code === 'alternating-participants'))
  const evidence = assessment.plan.state.firstPass.find(entry => entry.speechId === 's1')
  assert.equal(evidence?.speech.normalized, 'unresolved')
  assert.equal(evidence?.paragraph.normalized, 'unresolved')
  assert.deepEqual(
    assessment.plan.state.establishedIdentities.map(identity => identity.identity).sort(),
    ['ruby', 'vega'],
  )
  for (const criteria of Object.values(assessment.plan.questions)) {
    assert.ok(criteria.criteria[DECISION_UNCAST_CRITERION])
    assert.ok(criteria.criteria.no_clear_identity)
  }

  const vega = decisionOption(plan, 'vega')
  const ruby = decisionOption(plan, 'ruby')
  const discourseAnswers = {
    discourse_s1: confidentDecision(vega),
    discourse_s2: confidentDecision(ruby),
    discourse_s3: confidentDecision(vega),
  }
  const outcomes = resolveSpeakerDiscourseAnswers(assessment.plan, discourseAnswers)
  assert.equal(outcomes.get('s1')?.reason, 'filled-unresolved')
  assert.equal(outcomes.has('s0'), false)

  const segments = resolveSpeakerDecisionSegments(CALL_AND_RESPONSE, plan, answers, CALL_AND_RESPONSE_SPEAKERS, {
    isUserMessage: false,
    cardSpeakerId: null,
    historicalSpeakerId: null,
    discourse: { assessment, answers: discourseAnswers, status: 'completed' },
  })
  const spoken = segments.filter(segment => [
    'Yes. The bridge was out.',
    'And the horses?',
    'Took the long way.',
  ].includes(segment.text))
  assert.deepEqual(spoken.map(segment => segment.speakerId), ['vega', 'ruby', 'vega'])
})

test('leaves an isolated low-confidence quotation to ordinary inheritance', () => {
  const content = ['Ruby closes the door. "I am staying."', '', '"Where is the ledger?"'].join('\n')
  const speakers = [{ id: 'ruby', name: 'Ruby' }]
  const plan = buildSpeakerDecisionPlan(content, speakers, false)
  const ruby = decisionOption(plan, 'ruby')
  const answers = {
    paragraph_p0: confidentDecision(ruby),
    speech_s0: confidentDecision(ruby),
    paragraph_p1: confidentDecision('no_clear_identity'),
    speech_s1: confidentDecision('no_clear_identity'),
  }

  const assessment = assessSpeakerDiscourseEscalation(plan, answers)
  assert.equal(assessment.plan, null)
  assert.equal(
    assessment.runs[0]?.rejection,
    'isolated low-confidence speech with only upstream evidence',
  )

  const segments = resolveSpeakerDecisionSegments(content, plan, answers, speakers, {
    isUserMessage: false,
    cardSpeakerId: null,
    historicalSpeakerId: null,
    discourse: { assessment, answers: null, status: 'not-requested' },
  })
  assert.equal(segments.find(segment => segment.text === 'Where is the ledger?')?.speakerId, 'ruby')
})

test('chain decode fills a weak continuation instead of escalating it', () => {
  const content = ['Ruby closes the door. "I am staying."', '', '"Where is the ledger?"'].join('\n')
  const speakers = [{ id: 'ruby', name: 'Ruby' }, { id: 'vega', name: 'Vega' }]
  const plan = buildSpeakerDecisionPlan(content, speakers, false)
  const ruby = decisionOption(plan, 'ruby')
  const answers = {
    paragraph_p0: confidentDecision(ruby),
    speech_s0: confidentDecision(ruby),
    paragraph_p1: confidentDecision('no_clear_identity'),
    speech_s1: {
      choice: ruby,
      probabilities: { [ruby]: 0.45, no_clear_identity: 0.35, uncast_character: 0.2 },
      confidence: 0.4,
    },
    turn_s1: turnDecision('continues_previous_turn', 0.85, 0.85),
  }

  const chain = decodeSpeakerChain(plan, answers)
  assert.equal(chain.get('s1')?.filled, true)
  assert.equal(chain.get('s1')?.identity, 'ruby')

  const assessment = assessSpeakerDiscourseEscalation(plan, answers)
  assert.equal(assessment.plan, null)

  const segments = resolveSpeakerDecisionSegments(content, plan, answers, speakers, {
    isUserMessage: false,
    cardSpeakerId: null,
    historicalSpeakerId: null,
    includeDebug: true,
  })
  const reply = segments.find(segment => segment.text === 'Where is the ledger?')
  assert.equal(reply?.speakerId, 'ruby')
  assert.ok(reply?.debugPath?.some(step => step.startsWith('chain-decode:filled-unresolved')))
})

test('chain decode switches speakers when the quotation responds to the previous one', () => {
  const content = [
    'Ruby closes the door. "I am staying."',
    '',
    '"Then I will wait outside."',
    '',
    'Vega leans against the frame. "Suit yourself."',
  ].join('\n')
  const speakers = [{ id: 'ruby', name: 'Ruby' }, { id: 'vega', name: 'Vega' }]
  const plan = buildSpeakerDecisionPlan(content, speakers, false)
  const ruby = decisionOption(plan, 'ruby')
  const vega = decisionOption(plan, 'vega')
  const answers = {
    paragraph_p0: confidentDecision(ruby),
    speech_s0: confidentDecision(ruby),
    paragraph_p1: confidentDecision('no_clear_identity'),
    speech_s1: {
      choice: ruby,
      probabilities: { [ruby]: 0.2, [vega]: 0.45, no_clear_identity: 0.35 },
      confidence: 0.4,
    },
    turn_s1: turnDecision('responds_to_previous_speaker', 0.85, 0.85),
    paragraph_p2: confidentDecision(vega),
    speech_s2: confidentDecision(vega),
    turn_s2: turnDecision('continues_previous_turn', 0.85, 0.85),
  }

  const chain = decodeSpeakerChain(plan, answers)
  assert.equal(chain.get('s1')?.identity, 'vega')
  assert.equal(chain.get('s1')?.filled, true)

  const segments = resolveSpeakerDecisionSegments(content, plan, answers, speakers, {
    isUserMessage: false,
    cardSpeakerId: null,
    historicalSpeakerId: null,
  })
  assert.equal(segments.find(segment => segment.text === 'Then I will wait outside.')?.speakerId, 'vega')
})

test('keeps upstream inheritance when the chain cannot confidently fill a span', () => {
  const content = ['Ruby closes the door. "I am staying."', '', '"Where is the ledger?"'].join('\n')
  const speakers = [{ id: 'ruby', name: 'Ruby' }, { id: 'vega', name: 'Vega' }]
  const plan = buildSpeakerDecisionPlan(content, speakers, false)
  const ruby = decisionOption(plan, 'ruby')
  const vega = decisionOption(plan, 'vega')
  const answers = {
    paragraph_p0: confidentDecision(ruby),
    speech_s0: confidentDecision(ruby),
    paragraph_p1: confidentDecision('no_clear_identity'),
    speech_s1: {
      choice: ruby,
      probabilities: { [ruby]: 0.1, [vega]: 0.1, no_clear_identity: 0.8 },
      confidence: 0.5,
    },
    turn_s1: turnDecision('continues_previous_turn', 0.8, 0.8),
  }

  const chain = decodeSpeakerChain(plan, answers)
  assert.equal(chain.get('s1')?.identity, null)
  assert.equal(chain.get('s1')?.filled, false)
  const segments = resolveSpeakerDecisionSegments(content, plan, answers, speakers, {
    isUserMessage: false,
    cardSpeakerId: null,
    historicalSpeakerId: null,
    includeDebug: true,
  })
  const reply = segments.find(segment => segment.text === 'Where is the ledger?')
  assert.equal(reply?.speakerId, 'ruby')
  assert.ok(reply?.debugPath?.some(step => step.startsWith('chain-decode:retained-unresolved')))
})

test('chain decode may override a clear answer when the chain strongly disagrees', () => {
  const content = [
    'Duncan covers the phone. "Hold on."',
    '',
    'Poppy laughs. "Tell me again."',
    '',
    'Duncan sighs. "Fine."',
  ].join('\n')
  const speakers = [{ id: 'poppy', name: 'Poppy' }, { id: 'duncan', name: 'Duncan' }]
  const plan = buildSpeakerDecisionPlan(content, speakers, false)
  const poppy = decisionOption(plan, 'poppy')
  const duncan = decisionOption(plan, 'duncan')
  // The first pass claims Duncan speaks the middle line, but both neighbours
  // are Duncan and both relations say the line responds to the previous speaker.
  const answers = {
    paragraph_p0: confidentDecision(duncan),
    speech_s0: confidentDecision(duncan),
    paragraph_p1: confidentDecision('no_clear_identity'),
    speech_s1: {
      choice: duncan,
      probabilities: { [duncan]: 0.55, [poppy]: 0.4, no_clear_identity: 0.05 },
      confidence: 0.9,
    },
    turn_s1: turnDecision('responds_to_previous_speaker', 0.92, 0.9),
    paragraph_p2: confidentDecision(duncan),
    speech_s2: confidentDecision(duncan),
    turn_s2: turnDecision('responds_to_previous_speaker', 0.9, 0.9),
  }

  const chain = decodeSpeakerChain(plan, answers)
  assert.equal(chain.get('s1')?.directIdentity, 'duncan')
  assert.equal(chain.get('s1')?.overrode, true)
  assert.equal(chain.get('s1')?.identity, 'poppy')

  const segments = resolveSpeakerDecisionSegments(content, plan, answers, speakers, {
    isUserMessage: false,
    cardSpeakerId: null,
    historicalSpeakerId: null,
    includeDebug: true,
  })
  const reply = segments.find(segment => segment.text === 'Tell me again.')
  assert.equal(reply?.speakerId, 'poppy')
  assert.ok(reply?.debugPath?.includes('resolution:chain-identity (overrode clear answer)'))
})

test('chain decode uses narrative attribution and refuses a downstream respondent', () => {
  const content = [
    'Poppy blurts, "Look at me."',
    '',
    '"Do you like it? Do you like how I look?"',
    '',
    '"Perfect," Duncan laughs. "An institution."',
  ].join('\n')
  const speakers = [
    { id: 'poppy', name: 'Poppy' },
    { id: 'duncan', name: 'Duncan' },
    { id: 'ken', name: 'Ken' },
  ]
  const plan = buildSpeakerDecisionPlan(content, speakers, false)
  const poppy = decisionOption(plan, 'poppy')
  const duncan = decisionOption(plan, 'duncan')
  const unclear = confidentDecision('no_clear_identity')
  const answers = {
    paragraph_p0: confidentDecision(poppy),
    speech_s0: confidentDecision(poppy),
    paragraph_p1: unclear,
    speech_s1: {
      choice: poppy,
      probabilities: { [poppy]: 0.45, [duncan]: 0.35, no_clear_identity: 0.2 },
      confidence: 0.4,
    },
    turn_s1: turnDecision('continues_previous_turn', 0.8, 0.85),
    paragraph_p2: confidentDecision(duncan),
    speech_s2: confidentDecision(duncan),
    turn_s2: turnDecision('responds_to_previous_speaker', 0.8, 0.85),
  }

  const chain = decodeSpeakerChain(plan, answers)
  assert.equal(chain.get('s0')?.narrativeAttribution, 'poppy')
  assert.equal(chain.get('s1')?.narrativeAttribution, null)
  assert.equal(chain.get('s1')?.identity, 'poppy')
  assert.equal(chain.get('s2')?.narrativeAttribution, 'duncan')

  const segments = resolveSpeakerDecisionSegments(content, plan, answers, speakers, {
    isUserMessage: false,
    cardSpeakerId: null,
    historicalSpeakerId: null,
  })
  assert.equal(segments.find(segment => segment.text === 'Do you like it? Do you like how I look?')?.speakerId, 'poppy')
  assert.equal(segments.find(segment => segment.text === 'Perfect,')?.speakerId, 'duncan')
  assert.equal(segments.find(segment => segment.text === 'An institution.')?.speakerId, 'duncan')
})


test('chain decode handles phone monologues and turn alternation across a scene', () => {
  const content = [
    'Duncan is at his desk with the phone cradled at his ear.',
    '',
    '"—no, I completely understand. And look, this is exactly what I would want to hear."',
    '',
    'Duncan leans back. "Yeah. No, that is the right call and I will tell you why."',
    '',
    '"I know!" Poppy says. "I know! Isn\'t it perfect?"',
    '',
    '"Do you like it? Do you like how I look?"',
    '',
    '"Perfect." Duncan says. "You are a goddamn institution."',
    '',
    '"Keep me! Keep me! No — he is taking me to the conference room."',
    '',
    'His eyes move to Ken and he nods once.',
    '',
    '"Good for you, man. She is the best we got."',
    '',
    'Then Duncan uncovers the phone and his voice snaps back to business.',
    '',
    '"—sorry about that. No, I am here."',
  ].join('\n')
  const speakers = [
    { id: 'poppy', name: 'Poppy' },
    { id: 'duncan', name: 'Duncan' },
    { id: 'ken', name: 'Ken' },
  ]
  const plan = buildSpeakerDecisionPlan(content, speakers, false)
  const poppy = decisionOption(plan, 'poppy')
  const duncan = decisionOption(plan, 'duncan')
  const unclear = confidentDecision('no_clear_identity')
  const answers = {
    paragraph_p0: confidentDecision(duncan),
    paragraph_p1: unclear,
    speech_s0: unclear,
    paragraph_p2: confidentDecision(duncan),
    speech_s1: confidentDecision(duncan),
    turn_s1: turnDecision('responds_to_other_participant', 0.8, 0.8),
    paragraph_p3: confidentDecision(poppy),
    speech_s2: confidentDecision(poppy),
    speech_s3: confidentDecision(poppy),
    turn_s3: turnDecision('continues_previous_turn', 0.9, 0.9),
    paragraph_p4: unclear,
    speech_s4: {
      choice: poppy,
      probabilities: { [poppy]: 0.45, [duncan]: 0.35, no_clear_identity: 0.2 },
      confidence: 0.4,
    },
    turn_s4: turnDecision('continues_previous_turn', 0.9, 0.9),
    paragraph_p5: confidentDecision(duncan),
    speech_s5: confidentDecision(duncan),
    speech_s6: confidentDecision(duncan),
    turn_s5: turnDecision('responds_to_previous_speaker', 0.9, 0.9),
    turn_s6: turnDecision('continues_previous_turn', 0.9, 0.9),
    paragraph_p6: unclear,
    speech_s7: {
      choice: poppy,
      probabilities: { [poppy]: 0.45, [duncan]: 0.35, no_clear_identity: 0.2 },
      confidence: 0.4,
    },
    turn_s7: turnDecision('responds_to_previous_speaker', 0.9, 0.9),
    paragraph_p7: confidentDecision(duncan),
    paragraph_p8: unclear,
    speech_s8: {
      choice: duncan,
      probabilities: { [duncan]: 0.5, [poppy]: 0.2, no_clear_identity: 0.3 },
      confidence: 0.4,
    },
    turn_s8: turnDecision('responds_to_previous_speaker', 0.9, 0.9),
    paragraph_p9: confidentDecision(duncan),
    paragraph_p10: unclear,
    speech_s9: unclear,
    turn_s9: turnDecision('responds_to_other_participant', 0.8, 0.8),
  }

  const chain = decodeSpeakerChain(plan, answers)
  assert.equal(chain.get('s4')?.identity, 'poppy')
  assert.equal(chain.get('s4')?.filled, true)
  assert.equal(chain.get('s7')?.identity, 'poppy')
  assert.equal(chain.get('s7')?.filled, true)
  assert.equal(chain.get('s8')?.identity, 'duncan')

  const segments = resolveSpeakerDecisionSegments(content, plan, answers, speakers, {
    isUserMessage: false,
    cardSpeakerId: null,
    historicalSpeakerId: null,
  })
  const speakerOf = (text: string) => segments.find(segment => segment.text === text)?.speakerId
  assert.equal(speakerOf('—no, I completely understand. And look, this is exactly what I would want to hear.'), 'duncan')
  assert.equal(speakerOf('Do you like it? Do you like how I look?'), 'poppy')
  assert.equal(speakerOf('Keep me! Keep me! No — he is taking me to the conference room.'), 'poppy')
  assert.equal(speakerOf('Good for you, man. She is the best we got.'), 'duncan')
  assert.equal(speakerOf('—sorry about that. No, I am here.'), 'duncan')
})

test('extracts narrative context for spans and inter-quote bridges', () => {
  const content = 'Poppy says, "Look at me." Duncan says, "I am."'
  const plan = buildSpeakerDecisionPlan(content, [
    { id: 'poppy', name: 'Poppy' },
    { id: 'duncan', name: 'Duncan' },
  ], false)
  assert.equal(plan.state.speeches[0]?.narrativeBefore, 'Poppy says,')
  assert.equal(plan.state.speeches[0]?.narrativeAfter, 'Duncan says,')
  assert.equal(plan.state.speeches[1]?.narrativeBefore, 'Duncan says,')
  assert.equal(plan.state.speeches[1]?.narrativeAfter, '')
  assert.equal(plan.state.turns[0]?.bridge, 'Duncan says,')
})

test('drops turn questions and chain decoding when the first pass exceeds the question budget', () => {
  const lines: string[] = []
  for (let index = 0; index < 90; index += 1) {
    lines.push(`Ruby says, "Line ${index}."`)
    if (index < 89) lines.push('')
  }
  const content = lines.join('\n')
  const plan = buildSpeakerDecisionPlan(content, [{ id: 'ruby', name: 'Ruby' }], false)
  assert.equal(plan.state.speeches.length, 90)
  assert.equal(plan.state.paragraphs.length, 90)
  assert.equal(plan.state.turnQuestionsOmitted, true)
  assert.deepEqual(plan.state.turns, [])
  assert.equal(Object.keys(plan.questions).some(id => id.startsWith('turn_')), false)
  assert.ok(Object.keys(plan.questions).length <= 256)

  const ruby = decisionOption(plan, 'ruby')
  const answers: Record<string, SpeakerDecisionChoice> = {}
  for (const paragraph of plan.state.paragraphs) answers[`paragraph_${paragraph.id}`] = confidentDecision(ruby)
  for (const speech of plan.state.speeches) answers[`speech_${speech.id}`] = confidentDecision(ruby)
  assert.equal(decodeSpeakerChain(plan, answers).size, 0)
})

test('reviews an ambiguous opening run before its later attribution', () => {
  const content = [
    '"Where is the ledger?"',
    '',
    '"The study, I think."',
    '',
    'Ruby frowns. "Then fetch it."',
  ].join('\n')
  const speakers = [{ id: 'ruby', name: 'Ruby' }]
  const plan = buildSpeakerDecisionPlan(content, speakers, false)
  const ruby = decisionOption(plan, 'ruby')
  const unclear = confidentDecision('no_clear_identity')
  const answers = {
    paragraph_p0: unclear,
    speech_s0: unclear,
    paragraph_p1: unclear,
    speech_s1: unclear,
    paragraph_p2: confidentDecision(ruby),
    speech_s2: confidentDecision(ruby),
  }

  const assessment = assessSpeakerDiscourseEscalation(plan, answers)
  assert.ok(assessment.plan)
  assert.deepEqual(assessment.plan.targets, ['s0', 's1'])

  const discourseAnswers = {
    discourse_s0: confidentDecision('uncast_character'),
    discourse_s1: confidentDecision('uncast_character'),
  }
  const segments = resolveSpeakerDecisionSegments(content, plan, answers, speakers, {
    isUserMessage: false,
    cardSpeakerId: null,
    historicalSpeakerId: null,
    discourse: { assessment, answers: discourseAnswers, status: 'completed' },
  })
  const spoken = segments.filter(segment => [
    'Where is the ledger?',
    'The study, I think.',
  ].includes(segment.text))
  assert.deepEqual(spoken.map(segment => segment.speakerId), [UNCAST_SPEAKER_ID, UNCAST_SPEAKER_ID])
})

test('only overrides a conflicting clear answer above the discourse override threshold', () => {
  const content = [
    'Ruby steps forward. "I will go."',
    '',
    'Vega folds her arms. "No."',
  ].join('\n')
  const speakers = [
    { id: 'ruby', name: 'Ruby' },
    { id: 'vega', name: 'Vega' },
  ]
  const plan = buildSpeakerDecisionPlan(content, speakers, false)
  const ruby = decisionOption(plan, 'ruby')
  const vega = decisionOption(plan, 'vega')
  const answers = {
    paragraph_p0: confidentDecision(ruby),
    speech_s0: confidentDecision(ruby),
    paragraph_p1: confidentDecision(vega),
    speech_s1: confidentDecision(ruby),
  }

  const assessment = assessSpeakerDiscourseEscalation(plan, answers)
  assert.ok(assessment.plan)
  assert.deepEqual(assessment.plan.targets, ['s1'])
  assert.ok(assessment.runs[0]?.triggers.some(trigger => trigger.code === 'paragraph-speech-conflict'))

  const belowOverride = resolveSpeakerDiscourseAnswers(assessment.plan, {
    discourse_s1: confidentDecision(vega, 0.66, 0.6),
  })
  assert.equal(belowOverride.get('s1')?.reason, 'rejected-override-threshold')

  const belowOverrideSegments = resolveSpeakerDecisionSegments(content, plan, answers, speakers, {
    isUserMessage: false,
    cardSpeakerId: null,
    historicalSpeakerId: null,
    discourse: {
      assessment,
      answers: { discourse_s1: confidentDecision(vega, 0.66, 0.6) },
      status: 'completed',
    },
  })
  assert.equal(belowOverrideSegments.find(segment => segment.text === 'No.')?.speakerId, 'ruby')

  const aboveOverride = resolveSpeakerDiscourseAnswers(assessment.plan, {
    discourse_s1: confidentDecision(vega, 0.9, 0.9),
  })
  assert.equal(aboveOverride.get('s1')?.reason, 'overrode-conflict')
  const aboveOverrideSegments = resolveSpeakerDecisionSegments(content, plan, answers, speakers, {
    isUserMessage: false,
    cardSpeakerId: null,
    historicalSpeakerId: null,
    discourse: {
      assessment,
      answers: { discourse_s1: confidentDecision(vega, 0.9, 0.9) },
      status: 'completed',
    },
  })
  assert.equal(aboveOverrideSegments.find(segment => segment.text === 'No.')?.speakerId, 'vega')
  assert.ok(SPEAKER_DECISION_THRESHOLDS.override.probability > SPEAKER_DECISION_THRESHOLDS.discourse.probability)
})

test('keeps normalized first-pass answers when the discourse request fails', () => {
  const plan = buildSpeakerDecisionPlan(CALL_AND_RESPONSE, CALL_AND_RESPONSE_SPEAKERS, false)
  const answers = callAndResponseAnswers(plan)
  const assessment = assessSpeakerDiscourseEscalation(plan, answers)
  assert.ok(assessment.plan)
  const baseline = resolveSpeakerDecisionSegments(CALL_AND_RESPONSE, plan, answers, CALL_AND_RESPONSE_SPEAKERS, {
    isUserMessage: false,
    cardSpeakerId: null,
    historicalSpeakerId: null,
  })
  const failed = resolveSpeakerDecisionSegments(CALL_AND_RESPONSE, plan, answers, CALL_AND_RESPONSE_SPEAKERS, {
    isUserMessage: false,
    cardSpeakerId: null,
    historicalSpeakerId: null,
    includeDebug: true,
    discourse: { assessment, answers: null, status: 'failed (timed out); first-pass results retained' },
  })
  assert.deepEqual(
    failed.map(segment => segment.speakerId),
    baseline.map(segment => segment.speakerId),
  )
  const problem = failed.find(segment => segment.text === 'And the horses?')
  const debugLines = failed.flatMap(segment => segment.debugPath ?? [])
  assert.ok(debugLines.includes('discourse-request:failed (timed out); first-pass results retained'))
  assert.ok(debugLines.includes('discourse-decision:escalated'))
  assert.ok(debugLines.some(line => line.startsWith('discourse-triggers:')))
  assert.ok(problem?.debugPath?.includes('discourse-run:run_0'))
  assert.ok(problem?.debugPath?.includes('discourse-outcome:not-a-target (first-pass identity retained)'))
})

test('an explicitly anonymous role keeps discourse uncast ahead of card deference', () => {
  const content = ['The stranger says, "The door is locked."', '', '"Then find another way."'].join('\n')
  const speakers = [{ id: 'naomi', name: 'Naomi' }]
  const plan = buildSpeakerDecisionPlan(content, speakers, false)
  const unclear = confidentDecision('no_clear_identity')
  const answers = {
    paragraph_p0: unclear,
    speech_s0: unclear,
    paragraph_p1: unclear,
    speech_s1: unclear,
  }
  const assessment = assessSpeakerDiscourseEscalation(plan, answers)
  assert.ok(assessment.plan)

  const discourseAnswers = {
    discourse_s0: confidentDecision('uncast_character'),
    discourse_s1: confidentDecision('uncast_character'),
  }
  const withDiscourse = resolveSpeakerDecisionSegments(content, plan, answers, speakers, {
    isUserMessage: false,
    cardSpeakerId: 'naomi',
    historicalSpeakerId: null,
    includeDebug: true,
    discourse: { assessment, answers: discourseAnswers, status: 'completed' },
  })
  const spoken = withDiscourse.filter(segment => ['The door is locked.', 'Then find another way.'].includes(segment.text))
  assert.deepEqual(spoken.map(segment => segment.speakerId), [UNCAST_SPEAKER_ID, UNCAST_SPEAKER_ID])
  assert.ok(spoken[0]?.debugPath?.includes(
    'resolution:discourse-identity (filled unresolved first pass)',
  ))
})

test('defers a whole-message uncast identity to the unique card', () => {
  const content = [
    'She turns on the sidewalk. "That is a hand-kiss. In public."',
    '',
    '"And the cardigan. Look at you."',
  ].join('\n')
  const speakers = [{ id: 'jayden', name: 'Jayden Flynn / Jayden' }]
  const plan = buildSpeakerDecisionPlan(content, speakers, false)
  const weakUncast = {
    choice: 'uncast_character',
    probabilities: { uncast_character: 0.69, no_clear_identity: 0.2, known_0: 0.11 },
    confidence: 0.53,
  }
  const answers = {
    paragraph_p0: weakUncast,
    speech_s0: {
      choice: 'uncast_character',
      probabilities: { uncast_character: 0.55, known_0: 0.1, no_clear_identity: 0.35 },
      confidence: 0.4,
    },
    paragraph_p1: weakUncast,
    speech_s1: weakUncast,
  }

  const chain = decodeSpeakerChain(plan, answers)
  assert.equal(chain.get('s0')?.filled, true)
  assert.equal(chain.get('s0')?.identity, UNCAST_SPEAKER_ID)

  const segments = resolveSpeakerDecisionSegments(content, plan, answers, speakers, {
    isUserMessage: false,
    cardSpeakerId: 'jayden',
    historicalSpeakerId: null,
    includeDebug: true,
  })
  const spoken = segments.filter(segment => [
    'That is a hand-kiss. In public.',
    'And the cardigan. Look at you.',
  ].includes(segment.text))
  assert.deepEqual(spoken.map(segment => segment.speakerId), ['jayden', 'jayden'])
  assert.ok(spoken[0]?.debugPath?.includes(
    'resolution:unique card-title match (uncast identity had no explicit role cue)',
  ))
})

test('a strong uncast identity blocks card deference', () => {
  const content = [
    'She turns on the sidewalk. "That is a hand-kiss. In public."',
    '',
    '"And the cardigan. Look at you."',
  ].join('\n')
  const speakers = [{ id: 'jayden', name: 'Jayden Flynn / Jayden' }]
  const plan = buildSpeakerDecisionPlan(content, speakers, false)
  const uncast = confidentDecision('uncast_character')
  const answers = {
    paragraph_p0: uncast,
    speech_s0: uncast,
    paragraph_p1: uncast,
    speech_s1: uncast,
  }

  const segments = resolveSpeakerDecisionSegments(content, plan, answers, speakers, {
    isUserMessage: false,
    cardSpeakerId: 'jayden',
    historicalSpeakerId: null,
    includeDebug: true,
  })
  const spoken = segments.filter(segment => [
    'That is a hand-kiss. In public.',
    'And the cardigan. Look at you.',
  ].includes(segment.text))
  assert.deepEqual(spoken.map(segment => segment.speakerId), [UNCAST_SPEAKER_ID, UNCAST_SPEAKER_ID])
  assert.ok(spoken[0]?.debugPath?.some(step => step.startsWith('card-deference:blocked')))
})

test('splits dialogue runs at time jumps instead of inferring across scenes', () => {
  const content = [
    'Ruby says, "I am leaving."',
    '',
    '"Take the north road."',
    '',
    '"The north road is watched."',
    '',
    'The next morning, Vega waits by the gate.',
    '',
    '"You came."',
    '',
    '"I did."',
  ].join('\n')
  const speakers = [
    { id: 'ruby', name: 'Ruby' },
    { id: 'vega', name: 'Vega' },
  ]
  const plan = buildSpeakerDecisionPlan(content, speakers, false)
  const ruby = decisionOption(plan, 'ruby')
  const vega = decisionOption(plan, 'vega')
  const unclear = confidentDecision('no_clear_identity')
  const answers = {
    paragraph_p0: confidentDecision(ruby),
    speech_s0: confidentDecision(ruby),
    paragraph_p1: unclear,
    speech_s1: unclear,
    paragraph_p2: unclear,
    speech_s2: unclear,
    paragraph_p3: confidentDecision(vega),
    paragraph_p4: unclear,
    speech_s3: unclear,
    paragraph_p5: unclear,
    speech_s4: unclear,
  }

  const assessment = assessSpeakerDiscourseEscalation(plan, answers)
  assert.equal(assessment.runs.length, 2)
  assert.deepEqual(assessment.runs[0]?.paragraphIds, ['p0', 'p1', 'p2'])
  assert.deepEqual(assessment.runs[1]?.paragraphIds, ['p4', 'p5'])
  assert.equal(assessment.runs[1]?.boundaryBeforeParagraphId, 'p3')
  assert.equal(assessment.runs[1]?.boundaryBeforeIdentity, 'vega')
  assert.equal(assessment.runs[0]?.boundaryAfterParagraphId, 'p3')
  assert.ok(assessment.plan)
  assert.deepEqual(assessment.plan.targets, ['s1', 's2', 's3', 's4'])
  assert.deepEqual(assessment.plan.runIds, ['run_0', 'run_1'])
})

test('gates a decision answer on probability, confidence, and winner margin', () => {
  const optionSpeakerIds = { known_0: 'ruby' }
  const passes = evaluateSpeakerDecisionAnswer(
    { choice: 'known_0', probabilities: { known_0: 0.8, no_clear_identity: 0.2 }, confidence: 0.8 },
    optionSpeakerIds,
  )
  assert.equal(passes.identity, 'ruby')

  const lowProbability = evaluateSpeakerDecisionAnswer(
    { choice: 'known_0', probabilities: { known_0: 0.45, no_clear_identity: 0.3, uncast_character: 0.25 }, confidence: 0.9 },
    optionSpeakerIds,
  )
  assert.equal(lowProbability.resolved, false)
  assert.equal(lowProbability.leadingIdentity, 'ruby')

  const lowConfidence = evaluateSpeakerDecisionAnswer(
    { choice: 'known_0', probabilities: { known_0: 0.9, no_clear_identity: 0.1 }, confidence: 0.4 },
    optionSpeakerIds,
  )
  assert.equal(lowConfidence.resolved, false)

  const narrowMargin = evaluateSpeakerDecisionAnswer(
    { choice: 'known_0', probabilities: { known_0: 0.55, no_clear_identity: 0.45 }, confidence: 0.9 },
    optionSpeakerIds,
  )
  assert.equal(narrowMargin.resolved, false)
  assert.ok(narrowMargin.margin < SPEAKER_DECISION_THRESHOLDS.local.margin)

  const unknownOption = evaluateSpeakerDecisionAnswer(
    { choice: 'known_9', probabilities: { known_9: 0.95, no_clear_identity: 0.05 }, confidence: 0.9 },
    optionSpeakerIds,
  )
  assert.equal(unknownOption.resolved, false)

  const uncast = evaluateSpeakerDecisionAnswer(
    { choice: 'uncast_character', probabilities: { uncast_character: 0.9, no_clear_identity: 0.1 }, confidence: 0.9 },
    optionSpeakerIds,
  )
  assert.equal(uncast.identity, UNCAST_SPEAKER_ID)
  assert.equal(evaluateSpeakerDecisionAnswer({ choice: 'known_0', probabilities: { known_0: Infinity }, confidence: 1 }, optionSpeakerIds).resolved, false)
  assert.equal(evaluateSpeakerDecisionAnswer({ choice: 'known_0', probabilities: { known_0: 1.1 }, confidence: 1 }, optionSpeakerIds).resolved, false)
  assert.equal(evaluateSpeakerDecisionAnswer({ choice: 'known_0', probabilities: { known_0: 0.9 }, confidence: NaN }, optionSpeakerIds).resolved, false)
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

test('keeps mixed long and short synthesis windows at one request', () => {
  assert.deepEqual(
    adaptiveGenerationConcurrency(4, 4, [520, 190, 610, 205, 480, 175]),
    { concurrency: 1, shortCooldown: 6, longWindowStreak: 0 },
  )
})

test('keeps frequently switching voice windows at one request', () => {
  assert.deepEqual(
    adaptiveGenerationConcurrency(3, 4, [420, 460, 500, 440, 480, 520], 0, 0, 10, 4),
    { concurrency: 1, shortCooldown: 6, longWindowStreak: 0 },
  )
})

test('raises synthesis concurrency while the playback buffer is under target', () => {
  assert.equal(bufferAwareGenerationConcurrency(1, 4, 0, 2, 1), 2)
  assert.equal(bufferAwareGenerationConcurrency(2, 4, 1, 2, 1), 3)
  assert.equal(bufferAwareGenerationConcurrency(3, 4, 0, 2, 1), 4)
})

test('returns to the adaptive baseline when buffered and serializes after rate limiting', () => {
  assert.equal(bufferAwareGenerationConcurrency(3, 4, 2, 2, 1), 1)
  assert.equal(bufferAwareGenerationConcurrency(3, 4, 0, 2, 3, true), 1)
  assert.equal(bufferAwareGenerationConcurrency(1, 1, 0, 2, 1), 1)
})

test('paces synthesis starts inside a rolling request window', () => {
  assert.equal(rollingRequestWindowDelay([1_000, 2_000, 3_000], 4_000, 4, 60_000), 0)
  assert.equal(rollingRequestWindowDelay([1_000, 2_000, 3_000, 4_000], 5_000, 4, 60_000), 56_000)
  assert.equal(rollingRequestWindowDelay([1_000, 2_000, 3_000, 4_000], 61_001, 4, 60_000), 0)
  assert.equal(reducedRequestWindowLimit(18), 9)
  assert.equal(reducedRequestWindowLimit(7), 6)
})

test('keeps adjacent same-voice segments as separate synthesis requests', () => {
  assert.deepEqual(mergeVoicePlan([
    { text: 'First sentence.', voice: 'narrator' },
    { text: ' Second sentence. ', voice: 'narrator' },
    { text: 'Hello.', voice: 'alice' },
    { text: '', voice: 'alice' },
    { text: 'Back to narration.', voice: 'narrator' },
  ]), [
    { text: 'First sentence.', voice: 'narrator' },
    { text: 'Second sentence.', voice: 'narrator' },
    { text: 'Hello.', voice: 'alice' },
    { text: 'Back to narration.', voice: 'narrator' },
  ])
})

test('plans each same-speaker paragraph as an independent synthesis request', () => {
  const content = [
    'Narration.',
    '',
    '"First paragraph of the speech."',
    '',
    '"Second paragraph of the same speech."',
    '',
    '"Third paragraph."',
  ].join('\n')
  const segments = parseRosterVoiceSegments(content, 'alice', [{ id: 'alice', name: 'Alice' }])
  const plan = mergeVoicePlan(segments.map(segment => ({
    text: segment.text,
    voice: segment.speakerId ?? 'narrator',
  })))
  assert.deepEqual(plan, [
    { text: 'Narration.', voice: 'narrator' },
    { text: 'First paragraph of the speech.', voice: 'alice' },
    { text: 'Second paragraph of the same speech.', voice: 'alice' },
    { text: 'Third paragraph.', voice: 'alice' },
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

test('splits oversized paragraph jobs at sentence boundaries', () => {
  const sentences = [
    'The first sentence carries enough detail to make a useful synthesis chunk without feeling abrupt.',
    'The second sentence likewise supplies enough words to form another naturally bounded request.',
    'The final sentence closes the paragraph cleanly.',
  ]
  const result = splitLargeVoicePlanSegments([
    { text: sentences.join(' '), voice: 'narrator', tagId: 'speech-1' },
  ], 120)

  assert.deepEqual(result, sentences.map(text => ({ text, voice: 'narrator', tagId: 'speech-1' })))
})

test('falls back to safe word boundaries for long sentences and preserves plan metadata', () => {
  const text = Array.from({ length: 45 }, (_, index) => `word${index}`).join(' ')
  const result = splitLargeVoicePlanSegments([{ text, voice: 'ruby', tagId: 'speech-2' }], 100)

  assert.ok(result.length > 1)
  assert.ok(result.every(segment => segment.text.length <= 100))
  assert.ok(result.every(segment => segment.voice === 'ruby' && segment.tagId === 'speech-2'))
  assert.equal(result.map(segment => segment.text).join(' '), text)
})

test('leaves ordinary synthesis jobs unchanged', () => {
  assert.deepEqual(
    splitLargeVoicePlanSegments([{ text: 'A short paragraph.', voice: 'alice' }]),
    [{ text: 'A short paragraph.', voice: 'alice' }],
  )
})

test('builds emotion, sound, and pause questions per speech', () => {
  const content = ['Narration.', '', '"Wait. You heard that too?"'].join('\n')
  const plan = buildSpeakerDecisionPlan(content, [{ id: 'alice', name: 'Alice' }], false)
  const tagPlan = buildTtsTagPlan(plan)

  assert.equal(tagPlan.state.speeches.length, 1)
  const emotionQuestion = tagPlan.questions.emotion_s0
  assert.ok(emotionQuestion)
  assert.ok(emotionQuestion.criteria.happy)
  assert.ok(emotionQuestion.criteria.calm)
  const emotion2Question = tagPlan.questions.emotion2_s0
  assert.ok(emotion2Question)
  assert.ok(emotion2Question.criteria.no_emotion)
  assert.ok(emotion2Question.criteria.nervous)
  const tagQuestion = tagPlan.questions.tag_s0
  assert.ok(tagQuestion)
  assert.ok(tagQuestion.criteria.no_tag)
  assert.ok(tagQuestion.criteria.gasp)
  assert.ok(tagPlan.questions.tag2_s0?.criteria.sigh)
  const pauseQuestion = tagPlan.questions.pause_s0
  assert.ok(pauseQuestion)
  assert.ok(pauseQuestion.criteria.no_pause)
  assert.ok(pauseQuestion.criteria.short)
  assert.ok(pauseQuestion.criteria.long)
  assert.ok(tagPlan.questions.pause2_s0?.criteria.long)
  const positionQuestion = tagPlan.questions.tagpos_s0
  assert.ok(positionQuestion)
  assert.ok(positionQuestion.criteria.start)
  assert.ok(positionQuestion.criteria.end)
  assert.ok(positionQuestion.criteria.b1)
  assert.ok(tagPlan.questions.pausepos_s0?.criteria.b1)
  assert.equal(Object.keys(tagPlan.questions).length, 8)
})

test('adds a Fish style question and repeats leading cues per sentence', () => {
  const content = ['Narration.', '', '"Wait. You heard that too?"'].join('\n')
  const plan = buildSpeakerDecisionPlan(content, [{ id: 'alice', name: 'Alice' }], false)
  const tagPlan = buildTtsTagPlan(plan, undefined, undefined, 'fish')
  assert.ok(tagPlan.questions.style_s0)
  assert.ok(tagPlan.questions.style_s0?.criteria.whispering)
  assert.equal(Object.keys(tagPlan.questions).length, 9)

  const selection = resolveTtsTagAnswers(tagPlan, {
    emotion_s0: {
      choice: 'moved',
      probabilities: { moved: 0.9, calm: 0.1 },
      confidence: 0.9,
    },
    style_s0: {
      choice: 'whispering',
      probabilities: { whispering: 0.9, no_style: 0.1 },
      confidence: 0.9,
    },
  }, 'fish').get('s0')
  assert.deepEqual(selection?.emotions, ['moved'])
  assert.deepEqual(selection?.styles, ['whispering'])
  assert.equal(selection?.baseText, '[moved] [whispering] Wait. You heard that too?')
  assert.equal(selection?.ttsText, '[moved] [whispering] Wait. [moved] [whispering] You heard that too?')
})

test('adds Fish modulation questions and marks the selected mid-speech point', () => {
  const content = ['Narration.', '', `"I thought you were gone, but you came back. I can't believe it."`].join('\n')
  const plan = buildSpeakerDecisionPlan(content, [{ id: 'alice', name: 'Alice' }], false)
  const tagPlan = buildTtsTagPlan(plan, undefined, undefined, 'fish', true)
  assert.ok(tagPlan.questions.modulation_s0)
  assert.ok(tagPlan.questions.modulationpos_s0)
  assert.ok(tagPlan.modulationPositions.s0?.length)
  assert.equal(Object.keys(tagPlan.questions).length, 11)

  const selection = resolveTtsTagAnswers(tagPlan, {
    emotion_s0: {
      choice: 'moved',
      probabilities: { moved: 0.9, calm: 0.1 },
      confidence: 0.9,
    },
    modulation_s0: {
      choice: 'modulation',
      probabilities: { modulation: 0.9, no_modulation: 0.1 },
      confidence: 0.9,
    },
    modulationpos_s0: {
      choice: 'm1',
      probabilities: { m1: 0.9, m2: 0.1 },
      confidence: 0.9,
    },
  }, 'fish').get('s0')
  assert.equal(selection?.modulation, true)
  assert.equal(selection?.modulationPoint, 'm1')
  assert.ok(selection?.baseText.includes(TTS_MODULATION_MARKER))
  assert.ok(!selection?.ttsText.includes(TTS_MODULATION_MARKER))

  const weak = resolveTtsTagAnswers(tagPlan, {
    modulation_s0: {
      choice: 'modulation',
      probabilities: { modulation: 0.4, no_modulation: 0.6 },
      confidence: 0.4,
    },
    modulationpos_s0: {
      choice: 'm1',
      probabilities: { m1: 0.9, m2: 0.1 },
      confidence: 0.9,
    },
  }, 'fish').get('s0')
  assert.equal(weak?.modulation, false)
  assert.ok(!weak?.baseText.includes(TTS_MODULATION_MARKER))
})

test('carries a Fish modulation through later sentences', () => {
  assert.equal(
    applyCustomTtsEmotionCuesWithModulation(
      '[moved] [whispering] Wait. [gasp] You heard [modulationmarker] that too? It changes everything.',
      'quietly relieved',
      ['whispering'],
      'desperate but controlled',
      'fish',
    ),
    '[quietly relieved] [whispering] Wait. [quietly relieved] [whispering] [gasp] You heard [desperate but controlled] [whispering] that too? [desperate but controlled] [whispering] It changes everything.',
  )
})

test('validates a Fish modulation marker without treating it as spoken text', () => {
  assert.equal(
    validateTtsSpeechPlacement(
      '[moved] Wait. [modulationmarker] You heard.',
      '[moved] Wait. [modulationmarker] You heard. [gasp]',
      { emotions: ['moved'], styles: [], sounds: ['gasp'], pauses: [] },
      'fish',
    ),
    true,
  )
  assert.equal(
    validateTtsSpeechPlacement(
      '[moved] Wait. [modulationmarker] You heard.',
      '[moved] Wait. You heard. [gasp]',
      { emotions: ['moved'], styles: [], sounds: ['gasp'], pauses: [] },
      'fish',
    ),
    false,
  )
  assert.equal(
    validateTtsSpeechPlacement(
      '[moved] Wait. [modulationmarker] You heard.',
      '[moved] Wait. You [modulationmarker] heard. [gasp]',
      { emotions: ['moved'], styles: [], sounds: ['gasp'], pauses: [] },
      'fish',
    ),
    false,
  )
})

test('formats Gemini 3.8 vocal events and omits unsupported emotion/style cues', () => {
  assert.equal(formatTtsTag('sigh', 'gemini38'), '<sigh>')
  assert.equal(formatTtsTag('short', 'gemini38'), '<short pause>')
  assert.equal(formatTtsTag('long', 'gemini38'), '<long pause>')
  assert.equal(formatTtsTag('happy', 'gemini38'), '')
  assert.equal(formatTtsTag('whispering', 'gemini38'), '')
  assert.equal(formatTtsTag('snore', 'gemini38'), '')
  assert.equal(
    normalizeTtsTags('[happy] [whispering] Wait. [gasp] [break]', 'gemini38')
      .replace(/\s+/gu, ' ')
      .trim(),
    'Wait. <gasp> <short pause>',
  )
  assert.equal(
    applyLeadingTtsCues(
      '[happy] [whispering] Wait. [gasp] You heard.',
      ['happy'],
      ['whispering'],
      'gemini38',
    ),
    'Wait. <gasp> You heard.',
  )
})

test('rebuilds Fish leading cues after placement', () => {
  assert.equal(
    applyLeadingTtsCues(
      '[moved] [whispering] Wait. [gasp] You heard that too?',
      ['moved'],
      ['whispering'],
      'fish',
    ),
    '[moved] [whispering] Wait. [moved] [whispering] [gasp] You heard that too?',
  )
})

test('validates and applies custom Fish emotion tags', () => {
  assert.equal(
    normalizeCustomTtsEmotionTag('[quietly relieved but guarded]'),
    'quietly relieved but guarded',
  )
  assert.equal(
    normalizeCustomTtsEmotionTag('one two three four five six seven eight nine ten eleven'),
    null,
  )
  assert.equal(
    normalizeCustomTtsEmotionTag('one two three four five six seven eight nine ten'),
    null,
  )
  assert.equal(
    normalizeCustomTtsEmotionTag('one two three four five six seven eight nine'),
    'one two three four five six seven eight nine',
  )
  assert.equal(normalizeCustomTtsEmotionTag('[gasp]'), null)
  assert.equal(normalizeCustomTtsEmotionTag('line one\nline two'), null)
  assert.equal(
    applyCustomTtsEmotionCues(
      '[moved] [whispering] Wait. You heard that too?',
      'quietly relieved but guarded',
      ['whispering'],
      'fish',
    ),
    '[quietly relieved but guarded] [whispering] Wait. [quietly relieved but guarded] [whispering] You heard that too?',
  )
})

test('prepends emotion and places sound and pause together', () => {
  const content = ['Narration.', '', '"Wait. You heard that too?"'].join('\n')
  const plan = buildSpeakerDecisionPlan(content, [{ id: 'alice', name: 'Alice' }], false)
  const tagPlan = buildTtsTagPlan(plan)
  const answers = {
    emotion_s0: {
      choice: 'happy',
      probabilities: { happy: 0.8, calm: 0.2 },
      confidence: 0.9,
    },
    tag_s0: {
      choice: 'gasp',
      probabilities: { gasp: 0.9, no_tag: 0.1 },
      confidence: 0.9,
    },
    tagpos_s0: {
      choice: 'b1',
      probabilities: { start: 0.1, b1: 0.8, end: 0.1 },
      confidence: 0.9,
    },
    pause_s0: {
      choice: 'short',
      probabilities: { short: 0.8, no_pause: 0.2 },
      confidence: 0.9,
    },
    pausepos_s0: {
      choice: 'end',
      probabilities: { start: 0.1, b1: 0.1, end: 0.8 },
      confidence: 0.9,
    },
  }

  const selection = resolveTtsTagAnswers(tagPlan, answers, 'gemini').get('s0')
  assert.deepEqual(selection?.emotions, ['happy'])
  assert.deepEqual(selection?.sounds, ['gasp'])
  assert.deepEqual(selection?.soundPositions, ['b1'])
  assert.deepEqual(selection?.pauses, ['short'])
  assert.equal(selection?.baseText, '[happy] Wait. You heard that too?')
  assert.equal(selection?.ttsText, '[happy] Wait. [gasp] You heard that too? [break]')

  const fish = resolveTtsTagAnswers(tagPlan, answers, 'fish').get('s0')
  assert.equal(fish?.ttsText, '[happy] Wait. [happy] [gasp] You heard that too? [short pause]')

  const gemini38Plan = buildTtsTagPlan(plan, undefined, undefined, 'gemini38')
  assert.equal(gemini38Plan.questions.emotion_s0, undefined)
  assert.equal(gemini38Plan.questions.emotion2_s0, undefined)
  assert.equal(gemini38Plan.questions.style_s0, undefined)
  assert.equal(Object.keys(gemini38Plan.questions).length, 6)
  const gemini38 = resolveTtsTagAnswers(gemini38Plan, answers, 'gemini38').get('s0')
  assert.deepEqual(gemini38?.emotions, [])
  assert.deepEqual(gemini38?.styles, [])
  assert.deepEqual(gemini38?.sounds, ['gasp'])
  assert.deepEqual(gemini38?.pauses, ['short'])
  assert.equal(gemini38?.baseText, 'Wait. You heard that too?')
  assert.equal(gemini38?.ttsText, 'Wait. <gasp> You heard that too? <short pause>')
  assert.equal(
    resolveTtsTagAnswers(gemini38Plan, {}, 'gemini38').get('s0')?.ttsText,
    'Wait. You heard that too?',
  )
})

test('supports a second emotion, sound, and pause in one selection', () => {
  const content = ['Narration.', '', '"Wait. You heard that too?"'].join('\n')
  const plan = buildSpeakerDecisionPlan(content, [{ id: 'alice', name: 'Alice' }], false)
  const tagPlan = buildTtsTagPlan(plan)
  const selection = resolveTtsTagAnswers(tagPlan, {
    emotion_s0: {
      choice: 'happy',
      probabilities: { happy: 0.8, calm: 0.2 },
      confidence: 0.9,
    },
    emotion2_s0: {
      choice: 'moved',
      probabilities: { moved: 0.8, no_emotion: 0.2 },
      confidence: 0.9,
    },
    tag_s0: {
      choice: 'gasp',
      probabilities: { gasp: 0.8, no_tag: 0.2 },
      confidence: 0.9,
    },
    tag2_s0: {
      choice: 'sigh',
      probabilities: { sigh: 0.8, no_tag: 0.2 },
      confidence: 0.9,
    },
    tagpos_s0: {
      choice: 'b1',
      probabilities: { start: 0.1, b1: 0.8, end: 0.1 },
      confidence: 0.9,
    },
    pause_s0: {
      choice: 'short',
      probabilities: { short: 0.8, no_pause: 0.2 },
      confidence: 0.9,
    },
    pause2_s0: {
      choice: 'long',
      probabilities: { long: 0.8, no_pause: 0.2 },
      confidence: 0.9,
    },
    pausepos_s0: {
      choice: 'b1',
      probabilities: { start: 0.1, b1: 0.8, end: 0.1 },
      confidence: 0.9,
    },
  }, 'gemini').get('s0')
  assert.deepEqual(selection?.emotions, ['happy', 'moved'])
  assert.deepEqual(selection?.sounds, ['gasp', 'sigh'])
  assert.deepEqual(selection?.pauses, ['short', 'long'])
  assert.deepEqual(selection?.soundPositions, ['b1', 'end'])
  assert.deepEqual(selection?.pausePositions, ['b1', 'end'])
  assert.ok(selection?.ttsText.startsWith('[happy] [moved] '))
  assert.ok(selection?.ttsText.includes('[gasp]'))
  assert.ok(selection?.ttsText.includes('[sigh]'))
  assert.ok(selection?.ttsText.includes('[break]'))
  assert.ok(selection?.ttsText.includes('[long-break]'))
})

test('smooths weak emotions per speaker while preserving confident shifts and scene boundaries', () => {
  const content = '"First."\n\n"Reply."\n\n"Again."\n\n"Shift."\n\nHours later, she returns.\n\n"After."'
  const plan = buildSpeakerDecisionPlan(content, [{ id: 'a', name: 'Alice' }, { id: 'b', name: 'Bob' }], false)
  const tags = buildTtsTagPlan(plan, undefined, undefined, 'fish')
  const selections = resolveTtsTagAnswers(tags, {
    emotion_s0: { choice: 'excited', probabilities: { excited: 0.9, calm: 0.1 }, confidence: 0.9 },
    emotion_s1: { choice: 'sad', probabilities: { sad: 0.9, calm: 0.1 }, confidence: 0.9 },
    emotion_s2: { choice: 'calm', probabilities: { calm: 0.4, excited: 0.35 }, confidence: 0.3 },
    emotion_s3: { choice: 'calm', probabilities: { calm: 0.9, excited: 0.1 }, confidence: 0.9 },
  }, 'fish')
  const segments = ['a', 'b', 'a', 'a', 'a'].map((speakerId, index) => ({
    speakerId, text: plan.state.speeches[index].text,
  }))
  const result = applyTtsSpeakerContinuity(segments, plan, selections, 'fish')
  assert.deepEqual(result.get('s1')?.emotions, ['sad'])
  assert.deepEqual(result.get('s2')?.emotions, ['excited'])
  assert.match(result.get('s2')?.ttsText ?? '', /^\[excited\]/u)
  assert.deepEqual(result.get('s3')?.emotions, ['calm'])
  assert.deepEqual(result.get('s4')?.emotions, ['calm'])
  assert.match(result.get('s4')?.continuity ?? '', /reset at time-jump/u)
  assert.deepEqual(result.get('s2')?.sounds, selections.get('s2')?.sounds)
  assert.deepEqual(result.get('s2')?.pauses, selections.get('s2')?.pauses)
  segments[2].speakerId = UNCAST_SPEAKER_ID
  assert.deepEqual(applyTtsSpeakerContinuity(segments, plan, selections, 'fish').get('s2')?.emotions, ['calm'])
})

test('falls back to calm when the primary emotion is a weak winner', () => {
  const content = ['Narration.', '', '"Wait. You heard that too?"'].join('\n')
  const plan = buildSpeakerDecisionPlan(content, [{ id: 'alice', name: 'Alice' }], false)
  const tagPlan = buildTtsTagPlan(plan)
  const selection = resolveTtsTagAnswers(tagPlan, {
    emotion_s0: {
      choice: 'happy',
      probabilities: { happy: 0.32, calm: 0.24, nervous: 0.2 },
      confidence: 0.28,
    },
  }, 'gemini').get('s0')
  assert.deepEqual(selection?.emotions, ['calm'])
  assert.equal(selection?.emotionProbability, 0.32)
  assert.equal(selection?.emotionConfidence, 0.28)
  assert.equal(selection?.ttsText, '[calm] Wait. You heard that too?')
})

test('suppresses optional cues below the strong thresholds but keeps emotion', () => {
  const content = ['Narration.', '', '"Wait. You heard that too?"'].join('\n')
  const plan = buildSpeakerDecisionPlan(content, [{ id: 'alice', name: 'Alice' }], false)
  const tagPlan = buildTtsTagPlan(plan)

  const weak = resolveTtsTagAnswers(tagPlan, {
    tag_s0: {
      choice: 'gasp',
      probabilities: { gasp: 0.6, no_tag: 0.4 },
      confidence: 0.9,
    },
    pause_s0: {
      choice: 'long',
      probabilities: { long: 0.55, no_pause: 0.45 },
      confidence: 0.9,
    },
  }, 'gemini').get('s0')
  assert.deepEqual(weak?.emotions, ['calm'])
  assert.deepEqual(weak?.sounds, [])
  assert.deepEqual(weak?.pauses, [])
  assert.equal(weak?.ttsText, '[calm] Wait. You heard that too?')

  const noTag = resolveTtsTagAnswers(tagPlan, {
    tag_s0: {
      choice: 'no_tag',
      probabilities: { no_tag: 0.9, gasp: 0.1 },
      confidence: 0.9,
    },
    pause_s0: {
      choice: 'no_pause',
      probabilities: { no_pause: 0.9, short: 0.1 },
      confidence: 0.9,
    },
  }, 'gemini').get('s0')
  assert.deepEqual(noTag?.sounds, [])
  assert.deepEqual(noTag?.pauses, [])
})

test('preserves existing tags, normalizes style, and can add another sound', () => {
  const content = '"No. [sigh] Fine."'
  const plan = buildSpeakerDecisionPlan(content, [{ id: 'alice', name: 'Alice' }], false)
  const tagPlan = buildTtsTagPlan(plan)

  const added = resolveTtsTagAnswers(tagPlan, {
    emotion_s0: {
      choice: 'sad',
      probabilities: { sad: 0.9, calm: 0.1 },
      confidence: 0.9,
    },
    tag_s0: {
      choice: 'gasp',
      probabilities: { gasp: 0.9, no_tag: 0.1 },
      confidence: 0.9,
    },
    tagpos_s0: {
      choice: 'end',
      probabilities: { start: 0.1, end: 0.8, b1: 0.1 },
      confidence: 0.9,
    },
  }, 'gemini').get('s0')
  assert.equal(added?.ttsText, '[sad] No. [sigh] Fine. [gasp]')
  assert.deepEqual(added?.sounds, ['gasp'])

  const same = resolveTtsTagAnswers(tagPlan, {
    emotion_s0: {
      choice: 'sad',
      probabilities: { sad: 0.9, calm: 0.1 },
      confidence: 0.9,
    },
    tag_s0: {
      choice: 'sigh',
      probabilities: { sigh: 0.9, no_tag: 0.1 },
      confidence: 0.9,
    },
  }, 'gemini').get('s0')
  assert.deepEqual(same?.sounds, [])
  assert.equal(same?.ttsText, '[sad] No. [sigh] Fine.')
})

test('keeps an existing leading emotion ahead of an inserted sound', () => {
  const content = '"[sad] Wait."'
  const plan = buildSpeakerDecisionPlan(content, [{ id: 'alice', name: 'Alice' }], false)
  const tagPlan = buildTtsTagPlan(plan)
  const selection = resolveTtsTagAnswers(tagPlan, {
    emotion_s0: {
      choice: 'sad',
      probabilities: { sad: 0.9, calm: 0.1 },
      confidence: 0.9,
    },
    tag_s0: {
      choice: 'gasp',
      probabilities: { gasp: 0.9, no_tag: 0.1 },
      confidence: 0.9,
    },
    tagpos_s0: {
      choice: 'start',
      probabilities: { start: 0.9, end: 0.1 },
      confidence: 0.9,
    },
  }, 'gemini').get('s0')
  assert.deepEqual(selection?.emotions, ['sad'])
  assert.equal(selection?.ttsText, '[sad] [gasp] Wait.')
})

test('normalizes both providers to brackets and validates grouped placement', () => {
  assert.equal(normalizeTtsTags('[gasp] <sigh> [unknown]', 'gemini'), '[gasp] [sigh] [unknown]')
  assert.equal(normalizeTtsTags('<gasp> [sigh]', 'fish'), '[gasp] [sigh]')
  assert.equal(stripTtsTags('Wait. [gasp] You <sigh> heard.'), 'Wait.  You  heard.')
  assert.equal(validateTtsTagPlacement('Wait. You heard.', 'Wait. [gasp] You heard.', 'gasp'), true)
  assert.equal(validateTtsTagPlacement('Wait. You heard.', 'Wait. You heard.', 'gasp'), false)
  assert.equal(validateTtsTagPlacement('Wait. You heard.', 'Wait. [sigh] You heard.', 'gasp'), false)
  assert.equal(validateTtsTagPlacement('Wait. You heard.', 'Wait. [gasp] You heard!', 'gasp'), false)

  const original = '[happy] Wait. You heard.'
  const request = {
    emotions: ['happy'],
    styles: [],
    sounds: ['gasp'],
    pauses: ['short' as const],
  }
  assert.equal(
    validateTtsSpeechPlacement(original, '[happy] Wait. [gasp] You [break] heard.', request, 'gemini'),
    true,
  )
  assert.equal(
    validateTtsSpeechPlacement(original, '[happy] Wait. [gasp] You heard.', request, 'gemini'),
    false,
  )
  assert.equal(
    validateTtsSpeechPlacement(original, '[sad] Wait. [gasp] You [break] heard.', request, 'gemini'),
    false,
  )
  assert.equal(
    validateTtsSpeechPlacement(original, '[happy] Wait. [sigh] You [break] heard.', request, 'gemini'),
    false,
  )
  assert.equal(
    validateTtsSpeechPlacement(
      '[happy] [moved] Wait. You heard.',
      '[happy] [moved] Wait. [gasp] You [sigh] [break] heard. [long-break]',
      { emotions: ['happy', 'moved'], styles: [], sounds: ['gasp', 'sigh'], pauses: ['short', 'long'] },
      'gemini',
    ),
    true,
  )
  assert.equal(
    validateTtsSpeechPlacement(
      'Wait. You heard.',
      'Wait. <gasp> You heard. <short pause>',
      { emotions: [], styles: [], sounds: ['gasp'], pauses: ['short'] },
      'gemini38',
    ),
    true,
  )
})

test('removes leading speech dashes without changing internal or trailing dashes', () => {
  assert.equal(
    normalizeSpeechBoundaryDashes('[confident] —sorry about that. [confident] No, I am here—'),
    '[confident] sorry about that. [confident] No, I am here—',
  )
  assert.equal(
    normalizeSpeechBoundaryDashes('—Wait — I need to explain–'),
    'Wait — I need to explain–',
  )
  assert.equal(
    normalizeSpeechBoundaryDashes('<soft> – Give me a moment.'),
    '<soft> Give me a moment.',
  )
})

test('attaches emotion, sound, and pause text without changing narration', () => {
  const content = ['Narration.', '', '"Wait."', '', '"No."'].join('\n')
  const plan = buildSpeakerDecisionPlan(content, [{ id: 'alice', name: 'Alice' }], false)
  const tagPlan = buildTtsTagPlan(plan)
  const selections = resolveTtsTagAnswers(tagPlan, {
    emotion_s0: {
      choice: 'happy',
      probabilities: { happy: 0.9, calm: 0.1 },
      confidence: 0.9,
    },
    tag_s0: {
      choice: 'gasp',
      probabilities: { gasp: 0.9, no_tag: 0.1 },
      confidence: 0.9,
    },
    pause_s0: {
      choice: 'long',
      probabilities: { long: 0.9, no_pause: 0.1 },
      confidence: 0.9,
    },
    pausepos_s0: {
      choice: 'end',
      probabilities: { start: 0.1, end: 0.8, b1: 0.1 },
      confidence: 0.9,
    },
  }, 'gemini')
  const segments = parseRosterVoiceSegments(content, 'alice', [{ id: 'alice', name: 'Alice' }])
  const tagged = applyTtsTagSelections(segments, tagPlan, selections, true)
  const speech = tagged.find(segment => segment.text === 'Wait.')
  assert.equal(speech?.text, 'Wait.')
  assert.equal(speech?.ttsText, '[happy] [gasp] Wait. [long-break]')
  assert.deepEqual(speech?.ttsTag?.emotions, ['happy'])
  assert.deepEqual(speech?.ttsTag?.sounds, ['gasp'])
  assert.deepEqual(speech?.ttsTag?.pauses, ['long'])
  assert.equal(tagged.find(segment => segment.text === 'Narration.')?.ttsText, undefined)
})

test('preserves speech IDs when splitting plans', () => {
  assert.deepEqual(mergeVoicePlan([{ text: 'One.\n\nTwo.', voice: 'alice', tagId: 's0' }]), [
    { text: 'One.', voice: 'alice', tagId: 's0' },
    { text: 'Two.', voice: 'alice', tagId: 's0' },
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

test('supports asymmetric tracker tag pairs alongside symmetric names', () => {
  const value = 'tracker, <o_ledger></o_l>, <o_plan class="x"></o_p>'
  assert.deepEqual(parseSkippedTrackerTagPairs(value), [
    { open: 'tracker', close: 'tracker' },
    { open: 'o_ledger', close: 'o_l' },
    { open: 'o_plan', close: 'o_p' },
  ])
  assert.deepEqual(parseSkippedTrackerTags(value), ['tracker', 'o_ledger', 'o_plan'])
})

test('removes asymmetric tracker blocks including nested and escaped forms', () => {
  assert.equal(
    stripSkippedTrackerBlocks('Before<o_ledger>hidden</o_l>After', '<o_ledger></o_l>'),
    'Before After',
  )
  assert.equal(
    stripSkippedTrackerBlocks(
      'A<o_ledger>one<o_ledger>two</o_l>three</o_l>B',
      '<O_LEDGER></O_L>',
    ),
    'A B',
  )
  assert.equal(
    stripSkippedTrackerBlocks(
      'A&lt;o_ledger id="x"&gt;hidden&lt;/o_l &gt;B',
      '<o_ledger></o_l>',
    ),
    'A B',
  )
  assert.equal(
    stripSkippedTrackerBlocks(
      'Before\n<o_ledger>\nhidden\n</o_l>\nAfter',
      '<o_ledger></o_l>',
    ),
    'Before\n \nAfter',
  )
  assert.equal(
    stripSkippedTrackerBlocks('<o_ledger>hidden</o_ledger>', '<o_ledger></o_l>'),
    '<o_ledger>hidden</o_ledger>',
  )
  assert.equal(
    stripSkippedTrackerBlocks('A<o_ledger/>B', '<o_ledger></o_l>'),
    'A<o_ledger/>B',
  )
})

test('skips quotations inside asymmetric tracker blocks during playback', () => {
  assert.deepEqual(
    parseRosterVoiceSegments(
      '"Keep this." <o_ledger>"Do not synthesize this."</o_l> Narration remains.',
      'alice',
      [{ id: 'alice', name: 'Alice' }],
      '<o_ledger></o_l>',
    ),
    [
      { text: 'Keep this.', speakerId: 'alice' },
      { text: 'Narration remains.', speakerId: null },
    ],
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

test('validates favorite voice IDs and classifications', () => {
  assert.deepEqual(readFavoriteVoices([
    { id: ' voice-1 ', name: ' Alice ', category: 'female', description: ' warm and gentle ' },
    { id: 'voice-2', name: 'Bob', category: 'male' },
    { id: 'voice-3', category: 'other' },
    { id: 'voice-1', name: 'Duplicate', category: 'male' },
    { id: ' ' }, null,
  ]), [
    { id: 'voice-1', name: 'Alice', category: 'female', description: 'warm and gentle' },
    { id: 'voice-2', name: 'Bob', category: 'male', description: '' },
    { id: 'voice-3', name: '', category: 'unspecified', description: '' },
  ])
  assert.deepEqual(readFavoriteVoices(null), [])
})

test('rejects duplicate favorite voice IDs even if names differ or whitespace is present', () => {
  const existing = readFavoriteVoices([{ id: 'Voice-1', name: 'First' }])
  const duplicate = { id: ' Voice-1 ', name: 'Another', category: 'male' as const, description: '' }
  assert.throws(() => addFavoriteVoice(existing, duplicate), /already a favorite/u)
  assert.deepEqual(existing.map(voice => voice.name), ['First'])
  assert.equal(addFavoriteVoice(existing, { ...duplicate, id: 'voice-1' }).length, 2)
})

test('matches uncast voice groups without using cast voices or crossing gender categories', () => {
  const segments = [
    { text: 'The clerk arrives.', speakerId: null },
    { text: 'Hello.', speakerId: UNCAST_SPEAKER_ID },
    { text: 'She waits.', speakerId: null },
    { text: 'Come in.', speakerId: UNCAST_SPEAKER_ID },
    { text: 'Thanks.', speakerId: 'mira' },
    { text: 'Next.', speakerId: UNCAST_SPEAKER_ID },
  ]
  const groups = collectUncastVoiceGroups(segments)
  assert.deepEqual(groups.map(group => group.segmentIndexes), [[1, 3], [5]])
  const voices = readFavoriteVoices([
    { id: 'in-use', category: 'female', description: 'gentle' },
    { id: 'female', category: 'female', description: 'gentle warm' },
    { id: 'male', category: 'male', description: 'commanding' },
  ])
  const available = availableUncastVoices(voices, ['in-use'])
  assert.deepEqual(available.map(voice => voice.id), ['female', 'male'])
  const plan = buildUncastVoiceDecision(groups, available, 'Scene context')
  assert.equal(Object.keys(plan.questions).length, 6)
  assert.ok(!Object.keys(plan.questions).some(key => key.startsWith('trait_')))
  assert.match(plan.questions.voice_g0.criteria.voice_0, /gentle warm/u)
  const matches = resolveUncastVoiceDecisions(groups, available, {
    gender_g0: confidentDecision('female'),
    voice_g0: { choice: 'voice_1', probabilities: { voice_0: 0.4, voice_1: 0.6 }, confidence: 0.8 },
    gender_g1: confidentDecision('unknown'),
    voice_g1: { choice: 'voice_0', probabilities: { voice_0: 0.6, voice_1: 0.4 }, confidence: 0.8 },
  })
  assert.deepEqual(matches.map(match => [match.voiceId, match.gender]), [
    ['female', 'female'], ['male', 'unknown'],
  ])
  assert.deepEqual(resolveUncastVoiceDecisions(groups, [], {}), [])
  assert.deepEqual(resolveUncastVoiceDecisions(groups, available, {
    voice_g0: confidentDecision('no_match'),
  }), [])
})

test('keeps ghost voices for the configured count of assistant messages and never links weak identities', () => {
  const ids = Array.from({ length: 13 }, (_, index) => `assistant-${index}`)
  const ghost = { id: 'ghost-1', speakerId: UNCAST_SPEAKER_ID, voiceId: 'voice-1', context: 'The clerk spoke.', occurrenceKeys: [], lastSeenMessageId: ids[0] }
  assert.equal(activeGhostVoices([ghost], ids, ids[10]).length, 1)
  assert.equal(activeGhostVoices([ghost], ids, ids[11]).length, 0)
  assert.equal(activeGhostVoices([ghost], ids, ids[3], 2).length, 0)
  const groups = collectUncastVoiceGroups([{ text: 'Next please.', speakerId: UNCAST_SPEAKER_ID }])
  const strong = resolveUncastVoiceDecisions(groups, [], {
    identity_g0: confidentDecision('ghost_0'),
  }, [ghost])
  assert.equal(strong[0]?.voiceId, 'voice-1')
  assert.deepEqual(resolveUncastVoiceDecisions(groups, [], {
    identity_g0: { choice: 'ghost_0', probabilities: { ghost_0: 0.6, new_or_unclear: 0.4 }, confidence: 0.6 },
  }, [ghost]), [])
  assert.deepEqual(resolveUncastVoiceDecisions(groups, [], {
    identity_g0: confidentDecision('ghost_0'),
  }, [ghost], ['voice-1']), [])
  const replay = { ...ghost, lastSeenMessageId: ids[10], occurrenceKeys: [`${ids[0]}:stored`] }
  assert.equal(activeGhostVoices([replay], ids, ids[0], 1).length, 1)
  assert.equal(activeGhostVoices([replay], ids, ids[1], 10).length, 1)
})

test('reuses a ghost voice for a weak identity only when the follow-up review confirms it', () => {
  const ghost = { id: 'ghost-girl', speakerId: UNCAST_SPEAKER_ID, voiceId: 'voice-girl', label: 'the girl', context: 'The girl ordered coffee.', occurrenceKeys: [], lastSeenMessageId: 'assistant-0' }
  const groups = collectUncastVoiceGroups([{ text: 'Shit.', speakerId: UNCAST_SPEAKER_ID }])
  const weakIdentity = { choice: 'ghost_0', probabilities: { ghost_0: 0.61, new_or_unclear: 0.2, uncast_character: 0.19 }, confidence: 0.53 }
  const confirmed = resolveUncastVoiceDecisions(groups, [], {
    identity_g0: weakIdentity,
    review_ghost_g0_0: { choice: 'same', probabilities: { same: 0.9, different_or_unclear: 0.1 }, confidence: 0.82 },
  }, [ghost])
  assert.equal(confirmed[0]?.voiceId, 'voice-girl')
  assert.equal(confirmed[0]?.ghostId, 'ghost-girl')
  const unconfirmed = resolveUncastVoiceDecisions(groups, [], {
    identity_g0: weakIdentity,
    review_ghost_g0_0: { choice: 'different_or_unclear', probabilities: { same: 0.3, different_or_unclear: 0.7 }, confidence: 0.7 },
  }, [ghost])
  assert.equal(unconfirmed.some(assignment => assignment.ghostId === 'ghost-girl'), false)
})

test('treats a repeated specific unnamed label as a voice match and ignores broad person labels', () => {
  const girl = { id: 'ghost-girl', speakerId: UNCAST_SPEAKER_ID, voiceId: 'voice-girl', label: 'the girl', context: 'A girl orders coffee.', occurrenceKeys: [], lastSeenMessageId: 'assistant-0' }
  const groups = collectUncastVoiceGroups([{ text: 'Thanks for pulling out.', speakerId: UNCAST_SPEAKER_ID }])
  const message = 'The girl sits down. "Thanks for pulling out."'
  const labelIndex = uncastIdentityLabels(message, [girl]).indexOf('the girl')
  const assigned = resolveUncastVoiceDecisions(groups, [], {
    identity_g0: { choice: 'new_or_unclear', probabilities: { new_or_unclear: 0.5, ghost_0: 0.3 }, confidence: 0.4 },
    label_g0: { choice: `label_${labelIndex}`, probabilities: { [`label_${labelIndex}`]: 0.95 }, confidence: 0.95 },
  }, [girl], [], 'later', message)
  assert.equal(assigned[0]?.ghostId, 'ghost-girl')
  const broad = { ...girl, id: 'ghost-woman', label: 'the woman', voiceId: 'voice-woman' }
  const broadMessage = 'The woman sits down. "Thanks for pulling out."'
  const broadIndex = uncastIdentityLabels(broadMessage, [broad]).indexOf('the woman')
  const broadAssigned = resolveUncastVoiceDecisions(groups, [], {
    identity_g0: { choice: 'new_or_unclear', probabilities: { new_or_unclear: 0.5, ghost_0: 0.3 }, confidence: 0.4 },
    label_g0: { choice: `label_${broadIndex}`, probabilities: { [`label_${broadIndex}`]: 0.95 }, confidence: 0.95 },
  }, [broad], [], 'later', broadMessage)
  assert.equal(broadAssigned.some(assignment => assignment.ghostId === 'ghost-woman'), false)
})

test('a vocative name inside a quote is a label candidate that a speaker answer can confirm', () => {
  const ghost = { id: 'ghost-ellis', speakerId: UNCAST_SPEAKER_ID, voiceId: 'voice-ellis', label: 'Ellis', aliases: ['Ellis'], context: 'A man stands by the gate.', occurrenceKeys: [], lastSeenMessageId: 'assistant-0' }
  const message = 'A man stands by the gate. "Leave it, Ellis. Come away."'
  const labelIndex = uncastIdentityLabels(message, [ghost]).indexOf('ellis')
  assert.ok(labelIndex >= 0)
  const groups = collectUncastVoiceGroups([{ text: 'Leave it, Ellis. Come away.', speakerId: UNCAST_SPEAKER_ID }])
  const assigned = resolveUncastVoiceDecisions(groups, [], {
    identity_g0: { choice: 'new_or_unclear', probabilities: { new_or_unclear: 0.5, ghost_0: 0.3 }, confidence: 0.4 },
    label_g0: { choice: `label_${labelIndex}`, probabilities: { [`label_${labelIndex}`]: 0.95 }, confidence: 0.95 },
  }, [ghost], [], 'later', message)
  assert.equal(assigned[0]?.ghostId, 'ghost-ellis')
  assert.ok(uncastIdentityLabels(message, []).includes('ellis'))
})

test('reveal review cites an earlier addressee of the same name in the ghost history', () => {
  const ghost = { id: 'ghost-unnamed', speakerId: UNCAST_SPEAKER_ID, voiceId: 'voice-ellis', label: 'the man', context: '', occurrenceKeys: [], lastSeenMessageId: 'assistant-0', conversationHistory: [{ messageId: 'assistant-0', text: 'A man stands by the gate. "Leave it, Ellis. Come away."' }] }
  const message = '"Ellis says, without turning his head." "Not yet."'
  const groups = collectUncastVoiceGroups([{ text: 'Not yet.', speakerId: 'unconfigured:ellis' }])
  const review = buildUncastIdentityReview(groups, {}, message, [ghost], 'later', [{ id: 'assistant-0', role: 'assistant', text: ghost.conversationHistory[0].text }])
  assert.match(review.questions.review_reveal_g0_0.instructions, /addressee/u)
})

test('links separate same-character runs to one ghost voice and gathers their local context', () => {
  const groups = collectUncastVoiceGroups([
    { speakerId: null, text: 'The clerk smiles.' },
    { speakerId: UNCAST_SPEAKER_ID, text: 'Hello.' },
    { speakerId: 'mira', text: 'Good morning.' },
    { speakerId: null, text: 'The clerk gestures to the door.' },
    { speakerId: UNCAST_SPEAKER_ID, text: 'Come in.' },
  ])
  assert.equal(groups.length, 2)
  assert.match(groups[0].context[0], /clerk smiles/u)
  assert.match(groups[1].context[0], /clerk gestures/u)
  const voices = readFavoriteVoices([{ id: 'voice-1', description: 'friendly and warm' }])
  const plan = buildUncastVoiceDecision(groups, voices, 'The scene.')
  assert.match(plan.questions.identity_g1.criteria.group_g0, /clerk smiles/u)
  const result = resolveUncastVoiceDecisions(groups, voices, {
    voice_g0: confidentDecision('voice_0'),
    identity_g1: confidentDecision('group_g0'),
  })
  assert.deepEqual(result.map(item => item.voiceId), ['voice-1', 'voice-1'])
  assert.equal(result[1].ghostId, result[0].ghostId)
})

test('combines interrupted uncast groups before selecting their voice', () => {
  const groups = collectUncastVoiceGroups([
    { speakerId: null, text: 'The clerk speaks.' },
    { speakerId: UNCAST_SPEAKER_ID, text: 'First.' },
    { speakerId: 'watt', text: 'Answer.' },
    { speakerId: null, text: 'The clerk responds.' },
    { speakerId: UNCAST_SPEAKER_ID, text: 'Next.' },
  ])
  const voices = readFavoriteVoices([{ id: 'clerk', category: 'male' }])
  const matches = resolveUncastVoiceDecisions(groups, voices, {
    voice_g0: confidentDecision('no_match'),
    identity_g1: confidentDecision('group_g0'),
    gender_g1: confidentDecision('male'),
    voice_g1: confidentDecision('voice_0'),
  })
  assert.deepEqual(matches.map(match => match.voiceId), ['clerk', 'clerk'])
  assert.equal(matches[0].ghostId, matches[1].ghostId)
  const weak = resolveUncastVoiceDecisions(groups, voices, {
    identity_g1: { choice: 'group_g0', probabilities: { group_g0: 0.6, new_or_unclear: 0.4 }, confidence: 0.6 },
    voice_g1: confidentDecision('voice_0'),
  })
  assert.deepEqual(weak.map(match => match.groupId), ['g1'])
})

test('strong pairwise identity links override conflicting cached turn voices', () => {
  const groups = collectUncastVoiceGroups([
    { speakerId: UNCAST_SPEAKER_ID, text: 'First.' },
    { speakerId: 'watt', text: 'Answer.' },
    { speakerId: UNCAST_SPEAKER_ID, text: 'Second.' },
  ])
  const ghosts = groups.map((group, index) => ({ id: `ghost-${index}`, speakerId: UNCAST_SPEAKER_ID, voiceId: `voice-${index}`, context: 'The clerk.', occurrenceKeys: [`message:${hashMessageContent(group.speeches.join('\n'))}`], lastSeenMessageId: 'message' }))
  const answers = { same_g1_g0: confidentDecision('same'), review_occurrence_g0_0: confidentDecision('same') }
  const matches = resolveUncastVoiceDecisions(groups, [], answers, ghosts, [], 'message')
  assert.deepEqual(matches.map(match => match.voiceId), ['voice-0', 'voice-0'])
  assert.match(buildUncastVoiceDecision(groups, [], 'The clerk and Watt.').questions.same_g1_g0.instructions, /same individual/u)
})

test('retains a confident descriptive uncast identity across turns and messages', () => {
  const groups = collectUncastVoiceGroups([
    { speakerId: UNCAST_SPEAKER_ID, text: 'First.' },
    { speakerId: 'watt', text: 'Answer.' },
    { speakerId: UNCAST_SPEAKER_ID, text: 'Second.' },
  ])
  const message = "The clerk's quill moves. The clerk speaks."
  const plan = buildUncastVoiceDecision(groups, [], message)
  const labelKey = Object.entries(plan.questions.label_g0.criteria).find(([, label]) => label === 'the clerk')?.[0]
  assert.ok(labelKey)
  const ghost = { id: 'clerk-ghost', speakerId: UNCAST_SPEAKER_ID, label: 'the clerk', voiceId: 'clerk-voice', context: 'The clerk speaks.', occurrenceKeys: [], lastSeenMessageId: 'previous' }
  const result = resolveUncastVoiceDecisions(groups, [], {
    label_g0: confidentDecision(labelKey), label_g1: confidentDecision(labelKey),
  }, [ghost], [], 'current', message)
  assert.deepEqual(result.map(item => [item.voiceId, item.label]), [['clerk-voice', 'the clerk'], ['clerk-voice', 'the clerk']])
  const weak = resolveUncastVoiceDecisions(groups, [], {
    label_g0: { choice: labelKey, confidence: 0.4, probabilities: { [labelKey]: 0.6, none: 0.4 } },
  }, [ghost], [], 'current', message)
  assert.deepEqual(weak, [])
})

test('uses a clear label below the identity threshold and prefers the prior message over a stale replay', () => {
  const groups = collectUncastVoiceGroups([{ speakerId: UNCAST_SPEAKER_ID, text: 'Continue.' }])
  const message = 'The clerk speaks.'
  const ghosts = [
    { id: 'stale', speakerId: UNCAST_SPEAKER_ID, label: 'the clerk', voiceId: 'stale-voice', context: '', occurrenceKeys: [`current:${hashMessageContent('Continue.')}`], lastSeenMessageId: 'current' },
    { id: 'prior', speakerId: UNCAST_SPEAKER_ID, label: 'the clerk', voiceId: 'prior-voice', context: '', occurrenceKeys: ['prior:abc'], lastSeenMessageId: 'prior' },
  ]
  const result = resolveUncastVoiceDecisions(groups, [], {
    label_g0: { choice: 'label_0', confidence: 0.77, probabilities: { label_0: 0.77, none: 0.05, label_1: 0.16 } },
  }, ghosts, [], 'current', message, ['prior'])
  assert.equal(result[0]?.voiceId, 'prior-voice')
})

test('reviews uncast turns separately when a long narrative may introduce someone else', () => {
  const groups = collectUncastVoiceGroups([
    { speakerId: UNCAST_SPEAKER_ID, text: 'The guard speaks.' },
    { speakerId: null, text: 'They cross the camp. '.repeat(20) + 'The clerk looks up.' },
    { speakerId: UNCAST_SPEAKER_ID, text: 'The clerk speaks.' },
  ])
  assert.deepEqual(groups.map(group => group.segmentIndexes), [[0], [2]])
})

test('separates named-action dialogue and adjacent replies before resolving Dennis continuity', () => {
  const segments = [
    { speakerId: UNCAST_SPEAKER_ID, text: 'Next two, get your orders ready.' },
    { speakerId: null, text: 'She calls without breaking eye contact.' },
    { speakerId: UNCAST_SPEAKER_ID, text: "I can take his order for him." },
    { speakerId: null, text: 'Dennis huffs through his nose at the register, still not turning round.' },
    { speakerId: UNCAST_SPEAKER_ID, text: "You're going to hell, Lisa." },
    { speakerId: UNCAST_SPEAKER_ID, text: "I'm going to my break at two." },
    { speakerId: null, text: 'She fires back. The tongs click.' },
    { speakerId: UNCAST_SPEAKER_ID, text: 'Which is more than some of us get.' },
  ]
  const groups = collectUncastVoiceGroups(segments)
  assert.deepEqual(groups.map(group => group.segmentIndexes), [[0, 2], [4], [5, 7]])
  const message = `Lisa calls out. Dennis huffs through his nose at the register. "You're going to hell, Lisa." "I'm going to my break at two," she fires back.`
  const voices = readFavoriteVoices([{ id: 'lisa-voice', category: 'female' }, { id: 'dennis-voice', category: 'male' }])
  const plan = buildUncastVoiceDecision(groups, voices, message)
  const dennis = plan.state.narrativeNames.findIndex(name => name.toLowerCase() === 'dennis')
  const lisa = plan.state.narrativeNames.findIndex(name => name.toLowerCase() === 'lisa')
  assert.ok(dennis >= 0 && lisa >= 0)
  const answers: Record<string, SpeakerDecisionChoice> = {
    narrative_name_g0: confidentDecision(`name_${lisa}`), narrative_name_g1: confidentDecision(`name_${dennis}`), narrative_name_g2: confidentDecision(`name_${lisa}`),
    same_g1_g0: confidentDecision('different_or_unclear'), same_g2_g0: confidentDecision('same'), same_g2_g1: confidentDecision('different_or_unclear'),
    gender_g0: confidentDecision('female'), gender_g1: confidentDecision('male'), gender_g2: confidentDecision('female'),
    voice_g0: confidentDecision('voice_0'), voice_g1: confidentDecision('voice_1'), voice_g2: confidentDecision('voice_0'),
  }
  const assigned = resolveUncastVoiceDecisions(groups, voices, answers, [], [], 'first', message)
  assert.deepEqual(groups.map(group => assigned.find(item => item.groupId === group.id)?.voiceId), ['lisa-voice', 'dennis-voice', 'lisa-voice'])
  assert.ok(assigned.find(item => item.groupId === 'g1')?.aliases?.includes('dennis'))
  const ghost = { id: 'dennis', speakerId: UNCAST_SPEAKER_ID, voiceId: 'dennis-voice', label: 'dennis', aliases: ['dennis'], context: 'Dennis huffs at the register.', occurrenceKeys: [], lastSeenMessageId: 'first' }
  const later = 'Lisa calls to Dennis. "You are what?" The steamer goes off. Dennis slaps the counter. "LISA. Machine!"'
  const nextGroups = collectUncastVoiceGroups([
    { speakerId: UNCAST_SPEAKER_ID, text: 'You are what?' },
    { speakerId: null, text: 'The steamer goes off. Dennis slaps the counter.' },
    { speakerId: UNCAST_SPEAKER_ID, text: 'LISA. Machine!' },
  ])
  const nextPlan = buildUncastVoiceDecision(nextGroups, [], later, [ghost])
  const nextDennis = nextPlan.state.narrativeNames.findIndex(name => name.toLowerCase() === 'dennis')
  assert.ok(nextDennis >= 0)
  const next = resolveUncastVoiceDecisions(nextGroups, [], { narrative_name_g0: confidentDecision(`name_${nextDennis}`), narrative_name_g1: confidentDecision(`name_${nextDennis}`) }, [ghost], [], 'next', later, ['first'])
  assert.deepEqual(next.map(item => item.voiceId), ['dennis-voice', 'dennis-voice'])
  const conflict = resolveUncastVoiceDecisions(groups, voices, { ...answers, same_g1_g0: confidentDecision('same') }, [], [], 'first', message)
  assert.notEqual(conflict.find(item => item.groupId === 'g0')?.ghostId, conflict.find(item => item.groupId === 'g1')?.ghostId)
})

test('automatic casting respects reserved voices, gender, and no match', () => {
  const voices = readFavoriteVoices([{ id: 'used', category: 'male' }, { id: 'female', category: 'female' }, { id: 'male', category: 'male' }])
  const answer = { choice: 'voice_0', confidence: 0.9, probabilities: { voice_0: 0.8, voice_1: 0.15, voice_2: 0.05, no_match: 0 } }
  assert.equal(selectAutomaticVoice(voices, new Set(['used']), answer, 'male'), 'male')
  assert.equal(selectAutomaticVoice(voices, new Set(['used']), answer, 'female'), 'female')
  assert.equal(selectAutomaticVoice(voices, new Set(), { ...answer, choice: 'no_match' }, 'unknown'), '')
})

test('automatic voice reservations reject exhausted voices and preserve existing ghost ownership', () => {
  const ghost = { id: 'one', speakerId: UNCAST_SPEAKER_ID, voiceId: 'last-voice', context: '', occurrenceKeys: [], lastSeenMessageId: 'message' }
  assert.equal(canReserveAutomaticVoice('last-voice', new Set(), [ghost]), false)
  assert.equal(canReserveAutomaticVoice('last-voice', new Set(), [ghost], 'one'), true)
  assert.equal(canReserveAutomaticVoice('last-voice', new Set(['last-voice']), [ghost], 'one'), false)
  assert.equal(canReserveAutomaticVoice('', new Set(), []), false)
  const voices = readFavoriteVoices([{ id: 'last-voice' }])
  assert.equal(selectAutomaticVoice(voices, new Set(['last-voice']), confidentDecision('voice_0'), 'unknown'), '')
})

test('uncast voice matching excludes narration-only people and only groups actual speech', () => {
  const narration = 'The clerk watches silently. The guard waits by the door.'
  const segments = parseRosterVoiceSegments(narration, null, [], '', null, true)
  assert.deepEqual(collectUncastVoiceGroups(segments), [])
  const groups = collectUncastVoiceGroups([
    { speakerId: UNCAST_SPEAKER_ID, text: 'A silent clerk watches.', debugPath: ['segment-type:narration'] },
    { speakerId: UNCAST_SPEAKER_ID, text: 'Come in.', debugPath: ['segment-type:speech (quote 1)'] },
  ])
  assert.deepEqual(groups.map(group => group.speeches), [['Come in.']])
  const plan = buildUncastVoiceDecision(groups, readFavoriteVoices([{ id: 'voice' }]), 'The clerk watches. "Come in."')
  assert.match(plan.questions.label_g0.instructions, /actually speaks/u)
  assert.match(plan.questions.voice_g0.instructions, /Narration-only bystanders/u)
})

test('regeneration ranks only voices available against both historical and current ghosts', () => {
  const ids = ['earlier', 'later']
  const historical = { id: 'old', speakerId: UNCAST_SPEAKER_ID, voiceId: 'old-voice', context: '', occurrenceKeys: [], lastSeenMessageId: 'earlier' }
  const current = { id: 'new', speakerId: UNCAST_SPEAKER_ID, voiceId: 'new-voice', context: '', occurrenceKeys: [], lastSeenMessageId: 'later' }
  const ghosts = [historical, current]
  const atMessage = activeGhostVoices(ghosts, ids, 'earlier')
  const now = activeGhostVoices(ghosts, ids, 'later')
  const favorites = readFavoriteVoices([{ id: 'old-voice' }, { id: 'new-voice' }, { id: 'free-voice' }])
  const available = availableUncastVoices(favorites, [...atMessage, ...now].map(ghost => ghost.voiceId))
  assert.deepEqual(available.map(voice => voice.id), ['free-voice'])
  const groups = collectUncastVoiceGroups([{ speakerId: UNCAST_SPEAKER_ID, text: 'Hello again.' }])
  const fresh = resolveUncastVoiceDecisions(groups, available, { voice_g0: confidentDecision('voice_0') }, [], [], 'earlier')
  assert.equal(fresh[0]?.voiceId, 'free-voice')
  assert.equal(fresh[0]?.ghostId, 'pending:g0')
})

test('refreshes temporary voice expiry when used, including playback of older messages', () => {
  const ids = Array.from({ length: 25 }, (_, index) => `assistant-${24 - index}`)
  const ghost = { id: 'ghost', speakerId: UNCAST_SPEAKER_ID, voiceId: 'voice', context: '', occurrenceKeys: [`${ids[0]}:speech`], lastSeenMessageId: ids[0] }
  assert.equal(activeGhostVoices([ghost], ids, ids[11], 10).length, 0)
  markGhostVoiceInvoked(ghost, ids.slice(0, 13), ids[1])
  const restored = readGhostVoices([ghost])[0]
  assert.equal(restored.lastInvokedAtMessageId, ids[12])
  assert.equal(restored.lastSeenMessageId, ids[0])
  markGhostVoiceInvoked(restored, ids.slice(0, 20), ids[0])
  assert.equal(restored.lastInvokedAtMessageId, ids[12])
  markGhostVoiceInvoked(restored, ids.slice(0, 20), ids[2])
  assert.equal(restored.lastInvokedAtMessageId, ids[19])
  markGhostVoiceInvoked(restored, ids, ids[2])
  assert.equal(restored.lastInvokedAtMessageId, ids[19])
  restored.lastInvokedAtMessageId = ids[12]
  assert.equal(activeGhostVoices([restored], ids, ids[22], 10).length, 1)
  assert.equal(activeGhostVoices([restored], ids, ids[23], 10).length, 0)
  assert.equal(activeGhostVoices([restored], ids, ids[11], 10).length, 0)
  assert.equal(activeGhostVoices([restored], ids, ids[0], 10).length, 1)
})

test('purges only expired temporary voice context using the latest assistant message', () => {
  const ids = Array.from({ length: 13 }, (_, index) => `message-${index}`)
  const expired = { id: 'old', speakerId: UNCAST_SPEAKER_ID, voiceId: 'old-voice', context: 'Old scene', conversationHistory: [{ messageId: ids[0], text: 'Old dialogue' }], occurrenceKeys: [], lastSeenMessageId: ids[0] }
  const active = { id: 'active', speakerId: UNCAST_SPEAKER_ID, voiceId: 'active-voice', context: 'Recent scene', conversationHistory: [{ messageId: ids[11], text: 'Recent dialogue' }], occurrenceKeys: [], lastSeenMessageId: ids[11] }
  assert.equal(purgeExpiredGhostContexts([expired, active], [], 10), false)
  assert.equal(purgeExpiredGhostContexts([expired, active], ids, 10), true)
  assert.equal(expired.context, '')
  assert.deepEqual(expired.conversationHistory, [])
  assert.equal(active.context, 'Recent scene')
  assert.equal(active.conversationHistory.length, 1)
  assert.equal(purgeExpiredGhostContexts([expired, active], ids, 10), false)
})

test('new ghosts from older regenerated messages appear until their creation lifetime expires', () => {
  const ids = Array.from({ length: 25 }, (_, index) => `assistant-${index}`)
  const ghost = { id: 'new', speakerId: UNCAST_SPEAKER_ID, voiceId: 'voice', context: '', occurrenceKeys: [`${ids[0]}:speech`], lastSeenMessageId: ids[0], createdAtMessageId: ids[12] }
  assert.equal(activeGhostVoices([ghost], ids, ids[12], 10).length, 1)
  assert.equal(activeGhostVoices([ghost], ids, ids[22], 10).length, 1)
  assert.equal(activeGhostVoices([ghost], ids, ids[23], 10).length, 0)
  assert.equal(activeGhostVoices([ghost], ids, ids[0], 10).length, 1)
  assert.equal(activeGhostVoices([ghost], ids, ids[11], 10).length, 0)
})

test('retains confirmed ghost aliases for matching and promotion', () => {
  const ghost = readGhostVoices([{ id: 'ghost', speakerId: 'unconfigured:cobb', label: 'the farrier', aliases: ['COBB', 'the farrier', 'the healer'], voiceId: 'voice', context: '', occurrenceKeys: [], lastSeenMessageId: 'previous' }])[0]
  assert.deepEqual(ghostCastAliases(ghost), ['cobb', 'the farrier', 'the healer'])
  assert.deepEqual(mergeGhostAliases(['Cobb / the farrier'], ['cobb', 'the healer']), ['Cobb', 'the farrier', 'the healer'])
  const groups = collectUncastVoiceGroups([{ speakerId: 'unconfigured:the healer', text: 'I can help.' }])
  const matches = resolveUncastVoiceDecisions(groups, [], {}, [ghost])
  assert.equal(matches[0]?.ghostId, 'ghost')
  assert.deepEqual(matches[0]?.aliases, ['the healer'])
  const ambiguous = resolveUncastVoiceDecisions(groups, [], {}, [ghost, { ...ghost, id: 'other', voiceId: 'another' }])
  assert.deepEqual(ambiguous, [])
})

test('keeps bounded occurrence provenance while preserving legacy occurrence keys', () => {
  const ghost = readGhostVoices([{ id: 'g', speakerId: UNCAST_SPEAKER_ID, voiceId: 'v', context: '', occurrenceKeys: ['old:legacy'], lastSeenMessageId: 'old' }])[0]
  recordGhostOccurrence(ghost, 'new', 'message-hash', 'speech-hash', 'Jev identity match')
  recordGhostOccurrence(ghost, 'new', 'message-hash', 'speech-hash', 'confirmed')
  const restored = readGhostVoices([ghost])[0]
  assert.deepEqual(restored.occurrenceKeys, ['old:legacy'])
  assert.deepEqual(restored.occurrenceEvidence, [{ messageId: 'new', messageHash: 'message-hash', speechHash: 'speech-hash', version: 'occurrence-1', reason: 'confirmed' }])
})

test('requires identity review before matching broad person descriptions to earlier ghosts', () => {
  const group = collectUncastVoiceGroups([{ speakerId: 'unconfigured:the woman', text: 'Sit anywhere.' }])
  const ghost = { id: 'old', speakerId: 'unconfigured:the woman', label: 'the woman', voiceId: 'old-voice', context: 'A woman at another location.', occurrenceKeys: [], lastSeenMessageId: 'previous' }
  const voices = readFavoriteVoices([{ id: 'new-voice' }])
  const fresh = resolveUncastVoiceDecisions(group, voices, { voice_g0: confidentDecision('voice_0') }, [ghost])
  assert.equal(fresh[0].voiceId, 'new-voice')
  assert.match(fresh[0].matchReason!, /new voice/u)
  const reviewed = resolveUncastVoiceDecisions(group, voices, { identity_g0: confidentDecision('ghost_0') }, [ghost])
  assert.equal(reviewed[0].voiceId, 'old-voice')
  assert.match(reviewed[0].matchReason!, /Jev identity match: old/u)
  const occurrence = { ...ghost, occurrenceKeys: [`current:${hashMessageContent('Sit anywhere.')}`] }
  const replay = resolveUncastVoiceDecisions(group, voices, {}, [occurrence], [], 'current')
  assert.deepEqual(replay, [])
  const confirmedReplay = resolveUncastVoiceDecisions(group, voices, { review_occurrence_g0_0: confidentDecision('same') }, [occurrence], [], 'current')
  assert.match(confirmedReplay[0].matchReason!, /exact message occurrence/u)
})

test('a contested saved occurrence is reviewed and does not force a voice or overwrite the ghost', () => {
  const group = collectUncastVoiceGroups([{ speakerId: UNCAST_SPEAKER_ID, text: 'No, I know what you meant.' }])
  const ghost = { id: 'halloran', speakerId: 'unconfigured:halloran', label: 'Halloran', voiceId: 'halloran-voice', context: 'Halloran works in an office.', occurrenceKeys: [`current:${hashMessageContent('No, I know what you meant.')}`], lastSeenMessageId: 'current' }
  const answers: Record<string, SpeakerDecisionChoice> = { identity_g0: { choice: 'ghost_0', confidence: 0.55, probabilities: { ghost_0: 0.65, new_or_unclear: 0.35 } } }
  const review = buildUncastIdentityReview(group, answers, 'A speaker with a tray turns back.', [ghost], 'current')
  assert.ok(review.questions.review_occurrence_g0_0)
  const before = structuredClone(ghost)
  assert.deepEqual(resolveUncastVoiceDecisions(group, readFavoriteVoices([{ id: 'other-voice' }]), { ...answers, review_occurrence_g0_0: confidentDecision('different_or_unclear') }, [ghost], [], 'current'), [])
  assert.deepEqual(ghost, before)
  const confirmed = resolveUncastVoiceDecisions(group, [], { ...answers, review_occurrence_g0_0: confidentDecision('same') }, [ghost], [], 'current')
  assert.equal(confirmed[0]?.ghostId, 'halloran')
})

test('a clearly different saved occurrence can receive a new voice without changing the old ghost', () => {
  const group = collectUncastVoiceGroups([{ speakerId: UNCAST_SPEAKER_ID, text: 'Seven-forty is the next one.' }])
  const key = `current:${hashMessageContent('Seven-forty is the next one.')}`
  const ghost = { id: 'wrong', speakerId: UNCAST_SPEAKER_ID, label: 'the woman', voiceId: 'old-voice', context: 'A different person.', occurrenceKeys: [key], lastSeenMessageId: 'current' }
  const before = structuredClone(ghost)
  const voices = readFavoriteVoices([{ id: 'new-voice' }])
  const answers: Record<string, SpeakerDecisionChoice> = { identity_g0: confidentDecision('new_or_unclear'), voice_g0: confidentDecision('voice_0'), review_occurrence_g0_0: confidentDecision('different_or_unclear') }
  const review = buildUncastIdentityReview(group, answers, 'A woman speaks at the tram stop.', [ghost], 'current')
  assert.ok(review.questions.review_occurrence_disposition_g0_0)
  assert.deepEqual(resolveUncastVoiceDecisions(group, voices, answers, [ghost], [], 'current'), [])
  const different = { ...answers, review_occurrence_disposition_g0_0: confidentDecision('different') }
  const replacement = resolveUncastVoiceDecisions(group, voices, different, [ghost], [], 'current')
  assert.equal(replacement[0]?.voiceId, 'new-voice')
  assert.match(replacement[0]?.ghostId ?? '', /^pending:/u)
  assert.deepEqual(ghost, before)
  const secondText = 'The next tram arrives.'
  const linkedGroups = collectUncastVoiceGroups([{ speakerId: UNCAST_SPEAKER_ID, text: 'Seven-forty is the next one.' }, { speakerId: null, text: 'A long description. '.repeat(20) }, { speakerId: UNCAST_SPEAKER_ID, text: secondText }])
  const repeated = { ...ghost, occurrenceKeys: [key, `current:${hashMessageContent(secondText)}`] }
  const linkedAnswers = { ...different, same_g1_g0: confidentDecision('same'), identity_g1: confidentDecision('group_g0'), voice_g1: confidentDecision('voice_0'), review_occurrence_g1_0: confidentDecision('different_or_unclear') }
  const linked = resolveUncastVoiceDecisions(linkedGroups, voices, linkedAnswers, [repeated], [], 'current')
  assert.equal(linked.length, 2)
  assert.equal(linked[0].ghostId, linked[1].ghostId)
  const conflictingGroups = { identity_g0: confidentDecision('ghost_0'), same_g1_g0: confidentDecision('same'), identity_g1: confidentDecision('new_or_unclear'), voice_g1: confidentDecision('voice_0'), review_occurrence_disposition_g1_0: confidentDecision('different') }
  assert.deepEqual(resolveUncastVoiceDecisions(linkedGroups, voices, conflictingGroups, [repeated], [], 'current'), [])
  const uncertain = { ...answers, review_occurrence_disposition_g0_0: confidentDecision('unclear') }
  assert.deepEqual(resolveUncastVoiceDecisions(group, voices, uncertain, [ghost], [], 'current'), [])
  const weakNew = { ...different, identity_g0: { choice: 'new_or_unclear', probabilities: { new_or_unclear: 0.6, ghost_0: 0.4 }, confidence: 0.5 } }
  assert.deepEqual(resolveUncastVoiceDecisions(group, voices, weakNew, [ghost], [], 'current'), [])
  const newer = { ...ghost, id: 'replacement', voiceId: 'new-voice' }
  const replayReview = buildUncastIdentityReview(group, {}, 'A woman speaks at the tram stop.', [ghost, newer], 'current')
  assert.ok(replayReview.questions.review_occurrence_g0_1)
  const replay = resolveUncastVoiceDecisions(group, [], { review_occurrence_g0_1: confidentDecision('same') }, [ghost, newer], [], 'current')
  assert.equal(replay[0]?.ghostId, 'replacement')
})

test('reviews borderline opening dialogue against a later clearly labeled speaker', () => {
  const groups = collectUncastVoiceGroups([
    { speakerId: null, text: 'Two clerks work. The elder is speaking.' },
    { speakerId: UNCAST_SPEAKER_ID, text: 'Carry the three to the oats column.' },
    { speakerId: 'watt', text: 'We have the tally.' },
    { speakerId: null, text: 'The clerk stops writing.' },
    { speakerId: UNCAST_SPEAKER_ID, text: 'Brenner?s infantry vanguard.' },
  ])
  const message = 'The clerk stops writing. The clerk speaks.'
  const voices = readFavoriteVoices([{ id: 'first' }, { id: 'second' }])
  const labelChoice = Object.entries(buildUncastVoiceDecision(groups, voices, message).questions.label_g1.criteria).find(([, label]) => label === 'the clerk')?.[0]
  assert.ok(labelChoice)
  const answers = {
    label_g1: confidentDecision(labelChoice),
    same_g1_g0: { choice: 'same', probabilities: { same: 0.88, different_or_unclear: 0.12 }, confidence: 0.76 },
    voice_g0: confidentDecision('voice_0'), voice_g1: confidentDecision('voice_1'),
  }
  const review = buildUncastIdentityReview(groups, answers, message)
  assert.ok(review.questions.review_same_g1_g0)
  assert.deepEqual(resolveUncastVoiceDecisions(groups, voices, answers).map(item => item.voiceId), ['first', 'second'])
  const confirmed = resolveUncastVoiceDecisions(groups, voices, { ...answers, review_same_g1_g0: confidentDecision('same') })
  assert.equal(confirmed[0].voiceId, confirmed[1].voiceId)
  const rejected = resolveUncastVoiceDecisions(groups, voices, { ...answers, review_same_g1_g0: confidentDecision('different_or_unclear') })
  assert.deepEqual(rejected.map(item => item.voiceId), ['first', 'second'])
  const weak = resolveUncastVoiceDecisions(groups, voices, { ...answers, review_same_g1_g0: { choice: 'same', probabilities: { same: 0.65, different_or_unclear: 0.35 }, confidence: 0.6 } })
  assert.deepEqual(weak.map(item => item.voiceId), ['first', 'second'])
  assert.deepEqual(Object.keys(buildUncastIdentityReview(groups, { ...answers, same_g1_g0: confidentDecision('different_or_unclear') }, message).questions), [])
})

test('automatic casting chooses the last compatible unused favorite', () => {
  const voices = readFavoriteVoices([{ id: 'already-used', category: 'female' }, { id: 'available', category: 'female' }, { id: 'male', category: 'male' }])
  const answer = { choice: 'no_match', confidence: 0.5, probabilities: { no_match: 0.7, voice_0: 0.2, voice_1: 0.1, voice_2: 0 } }
  assert.equal(selectAutomaticVoice(voices, new Set(['already-used']), answer, 'female'), 'available')
  assert.equal(selectAutomaticVoice(voices, new Set(['already-used', 'available']), answer, 'female'), '')
  const groups = collectUncastVoiceGroups([{ speakerId: UNCAST_SPEAKER_ID, text: 'Hello.' }])
  const one = readFavoriteVoices([{ id: 'available', category: 'female' }])
  assert.equal(resolveUncastVoiceDecisions(groups, one, { voice_g0: confidentDecision('no_match'), gender_g0: confidentDecision('female') })[0]?.voiceId, 'available')
  assert.deepEqual(resolveUncastVoiceDecisions(groups, one, { voice_g0: confidentDecision('no_match'), gender_g0: confidentDecision('male') }), [])
  const questions = buildUncastVoiceDecision(groups, voices, 'A speaker says hello.').questions
  assert.equal('no_match' in questions.voice_g0.criteria, false)
})

test('reviews assistant dialogue attributed to the user when another named subject is present', () => {
  const message = `"Nine-fifteen, Tessa." The voice crackles through the earpiece. Tessa's jaw stays clamped on the phone. Ken's hand rests on her hip.\n\n"Mom. Mom, I heard you."`
  const speakers = addUnconfiguredDialogueSpeakers(message, [{ id: USER_SPEAKER_ID, name: 'Ken' }])
  assert.equal(speakers.filter(speaker => speaker.name.toLowerCase() === 'ken').length, 1)
  assert.ok(speakers.some(speaker => speaker.name === 'Tessa'))
  const plan = buildSpeakerDecisionPlan(message, speakers, false)
  const userOption = plan.state.speakers.find(speaker => speaker.id === USER_SPEAKER_ID)!.option
  const tessaOption = plan.state.speakers.find(speaker => speaker.name === 'Tessa')!.option
  const answers = { speech_s0: confidentDecision('uncast_character'), speech_s1: confidentDecision(userOption, 0.68, 0.57) }
  const review = buildAssistantUserSpeakerReview(plan, answers)
  assert.ok(review.questions.user_review_s1)
  assert.equal(review.questions.user_review_s0, undefined)
  applyAssistantUserSpeakerReview(plan, answers, { user_review_s1: confidentDecision(tessaOption) })
  assert.equal(answers.speech_s1.choice, tessaOption)
  assert.equal(resolveSpeakerDecisionSegments(message, plan, answers, speakers, { isUserMessage: false, cardSpeakerId: null, historicalSpeakerId: null }).filter(segment => segment.text.includes('Mom.'))[0]?.speakerId, 'unconfigured:tessa')
  const weak = { speech_s1: confidentDecision(userOption, 0.68, 0.57) }
  applyAssistantUserSpeakerReview(plan, weak, { user_review_s1: confidentDecision(tessaOption, 0.7, 0.65) })
  assert.equal(weak.speech_s1.choice, userOption)
  const userMessagePlan = buildSpeakerDecisionPlan(message, speakers, true)
  assert.deepEqual(Object.keys(buildAssistantUserSpeakerReview(userMessagePlan, weak).questions), [])
})

test('discovers repeated named subjects and self-introductions for uncast voice continuity', () => {
  const message = `The earbud comes out against her thumb, and Tessa turns at the waist. A stream falls between Ken's feet.\n\n"Oh hey." She puts it away.\n\nTessa does not step back.\n\n"You live in there?" She smiles. "I'm Tessa. Two doors down."`
  const speakers = addUnconfiguredDialogueSpeakers(message, [{ id: USER_SPEAKER_ID, name: 'Ken' }])
  assert.ok(speakers.some(speaker => speaker.id === 'unconfigured:tessa'))
  assert.equal(speakers.some(speaker => speaker.id === 'unconfigured:ken'), false)
  const group = collectUncastVoiceGroups([{ speakerId: 'unconfigured:tessa', text: "I'm Tessa." }])
  const oldGhost = { id: 'temporary', speakerId: UNCAST_SPEAKER_ID, voiceId: 'voice', context: 'Tessa turns. She introduces herself.', occurrenceKeys: [], lastSeenMessageId: 'previous' }
  const linked = resolveUncastVoiceDecisions(group, [], { identity_g0: confidentDecision('ghost_0') }, [oldGhost])
  assert.equal(linked[0]?.ghostId, 'temporary')
  assert.deepEqual(linked[0]?.aliases, ['tessa'])
  const weak = resolveUncastVoiceDecisions(group, [], { identity_g0: { choice: 'ghost_0', confidence: 0.5, probabilities: { ghost_0: 0.6, new_or_unclear: 0.4 } } }, [oldGhost])
  assert.deepEqual(weak, [])
  const singular = addUnconfiguredDialogueSpeakers('The lamp flickers. "I am waiting."', [])
  assert.deepEqual(singular, [])
})

test('reviews a borderline cross-message match before creating another voice', () => {
  const ghost = { id: 'old', speakerId: UNCAST_SPEAKER_ID, voiceId: 'tessa-voice', context: 'Tessa introduces herself and answers her phone.', occurrenceKeys: [], lastSeenMessageId: 'earlier' }
  const groups = collectUncastVoiceGroups([{ speakerId: 'unconfigured:tessa', text: 'Mom, I heard you.' }])
  const message = "Tessa holds the phone. Her mother speaks on the other end."
  const answers = { identity_g0: { choice: 'ghost_0', confidence: 0.58, probabilities: { ghost_0: 0.72, new_or_unclear: 0.25, group_g0: 0.03 } }, voice_g0: confidentDecision('voice_0') }
  const voices = readFavoriteVoices([{ id: 'another-voice' }])
  const plan = buildUncastIdentityReview(groups, answers, message, [ghost])
  assert.ok(plan.questions.review_ghost_g0_0)
  assert.match(plan.state.ghosts[0].context, /Tessa introduces/u)
  assert.equal(resolveUncastVoiceDecisions(groups, voices, answers, [ghost], [], 'later', message)[0].voiceId, 'another-voice')
  const confirmed = resolveUncastVoiceDecisions(groups, voices, { ...answers, review_ghost_g0_0: confidentDecision('same') }, [ghost], [], 'later', message)
  assert.equal(confirmed[0].ghostId, 'old')
  assert.equal(confirmed[0].voiceId, 'tessa-voice')
  assert.deepEqual(confirmed[0].aliases, ['tessa'])
  const rejected = resolveUncastVoiceDecisions(groups, voices, { ...answers, review_ghost_g0_0: confidentDecision('different_or_unclear') }, [ghost], [], 'later', message)
  assert.equal(rejected[0].voiceId, 'another-voice')
  const weak = resolveUncastVoiceDecisions(groups, voices, { ...answers, review_ghost_g0_0: { choice: 'same', confidence: 0.6, probabilities: { same: 0.7, different_or_unclear: 0.3 } } }, [ghost], [], 'later', message)
  assert.equal(weak[0].voiceId, 'another-voice')
})

test('reviews a newly named speaker against anonymous history even when the first pass says new', () => {
  const ghosts = [
    { id: 'mom', speakerId: UNCAST_SPEAKER_ID, label: "tessa's mom", voiceId: 'mom-voice', context: 'A caller speaks to Tessa.', occurrenceKeys: [], lastSeenMessageId: 'earlier', conversationHistory: [{ messageId: 'earlier', text: 'Tessa says Mom while speaking on the phone.' }] },
    { id: 'clerk', speakerId: UNCAST_SPEAKER_ID, label: 'the clerk', voiceId: 'clerk-voice', context: 'A clerk works elsewhere.', occurrenceKeys: [], lastSeenMessageId: 'earlier' },
  ]
  const groups = collectUncastVoiceGroups([{ speakerId: 'unconfigured:marisol', text: 'Seven minutes.' }])
  const message = 'Marisol arrives. Her daughter Tessa sees her.'
  const voices = readFavoriteVoices([{ id: 'new-voice' }])
  const answers = { identity_g0: confidentDecision('new_or_unclear'), voice_g0: confidentDecision('voice_0') }
  const review = buildUncastIdentityReview(groups, answers, message, ghosts)
  assert.ok(review.questions.review_reveal_g0_0)
  assert.equal(review.state.ghosts[0].conversationHistory[0].text, ghosts[0].conversationHistory![0].text)
  const confirmed = resolveUncastVoiceDecisions(groups, voices, { ...answers, review_reveal_g0_0: confidentDecision('same') }, ghosts, [], 'current', message)
  assert.equal(confirmed[0].ghostId, 'mom')
  assert.deepEqual(confirmed[0].aliases, ['marisol'])
  assert.match(confirmed[0].matchReason!, /name-reveal/u)
  const uncertain = resolveUncastVoiceDecisions(groups, voices, { ...answers, review_reveal_g0_0: confidentDecision('different_or_unclear') }, ghosts, [], 'current', message)
  assert.equal(uncertain[0].voiceId, 'new-voice')
  const conflicting = resolveUncastVoiceDecisions(groups, voices, { ...answers, review_reveal_g0_0: confidentDecision('same'), review_reveal_g0_1: confidentDecision('same') }, ghosts, [], 'current', message)
  assert.equal(conflicting[0].voiceId, 'new-voice')
  const introduction = collectUncastVoiceGroups([{ speakerId: UNCAST_SPEAKER_ID, text: "I'm Marisol. Nice to meet you." }])
  assert.ok(buildUncastIdentityReview(introduction, answers, message, ghosts).questions.review_reveal_g0_0)
  const selfNamed = resolveUncastVoiceDecisions(introduction, voices, { ...answers, review_reveal_g0_0: confidentDecision('same') }, ghosts, [], 'current', message)
  assert.equal(selfNamed[0].ghostId, 'mom')
  assert.deepEqual(selfNamed[0].aliases, ['marisol'])
})

test('connects a newly named uncast speaker through a continuing scene and conversation', () => {
  const first = 'The counter man speaks to Ken. A woman at the second copper turns round and says, "That’s charged her for that, Arthur." Arthur answers her at the counter. The copper behind the woman sizzles.'
  const user = 'I explain what happened to the note and offer it to the counter man.'
  const current = 'Arthur says, "Annie at her copper will tell the whole road." "They’re all the same these lads, Arthur," says Annie from her copper. "Annie, love. Wash the sheet," he replies.'
  const messages = [
    { id: 'first', is_user: false, content: first },
    { id: 'user', is_user: true, content: user },
    { id: 'current', is_user: false, content: current },
    { id: 'future', is_user: false, content: 'Future secret.' },
  ]
  const ghosts = [{ id: 'copper-worker', speakerId: UNCAST_SPEAKER_ID, label: 'the woman', aliases: ['the woman'], voiceId: 'earlier-voice', context: 'The woman speaks to Arthur by the second copper.', occurrenceKeys: [], lastSeenMessageId: 'first', conversationHistory: [{ messageId: 'first', text: first }] }]
  const context = relationshipReviewContext(messages, 'current', ghosts)
  const safeGhosts = ghosts.map(ghost => ({ ...ghost, conversationHistory: context.ghosts[0].conversationHistory }))
  const groups = collectUncastVoiceGroups([{ speakerId: 'unconfigured:annie', text: 'They’re all the same these lads, Arthur.', debugPath: ['segment-type:speech'] }])
  const voices = readFavoriteVoices([{ id: 'unused-voice' }])
  const answers: Record<string, SpeakerDecisionChoice> = { identity_g0: confidentDecision('new_or_unclear'), voice_g0: confidentDecision('voice_0') }
  const review = buildUncastIdentityReview(groups, answers, current, safeGhosts, 'current', context.previousMessages)
  assert.ok(review.questions.review_scene_g0_0)
  assert.match(review.questions.review_scene_g0_0.instructions, /workstations/u)
  assert.deepEqual(review.state.previousMessages.map(item => item.role), ['assistant', 'user'])
  assert.ok(!JSON.stringify(review.state).includes('Future secret'))
  const firstPass = buildUncastVoiceDecision(groups, voices, current, safeGhosts, context.previousMessages)
  assert.equal(firstPass.state.previousMessages[1].text, user)
  const linked = resolveUncastVoiceDecisions(groups, voices, { ...answers, review_scene_g0_0: confidentDecision('same') }, safeGhosts, [], 'current', current, ['first'])
  assert.equal(linked[0].ghostId, 'copper-worker')
  assert.equal(linked[0].voiceId, 'earlier-voice')
  assert.ok(linked[0].aliases?.includes('annie'))
  const uncertain = resolveUncastVoiceDecisions(groups, voices, { ...answers, review_scene_g0_0: confidentDecision('different_or_unclear') }, safeGhosts, [], 'current', current, ['first'])
  assert.equal(uncertain[0].voiceId, 'unused-voice')
  const contradicted = resolveUncastVoiceDecisions(groups, voices, { ...answers, review_scene_g0_0: confidentDecision('same'), review_reveal_g0_0: confidentDecision('different_or_unclear') }, safeGhosts, [], 'current', current, ['first'])
  assert.equal(contradicted[0].voiceId, 'unused-voice')
  const another = { ...safeGhosts[0], id: 'other-worker', voiceId: 'other-voice', label: 'the other woman', aliases: ['the other woman'] }
  const ambiguous = resolveUncastVoiceDecisions(groups, voices, { ...answers, review_scene_g0_0: confidentDecision('same'), review_scene_g0_1: confidentDecision('same') }, [...safeGhosts, another], [], 'current', current, ['first'])
  assert.equal(ambiguous[0].voiceId, 'unused-voice')
})

test('reviews a name introduced in narration for an otherwise uncast speaker', () => {
  const first = 'A woman at the tram stop holds a cup and a satchel. "Why, where are you headed?"'
  const user = 'I ask her how her morning has been.'
  const current = 'Free-use is default in this city. Leah is at her own stop on her own errand. She turns her cup. "Morning’s been morning."'
  const messages = [{ id: 'first', is_user: false, content: first }, { id: 'user', is_user: true, content: user }, { id: 'current', is_user: false, content: current }]
  const ghosts = [{ id: 'woman', speakerId: UNCAST_SPEAKER_ID, label: 'the woman', aliases: ['the woman'], voiceId: 'original-voice', context: 'The woman holds a cup at the stop.', occurrenceKeys: [], lastSeenMessageId: 'first', conversationHistory: [{ messageId: 'first', text: first }] }]
  const context = relationshipReviewContext(messages, 'current', ghosts)
  const groups = collectUncastVoiceGroups([{ speakerId: UNCAST_SPEAKER_ID, text: 'Morning’s been morning.' }])
  const plan = buildUncastVoiceDecision(groups, [], current, ghosts, context.previousMessages)
  const index = plan.state.narrativeNames.findIndex(name => name.toLowerCase() === 'leah')
  assert.ok(index >= 0)
  assert.ok(plan.questions.narrative_name_g0)
  const answers: Record<string, SpeakerDecisionChoice> = { narrative_name_g0: confidentDecision(`name_${index}`), identity_g0: confidentDecision('new_or_unclear') }
  const review = buildUncastIdentityReview(groups, answers, current, ghosts, 'current', context.previousMessages)
  assert.ok(review.questions.review_continuity_g0_0)
  assert.match(review.questions.review_continuity_g0_0.instructions, /intervening user message/u)
  assert.ok(review.questions.review_reveal_g0_0)
  assert.ok(review.questions.review_scene_g0_0)
  const linked = resolveUncastVoiceDecisions(groups, [], { ...answers, review_scene_g0_0: confidentDecision('same') }, ghosts, [], 'current', current, ['first'])
  assert.equal(linked[0]?.ghostId, 'woman')
  assert.equal(linked[0]?.voiceId, 'original-voice')
  assert.ok(linked[0]?.aliases?.includes('leah'))
  const doubtful = { ...answers, review_reveal_g0_0: confidentDecision('different_or_unclear'), review_scene_g0_0: confidentDecision('different_or_unclear') }
  const continuity = resolveUncastVoiceDecisions(groups, [], { ...doubtful, review_continuity_g0_0: confidentDecision('same') }, ghosts, [], 'current', current, ['first'])
  assert.equal(continuity[0]?.voiceId, 'original-voice')
  assert.ok(continuity[0]?.aliases?.includes('leah'))
  assert.equal(resolveUncastVoiceDecisions(groups, [], { ...doubtful, review_continuity_g0_0: confidentDecision('unclear') }, ghosts, [], 'current', current, ['first']).length, 0)
  assert.equal(resolveUncastVoiceDecisions(groups, [], { ...answers, review_scene_g0_0: confidentDecision('same'), review_continuity_g0_0: confidentDecision('different') }, ghosts, [], 'current', current, ['first']).length, 0)
  const competing = { ...ghosts[0], id: 'other', voiceId: 'other-voice' }
  assert.equal(resolveUncastVoiceDecisions(groups, [], { ...doubtful, review_continuity_g0_0: confidentDecision('same'), review_continuity_g0_1: confidentDecision('same') }, [...ghosts, competing], [], 'current', current, ['first']).length, 0)
  const stale = { ...ghosts[0], id: 'stale-current', voiceId: 'wrong-voice', occurrenceKeys: [`current:${hashMessageContent('Morning’s been morning.')}`], lastSeenMessageId: 'current', conversationHistory: [] }
  const recovered = resolveUncastVoiceDecisions(groups, [], { ...answers, review_occurrence_g0_1: confidentDecision('different_or_unclear'), review_scene_g0_0: confidentDecision('same') }, [...ghosts, stale], [], 'current', current, ['first'])
  assert.equal(recovered[0]?.ghostId, 'woman')
  assert.equal(recovered[0]?.voiceId, 'original-voice')
  const namedGhost = { ...ghosts[0], label: 'Leah', aliases: ['Leah'] }
  const existing = resolveUncastVoiceDecisions(groups, [], answers, [namedGhost], [], 'current', current, ['first'])
  assert.equal(existing[0]?.ghostId, 'woman')
  const older = Array.from({ length: 9 }, (_, i) => ({ ...ghosts[0], id: `older-${i}`, lastSeenMessageId: 'older', conversationHistory: [] }))
  const recentReview = buildUncastIdentityReview(groups, answers, current, [...older, ghosts[0]], 'current', context.previousMessages)
  assert.ok(recentReview.questions.review_scene_g0_9, 'recent matching candidates must not be crowded out by older ghosts')
  const unrelated = { ...answers, narrative_name_g0: confidentDecision('none') }
  assert.equal(buildUncastIdentityReview(groups, unrelated, current, ghosts, 'current', context.previousMessages).questions.review_scene_g0_0, undefined)
  const weak = { ...answers, narrative_name_g0: { choice: `name_${index}`, probabilities: { [`name_${index}`]: 0.6, none: 0.4 }, confidence: 0.5 } }
  assert.equal(buildUncastIdentityReview(groups, weak, current, ghosts, 'current', context.previousMessages).questions.review_scene_g0_0, undefined)
})

test('retains conversation exchanges and relationship labels for later ghost identity review', () => {
  const ids = ['one', 'two', 'three', 'four']
  const ghost = { id: 'mother', speakerId: UNCAST_SPEAKER_ID, voiceId: 'voice', context: '', occurrenceKeys: [], lastSeenMessageId: 'one', conversationHistory: [] as Array<{ messageId: string; text: string }> }
  const first = `"Nine-fifteen, Tessa." Tessa holds the phone. "Mom, I heard you."`
  const second = `Tessa listens to the phone. "Mom, I said I'm coming." "I'm on Maple, Tessa."`
  const third = `Marisol arrives. Her daughter Tessa sees her. "Seven minutes."`
  updateGhostConversationHistory(ghost, 'one', first, ids)
  updateGhostConversationHistory(ghost, 'two', second, ids)
  assert.deepEqual(ghost.conversationHistory.map(item => item.messageId), ['one', 'two'])
  assert.match(ghost.conversationHistory[0].text, /Mom, I heard you/u)
  const labels = uncastIdentityLabels(first, [])
  assert.ok(labels.includes("tessa's mom"))
  const groups = collectUncastVoiceGroups([{ speakerId: 'unconfigured:marisol', text: 'Seven minutes.' }])
  const plan = buildUncastVoiceDecision(groups, [], third, [ghost])
  assert.match(plan.questions.identity_g0.instructions, /person they address/u)
  assert.equal(plan.state.ghosts[0].conversationHistory[1].text, second)
  const assignment = resolveUncastVoiceDecisions(groups, [], { identity_g0: confidentDecision('ghost_0') }, [ghost], [], 'three', third, ids.slice(0, 2))
  assert.equal(assignment[0]?.voiceId, 'voice')
  assert.deepEqual(assignment[0]?.aliases, ['marisol'])
  updateGhostConversationHistory(ghost, 'three', third, ids)
  updateGhostConversationHistory(ghost, 'four', 'A later conversation.', ids)
  updateGhostConversationHistory(ghost, 'one', first, ids)
  assert.deepEqual(ghost.conversationHistory.map(item => item.messageId), ['two', 'three', 'four'])
  const reloaded = readGhostVoices([ghost])[0]
  assert.equal(reloaded.conversationHistory?.length, 3)
})

test('relationship review preserves caller identity, excludes future context, and routes to the existing ghost', () => {
  const messages = [
    { id: 'previous', is_user: false, content: `Tessa answers the phone. "Mom, are you there?" "Yes, Tessa." <tracker>secret prior</tracker>` },
    { id: 'current', is_user: false, content: `Tessa holds the phone. "Mom, I said I am coming." "I am on Maple, Tessa."` },
    { id: 'future', is_user: false, content: 'Marisol arrives in person.' },
  ]
  const ghost = { id: 'mother', speakerId: UNCAST_SPEAKER_ID, voiceId: 'mom-voice', label: 'Marisol', aliases: ['Marisol'], context: 'Marisol arrives in person.', occurrenceKeys: [], lastSeenMessageId: 'future', conversationHistory: [{ messageId: 'previous', text: messages[0].content }, { messageId: 'future', text: messages[2].content }] }
  const context = relationshipReviewContext(messages, 'current', [ghost], 'tracker')
  assert.doesNotMatch(JSON.stringify(context), /secret prior|Marisol/u)
  assert.match(context.ghosts[0].conversationHistory[0].text, /Mom, are you there/u)
  const speakers = [{ id: 'npc:tessa', name: 'Tessa' }, { id: USER_SPEAKER_ID, name: 'Ken' }]
  const plan = buildSpeakerDecisionPlan(messages[1].content, speakers, false)
  const answers = { speech_s0: confidentDecision('known_0'), speech_s1: confidentDecision('uncast_character') }
  const review = buildRelationshipSpeakerReview(plan, answers, context)
  assert.ok(review.questions.relationship_s1)
  assert.ok(review.ghostOptions.relationship_ghost_0)
  applyRelationshipSpeakerReview(plan, answers, { relationship_s1: confidentDecision('relationship_ghost_0') }, review.ghostOptions)
  assert.equal(answers.speech_s1.choice, 'relationship_ghost_0')
  const resolved = resolveSpeakerDecisionSegments(messages[1].content, plan, answers, speakers, { isUserMessage: false, cardSpeakerId: null, historicalSpeakerId: null })
  const groups = collectUncastVoiceGroups(resolved)
  assert.ok(groups.some(group => group.speakerId === 'ghost:mother'))
  const matches = resolveUncastVoiceDecisions(groups, [], {}, [ghost])
  assert.equal(matches.find(match => groups.find(group => group.id === match.groupId)?.speakerId === 'ghost:mother')?.voiceId, 'mom-voice')
})

test('global context includes six preceding user and assistant messages in order without future leakage', () => {
  const messages = Array.from({ length: 9 }, (_, index) => ({ id: String(index), is_user: index % 2 === 0, content: `message ${index}` }))
  const context = relationshipReviewContext(messages, '7', [])
  assert.deepEqual(context.previousMessages.map(item => [item.id, item.role]), [ ['1', 'assistant'], ['2', 'user'], ['3', 'assistant'], ['4', 'user'], ['5', 'assistant'], ['6', 'user'] ])
  assert.deepEqual(relationshipReviewContext(messages, '4', [], '', 2).previousMessages.map(item => item.id), ['2', '3'])
  assert.deepEqual(relationshipReviewContext(messages, 'missing', []).previousMessages, [])
  const long = Array.from({ length: 9 }, (_, index) => ({ id: String(index), is_user: index % 2 === 0, content: 'x'.repeat(10_000) }))
  const capped = relationshipReviewContext(long, '8', [], '', 8).previousMessages
  assert.equal(capped.reduce((sum, item) => sum + item.text.length, 0), 24_000)
  assert.deepEqual(capped.map(item => item.id), ['2', '3', '4', '5', '6', '7'])
})

test('prioritizes the latest ghost context without changing candidate indexes or exposing future links', () => {
  const messages = [
    { id: 'old', is_user: false, content: 'An earlier scene.' },
    { id: 'first', is_user: false, content: 'The woman speaks at the stop.' },
    { id: 'user', is_user: true, content: 'How was your morning?' },
    { id: 'current', is_user: false, content: 'Leah replies.' },
    { id: 'future', is_user: false, content: 'Future scene.' },
  ]
  const old = Array.from({ length: 8 }, (_, i) => ({ id: `old-${i}`, speakerId: UNCAST_SPEAKER_ID, voiceId: `voice-${i}`, context: 'old context '.repeat(150), occurrenceKeys: [], lastSeenMessageId: 'old', conversationHistory: [{ messageId: 'old', text: 'old history '.repeat(150) }] }))
  const recent = { id: 'recent', speakerId: UNCAST_SPEAKER_ID, voiceId: 'recent-voice', context: 'the woman by the stop', occurrenceKeys: ['first:hash', 'future:hash'], lastSeenMessageId: 'first', conversationHistory: [{ messageId: 'first', text: 'the woman answers at the stop' }, { messageId: 'future', text: 'future secret' }] }
  const ghosts = [...old, recent]
  const context = relationshipReviewContext(messages, 'current', ghosts)
  assert.deepEqual(context.ghosts.map(ghost => ghost.id), ghosts.map(ghost => ghost.id))
  const safeRecent = context.ghosts[8]
  assert.equal(safeRecent.context, recent.context)
  assert.deepEqual(safeRecent.conversationHistory.map(item => item.messageId), ['first'])
  assert.ok(!JSON.stringify(context).includes('future secret'))
  const safeGhosts = ghosts.map(ghost => ({ ...ghost, ...context.ghosts.find(item => item.id === ghost.id)! }))
  const groups = collectUncastVoiceGroups([{ speakerId: UNCAST_SPEAKER_ID, text: 'Morning was fine.' }])
  const plan = buildUncastVoiceDecision(groups, [], messages[3].content, safeGhosts, context.previousMessages)
  assert.deepEqual(plan.state.ghosts[8].priorMessageIds, ['first'])
  const answers: Record<string, SpeakerDecisionChoice> = { narrative_name_g0: confidentDecision('name_0'), identity_g0: confidentDecision('new_or_unclear') }
  const review = buildUncastIdentityReview(groups, answers, messages[3].content, safeGhosts, 'current', context.previousMessages)
  assert.deepEqual(review.state.ghosts[8].priorMessageIds, ['first'])
  assert.ok(review.questions.review_continuity_g0_8)
})

test('global review avoids scene-wide inheritance and treats card as context only', () => {
  const speakers = [{ id: 'tessa', name: 'Tessa' }, { id: 'ewan', name: 'Ewan' }]
  const plan = buildSpeakerDecisionPlan('"Sacrifice."\n\nHe turns with the tray.\n\n"What are you sacrificing?"', speakers, false)
  const answers: Record<string, SpeakerDecisionChoice> = { speech_s0: confidentDecision('no_clear_identity'), speech_s1: confidentDecision('no_clear_identity') }
  const context = { previousMessages: [{ id: 'prior', role: 'user' as const, text: 'Ewan walks away with his tray.' }], ghosts: [] }
  const review = buildRelationshipSpeakerReview(plan, answers, context, null, { cardSpeakerId: 'tessa', targets: ['s0', 's1'] })
  assert.equal(review.questions.relationship_scene, undefined)
  assert.ok(review.questions.relationship_s0)
  assert.equal(review.state.cardSpeakerPrior, 'tessa')
  applyRelationshipSpeakerReview(plan, answers, { relationship_s0: confidentDecision('known_1') }, review.ghostOptions, 'tessa', 'tessa', true)
  assert.equal(answers.speech_s0.choice, 'known_1')
  assert.equal(answers.speech_s1.choice, 'no_clear_identity')
  const resolved = resolveSpeakerDecisionSegments(plan.state.message, plan, answers, speakers, { isUserMessage: false, cardSpeakerId: null, historicalSpeakerId: null, evidenceOnly: true })
  assert.notEqual(resolved.find(segment => segment.text === 'What are you sacrificing?')?.speakerId, 'tessa')
  const failed = buildSpeakerDecisionPlan('"What now?"', speakers, false)
  const failedAnswers = { speech_s0: confidentDecision('no_clear_identity') }
  applyRelationshipSpeakerReview(failed, failedAnswers, {}, {}, 'tessa', 'tessa', true)
  assert.equal(failedAnswers.speech_s0.choice, 'no_clear_identity')
  assert.equal(resolveSpeakerDecisionSegments(failed.state.message, failed, failedAnswers, speakers, { isUserMessage: false, cardSpeakerId: null, historicalSpeakerId: null, evidenceOnly: true }).find(segment => segment.text === 'What now?')?.speakerId, UNRESOLVED_SPEAKER_ID)
})

test('speaker diagnostic source labels follow final resolution rather than an intermediate guess', () => {
  assert.equal(speakerAssignmentSourceFromTrace(['resolution:global-context confirmed current identity (protected from local override)'], false), 'contextual-confirmation')
  assert.equal(speakerAssignmentSourceFromTrace(['resolution:global-context review (protected from local override)'], false), 'contextual-review')
  assert.equal(speakerAssignmentSourceFromTrace(['jev-opening-exchange:strong single-speaker review applied', 'resolution:global-context review (protected from local override)'], false), 'opening-exchange')
  assert.equal(speakerAssignmentSourceFromTrace(['jev-opening-backlink:accepted same-speaker link to later validated quote', 'resolution:global-context review (protected from local override)'], false), 'opening-backlink')
  assert.equal(speakerAssignmentSourceFromTrace(['jev-opening-forwardlink:accepted same-speaker link to earlier validated quote', 'resolution:global-context review (protected from local override)'], false), 'opening-forwardlink')
  assert.equal(speakerAssignmentSourceFromTrace(['jev-opening-exchange:strong single-speaker review applied', 'resolution:unresolved speech (connection-default fallback)'], false), 'role-fallback')
  assert.equal(speakerAssignmentSourceFromTrace(['resolution:direct-speech-identity'], false), 'first-pass')
  assert.equal(speakerAssignmentSourceFromTrace([], true), 'local-parser')
})

test('first-pass debug snapshots remain unchanged after later review decisions', () => {
  const plan = buildSpeakerDecisionPlan('"Hello."', [{ id: 'npc:a', name: 'A' }], false)
  const answers: Record<string, SpeakerDecisionChoice> = { speech_s0: confidentDecision('known_0') }
  snapshotSpeakerFirstPass(plan, answers)
  answers.speech_s0.probabilities.known_0 = 0.4
  answers.speech_s0.choice = 'no_clear_identity'
  assert.equal(answers.first_pass_s0.choice, 'known_0')
  assert.equal(answers.first_pass_s0.probabilities.known_0, 0.92)
})

test('dialogue-only filtering removes narration but keeps cast, user and unresolved speech', () => {
  const segments = [
    { text: 'Narration.', speakerId: null },
    { text: 'A line.', speakerId: 'npc:ewan' },
    { text: 'Unknown line.', speakerId: UNRESOLVED_SPEAKER_ID },
    { text: 'User line.', speakerId: USER_SPEAKER_ID },
    { text: 'Another narrator beat.', speakerId: null },
  ]
  assert.deepEqual(filterNarrationSegments(segments, true).map(item => item.text), ['A line.', 'Unknown line.', 'User line.'])
  assert.deepEqual(filterNarrationSegments(segments, false), segments)
  assert.deepEqual(filterNarrationSegments([{ text: 'Only narration.', speakerId: null }], true), [])
  assert.equal(segments.length, 5)
})

test('offline speaker evaluation scores paired cases and validates alignment', () => {
  const cases = [
    { id: 'reply', conversation: 'exchange-a', expected: ['ewan', 'ewan', null], baseline: ['user', null, null], candidate: ['ewan', 'ewan', 'ewan'], baselineMs: 100, candidateMs: 160 },
    { id: 'phone', conversation: 'exchange-b', expected: ['mother', 'daughter'], baseline: ['mother', 'daughter'], candidate: ['mother', 'daughter'], baselineMs: 200, candidateMs: 250 },
  ]
  const result = evaluateSpeakerReviews(cases)
  assert.equal(result.conversations, 2)
  assert.equal(result.baseline.exactMatches, 3)
  assert.equal(result.candidate.exactMatches, 4)
  assert.equal(result.changed, 3)
  assert.equal(result.improved, 2)
  assert.equal(result.regressed, 1)
  assert.equal(result.candidate.p95Ms, 250)
  assert.throws(() => evaluateSpeakerReviews([{ ...cases[0], candidate: [] }]), /aligned/u)
  assert.throws(() => evaluateSpeakerReviews([cases[0], cases[0]]), /unique/u)
  assert.throws(() => evaluateSpeakerReviews([{ ...cases[0], candidateMs: Infinity }]), /finite/u)
})

test('speaker review rejects missing, malformed and out-of-scope answers', () => {
  const questions = { relationship_s0: { type: 'choice' as const, instructions: '', criteria: { known_0: 'A', no_clear_identity: 'Unknown' } } }
  assert.deepEqual(invalidSpeakerReviewAnswers(questions, {}), ['relationship_s0'])
  assert.deepEqual(invalidSpeakerReviewAnswers(questions, { relationship_s0: confidentDecision('other') }), ['relationship_s0'])
  assert.deepEqual(invalidSpeakerReviewAnswers(questions, { relationship_s0: { choice: 'known_0', probabilities: { known_0: NaN }, confidence: 1 } }), ['relationship_s0'])
  assert.deepEqual(invalidSpeakerReviewAnswers(questions, { relationship_s0: confidentDecision('no_clear_identity') }), [])
})

test('run-focused shadow review keeps context while leaving the live plan and answers untouched', () => {
  const speakers = [{ id: 'ewan', name: 'Ewan' }, { id: 'tessa', name: 'Tessa' }]
  const plan = buildSpeakerDecisionPlan('"Sacrifice."\n\nHe turns with the tray.\n\n"What are you sacrificing?"', speakers, false)
  const answers: Record<string, SpeakerDecisionChoice> = { speech_s0: confidentDecision('no_clear_identity'), speech_s1: confidentDecision('no_clear_identity') }
  const context = { previousMessages: [{ id: 'prior', role: 'user' as const, text: 'I turn to Ewan and mention sacrifice.' }], ghosts: [] }
  const before = JSON.stringify({ plan, answers })
  const shadowPlan = { ...plan, optionSpeakerIds: { ...plan.optionSpeakerIds } }
  const shadowAnswers = { ...answers }
  const review = buildRelationshipSpeakerReview(shadowPlan, shadowAnswers, context, null, { cardSpeakerId: null, targets: ['s0', 's1'], strategy: 'run' })
  assert.ok(review.questions.relationship_s0)
  assert.ok(review.questions.boundary_relation)
  assert.ok(review.state.reviewedRuns!.length)
  assert.equal(review.questions.scene_reference_s0, undefined)
  applyRelationshipSpeakerReview(shadowPlan, shadowAnswers, { relationship_s0: confidentDecision('known_0') }, review.ghostOptions, null, null, true)
  assert.equal(shadowAnswers.speech_s0.choice, 'known_0')
  assert.equal(JSON.stringify({ plan, answers }), before)
})

test('scene references link Ewan to the tray without making a bystander the speaker', () => {
  const content = '"Sacrifice."\n\nHe is ten paces off with the tray, and he turns halfway around.\n\n"What are you sacrificing?"\n\nSomebody behind him sidesteps the tray. He shifts without looking.\n\n"No, I know what you meant."'
  const speakers = [{ id: 'npc:ewan', name: 'Ewan' }, { id: 'npc:tessa', name: 'Tessa' }, { id: USER_SPEAKER_ID, name: 'Ken' }]
  const context = { previousMessages: [{ id: 'earlier', role: 'assistant' as const, text: 'Ewan picks up his tray.' }, { id: 'prior', role: 'user' as const, text: 'I turn to Ewan. "Sometimes you have to sacrifice for someone you like."' }], ghosts: [] }
  const make = () => {
    const plan = buildSpeakerDecisionPlan(content, speakers, false)
    const answers: Record<string, SpeakerDecisionChoice> = { speech_s0: confidentDecision('no_clear_identity'), speech_s1: confidentDecision('no_clear_identity'), speech_s2: confidentDecision('no_clear_identity') }
    const review = buildRelationshipSpeakerReview(plan, answers, context, null, { cardSpeakerId: null, targets: ['s0', 's1', 's2'] })
    return { plan, answers, review }
  }
  const { plan, answers, review } = make()
  assert.ok(review.questions.scene_reference_s0)
  assert.ok(review.questions.scene_secondary_s1)
  assert.ok(review.questions.scene_link_s0)
  assert.match(review.state.sceneReferences!.find(item => item.speechId === 's0')!.narration, /tray/u)
  assert.equal(review.state.previousMessages[1].role, 'user')
  applyRelationshipSpeakerReview(plan, answers, {
    relationship_s0: confidentDecision('no_clear_identity'),
    scene_reference_s0: confidentDecision('known_0'),
    scene_link_s0: confidentDecision('same_speaker'),
    relationship_s1: confidentDecision('known_0'),
    scene_reference_s2: confidentDecision('known_1'),
    scene_link_s2: confidentDecision('different_person'),
  }, review.ghostOptions, null, null, true)
  assert.equal(answers.speech_s0.choice, 'known_0')
  assert.equal(answers.speech_s1.choice, 'known_0')
  assert.equal(answers.speech_s2.choice, 'no_clear_identity')
  assert.ok(answers.scene_applied_s0)
  const resolved = resolveSpeakerDecisionSegments(content, plan, answers, speakers, { isUserMessage: false, cardSpeakerId: null, historicalSpeakerId: null, evidenceOnly: true, includeDebug: true })
  assert.equal(resolved.find(segment => segment.text === 'Sacrifice.')?.speakerId, 'npc:ewan')
  assert.ok(resolved.find(segment => segment.text === 'Sacrifice.')?.debugPath?.some(item => item.includes('jev-scene-link')))
  const unlinked = make()
  applyRelationshipSpeakerReview(unlinked.plan, unlinked.answers, { scene_reference_s0: confidentDecision('known_0'), scene_link_s0: confidentDecision('no_clear_identity') }, unlinked.review.ghostOptions, null, null, true)
  assert.equal(unlinked.answers.speech_s0.choice, 'no_clear_identity')
  const contradictory = make()
  applyRelationshipSpeakerReview(contradictory.plan, contradictory.answers, { relationship_s0: confidentDecision('known_1'), scene_reference_s0: confidentDecision('known_0'), scene_link_s0: confidentDecision('same_speaker') }, contradictory.review.ghostOptions, null, null, true)
  assert.equal(contradictory.answers.speech_s0.choice, 'known_1')
  assert.equal(contradictory.answers.scene_applied_s0, undefined)
})

test('cross-message review links a user exchange to each quote in the Ewan opening run', () => {
  const speakers = [{ id: 'npc:ewan', name: 'Ewan' }, { id: 'npc:tessa', name: 'Tessa' }, { id: USER_SPEAKER_ID, name: 'Ken' }, { id: 'unconfigured:halloran', name: 'Halloran' }]
  const content = '"Sacrifice."\n\nHe is ten paces off with the tray and turns halfway around.\n\n"What are you sacrificing? The noodles?"\n\nSomebody behind him has to sidestep the tray, and he shifts without looking.\n\n"No, I know what you meant."\n\nHe lifts one shoulder.\n\n"Whatever. Text her."'
  const plan = buildSpeakerDecisionPlan(content, speakers, false)
  const context = { previousMessages: [{ id: 'a', role: 'assistant' as const, text: 'Ewan gets the tray up and stands.' }, { id: 'u', role: 'user' as const, text: 'I turn to Ewan again. "Sometimes you gotta sacrifice a little for someone you like, you know?"' }], ghosts: [] }
  const answers: Record<string, SpeakerDecisionChoice> = { speech_s0: confidentDecision('known_2'), speech_s1: confidentDecision('no_clear_identity'), speech_s2: confidentDecision('no_clear_identity'), speech_s3: confidentDecision('no_clear_identity') }
  const review = buildRelationshipSpeakerReview(plan, answers, context, null, { cardSpeakerId: null, targets: ['s1', 's2', 's3'] })
  assert.equal(review.state.boundaryExchange!.role, 'user')
  assert.ok(review.questions.boundary_relation)
  assert.ok(review.questions.boundary_addressee)
  for (const speech of plan.state.speeches) assert.ok(review.questions[`relationship_${speech.id}`])
  assert.match(review.questions.relationship_s0.instructions, /recipient of the preceding relevant utterance/u)
  assert.match(review.questions.relationship_s0.instructions, /do not assume the addressee responds/u)
  applyRelationshipSpeakerReview(plan, answers, { boundary_relation: confidentDecision('response'), boundary_addressee: confidentDecision('known_0'), relationship_s0: confidentDecision('known_0'), relationship_s1: confidentDecision('known_0'), relationship_s2: confidentDecision('known_0'), relationship_s3: confidentDecision('known_0') }, review.ghostOptions, null, null, true)
  const resolved = resolveSpeakerDecisionSegments(content, plan, answers, speakers, { isUserMessage: false, cardSpeakerId: null, historicalSpeakerId: null, evidenceOnly: true, includeDebug: true })
  assert.deepEqual(resolved.filter(segment => segment.speakerId !== null).map(segment => segment.speakerId), ['npc:ewan', 'npc:ewan', 'npc:ewan', 'npc:ewan'])
  assert.ok(resolved[0].debugPath?.some(item => item.startsWith('jev-boundary-relation-choice:response')))
})

test('opening re-read uses bounded prior dialogue and only changes supported unresolved targets', () => {
  const speakers = [{ id: 'npc:ewan', name: 'Ewan' }, { id: USER_SPEAKER_ID, name: 'Ken' }]
  const message = '"Sacrifice."\n\nHe turns with the tray.\n\n"What are you sacrificing?"\n\nThe phone buzzes.\n\n"A different conversation."'
  const plan = buildSpeakerDecisionPlan(message, speakers, false)
  const answers: Record<string, SpeakerDecisionChoice> = { speech_s0: confidentDecision('known_1'), speech_s1: confidentDecision('no_clear_identity'), global_uncertain_s0: confidentDecision('no_clear_identity'), global_uncertain_s1: confidentDecision('no_clear_identity') }
  const context = { previousMessages: [{ id: 'old', role: 'assistant' as const, text: 'Old context.' }, { id: 'prior', role: 'assistant' as const, text: 'Ewan takes his tray.' }, { id: 'user', role: 'user' as const, text: 'I turn to Ewan. "Sometimes you sacrifice."' }], ghosts: [] }
  const review = buildOpeningSpeakerReview(plan, answers, context, null)!
  assert.deepEqual(review.state.previousMessages.map(item => item.id), ['prior', 'user'])
  const before = JSON.stringify({ review, answers })
  const boundaryShadow = buildBoundaryExchangeShadowReview(review)
  assert.ok(boundaryShadow.questions.boundary_s1)
  assert.ok(boundaryShadow.questions.retrospective_s1)
  assert.match(boundaryShadow.questions.retrospective_s1.instructions, /self-introductions/u)
  assert.match(boundaryShadow.questions.boundary_s1.instructions, /across the message boundary/u)
  assert.deepEqual(boundaryShadow.state.previousMessages.map(item => item.id), ['prior', 'user'])
  assert.equal(boundaryShadow.expectedControls.boundary_control_interruption, 'rowan')
  assert.equal(boundaryShadow.expectedControls.boundary_control_unclear, 'no_clear_identity')
  assert.equal(boundaryShadow.expectedControls.retrospective_control_introduction, 'mira')
  assert.equal(boundaryShadow.expectedControls.retrospective_control_interruption, 'rowan')
  assert.equal(boundaryShadow.expectedControls.retrospective_control_unclear, 'no_clear_identity')
  assert.equal('expectedControls' in boundaryShadow.state, false)
  assert.equal(JSON.stringify({ review, answers }), before)
  assert.ok(review.questions.relationship_s0)
  assert.ok(review.questions.relationship_s1)
  assert.match(review.questions.relationship_s0.instructions, /not the user who authored/u)
  applyRelationshipSpeakerReview(plan, answers, { relationship_s0: confidentDecision('known_0'), relationship_s1: confidentDecision('known_0') }, review.ghostOptions, null, null, true)
  assert.equal(answers.global_uncertain_s0, undefined)
  assert.equal(answers.global_uncertain_s1, undefined)
  assert.equal(answers.speech_s0.choice, 'known_0')
  assert.equal(answers.speech_s1.choice, 'known_0')
  assert.equal(buildOpeningSpeakerReview(plan, answers, context, null), null)
  const unresolved = { ...answers, speech_s1: confidentDecision('no_clear_identity'), global_uncertain_s1: confidentDecision('no_clear_identity') }
  applyRelationshipSpeakerReview(plan, unresolved, { relationship_s1: { choice: 'known_0', probabilities: { known_0: 0.4, no_clear_identity: 0.6 }, confidence: 0.4 } }, {}, null, null, true)
  assert.ok(unresolved.global_uncertain_s1)
  assert.equal(buildOpeningSpeakerReview(plan, unresolved, { previousMessages: [], ghosts: [] }, null), null)
})

test('retrospective shadow retains later self-identification in the bounded opening without applying answers', () => {
  const speakers = [{ id: 'npc:tessa', name: 'Tessa' }, { id: USER_SPEAKER_ID, name: 'Ken' }]
  const plan = buildSpeakerDecisionPlan('"Bishop. Third floor."\n\nShe balances her tray. "It is noisy."\n\n"Tessa. Tessa Doyle." She sits down.', speakers, false)
  const answers: Record<string, SpeakerDecisionChoice> = { speech_s0: confidentDecision('no_clear_identity'), global_uncertain_s0: confidentDecision('no_clear_identity') }
  const review = buildOpeningSpeakerReview(plan, answers, { previousMessages: [{ id: 'prior', role: 'user' as const, text: 'I ask her, "Where do you live?"' }], ghosts: [] }, null)!
  const before = JSON.stringify(answers)
  const shadow = buildBoundaryExchangeShadowReview(review)
  assert.match(shadow.state.message, /Tessa Doyle/u)
  assert.ok(shadow.questions.retrospective_s0)
  assert.equal(JSON.stringify(answers), before)
  assert.equal('expectedControls' in shadow.state, false)
})

test('agreement retains a clear first-pass identity without requiring override thresholds', () => {
  const speakers = [{ id: 'npc:zadie', name: 'Zadie' }, { id: 'npc:tessa', name: 'Tessa' }]
  const message = '"Dinner is handled."'
  const make = () => ({ plan: buildSpeakerDecisionPlan(message, speakers, false), answers: { speech_s0: { choice: 'known_0', probabilities: { known_0: 0.93, known_1: 0.05, no_clear_identity: 0.02 }, confidence: 0.92 } } as Record<string, SpeakerDecisionChoice> })
  const agreeing = make()
  applyRelationshipSpeakerReview(agreeing.plan, agreeing.answers, { relationship_s0: { choice: 'known_0', probabilities: { known_0: 0.81, known_1: 0.16, no_clear_identity: 0.03 }, confidence: 0.80 } }, {}, null, null, true)
  assert.ok(agreeing.answers.relationship_confirmed_s0)
  assert.equal(agreeing.answers.global_uncertain_s0, undefined)
  const segments = resolveSpeakerDecisionSegments(message, agreeing.plan, agreeing.answers, speakers, { isUserMessage: false, cardSpeakerId: null, historicalSpeakerId: null, evidenceOnly: true, includeDebug: true })
  assert.equal(segments[0].speakerId, 'npc:zadie')
  assert.ok(segments[0].debugPath?.includes('jev-relationship-review:accepted first-pass identity confirmed'))
  const weak = make()
  applyRelationshipSpeakerReview(weak.plan, weak.answers, { relationship_s0: { choice: 'known_0', probabilities: { known_0: 0.50, known_1: 0.30, no_clear_identity: 0.20 }, confidence: 0.39 } }, {}, null, null, true)
  assert.ok(weak.answers.global_uncertain_s0)
  const weakAgreement = make()
  weakAgreement.answers.speech_s0 = { choice: 'known_0', probabilities: { known_0: 0.64, known_1: 0.32, no_clear_identity: 0.04 }, confidence: 0.60 }
  applyRelationshipSpeakerReview(weakAgreement.plan, weakAgreement.answers, { relationship_s0: { choice: 'known_0', probabilities: { known_0: 0.51, known_1: 0.43, no_clear_identity: 0.06 }, confidence: 0.48 } }, {}, null, null, true)
  assert.ok(weakAgreement.answers.relationship_confirmed_s0)
  assert.equal(weakAgreement.answers.global_uncertain_s0, undefined)
  const zadieLog = make()
  zadieLog.answers.speech_s0 = { choice: 'known_0', probabilities: { known_0: 0.70, known_1: 0.25, no_clear_identity: 0.05 }, confidence: 0.66 }
  applyRelationshipSpeakerReview(zadieLog.plan, zadieLog.answers, { relationship_s0: { choice: 'known_0', probabilities: { known_0: 0.49, known_1: 0.41, no_clear_identity: 0.10 }, confidence: 0.45 } }, {}, null, null, true)
  assert.ok(zadieLog.answers.relationship_confirmed_s0)
  assert.equal(zadieLog.answers.global_uncertain_s0, undefined)
  const zadieSecond = make()
  zadieSecond.answers.speech_s0 = { choice: 'known_0', probabilities: { known_0: 0.60, known_1: 0.24, no_clear_identity: 0.16 }, confidence: 0.55 }
  applyRelationshipSpeakerReview(zadieSecond.plan, zadieSecond.answers, { relationship_s0: { choice: 'known_0', probabilities: { known_0: 0.45, known_1: 0.31, no_clear_identity: 0.24 }, confidence: 0.41 } }, {}, null, null, true)
  assert.ok(zadieSecond.answers.relationship_confirmed_s0)
  const conflict = make()
  applyRelationshipSpeakerReview(conflict.plan, conflict.answers, { relationship_s0: { choice: 'known_1', probabilities: { known_1: 0.75, known_0: 0.20, no_clear_identity: 0.05 }, confidence: 0.70 } }, {}, null, null, true)
  assert.ok(conflict.answers.global_uncertain_s0)
  assert.equal(conflict.answers.relationship_confirmed_s0, undefined)
  const userPlan = buildSpeakerDecisionPlan('"Sacrifice."', [{ id: USER_SPEAKER_ID, name: 'Ken' }, { id: 'npc:ewan', name: 'Ewan' }], false)
  const userAnswers: Record<string, SpeakerDecisionChoice> = { speech_s0: { choice: 'known_0', probabilities: { known_0: 0.75, known_1: 0.1, no_clear_identity: 0.15 }, confidence: 0.72 } }
  applyRelationshipSpeakerReview(userPlan, userAnswers, { relationship_s0: { choice: 'known_0', probabilities: { known_0: 0.51, known_1: 0.16, no_clear_identity: 0.33 }, confidence: 0.48 } }, {}, null, null, true)
  assert.ok(userAnswers.global_uncertain_s0)
  assert.equal(userAnswers.relationship_confirmed_s0, undefined)
})

test('contextual persona reconciliation reviews existing and newly introduced user assignments', () => {
  const speakers = [{ id: 'npc:ewan', name: 'Ewan' }, { id: USER_SPEAKER_ID, name: 'Ken' }]
  const message = '"Sacrifice."\n\nHe turns with the tray.\n\n"The noodles?"\n\n"No, I know what you meant."'
  const plan = buildSpeakerDecisionPlan(message, speakers, false)
  const context = { previousMessages: [{ id: 'u', role: 'user' as const, text: 'I turn to Ewan. "Sometimes you sacrifice."' }], ghosts: [] }
  const answers: Record<string, SpeakerDecisionChoice> = { speech_s0: confidentDecision('known_1'), speech_s1: confidentDecision('known_1'), speech_s2: confidentDecision('known_0'), relationship_original_s1: confidentDecision('no_clear_identity'), relationship_review_s1: confidentDecision('known_1'), relationship_applied_s1: confidentDecision('known_1'), relationship_continuity_s1: confidentDecision('known_1') }
  const review = buildContextualUserReconciliation(plan, answers, context)
  assert.ok(review.questions.persona_check_s0)
  assert.ok(review.questions.persona_check_s1)
  assert.equal(review.questions.persona_check_s2, undefined)
  applyContextualUserReconciliation(plan, answers, { persona_check_s0: confidentDecision('no_clear_identity'), persona_check_s1: confidentDecision('other') }, review.questions)
  assert.ok(answers.global_uncertain_s0)
  assert.ok(answers.global_uncertain_s1)
  assert.equal(answers.speech_s0.choice, 'no_clear_identity')
  assert.equal(answers.relationship_continuity_s1, undefined)
  answers.persona_phase_complete = { choice: 'complete', probabilities: {}, confidence: 0 }
  applyRelationshipSpeakerReview(plan, answers, { relationship_s0: confidentDecision('known_0', 0.67, 0.65), relationship_s1: confidentDecision('known_0', 0.67, 0.65) }, {}, null, null, true)
  assert.equal(answers.speech_s0.choice, 'known_0')
  assert.equal(answers.speech_s1.choice, 'known_0')
  const late = buildSpeakerDecisionPlan('"Who said that?"', speakers, false)
  const lateAnswers: Record<string, SpeakerDecisionChoice> = { speech_s0: confidentDecision('no_clear_identity'), persona_phase_complete: { choice: 'complete', probabilities: {}, confidence: 0 } }
  applyRelationshipSpeakerReview(late, lateAnswers, { relationship_s0: confidentDecision('known_1') }, {}, null, null, true)
  assert.ok(lateAnswers.global_uncertain_s0)
  const genuine = buildSpeakerDecisionPlan('"I agree," Ken says.', speakers, false)
  const genuineAnswers: Record<string, SpeakerDecisionChoice> = { speech_s0: confidentDecision('known_1') }
  const genuineReview = buildContextualUserReconciliation(genuine, genuineAnswers, context)
  applyContextualUserReconciliation(genuine, genuineAnswers, { persona_check_s0: confidentDecision('user') }, genuineReview.questions)
  assert.ok(genuineAnswers.persona_confirmed_s0)
  assert.equal(genuineAnswers.global_uncertain_s0, undefined)
  const attributedOther = buildSpeakerDecisionPlan('"I agree," Ewan says.', speakers, false)
  const wrongPersona: Record<string, SpeakerDecisionChoice> = { speech_s0: confidentDecision('known_1') }
  const attributedReview = buildContextualUserReconciliation(attributedOther, wrongPersona, context)
  applyContextualUserReconciliation(attributedOther, wrongPersona, { persona_check_s0: confidentDecision('user') }, attributedReview.questions)
  assert.ok(wrongPersona.global_uncertain_s0)
  assert.equal(wrongPersona.persona_confirmed_s0, undefined)
  assert.equal(buildContextualUserReconciliation(buildSpeakerDecisionPlan('"I agree."', speakers, true), genuineAnswers, context).questions.persona_check_s0, undefined)
})

test('replays opening user-confusion and later text-message agreement without mixing identities', () => {
  const speakers = [{ id: 'npc:ewan', name: 'Ewan' }, { id: 'npc:zadie', name: 'Zadie' }, { id: USER_SPEAKER_ID, name: 'Ken' }]
  const message = '"Sacrifice."\n\nHe turns with the tray.\n\n"The noodles?"\n\n"No, I know what you meant."\n\nHe lifts one shoulder.\n\n"Whatever. Text her."\n\nHours later, a phone buzzes.\n\n"Do not bring food."\n\n"Dinner is handled."'
  const plan = buildSpeakerDecisionPlan(message, speakers, false)
  const context = { previousMessages: [{ id: 'prior', role: 'user' as const, text: 'I turn to Ewan. "Sometimes you sacrifice."' }], ghosts: [] }
  const answers: Record<string, SpeakerDecisionChoice> = {
    speech_s0: confidentDecision('known_2', 0.74, 0.71), speech_s1: confidentDecision('no_clear_identity'),
    speech_s2: confidentDecision('known_0'), speech_s3: confidentDecision('known_0'),
    speech_s4: confidentDecision('known_1', 0.70, 0.66), speech_s5: { choice: 'known_1', probabilities: { known_1: 0.60, known_2: 0.24, no_clear_identity: 0.16 }, confidence: 0.55 },
  }
  snapshotSpeakerFirstPass(plan, answers)
  applyRelationshipSpeakerReview(plan, answers, {
    relationship_s0: confidentDecision('known_2', 0.54, 0.51),
    relationship_s1: confidentDecision('known_2', 0.56, 0.53),
    relationship_s4: { choice: 'known_1', probabilities: { known_1: 0.49, known_2: 0.41, no_clear_identity: 0.1 }, confidence: 0.45 },
    relationship_s5: { choice: 'known_1', probabilities: { known_1: 0.45, known_2: 0.31, no_clear_identity: 0.24 }, confidence: 0.41 },
  }, {}, null, null, true)
  const personaReview = buildContextualUserReconciliation(plan, answers, context)
  applyContextualUserReconciliation(plan, answers, { persona_check_s0: confidentDecision('no_clear_identity'), persona_check_s1: confidentDecision('other') }, personaReview.questions)
  answers.persona_phase_complete = { choice: 'complete', probabilities: {}, confidence: 0 }
  assert.ok(buildOpeningSpeakerReview(plan, answers, context, null)?.questions.relationship_s0)
  applyRelationshipSpeakerReview(plan, answers, { relationship_s0: confidentDecision('known_0', 0.67, 0.65), relationship_s1: confidentDecision('known_0', 0.67, 0.65) }, {}, null, null, true)
  const segments = resolveSpeakerDecisionSegments(message, plan, answers, speakers, { isUserMessage: false, cardSpeakerId: null, historicalSpeakerId: null, evidenceOnly: true, includeDebug: true })
  assert.deepEqual(segments.filter(segment => segment.speakerId !== null).map(segment => segment.speakerId), ['npc:ewan', 'npc:ewan', 'npc:ewan', 'npc:ewan', 'npc:zadie', 'npc:zadie'])
  assert.ok(segments[0].debugPath?.some(step => step === 'jev-first-pass-speech-normalized:__chat_voice_user__'))
  assert.equal(speakerAssignmentSourceFromTrace(segments[0].debugPath ?? [], false), 'contextual-review')
})

test('opening exchange review fills uncertain lines only for a strongly supported coherent speaker', () => {
  const speakers = [{ id: 'npc:ewan', name: 'Ewan' }, { id: USER_SPEAKER_ID, name: 'Ken' }]
  const plan = buildSpeakerDecisionPlan('"Sacrifice."\n\nHe turns with the tray.\n\n"The noodles?"\n\n"No, I know what you meant."', speakers, false)
  const context = { previousMessages: [{ id: 'prior', role: 'user' as const, text: 'I turn to Ewan. "Sometimes you sacrifice."' }], ghosts: [] }
  const make = () => ({ speech_s0: confidentDecision('known_1'), speech_s1: confidentDecision('no_clear_identity'), speech_s2: confidentDecision('known_0'), global_uncertain_s0: confidentDecision('no_clear_identity'), global_uncertain_s1: confidentDecision('no_clear_identity') } as Record<string, SpeakerDecisionChoice>)
  const answers = make()
  const review = buildOpeningSpeakerReview(plan, answers, context, null)!
  assert.ok(review.questions.opening_exchange_pattern)
  assert.ok(review.questions.opening_exchange_speaker)
  const supported = { opening_exchange_pattern: confidentDecision('single_speaker'), opening_exchange_speaker: confidentDecision('known_0') }
  applyOpeningExchangeReview(plan, answers, supported)
  assert.equal(answers.speech_s0.choice, 'known_0')
  assert.equal(answers.speech_s1.choice, 'known_0')
  assert.equal(answers.global_uncertain_s0, undefined)
  assert.ok(answers.relationship_exchange_s0)
  const mixed = make()
  applyOpeningExchangeReview(plan, mixed, { ...supported, opening_exchange_pattern: confidentDecision('multiple_speakers') })
  assert.ok(mixed.global_uncertain_s0)
  assert.equal(mixed.opening_pattern_s0.choice, 'multiple_speakers')
  const weak = make()
  applyOpeningExchangeReview(plan, weak, { ...supported, opening_exchange_speaker: { choice: 'known_0', probabilities: { known_0: 0.60, known_1: 0.40 }, confidence: 0.55 } })
  assert.ok(weak.global_uncertain_s0)
  const conflict = make()
  conflict.speech_s2 = confidentDecision('known_1')
  applyOpeningExchangeReview(plan, conflict, supported)
  assert.ok(conflict.global_uncertain_s0)
  const perSpeechConflict = make()
  applyOpeningExchangeReview(plan, perSpeechConflict, { ...supported, relationship_s1: confidentDecision('known_1') })
  assert.ok(perSpeechConflict.global_uncertain_s1)
})

test('opening review excludes the following scene and its dialogue from all focused state', () => {
  const speakers = [{ id: 'npc:ewan', name: 'Ewan' }, { id: USER_SPEAKER_ID, name: 'Ken' }]
  const content = '"Sacrifice."\n\nHe turns with the tray.\n\n"The noodles?"\n\nHours later, another room. "An unrelated message."'
  const plan = buildSpeakerDecisionPlan(content, speakers, false)
  const answers: Record<string, SpeakerDecisionChoice> = { speech_s0: confidentDecision('no_clear_identity'), global_uncertain_s0: confidentDecision('no_clear_identity') }
  const context = { previousMessages: [{ id: 'prior', role: 'user' as const, text: 'I turn to Ewan. "Sometimes you sacrifice."' }], ghosts: [] }
  const review = buildOpeningSpeakerReview(plan, answers, context, null)!
  assert.deepEqual(review.state.speeches.map(speech => speech.id), ['s0', 's1'])
  assert.doesNotMatch(review.state.message, /unrelated message/u)
  assert.ok(review.state.runs.every(run => run.speechIds.every(id => id === 's0' || id === 's1')))
  assert.equal(review.state.boundaryEvidence?.quotation, 'Sometimes you sacrifice.')
})

test('opening review scopes the tray exchange separately from incoming phone messages', () => {
  const speakers = [{ id: 'npc:ewan', name: 'Ewan' }, { id: 'npc:zadie', name: 'Zadie' }, { id: USER_SPEAKER_ID, name: 'Ken' }]
  const message = '"Sacrifice."\n\nHe is ten paces off with the tray balanced on one palm, and he turns halfway around.\n\n"What are you sacrificing? The noodles?"\n\nSomebody behind him sidesteps the tray, and he shifts without looking.\n\n"No, I know what you meant." A beat, and his jaw works over something he cannot say. "You do not take a little off the top and keep the rest."\n\nHe lifts one shoulder.\n\n"Whatever. Text her."\n\nHe goes. The tray goes through the window, and there is a crash from the other side of it, and then he is out the side door and the door swings twice and settles.\n\nThe phone buzzes in Ken’s hand.\n\n"Do not bring food."\n\n"Dinner is handled."'
  const plan = buildSpeakerDecisionPlan(message, speakers, false)
  const context = { previousMessages: [{ id: 'user', role: 'user' as const, text: 'I turn to Ewan again. "Sometimes you gotta sacrifice a little for someone you like, you know?"' }], ghosts: [] }
  const answers: Record<string, SpeakerDecisionChoice> = { speech_s0: confidentDecision('no_clear_identity'), global_uncertain_s0: confidentDecision('no_clear_identity') }
  const review = buildOpeningSpeakerReview(plan, answers, context, null)!
  assert.deepEqual(review.state.speeches.map(item => item.id), ['s0', 's1', 's2', 's3', 's4'])
  assert.doesNotMatch(review.state.message, /Do not bring food|Dinner is handled/u)
  assert.match(review.state.boundaryEvidence?.quotation ?? '', /sacrifice a little/u)
  assert.match(review.state.boundaryEvidence?.lead ?? '', /turn to Ewan/u)
})

test('backward links require a strong independent same-speaker answer and a validated later anchor', () => {
  const speakers = [{ id: 'npc:ewan', name: 'Ewan' }, { id: USER_SPEAKER_ID, name: 'Ken' }]
  const message = '"Sacrifice."\n\nHe turns with the tray.\n\n"What are you sacrificing?"\n\n"No, I know what you meant."'
  const plan = buildSpeakerDecisionPlan(message, speakers, false)
  const context = { previousMessages: [{ id: 'user', role: 'user' as const, text: 'I turn to Ewan. "Sometimes you sacrifice."' }], ghosts: [] }
  const make = () => ({ speech_s0: confidentDecision('known_1'), speech_s1: confidentDecision('no_clear_identity'), speech_s2: confidentDecision('known_0'), global_uncertain_s0: confidentDecision('no_clear_identity'), global_uncertain_s1: confidentDecision('no_clear_identity'), relationship_applied_s2: confidentDecision('known_0') } as Record<string, SpeakerDecisionChoice>)
  const answers = make()
  const review = buildOpeningBacklinkReview(plan, answers, context, null)!
  assert.equal(review.links.backlink_s0.anchorId, 's2')
  assert.equal(review.links.backlink_s1.identity, 'npc:ewan')
  assert.equal(review.state.boundaryEvidence?.quotation, 'Sometimes you sacrifice.')
  assert.equal(review.state.boundaryEvidence?.role, 'user')
  assert.match(review.state.boundaryEvidence?.lead ?? '', /turn to Ewan/u)
  assert.equal(review.state.pairEvidence.backlink_s0.target, 'Sacrifice.')
  assert.equal(review.state.pairEvidence.backlink_s0.anchor, 'No, I know what you meant.')
  assert.match(review.state.pairEvidence.backlink_s0.between, /tray/u)
  assert.match(review.questions.backlink_s0.instructions, /Both quotations are from the CURRENT message/u)
  applyOpeningBacklinkReview(plan, answers, { backlink_s0: confidentDecision('same'), backlink_s1: confidentDecision('different_or_unclear') }, review.links)
  assert.equal(answers.speech_s0.choice, 'known_0')
  assert.equal(answers.global_uncertain_s0, undefined)
  assert.ok(answers.global_uncertain_s1)
  const weak = make()
  applyOpeningBacklinkReview(plan, weak, { backlink_s0: { choice: 'same', probabilities: { same: 0.70, different_or_unclear: 0.30 }, confidence: 0.7 } }, review.links)
  assert.ok(weak.global_uncertain_s0)
  const stale = make()
  stale.speech_s2 = confidentDecision('known_1')
  applyOpeningBacklinkReview(plan, stale, { backlink_s0: confidentDecision('same') }, review.links)
  assert.ok(stale.global_uncertain_s0)
  const unvalidated = make()
  delete unvalidated.relationship_applied_s2
  assert.equal(buildOpeningBacklinkReview(plan, unvalidated, context, null), null)
  const changedScene = buildSpeakerDecisionPlan('"First."\n\nHours later, the room is empty.\n\n"Second," Ewan says.', speakers, false)
  const sceneAnswers: Record<string, SpeakerDecisionChoice> = { speech_s0: confidentDecision('no_clear_identity'), global_uncertain_s0: confidentDecision('no_clear_identity'), speech_s1: confidentDecision('known_0'), relationship_applied_s1: confidentDecision('known_0') }
  assert.equal(buildOpeningBacklinkReview(changedScene, sceneAnswers, context, null), null)
  const explicitlyDifferent = buildSpeakerDecisionPlan('"First," Ken says.\n\n"Second," Ewan says.', speakers, false)
  assert.equal(buildOpeningBacklinkReview(explicitlyDifferent, sceneAnswers, context, null), null)
})

test('global TTS connection preference overrides the host default without per-chat input', () => {
  const connections = [{ id: 'fish', is_default: true }, { id: 'other' }]
  assert.equal(globalTtsConnectionPreference({ ttsConnectionId: 'fish' }), 'fish')
  assert.equal(globalTtsConnectionPreference({ chatVoiceTtsConnectionId: 'other', ttsConnectionId: 'fish' }), 'other')
  assert.equal(globalTtsConnectionPreference({ chatVoiceTtsConnectionId: '', ttsConnectionId: 'other' }), '')
  assert.equal(resolveGlobalTtsConnection('', connections), 'fish')
  assert.equal(resolveGlobalTtsConnection('missing', connections), 'missing')
  assert.equal(resolveGlobalTtsConnection('other', connections), 'other')
  assert.equal(resolveGlobalTtsConnection('', []), '')
})

test('standard speaker review enables the production pipeline without comparison calls', () => {
  assert.deepEqual(standardSpeakerReviewPolicy(), { runReview: true, bestAvailableSpeaker: true, shadowEvaluation: false, focusedOpeningFallback: false })
})

test('autoplay selects successful foreground messages and rerolls without duplicate events', () => {
  const event = { chatId: 'chat', generationId: 'gen', messageId: 'new', content: 'Finished text', generationType: 'normal' }
  assert.deepEqual(autoplayGenerationEvent(event, 'chat'), { chatId: 'chat', generationId: 'gen', messageId: 'new', content: 'Finished text' })
  assert.deepEqual(autoplayGenerationEvent({ ...event, generationType: undefined }, 'chat'), { chatId: 'chat', generationId: 'gen', messageId: 'new', content: 'Finished text' })
  assert.equal(autoplayGenerationEvent(event, 'another-chat'), null)
  assert.equal(autoplayGenerationEvent({ ...event, error: 'generation failed' }, 'chat'), null)
  assert.equal(autoplayGenerationEvent({ ...event, messageId: undefined }, 'chat'), null)
  assert.equal(autoplayGenerationEvent({ ...event, generationId: '' }, 'chat'), null)
  assert.equal(autoplayGenerationEvent({ ...event, backgroundSwipe: true }, 'chat'), null)
  for (const generationType of ['continue', 'impersonate']) assert.equal(autoplayGenerationEvent({ ...event, generationType }, 'chat'), null)
  for (const generationType of ['regenerate', 'swipe']) assert.deepEqual(autoplayGenerationEvent({ ...event, generationType }, 'chat'), { chatId: 'chat', generationId: 'gen', messageId: 'new', reroll: true, content: 'Finished text' })
  const generations = new Set<string>()
  const messages = new Set<string>()
  assert.equal(claimAutoplayGeneration(event, generations, messages), true)
  assert.equal(claimAutoplayGeneration(event, generations, messages), false)
  const untypedReroll = autoplayGenerationEvent({ ...event, generationId: 'retry', generationType: undefined }, 'chat')!
  assert.equal(claimAutoplayGeneration(untypedReroll, generations, messages), true)
  assert.equal(claimAutoplayGeneration(untypedReroll, generations, messages), false)
  const reroll = { ...event, generationId: 'reroll', reroll: true }
  assert.equal(claimAutoplayGeneration(reroll, generations, messages), true)
  assert.equal(claimAutoplayGeneration(reroll, generations, messages), false)
  assert.equal(claimAutoplayGeneration({ ...reroll, generationId: 'reroll-2' }, generations, messages), true)
  assert.equal(claimAutoplayGeneration({ ...event, chatId: 'other' }, generations, messages), true)
})

test('autoplay recognizes saved audio only on its active swipe', () => {
  const legacy = { extra: { attachments: [{ type: 'audio' }] } }
  assert.equal(hasAudioForActiveSwipe(legacy), true)
  assert.equal(hasAudioForActiveSwipe({ ...legacy, swipe_id: 1 }), false)
  const swiped = { swipe_id: 1, extra: { attachments: [{ type: 'audio', swipe_id: 0 }, { type: 'audio', swipe_id: 1 }] } }
  assert.equal(hasAudioForActiveSwipe(swiped), true)
  assert.equal(hasAudioForActiveSwipe({ ...swiped, swipe_id: 2 }), false)
  assert.equal(hasAudioForActiveSwipe({ swipe_id: 1, extra: { attachments: [{ type: 'image', swipe_id: 1 }] } }), false)
})

test('autoplay snapshots the active swipe and detects later navigation or edits', () => {
  const message = { swipe_id: 4, content: 'Fourth reroll.' }
  const snapshot = autoplaySwipeSnapshot(message)
  assert.equal(autoplaySwipeMatches(message, snapshot), true)
  assert.equal(autoplaySwipeMatches({ ...message, swipe_id: 5 }, snapshot), false)
  assert.equal(autoplaySwipeMatches({ ...message, content: 'A later reroll in the same slot.' }, snapshot), false)
  assert.equal(autoplaySwipeMatches({ content: 'Original.' }, autoplaySwipeSnapshot({ swipe_id: 0, content: 'Original.' })), true)
})

test('autoplay refreshes edits on the original swipe after its delay but rejects another swipe', () => {
  const generated = { swipe_id: 2, content: 'Original text.', swipe_dates: [10, 20, 30] }
  const original = autoplaySwipeSnapshot(generated)
  const honed = { ...generated, content: 'Honed text.' }
  const refreshed = refreshAutoplaySwipe(honed, original)
  assert.ok(refreshed)
  assert.equal(autoplaySwipeMatches(honed, refreshed), true)
  assert.equal(autoplaySwipeMatches(honed, original), false)
  assert.equal(refreshAutoplaySwipe({ ...honed, swipe_id: 1 }, original), null)
  assert.equal(refreshAutoplaySwipe({ ...honed, swipe_dates: [10, 20, 99] }, original), null)
  assert.equal(autoplaySwipeMatches({ ...honed, content: 'Edited after refresh.' }, refreshed), false)
  assert.ok(refreshAutoplaySwipe({ swipe_id: 2, content: 'Edited.' }, autoplaySwipeSnapshot({ swipe_id: 2, content: 'Original.' })))
})

test('synthesis and save validation remain scoped to the original swipe after navigation', () => {
  const initial = { swipe_id: 1, content: 'Second version.' }
  const snapshot = autoplaySwipeSnapshot(initial)
  const navigated = { swipe_id: 2, content: 'Third version.', swipes: ['First version.', 'Second version.', 'Third version.'] }
  assert.equal(autoplaySwipeMatches(navigated, snapshot), false)
  assert.equal(targetSwipeContentMatches(readMessageSwipeContent(navigated, snapshot.swipeId), snapshot), true)
  assert.equal(targetSwipeContentMatches(readMessageSwipeContent({ ...navigated, swipes: ['First version.', 'Edited.', 'Third version.'] }, 1), snapshot), false)
  assert.equal(targetSwipeContentMatches(readMessageSwipeContent({ ...navigated, swipes: ['First version.', 'Third version.'] }, 1), snapshot), false)
  assert.equal(readMessageSwipeContent({ swipe_id: 2, content: 'Third version.' }, 1), null)
  assert.notEqual(swipeSynthesisKey('chat', 'message', 1), swipeSynthesisKey('chat', 'message', 2))
  assert.equal(swipeSynthesisKey('chat', 'message', 1), swipeSynthesisKey('chat', 'message', 1))
})

test('saved audio confirmation requires the requested swipe and attachment', () => {
  const result = { message: { id: 'message', extra: { attachments: [{ type: 'audio', image_id: 'older', swipe_id: 1 }, { type: 'audio', image_id: 'new', swipe_id: 2 }] } }, audio: { id: 'new' }, swipe_id: 2 }
  assert.equal(savedAudioMatchesSwipe(result, 'message', 2), true)
  assert.equal(savedAudioMatchesSwipe(result, 'message', 1), false)
  assert.equal(savedAudioMatchesSwipe({ ...result, swipe_id: 1 }, 'message', 2), false)
  assert.equal(savedAudioMatchesSwipe({ ...result, audio: { id: 'older' } }, 'message', 2), false)
})

test('saved audio does not prevent automatic playback of a valid reroll', () => {
  const message = { is_user: false, swipe_id: 3, content: 'New response.', extra: { attachments: [{ type: 'audio', swipe_id: 3 }] } }
  const snapshot = autoplaySwipeSnapshot(message)
  assert.equal(hasAudioForActiveSwipe(message), true)
  assert.equal(automaticPlaybackSkipReason(message, snapshot), null)
  assert.equal(automaticPlaybackSkipReason({ ...message, is_user: true }, snapshot), 'user-message')
  assert.equal(automaticPlaybackSkipReason({ ...message, swipe_id: 4 }, snapshot), 'changed-swipe')
  assert.equal(automaticPlaybackSkipReason({ ...message, content: 'Changed response.' }, snapshot), 'changed-swipe')
  assert.equal(shouldPersistMessageAudio(false, true, false), true)
  assert.equal(shouldPersistMessageAudio(false, false, false), false)
})

test('playback controls follow shared playback state, including menus rendered later', () => {
  class FakeButton {
    dataset: Record<string, string> = {}
    attributes = new Map<string, string>()
    writes = 0
    constructor(public messageId: string, private html: string, title: string) { this.attributes.set('title', title) }
    get innerHTML() { return this.html }
    set innerHTML(value: string) { this.writes++; this.html = value }
    get title() { return this.attributes.get('title') ?? '' }
    set title(value: string) { this.attributes.set('title', value) }
    getAttribute(name: string) { return this.attributes.get(name) ?? null }
    setAttribute(name: string, value: string) { this.attributes.set(name, value) }
    removeAttribute(name: string) { this.attributes.delete(name) }
    querySelector(selector: string) { return (selector === ':scope > span' ? this.html.includes('<span>') : selector === '[data-chat-voice-stop]' && this.html.includes('data-chat-voice-stop')) ? {} : null }
  }
  const bubble = new FakeButton('new', '<svg></svg>', 'Play audio')
  const other = new FakeButton('old', '<svg></svg>', 'Play other')
  const menu = new FakeButton('new', '<svg></svg><span>Play audio</span>', 'Play audio')
  const states = new Map<HTMLButtonElement, PlaybackButtonState>()
  const native = (button: FakeButton) => button as unknown as HTMLButtonElement
  const id = (button: HTMLButtonElement) => (button as unknown as FakeButton).messageId
  const icon = '<svg data-chat-voice-stop="true"></svg>'
  syncPlaybackButtons([native(bubble), native(other)], 'new', id, states, icon)
  assert.equal(bubble.dataset.playing, 'true')
  assert.equal(bubble.getAttribute('aria-label'), 'Stop custom voice playback')
  assert.equal(other.dataset.playing, undefined)
  const writes = bubble.writes
  syncPlaybackButtons([native(bubble), native(other), native(menu)], 'new', id, states, icon)
  assert.equal(bubble.writes, writes)
  assert.equal(menu.dataset.playing, 'true')
  assert.match(menu.innerHTML, /Stop custom voice playback/u)
  bubble.innerHTML = '<svg></svg>' // The host re-rendered the existing control.
  syncPlaybackButtons([native(bubble), native(other), native(menu)], 'new', id, states, icon)
  assert.match(bubble.innerHTML, /data-chat-voice-stop/u)
  syncPlaybackButtons([native(bubble), native(other), native(menu)], null, id, states, icon)
  assert.equal(bubble.innerHTML, '<svg></svg>')
  assert.equal(bubble.title, 'Play audio')
  assert.equal(bubble.getAttribute('aria-pressed'), null)
  assert.equal(menu.innerHTML, '<svg></svg><span>Play audio</span>')
  assert.equal(states.size, 0)
})

test('autoplay indicators follow the shared preference on each native control', () => {
  const button = { dataset: {}, messageId: 'message' } as unknown as HTMLButtonElement
  const unrelated = { dataset: {}, messageId: null } as unknown as HTMLButtonElement
  const getId = (item: HTMLButtonElement) => (item as unknown as { messageId: string | null }).messageId
  syncAutoplayIndicators([button, unrelated], true, getId)
  assert.equal(button.dataset.chatVoiceAutoplay, 'true')
  assert.equal(unrelated.dataset.chatVoiceAutoplay, undefined)
  syncAutoplayIndicators([button, unrelated], false, getId)
  assert.equal(button.dataset.chatVoiceAutoplay, undefined)
})

test('long press toggles once and suppresses its click, but taps and drags do not', async () => {
  let toggles = 0
  const button = {}
  const gesture = new PlaybackLongPress<object>(() => { toggles++ }, 10)
  gesture.start(button, 1, 0, 0)
  gesture.end(1)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(toggles, 0)
  assert.equal(gesture.consumeClick(button), false)
  gesture.start(button, 2, 0, 0)
  gesture.move(2, 20, 0)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(toggles, 0)
  gesture.start(button, 3, 0, 0)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(toggles, 1)
  gesture.end(3)
  assert.equal(gesture.consumeClick({}), false)
  assert.equal(gesture.consumeClick(button), true)
  assert.equal(gesture.consumeClick(button), false)
  gesture.start(button, 4, 0, 0)
  await new Promise(resolve => setTimeout(resolve, 20))
  gesture.end(4)
  assert.equal(toggles, 2)
  gesture.cancel()
})

test('automatic casting defaults on and autoplay requires explicit opt-in', () => {
  assert.deepEqual(readAutomaticVoicePreferences({}), { autoVoiceCasting: true, autoPlayback: false })
  assert.deepEqual(readAutomaticVoicePreferences({ chatVoiceAutoCasting: false, chatVoiceAutoPlayback: true }), { autoVoiceCasting: false, autoPlayback: true })
  assert.deepEqual(readAutomaticVoicePreferences({ chatVoiceAutoCasting: true, chatVoiceAutoPlayback: 'true' }), { autoVoiceCasting: true, autoPlayback: false })
})

test('autoplay delay defaults to zero and clamps invalid and excessive values', () => {
  assert.equal(readAutoplayDelaySeconds(undefined), 0)
  assert.equal(readAutoplayDelaySeconds(NaN), 0)
  assert.equal(readAutoplayDelaySeconds(-3), 0)
  assert.equal(readAutoplayDelaySeconds(2.6), 3)
  assert.equal(readAutoplayDelaySeconds(5000), 3600)
})

test('autoplay deadline waits and can be cancelled without blocking the queue', async () => {
  const alreadyAborted = new AbortController()
  alreadyAborted.abort()
  assert.equal(await waitForAutoplayDeadline(Date.now(), alreadyAborted.signal), false)
  assert.equal(await waitForAutoplayDeadline(Date.now() - 1, new AbortController().signal), true)
  const pending = new AbortController()
  const waiting = waitForAutoplayDeadline(Date.now() + 10000, pending.signal)
  pending.abort()
  assert.equal(await waiting, false)
  assert.equal(await waitForAutoplayDeadline(Date.now() + 5, new AbortController().signal), true)
})

test('new rerolls supersede the same message without cancelling other messages', async () => {
  const requests = new AutoplayRequestRegistry()
  const first = requests.begin('chat\0message')
  const other = requests.begin('chat\0other')
  const pendingDelay = waitForAutoplayDeadline(Date.now() + 10000, first)
  const second = requests.begin('chat\0message')
  assert.equal(await pendingDelay, false)
  assert.equal(first.aborted, true)
  assert.equal(other.aborted, false)
  requests.finish('chat\0message', first)
  assert.equal(second.aborted, false)
  const playing = waitForAutoplayWork(new Promise<void>(() => undefined), second)
  const third = requests.begin('chat\0message')
  await playing
  assert.equal(second.aborted, true)
  assert.equal(third.aborted, false)
  requests.cancelAll()
  assert.equal(third.aborted, true)
  assert.equal(other.aborted, true)
})

test('playback startup ownership prevents overlapping and cancelled audio starts', () => {
  const guard = new PlaybackStartupGuard()
  const first = guard.begin('chat', 'one', true)!
  assert.equal(guard.begin('chat', 'one', true), null)
  assert.equal(guard.owns(first), true)
  const second = guard.begin('chat', 'two', false)!
  assert.equal(guard.owns(first), false)
  assert.equal(guard.owns(second), true)
  guard.finish(first)
  assert.equal(guard.owns(second), true)
  assert.equal(guard.begin('chat', 'two', false), null)
  assert.equal(guard.owns(second), false)
  const third = guard.begin('chat', 'three', true)!
  guard.cancelAutomatic()
  assert.equal(guard.owns(third), false)
  const manual = guard.begin('chat', 'four', false)!
  guard.cancelAutomatic()
  assert.equal(guard.owns(manual), true)
  guard.cancelAutomaticFor('chat', 'four')
  assert.equal(guard.owns(manual), true)
  guard.cancel()
  assert.equal(guard.owns(manual), false)
  const auto = guard.begin('chat', 'five', true)!
  guard.cancelAutomaticFor('chat', 'other')
  assert.equal(guard.owns(auto), true)
  guard.cancelAutomaticFor('chat', 'five')
  assert.equal(guard.owns(auto), false)
})

test('immediate named voice attribution anchors the preceding quote but not an introduced next quote', () => {
  const speakers = [{ id: 'unconfigured:maeve', name: 'Maeve' }, { id: 'unconfigured:erin', name: 'Erin' }, { id: USER_SPEAKER_ID, name: 'Ken' }]
  const text = '"Decided what?"\n\nMaeve’s voice comes from the other side of Erin, flat and absolutely awake.\n\n"Whether I sleep in my boots."'
  const plan = buildSpeakerDecisionPlan(text, speakers, false)
  const answers: Record<string, SpeakerDecisionChoice> = { speech_s0: confidentDecision('known_1'), global_uncertain_s0: confidentDecision('no_clear_identity') }
  applyExplicitPostQuoteVoiceAttributions(plan, answers)
  assert.equal(answers.speech_s0.choice, 'known_0')
  assert.ok(answers.explicit_voice_attribution_s0)
  assert.equal(answers.global_uncertain_s0, undefined)
  const nextQuote = buildSpeakerDecisionPlan('"Hello."\n\nMaeve’s voice comes over the phone. "I am here."', speakers, false)
  const unchanged: Record<string, SpeakerDecisionChoice> = { speech_s0: confidentDecision('known_1') }
  applyExplicitPostQuoteVoiceAttributions(nextQuote, unchanged)
  assert.equal(unchanged.speech_s0.choice, 'known_1')
  assert.equal(unchanged.explicit_voice_attribution_s0, undefined)
})

test('an explicit named-voice anchor can resolve a strong switch and independently linked smoker lines', () => {
  const speakers = [{ id: 'unconfigured:maeve', name: 'Maeve' }, { id: 'unconfigured:erin', name: 'Erin' }, { id: USER_SPEAKER_ID, name: 'Ken' }]
  const text = 'The smoker sits by the window. "Lamp is out," she says. "I did not light it."\n\n"Decided what?"\n\nMaeve’s voice comes from the other side of Erin.\n\n"Whether I sleep in my boots." The smoker puts her boots down. "Boots stay."'
  const plan = buildSpeakerDecisionPlan(text, speakers, false)
  const answers: Record<string, SpeakerDecisionChoice> = {}
  for (const speech of plan.state.speeches) answers[`speech_${speech.id}`] = confidentDecision('known_0')
  answers.speech_s2 = { choice: 'known_0', probabilities: { known_0: 0.34, known_1: 0.22, no_clear_identity: 0.44 }, confidence: 0.27 }
  answers.turn_s2 = confidentDecision('responds_to_previous_speaker')
  answers.global_uncertain_s2 = confidentDecision('no_clear_identity')
  applyExplicitPostQuoteVoiceAttributions(plan, answers)
  assert.ok(answers.explicit_voice_attribution_s2)
  const context = { previousMessages: [{ id: 'prior', role: 'user' as const, text: 'Erin lies beside me.' }], ghosts: [] }
  const review = buildSpeakerSwitchContradictionReview(plan, answers, context)
  assert.equal(review.runs.length, 1)
  const run = review.runs[0]
  const results: Record<string, SpeakerDecisionChoice> = {
    [`switch_${run.id}`]: { choice: 'different', probabilities: { different: 0.73, same_or_unclear: 0.27 }, confidence: 0.46 },
    [`switch_speaker_${run.id}_s1`]: { choice: 'uncast_character', probabilities: { uncast_character: 0.8, known_0: 0.2 }, confidence: 0.77 },
    [`switch_speaker_${run.id}_s2`]: confidentDecision('known_1'),
    [`switch_speaker_${run.id}_s0`]: confidentDecision('no_clear_identity'),
    [`switch_speaker_${run.id}_s3`]: confidentDecision('no_clear_identity'),
    [`switch_speaker_${run.id}_s4`]: confidentDecision('no_clear_identity'),
    [`switch_link_${run.id}_s0`]: confidentDecision('previous'),
    [`switch_link_${run.id}_s3`]: confidentDecision('previous'),
    [`switch_link_${run.id}_s4`]: confidentDecision('previous'),
  }
  applySpeakerSwitchContradictionReview(plan, answers, review, results)
  const segments = resolveSpeakerDecisionSegments(text, plan, answers, speakers, { isUserMessage: false, cardSpeakerId: null, historicalSpeakerId: null, evidenceOnly: true })
  assert.deepEqual(segments.filter(segment => segment.speakerId !== null).map(segment => segment.speakerId), [UNCAST_SPEAKER_ID, UNCAST_SPEAKER_ID, 'unconfigured:maeve', UNCAST_SPEAKER_ID, UNCAST_SPEAKER_ID])
  assert.ok(answers.switch_link_reconciled_s3)
  const duplicatePlan = buildSpeakerDecisionPlan(text, speakers, false)
  const duplicateAnswers: Record<string, SpeakerDecisionChoice> = {}
  for (const speech of duplicatePlan.state.speeches) duplicateAnswers[`speech_${speech.id}`] = confidentDecision('known_0')
  duplicateAnswers.turn_s2 = confidentDecision('responds_to_previous_speaker')
  applyExplicitPostQuoteVoiceAttributions(duplicatePlan, duplicateAnswers)
  const duplicateContext = { ...context, ghosts: [{ id: 'same-maeve', label: 'Maeve', aliases: ['Maeve'], context: '', conversationHistory: [{ messageId: 'prior', text: 'Maeve is present.' }] }] }
  const duplicateReview = buildSpeakerSwitchContradictionReview(duplicatePlan, duplicateAnswers, duplicateContext)
  const duplicateResults = { ...results, [`switch_speaker_${run.id}_s1`]: { choice: 'switch_ghost_0', probabilities: { switch_ghost_0: 0.8, known_0: 0.2 }, confidence: 0.77 } }
  applySpeakerSwitchContradictionReview(duplicatePlan, duplicateAnswers, duplicateReview, duplicateResults)
  assert.equal(duplicateAnswers.speech_s1.choice, 'known_0')
})

test('narrative role review separates the smoker from a named reply without assigning bystanders', () => {
  const speakers = [{ id: 'unconfigured:maeve', name: 'Maeve' }, { id: 'unconfigured:erin', name: 'Erin' }, { id: USER_SPEAKER_ID, name: 'Ken' }]
  const text = 'The smoker’s sitting upright in it, blanket pooled at her waist, boots back on and laced.\n\n"Lamp’s out," she says, to nobody in particular. "I didn’t light it. Wanted to see the room dark before I decided anything about it." "Decided what?"\n\nMaeve’s voice comes from the other side of Erin.\n\n"Whether it was a night where I sleep in my boots or a night where I take them off and trust the stair." The smoker’s boot heels come down onto the boards. "I’ve decided. Boots stay." "Suit yourself."'
  const plan = buildSpeakerDecisionPlan(text, speakers, false)
  const answers: Record<string, SpeakerDecisionChoice> = {}
  for (const speech of plan.state.speeches) answers[`speech_${speech.id}`] = confidentDecision('known_0')
  answers.turn_s2 = confidentDecision('responds_to_previous_speaker')
  applyExplicitPostQuoteVoiceAttributions(plan, answers)
  const context = { previousMessages: [{ id: 'prior', role: 'user' as const, text: 'Erin lies beside me.' }], ghosts: [{ id: 'smoker', label: 'the smoker', aliases: ['the smoker'], context: '', conversationHistory: [{ messageId: 'prior', text: 'The smoker is in the room.' }] }] }
  const review = buildSpeakerSwitchContradictionReview(plan, answers, context)
  const role = review.roles.find(item => item.label === 'the smoker')!
  assert.ok(role)
  assert.ok(review.localEvidence.some(item => item.speechId === 's0' && item.cues.some(cue => cue.includes('pronoun speech tag'))))
  assert.ok(review.localEvidence.some(item => item.speechId === 's1' && item.cues.some(cue => cue.includes('follows a pronoun speech tag'))))
  assert.ok(review.localEvidence.some(item => item.speechId === 's3' && item.cues.some(cue => cue.includes('role action immediately follows'))))
  assert.ok(review.localEvidence.some(item => item.speechId === 's4' && item.cues.some(cue => cue.includes('role action immediately precedes'))))
  const results: Record<string, SpeakerDecisionChoice> = { [`${role.id}_distinct`]: confidentDecision('different') }
  for (const id of role.speechIds) if (id !== role.anchorId) results[`${role.id}_speech_${id}`] = confidentDecision(['s0', 's1', 's3', 's4'].includes(id) ? 'role' : 'other_or_unclear')
  applyNarrativeRoleSpeakerReview(plan, answers, review, results)
  const segments = resolveSpeakerDecisionSegments(text, plan, answers, speakers, { isUserMessage: false, cardSpeakerId: null, historicalSpeakerId: null, evidenceOnly: true, includeDebug: true })
  assert.deepEqual(segments.filter(segment => segment.speakerId !== null).map(segment => segment.speakerId), ['ghost:smoker', 'ghost:smoker', 'unconfigured:maeve', 'ghost:smoker', 'ghost:smoker', 'unconfigured:maeve'])
  assert.ok(answers.narrative_role_reconciled_s0)
  const exchangeAnswers: Record<string, SpeakerDecisionChoice> = {}
  for (const speech of plan.state.speeches) exchangeAnswers[`speech_${speech.id}`] = confidentDecision('known_0')
  exchangeAnswers.turn_s2 = confidentDecision('responds_to_previous_speaker')
  applyExplicitPostQuoteVoiceAttributions(plan, exchangeAnswers)
  const exchangeReview = buildSpeakerSwitchContradictionReview(plan, exchangeAnswers, context)
  const exchangeResults: Record<string, SpeakerDecisionChoice> = {
    [`${role.id}_distinct`]: { choice: 'different', probabilities: { different: 0.72, same_or_unclear: 0.28 }, confidence: 0.44 },
    [`${role.id}_exchange`]: confidentDecision('two_speakers'),
  }
  for (const id of role.speechIds) if (id !== role.anchorId) {
    exchangeResults[`${role.id}_speech_${id}`] = { choice: 'other_or_unclear', probabilities: { role: 0.31, other_or_unclear: 0.69 }, confidence: 0.38 }
    exchangeResults[`${role.id}_exchange_${id}`] = confidentDecision(['s0', 's1', 's3', 's4'].includes(id) ? 'role' : 'anchor')
  }
  applyNarrativeExchangeSpeakerReview(plan, exchangeAnswers, exchangeReview, exchangeResults)
  const exchangeSegments = resolveSpeakerDecisionSegments(text, plan, exchangeAnswers, speakers, { isUserMessage: false, cardSpeakerId: null, historicalSpeakerId: null, evidenceOnly: true, includeDebug: true })
  assert.deepEqual(exchangeSegments.filter(segment => segment.speakerId !== null).map(segment => segment.speakerId), ['ghost:smoker', 'ghost:smoker', 'unconfigured:maeve', 'ghost:smoker', 'ghost:smoker', 'unconfigured:maeve'])
  assert.ok(exchangeAnswers.narrative_exchange_reconciled_s3)
  const localAnswers: Record<string, SpeakerDecisionChoice> = {}
  for (const speech of plan.state.speeches) localAnswers[`speech_${speech.id}`] = confidentDecision('known_0')
  localAnswers.turn_s2 = confidentDecision('responds_to_previous_speaker')
  applyExplicitPostQuoteVoiceAttributions(plan, localAnswers)
  const localReview = buildSpeakerSwitchContradictionReview(plan, localAnswers, context)
  const localResults: Record<string, SpeakerDecisionChoice> = { [`${role.id}_distinct`]: { choice: 'different', probabilities: { different: 0.67, same_or_unclear: 0.33 }, confidence: 0.34 } }
  for (const item of localReview.localEvidence) localResults[`${role.id}_local_${item.speechId}`] = confidentDecision('role', 0.75, 0.65)
  applyNarrativeLocalEvidenceReview(plan, localAnswers, localReview, localResults)
  assert.ok(localAnswers.narrative_local_reconciled_s0)
  assert.ok(localAnswers.narrative_local_reconciled_s1)
  assert.ok(localAnswers.narrative_local_reconciled_s3)
  assert.ok(localAnswers.narrative_local_reconciled_s4)
  assert.equal(localAnswers.speech_s2.choice, 'known_0')
  const jointAnswers: Record<string, SpeakerDecisionChoice> = {}
  for (const speech of plan.state.speeches) jointAnswers[`speech_${speech.id}`] = confidentDecision('known_0')
  jointAnswers.turn_s1 = confidentDecision('continues_previous_turn')
  jointAnswers.turn_s2 = confidentDecision('responds_to_previous_speaker')
  jointAnswers.turn_s3 = { choice: 'responds_to_previous_speaker', probabilities: { responds_to_previous_speaker: 0.58, continues_previous_turn: 0.41, responds_to_other_participant: 0.01 }, confidence: 0.44 }
  jointAnswers.turn_s4 = confidentDecision('continues_previous_turn')
  jointAnswers.turn_s5 = confidentDecision('responds_to_previous_speaker')
  applyExplicitPostQuoteVoiceAttributions(plan, jointAnswers)
  const jointReview = buildSpeakerSwitchContradictionReview(plan, jointAnswers, context)
  const jointResults: Record<string, SpeakerDecisionChoice> = { [`${role.id}_distinct`]: { choice: 'different', probabilities: { different: 0.63, same_or_unclear: 0.37 }, confidence: 0.26 } }
  for (const item of jointReview.localEvidence) jointResults[`${role.id}_local_${item.speechId}`] = item.speechId === 's0' || item.speechId === 's1' ? confidentDecision('role', 0.8, 0.62) : confidentDecision('other_or_unclear', 0.75, 0.5)
  const ghostOption = Object.entries(jointReview.ghostOptions).find(([, identity]) => identity === 'ghost:smoker')?.[0]
  assert.ok(ghostOption)
  for (const [id, ghostProbability, namedProbability] of [['s0', 0.88, 0.07], ['s1', 0.86, 0.08], ['s2', 0.08, 0.64], ['s3', 0.35, 0.61], ['s4', 0.57, 0.36], ['s5', 0.12, 0.59]] as const) jointResults[`switch_speaker_${jointReview.runs[0].id}_${id}`] = { choice: ghostProbability > namedProbability ? ghostOption : 'known_0', probabilities: { [ghostOption]: ghostProbability, known_0: namedProbability, no_clear_identity: Math.max(0, 1 - ghostProbability - namedProbability) }, confidence: 0.86 }
  applyContestedDialogueChain(plan, jointAnswers, jointReview, jointResults)
  const jointSegments = resolveSpeakerDecisionSegments(text, plan, jointAnswers, speakers, { isUserMessage: false, cardSpeakerId: null, historicalSpeakerId: null, evidenceOnly: true, includeDebug: true })
  assert.deepEqual(jointSegments.filter(segment => segment.speakerId !== null).map(segment => segment.speakerId), ['ghost:smoker', 'ghost:smoker', 'unconfigured:maeve', 'ghost:smoker', 'ghost:smoker', 'unconfigured:maeve'])
  assert.ok(jointAnswers.joint_chain_detail_s3.choice.includes('scores are heuristic'))
  const rejectedJoint: Record<string, SpeakerDecisionChoice> = { ...jointAnswers, speech_s3: confidentDecision('known_0') }
  const strongOther = { ...jointResults, [`${role.id}_local_s3`]: confidentDecision('other_or_unclear') }
  applyContestedDialogueChain(plan, rejectedJoint, jointReview, strongOther)
  assert.equal(rejectedJoint.speech_s3.choice, 'known_0')
  const noAnchor: Record<string, SpeakerDecisionChoice> = { ...jointAnswers, speech_s3: confidentDecision('known_0') }
  const noTag = { ...jointResults, [`${role.id}_local_s0`]: confidentDecision('other_or_unclear'), [`${role.id}_local_s1`]: confidentDecision('other_or_unclear') }
  applyContestedDialogueChain(plan, noAnchor, jointReview, noTag)
  assert.equal(noAnchor.speech_s3.choice, 'known_0')
  const localRejected: Record<string, SpeakerDecisionChoice> = { ...localAnswers, speech_s3: confidentDecision('known_0') }
  delete localRejected.narrative_role_reconciled_s3
  const listenerResults = { ...localResults, [`${role.id}_local_s3`]: confidentDecision('other_or_unclear') }
  applyNarrativeLocalEvidenceReview(plan, localRejected, localReview, listenerResults)
  assert.equal(localRejected.speech_s3.choice, 'known_0')
  const ambiguousText = text.replace('The smoker’s sitting upright in it, blanket pooled at her waist, boots back on and laced.', 'The smoker’s sitting beside Erin, both women awake.')
  const ambiguousPlan = buildSpeakerDecisionPlan(ambiguousText, speakers, false)
  const ambiguousAnswers: Record<string, SpeakerDecisionChoice> = {}
  for (const speech of ambiguousPlan.state.speeches) ambiguousAnswers[`speech_${speech.id}`] = confidentDecision('known_0')
  ambiguousAnswers.turn_s2 = confidentDecision('responds_to_previous_speaker')
  applyExplicitPostQuoteVoiceAttributions(ambiguousPlan, ambiguousAnswers)
  const ambiguousReview = buildSpeakerSwitchContradictionReview(ambiguousPlan, ambiguousAnswers, context)
  assert.ok(!ambiguousReview.localEvidence.some(item => item.speechId === 's0' && item.cues.some(cue => cue.includes('pronoun speech tag'))))
  const interruptedText = text.replace('The smoker’s boot heels come down onto the boards.', 'The smoker’s boot heels come down onto the boards. Another woman says,')
  const interruptedPlan = buildSpeakerDecisionPlan(interruptedText, speakers, false)
  const interruptedAnswers: Record<string, SpeakerDecisionChoice> = {}
  for (const speech of interruptedPlan.state.speeches) interruptedAnswers[`speech_${speech.id}`] = confidentDecision('known_0')
  interruptedAnswers.turn_s2 = confidentDecision('responds_to_previous_speaker')
  applyExplicitPostQuoteVoiceAttributions(interruptedPlan, interruptedAnswers)
  const interruptedReview = buildSpeakerSwitchContradictionReview(interruptedPlan, interruptedAnswers, context)
  assert.ok(!interruptedReview.localEvidence.some(item => item.speechId === 's4' && item.cues.some(cue => cue.includes('role action immediately precedes'))))
  // Earlier speeches have already been resolved to the smoker, so the first
  // same-identity response contradiction is later than Maeve's attributed line.
  const partiallyResolved: Record<string, SpeakerDecisionChoice> = {}
  plan.optionSpeakerIds.test_smoker = 'ghost:smoker'
  for (const speech of plan.state.speeches) partiallyResolved[`speech_${speech.id}`] = confidentDecision('known_0')
  partiallyResolved.speech_s0 = confidentDecision('test_smoker')
  partiallyResolved.speech_s1 = confidentDecision('test_smoker')
  partiallyResolved.turn_s2 = confidentDecision('responds_to_previous_speaker')
  partiallyResolved.turn_s5 = confidentDecision('responds_to_previous_speaker')
  applyExplicitPostQuoteVoiceAttributions(plan, partiallyResolved)
  const laterReview = buildSpeakerSwitchContradictionReview(plan, partiallyResolved, context)
  assert.equal(laterReview.runs[0].currentId, 's5')
  assert.equal(laterReview.roles[0]?.anchorId, 's2')
  assert.ok(laterReview.questions[`${role.id}_exchange_s3`])
  applyNarrativeExchangeSpeakerReview(plan, partiallyResolved, laterReview, exchangeResults)
  const laterSegments = resolveSpeakerDecisionSegments(text, plan, partiallyResolved, speakers, { isUserMessage: false, cardSpeakerId: null, historicalSpeakerId: null, evidenceOnly: true, includeDebug: true })
  assert.deepEqual(laterSegments.filter(segment => segment.speakerId !== null).map(segment => segment.speakerId), ['ghost:smoker', 'ghost:smoker', 'unconfigured:maeve', 'ghost:smoker', 'ghost:smoker', 'unconfigured:maeve'])
  const interrupted = { ...exchangeResults, [`${role.id}_exchange`]: confidentDecision('other_or_unclear') }
  const unchanged: Record<string, SpeakerDecisionChoice> = { ...exchangeAnswers, speech_s3: confidentDecision('known_0') }
  delete unchanged.narrative_role_reconciled_s3
  applyNarrativeExchangeSpeakerReview(plan, unchanged, exchangeReview, interrupted)
  assert.equal(unchanged.speech_s3.choice, 'known_0')
  const bystander: Record<string, SpeakerDecisionChoice> = {}
  for (const speech of plan.state.speeches) bystander[`speech_${speech.id}`] = confidentDecision('known_0')
  bystander.turn_s2 = confidentDecision('responds_to_previous_speaker')
  applyExplicitPostQuoteVoiceAttributions(plan, bystander)
  const bystanderReview = buildSpeakerSwitchContradictionReview(plan, bystander, context)
  const noRole = Object.fromEntries(Object.entries(results).map(([id, value]) => [id, id.includes('_speech_') ? confidentDecision('other_or_unclear') : value]))
  applyNarrativeRoleSpeakerReview(plan, bystander, bystanderReview, noRole)
  assert.equal(bystander.speech_s0.choice, 'known_0')
  const ambiguous = { ...results, [`${role.id}_distinct`]: confidentDecision('same_or_unclear') }
  applyNarrativeRoleSpeakerReview(plan, bystander, bystanderReview, ambiguous)
  assert.equal(bystander.speech_s0.choice, 'known_0')
  const userOption = plan.state.speakers.find(speaker => speaker.id === USER_SPEAKER_ID)!.option
  bystander.speech_s0 = confidentDecision(userOption)
  bystander.persona_confirmed_s0 = confidentDecision(userOption)
  bystander.self_intro_reconciled_s1 = confidentDecision('known_0')
  applyNarrativeRoleSpeakerReview(plan, bystander, bystanderReview, results)
  assert.equal(bystander.speech_s0.choice, userOption)
  assert.equal(bystander.speech_s1.choice, 'known_0')
})

test('speaker-switch review separates an unnamed respondent from a named speaker without forcing ambiguous switches', () => {
  const speakers = [{ id: 'unconfigured:maeve', name: 'Maeve' }, { id: 'unconfigured:erin', name: 'Erin' }, { id: USER_SPEAKER_ID, name: 'Ken' }]
  const text = 'The smoker sits by the window. "Lamp is out," she says. "I did not light it."\n\n"Decided what?" Maeve asks.\n\n"Whether I sleep in my boots." The smoker puts her boots down. "Boots stay."'
  const plan = buildSpeakerDecisionPlan(text, speakers, false)
  const answers: Record<string, SpeakerDecisionChoice> = {}
  for (const speech of plan.state.speeches) answers[`speech_${speech.id}`] = confidentDecision('known_0')
  answers.speech_s2 = { choice: 'known_0', probabilities: { known_0: 0.28, known_1: 0.26, no_clear_identity: 0.46 }, confidence: 0.2 }
  answers.turn_s2 = confidentDecision('responds_to_previous_speaker')
  answers.global_uncertain_s2 = confidentDecision('no_clear_identity')
  const context = { previousMessages: [{ id: 'prior', role: 'user' as const, text: 'Erin lies beside me.' }], ghosts: [] }
  const review = buildSpeakerSwitchContradictionReview(plan, answers, context)
  assert.equal(review.runs.length, 1)
  const run = review.runs[0]
  assert.equal(run.previousId, 's1')
  assert.equal(run.currentId, 's2')
  assert.ok(review.questions[`switch_speaker_${run.id}_s1`].criteria.uncast_character)
  const results: Record<string, SpeakerDecisionChoice> = { [`switch_${run.id}`]: confidentDecision('different') }
  for (const id of run.speechIds) results[`switch_speaker_${run.id}_${id}`] = confidentDecision(id === 's2' ? 'known_0' : 'uncast_character')
  applySpeakerSwitchContradictionReview(plan, answers, review, results)
  const segments = resolveSpeakerDecisionSegments(text, plan, answers, speakers, { isUserMessage: false, cardSpeakerId: null, historicalSpeakerId: null, evidenceOnly: true, includeDebug: true })
  assert.deepEqual(segments.filter(segment => segment.speakerId !== null).map(segment => segment.speakerId), [UNCAST_SPEAKER_ID, UNCAST_SPEAKER_ID, 'unconfigured:maeve', UNCAST_SPEAKER_ID, UNCAST_SPEAKER_ID])
  const unchanged: Record<string, SpeakerDecisionChoice> = {}
  for (const speech of plan.state.speeches) unchanged[`speech_${speech.id}`] = confidentDecision('known_0')
  unchanged.turn_s2 = confidentDecision('responds_to_previous_speaker')
  const falseAlarm = buildSpeakerSwitchContradictionReview(plan, unchanged, context)
  applySpeakerSwitchContradictionReview(plan, unchanged, falseAlarm, { ...results, [`switch_${run.id}`]: confidentDecision('same_or_unclear') })
  assert.equal(unchanged.speech_s1.choice, 'known_0')
  const weak = { ...results, [`switch_speaker_${run.id}_s1`]: { choice: 'uncast_character', probabilities: { uncast_character: 0.6, known_0: 0.4 }, confidence: 0.5 } }
  applySpeakerSwitchContradictionReview(plan, unchanged, falseAlarm, weak)
  assert.equal(unchanged.speech_s1.choice, 'known_0')
  const sameIdentity = { ...results, [`switch_speaker_${run.id}_s1`]: confidentDecision('known_0') }
  applySpeakerSwitchContradictionReview(plan, unchanged, falseAlarm, sameIdentity)
  assert.equal(unchanged.speech_s1.choice, 'known_0')
  unchanged.turn_s2 = { choice: 'responds_to_previous_speaker', probabilities: { responds_to_previous_speaker: 0.6, continues_previous_turn: 0.4 }, confidence: 0.5 }
  assert.equal(buildSpeakerSwitchContradictionReview(plan, unchanged, context).runs.length, 0)
})

test('cast candidates require independent scene or lookback evidence, not their own prior assignment', () => {
  const speakers = [{ id: 'npc:zara', name: 'Zara Vane / Zara' }, { id: 'npc:ewan', name: 'Ewan' }, { id: USER_SPEAKER_ID, name: 'Ken' }]
  const plan = buildSpeakerDecisionPlan('She smiles. "Dear." She turns. "Come on."', speakers, false)
  const context = { previousMessages: [{ id: 'prior', role: 'user' as const, text: 'I turn toward Ewan.' }], ghosts: [] }
  const answers: Record<string, SpeakerDecisionChoice> = { speech_s0: confidentDecision('known_0'), paragraph_p0: confidentDecision('known_0') }
  suppressUngroundedSpeakerChoices(plan, answers, context)
  assert.ok(answers.global_uncertain_s0)
  assert.equal(answers.speech_s0.choice, 'no_clear_identity')
  assert.equal(answers.ungrounded_original_s0.choice, 'known_0')
  const review = buildRelationshipSpeakerReview(plan, answers, context, null, { cardSpeakerId: null, targets: ['s0'], strategy: 'run' })
  assert.equal(review.questions.relationship_s0.criteria.known_0, undefined)
  assert.ok(review.questions.relationship_s0.criteria.known_1)
  assert.ok(review.questions.relationship_s0.criteria.uncast_character)
  answers.relationship_applied_s0 = confidentDecision('known_0')
  answers.speech_s0 = confidentDecision('known_0')
  const fallback = buildBestAvailableSpeakerReview(plan, answers, context)
  assert.equal(fallback.questions.best_guess_s0.criteria.known_0, undefined)
  assert.ok(fallback.questions.best_guess_s0.criteria.known_1)
  assert.ok(independentlyGroundedSpeakerIds(plan, context, 'npc:zara').has('npc:zara'))
  const soloAnswers: Record<string, SpeakerDecisionChoice> = { speech_s0: confidentDecision('known_0') }
  suppressUngroundedSpeakerChoices(plan, soloAnswers, context, 'npc:zara')
  assert.equal(soloAnswers.speech_s0.choice, 'known_0')
  const namedContext = { previousMessages: [{ id: 'prior', role: 'user' as const, text: 'I turn to Zara.' }], ghosts: [] }
  assert.ok(independentlyGroundedSpeakerIds(plan, namedContext).has('npc:zara'))
  const ghostContext = { previousMessages: [{ id: 'prior', role: 'assistant' as const, text: 'She opens the door.' }], ghosts: [
    { id: 'active', label: '', aliases: [], context: 'She speaks.', conversationHistory: [{ messageId: 'prior', text: 'She opens the door.' }] },
    { id: 'stale', label: 'Maeve', aliases: ['Maeve'], context: '', conversationHistory: [{ messageId: 'older', text: 'Maeve speaks.' }] },
  ] }
  const groundedGhosts = independentlyGroundedSpeakerIds(plan, ghostContext)
  assert.ok(groundedGhosts.has('ghost:active'))
  assert.equal(groundedGhosts.has('ghost:stale'), false)
})

test('verified self-introduction reconciles earlier uncertain identities without crossing scene changes or explicit speakers', () => {
  const speakers = [{ id: 'npc:zara', name: 'Zara' }, { id: 'npc:sarah', name: 'Sarah' }, { id: USER_SPEAKER_ID, name: 'Ken' }]
  const text = '"Dear." She tries the word. "Okay, big caa."\n\nShe walks to the rail. "Come on, then."\n\nA woman in scrubs waits nearby. "Fair is fair." She turns to him. "Maeve. My friend is Erin."'
  const plan = buildSpeakerDecisionPlan(text, speakers, false)
  const answers: Record<string, SpeakerDecisionChoice> = {}
  for (const speech of plan.state.speeches) {
    answers[`speech_${speech.id}`] = confidentDecision('known_0')
    answers[`relationship_original_${speech.id}`] = confidentDecision('uncast_character')
  }
  const context = { previousMessages: [{ id: 'previous', role: 'user' as const, text: 'I follow her outside.' }], ghosts: [] }
  const review = buildSelfIntroductionReview(plan, context)
  const anchor = plan.state.speeches.at(-1)!
  assert.equal(review.candidates[`intro_${anchor.id}`].name, 'Maeve')
  const results: Record<string, SpeakerDecisionChoice> = { [`intro_${anchor.id}`]: confidentDecision('self') }
  for (const id of review.candidates[`intro_${anchor.id}`].targetIds) results[`intro_link_${anchor.id}_${id}`] = confidentDecision('same')
  applySelfIntroductionReview(plan, answers, review, results)
  assert.ok(plan.state.speeches.every(speech => answers[`self_intro_reconciled_${speech.id}`]))
  const segments = resolveSpeakerDecisionSegments(text, plan, answers, speakers, { isUserMessage: false, cardSpeakerId: null, historicalSpeakerId: null, evidenceOnly: true, includeDebug: true })
  assert.ok(segments.filter(segment => segment.speakerId !== null).every(segment => segment.speakerId === 'unconfigured:maeve'))
  const notSelf: Record<string, SpeakerDecisionChoice> = { [`intro_${anchor.id}`]: confidentDecision('other_or_unclear') }
  const unchanged: Record<string, SpeakerDecisionChoice> = { speech_s0: confidentDecision('known_0'), relationship_original_s0: confidentDecision('uncast_character') }
  applySelfIntroductionReview(plan, unchanged, review, notSelf)
  assert.equal(unchanged.speech_s0.choice, 'known_0')
  const mixed = buildSpeakerDecisionPlan('"Hello," Sarah says.\n\n"Maeve. My friend is Erin."', speakers, false)
  const mixedReview = buildSelfIntroductionReview(mixed, context)
  const mixedAnswers: Record<string, SpeakerDecisionChoice> = { speech_s0: confidentDecision('known_1'), relationship_original_s0: confidentDecision('known_1') }
  applySelfIntroductionReview(mixed, mixedAnswers, mixedReview, { intro_s1: confidentDecision('self'), intro_link_s1_s0: confidentDecision('same') })
  assert.equal(mixedAnswers.speech_s0.choice, 'known_1')
  const interrupt = buildSpeakerDecisionPlan('"Hello." A stranger steps in. "Maeve. My friend is Erin."', speakers, false)
  const interruptReview = buildSelfIntroductionReview(interrupt, context)
  const interruptAnswers: Record<string, SpeakerDecisionChoice> = { speech_s0: confidentDecision('uncast_character'), global_uncertain_s0: confidentDecision('no_clear_identity') }
  applySelfIntroductionReview(interrupt, interruptAnswers, interruptReview, { intro_s1: confidentDecision('self'), intro_link_s1_s0: confidentDecision('different_or_unclear') })
  assert.ok(interruptAnswers.global_uncertain_s0)
  assert.equal(interruptAnswers.self_intro_reconciled_s0, undefined)
  const cut = buildSpeakerDecisionPlan('"Hello."\n\nHours later, she arrives.\n\n"Maeve. My friend is Erin."', speakers, false)
  assert.equal(Object.keys(buildSelfIntroductionReview(cut, context).questions).length, 0)
})

test('best-available guesses use scene candidates and never become validated anchors', () => {
  const speakers = [{ id: 'npc:ewan', name: 'Ewan' }, { id: 'npc:absent', name: 'Absent' }, { id: USER_SPEAKER_ID, name: 'Ken' }]
  const plan = buildSpeakerDecisionPlan('"Sacrifice."\n\nHe holds a tray.\n\n"The noodles?"', speakers, false)
  const answers: Record<string, SpeakerDecisionChoice> = { speech_s0: confidentDecision('no_clear_identity'), global_uncertain_s0: confidentDecision('no_clear_identity'), speech_s1: confidentDecision('no_clear_identity'), global_uncertain_s1: confidentDecision('no_clear_identity') }
  const review = buildBestAvailableSpeakerReview(plan, answers, { previousMessages: [{ id: 'prior', role: 'user' as const, text: 'I turn to Ewan. "Sometimes you sacrifice."' }], ghosts: [] })
  assert.ok(review.questions.best_guess_s0.criteria.known_0)
  assert.equal(review.questions.best_guess_s0.criteria.known_1, undefined)
  assert.equal(review.questions.best_guess_s0.criteria.known_2, undefined)
  assert.ok(review.questions.best_guess_s0.criteria.uncast_character)
  applyBestAvailableSpeakerReview(plan, answers, review, { best_guess_s0: { choice: 'known_0', probabilities: { known_0: 0.4, no_clear_identity: 0.3, uncast_character: 0.3 }, confidence: 0.3 } })
  assert.ok(answers.global_uncertain_s0)
  assert.equal(answers.relationship_applied_s0, undefined)
  const segments = resolveSpeakerDecisionSegments(plan.state.message, plan, answers, speakers, { isUserMessage: false, cardSpeakerId: null, historicalSpeakerId: null, evidenceOnly: true, includeDebug: true })
  const speech = segments.filter(segment => segment.speakerId !== null)
  assert.equal(speech[0].speakerId, 'npc:ewan')
  assert.equal(speech[1].speakerId, UNRESOLVED_SPEAKER_ID)
  assert.ok(speech[0].debugPath?.some(step => step.includes('low-confidence guess; not an anchor')))
  assert.equal(buildOpeningBacklinkReview(plan, answers, { previousMessages: [{ id: 'prior', role: 'user', text: 'I turn to Ewan.' }], ghosts: [] }, null), null)
  const uncastAnswers: Record<string, SpeakerDecisionChoice> = { speech_s0: confidentDecision('no_clear_identity'), global_uncertain_s0: confidentDecision('no_clear_identity') }
  applyBestAvailableSpeakerReview(plan, uncastAnswers, review, { best_guess_s0: { choice: 'uncast_character', probabilities: { uncast_character: 0.6, no_clear_identity: 0.4 }, confidence: 0.4 } })
  const uncast = resolveSpeakerDecisionSegments(plan.state.message, plan, uncastAnswers, speakers, { isUserMessage: false, cardSpeakerId: null, historicalSpeakerId: null, evidenceOnly: true })
  assert.equal(uncast.find(segment => segment.speakerId !== null)?.speakerId, UNCAST_SPEAKER_ID)
  const unknownAnswers: Record<string, SpeakerDecisionChoice> = { speech_s0: confidentDecision('no_clear_identity'), global_uncertain_s0: confidentDecision('no_clear_identity') }
  applyBestAvailableSpeakerReview(plan, unknownAnswers, review, { best_guess_s0: { choice: 'no_clear_identity', probabilities: { no_clear_identity: 1 }, confidence: 1 } })
  assert.equal(unknownAnswers.best_guess_s0, undefined)
  applyBestAvailableSpeakerReview(plan, unknownAnswers, review, { best_guess_s0: { choice: 'known_2', probabilities: { known_2: 1 }, confidence: 1 } })
  assert.equal(unknownAnswers.best_guess_s0, undefined)
  const ghostReview = buildBestAvailableSpeakerReview(plan, unknownAnswers, { previousMessages: [{ id: 'prior', role: 'user', text: 'Mira returns to the table.' }], ghosts: [{ id: 'mira', label: 'Mira', aliases: ['Mira'], context: 'Friend at the table', conversationHistory: [] }] })
  assert.equal(ghostReview.options.best_ghost_0, 'ghost:mira')
})

test('focused shadow compares the earlier unnamed reply to a validated later anchor', () => {
  const speakers = [{ id: 'npc:tessa', name: 'Tessa' }, { id: USER_SPEAKER_ID, name: 'Ken' }]
  const plan = buildSpeakerDecisionPlan('"Bishop. Third floor."\n\nShe balances her tray. "It is noisy."\n\n"Tessa. Tessa Doyle." She sits down.', speakers, false)
  const answers: Record<string, SpeakerDecisionChoice> = { speech_s0: confidentDecision('no_clear_identity'), global_uncertain_s0: confidentDecision('no_clear_identity'), speech_s1: confidentDecision('known_0'), relationship_confirmed_s1: confidentDecision('known_0') }
  const review = buildOpeningBacklinkReview(plan, answers, { previousMessages: [{ id: 'prior', role: 'user' as const, text: 'I ask her, "Where do you live?"' }], ghosts: [] }, null)!
  const before = JSON.stringify(answers)
  const shadow = buildContrastiveOpeningLinkReview(review)
  assert.equal(review.links.backlink_s0.identity, 'npc:tessa')
  assert.match(shadow.state.pairEvidence.backlink_s0.between, /balances her tray/u)
  assert.match(shadow.state.message, /Tessa Doyle/u)
  assert.ok(shadow.questions.focused_backlink_s0)
  assert.equal(JSON.stringify(answers), before)
})

test('opening links consider adjacent validated speakers in both directions without forcing continuity', () => {
  const speakers = [{ id: 'npc:ewan', name: 'Ewan' }, { id: USER_SPEAKER_ID, name: 'Ken' }]
  const plan = buildSpeakerDecisionPlan('"Sacrifice."\n\nHe turns with the tray.\n\n"The noodles?"\n\n"No, I know what you meant."', speakers, false)
  const context = { previousMessages: [{ id: 'prior', role: 'user' as const, text: 'I turn to Ewan. "Sometimes you sacrifice."' }], ghosts: [] }
  const make = () => ({ speech_s0: confidentDecision('known_0'), relationship_applied_s0: confidentDecision('known_0'), speech_s1: confidentDecision('no_clear_identity'), global_uncertain_s1: confidentDecision('no_clear_identity'), speech_s2: confidentDecision('known_0'), relationship_applied_s2: confidentDecision('known_0') } as Record<string, SpeakerDecisionChoice>)
  const answers = make()
  const review = buildOpeningBacklinkReview(plan, answers, context, null)!
  assert.equal(review.links.forwardlink_s1.anchorId, 's0')
  assert.equal(review.links.backlink_s1.anchorId, 's2')
  const reviewBefore = JSON.stringify(review)
  const contrastive = buildContrastiveOpeningLinkReview(review)
  assert.deepEqual(Object.keys(contrastive.questions.forwardlink_s1.criteria), ['same', 'different', 'no_clear_identity'])
  assert.match(contrastive.questions.focused_backlink_s1.instructions, /self-introduction/u)
  assert.equal(contrastive.expectedControls.focused_control_introduction, 'same')
  assert.equal(contrastive.expectedControls.focused_control_interruption, 'different')
  assert.equal(contrastive.expectedControls.focused_control_unclear, 'no_clear_identity')
  assert.ok(contrastive.questions.control_continuation)
  assert.ok(contrastive.questions.control_reply)
  assert.ok(contrastive.questions.control_uncertain)
  assert.equal(contrastive.expectedControls.control_reply, 'different')
  assert.equal('expectedControls' in contrastive.state, false)
  assert.equal(JSON.stringify(review), reviewBefore)
  const focusedSame = { choice: 'same', probabilities: { same: 0.68, different: 0.21, no_clear_identity: 0.11 }, confidence: 0.52 }
  const focusedDifferent = { choice: 'different', probabilities: { same: 0.1, different: 0.85, no_clear_identity: 0.05 }, confidence: 0.8 }
  const fallback = make()
  applyFocusedOpeningFallback(plan, fallback, { focused_backlink_s1: focusedSame }, review.links, {})
  assert.equal(fallback.speech_s1.choice, 'known_0')
  assert.equal(fallback.focused_fallback_s1, focusedSame)
  const fallbackSegments = resolveSpeakerDecisionSegments(plan.state.message, plan, fallback, speakers, { isUserMessage: false, cardSpeakerId: null, historicalSpeakerId: null, evidenceOnly: true, includeDebug: true })
  assert.equal(fallbackSegments.filter(segment => segment.speakerId !== null)[1].speakerId, 'npc:ewan')
  const conflicting = make()
  applyFocusedOpeningFallback(plan, conflicting, { focused_backlink_s1: focusedSame, focused_forwardlink_s1: focusedDifferent }, review.links, {})
  assert.ok(conflicting.global_uncertain_s1)
  const weak = make()
  applyFocusedOpeningFallback(plan, weak, { focused_backlink_s1: { ...focusedSame, confidence: 0.3 } }, review.links, {})
  assert.ok(weak.global_uncertain_s1)
  const stale = make()
  stale.speech_s2 = confidentDecision('known_1')
  applyFocusedOpeningFallback(plan, stale, { focused_backlink_s1: focusedSame }, review.links, {})
  assert.ok(stale.global_uncertain_s1)
  const blockedBaseline = make()
  applyFocusedOpeningFallback(plan, blockedBaseline, { focused_backlink_s1: focusedSame }, review.links, { backlink_s1: confidentDecision('different_or_unclear') })
  assert.ok(blockedBaseline.global_uncertain_s1)
  assert.match(review.state.pairEvidence.forwardlink_s1.between, /tray/u)
  assert.match(review.questions.forwardlink_s1.instructions, /earlier quotation s0/u)
  applyOpeningBacklinkReview(plan, answers, { forwardlink_s1: confidentDecision('same'), backlink_s1: { choice: 'different_or_unclear', probabilities: { different_or_unclear: 0.62, same: 0.38 }, confidence: 0.24 } }, review.links)
  assert.equal(answers.speech_s1.choice, 'known_0')
  assert.ok(answers.relationship_forwardlink_s1)
  assert.equal(answers.global_uncertain_s1, undefined)
  const disagreement = make()
  applyOpeningBacklinkReview(plan, disagreement, { forwardlink_s1: confidentDecision('same'), backlink_s1: confidentDecision('different_or_unclear') }, review.links)
  assert.ok(disagreement.global_uncertain_s1)
  const changed = make()
  changed.speech_s0 = confidentDecision('known_1')
  applyOpeningBacklinkReview(plan, changed, { forwardlink_s1: confidentDecision('same') }, review.links)
  assert.ok(changed.global_uncertain_s1)
  const turn = buildSpeakerDecisionPlan('"Sacrifice," Ewan says.\n\n"No," Ken replies.\n\n"Fine," Ewan says.', speakers, false)
  const mixed: Record<string, SpeakerDecisionChoice> = { speech_s0: confidentDecision('known_0'), relationship_applied_s0: confidentDecision('known_0'), speech_s1: confidentDecision('no_clear_identity'), global_uncertain_s1: confidentDecision('no_clear_identity'), speech_s2: confidentDecision('known_0'), relationship_applied_s2: confidentDecision('known_0') }
  assert.equal(buildOpeningBacklinkReview(turn, mixed, context, null), null)
})

test('uncertain global review blocks chain guessing and uses unresolved speech voice, not narration', () => {
  const speakers = [{ id: USER_SPEAKER_ID, name: 'Ken' }, { id: 'npc:ewan', name: 'Ewan' }]
  const content = '"Sacrifice."\n\nHe turns with the tray.\n\n"What are you sacrificing?"'
  const plan = buildSpeakerDecisionPlan(content, speakers, false)
  const answers: Record<string, SpeakerDecisionChoice> = { speech_s0: confidentDecision('known_0'), speech_s1: confidentDecision('no_clear_identity'), turn_s1: confidentDecision('continues_previous_turn') }
  applyRelationshipSpeakerReview(plan, answers, { relationship_s0: confidentDecision('no_clear_identity'), relationship_s1: confidentDecision('no_clear_identity') }, {}, null, null, true)
  const segments = resolveSpeakerDecisionSegments(content, plan, answers, speakers, { isUserMessage: false, cardSpeakerId: null, historicalSpeakerId: null, evidenceOnly: true })
  assert.deepEqual(segments.filter(segment => segment.speakerId !== null).map(segment => segment.speakerId), [UNRESOLVED_SPEAKER_ID, UNRESOLVED_SPEAKER_ID])
  assert.equal(playbackVoiceForSpeaker(UNRESOLVED_SPEAKER_ID, false, {}, 'narrator', 'user'), '')
  assert.deepEqual(collectUncastVoiceGroups(segments), [])
})

test('local parser fallback keeps unresolved quotes distinct from narration', () => {
  const content = 'The curtain moves.\n\n"Who is there?"'
  const segments = markUnresolvedSpeechSegments(parseRosterVoiceSegments(content, null, [], '', null, true))
  assert.equal(segments.find(segment => segment.text === 'The curtain moves.')?.speakerId, null)
  assert.equal(segments.find(segment => segment.text === 'Who is there?')?.speakerId, UNRESOLVED_SPEAKER_ID)
  assert.equal(playbackVoiceForSpeaker(UNRESOLVED_SPEAKER_ID, false, {}, 'narrator', 'user'), '')
})

test('relationship review keeps explicit attributions and rejects weak changes', () => {
  const content = '"Hello," Tessa says. "Someone is calling."'
  const speakers = [{ id: 'npc:tessa', name: 'Tessa' }, { id: USER_SPEAKER_ID, name: 'Ken' }]
  const plan = buildSpeakerDecisionPlan(content, speakers, false)
  const answers = { speech_s0: confidentDecision('known_0'), speech_s1: confidentDecision('uncast_character') }
  const context = { previousMessages: [{ id: 'prior', text: 'Someone called.' }], ghosts: [{ id: 'other', label: '', aliases: [], context: 'A caller speaks.', conversationHistory: [] }] }
  const review = buildRelationshipSpeakerReview(plan, answers, context)
  assert.equal(review.questions.relationship_s0, undefined)
  assert.ok(review.questions.relationship_s1)
  applyRelationshipSpeakerReview(plan, answers, { relationship_s1: { choice: 'relationship_ghost_0', probabilities: { relationship_ghost_0: 0.65, no_clear_identity: 0.35 }, confidence: 0.6 } }, review.ghostOptions)
  assert.equal(answers.speech_s1.choice, 'uncast_character')
})

test('uses a leading temporary speaker for a continuous anonymous scene while preserving card and speaker boundaries', () => {
  const content = 'She lifts her cap. "Ten minutes." She smiles. "I should write it down." She bends forward. "That is the whole story."'
  const speakers = [{ id: 'npc:tova', name: 'Tova' }]
  const context = { previousMessages: [{ id: 'prior', text: 'Tasha holds her cap.' }], ghosts: [{ id: 'tasha', label: 'Tasha', aliases: ['Tasha'], context: 'Tasha speaks.', conversationHistory: [] }] }
  const create = () => {
    const plan = buildSpeakerDecisionPlan(content, speakers, false)
    const answers: Record<string, SpeakerDecisionChoice> = { speech_s0: confidentDecision('known_0', 0.42, 0.35), speech_s1: confidentDecision('known_0', 0.58, 0.53), speech_s2: confidentDecision('known_0', 0.6, 0.55) }
    return { plan, answers, review: buildRelationshipSpeakerReview(plan, answers, context) }
  }
  const scene = { choice: 'relationship_ghost_0', confidence: 0.49, probabilities: { relationship_ghost_0: 0.66, no_clear_identity: 0.33 } }
  const current = create()
  assert.ok(current.review.questions.relationship_scene)
  applyRelationshipSpeakerReview(current.plan, current.answers, { relationship_scene: scene }, current.review.ghostOptions)
  assert.deepEqual(current.plan.state.speeches.map(speech => current.answers[`speech_${speech.id}`].choice), ['relationship_ghost_0', 'relationship_ghost_0', 'relationship_ghost_0'])
  const unique = create()
  applyRelationshipSpeakerReview(unique.plan, unique.answers, { relationship_scene: scene }, unique.review.ghostOptions, 'npc:tova')
  assert.equal(unique.answers.speech_s1.choice, 'known_0')
  const established = create()
  applyRelationshipSpeakerReview(established.plan, established.answers, { relationship_scene: scene }, established.review.ghostOptions, null, 'ghost:tasha')
  assert.equal(established.answers.speech_s1.choice, 'relationship_ghost_0')
  for (const paragraph of established.plan.state.paragraphs) established.answers[`paragraph_${paragraph.id}`] = confidentDecision('known_0')
  const assessment = assessSpeakerDiscourseEscalation(established.plan, established.answers)
  assert.equal(assessment.plan, null)
  const resolved = resolveSpeakerDecisionSegments(content, established.plan, established.answers, speakers, { isUserMessage: false, cardSpeakerId: null, historicalSpeakerId: null, discourse: { assessment, answers: null } })
  assert.deepEqual(resolved.filter(segment => segment.speakerId !== null).map(segment => segment.speakerId), ['ghost:tasha', 'ghost:tasha', 'ghost:tasha'])
  const cardFirst = create()
  applyRelationshipSpeakerReview(cardFirst.plan, cardFirst.answers, { relationship_scene: scene }, cardFirst.review.ghostOptions, 'npc:tova', 'ghost:tasha')
  assert.equal(cardFirst.answers.speech_s1.choice, 'known_0')
  const tied = create()
  applyRelationshipSpeakerReview(tied.plan, tied.answers, { relationship_scene: { ...scene, probabilities: { relationship_ghost_0: 0.52, no_clear_identity: 0.48 } } }, tied.review.ghostOptions)
  assert.equal(tied.answers.speech_s1.choice, 'known_0')
  const changed = create()
  changed.plan.state.turns.push({ speechId: 's1', previousSpeechId: 's0', bridge: '' })
  changed.answers.turn_s1 = confidentDecision('responds_to_previous_speaker')
  applyRelationshipSpeakerReview(changed.plan, changed.answers, { relationship_scene: scene }, changed.review.ghostOptions)
  assert.equal(changed.answers.speech_s1.choice, 'known_0')
})

test('inherits continuity only from the unchanged immediately previous assistant message', () => {
  const messages = [
    { id: 'z', is_user: false, content: 'Tasha speaks.' },
    { id: 'user', is_user: true, content: 'A reply.' },
    { id: 'a', is_user: false, content: 'She continues.' },
    { id: 'b', is_user: false, content: 'She speaks again.' },
  ]
  const records = { z: { contentHash: hashMessageContent('Tasha speaks.'), speakerId: 'ghost:tasha' }, a: { contentHash: hashMessageContent('She continues.'), speakerId: 'ghost:tasha' } }
  assert.equal(previousContinuitySpeaker(messages, 'a', records), 'ghost:tasha')
  assert.equal(previousContinuitySpeaker(messages, 'b', records), 'ghost:tasha')
  assert.equal(previousContinuitySpeaker(messages, 'z', records), null)
  assert.equal(previousContinuitySpeaker(messages, 'b', { ...records, a: { contentHash: 'stale', speakerId: 'ghost:tasha' } }), null)
  assert.equal(previousContinuitySpeaker(messages, 'b', { ...records, a: { contentHash: records.a.contentHash, speakerId: null } }), null)
})

test('recovers existing ghost continuity only when cached dialogue matches the previous message', () => {
  const messages = [{ id: 'old', is_user: false, content: 'She speaks. "Hello there."' }, { id: 'current', is_user: false, content: 'She continues.' }]
  const parsed = { old: { contentHash: 'legacy', segments: [{ text: 'She speaks.', speakerId: null }, { text: 'Hello there.', speakerId: UNCAST_SPEAKER_ID }] } }
  const ghost = { id: 'tasha', speakerId: UNCAST_SPEAKER_ID, voiceId: 'voice', context: '', lastSeenMessageId: 'old', occurrenceKeys: [`old:${hashMessageContent('Hello there.')}`] }
  assert.equal(recoverPreviousGhostContinuity(messages, 'current', parsed, [ghost]), 'ghost:tasha')
  assert.equal(recoverPreviousGhostContinuity(messages, 'current', {}, [ghost]), 'ghost:tasha')
  assert.equal(recoverPreviousGhostContinuity([{ ...messages[0], content: 'She says "Changed."' }, messages[1]], 'current', parsed, [ghost]), null)
  assert.equal(recoverPreviousGhostContinuity(messages, 'current', parsed, [ghost, { ...ghost, id: 'other' }]), null)
  assert.equal(recoverPreviousGhostContinuity(messages, 'old', parsed, [ghost]), null)
})

test('bootstraps from an explicitly named prior temporary character and inherits an ambiguous scene', () => {
  const messages = [{ id: 'earlier', is_user: false, content: 'Tasha takes off her cap. "That is better."' }, { id: 'current', is_user: false, content: 'She smiles. "Keep going."' }]
  const ghost = { id: 'tasha', speakerId: UNCAST_SPEAKER_ID, label: 'Tasha', aliases: ['Tasha'], voiceId: 'voice', context: '', lastSeenMessageId: 'earlier', occurrenceKeys: [] }
  const cast = [{ id: 'npc:tova', name: 'Tova' }]
  assert.equal(previousNamedGhostContinuity(messages, 'current', [ghost], cast), 'ghost:tasha')
  assert.equal(previousNamedGhostContinuity([{ ...messages[0], content: 'Tasha and Tova speak. "Hello."' }, messages[1]], 'current', [ghost], cast), null)
  const plan = buildSpeakerDecisionPlan(messages[1].content, cast, false)
  const answers: Record<string, SpeakerDecisionChoice> = { speech_s0: confidentDecision('known_0') }
  const context = { previousMessages: [{ id: 'earlier', text: messages[0].content }], ghosts: [{ id: 'tasha', label: 'Tasha', aliases: ['Tasha'], context: '', conversationHistory: [] }] }
  const review = buildRelationshipSpeakerReview(plan, answers, context, 'ghost:tasha')
  applyRelationshipSpeakerReview(plan, answers, { relationship_scene: { choice: 'no_clear_identity', confidence: 0.34, probabilities: { relationship_ghost_0: 0.56, no_clear_identity: 0.43 } } }, review.ghostOptions, null, 'ghost:tasha')
  assert.equal(answers.speech_s0.choice, 'relationship_ghost_0')
  const changed = buildSpeakerDecisionPlan('Tova says, "Now it is my turn."', cast, false)
  const changedAnswers: Record<string, SpeakerDecisionChoice> = { speech_s0: confidentDecision('known_0') }
  applyRelationshipSpeakerReview(changed, changedAnswers, {}, review.ghostOptions, null, 'ghost:tasha')
  assert.equal(changedAnswers.speech_s0.choice, 'known_0')
})

test('looks back at most five assistant messages and stops at the nearest clear speaker', () => {
  const ghost = { id: 'tasha', speakerId: UNCAST_SPEAKER_ID, label: 'Tasha', aliases: ['Tasha'], voiceId: 'voice', context: '', lastSeenMessageId: 'named', occurrenceKeys: [] }
  const cast = [{ id: 'npc:tova', name: 'Tova' }]
  const named = { id: 'named', is_user: false, content: 'Tasha smiles. "Hello."' }
  const ambiguous = Array.from({ length: 4 }, (_, index) => ({ id: `amb-${index}`, is_user: false, content: 'She smiles. "Yes."' }))
  const target = { id: 'target', is_user: false, content: 'She speaks. "Again."' }
  const user = { id: 'user', is_user: true, content: 'I listen.' }
  const find = (messages: typeof ambiguous) => lookbackSpeakerContinuity(messages, 'target', {}, {}, [ghost], cast, '', 5)
  assert.equal(find([named, user, ...ambiguous, target]), 'ghost:tasha')
  assert.equal(find([named, ...ambiguous, { ...ambiguous[0], id: 'fifth' }, target]), null)
  assert.equal(lookbackSpeakerContinuity([named, ...ambiguous, { ...ambiguous[0], id: 'fifth' }, target], 'target', {}, {}, [ghost], cast, '', 6), 'ghost:tasha')
  assert.equal(lookbackSpeakerContinuity([named, ...ambiguous, target], 'target', {}, {}, [ghost], cast, '', 2), null)
  assert.equal(find([named, ...ambiguous, { id: 'tova', is_user: false, content: 'Tova says, "Hello."' }, target]), 'npc:tova')
  assert.equal(find([named, ...ambiguous, { id: 'other', is_user: false, content: 'The clerk says, "Hello."' }, target]), CONTINUITY_LOOKBACK_BLOCKED)
  assert.equal(find([named, ...ambiguous, { id: 'mixed', is_user: false, content: 'Tasha and Tova speak. "Hello."' }, target]), CONTINUITY_LOOKBACK_BLOCKED)
})

test('uses saved continuity or the final explicit attribution in a multi-character previous message', () => {
  const cast = [{ id: 'npc:sarah', name: 'Sarah' }, { id: 'npc:zadie', name: 'Zadie' }]
  const prior = { id: 'prior', is_user: false, content: 'Sarah says, "Hello."\n\nZadie says, "Goodbye."' }
  const target = { id: 'target', is_user: false, content: 'She smiles. "Again."' }
  const messages = [prior, target]
  assert.equal(lookbackSpeakerContinuity(messages, 'target', {}, {}, [], cast), 'npc:zadie')
  const records = { prior: { contentHash: hashMessageContent(prior.content), speakerId: 'npc:zadie' } }
  assert.equal(lookbackSpeakerContinuity(messages, 'target', records, {}, [], cast), 'npc:zadie')
})

test('finds the last named speaker after an anonymous interruption and continued dialogue', () => {
  const cast = [{ id: 'npc:sarah', name: 'Sarah' }, { id: 'npc:zadie', name: 'Zadie' }]
  const previous = { id: 'prior', is_user: false, content: 'Sarah says, "Earlier."\n\nA woman walks past. "Whites are going in."\n\nShe keeps walking.\n\nZadie does not blink at the interruption. She pulls her notebook closer.\n\n"Write it down."\n\nHer voice dries at the edges.\n\n"Since you are being thorough."\n\nA pause.\n\n"Do not make me come find you."' }
  const target = { id: 'target', is_user: false, content: 'She smiles. "Every night."' }
  const diagnostics: string[] = []
  assert.equal(lookbackSpeakerContinuity([previous, target], 'target', {}, {}, [], cast, '', 5, diagnostics), 'npc:zadie')
  assert.ok(diagnostics.some(line => line.includes('closing named subject -> npc:zadie')))
  const ghost = { id: 'zadie', speakerId: UNCAST_SPEAKER_ID, label: 'Zadie', aliases: ['Zadie'], voiceId: 'voice', context: '', lastSeenMessageId: 'prior', occurrenceKeys: [] }
  assert.equal(lookbackSpeakerContinuity([previous, target], 'target', {}, {}, [ghost], [cast[0]]), 'ghost:zadie')
  const interruptedAgain = { ...previous, content: previous.content + '\n\nThe clerk says, "Wait."' }
  assert.notEqual(lookbackSpeakerContinuity([interruptedAgain, target], 'target', {}, {}, [], cast), 'npc:zadie')
})

test('keeps a historically seen temporary speaker eligible after later playback without leaking future-only ghosts', () => {
  const messages = [
    { id: 'first', is_user: false, content: 'Tasha smiles. "Hello."' },
    { id: 'current', is_user: false, content: 'She smiles. "Again."' },
    { id: 'future', is_user: false, content: 'Tasha returns. "Later."' },
  ]
  const ghost = { id: 'tasha', speakerId: UNCAST_SPEAKER_ID, label: 'Tasha', aliases: ['Tasha'], voiceId: 'voice', context: '', lastSeenMessageId: 'future', occurrenceKeys: [`first:${hashMessageContent('Hello.')}`, `future:${hashMessageContent('Later.')}`] }
  const ids = messages.map(message => message.id)
  const active = activeGhostVoices([ghost], ids, 'current', 5)
  assert.equal(active.length, 1)
  const trace: string[] = []
  assert.equal(lookbackSpeakerContinuity(messages, 'current', {}, {}, active, [], '', 5, trace), 'ghost:tasha')
  assert.ok(trace.some(line => line.includes('earlierOccurrence=true')))
  const futureOnly = { ...ghost, occurrenceKeys: [`future:${hashMessageContent('Later.')}`] }
  assert.equal(activeGhostVoices([futureOnly], ids, 'current', 5).length, 0)
  assert.notEqual(lookbackSpeakerContinuity(messages, 'current', {}, {}, [futureOnly], [], '', 5), 'ghost:tasha')
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
  assert.equal(config.userVoice, '')
  assert.equal(config.useGlobalNarratorVoice, false)
  assert.equal(config.useGlobalUserVoice, true)
  assert.equal(config.characterVoices.alice, 'alice-voice')
})

test('persists the dedicated user voice in extension metadata', () => {
  const metadata = applyConfigToMetadata({}, {
    version: 7,
    messageLimit: 20,
    connectionId: 'shared',
    narratorVoice: 'narrator',
    userVoice: 'persona-voice',
    useGlobalNarratorVoice: false,
    useGlobalUserVoice: false,
    characterVoices: {},
    detectedCharacters: [],
    managedCharacterIds: [],
    parsedMessages: {},
  })
  const restored = readConfig(metadata, [])
  assert.equal(restored.userVoice, 'persona-voice')
  assert.equal(restored.useGlobalNarratorVoice, false)
  assert.equal(restored.useGlobalUserVoice, false)
})

test('routes explicitly attributed user-persona dialogue to the dedicated speaker role', () => {
  assert.deepEqual(
    parseRosterVoiceSegments(
      'Ken says, "I can handle it."',
      null,
      [{ id: USER_SPEAKER_ID, name: 'Ken / Kenneth' }],
    ).filter(segment => segment.speakerId !== null),
    [{ text: 'I can handle it.', speakerId: USER_SPEAKER_ID }],
  )
})

test('uses the user role as the default speaker for unattributed user dialogue', () => {
  assert.deepEqual(
    parseRosterVoiceSegments(
      '"I can handle it."',
      USER_SPEAKER_ID,
      [{ id: USER_SPEAKER_ID, name: 'Ken' }],
    ).filter(segment => segment.speakerId !== null),
    [{ text: 'I can handle it.', speakerId: USER_SPEAKER_ID }],
  )
})

test('exposes the dedicated user speaker for both message roles', () => {
  const cast = [{ id: 'card', name: 'Card Character' }]

  assert.deepEqual(speakersForMessageRole(cast, false, 'Ken'), [
    ...cast,
    { id: USER_SPEAKER_ID, name: 'Ken' },
  ])
  assert.deepEqual(speakersForMessageRole(cast, true, 'Ken'), [
    ...cast,
    { id: USER_SPEAKER_ID, name: 'Ken' },
  ])
})

test('uses the user voice for the user persona and the connection default for unset NPCs', () => {
  const voices = { configured: 'character-voice', unset: '' }

  assert.equal(playbackVoiceForSpeaker('configured', false, voices, 'narrator', 'user-voice'), 'character-voice')
  assert.equal(playbackVoiceForSpeaker('unset', false, voices, 'narrator', 'user-voice'), '')
  assert.equal(playbackVoiceForSpeaker(USER_SPEAKER_ID, false, voices, 'narrator', 'user-voice'), 'user-voice')
  assert.equal(playbackVoiceForSpeaker(USER_SPEAKER_ID, true, voices, 'narrator', 'user-voice'), 'user-voice')
  assert.equal(playbackVoiceForSpeaker(null, false, voices, 'narrator', 'user-voice'), 'narrator')
})

test('Jev can assign an assistant-message exchange to the user without claiming uncast dialogue', () => {
  const content = [
    'Mira catches her breath. "Mmh."',
    'He waits. "How is it, my love?"',
    'Her answer is small and honest: "It is a lot."',
    'The clerk says, "Next."',
  ].join('\n\n')
  const speakers = speakersForMessageRole([{ id: 'mira', name: 'Mira' }], false, 'Ken')
  const plan = buildSpeakerDecisionPlan(content, speakers, false)
  const mira = decisionOption(plan, 'mira')
  const user = decisionOption(plan, USER_SPEAKER_ID)
  assert.match(plan.questions.speech_s1.criteria[user], /user persona/u)
  const resolved = resolveSpeakerDecisionSegments(content, plan, {
    speech_s0: confidentDecision(mira),
    speech_s1: confidentDecision(user),
    speech_s2: confidentDecision(mira),
    speech_s3: confidentDecision(DECISION_UNCAST_CRITERION),
  }, speakers, { isUserMessage: false, cardSpeakerId: 'mira', historicalSpeakerId: null })
  assert.equal(resolved.find(segment => segment.text === 'How is it, my love?')?.speakerId, USER_SPEAKER_ID)
  assert.equal(resolved.find(segment => segment.text === 'Next.')?.speakerId, UNCAST_SPEAKER_ID)
  assert.equal(playbackVoiceForSpeaker(USER_SPEAKER_ID, false, {}, 'narrator', 'user-voice'), 'user-voice')
  assert.equal(playbackVoiceForSpeaker(UNCAST_SPEAKER_ID, false, {}, 'narrator', 'user-voice'), '')
  assert.equal(playbackVoiceForSpeaker(null, false, {}, 'narrator', 'user-voice'), 'narrator')
})

test('assistant speech explicitly attributed to the user uses the user identity', () => {
  const speakers = speakersForMessageRole([{ id: 'mira', name: 'Mira' }], false, 'Ken')
  const segments = parseRosterVoiceSegments('Ken says, "Hello."', null, speakers)
  assert.equal(segments.find(segment => segment.text === 'Hello.')?.speakerId, USER_SPEAKER_ID)
})

test('adding a user candidate does not make them the fallback for nameless assistant dialogue', () => {
  const speakers = speakersForMessageRole([{ id: 'mira', name: 'Mira' }], false, 'Ken')
  const content = 'She looks up. "Hello."'
  const plan = buildSpeakerDecisionPlan(content, speakers, false)
  const result = resolveSpeakerDecisionSegments(content, plan, {}, speakers, {
    isUserMessage: false, cardSpeakerId: 'mira', historicalSpeakerId: null,
  })
  assert.equal(result.find(segment => segment.text === 'Hello.')?.speakerId, 'mira')
})

test('routes clear unconfigured dialogue subjects through connection-default voices', () => {
  const content = [
    'Tobben watches as Willum comes out with the board.',
    '',
    'Willum sets it on the rail.',
    '',
    '"I heard your rider too. Told you I sleep light."',
    '',
    'Tobben drew the last nail and set the foot down.',
    '',
    '"There is a horse made for the road," Tobben said.',
  ].join('\n')
  const speakers = addUnconfiguredDialogueSpeakers(content, [{ id: 'card', name: 'Main Character' }])
  const segments = parseRosterVoiceSegments(content, 'card', speakers)
    .filter(segment => segment.speakerId !== null)

  assert.deepEqual(segments, [
    { text: 'I heard your rider too. Told you I sleep light.', speakerId: 'unconfigured:willum' },
    { text: 'There is a horse made for the road,', speakerId: 'unconfigured:tobben' },
  ])
  assert.equal(playbackVoiceForSpeaker(segments[0].speakerId, false, {}, '', 'user-voice'), '')
  assert.equal(playbackVoiceForSpeaker(segments[1].speakerId, false, {}, '', 'user-voice'), '')
})

test('excludes skipped tracker identities from speaker discovery and Jev context', () => {
  const content = [
    'She opens her sketchbook.',
    '“The eyes are wrong.”',
    '<sola_hud digest="morning"><thought_engine>',
    'Sola says, “What is your goal?”',
    'Sola says, “How do you feel?”',
    '</thought_engine></sola_hud>',
    '<chatterbox><sola_text>Sola says, “Another thought.”</sola_text></chatterbox>',
  ].join('\n\n')
  const configured = [{ id: 'jayden', name: 'Jayden Flynn / Jayden' }]
  const skipped = 'sola_hud, chatterbox'
  const speakers = addUnconfiguredDialogueSpeakers(content, configured, skipped)
  const plan = buildSpeakerDecisionPlan(content, speakers, false, skipped)

  assert.deepEqual(speakers, configured)
  assert.equal(eligibleCardFallbackSpeakerId(content, 'jayden', speakers, skipped), 'jayden')
  assert.deepEqual(plan.state.speakers.map(speaker => speaker.id), ['jayden'])
  assert.equal(plan.state.speeches.length, 1)
  assert.doesNotMatch(JSON.stringify(plan.state), /Sola|goal|Another thought/u)
  assert.deepEqual(
    parseRosterVoiceSegments(content, 'jayden', speakers, skipped)
      .filter(segment => segment.speakerId !== null)
      .map(segment => segment.speakerId),
    ['jayden'],
  )
  assert.ok(addUnconfiguredDialogueSpeakers(content, configured).some(speaker => speaker.name === 'Sola'))
})

test('does not mistake capitalized narrative words for unconfigured speakers', () => {
  const content = [
    'Across the room, she closes the window.',
    '',
    '"The first thought."',
    '',
    'Silence settles over the table.',
    '',
    '"The second thought."',
  ].join('\n')

  assert.deepEqual(
    addUnconfiguredDialogueSpeakers(content, [{ id: 'card', name: 'Mara' }]),
    [{ id: 'card', name: 'Mara' }],
  )
})

test('does not mistake repeated sentence-leading prepositions between quotes for speakers', () => {
  const content = [
    'Then she got up and crossed to the kitchenette.',
    '',
    '"Okay." To the kitchen. To the succulent. To the room. "He\'s coming back. With groceries. And you\'re going to stand here and wait."',
  ].join('\n')
  const speakers = addUnconfiguredDialogueSpeakers(content, [{ id: 'mira', name: 'Mira' }])

  assert.equal(speakers.some(speaker => speaker.id === unconfiguredSpeakerId('To')), false)
  assert.equal(hasNamedSpeakerSubject(content, speakers), false)
  assert.deepEqual(
    parseRosterVoiceSegments(content, 'mira', speakers)
      .filter(segment => segment.speakerId !== null)
      .map(segment => segment.speakerId),
    ['mira', 'mira'],
  )
})

test('rejects common prepositional paragraph leads as inferred character names', () => {
  const prepositions = ['Across', 'Behind', 'From', 'Inside', 'Near', 'Through', 'Under', 'With']

  for (const preposition of prepositions) {
    const content = [
      `${preposition} the room, she waits.`,
      '',
      '"The first thought."',
      '',
      `${preposition} the hall, she listens.`,
      '',
      '"The second thought."',
    ].join('\n')
    const speakers = addUnconfiguredDialogueSpeakers(content, [{ id: 'mira', name: 'Mira' }])
    assert.equal(
      speakers.some(speaker => speaker.id === unconfiguredSpeakerId(preposition)),
      false,
      `${preposition} must not become a speaker`,
    )
  }
})

test('does not treat a configured name after a preposition as a speaker without attribution', () => {
  const speakers = [
    { id: 'mira', name: 'Mira' },
    { id: 'tess', name: 'Tess' },
  ]

  assert.equal(hasNamedSpeakerSubject('She turns to Tess. "I am ready."', speakers), false)
  assert.equal(
    parseRosterVoiceSegments('From beside the door, Mira says, "I am ready."', null, speakers)
      .find(segment => segment.text === 'I am ready.')?.speakerId,
    'mira',
  )
})

test('distinguishes name-free messages from messages that contain a speaker name', () => {
  const speakers = [{ id: 'card', name: 'Mara Vale / Mara' }]
  const nameless = 'She sets down the mug.\n\n"Especially ragged."\n\nHer hands stay on the table.'

  assert.equal(hasNamedSpeakerMention(nameless, speakers), false)
  assert.equal(hasNamedSpeakerMention('Mara sets down the mug.\n\n"Especially ragged."', speakers), true)
  assert.equal(hasNamedSpeakerMention('She says, "Tell Mara I am ready."', speakers), true)
})

test('distinguishes named subjects from objects, addressees, and skipped trackers', () => {
  const speakers = [{ id: 'jayden', name: 'Jayden Flynn / Jayden' }]

  assert.equal(hasNamedSpeakerSubject('Jayden sets down her mug. "I am ready."', speakers), true)
  assert.equal(hasNamedSpeakerSubject('He looks toward Jayden. "Tell Jayden I am ready."', speakers), false)
  assert.equal(
    hasNamedSpeakerSubject(
      '<tracker>Jayden waits outside.</tracker>\n\nShe sets down her mug. "I am ready."',
      speakers,
      'tracker',
    ),
    false,
  )
})

test('routes subjectless assistant dialogue through a unique card-title NPC alias', () => {
  const speakers = [{ id: 'npc:jayden-flynn', name: 'Jayden Flynn / Jayden' }]
  const defaultSpeakerId = speakerIdMatchingCardTitle('Jayden', speakers)
  const speech = parseRosterVoiceSegments(
    'She sets down her mug.\n\n"You imagined feeding me."',
    defaultSpeakerId,
    speakers,
  ).filter(segment => segment.speakerId !== null)

  assert.equal(defaultSpeakerId, 'npc:jayden-flynn')
  assert.deepEqual(speech, [{ text: 'You imagined feeding me.', speakerId: 'npc:jayden-flynn' }])
})

test('uses a card-title fallback only when no other cast identity is established', () => {
  const speakers = [
    { id: 'naomi', name: 'Naomi Lin / Naomi' },
    { id: 'ruby', name: 'Ruby' },
  ]

  assert.equal(
    eligibleCardFallbackSpeakerId('She waits. "Still here."', 'naomi', speakers),
    'naomi',
  )
  assert.equal(
    eligibleCardFallbackSpeakerId('Ruby closes the door. "Still here."', 'naomi', speakers),
    null,
  )
})

test('treats definite human descriptors as card-friendly but indefinite ones as anonymous', () => {
  const speakers = [{ id: 'naomi', name: 'Naomi Lin / Naomi' }]
  assert.equal(
    eligibleCardFallbackSpeakerId('The woman waits. "Still here."', 'naomi', speakers),
    'naomi',
  )
  assert.equal(
    eligibleCardFallbackSpeakerId('An older woman waits. "Still here."', 'naomi', speakers),
    null,
  )
  assert.equal(
    eligibleCardFallbackSpeakerId('The clerk waits. "Still here."', 'naomi', speakers),
    null,
  )
  assert.equal(
    eligibleCardFallbackSpeakerId(
      'She steps back and waits, chin up, feet planted like a person who has decided. "Still here."',
      'naomi',
      speakers,
    ),
    'naomi',
  )
})

test('disables a card-title fallback for mid-paragraph anonymous and aside-attributed identities', () => {
  const content = [
    'The guy from the end of the hall was talking to the person attached to the phone: a broad kid with a grocery bag.',
    '"No, the reading was fine."',
    '',
    'Dev, apparently, said something out of frame.',
    '',
    '"Yeah, he has got the face."',
  ].join('\n')
  const speakers = addUnconfiguredDialogueSpeakers(
    content,
    [{ id: 'naomi', name: 'Naomi Lin / Naomi' }],
  )

  assert.equal(eligibleCardFallbackSpeakerId(content, 'naomi', speakers), null)
  assert.ok(speakers.some(speaker => speaker.name === 'Dev'))
  const speech = parseRosterVoiceSegments(content, null, speakers)
    .filter(segment => segment.text === 'No, the reading was fine.' || segment.text === 'Yeah, he has got the face.')
  assert.ok(speech.every(segment => segment.speakerId !== 'naomi'))
  assert.ok(speech.every(segment => (
    playbackVoiceForSpeaker(segment.speakerId, false, { naomi: 'naomi-voice' }, '', '') === ''
  )))
})

test('routes dialogue anchored to an anonymous local character through the connection default', () => {
  const content = [
    'The phone buzzed.',
    '',
    '"Hi. It\'s me. I know you know it\'s me because caller ID."',
    '',
    'Near the bacon, an older woman in a quilted jacket reached past and pulled the thick-cut without looking.',
    '',
    '"Go with the thick-cut. The thin stuff disappears in the pan."',
    '',
    'She was gone before the sentence finished landing.',
    '',
    'The phone buzzed again.',
    '',
    '"The eggs are still on the counter."',
  ].join('\n')
  const speakers = [{ id: 'mira', name: 'Mira' }]
  const speech = parseRosterVoiceSegments(content, 'mira', speakers)
    .filter(segment => segment.speakerId !== null)

  assert.deepEqual(speech, [
    { text: "Hi. It's me. I know you know it's me because caller ID.", speakerId: 'mira' },
    { text: 'Go with the thick-cut. The thin stuff disappears in the pan.', speakerId: UNCAST_SPEAKER_ID },
    { text: 'The eggs are still on the counter.', speakerId: 'mira' },
  ])
  assert.equal(playbackVoiceForSpeaker(UNCAST_SPEAKER_ID, false, { mira: 'mira-voice' }, '', ''), '')
})

test('disables the card fallback across a message containing a definite anonymous role', () => {
  const content = [
    '"You\'re the piano guy." The clerk — older, reading glasses on a chain, sorting envelopes without looking up — said it to fill the space. "No wait. You\'re the one who never gets packages."',
    '',
    'She pulled a stack of flyers from the box and set it on the counter. "Campus things. Meetings. Somebody\'s garage band."',
    '',
    'The clerk had gone back to her sorting. "Anything else today, piano guy?"',
    '',
    '"No. That\'s everything."',
  ].join('\n')
  const speakers = [{ id: 'naomi', name: 'Naomi Lin / Naomi' }]
  const defaultSpeakerId = eligibleCardFallbackSpeakerId(content, 'naomi', speakers)
  const segments = parseRosterVoiceSegments(
    content,
    defaultSpeakerId,
    speakers,
    '',
    'naomi',
    true,
  ).filter(segment => [
    "You're the piano guy.",
    "No wait. You're the one who never gets packages.",
    "Campus things. Meetings. Somebody's garage band.",
    'Anything else today, piano guy?',
    "No. That's everything.",
  ].includes(segment.text))

  assert.equal(defaultSpeakerId, null)
  assert.deepEqual(segments.map(segment => segment.speakerId), [
    UNCAST_SPEAKER_ID,
    UNCAST_SPEAKER_ID,
    UNCAST_SPEAKER_ID,
    UNCAST_SPEAKER_ID,
    null,
  ])
  assert.ok(segments[0].debugPath?.includes(`anonymous-downstream-attribution:${UNCAST_SPEAKER_ID}`))
  assert.ok(segments[2].debugPath?.includes(`anonymous-pronoun-continuation:${UNCAST_SPEAKER_ID}`))
  assert.ok(segments[3].debugPath?.includes(`anonymous-local-subject:${UNCAST_SPEAKER_ID}`))
})

test('preserves the user role when reviewed unnamed user dialogue selects an NPC', () => {
  const local = parseRosterVoiceSegments(
    'I set down the mug.\n\n"This is mine."',
    USER_SPEAKER_ID,
    [{ id: USER_SPEAKER_ID, name: 'Ken' }],
  )
  const reviewed = local.map(segment => (
    segment.speakerId === USER_SPEAKER_ID
      ? { ...segment, speakerId: 'npc:jayden-flynn' }
      : segment
  ))

  assert.deepEqual(
    protectDefaultSpeakerSegments(local, reviewed, USER_SPEAKER_ID),
    local,
  )
})

test('matches a name-free message only to a configured name contained in its card title', () => {
  const speakers = [
    { id: 'ruby', name: 'Ruby Vale / Ruby' },
    { id: 'grace', name: 'Grace' },
  ]

  assert.equal(speakerIdMatchingCardTitle('Ruby Vale - The Long Reset', speakers), 'ruby')
  assert.equal(speakerIdMatchingCardTitle('The Long Reset', speakers), null)
  assert.equal(speakerIdMatchingCardTitle('Ruby and Grace at the Long Reset', speakers), null)
})

test('never persists generated audio for user messages', () => {
  assert.equal(shouldPersistMessageAudio(true, false, false), false)
  assert.equal(shouldPersistMessageAudio(true, true, false), false)
  assert.equal(shouldPersistMessageAudio(true, false, true), false)
  assert.equal(shouldPersistMessageAudio(true, true, true), false)
  assert.equal(shouldPersistMessageAudio(false, false, false), false)
  assert.equal(shouldPersistMessageAudio(false, true, false), true)
  assert.equal(shouldPersistMessageAudio(false, false, true), true)
})

test('keeps user-message narration separate from defaulted user dialogue', () => {
  const segments = parseRosterVoiceSegments(
    'The door opens.\n\n"I can handle it."',
    USER_SPEAKER_ID,
    [{ id: USER_SPEAKER_ID, name: 'Ken' }],
  )
  assert.ok(segments.some(segment => segment.speakerId === null && segment.text.includes('The door opens.')))
  assert.ok(segments.some(segment => (
    segment.speakerId === USER_SPEAKER_ID && segment.text === 'I can handle it.'
  )))
})

test('writes native overrides while preserving unrelated character voices', () => {
  const config: ChatVoiceConfig = {
    version: 7,
    messageLimit: 20,
    connectionId: 'shared',
    narratorVoice: 'narrator',
    userVoice: '',
    useGlobalNarratorVoice: false,
    useGlobalUserVoice: true,
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
    version: 7,
    messageLimit: 35,
    connectionId: '',
    narratorVoice: '',
    userVoice: '',
    useGlobalNarratorVoice: true,
    useGlobalUserVoice: true,
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

test('restores cached Gemini 3.8 event metadata without leading emotions', () => {
  const metadata = applyConfigToMetadata({}, {
    version: 7,
    messageLimit: 20,
    connectionId: '',
    narratorVoice: '',
    userVoice: '',
    useGlobalNarratorVoice: true,
    useGlobalUserVoice: true,
    characterVoices: {},
    detectedCharacters: [],
    managedCharacterIds: [],
    parsedMessages: {
      message1: {
        contentHash: hashMessageContent('Alice said, "Wait."'),
        segments: [{
          text: 'Wait.',
          speakerId: npcSpeakerId('Alice'),
          ttsText: 'Wait. <gasp>',
          ttsTag: {
            id: 's0',
            emotions: [],
            styles: [],
            sounds: ['gasp'],
            pauses: [],
            source: 'jev',
            baseText: 'Wait.',
          },
        }],
      },
    },
  })
  const restored = readConfig(metadata, ['alice'])
  assert.equal(restored.parsedMessages.message1.segments[0].ttsText, 'Wait. <gasp>')
  assert.deepEqual(restored.parsedMessages.message1.segments[0].ttsTag, {
    id: 's0',
    emotions: [],
    styles: [],
    sounds: ['gasp'],
    pauses: [],
    source: 'jev',
    baseText: 'Wait.',
  })
})

test('restores cached Fish modulation metadata', () => {
  const metadata = applyConfigToMetadata({}, {
    version: 7,
    messageLimit: 20,
    connectionId: '',
    narratorVoice: '',
    userVoice: '',
    useGlobalNarratorVoice: true,
    useGlobalUserVoice: true,
    characterVoices: {},
    detectedCharacters: [],
    managedCharacterIds: [],
    parsedMessages: {
      message1: {
        contentHash: hashMessageContent('Alice said, "Wait. You heard that."'),
        segments: [{
          text: 'Wait. You heard that.',
          speakerId: npcSpeakerId('Alice'),
          ttsText: '[moved] [whispering] Wait. [desperate] [whispering] You heard that.',
          ttsTag: {
            id: 's0',
            emotions: ['moved'],
            styles: ['whispering'],
            sounds: [],
            pauses: [],
            source: 'jev',
            baseText: `[moved] [whispering] Wait. ${TTS_MODULATION_MARKER} You heard that.`,
            modulation: true,
            modulationPoint: 'm1',
            modulationCharIndex: 16,
          },
        }],
      },
    },
  })
  const restored = readConfig(metadata, ['alice'])
  const restoredTag = restored.parsedMessages.message1.segments[0].ttsTag
  assert.equal(restoredTag?.modulation, true)
  assert.equal(restoredTag?.modulationPoint, 'm1')
  assert.equal(restoredTag?.modulationCharIndex, 16)
  assert.ok(restoredTag?.baseText?.includes(TTS_MODULATION_MARKER))
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

test('does not let an ambiguous LLM null erase a deterministic speaker', () => {
  const content = 'Grace watches the door.\n\n"Who is there?"'
  const speakers = [{ id: 'grace', name: 'Grace' }]
  assert.deepEqual(
    parseRosterVoiceSegmentsWithAssignments(
      content,
      null,
      speakers,
      [{ quote: 0, speakerId: null }],
      '',
      null,
      true,
    ).at(-1),
    { text: 'Who is there?', speakerId: 'grace' },
  )
})

test('requests LLM review only for final low-confidence quote assignments', () => {
  const speakers = [{ id: 'grace', name: 'Grace' }, { id: 'katie', name: 'Katie' }]
  assert.equal(needsLlmSpeakerReview('Grace said, "Clearly attributed."', 'grace', speakers), false)
  assert.equal(needsLlmSpeakerReview('Grace watched the door.\n\n"Who is there?"', 'grace', speakers), false)
  assert.equal(needsLlmSpeakerReview('"Who is there?"', null, speakers), true)
  assert.deepEqual(
    speakerReviewQuoteIndexes(
      'Grace said, "First."\n\nGrace watches the door.\n\n"Second."\n\n"Third."',
      null,
      speakers,
    ),
    [2],
  )
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

test('world and RPG titles are not automatically added as speakers', () => {
  assert.equal(isScenarioCardTitle('Free Use World / Free'), true)
  assert.equal(isScenarioCardTitle('Alice Mercer / Alice'), false)
  assert.deepEqual(mergeScannedCardCast([{ id: 'world', name: 'Free Use World' }], [{ cardId: 'world', name: 'Halloran' }]), [{ id: 'npc:halloran', name: 'Halloran' }])
  assert.deepEqual(mergeScannedCardCast([{ id: 'world', name: 'Free Use World' }], []), [])
})

test('keeps the established speaker when a visitor enters before an uncast closing line', () => {
  const plan = buildSpeakerDecisionPlan('"Keep that."\n\n"Hold the door."\n\nThe student moves into the office.\n\n"Sit. Name and ID."', [{ id: 'unconfigured:halloran', name: 'Halloran' }], false)
  const answers: Record<string, SpeakerDecisionChoice> = { speech_s0: confidentDecision('known_0'), speech_s1: confidentDecision('known_0'), speech_s2: confidentDecision('uncast_character') }
  continueUncastClosingSpeech(plan, answers)
  assert.equal(answers.speech_s2.choice, 'known_0')
  const different = buildSpeakerDecisionPlan('"Keep that."\n\n"Hold the door."\n\nThe clerk walks in and says, "Sit. Name and ID."', [{ id: 'unconfigured:halloran', name: 'Halloran' }], false)
  const differentAnswers: Record<string, SpeakerDecisionChoice> = { speech_s0: confidentDecision('known_0'), speech_s1: confidentDecision('known_0'), speech_s2: confidentDecision('uncast_character') }
  continueUncastClosingSpeech(different, differentAnswers)
  assert.equal(differentAnswers.speech_s2.choice, 'uncast_character')
  const unresolved: Record<string, SpeakerDecisionChoice> = { speech_s0: confidentDecision('known_0'), speech_s1: confidentDecision('known_0'), speech_s2: { choice: 'known_0', confidence: 0.45, probabilities: { known_0: 0.51, uncast_character: 0.27, no_clear_identity: 0.22 } } }
  continueUncastClosingSpeech(plan, unresolved)
  assert.equal(unresolved.speech_s2.choice, 'known_0')
  assert.ok(unresolved.relationship_continuity_s2)
})

test('maps a safe ghost alias to its unique roster identity for relationship and discourse review', () => {
  const context = { previousMessages: [{ id: 'previous', text: 'Halloran speaks.' }], ghosts: [{ id: 'halloran', label: 'Halloran', aliases: ['Halloran'], context: '', conversationHistory: [] }] }
  const speakers = [{ id: 'npc:sarah', name: 'Sarah' }, { id: 'unconfigured:halloran', name: 'Halloran' }]
  const continuity = continuityRosterIdentity('ghost:halloran', context, speakers)
  assert.equal(continuity, 'unconfigured:halloran')
  assert.equal(continuityRosterIdentity('ghost:halloran', context, [...speakers, { id: 'npc:halloran', name: 'Halloran' }]), 'ghost:halloran')
  const plan = buildSpeakerDecisionPlan('"Does he know?"\n\nHer eyes come up.\n\n"Because he will."\n\n"Next."', speakers, false)
  const answers: Record<string, SpeakerDecisionChoice> = { speech_s0: confidentDecision('known_1'), speech_s1: confidentDecision('known_0'), speech_s2: confidentDecision('known_1') }
  const review = buildRelationshipSpeakerReview(plan, answers, context, continuity)
  applyRelationshipSpeakerReview(plan, answers, { relationship_s1: confidentDecision('known_1', 0.97, 0.97) }, review.ghostOptions, null, continuity)
  assert.equal(answers.speech_s1.choice, 'known_1')
  assert.ok(answers.relationship_continuity_s1)
  const assessment = assessSpeakerDiscourseEscalation(plan, answers)
  assert.ok(!assessment.runs.some(run => run.targets.includes('s1')))
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

test('prefers a possessive clause subject over weak possessive objects and history', () => {
  const speakers = [
    { id: 'zuri', name: 'Zuri' },
    { id: 'grace', name: 'Grace' },
    { id: 'hailey', name: 'Hailey' },
    { id: 'katie', name: 'Katie' },
  ]
  const current = [
    'The fever in his mouth and hands finds the girl at the center and Zuri\'s body does the thing she warned everyone about — it falls apart sideways. Her hands knot in the throw and in Grace\'s wrist.',
    '',
    '"I\'m — oh. Oh, it\'s here, it\'s all the way here —"',
    '',
    'The orgasm takes her sideways, her fingers white-knuckled in Grace\'s wrist.',
    '',
    '"There," she breathes into the fabric. "That\'s the falling apart."',
  ].join('\n')
  const historicalSpeakerId = previousAssistantSpeakerFallback(
    current,
    '"Name it whenever you want," Hailey murmurs from the sleeping bag.',
    null,
    speakers,
  )

  assert.equal(historicalSpeakerId, null)
  assert.deepEqual(
    parseRosterVoiceSegments(current, null, speakers, '', historicalSpeakerId)
      .filter(segment => segment.speakerId !== null)
      .map(segment => segment.speakerId),
    ['zuri', 'zuri', 'zuri'],
  )
})

test('inherits speakers from clause-leading possessive action subjects', () => {
  const content = [
    '"Then the first act is coming," Katie says. "More oil. Then the fullest."',
    '',
    'Zuri\'s breath shards into the throw and reforms as the word the house has been building toward, her hips pressing back into the slow work with the last of her deliberate rhythm.',
    '',
    '"More. There. That\'s the more."',
    '',
    'Grace\'s black-nailed hands lock at the freckles and hold. The fairy lights make their small gold weather over the four of them and the poem watches from its shelf.',
    '',
    '"Name it," she gasps. "The movie claim."',
    '',
    '"Seconded," Katie says from the wall.',
  ].join('\n')

  assert.deepEqual(
    parseRosterVoiceSegments(content, null, [
      { id: 'katie', name: 'Katie' },
      { id: 'zuri', name: 'Zuri' },
      { id: 'grace', name: 'Grace' },
    ]).filter(segment => segment.speakerId !== null),
    [
      { text: 'Then the first act is coming,', speakerId: 'katie' },
      { text: 'More oil. Then the fullest.', speakerId: 'katie' },
      { text: "More. There. That's the more.", speakerId: 'zuri' },
      { text: 'Name it,', speakerId: 'grace' },
      { text: 'The movie claim.', speakerId: 'grace' },
      { text: 'Seconded,', speakerId: 'katie' },
    ],
  )
})

test('recognizes a possessive speaker after a fronted prepositional phrase', () => {
  const content = [
    'Across the room Jeremy\'s breathing goes ragged and short. "Yo— hold on— hold—" He grits it out and spills over his own fist. "...That was warmup. That was a warmup."',
  ].join('\n')
  const speakers = [
    { id: 'diana', name: 'Diana' },
    { id: 'judy', name: 'Judy' },
    { id: 'jeremy', name: 'Jeremy' },
  ]

  assert.deepEqual(
    parseRosterVoiceSegments(content, 'diana', speakers)
      .filter(segment => segment.speakerId !== null),
    [
      { text: 'Yo— hold on— hold—', speakerId: 'jeremy' },
      { text: '...That was warmup. That was a warmup.', speakerId: 'jeremy' },
    ],
  )
})

test('anchors Ruby dialogue to the immediately preceding possessive-subject paragraph', () => {
  const content = [
    'The laugh comes first — and it lands wrong. Bright, automatic, the laugh she keeps for men who flirt at the bar, fired off at a question about trouble like a reflex striking a dead nerve. It cuts itself short.',
    '',
    "Ruby's hand comes to her own mouth. She swallows the rest of the laugh.",
    '',
    '"No one gives me trouble." Quiet now. "That isn\'t the word for it. Trouble\'s got a person in it."',
  ].join('\n')
  const speakers = [
    { id: 'ruby', name: 'Ruby' },
    { id: 'colton', name: 'Colton' },
    { id: 'tess', name: 'Tess' },
  ]

  assert.deepEqual(
    parseRosterVoiceSegments(content, null, speakers)
      .filter(segment => segment.speakerId !== null)
      .map(segment => segment.speakerId),
    ['ruby', 'ruby'],
  )
  assert.deepEqual(speakerReviewQuoteIndexes(content, null, speakers), [])

  const singleNewlineContent = [
    'The laugh comes first — and it lands wrong.',
    "Ruby's hand comes to her own mouth. She swallows the rest of the laugh.",
    '"No one gives me trouble." Quiet now. "That isn\'t the word for it."',
    "Her eyes go past Ken's shoulder to where Colton's chair sits empty.",
    '"It\'s the same. It\'s always the same."',
    "Across the street, Tess's tablet pulses once against her palm.",
    "The edge of Ruby's red dress hangs between them.",
  ].join('\n')
  assert.equal(
    parseRosterVoiceSegments(singleNewlineContent, null, speakers)
      .find(segment => segment.text === 'No one gives me trouble.')?.speakerId,
    'ruby',
  )

})

test('does not invent a speaker from a sentence-leading descriptor between quotes', () => {
  const content = [
    "Ruby's hand comes to her own mouth. She swallows the rest of the laugh.",
    '',
    '"No one gives me trouble." Quiet now. "That isn\'t the word for it. Trouble\'s got a person in it."',
    '',
    'Her voice is level and quiet, the way a person talks who is choosing each word.',
  ].join('\n')
  const speakers = addUnconfiguredDialogueSpeakers(content, [{ id: 'ruby', name: 'Ruby' }])

  assert.equal(speakers.some(speaker => speaker.id === unconfiguredSpeakerId('Quiet')), false)
  assert.deepEqual(
    parseRosterVoiceSegments(content, null, speakers)
      .filter(segment => segment.speakerId !== null)
      .map(segment => segment.speakerId),
    ['ruby', 'ruby'],
  )
})

test('prefers a clear adjacent narrative subject over previous-message history', () => {
  const content = [
    "On the boardwalk behind Ken, Tess Harlan's gaze has dropped to the hem of the red dress. Her thumb moves on the tablet. She lifts her hand to her earpiece, her voice dropping under the street noise.",
    '',
    '"...Ruby again. Fifth fracture since two. The guest is — yeah. Feeding her story. Log it."',
  ].join('\n')
  const segments = parseRosterVoiceSegments(
    content,
    null,
    [
      { id: 'ruby', name: 'Ruby' },
      { id: 'tess', name: 'Tess Harlan / Tess' },
    ],
    '',
    'ruby',
    true,
  )
  const speech = segments.find(segment => segment.text.startsWith('...Ruby again.'))

  assert.equal(speech?.speakerId, 'tess')
  assert.ok(speech?.debugPath?.includes('preceding-narrative-voice-subject:tess'))
  assert.ok(speech?.debugPath?.includes('local-selection:preceding-narrative-voice-subject -> tess'))
})

test('maps message-local speaker aliases back to configured voices', () => {
  const aliases = speakerAliasIdLookup([{ id: 'ruby', name: 'Ruby Vale / Ruby' }])

  assert.equal(aliases.get(unconfiguredSpeakerId('Ruby')), 'ruby')
  assert.equal(aliases.get(npcSpeakerId('Ruby')), 'ruby')
})

test('reports the rule path used for each speaker assignment when diagnostics are enabled', () => {
  const segments = parseRosterVoiceSegments(
    'Ruby\'s hand comes to her mouth.\n\n"No one gives me trouble."',
    null,
    [{ id: 'ruby', name: 'Ruby' }],
    '',
    null,
    true,
  )

  assert.deepEqual(segments[0].debugPath, ['segment-type:narration', 'routing:narrator-voice'])
  assert.ok(segments[1].debugPath?.includes('preceding-possessive-subject:ruby'))
  assert.ok(segments[1].debugPath?.includes('local-selection:preceding-possessive-subject -> ruby'))
  assert.ok(segments[1].debugPath?.includes('parser-result:ruby'))
})

test('does not let ambiguous LLM review override an adjacent narrative subject', () => {
  const content = [
    'Zuri\'s breath reforms as she steadies herself.',
    '',
    '"More. There."',
    '',
    'Grace\'s black-nailed hands close around her and hold.',
    '',
    '"Name it," she gasps. "The movie claim."',
  ].join('\n')
  const speakers = [
    { id: 'zuri', name: 'Zuri' },
    { id: 'grace', name: 'Grace' },
  ]

  assert.deepEqual(
    parseRosterVoiceSegmentsWithAssignments(
      content,
      null,
      speakers,
      [
        { quote: 0, speakerId: 'zuri' },
        { quote: 1, speakerId: 'zuri' },
        { quote: 2, speakerId: 'zuri' },
      ],
      '',
      null,
      true,
    ).filter(segment => segment.speakerId !== null),
    [
      { text: 'More. There.', speakerId: 'zuri' },
      { text: 'Name it,', speakerId: 'grace' },
      { text: 'The movie claim.', speakerId: 'grace' },
    ],
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

test('does not treat a sole named object as the paragraph speaker', () => {
  const content = [
    '"No, I hear you," Duncan says into the phone. "The third. Everything clean."',
    '',
    '"Four o\'clock. Her desk. I\'m there. Wouldn\'t miss it." His eyes cut to Poppy and he grins despite himself. "You\'re the star, sweetheart. Whole show."',
  ].join('\n')
  const speakers = [
    { id: 'duncan', name: 'Duncan' },
    { id: 'poppy', name: 'Poppy' },
  ]

  assert.deepEqual(
    parseRosterVoiceSegments(content, null, speakers)
      .filter(segment => segment.speakerId !== null),
    [
      { text: 'No, I hear you,', speakerId: 'duncan' },
      { text: 'The third. Everything clean.', speakerId: 'duncan' },
      { text: "Four o'clock. Her desk. I'm there. Wouldn't miss it.", speakerId: 'duncan' },
      { text: "You're the star, sweetheart. Whole show.", speakerId: 'duncan' },
    ],
  )
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

test('does not inherit the previous speaker across conflicting explicit subject pronouns', () => {
  const speakers = [{ id: 'npc:ewan', name: 'Ewan' }, { id: 'unconfigured:tessa', name: 'Tessa' }]
  const previous = 'Ewan picks up his tray. "I am going."\n\nTessa puts her bowl down. She frowns. "Talk about something else."'
  const current = '"Sacrifice."\n\nHe turns halfway back with the tray balanced on one palm.\n\n"What are you sacrificing?"\n\nHe shifts his weight.\n\n"Text her."'
  assert.equal(previousAssistantSpeakerFallback(current, previous, null, speakers), null)
  assert.ok(!addUnconfiguredDialogueSpeakers('Somebody behind him sidesteps the tray. Somebody moves. "Hello."', speakers).some(speaker => speaker.name === 'Somebody'))
})

test('speaker questions ask Jev to use names, pronouns and communication channels', () => {
  const plan = buildSpeakerDecisionPlan('"Hello."', [{ id: 'npc:ewan', name: 'Ewan' }], false)
  assert.match(plan.questions.speech_s0.instructions, /pronoun references/u)
  assert.match(plan.questions.speech_s0.instructions, /text messages/u)
  assert.match(plan.questions.speech_s0.instructions, /not proof of gender/u)
})

test('a clear response turn stops automatic carryover of the preceding speaker', () => {
  const content = '"Hello."\n\nThe other person looks up.\n\n"What now?"'
  const speakers = [{ id: 'npc:tessa', name: 'Tessa' }]
  const plan = buildSpeakerDecisionPlan(content, speakers, false)
  const answers: Record<string, SpeakerDecisionChoice> = { speech_s0: confidentDecision('known_0'), speech_s1: confidentDecision('no_clear_identity'), turn_s1: confidentDecision('responds_to_previous_speaker') }
  const result = resolveSpeakerDecisionSegments(content, plan, answers, speakers, { isUserMessage: false, cardSpeakerId: null, historicalSpeakerId: 'npc:tessa' })
  assert.notEqual(result.find(segment => segment.text === 'What now?')?.speakerId, 'npc:tessa')
})

test('prefers the sole character card for an unattributed assistant message', () => {
  const speakers = [
    { id: 'card-zuri', name: 'Zuri Vale / Zuri' },
    { id: 'npc-grace', name: 'Grace' },
    { id: USER_SPEAKER_ID, name: 'Ken' },
  ]
  const defaultSpeakerId = preferredCardSpeakerId(
    { name: 'Assistant' },
    speakers,
    ['card-zuri'],
  )

  assert.equal(defaultSpeakerId, 'card-zuri')
  assert.deepEqual(
    parseRosterVoiceSegments('"No names here."\n\n"Still the same speaker."', defaultSpeakerId, speakers)
      .filter(segment => segment.speakerId !== null),
    [
      { text: 'No names here.', speakerId: 'card-zuri' },
      { text: 'Still the same speaker.', speakerId: 'card-zuri' },
    ],
  )
})

test('keeps explicit and named group-card identities ahead of a card fallback', () => {
  const speakers = [
    { id: 'card-zuri', name: 'Zuri Vale / Zuri' },
    { id: 'card-grace', name: 'Grace Hopper / Grace' },
  ]

  assert.equal(
    preferredCardSpeakerId(
      { name: 'Unknown', extra: { character_id: 'card-grace' } },
      speakers,
      ['card-zuri', 'card-grace'],
    ),
    'card-grace',
  )
  assert.equal(
    preferredCardSpeakerId({ name: 'Zuri' }, speakers, ['card-zuri', 'card-grace']),
    'card-zuri',
  )
  assert.equal(
    preferredCardSpeakerId({ name: 'Unknown' }, speakers, ['card-zuri', 'card-grace']),
    null,
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

test('uses the previous assistant speaker to resolve conflicting narrative candidates', () => {
  const speakers = [
    { id: 'nathan', name: 'Nathan' },
    { id: 'kyoko', name: 'Kyoko' },
  ]
  const current = [
    'Nathan watches the doorway.',
    '',
    '"The first instruction."',
    '',
    'Kyoko appears at the edge of the kitchen.',
    '',
    '"The second instruction."',
  ].join('\n')
  const historicalSpeakerId = previousAssistantSpeakerFallback(
    current,
    'Nathan steps out first.\n\n"Do honest."',
    null,
    speakers,
  )
  assert.equal(historicalSpeakerId, 'nathan')
  assert.deepEqual(
    parseRosterVoiceSegments(current, null, speakers, '', historicalSpeakerId)
      .filter(segment => segment.speakerId !== null)
      .map(segment => segment.speakerId),
    ['nathan', 'nathan'],
  )
  assert.equal(
    previousAssistantSpeakerFallback(
      'Nathan watches the doorway.\n\n"One instruction."',
      'Kyoko closes the door.',
      null,
      speakers,
    ),
    null,
  )
})

test('recovers duplicated opening quotes without assigning narration to the speaker', () => {
  const speakers = [
    { id: 'nathan', name: 'Nathan Bateman / Nathan' },
    { id: 'kyoko', name: 'Kyoko' },
  ]
  const current = [
    'Nathan turns the bottle in his hand and studies the man.',
    '',
    '""Not for her. For myself.\'',
    '',
    '"That is her sentence wearing your coat."',
    '',
    'He steps past, close enough that the smell of beer comes off him.',
    '',
    '"Granted. Seven-thirty, ridge path, back by nine."',
    '',
    'Kyoko appears at the edge of the kitchen. Nathan watches her and then does not.',
    '',
    '"Dinner in twenty. Go wash your hands like a guest."',
  ].join('\n')
  const historicalSpeakerId = previousAssistantSpeakerFallback(
    current,
    'Nathan steps out first. "Do honest."',
    null,
    speakers,
  )

  assert.equal(historicalSpeakerId, 'nathan')
  const segments = parseRosterVoiceSegments(current, null, speakers, '', historicalSpeakerId)
  assert.deepEqual(
    segments.filter(segment => segment.text.startsWith('Not for her')
      || segment.text.startsWith('That is her sentence')
      || segment.text.startsWith('Granted')
      || segment.text.startsWith('Dinner in twenty')),
    [
      { text: 'Not for her. For myself.', speakerId: 'nathan' },
      { text: 'That is her sentence wearing your coat.', speakerId: 'nathan' },
      { text: 'Granted. Seven-thirty, ridge path, back by nine.', speakerId: 'nathan' },
      { text: 'Dinner in twenty. Go wash your hands like a guest.', speakerId: 'nathan' },
    ],
  )
  assert.deepEqual(
    segments.find(segment => segment.text.startsWith('He steps past')),
    { text: 'He steps past, close enough that the smell of beer comes off him.', speakerId: null },
  )
})

test('limits previous-message inheritance to an ambiguous opening dialogue run', () => {
  const speakers = [
    { id: 'mara', name: 'Mara' },
    { id: 'grace', name: 'Grace' },
  ]
  const current = [
    '"The first unresolved thought."',
    '',
    '"And another part of the same thought."',
    '',
    'Grace stepped into the doorway. "This line is mine," Grace said.',
    '',
    '"So is this continuation."',
  ].join('\n')
  const historicalSpeakerId = previousAssistantSpeakerFallback(
    current,
    'Mara folded her arms. "I am still speaking."',
    null,
    speakers,
  )

  assert.equal(historicalSpeakerId, 'mara')
  assert.deepEqual(
    parseRosterVoiceSegments(current, null, speakers, '', historicalSpeakerId)
      .filter(segment => segment.speakerId !== null)
      .map(segment => segment.speakerId),
    ['mara', 'mara', 'grace', 'grace'],
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
