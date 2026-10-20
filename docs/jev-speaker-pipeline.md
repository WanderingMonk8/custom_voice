# Jev speaker-assignment pipeline

## Status

Design proposal for the `jev` branch. This document precedes implementation.

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

### 2. One batched Decision evaluation

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

### 4. Deterministic resolution

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

### 5. Voice routing

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
- confidence-threshold version.

Debug requests may bypass the cache. Editing a message, roster, aliases, card
title, tracker settings, or relevant upstream identity invalidates it.

## Failure and compatibility behavior

The host does not automatically retry Decision evaluations. The first release
does not add retries to the playback critical path. On failure:

1. record the classifier failure in diagnostics;
2. show a concise playback status;
3. run the current local parser as a compatibility fallback;
4. continue synthesis rather than failing the entire audio request.

Cancellation of playback aborts the pending Decision evaluation. A late answer
must never mutate an aborted playback session.

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
3. Add a shadow mode during development that logs Jev results beside the current
   parser without changing playback.
4. Compare the engines against the fixture corpus and real debug traces.
5. Promote Jev to primary only after the known regression corpus passes.
6. Keep the current parser for one compatibility cycle, then remove obsolete
   grammatical rules separately after the Jev path is stable.

## Security and privacy

Message content is sent through the user's configured Lumiverse Decision
connection. Credentials and endpoints remain owned by Lumiverse and are never
exposed to the extension. The extension requests only the `decisions` capability
and does not persist provider responses beyond the assignment cache and optional
local diagnostics.
