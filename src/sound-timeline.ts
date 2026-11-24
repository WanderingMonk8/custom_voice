import { soundCategoryGain, type SoundMixTrack } from './sound-mix'

export interface SoundTimelineClip {
  channels: readonly Float32Array[]
  gain: number
}

export interface SoundTimelineCue {
  boundary: number
  kind: 'event' | 'ambience'
  action: 'play' | 'stop'
  assetId?: string
}

export interface SoundTimelineAsset {
  kind: 'event' | 'ambience'
  channels: readonly Float32Array[]
}

/** Construct a deterministic timeline from clips that already share one sample rate.
 * Unavailable assets are skipped; event clips occupy their own time between voices.
 */
export function buildSoundTimeline(
  voices: readonly SoundTimelineClip[], cues: readonly SoundTimelineCue[],
  assets: ReadonlyMap<string, SoundTimelineAsset>, sampleRate: number,
  volume: { event: number; ambience: number },
): { tracks: SoundMixTrack[]; totalFrames: number } {
  if (!Number.isSafeInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000
    || voices.length > 500 || cues.length > 32
    || !Number.isFinite(volume.event) || volume.event < 0 || volume.event > 1
    || !Number.isFinite(volume.ambience) || volume.ambience < 0 || volume.ambience > 1) throw new Error('Invalid sound timeline settings.')
  const tracks: SoundMixTrack[] = []
  let cursor = 0
  let active: { start: number; asset: SoundTimelineAsset; gain: number } | undefined
  const closeAmbience = () => {
    if (!active) return
    if (cursor > active.start) {
      const fade = Math.min(Math.round(sampleRate * 0.25), Math.floor((cursor - active.start) / 2))
      tracks.push({ kind: 'ambience', startFrame: active.start, endFrame: cursor, channels: active.asset.channels, gain: active.gain, loop: true, fadeInFrames: fade, fadeOutFrames: fade })
    }
    active = undefined
  }
  for (let boundary = 0; boundary <= voices.length; boundary++) {
    for (const cue of cues) {
      if (cue.boundary !== boundary) continue
      if (cue.kind === 'ambience' && cue.action === 'stop') { closeAmbience(); continue }
      if (cue.action !== 'play' || !cue.assetId) continue
      const asset = assets.get(cue.assetId)
      if (!asset || asset.kind !== cue.kind) continue
      let gain: number
      try { gain = soundCategoryGain(asset.channels, asset.kind) * volume[asset.kind] } catch { continue }
      if (cue.kind === 'ambience') { closeAmbience(); active = { start: cursor, asset, gain }; continue }
      const length = Math.min(asset.channels[0].length, sampleRate * 5)
      if (length > 0) {
        const fade = Math.min(Math.round(sampleRate * 0.01), Math.floor(length / 2))
        tracks.push({ kind: 'event', startFrame: cursor, endFrame: cursor + length, channels: asset.channels, gain, fadeInFrames: fade, fadeOutFrames: fade })
        cursor += length
      }
    }
    if (boundary < voices.length) {
      const voice = voices[boundary]
      if (![1, 2].includes(voice.channels.length) || !voice.channels[0]?.length
        || voice.channels.some(channel => !(channel instanceof Float32Array) || channel.length !== voice.channels[0].length)
        || !Number.isFinite(voice.gain) || voice.gain < 0 || voice.gain > 4) throw new Error('Invalid voice clip.')
      const end = cursor + voice.channels[0].length
      tracks.push({ kind: 'voice', startFrame: cursor, endFrame: end, channels: voice.channels, gain: voice.gain })
      cursor = end
    }
  }
  closeAmbience()
  return { tracks, totalFrames: cursor }
}
