# Reader-inspired speaker identification: rough design

## Status and goal

This is a proposed design, not a description of the current implementation. The goal is to improve speaker identification by using the kinds of evidence a reader uses: conversational context, participants and their roles, references in narration, turn relationships, and later clarification. The goal is not to reproduce a reader's reasoning step by step.

For each speech, the system should identify the character who produced it and route it to that character's voice. A person mentioned in the speech, its addressee, an actor in nearby narration, a background character, the author of the chat message, and the previous speaker may all provide evidence, but none is automatically the speaker.

The system must be able to return **unclear**. An unresolved line is preferable to confidently assigning it to an unrelated cast member.

## Context and boundaries

Build a bounded, chronological context for each target message containing:

- The preceding user and assistant messages, initially six total, using the existing global-context setting.
- The complete target message, including later text that may clarify an earlier quote.
- Known cast members and active temporary voices, including aliases.
- Relevant prior voice assignments and temporary-voice history, explicitly marked as previous interpretations rather than facts.
- Card information, including a single-character preference where appropriate.

Retain each message's role. A user message may contain the user's speech, narration, quoted text messages, and references to other characters; its author is not automatically the speaker of every quotation in it.

Use only earlier chat messages by default. The review may look forward within the target message, but not into later chat messages. This supports out-of-order playback and avoids leaking future information. Retrospective reinterpretation using later messages is a separate design decision.

## Lightweight scene representation

For dialogue requiring review, construct a provisional scene picture rather than an exhaustive, permanent model of everyone mentioned. Record, when supported:

- **Identity:** regular cast, temporary voice, unnamed person, user persona, or unclear.
- **References:** names, aliases, titles, relationship labels, and pronouns.
- **Presence:** in the immediate scene, off-scene, present by phone or text, or uncertain.
- **Participation:** active speaker, addressee, nearby actor, background person, or uncertain.
- **Actions and objects:** for example, Ewan carries a tray and turns back.
- **Evidence and confidence:** the supporting text and strength of the proposed link.

Roles can overlap and change. Someone initially in the background may later speak; an addressee may respond. Do not lock those roles for the whole message.

### Narration as identity anchors

Narration is still read by the narrator. Its references and actions can inform nearby speech attribution without automatically determining it. For example, “Tessa sets her chopsticks down” establishes an action and may support a later reference to “she,” but does not prove Tessa spoke the nearest quotation.

A paragraph may have multiple relevant anchors. In the dining-hall example, the roommate, the guy, and Tessa each act. A single paragraph-level speaker cannot represent all three relationships. When a pronoun or action cannot be resolved reliably, retain the uncertainty.

## Conversation runs and channels

Group nearby speeches into provisional conversation runs based on topic, participants, actions, turn relationships, and channel cues—not paragraph breaks alone. A message can contain an in-person conversation, a phone or text exchange, and a separate table conversation.

Treat someone leaving, a phone buzzing, a time jump, or another conversation becoming prominent as possible boundaries, not automatic proof of a new speaker. A person can speak while leaving, and an interrupted exchange can resume.

## Bridging message boundaries

When an assistant message opens with an unnamed speech, compare it with the relevant preceding exchange, including the preceding user message. Consider:

- Whether the opening quote continues or answers a recent statement.
- Who spoke that statement and whom they addressed.
- Whether an action or object connects a person across the boundary.
- Whether the opening introduces a new scene, interruption, or different channel.

The cross-message relationship may be continuation by the same speaker, response by the addressee or another participant, interjection by another person, an unrelated exchange, or unclear. A relationship is not itself an identity: a response does not prove which participant responded.

### Ewan example

Ken addresses Ewan about sacrifice; the next message opens with “Sacrifice”; and a person holding the tray turns back. The content of the response, the addressee, and the tray jointly support Ewan. The person who sidesteps the tray is a nearby bystander and is not thereby established as a speaker. No single clue, including the tray, has to prove the identity on its own.

## Resolve a connected exchange

Evaluate ambiguous speeches within a run together rather than as unrelated lines. Use the speech content and topic, candidate speakers and addressees, adjacent turn-relation scores, narrative anchors, pronouns, participant arrivals and departures, channels, and later clarification in the target message.

Each speech still receives its own result. A run-level interpretation should promote consistency without forcing every line onto one voice. In particular, “Ken addresses Ewan” does not mean Ken speaks next, and “a stranger sidesteps Ewan” does not mean the stranger joined the conversation.

## Re-read and revise

