# Jev speaker-assignment pipeline

## Status

Implemented on the `jev` branch. The initial design was committed before implementation.

Pipeline steps 1-6, including cross-paragraph discourse escalation, confidence
normalization, caching, and diagnostics, are implemented in `src/core.ts` and
wired through the backend Decision calls. Shadow mode and the promotion checklist
in "Validation and rollout" remain rollout tasks.

## Objective

Replace deterministic grammatical speaker inference as the primary assignment
engine with Lumiverse's default Decision connection. Jev supplies bounded
semantic judgments; ordinary code retains control of dialogue extraction,
confidence gates, inheritance, card-title fallback, voice routing, caching, and
failure recovery.

The extension must not call TypeSafe directly, store a TypeSafe credential, or
offer a separate Jev connection/model selector. It must use
`spindle.decisions.evaluate` without `connection_id` or `model`, allowing
Lumiverse to resolve the account's default Decision connection.

## Non-goals

- Jev does not extract or rewrite message text.
- Jev does not select TTS voices or connections.
- Jev does not decide whether narration is spoken by the narrator.
- Jev does not own inheritance or fallback policy.
- The first implementation does not delete the current parser. It remains an
  outage and compatibility fallback until the Jev path is proven.

## Host requirements

- Add the `decisions` permission to `spindle.json`.
- Upgrade `lumiverse-spindle-types` to at least `0.6.45`.
- Feature-detect `spindle.host.capabilities['decisions-v1']` before evaluation.
- Omit `connection_id` and `model` on every evaluation so the default Decision
  connection is always used.
- Treat missing permission, missing capability, missing default connection,
  provider errors, invalid answers, aborts, and the host's 30-second deadline as
  recoverable classifier failures.
- Do not implement a separate HTTP client or use `/api/v1/decisions/evaluate`
  directly from the frontend.

## Terminology

- **Paragraph**: a playback paragraph after tracker removal and markup cleanup.
- **Speech span**: playable text inside straight or curly quotation marks.
- **Known speaker**: a configured card or manually added NPC available to this
  message role.
- **Uncast character**: a locally identifiable character with no configured
  roster entry. All uncast characters use the TTS connection's default voice.
- **Clear identity**: a Jev result that passes the configured probability,
  confidence, and winner-margin gates.
- **Unresolved**: no candidate passes the clear-identity gates.

## Pipeline

### 1. Structural preprocessing

Deterministic code performs only stable text operations:

1. Remove skipped tracker blocks and playback markup.
2. Split the message into numbered paragraphs.
3. Extract numbered speech spans and associate each with its containing
   paragraph.
4. Build the role-appropriate known-speaker roster and aliases.
5. Record the nearest previous assistant identity, unique card-title match, and
   message role for the resolver. These fallback hints are not presented to Jev
   as preferred answers.

No grammatical rule assigns a speaker in this stage.

### 2. First-pass batched Decision evaluation

Send one state object containing:

- the cleaned current message;
- numbered paragraphs;
- numbered speech spans and their paragraph IDs;
- known speaker IDs, names, and aliases;
- whether the message is from the assistant or user.

Do not label the card character as preferred and do not expose the previous
speaker as a default. This avoids biasing local semantic classification toward
fallback candidates.

Ask independent Choice questions in the same evaluation:

- `paragraph_<id>`: which identity, if any, is locally established as the
  acting or speaking subject of this paragraph?
- `speech_<id>`: who speaks this quotation, based on its local narrative,
  attribution, action ownership, pronouns, and dialogue flow?

Every question uses the same option set:

- one option per known speaker ID;
- `uncast_character`;
- `no_clear_identity`.

Descriptions define `uncast_character` as a specific person present in the
text who is not one of the known speakers. `no_clear_identity` means that the
text does not establish a reliable identity. Jev returns the selected option,
probability distribution, and confidence for every question.

Questions are batched rather than called sequentially. Lumiverse supports up to
256 questions per evaluation and 255 Choice options. Oversized messages are
split into ordered windows with overlapping boundary paragraphs; candidate
rosters over the option limit are reduced to locally mentioned configured
speakers plus the card candidate and recent clear speakers.

### 3. Confidence normalization

Convert each Jev answer to one of:

- `clear-known(speakerId)`;
- `clear-uncast`;
- `unresolved`.

Acceptance considers three independent signals:

- the winner's probability;
- Jev's confidence;
- the probability margin over the runner-up.

