export type SoundPlanStage = 'library' | 'connection' | 'generation' | 'parsing' | 'decision'

export const SOUND_PLANNER_TIMEOUT_MS = 60_000
export const SOUND_LIBRARY_TIMEOUT_MS = 30_000
export function soundRequestTimeoutMs(type: string): number {
  return type === 'chat_voice_sound_scene_plan' ? SOUND_PLANNER_TIMEOUT_MS : SOUND_LIBRARY_TIMEOUT_MS
}

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

/** Classify only known local errors; never copy remote error text into logs. */
export function automaticSoundErrorCategory(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown failure'
  if (error.name === 'AbortError') return 'aborted or download timed out'
  if (error.name === 'TypeError') return 'network or browser restriction'
  const message = error.message
  if (message.startsWith('Save a Freesound API key')) return 'missing Freesound API key'
  if (message.startsWith('Freesound rejected')) return 'Freesound authentication or access'
  if (message.startsWith('Freesound rate limit')) return 'Freesound rate limit'
  if (/timed out/iu.test(message)) return 'timeout'
  if (message.startsWith('The preview exceeds')) return 'preview too large'
  if (message.startsWith('Sound library is full')) return 'cache full'
  return 'operation failed'
}
