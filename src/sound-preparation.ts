import type { SoundSceneCue } from './sound-scene'
import type { SoundTimelineAsset } from './sound-timeline'

export interface PreparedSoundCue {
  cue: SoundSceneCue
  boundary: number
  asset?: SoundTimelineAsset
}

/** Per-playback cache. Boundary reads are synchronous: late assets never stall speech. */
export class SoundCuePreparation {
  private readonly requests = new Map<string, { asset?: SoundTimelineAsset; ready: boolean }>()
  private readonly visited = new Set<number>()
  private cancelled = false

  constructor(
    private readonly cues: readonly { cue: SoundSceneCue; boundary: number }[],
    private readonly load: (id: string) => Promise<SoundTimelineAsset>,
  ) {}

  /** Start once, ahead of playback. Duplicate cues share one asset request. */
  start(): void {
    if (this.cancelled) return
    for (const { cue } of this.cues) {
      if (cue.action !== 'play' || !cue.assetId || this.requests.has(cue.assetId)) continue
      const state: { asset?: SoundTimelineAsset; ready: boolean } = { ready: false }
      this.requests.set(cue.assetId, state)
      void Promise.resolve().then(() => this.load(cue.assetId!)).then(asset => {
        if (!this.cancelled) { state.asset = asset; state.ready = true }
      }, () => { state.ready = true })
    }
  }

  /** Freeze the decisions for this boundary; repeated reads never replay sounds. */
  take(boundary: number): PreparedSoundCue[] {
    if (this.cancelled || !Number.isSafeInteger(boundary) || boundary < 0 || this.visited.has(boundary)) return []
    this.visited.add(boundary)
    const ready: PreparedSoundCue[] = []
    for (const item of this.cues) {
      if (item.boundary !== boundary) continue
      if (item.cue.kind === 'ambience' && item.cue.action === 'stop') { ready.push(item); continue }
      if (item.cue.action !== 'play' || !item.cue.assetId) continue
      const state = this.requests.get(item.cue.assetId)
      if (state?.ready && state.asset?.kind === item.cue.kind) ready.push({ ...item, asset: state.asset })
    }
    return ready
  }

  cancel(): void {
    this.cancelled = true
    this.requests.clear()
  }
}
