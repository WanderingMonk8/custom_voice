# TTS vocal tags

## Objective

Add a small, controlled amount of inline vocal acting to the speech sent to
TTS without changing the message. A tag is a momentary sound such as
`<gasp>` (Gemini) or `[gasp]` (Fish); it is not a sustained speaker emotion
instruction. Tags are inserted only inside quoted speech, never into
narration.

## Pipeline

1. **Structure plan.** `buildSpeakerDecisionPlan` supplies the message,
   quotations, and surrounding narration. The same structure is used by Jev
   speaker assignment and by the tag pass.
2. **Jev tag ranking.** `buildTtsTagPlan` issues one ranking question per
   speech with the full tag menu plus `no_tag`. It also issues one placement
   question per speech for the fallback sentence boundary. The tag evaluation
   runs in parallel with the Jev speaker decision and is independent of the LLM
   placement setting.
3. **Thresholds.** A tag is applied only when all three gates pass:
   - winner probability >= 0.65
   - answer confidence >= 0.60
   - winner minus runner-up >= 0.20
   The placement boundary uses 0.50/0.50/0.10. A failed gate means no new tag.
   Most speeches should resolve to `no_tag`.
4. **Deterministic insertion.** `resolveTtsTagAnswers` normalizes any existing
   recognized tags to the chosen provider style, inserts the selected tag at
   the chosen sentence boundary, and records `ttsText` plus `ttsTag` metadata.
   If the same tag is already present, the duplicate is skipped but the
   existing tag is normalized. The message text and the ordinary `text` field
   are unchanged.
5. **LLM placement.** When `LLM exact placement` is selected, the frontend
   sends only the chosen tag and its speech to the placement LLM. The backend
   validates that the LLM preserved every word and existing tag and added the
   requested tag exactly once. Invalid or missing results fall back to the
   deterministic Jev placement.

## Chunking

LLM placement never runs as one call for the whole message:

- Tagged speeches are grouped into chunks of four.
- The first chunk is requested before synthesis and awaited for at most eight
  seconds. This is the only blocking placement work.
- The remaining chunks start immediately after that first wait resolves or
  times out, and continue resolving sequentially while playback runs.
- A plan entry is updated when its chunk returns. If a segment has already
  started synthesis, its deterministic placement is used for that playback;
  segments that have not started use the exact placement.
- The first-chunk timeout is a latency bound, not an error. A slow first chunk
  can still arrive later and update segments that have not started.
- Chunk results are cached per message, speech, tag, style, connection, and
  model for the session, so replaying a message avoids repeat placement calls.
- Multi-paragraph speeches keep deterministic placement because a
  speech-level placement result cannot be split safely across paragraph-sized
  TTS requests.

## Settings

- **TTS vocal tags**: Off (default), Gemini `<tag>`, or Fish `[tag]`.
- **Vocal tag placement**: Jev sentence boundaries or LLM exact placement.
- **Vocal tag LLM connection**: optional Lumiverse LLM connection. Empty uses
  the active/default connection.
- **Vocal tag model**: optional model override. Empty uses the connection's
  model.

The tag style also invalidates the cached speaker parse, because the cached
`ttsText` depends on it. Placement connection/model changes do not invalidate
the deterministic parse cache.

## Failure behavior

- No Decision connection: existing recognized tags are normalized, but no new
  tags are chosen.
- Tag evaluation failure: the parse continues with local/deterministic speaker
  assignment and existing tags only.
- Placement RPC failure, timeout, or validation failure: the deterministic
  Jev placement remains in place.
- Messages with no quoted speech, or with only a single speech under the
  thresholds, receive no tags.

## Diagnostics

With **Speaker assignment debug** enabled, each speech's debug path includes
`tts-tag`, probability/confidence/margin, placement boundary, and the resulting
`tts-text`. The speech list also shows a truncated `tts-tagged` line. LLM
placement adds its style/connection/model settings, cache hits, chunk
start/finish/failure events, the first-chunk timeout, and each applied
placement text. The synthesis plan shows the final text used for each request,
including placements that arrived before that request started.
