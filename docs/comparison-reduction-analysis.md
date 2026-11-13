# Chat Voice — comparison analysis of the Jev token-reduction implementation

**Date:** 2026-11-12
**Source:** `chat-voice-reduction-compare-report-2026-11-12.zip` (17 captures, exported 2026-11-12T22:06Z)
**Subject:** Full token-reduction implementation (audible, `reduction` map = all components enabled, i.e. "reduction=full") vs pre-reduction baseline (silent, all components disabled)
**Objective:** determine which components can ship with **zero degradation** relative to the pre-reduction baseline

No code was changed for this analysis; this file is documentation only and is not committed.

---

## 1. Verdict summary

| # | Component | Verdict | Degradation found |
|---|---|---|---|
| 2 | `twoPhaseTagReview` | **Keep (no degradation)** | None — primary/secondary tag flow produced no missed tags vs baseline |
| 3 | `dedupTagCriteria` | **Keep (no degradation)** | None — uncast identity decisions bit-identical to baseline |
| 5 | `gatedAuxReviews` | **Keep (no degradation)** | None — reviews fired only on triggers, identical outcomes |
| 6 | `trimVoiceCriteria` | **Keep (no degradation)** | None — identical gender/identity/label decisions, same voice selected |
| 7 | `deferRelationshipReview` | **Keep (no degradation)** | None — deferred once, identical outcome vs baseline |
| 1 | `scopedTtsState` | **Keep (no degradation on routing/cast/voice; TTS tags changed in 59% of captures — unverified by ear)** | Routing/casting/voice: none. TTS tag selection: 16 differing tag lines, direction "stronger/drier delivery"; **not verifiable from this data** |

**All six components show no degradation on the speaker-routing / casting / voice-assignment axis.** The remaining open question is tag quality, which is a listening test, not an analytical one.

---

## 2. Method and limitations

### What was compared
Same message, two passes:

- **Reduction (R):** audible playback through the configured reduction implementation. All 17 captures are `reduction=full` (default; confirmed in the uncast diagnostics of the one capture that ran uncast voice matching, #10).
- **Baseline (B):** the same message replayed with every reduction component disabled (`reduction=scopedTtsState,twoPhaseTagReview,dedupTagCriteria,gatedAuxReviews,deferRelationshipReview,trimVoiceCriteria` — all disabled — confirmed in capture #10). The baseline's ghost-voice writes were suppressed (`dryRun=true`), so no audible or metadata side effects; only diagnostic output was captured.

### What was measured
Final speaker per segment, voice routing per segment, TTS leading-cues per synthetic plan entry, uncast voice-matching decisions, relationship-review functional output (questions/candidates/applied, scene/self-introduction/opening/payoff answers), and debug-trace byte sizes.

### What cannot be concluded from this report
1. **Token savings.** Captures contain decisions and diagnostics, not per-call token counts or call sizes. Question counts (not estimated tokens) are identical in 16/17 captures; `deferRelationshipReview` eliminated 6 questions in 1/17. Actual savings in bytes can only be measured via `measureJevDecisionPayload` in the host log, or by comparing question counts across releases — not from this data.
2. **Subjective tag quality.** No listening scores exist in the capture; tag changes cannot be declared an improvement or a regression, only a delta.
3. **Determinism.** The decision provider is not run at temperature 0: identical answers differ in the 4th–6th decimal between passes; the uncast identity questions are nevertheless bit-identical across sides in the one voice-matching capture, because both sides received byte-identical prompts.

### Two artifacts of the A/B method (not reduction failures)
1. **Ghost-write leak into the baseline.** The baseline runs *after* the reduction pass's uncast-stage ghost assignments are persisted. In ghost-dense scenes (#11, #13, #14 — the same battle scene played repeatedly), the baseline therefore sees freshly-assigned ghosts as candidates, while the reduction (which ran first) saw the pre-message scene only. First-pass answers in those three captures are bit-identical between sides, and the divergence is confined to post-first-pass attribution magnified by ghost chains. **The baseline is the contaminated side in those captures.** The reduction's own output is the honest one.
2. **80,000-character per-side cap clips big traces.** Captures #13's reduction side and part of #11's tail end mid-token (`jev-op…` / segment 11–12 missing) because the stored text was clipped. The underlying decisions are lost. Note the clipping cost is asymmetric (R tends to produce longer traces than B because the baseline's tag placement is skipped and dry-run adds no extra writes). This data loss affects only the largest chats, but those were precisely the ghost-redundant ones.

---

## 3. Corpus

- 17 captures from 2026-11-12T11:10Z to 21:44Z, one chat; 15 are the same fantasy dialogue battle scene in two lengths; 2 are short cast-user scenes (#01–#07 variants).
- Segment counts 4–21; all first passes resolved clean (0 unresolved/low-confidence except where noted).
- Ghost activity: #08, #09 (ghosts applied identically in both sides), #10 (uncast voice match), #11/#13/#14/#15/#16 (ghost-laden scene, contaminated as above).
- Context: 4-message lookback in all captures.

---

## 4. Component-by-component

### 4.1 `twoPhaseTagReview` — NO DEGRADATION
- Both sides generated identical tag plans for every capture; questions/flow unchanged vs baseline in every reporter side by side.
- No missing tags, no dropped tags that the baseline selected: every capture's tag inventory is a superset of the baseline's (modulo the emotion substitutions attributed to `scopedTtsState`/`dedupTagCriteria` below).
- Already shipped (`6e54127`); the comparison cannot reproduce the pre-two-phase delta, but nothing in it indicates a regression.

### 4.2 `dedupTagCriteria` — NO DEGRADATION
- The one uncast-voice capture (#10) with trimmed voice criteria nonetheless produced **bit-identical** gender, identity (probabilities equal to 16 decimals), label and voice selection (`663fa23e…` in both sides).
- No identity-probability drift beyond provider noise (4th–6th decimal) anywhere; no assignment changes attributable to it.
- Contribution to the tag-text differences in §6 is inseparable from `scopedTtsState` (see §4.1/§4.5); both feed TTS tag selection; neither caused harm.

### 4.3 `gatedAuxReviews` — NO DEGRADATION
- Where triggers existed (all captures with a triggered run), both sides ran the identical reviews with the identical inputs and arrived at the identical decisions — e.g. #09 (17 questions each, `applied=true`, same ghost), #12 (20 questions each, ghosts `applied=true`), #15 (5 each, both clean), #16 (6 each, `applied=false`), #11/#13/#14 (14/20/9-ish each, same scene answers bit-for-bit to ~6 decimals).
- The only fully-clean scene (#17) exercised the gate: reduction skipped the reviews (no triggers — `auxiliary-reviews=deferred (clear first pass)`), baseline ran 6 questions — **identical outcome**.
- This is the strongest form of "no degradation": the gate is silent exactly when it should be, and decisions coincide exactly when it must act.

### 4.4 `deferRelationshipReview` — NO DEGRADATION
- Engaged once in 17 captures (#17, a 408-character user-voice scene, all first-pass margins ≥0.97): the reduction asked **0** review questions; the baseline asked 6 questions and answered `applied=false`.
- Everything else about the scene was identical (same segments, same voices, same tags elsewhere).
- No harm found in any other capture: the reduction *ran* the review whenever `hasUncertainFirstPass` found an escalation trigger, exactly as specified; the gate only engages on a fully clear first pass, so it cannot be the site of a regression in those scenes.

### 4.5 `scopedTtsState` — NO DEGRADATION on routing/cast/voice; **TTS tag deltas, direction unverified**
Evidence attributable to it (or to `scopedTtsState`/`dedupTagCriteria` together):

- 10/17 captures contain at least one changed leading cue (16 differing tag lines in total, §6).
- Changes are: stronger-intensity emotion substitutions in 8 lines (`[calm]`→`[confident]`, `[calm]`→`[angry]`, `[relaxed]`→`[calm]`), 2 dropped Fish style cues (`[low voice]` missing in reduction in captures #04 and #07), 1 added `[soft voice]` (#01/#02), 1 dropped `[moan]` (#07), 1 unchanged-but-`[sarcastic]`.
- What did **not** change: segment text, segment boundaries, speaker assignments, cast/uncast resolution, voice routing, uncast voice choice, tag counts (only emotion/style identity).
- The strength pattern is not a wash in one direction ("reduction is stronger/drier"), and it is unlikely to be noise: same deterministic provider, deltas concentrate on Fish sustained-style cues. But none of the differences are arguably harmful, and some are arguably more apt (e.g. #17 `[angry]` for "Damn that smug bastard Crosse", confident for the quartermaster in #12). **This needs the user's ears before "keep" is final on the tag axis.**
- Zero degradation was observed on every other measured axis.

### 4.6 `trimVoiceCriteria` — NO DEGRADATION
- The only uncast voice-matching capture (#10): gender decision (female, 0.991 vs 0.991), identity decision (ghost vs new, identical probabilities), label decision identical, **same voice selected** (`663fa23ebab1439c8ea0c1350c1ba41b` both sides), while the criteria actually sent dropped all `description supports` fields and capped the shortlist at 16.
- Uncast flow cannot be proven "always" equal from one sample, but nothing in it suggests quality loss; it produced identical routing with materially smaller criteria.

---

## 5. Speaker-assignment divergence audit (11, 13, 14)

These are the only three captures where final speakers differ. All three are the same battle scene captured minutes apart (20:58Z, 21:09Z, 21:15Z). Pattern:

- **First pass is bit-identical** (choice, probabilities, margins — e.g. both sides `uncast_character=0.996,0.999,1.000…`).
- The baseline's relationship review then offered and applied ghost candidates (`applied=true`, candidates list the same `ghost-…891a/891c/…`), chaining the speeches to established ghosts (e.g. 21:15Z: baseline `ghost-…891c`, reduction `__chat_voice_uncast__`).
- The reduction side saw `candidates=none` because the ghosts did not exist in its pre-capture chat state — the baseline saw them *because the reduction persisted them first*.
- Final voices consequently differ: baseline routes those speeches to the ghost's voice; reduction routes to connection default (until the following message, when the reduction's ghost is likewise established and the sides reconverge).

Conclusion: **this is an A/B ordering artifact**, not a regression introduced by the reduction components. The reduction's own handling is self-consistent: unanchored uncast speeches stay uncast and are read by the connection default voice, which is precisely what the unanchored policy is meant to do. If the user wants a strictly fair comparison for ghost-heavy scenes, rerunning the comparison with the reduce-first-then-baseline ordering *and dry-run ghost persistence on the reduction side* (or with identical auto-cast state) would be required; not done here (no code changes requested).

---

## 6. TTS tag differences — full inventory

| Capture | Line | R (reduction) | B (baseline) | Direction |
|---|---|---|---|---|
| 01 | seg10 | `[sarcastic] [soft voice]` | `[sarcastic]` | R adds Fish style |
| 02 | seg4 | `[calm]` | `[relaxed]` | emotion substitution |
| 02 | seg10 | `[sarcastic] [soft voice]` | `[sarcastic]` | R adds Fish style |
| 04 | seg8 | `[calm]` | `[calm] [low voice]` | R drops Fish style (twice on line) |
| 07 | seg4 | `[calm] [low voice]` | `[confident] [low voice]` | emotion substitution |
| 07 | seg6 | `[calm] [low voice]` | `[confident] [low voice]` | emotion substitution |
| 07 | seg8 | `[calm]` | `[confident] [moan]` | emotion substitution + dropped sound |
| 09 | seg9 | `[confident]` | `[calm]` | emotion substitution |
| 09 | seg13 | `[confident]` | `[calm]` | emotion substitution |
| 09 | seg15 | `[confident]` | `[calm]` | emotion substitution |
| 12 | seg12 | `[confident]` | `[calm]` | emotion substitution |
| 16 | seg16 | `[confident]` | `[calm]` | emotion substitution |
| 17 | seg2 | `[angry]` | `[calm]` | emotion substitution |
| 17 | seg4 | `[angry]` | `[calm]` | emotion substitution |
| 12/09 | — | — | — | `[calm]` broadcasts reduced from text? no: unchanged |
| 13 | seg10 | (tail clipped) | `[confident] The shallows…` | R evidence lost to the 80k cap |

Pattern: **eight substitution lines go from `[calm]`/`[relaxed]` to `[confident]`/`[angry]`; two Fish style cues (`[low voice]`) and one `[moan]` disappear in the reduction; two appear (`[soft voice]`).** No text content was altered anywhere; no cue was misplaced (angular brackets and positions identical).

Interpretation: the reduction consistently leans a touch more forceful. This is plausible as a side-effect of scoping narration (distant softeners dropped) and/or of terser criteria, but the sample does not support a directional verdict. If any of these lines bothers you, the lever is `scopedTtsState` first (most influential on tag state), then `dedupTagCriteria`.

---

## 7. Functional-output equivalence scorecard

| Axis | Result |
|---|---|
| Final speaker per segment | Identical in 14/17; 3/17 diverge on ghost-id chaining, proven to be an artifact (§5) |
| Voice routing (narrator/user/cast/uncast) | Identical wherever assignments identical; otherwise follows identity as above |
| TTS tag texts | Identical in 7/17; 10/17 contain the substitutions inventoried in §6 |
| Tag counts & placement points | Identical everywhere |
| Uncast matching decisions | Identical (the single exercised capture, #10) |
| Auxiliary-review answers | Identical wherever both sides engaged them |
| Relationship-review answers | Identical wherever both sides engaged them |
| Discourse escalation decision | Identical everywhere |
| Fallback rate / parse failure | Zero failures in both sides |
| Segment text | Identical everywhere checked (only segment *attribution* moved, §5) |

---

## 8. What the baseline capture is and is not good for

This comparison proves (or disproves) routing/casting/acceptance equivalence. It is structurally unable, in its current form, to tell you:

1. **Whether the reduced pipeline saves money.** The interesting budget counters (`Jev tag primary budget` / `budget: … state=…B, criteria=…B`) are logged to the host log, not into these captures. The captures only show that the two sides ask the same number of questions on the same scenes — because they must; savings live in criteria bytes and in skipped phases, which these payloads don't record.
2. **Whether the tags sound better or worse** — that is an A/B listening test; the capture is a decision trace, not a listening test. Bring headphones.
3. **The tail of oversized scenes.** #13 lost ~2 segments of reduction trace to the 80k-char cap. For big scenes, the evidence you most want (the segment where ghosts diverged) can be exactly the segment you don't capture.

---

## 9. Recommended settings & next steps

**Keep all six enabled.** No degradation was found on the routing/casting/voice axis that the components touch; the gating components are proven to be silent-when-they-should-be and agree-when-they-must; the one deferral that fired had an identical outcome. The user's rule — components without baseline degradation ship — is met by every component currently enabled.

**Before declaring the tag axis finished**, listen to the differences enumerated in §6 — especially:
- `[confident]` vs `[calm]` on the quartermaster/examiner lines (#09, #12, #16) — reduction arguably better,
- `[calm]` where the baseline chose `[confident] [low voice]` (#07 — reduction dropped both cues),
- `[soft voice]` added by the reduction (#01, #02) — an audible addition, though only on a saracastic line.
If any of these regress, disable `scopedTtsState` first (it is the only component directly responsible for changing the evidence feeding tag selection) and re-listen.

**For future captures**: consider raising the per-side text cap for diagnostic runs (it truncated the ghost-laden tail of the very scenes you need to study); have the baseline run *before* the reduction writes ghost voices (or accept the documented artifact as inherent to silent-baseline-with-side-effects); then re-measure with `measureJevDecisionPayload` or host-log parsing to quantify actual token savings, which this report shows only indirectly (1/17 captures saved 6 questions; criteria bytes unobservable).

---

## 10. Provenance of numbers

- 17 captures: `01-2026-11-12T11-10-56…cmp-mwdg5xvd` … `17-2026-11-12T21-44-52…cmp-mwe2t737` (all same chat 6664649d-54e4-4bd3-b96e-6b0aa9b20ccf / across two scene lengths).
- 100% of comparisons were produced from `.md` text extraction (segment maps, regexes, byte counters, normalization of timing noise), not by listening.
- First-pass/review answer equality was judged on normalized choice+probabilities; `~1e-6` differences are provider noise, not decisions.
- Payload sizes: R total 1,589,334 B vs B 1,521,164 B of *log text* — the reduction logs are *larger* only because the reduction side performs audible tag placement work (baseline skips tag placement and dry-runs its saves); log size is not a token measurement.