Later text in the target message may name an earlier unnamed person or clarify a pronoun. The review may revisit an earlier uncertain or conflicting speech when the intervening text supports the link.

Safeguards:

- A later name only applies backward when the text supports the same identity.
- A newly arriving character does not automatically claim prior lines.
- Scene and channel changes block unsupported continuity.
- Later explicit attribution should outweigh an earlier weak guess.
- A previous audio assignment cannot override better textual evidence merely because it was saved.

This is a bounded re-read of the target message, not a recursive search through the entire chat.

## Cast, temporary voices, and saved occurrences

First identify **who** is speaking; then resolve **which voice** to use. The review should support regular cast, existing temporary identities, newly identified unnamed characters, the user persona, and unclear identities.

Aliases should map to the same underlying identity when evidence supports that mapping. When an unnamed temporary character later gains a name, review whether the name and existing temporary identity are the same person, and preserve the voice when justified.

A saved exact occurrence is evidence of a previous assignment, not proof that the assignment was correct. If earlier generation wrongly associated an occurrence with Halloran, a later contextual review must be able to question or replace it rather than reinforce it automatically.

## Card and history preferences

A genuine single-character card may provide a modest preference when the scene is otherwise compatible. It must not force an assignment or artificially inflate a model probability after the fact. A world or multi-character card title is not automatically a speaker.

The last speaker is likewise a contextual clue, not a blanket inheritance rule. An addressee, action, pronoun reference, channel change, or explicit attribution can point elsewhere.

## Confidence and conflicts

- Prefer clear direct attribution unless there is an explicit contradiction.
- Permit a contextual assignment when multiple mutually reinforcing clues support it and the review is sufficiently confident.
- Treat a single weak clue as evidence rather than an assignment.
- When interpretations conflict, select the better-supported one only when the review can distinguish them; otherwise leave the speech unresolved.
- Reconsider a saved identity when it conflicts with current text.

Do not fabricate numerical certainty. Repeating similar questions does not necessarily provide independent evidence, and model judgments should not be treated as deterministic facts.

## Debugging and evaluation

For each reviewed speech, diagnostics should distinguish model judgments from deterministic rules and show, where available:

- The speech, run, and channel.
- The relevant preceding exchange.
- Candidate speakers and participant roles.
- Narrative anchors and reference links.
- Turn relationship to adjacent speech.
- Later evidence in the target message.
- Chosen identity, alternatives, confidence, and conflicts.
- Whether a saved occurrence was reused, questioned, or rejected.
- Why a speech remained unresolved.
- Context size and review duration; token usage when the provider reports it.

The desired diagnostic for the Ewan example would say that Ken addressed Ewan about sacrifice, the tray carrier turned back, the opening line appears to respond, and the person sidestepping the tray is not established as speaking. This is a desired diagnostic structure, not a claim about current behavior.

## Cost and latency

Do not construct a complete scene model for every message by default. Initially target ambiguous or structurally suspicious runs, including unnamed opening replies, low-confidence or conflicting assignments, potential bystander confusion, phone/text and in-person channel changes, contradictory saved temporary identities, and later attribution that could clarify an earlier quote.

Batch the questions needed for a run where possible, and replace overlapping review work rather than adding a long sequence of calls. Bound both message history and temporary-voice context.

Measure call count, payload size, provider-reported tokens where available, time to the first affected speech, and total processing time. A single batch is not necessarily cheap: the provider may process shared context separately for each question. Live measurements are needed before claiming a latency or cost improvement.

## Proposed implementation stages

1. **Cross-message opening review:** Connect an ambiguous opening run to the preceding user/assistant exchange using speech content, addressees, actions, and references.
2. **Run-level scene evidence:** Represent active participants, bystanders, and channel boundaries for targeted runs, distinguishing acting from speaking.
3. **Bounded re-read:** Use later text in the target message to revise earlier unresolved or conflicting assignments.
4. **Identity and voice reconciliation:** Make ghost aliases and saved occurrences revisable when current evidence contradicts them.
5. **Measurement and tuning:** Compare accuracy, unresolved rate, latency, and provider-reported token usage on representative logs.

Before making the approach the default, evaluate it against the Ewan/Tessa exchange, Halloran's closing line, the caller later identified as Marisol, mixed-speaker scenes, and out-of-order playback. Improving one case should not come at the expense of the others.

The central principle: **context establishes relationships, and relationships inform a speaker decision—but no single relationship automatically becomes the speaker.**