Initial thresholds must be conservative and constants must be isolated in the
resolver. They should be tuned against the regression corpus rather than made
user-facing during the first release. Selecting `no_clear_identity`, failing a
threshold, or returning an invalid candidate produces `unresolved`.

### 4. Cross-paragraph discourse escalation

The first pass has access to the complete message, but its questions deliberately
ask for local evidence. Local answers alone are insufficient when speaker
identity is encoded by turn-taking across multiple paragraphs. After confidence
normalization, identify dialogue runs that need a second, discourse-level Jev
evaluation before applying inheritance or role fallbacks.

A **dialogue run** is an ordered group of speech spans connected across adjacent
paragraphs. Short narration-only paragraphs may remain inside the run when they
do not establish a scene change, time jump, new communication channel, or other
hard boundary. The escalation window includes the run plus the nearest clear
identity anchor before and after it, when present. The complete cleaned message
remains available as background, but the second pass may assign only speech
spans inside the marked run.

Escalate a run when at least one target speech is unresolved and one or more of
these conditions holds:

1. Two or more adjacent speech-bearing paragraphs are unresolved or
   low-confidence.
2. A clear speaker is followed by multiple unattributed replies, questions,
   contradictions, interruptions, or other likely turn changes.
3. An unresolved run lies between clear identity anchors, including a later
   attribution that may disambiguate earlier dialogue.
4. Paragraph-level and speech-level answers conflict, or their leading
   candidates are close enough that deterministic precedence would be brittle.
5. Two or more known or uncast participants are established in the surrounding
   scene and the unresolved spans could plausibly alternate between them.
6. A turn-switch cue identifies a different but unnamed participant, such as
   “the other woman replies,” “a second voice answers,” or dialogue arriving
   from across the room.
7. Multiple communication channels are interleaved, such as in-room speech,
   telephone audio, text messages, radio traffic, or overheard dialogue.
8. A known-to-uncast or uncast-to-known transition occurs inside an otherwise
   ambiguous dialogue sequence.

Do not escalate merely because one quotation has low confidence. A single
unresolved span with one strong, uncontested upstream identity may use ordinary
inheritance. Do not escalate narration-only passages, and never alternate
speakers mechanically based only on paragraph order.

The second Decision request contains:

- the same cleaned message, roster, paragraph IDs, and speech IDs;
- the target dialogue run and its boundary anchors;
- first-pass normalized results, probabilities, confidence, and margins;
- known and uncast identities established elsewhere in the current message;
- explicit channel or boundary cues detected structurally.

First-pass results are evidence rather than fixed answers. Ask one Choice
question for each unresolved or conflicting target speech. Each question asks
Jev to identify the speaker using the complete dialogue sequence, response
relationships, turn continuity, channel changes, and both boundary anchors.
Use the same known-speaker, `uncast_character`, and `no_clear_identity` options
as the first pass. Keeping one question per target avoids a combinatorial option
set while the shared state lets all questions reason over the same run.

Normalize second-pass answers with conservative probability, confidence, and
winner-margin gates. A discourse answer may replace an unresolved first-pass
answer. It may replace a clear first-pass answer only when that answer was part
of an explicit paragraph/speech conflict and the discourse result clears a
higher override threshold. Otherwise, the first-pass clear identity remains
authoritative.

Runs may be combined into one second batched evaluation when the total remains
within Lumiverse's 256-question limit. If the second request is unavailable,
fails, exceeds limits, or remains inconclusive, continue with the first-pass
results and existing deterministic policy. There is no third semantic pass.

Card-title deference, previous-message inheritance, user-role fallback, and the
connection default are not candidates in the discourse questions. They remain
post-classification policies and run only after every eligible escalation has
finished. A clear discourse-level uncast identity disables card-title deference
just like a clear first-pass uncast identity.

### 5. Deterministic resolution

Resolve speech spans in message order after every paragraph and speech answer
is available.

1. A clear speech-level known speaker wins.
2. A clear speech-level uncast identity routes to the connection default.
3. Otherwise, use a clear identity established by the containing paragraph.
4. Otherwise, inherit the nearest clear upstream identity within the current
   message, stopping at a conflicting clear identity.
5. An ambiguous opening run may inherit the last clear previous-assistant
   identity until the first clear current-message identity appears.
6. Card-title deference is eligible only when the complete current assistant
   message contains no clear known or uncast identity from either paragraph or
   speech decisions. The title must match exactly one configured NPC.
7. When no unique card match exists and the message has no local clear identity,
   the previous-assistant identity rule remains available.
