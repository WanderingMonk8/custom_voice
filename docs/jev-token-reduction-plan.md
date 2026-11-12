# Jev token-reduction plan

**Branch:** `jev-trim`  
**Date:** 2026-11-11  
**Scope:** Jev / `spindle.decisions.evaluate` usage in Chat Voice, with emphasis on speaker interpretation and TTS tag selection.

This is a reduction proposal, not an implementation. It is based on the current source tree and on representative debug logs. Exact provider billing is unavailable because `spindle.decisions.evaluate` returns answers and timing, not token usage.

---

## Executive summary

The dominant Jev cost is not the speaker parser’s first pass. It is the TTS tag-selection stage.

For a short message, the speaker pipeline usually sends one or a few requests and asks 20–55 questions. The TTS layer asks several questions **per speech**, re-sends the full current message for each TTS chunk, and produces a probability distribution for many expensive sound/emotion options.

On a 19-speech message, Fish + modulation can issue **209 questions** through roughly one request per speech. The entire speaker-assignment path is around 20–55 questions by comparison.

### Expected outcome

Implementing the low-risk portions of this plan should reduce total per-message Jev cost by roughly **35–55%**, with the TTS layer accounting for most of the reduction. More aggressive phases could reach **50–70%**, but those changes need stricter quality measurement.

---

## Current state and cost profile

### Questions emitted per speech, by TTS mode

| Question | Gemini | Gemini 3.8 | Fish | Fish + modulation |
|---|---:|---:|---:|---:|
| `emotion_*` / `emotion2_*` | 2 | 0 | 2 | 2 |
| `style_*` | 0 | 0 | 1 | 1 |
| `modulation_*` / `modulationpos_*` | 0 | 0 | 0 | 2 |
| `tag_*` / `tag2_*` | 2 | 2 | 2 | 2 |
| `tagpos_*` | 1 | 1 | 1 | 1 |
| `pause_*` / `pause2_*` | 2 | 2 | 2 | 2 |
| `pausepos_*` | 1 | 1 | 1 | 1 |
| **Per speech** | **8** | **6** | **9** | **11** |

For 19 speeches:

- Gemini: **152 questions**
- Gemini 3.8: **114 questions**
- Fish: **171 questions**
- Fish + modulation: **209 questions**

### Payload duplication

The current TTS design also duplicates expensive state:

- The full current message is included in the tag-planning state.
- The plan is built once per chunk.
- Each chunk is evaluated by a separate Jev request.
- The criteria for sound options, emotion lists, and boundary lists are repeated for every speech.
- Responses contain probabilities for many options.

The speaker parser sends the full message once, but TTS sends it many times.

### Relative ranking on a larger message

| Rank | Step | Typical profile |
|---|---|---|
| 1 | **TTS tag selection** | Highest cost; hundreds of questions and repeated state |
| 2 | **Uncast voice matching** | Potentially high; identity and voice selection use separate calls |
| 3 | **Relationship / global speaker review** | Moderate-to-high; 7–32 questions with large context |
| 4 | **Speaker first pass** | Moderate; 20–55 questions |
| 5 | **Auxiliary reviews** | Modest unless triggered frequently |
| 6 | **Auto-cast** | Large one-time cost, but not incurred per message |

The second tier is still significant. An uncast match can have multiple expensive candidate descriptions and probability distributions.

---

## Measurement gaps

The exact prompt size and token use are not exposed to the extension today.

The first phase of any reduction should therefore add a measurement mode before changing behavior. Recommended measurements:

1. Questions per request
2. Serialized bytes of `state`, `questions`, and probability distributions
3. Calls per generation
4. Bytes per call
5. Total questions per message
6. Jev latency
7. Number and rate of fallback answers

Serialized byte size is a useful proxy for prompt cost and is immediately available in process.

---

## Reduction principles

The plan should preserve the pipeline’s central guarantees:

- Narration remains narrator voice.
- Unresolved speech remains understandable and does not become narration.
- Confirmed cast identities remain stable across messages.
- Unnamed speakers can remain unnamed without being forced onto random cast voices.
- A tag is not inserted unless Jev establishes a plausible need.
- Sparse metadata, including missing Fish tags, must not be treated as evidence against a voice.
- Low-confidence guesses must not become anchors for later turns.

Any change that causes more of those properties to fail is not simply “cheaper”; it shifts cost into incorrect audio and user correction.

---

# Reduction plan

## Phase 0 — Instrumentation and baseline quality tests

### Goal

Establish a reproducible before/after measurement, not just a plausible reduction.

### Changes

1. Add an internal measurement mode that logs:
   - calls per step
   - questions per call
   - serialized state bytes
   - serialized criteria bytes
