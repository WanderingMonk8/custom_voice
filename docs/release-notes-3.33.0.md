# Update notes — 3.33.0

**Released against main (3.30.6).** Delivered on `development`; interim tags 3.31.x existed on a feature branch and were folded in before this release.

## The short version

Per-message Jev cost goes down materially, the speaker pipeline is more accurate on tricky identity cases, and every reduction component can be withdrawn independently in Advanced settings if anything regresses in your chats. (Built on several intermediate drops that were tested in parallel before consolidation.)

## Headline changes

### 1. Token reduction for the Jev pipeline (the big one)
The TTS vocal-tag stage was the dominant share of per-message Jev spend — on a 19-speech message it can ask ~200 questions, more than the entire speaker-assignment path. It now:

- asks for the basic tag decision (primary emotion, sound, pause, style, modulation need) first,
- only asks the expensive follow-ups (secondary emotion, second sound/pause, exact positions) when the first pass shows a need,
- sends Jev a narrowed, quotation-local state instead of a window of the surrounding paragraph,
- reuses terse, shared criteria text instead of re-expanding full option descriptions on every question,
- skips auxiliary speaker reviews entirely on scenes with a clean first pass, and runs them only when an escalation trigger fires,
- defers the big cross-message relationship review on fully clear scenes,
- asks voice-matching for only 16 best candidates with terse criteria instead of 32 with full descriptions.

A comparison run (17 captures, full reduction vs pre-reduction on the same scenes) found no degradation in speaker assignment, casting, or voice routing — that is why everything shipped on by default. The escape hatches: Advanced → Token reduction, one toggle per component, any of which restores the original behavior for just that piece.

### 2. Continuity and casting got smarter
- Narration that establishes a character's appearance is now tracked and weighed alongside other clues; an explicit physical description is strong evidence when matching voices or ghost identities.
- When narration announces another voice, the speaker parse splits the run so two different people are not merged into one speaker.
- Conflict evidence is ranked instead of discarded: narration that hints one sex but dialogue hints another now degrades gracefully instead of silently dropping the clue.
- Favorite voice metadata is normalized (explicit gender tags), ghost voices whose sex conflicts with the scene are not offered, and an active ghost's voice is never reassigned to a new character.
- Anonymous runs keep communicating links discovered across the message boundary: interactivity anchors (continuity of an ongoing exchange) carry identity forward, even without names.

### 3. Build stamp
Every debug log and diagnostics line now carries `build=3.33.0`, so support and triage can see exactly which build you run.

### 4. Notes for upgraders
- No settings migration needed; global preferences survive unaffected.
- If you notice any regression after upgrading, flip individual components in Advanced → Token reduction instead of reverting the whole release.
- The debug voice-route trace is richer (per-segment reasons, review-status lines) and a little noisier — turn it off in Advanced if you're not debugging.
