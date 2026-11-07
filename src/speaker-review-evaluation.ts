/** Offline evaluation of labeled speaker decisions. No conversation text is required. */
export type SpeakerEvaluationCase = {
  id: string
  conversation: string
  expected: Array<string | null>
  baseline: Array<string | null>
  candidate: Array<string | null>
  baselineMs?: number
  candidateMs?: number
}

type Scores = { total: number; correct: number; incorrect: number; unresolved: number; unresolvedExpected: number; milliseconds: number[] }

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil(sorted.length * p) - 1]
}

/** Validate the complete input before producing aggregate output. Null means unresolved. */
export function evaluateSpeakerReviews(input: unknown) {
  if (!Array.isArray(input) || !input.length) throw new Error('Expected a non-empty array of evaluation cases.')
  const cases = input as SpeakerEvaluationCase[]
  const ids = new Set<string>()
  const conversations = new Set<string>()
  const scores = (): Scores => ({ total: 0, correct: 0, incorrect: 0, unresolved: 0, unresolvedExpected: 0, milliseconds: [] })
  const baseline = scores()
  const candidate = scores()
  let changed = 0
  let improved = 0
  let regressed = 0
  for (const item of cases) {
    if (!item || typeof item.id !== 'string' || !item.id.trim() || ids.has(item.id) || typeof item.conversation !== 'string' || !item.conversation.trim()) throw new Error('Each case needs a unique id and a conversation id.')
    ids.add(item.id)
    conversations.add(item.conversation)
    if (!Array.isArray(item.expected) || !item.expected.length || !Array.isArray(item.baseline) || !Array.isArray(item.candidate) || item.baseline.length !== item.expected.length || item.candidate.length !== item.expected.length) throw new Error(`Case ${item.id}: expected and prediction arrays must be nonempty and aligned.`)
    for (const value of [...item.expected, ...item.baseline, ...item.candidate]) if (value !== null && (typeof value !== 'string' || !value.trim())) throw new Error(`Case ${item.id}: identities must be nonempty strings or null.`)
    for (const [score, duration] of [[baseline, item.baselineMs], [candidate, item.candidateMs]] as const) {
      if (duration !== undefined) {
        if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) throw new Error(`Case ${item.id}: duration must be nonnegative and finite.`)
        score.milliseconds.push(duration)
      }
    }
    item.expected.forEach((expected, index) => {
      const before = item.baseline[index]
      const after = item.candidate[index]
      for (const [score, actual] of [[baseline, before], [candidate, after]] as const) {
        score.total++
        if (actual === null) score.unresolved++
        if (expected === null) score.unresolvedExpected++
        if (actual === expected) score.correct++
        else score.incorrect++
      }
      if (before !== after) {
        changed++
        if (before !== expected && after === expected) improved++
        if (before === expected && after !== expected) regressed++
      }
    })
  }
  const summarize = (score: Scores) => ({ total: score.total, exactMatches: score.correct, mismatches: score.incorrect, unresolved: score.unresolved, expectedUnresolved: score.unresolvedExpected, accuracy: score.correct / score.total, unresolvedRate: score.unresolved / score.total, timedCases: score.milliseconds.length, p50Ms: percentile(score.milliseconds, 0.5), p95Ms: percentile(score.milliseconds, 0.95) })
  return { cases: cases.length, conversations: conversations.size, baseline: summarize(baseline), candidate: summarize(candidate), changed, improved, regressed }
}