2. Keep the current behavior unchanged behind a feature flag.
3. Build a fixture set covering:
   - named-cast dialogue,
   - one unresolved speaker,
   - multiple unnamed speakers in the same exchange,
   - cached and uncached Fish tag paths,
   - clean and malformed narration boundaries.

### Acceptance criteria

- Known message bytes per step are reported.
- Speaker decisions, tag decisions, unresolved rate, and fallback rate are recorded.
- The current parser suite can be run against the fixture set unchanged.

### Why first

Without measurement, reductions will look successful even when absolute savings are tiny.

---

## Phase 1 — Low-risk payload reduction

### 1. Scope TTS tag state to the target speech

### Problem

TTS sends the full current message for every tag request. The questions are explicitly local and only need the quotation and nearby narration.

### Change

Each tag request receives:

- the current quote text,
- its directly relevant `narrativeBefore`,
- its directly relevant `narrativeAfter`,
- speaker-related context from adjacent speeches if useful,
- cached emotion continuity status.

It does not receive the entire current message.

### Expected impact

- Very large reduction in repeated TTS input.
- Likely the largest single savings in this plan.

### Risks

- The model loses broad scene meaning.
- Continuity across distant passages may weaken.
- Tone hints in a distant line might be missed.

### Mitigation

- Retain short local speeches rather than removing all surroundings.
- Keep explicit interactivity anchors for adjacent speeches.
- Only ship after tag quality is compared against baseline.

### Rollout criterion

New tag output should retain at least **90% equivalent emotion/timing choices** on a fixed corpus. Any mismatch should be inspectable, not just an aggregate score.

---

### 2. Collapse repeated TTS reasoning into fewer questions

### Problem

The current path evaluates primary, secondary, positional, and no-op choices for every speech.

### Change

Split selection into a cheap first pass and a conditional second pass:

#### First pass

Only ask for choices that are almost always necessary:

- primary emotion,
- whether a sustained style is needed,
- whether there is a sound effect,
- whether a pause is needed,
- whether modulation occurs.

#### Second pass

Only for speeches where the first pass establishes a need:

- secondary emotion,
- second-position question,
- exact position,
- secondary pause,
- modulation position.

Speeches with an unequivocal “none” skip the second phase.

### Expected impact

- 40–60% fewer tag questions on ordinary dialogue.
- Large reduction in probability-response output.

### Risks

- Missing subtle expression.
- A true-but-rare tag might disappear.
- The two-phase path has to be disabled when the first pass is ambiguous.

### Mitigation

- Use conservative thresholds.
- Do not require a full distribution for obvious none cases.
- Keep the current path for `debug` and regression tests.
- Measure the percentage of normally silent lines that become directly labeled.

### Rollout criterion

Complete successful delivery with no obvious increase in:

- neutral read-alouds that should have a tag,
- delayed or duplicated pauses,
- wrongly placed sound effects.

---

### 3. Deduplicate tag criteria

### Problem

TTS criteria restate the same option list and similar rules on multiple questions.

### Change

Create shared, terse criteria blocks and reference them from related questions instead of copying the fully expanded text.

Examples:

- sound effect rules shared by primary and secondary selections,
- emotion definitions shared by primary and secondary emotion.

### Expected impact

- Moderate savings with little behavioral drift.

### Risks

- Jev may rely on verbatim criteria redundancy.
- Shorter definitions can create ambiguous labels.

### Mitigation

- Keep all ambiguity-bearing options explicit.
- Bench against current output before accepting.

---

### 4. Treat TTS cache misses as a separate failure mode

The Fish tag LLM placement step is not the same billing problem as Jev, but it still contributes dialogue latency. It should not be included in the Jev savings report, but should be tracked alongside it.

No reduction is proposed here.

---

## Phase 2 — Moderate-risk structured reductions

### 5. Gate auxiliary speaker reviews

### Problem

Some reviews run whenever a builder finds candidates, even when they are unlikely to change the final reading.

Examples include:

- best-available speaker guess,
- self-introduction review,
- speaker-switch review,
- selected contrastive or focused opening reviews.

### Change

Require a trigger condition such as:

- unresolved or conflicting initial answers,
- new unnamed speaker in an otherwise resolved run,
- continuity challenge after a named reveal,
- no early identity in an opening run.

Purely informational contests remain local.

### Expected impact

- Moderate token savings.
- Reduced latency on already clear scenes.

### Risks

- More errors in difficult ambiguous exchanges.
- The model may make an identity mistake that a secondary review would have corrected.

### Mitigation

- Never gate first-pass constraints based only on saving money.
- Keep auxiliary review available when continuity evidence is missing.
- Reintroduce it automatically when auxiliary results repeatedly change routing in practice.

---

