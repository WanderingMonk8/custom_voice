# TTS vocal tags

## Objective

Add controlled inline acting to the speech sent to TTS without changing the
message. Gemini and Fish S2 receive a leading emotion cue; Fish S2 with LLM
placement can also receive one mid-speech modulation. Gemini 3.8 uses only
documented vocal events and pauses. Jev may add one or two momentary sounds and
one or two short or long pauses. Cues are inserted only inside quoted speech,
never into narration.

Legacy Gemini and Fish S2 use square-bracket cues. Gemini documents bracket cues
such as `[laughs]`, `[sigh]`, `[uhm]`, and `[extremely fast]`; Fish S2 documents
`[happy]`, sound effects, and `[break]` / `[long-break]`. Gemini 3.8 instead uses
angle-bracket vocal events such as `<sigh>`, `<gasp>`, and `<short pause>`. Its
sustained emotion/style control is a separate `speech_metadata` field that the
extension's TTS request does not expose, so Gemini 3.8 receives no inline
emotion or style cue.

## Pipeline

1. **Structure plan.** `buildSpeakerDecisionPlan` supplies the message,
   quotations, and surrounding narration. The same structure is used by Jev
   speaker assignment and by the tag pass.
2. **Jev tag ranking.** `buildTtsTagPlan` issues eight questions per speech for
   legacy Gemini, nine for Fish with Jev placement, eleven for Fish with LLM
   placement, and six for Gemini 3.8:
   - Gemini/Fish only: mandatory primary emotion from the 24 basic emotions; no
     threshold, with `calm` as the neutral fallback
   - Gemini/Fish only: optional secondary basic emotion
   - Fish-only optional sustained voice style (whispering, soft/loud/low voice,
     shouting, screaming)
   - Fish + LLM only: optional mid-speech modulation
   - Fish + LLM only: mid-speech modulation position, using clause boundaries and
     a few evenly spaced word boundaries
   - optional primary momentary sound
   - optional secondary momentary sound
   - fallback primary-sound boundary
   - optional primary short/long pause
   - optional secondary short/long pause
   - fallback primary-pause boundary
   Gemini 3.8 skips the emotion and style questions because those cues cannot be
   expressed through its inline event syntax. Fish without modulation positions
   skips the two modulation questions.
   The tag evaluation runs in parallel with the Jev speaker decision. Fish
   modulation questions are enabled only for **LLM exact placement**. Fish with
   LLM placement evaluates one speech per Decision call; other styles keep two
   speeches per call. A failed batch is retried one speech at a time. This keeps
   the larger probability and position menu within the model's response limit.
3. **Thresholds.** Sound and pause are applied only when all three gates pass:
   - winner probability >= 0.65
   - answer confidence >= 0.60
   - winner minus runner-up >= 0.20
   The fallback boundaries use 0.50/0.50/0.10. Emotion is mandatory for Gemini
   and Fish, but a weak primary winner falls back to `calm` below
   0.40/0.35/0.10. Modulation uses the same strict sound/pause gates and requires
   a confident modulation position. Gemini 3.8 has no emotion question.
4. **Deterministic text.** `resolveTtsTagAnswers` collects up to two leading
   emotions for Gemini/Fish, normalizes existing cues, and inserts up to two new
   sounds and two new pauses at their fallback boundaries. Existing cues count
   toward the caps. Gemini 3.8 skips the leading emotions and emits only its
   angle-bracket sounds and pauses. For Fish + LLM modulation, `baseText`
   contains the internal `[modulationmarker]` at the selected point; the
   deterministic `ttsText` fallback does not include modulation. It also records
   `ttsTag` metadata and the full `ttsText` fallback. The message text and
   ordinary `text` field are unchanged.
5. **Grouped LLM placement.** When `LLM exact placement` is selected, one item
   per speech carries all selected sounds and pauses together. For Fish S2,
   every single-paragraph speech is included even when it has no sound or pause,
   because the same call also requests a custom emotion cue. The LLM returns
   that cue separately as `emotionTag`; it is never inserted into the returned
   text. For a modulated speech it also returns `modulationTag` for the remainder
   after the preserved marker. The backend validates the text for sound/pause
   placement and marker position, validates both custom cues (fewer than 10
   words, no brackets or line breaks), then replaces the fixed leading emotion
   and inserts the modulation cue at the marker. The fixed Jev emotion remains in
   `ttsTag` metadata and remains the fallback. Legacy Gemini keeps the fixed
   emotion and only uses the call for sound/pause placement. Gemini 3.8 has no
   leading emotion and uses the call only for its angle-bracket sounds/pauses.

## Chunking

LLM placement never runs as one call for the whole message:

- Fish S2 groups all single-paragraph speeches into placement chunks of four
  because every speech needs a custom emotion cue. Jev evaluates Fish modulation
  one speech per Decision call before that placement chunk. Legacy Gemini and
  Gemini 3.8 group only speeches that need sound or pause placement.
- Multi-paragraph speeches keep deterministic placement because a speech-level
  result cannot be split safely across paragraph requests.
- The first placement chunk is requested before synthesis and awaited for at
  most eight seconds. This is the only blocking placement work.
- The remaining chunks start immediately after that first wait resolves or
  times out, and continue resolving sequentially while playback runs.
- A plan entry is updated when its chunk returns. If a segment has already
  started synthesis, its deterministic placement is used for that playback;
  segments that have not started use the exact placement.
- The first-chunk timeout is a latency bound, not an error. A slow first chunk
  can still arrive later and update segments that have not started.
