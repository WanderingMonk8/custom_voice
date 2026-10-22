# TTS vocal tags

## Objective

Add controlled inline acting to the speech sent to TTS without changing the
message. Every quoted speech receives a leading emotion cue. Jev may also add
one momentary sound and one short or long pause. Cues are inserted only inside
quoted speech, never into narration.

Both providers now use square-bracket cues. Gemini documents bracket cues such
as `[laughs]`, `[sigh]`, `[uhm]`, and `[extremely fast]`; Fish S2 documents
`[happy]`, sound effects, and `[break]` / `[long-break]`. Gemini's separate
prompt-level emotion control is not exposed by the extension's TTS request, so
the leading emotion is sent as an inline bracket cue instead.

## Pipeline

1. **Structure plan.** `buildSpeakerDecisionPlan` supplies the message,
   quotations, and surrounding narration. The same structure is used by Jev
   speaker assignment and by the tag pass.
2. **Jev tag ranking.** `buildTtsTagPlan` issues eight questions per speech:
   - mandatory primary emotion; no threshold, with `calm` as the neutral fallback
   - optional secondary emotion
   - optional primary momentary sound
   - optional secondary momentary sound
   - fallback primary-sound boundary
   - optional primary short/long pause
   - optional secondary short/long pause
   - fallback primary-pause boundary
   The tag evaluation runs in parallel with the Jev speaker decision and is
   independent of the LLM placement setting. Tag evaluation is grouped two
   speeches per Decision call; a failed batch is retried one speech at a time.
   This keeps the probability output within the model's response limit.
3. **Thresholds.** Sound and pause are applied only when all three gates pass:
   - winner probability >= 0.65
   - answer confidence >= 0.60
   - winner minus runner-up >= 0.20
   The fallback boundaries use 0.50/0.50/0.10. Emotion is always applied.
4. **Deterministic text.** `resolveTtsTagAnswers` collects up to two leading
   emotions, normalizes existing cues, and inserts up to two new sounds and two
   new pauses at their fallback boundaries. Existing cues count toward the caps.
   It records `baseText` (emotions but no new sound/pause) for the placement LLM,
   plus the full `ttsText` fallback and `ttsTag` metadata. The message text and
   ordinary `text` field are unchanged.
5. **Grouped LLM placement.** When `LLM exact placement` is selected, one item
   per speech carries all selected sounds and pauses together. The backend
   validates that the LLM preserved the leading emotions, every word, and every
   existing cue, and added only the requested sounds and pauses, each exactly
   once. Invalid or missing results fall back to the deterministic placement.

## Chunking

LLM placement never runs as one call for the whole message:

- Speeches needing sound or pause placement are grouped into chunks of four.
- Emotion-only speeches do not enter the placement pipeline and do not block
  playback.
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
  connection, and model for the session.
- Multi-paragraph speeches keep deterministic placement because a speech-level
  placement result cannot be split safely across paragraph-sized TTS requests.

## Tag behavior

- **Emotion:** one of the 49 documented Fish emotions at the start. A second
  compatible emotion may be added above the same strict thresholds. Existing
  emotions are preserved and moved/normalized to the start; up to two are kept.
  Neutral delivery falls back to `calm`.
- **Sound:** up to two, rendered with Fish's documented forms where they differ,
  such as `[laughing]`, `[sighing]`, and `[gasping]`. Existing sounds count
  toward the cap; duplicates are skipped.
- **Pause:** up to two, using `[break]` or `[long-break]`. Existing pauses count
  toward the cap.
- Existing angle-bracket cues are normalized to bracket cues.

## Settings

- **TTS vocal tags**: Off (default), Gemini, or Fish S2. Both use bracket cues;
  Fish uses its documented sound vocabulary.
- **Vocal tag placement**: Jev sentence boundaries or LLM exact placement.
- **Vocal tag LLM connection**: optional Lumiverse LLM connection. Empty uses
  the active/default connection.
- **Vocal tag model**: optional model override. Empty uses the connection's
  model.

The tag style also invalidates the cached speaker parse, because the cached
`ttsText` depends on it. Placement connection/model changes do not invalidate
the deterministic parse cache.

## Failure behavior

- No Decision connection: existing recognized cues are normalized and the
  emotion falls back to `calm`; no optional sound or pause is chosen.
- Tag evaluation failure: the parse continues with local/deterministic speaker
  assignment and existing cues only.
- Placement RPC failure, timeout, or validation failure: the deterministic
  Jev placement remains in place.
- Messages with no quoted speech receive no tags.

## Diagnostics

With **Speaker assignment debug** enabled, each speech's debug path includes
the leading emotions, primary/secondary emotion probabilities, sound and pause
probabilities, margins, boundaries, and the resulting `tts-text`. The speech
list also shows a truncated `tts-tagged` line. LLM placement adds its
style/connection/model settings, cache hits, chunk start/finish/failure events,
the first-chunk timeout, and each applied placement text. The synthesis plan
shows the final text used for each request, including placements that arrived
before that request started.