### 6. Reduce uncast speaker criteria repetition

### Problem

Voice matching asks many favorites in parallel rather than sending a progressively narrower candidate list.

The same metadata may also be repeated in ghost context and in the identity criteria.

### Change

1. Remove `context` from the identity criteria when it is already in the state.
2. Shortlist compatible voices by:
   - gender,
   - age if established,
   - tags only when clearly justified,
   - preferred language if relevant.
3. Use a small shortlist rather than 32 candidates whenever possible.

### Expected impact

- Moderate savings.
- Lower output probability distributions.

### Risks

- Lower diversity—the exact issue being solved.
- Sparse-metadata candidates may be pushed out.
- Fewer alternatives increase pressure toward the most familiar voice in the pool.

### Mitigation

- Never exclude a voice because metadata is missing.
- Keep at least a moderate diverse shortlist.
- Prefer category-based filtering over tag exclusion.
- Do not treat unsupported metadata as evidence against a voice.

---

### 7. Defer relationship review globally

### Problem

The global speaker review handles many questions that do not need cross-message context.

### Change

Only escalate if the local exchange contains one of:

- a new unnamed speaker,
- a scene or setting shift,
- an unclear actor/addressee pair,
- a continuity mismatch,
- an uncertain speaker switch.

Routine confirmed dialogue remains with the first pass.

### Expected impact

- Moderate savings.
- Less latency for clean multi-speaker messages.

### Risks

- More errors in unusual openings and scene changes.
- Local continuity mistakes may survive until synthesis.

### Mitigation

- Keep clear escalation triggers.
- Do not fall back to the card-title character when identity remains weak; leave speech unresolved instead.

---

## Phase 3 — Structural rework only if necessary

### 8. Replace always-on secondary questions with a smaller question set

Potentially redundant questions:

- `emotion2_*`,
- `tag2_*`,
- `pause2_*`,
- `modulation_*`,
- `modulationpos_*`,
- `pausepos_*`.

### Change

Fold obvious “none” answers into a smaller set of negative outcomes and ask for a secondary decision only when a provider flags one clear secondary event.

### Expected impact

- Very high savings.

### Risks

- This is a substantial behavioral change.
- It is likely to flatten expressive audio if implemented too aggressively.
- It needs strong manual sign-off on a non-trivial corpus.

### Mitigation

Keep opt-in outside default builds until the audio quality metrics are proven.

---

### 9. Prefilter candidate voices by metadata, not by guesswork

This is conceptually useful but likely unnecessary while the voice pool already filters:

- used voices,
- reserved voices,
- unsupported gender,
- unsupported Gev shortlist thresholds.

### Expected impact

- Small.

### Risks

- Reduced voice diversity.
- Sparse metadata ranks lower.
- All authors receive fewer new voices—the exact failure this project is addressing.

### Recommendation

Do not pursue until measured data proves a material benefit.

---

## Not recommended as token optimizations

These would reduce prompt size but trade off disproportionate accuracy:

1. Removing role-labeled user/assistant prefixes.
2. Reducing the relationship instruction sufficiently to lose actor/addressee distinction.
3. Forcing a named cast speaker before local evidence establishes one.
4. Collapsing all ghost identities into the nearest known character.
5. Making unresolved speech inherit narration.
6. Removing ghost `interactivityTrail` merely to save context.
7. Reducing voice diversity by forcing the top few favorites.
8. Replacing “unresolved” with “card-title speaker” whenever the user appears in a message.

These look like cheap wins but break the speaker pipeline’s value proposition.

---

## Measurement plan and success criteria

### Metrics

Compare before and after on identical messages:

| Metric | Target |
|---|---|
| Total serialized prompt bytes | ≥35% reduction |
| Jev calls per message | ≥30% reduction |
| TTS questions per speech | ≥40% reduction |
| Tag choice agreement | ≥90% exact or equivalent |
| Speaker identity agreement | ≥95% |
| Clear card identity agreement | 100% |
| Unresolved rate | No material increase |
| Fallback answers | No material increase |
| Voice-reuse rate for unnamed speakers | No regression in repeated casting |

### Message corpus

Include at least:

- a short confirmed named-cast scene,
- an unnamed exchange where one speaker becomes named later,
- a contrasting unnamed pair in the same dialogue run,
- an intentional interrupted opening,
- a raw voice identification,
- a scene where all lines are neutral.

### Review procedure

1. Capture baseline outputs using the current formula.
2. Apply one phase at a time.
3. Compare token-proxy and behavior.
4. Keep a single feature flag and compare full output character-for-character enough to detect changed voice assignment.
5. Any missed speaker identity, unresolved fallback, or voice collision is a release blocker.

---

## Recommended implementation order

