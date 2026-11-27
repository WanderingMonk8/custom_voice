import { renderSoundMix, soundCategoryGain, type SoundMixTrack } from './sound-mix'
import { encodeConcatenatedWav } from './core'

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

export interface SampledSoundClip extends SoundTimelineClip {
  sampleRate: number
}

/** A source heard on the audio clock, including any silence between sources. */
export interface PlaybackTimelineTrack extends SampledSoundClip {
  startSeconds: number
  endSeconds: number
  loop?: boolean
  fadeInSeconds?: number
  fadeOutSeconds?: number
}

/** Keep recording data independent of Web Audio's transferable channel buffers. */
export function copyPlaybackChannels(channels: readonly Float32Array[]): Float32Array[] {
  return channels.map(channel => channel.slice())
}

/** Render captured audio-clock positions into the recording, preserving gaps. */
export function renderPlaybackTimeline(tracks: readonly PlaybackTimelineTrack[], durationSeconds: number, sampleRate: number): Float32Array[] {
  if (!Number.isSafeInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000
    || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || tracks.length > 2048) throw new Error('Invalid playback timeline.')
  const frames = Math.ceil(durationSeconds * sampleRate)
  if (!Number.isSafeInteger(frames) || frames * 2 * Float32Array.BYTES_PER_ELEMENT > 128 * 1024 * 1024) throw new Error('Playback timeline exceeds supported limits.')
  const output = [new Float32Array(frames), new Float32Array(frames)]
  for (const track of tracks) {
    if (!Number.isFinite(track.startSeconds) || !Number.isFinite(track.endSeconds) || track.startSeconds < 0 || track.endSeconds <= track.startSeconds
      || !Number.isSafeInteger(track.sampleRate) || track.sampleRate < 8000 || track.sampleRate > 192000
      || !Number.isFinite(track.gain) || track.gain < 0 || track.gain > 4
      || !Number.isFinite(track.fadeInSeconds ?? 0) || (track.fadeInSeconds ?? 0) < 0
      || !Number.isFinite(track.fadeOutSeconds ?? 0) || (track.fadeOutSeconds ?? 0) < 0) throw new Error('Invalid playback timeline track (timing, gain, rate, or fade).')
    if (![1, 2].includes(track.channels.length) || !track.channels[0]?.length
      || track.channels.some(channel => !(channel instanceof Float32Array) || channel.length !== track.channels[0].length)) throw new Error('Invalid playback timeline track (empty or inconsistent audio channels).')
    const first = Math.max(0, Math.ceil(track.startSeconds * sampleRate))
    const end = Math.min(frames, Math.ceil(track.endSeconds * sampleRate))
    const sourceFrames = track.channels[0].length
    for (let frame = first; frame < end; frame++) {
      // Multiplication and division can round in opposite directions even
      // after ceil(), leaving a tiny negative elapsed at an exact boundary.
      // A negative sample index reads undefined and poisons the recording.
      const elapsed = Math.max(0, frame / sampleRate - track.startSeconds)
      const position = elapsed * track.sampleRate
      if (!track.loop && position >= sourceFrames) break
      const wrapped = track.loop ? position % sourceFrames : position
      const lower = Math.floor(wrapped)
      const upper = track.loop ? (lower + 1) % sourceFrames : Math.min(lower + 1, sourceFrames - 1)
      const fraction = wrapped - lower
      const fadeIn = track.fadeInSeconds ? Math.min(1, elapsed / track.fadeInSeconds) : 1
      const fadeOut = track.fadeOutSeconds ? Math.min(1, (track.endSeconds - frame / sampleRate) / track.fadeOutSeconds) : 1
      const gain = track.gain * Math.max(0, Math.min(fadeIn, fadeOut))
      for (let channel = 0; channel < 2; channel++) {
        const input = track.channels[Math.min(channel, track.channels.length - 1)]
        const sample = input[lower] + (input[upper] - input[lower]) * fraction
        if (!Number.isFinite(sample)) throw new Error('Invalid playback audio sample.')
        output[channel][frame] += sample * gain
      }
    }
  }
  return output
}

/** Resample bounded decoded PCM into a common rate before timeline assembly. */
export function resampleSoundClip(clip: SampledSoundClip, sampleRate: number): SoundTimelineClip {
  if (!Number.isSafeInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000
    || !Number.isSafeInteger(clip.sampleRate) || clip.sampleRate < 8000 || clip.sampleRate > 192000
    || ![1, 2].includes(clip.channels.length) || !clip.channels[0]?.length
    || clip.channels.some(channel => !(channel instanceof Float32Array) || channel.length !== clip.channels[0].length)) throw new Error('Invalid sampled sound clip.')
  const frames = Math.max(1, Math.round(clip.channels[0].length * sampleRate / clip.sampleRate))
  if (!Number.isSafeInteger(frames) || frames * clip.channels.length * 4 > 64 * 1024 * 1024) throw new Error('Resampled sound exceeds supported limits.')
  if (sampleRate === clip.sampleRate) return { channels: clip.channels, gain: clip.gain }
  const channels = clip.channels.map(source => {
    const output = new Float32Array(frames)
    for (let frame = 0; frame < frames; frame++) {
      const pos = Math.min(source.length - 1, frame * clip.sampleRate / sampleRate)
      const index = Math.floor(pos)
      const fraction = pos - index
      output[frame] = source[index] + ((source[Math.min(index + 1, source.length - 1)] - source[index]) * fraction)
    }
    return output
  })
  return { channels, gain: clip.gain }
}

/** Encode the already-selected timeline as a single WAV attachment. */
export function encodeSoundTimelineWav(timeline: { tracks: readonly SoundMixTrack[]; totalFrames: number }, sampleRate: number): ArrayBuffer {
  if (!Number.isSafeInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new Error('Invalid sound sample rate.')
  const mixed = renderSoundMix(timeline.tracks, timeline.totalFrames, 2)
  return encodeConcatenatedWav([{ sampleRate, channels: mixed.channels }])
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