- Chunk results are cached per message, speech, emotion, sound, pause, style,
  modulation point, connection, and model for the session.
- Multi-paragraph speeches keep deterministic placement because a speech-level
  placement result cannot be split safely across paragraph-sized TTS requests.

## Tag behavior

- **Emotion:** legacy Gemini and Fish S2 use the automatic Jev menu with the 24
  basic emotions, always at the start. A weak primary winner falls back to
  `calm`. A second compatible basic emotion may be added above the same strict
  thresholds. Existing cues using any of the 49 documented Fish emotions are
  preserved, moved/normalized to the start, and capped at two. Gemini 3.8 does
  not receive inline emotions.
- **Fish S2 custom emotion:** when LLM placement is enabled, the placement LLM
  refines the fixed Jev winner using the speech and its surrounding narration.
  The custom cue replaces the fixed tag in `ttsText` but the fixed tag remains
  in metadata and is restored if the custom cue is missing or invalid.
- **Fish S2 style:** an optional sustained voice style is placed with the
  emotion at the start, never sent to the placement LLM. Fish sound cues use
  the S2 well-tested forms, including `[sigh]`, `[gasp]`, `[groan]`,
  `[laughing]`, `[crying]`, `[inhale]`, `[exhale]`, and `[clears throat]`.
  Pauses use `[short pause]` and `[long pause]`.
- **Fish S2 modulation:** with LLM placement only, Jev may select one
  mid-speech emotional turn and its point. The placement LLM writes a
  free-form tag for the remainder, fewer than 10 words, that continues the
  leading emotion and stays compatible with the style. The backend inserts it
  at the Jev point and repeats it with the style cue at later sentence starts,
  so it persists to the end of the speech. The internal marker never reaches
  TTS. If the point, marker, or tag is invalid, modulation is skipped and the
  leading delivery remains.
- **Gemini 3.8 events:** sounds use its documented angle-bracket forms, including
  `<sigh>`, `<gasp>`, `<laugh>`, `<cry>`, `<breath>`, and `<throat-clearing>`.
  Pauses use `<short pause>` and `<long pause>`. Sustained emotion, custom
  emotion, style, and volume are not inserted because Gemini 3.8 requires
  `speech_metadata.style` for those, and the current TTS request has no field
  for it.
- **Fish S2 scoping:** because S2 cues apply until the next cue or sentence end,
  the leading emotion/style prefix is repeated at each sentence start. This also
  restores the base delivery after a reaction or pause in the previous sentence.
  After a modulation point, the modulation tag and style are repeated at later
  sentence starts instead. Legacy Gemini keeps its existing single-prefix
  behavior. Gemini 3.8 has no leading prefix.
- **Sound:** up to two, rendered with the selected provider's documented forms
  where they differ. Existing sounds count toward the cap; duplicates are
  skipped.
- **Pause:** up to two, using the provider-specific pause form. Existing pauses
  count toward the cap.
- Existing cues are normalized to the selected provider's bracket type. Gemini
  3.8 uses angle brackets; legacy Gemini and Fish S2 use square brackets.

## Settings

- **TTS vocal tags**: Off (default), Gemini, Gemini 3.8, or Fish S2. Legacy
  Gemini and Fish S2 use square-bracket cues; Gemini 3.8 uses angle-bracket
  vocal events and pauses.
- **Vocal tag placement**: Jev sentence boundaries or LLM exact placement.
  Fish modulation is available only with **LLM exact placement**.
- **Vocal tag LLM connection**: optional Lumiverse LLM connection. Empty uses
  the active/default connection.
- **Vocal tag model**: optional model override. Empty uses the connection's
  model.

The tag style and placement mode invalidate the cached speaker parse, because
the cached `ttsText` and modulation metadata depend on them. Placement
connection/model changes do not invalidate the deterministic parse cache.

## Failure behavior

- No Decision connection: existing recognized cues are normalized and the
  Gemini/Fish emotion falls back to `calm`; no optional sound or pause is chosen.
  Gemini 3.8 has no emotion fallback and simply keeps any existing vocal events.
- Tag evaluation failure, a rejected probability distribution, or an invalid
  batch: retry the affected speeches individually, then with the compact
  12-emotion menu, then fall back to `calm` for that Gemini/Fish speech. Gemini
  3.8 simply keeps any existing vocal events.
- Placement RPC failure, timeout, or validation failure: the deterministic
  Jev placement remains in place.
- Missing, malformed, or too-long Fish custom emotion tag: the fixed Jev emotion
  remains in place and modulation is skipped.
- Missing, moved, or duplicated modulation marker: placement validation fails
  and the deterministic leading placement remains.
- Missing, malformed, or too-long Fish modulation tag: modulation is skipped
  and the leading custom emotion remains.
- Messages with no quoted speech receive no tags.

## Diagnostics

With **Speaker assignment debug** enabled, each speech's debug path includes
the leading emotions when supported, primary/secondary emotion probabilities,
confidence and margin, Fish style probabilities, sound and pause probabilities,
modulation probability/confidence/margin, the modulation point ID and character
offset, modulation position confidence, and the resulting `tts-text`. The speech
list also shows a truncated `tts-tagged` line. LLM placement adds its
style/connection/model settings, cache hits, chunk start/finish/failure events,
the first-chunk timeout, the custom Fish emotion cue and modulation cue when
used, the modulation point used for the cache key, and each applied placement
text. The synthesis plan shows the final text used for each request, including
placements that arrived before that request started.
