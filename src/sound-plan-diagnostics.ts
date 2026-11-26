export type SoundPlanStage = 'library' | 'connection' | 'generation' | 'parsing' | 'decision'

/** Do not forward arbitrary provider messages, which may contain prompt text or credentials. */
export function soundPlanErrorCategory(error: unknown): string {
  if (!error || typeof error !== 'object') return 'unknown failure'
  const item = error as { name?: unknown; status?: unknown; statusCode?: unknown; code?: unknown }
  const status = typeof item.status === 'number' ? item.status : item.statusCode
  if (status === 429) return 'provider rate limit (429)'
  if (status === 401 || status === 403) return `provider authentication/access (${status})`
  if (typeof status === 'number' && status >= 500 && status < 600) return `provider/server error (${status})`
  if (item.name === 'AbortError') return 'aborted'
  if (item.name === 'TimeoutError' || item.code === 'ETIMEDOUT') return 'timeout'
  return 'unknown failure'
}