| Order | Change | Expected impact | Risk | Recommendation |
|---|---|---|---|---|
| 1 | Restrict TTS state to target speech | Largest reduction | Low | Ship after fixture parity |
| 2 | Two-phase tag questions | Major savings | Medium | Ship behind flag |
| 3 | Deduplicate TTS criteria | Moderate reduction | Low | Ship with 1–2 |
| 4 | Sub-toggled conditional secondary questions | Additional large savings | Medium-high | Ship after fixtures |
| 5 | Gate auxiliary reviews | Moderate savings | Medium | Ship only with safeguards |
| 6 | Reduce uncast voice shortlist | Moderate savings | Medium | Optional |
| 7 | Full question-set collapse | Very large savings | High | Do not default |
| 8 | Metadata pre-filtering | Small | High | Do not prioritize |

---

## Constraints and rollout

The rollout should not change:

- `spindle.json` permissions,
- TTS vocal tags mode,
- choice option IDs,
- `no_match`/fallback semantics,
- ambiguity-bearing base questions,
- evidence-qualified identity updates.

Use internal feature toggles so behavioral rollback is immediate:

1. standard path,
2. local-scope TTS state,
3. conditional secondary questions,
4. both.

Each toggle must be removable without changing output behavior.

---

## Expected benefit

### Rough savings model

Assuming a normal mixed message with 20 speeches:

- TTS currently dominates the cost.
- Restricting state can remove most repeated context.
- Conditional secondary questions removes a large fraction of question cost.
- Criteria deduplication removes the remainder of template duplication.

### Likely range

Total Jev savings of approximately:

- **35–55%** from conservative implementation,
- **50–70%** from adding conditional secondary questions,

with no reduction from manual Auto-cast unless that feature is separately addressed.

Auto-cast remains a separate optimization pass because it is manually triggered, not run for every ordinary message.

---

## Summary

The first change to make is not a speaker-review change. It is a TTS change.

The pipeline is spending disproportionate Jev budget re-reading text for short, highly constrained tag choices. The reduction path that matters is:

**Scope state → evaluate secondary choices only when needed → deduplicate criteria → gate only genuinely avoidable reviews.**

The speaker identity pipeline is useful enough already. It should not be distilled into a cheaper set of questions that lose voice attribution across messages to save a few percent of prompt tokens.

---

## Implementation status (v3.31.0)

Landed as the **token reduction** implementation. Each plan component below is a global setting, toggleable independently in the Advanced section; turning a component off restores the pre-reduction behavior for that component alone. The comparison mode (also in Advanced) routes audible playback to the configured reduction implementation while running the pre-reduction pipeline silently in parallel; both outputs land in a capped rolling report (20 captures) stored in the global voice settings under `chatVoiceReductionCompareReport` and downloadable as a ZIP via "Download report". The report survives extension updates and reinstalls.

| # | Plan item | Component id | Status |
|---|---|---|---|
| 1 | Scope TTS tag state to the target speech | `scopedTtsState` | Implemented: narration sent to Jev is sliced to a 320-character quotation-local window (`TTS_NARRATION_WINDOW`), newest-first. |
| 2 | Conditional secondary questions | `twoPhaseTagReview` | Implemented (6e54127); off reverts to the single-pass `all` plan. |
| 3 | Deduplicate tag criteria | `dedupTagCriteria` | Implemented: shared terse criteria (first sentence only) are sent for emotion, sound, style, pause and boundary questions. |
| 5 | Gate auxiliary speaker reviews | `gatedAuxReviews` | Implemented: auxiliary reviews (user-review, contextual reconciliation, opening re-read, opening backlink, self-introduction, speaker-switch, best-available) are skipped on a clear first pass (`hasUncertainFirstPass`) and run on any escalation trigger. |
| 6 | Reduce uncast voice shortlist / criteria | `trimVoiceCriteria` | Implemented: voice ranking criteria drop `description` and `description supports`, the shortlist is capped at 16, and the ranking instructions match the trimmed criteria. |
| 7 | Defer relationship review globally | `deferRelationshipReview` | Implemented: the relationship review is skipped when no escalation trigger exists; first-pass answers remain authoritative and the decision is logged as `relationship-review=deferred (clear first pass)`. |
| 4 | Fish tag LLM placement as a separate failure mode | - | Not applicable to Jev cost; unchanged. |
| 8 | Structural Phase 3 (fold secondary questions) | - | Not implemented; excluded per plan's own risk guidance. |
| 9 | Prefilter voices by metadata | - | Not implemented; excluded per plan's recommendation. |

Instrumentation (Phase 0) exists through `measureJevDecisionPayload` and the `[Chat Voice] Jev tag budget` log lines; comparison captures additionally record the full reduction and baseline debug reports side by side.