8. Remaining unresolved assistant speech uses the TTS connection default.
9. Remaining unresolved user-message speech uses the configured user voice.

All non-speech text remains narrator audio. A clear uncast result counts as an
identity for inheritance and disables card-title deference, even though its
voice route is the connection default.

### 6. Voice routing

The semantic result is translated to the existing playback IDs:

- known speaker -> configured speaker ID;
- uncast character -> `UNCAST_SPEAKER_ID`;
- unresolved assistant speech -> no character voice (connection default);
- unresolved user speech -> `USER_SPEAKER_ID`;
- narration -> `null` (narrator route).

Jev never sees voice IDs, voice names, or TTS connection details.

## Caching

Cache final assignments per message. The cache hash includes:

- classifier schema version;
- cleaned message content;
- paragraph and speech-span structure;
- message role;
- known speaker IDs, names, and aliases;
- previous clear assistant identity;
- unique card-title candidate;
- skipped tracker configuration;
- first- and second-pass confidence-threshold versions;
- discourse-run detection and hard-boundary schema versions.

The cached result records which dialogue runs were escalated, their triggers,
and whether each final identity came from the local pass, discourse pass, or
deterministic fallback. Do not reuse first-pass-only assignments after a schema
change makes the same message eligible for escalation.

Debug requests may bypass the cache. Editing a message, roster, aliases, card
title, tracker settings, or relevant upstream identity invalidates it.

## Failure and compatibility behavior

The host does not automatically retry Decision evaluations. The first release
does not add retries to the playback critical path. If the first pass fails:

1. record the classifier failure in diagnostics;
2. show a concise playback status;
3. run the current local parser as a compatibility fallback;
4. continue synthesis rather than failing the entire audio request.

If only the discourse escalation fails, retain the normalized first-pass
answers and continue through deterministic resolution. Do not discard a
successful first pass or replace the entire message with local-parser output.

Cancellation stops the frontend from waiting for the assignment. Because the
Decision SDK does not expose an abort signal, a late backend result may still
populate the assignment cache, but it is not played by the cancelled session.

## Settings changes

- Remove the speaker-review LLM connection picker and custom LLM model field.
- Stop using `spindle.generate.quiet` for speaker assignment.
- Use the default Lumiverse Decision connection without an extension-level
  override.
- Retain the speaker-assignment debug switch.
- During rollout, retain a temporary engine switch only if needed for shadow
  comparison; it is not part of the intended final UI.

## Diagnostics

When speaker debug logging is enabled, each speech span records:

- paragraph and speech IDs;
- Jev selected option;
- all candidate probabilities;
- Jev confidence and winner margin;
- normalized confidence state;
- paragraph evidence used;
- whether discourse escalation was considered and the trigger that selected or
  rejected it;
- escalation run membership, boundary anchors, and hard boundaries;
- first-pass versus discourse-pass answers and thresholds;
- whether the discourse answer filled an unresolved span, overrode a conflict,
  or was rejected;
- upstream or previous-message inheritance;
- whether card-title deference was eligible and why;
- final speaker ID and voice route;
- cache, compatibility fallback, or Decision error status.

Diagnostics must distinguish semantic `uncast_character` from unresolved speech
that merely routes to the same connection-default voice.

## Validation and rollout

1. Convert every previously reported misassignment into a fixture with expected
   semantic and final routing results.
2. Unit-test request construction, response validation, confidence gates,
   inheritance, card-title eligibility, user/assistant defaults, window overlap,
   caching, and failure fallback.
3. Add fixtures for ambiguous call-and-response runs, downstream attribution,
   conflicting anchors, known/uncast transitions, interrupted dialogue, and
   interleaved communication channels.
4. Verify that isolated low-confidence speech with a strong upstream anchor does
   not escalate, and that a failed second pass preserves successful first-pass
   assignments.
5. Add a shadow mode during development that logs Jev results beside the current
   parser without changing playback.
6. Compare the engines against the fixture corpus and real debug traces.
7. Promote Jev to primary only after the known regression corpus passes.
8. Keep the current parser for one compatibility cycle, then remove obsolete
   grammatical rules separately after the Jev path is stable.

## Security and privacy

Message content is sent through the user's configured Lumiverse Decision
connection. Credentials and endpoints remain owned by Lumiverse and are never
exposed to the extension. The extension requests only the `decisions` capability
and does not persist provider responses beyond the assignment cache and optional
local diagnostics.
