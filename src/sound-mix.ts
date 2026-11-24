/** A local, frame-accurate mix primitive. It does not schedule playback. */
export interface SoundMixTrack {
  kind: 'voice' | 'event' | 'ambience'
  startFrame: number
  endFrame: number
  channels: readonly Float32Array[]
  gain: number
  fadeInFrames?: number
  fadeOutFrames?: number
  loop?: boolean
}

export interface SoundMixResult {
  channels: Float32Array[]
  peakGain: number
}

const MAX_MIX_BYTES = 128 * 1024 * 1024

/** Render a bounded PCM timeline. All input tracks must share the target sample rate. */
export function renderSoundMix(tracks: readonly SoundMixTrack[], totalFrames: number, channels = 2): SoundMixResult {
  if (!Number.isSafeInteger(totalFrames) || totalFrames < 1 || (channels !== 1 && channels !== 2)
    || totalFrames * channels * Float32Array.BYTES_PER_ELEMENT > MAX_MIX_BYTES || tracks.length > 512) {
    throw new Error('Sound mix exceeds supported limits.')
  }
  for (const track of tracks) {
    if (!['voice', 'event', 'ambience'].includes(track.kind) || !Number.isSafeInteger(track.startFrame) || !Number.isSafeInteger(track.endFrame)
      || track.startFrame < 0 || track.endFrame <= track.startFrame || track.endFrame > totalFrames
      || !Number.isFinite(track.gain) || track.gain < 0 || track.gain > 4
      || ![1, 2].includes(track.channels.length) || !track.channels[0]?.length
      || track.channels.some(channel => !(channel instanceof Float32Array) || channel.length !== track.channels[0].length)
      || (!track.loop && track.endFrame - track.startFrame > track.channels[0].length)
      || !Number.isSafeInteger(track.fadeInFrames ?? 0) || (track.fadeInFrames ?? 0) < 0
      || !Number.isSafeInteger(track.fadeOutFrames ?? 0) || (track.fadeOutFrames ?? 0) < 0) throw new Error('Invalid sound mix track.')
  }
  const voices = tracks.filter(track => track.kind === 'voice')
  const events = tracks.filter(track => track.kind === 'event')
  for (const event of events) {
    if (voices.some(voice => event.startFrame < voice.endFrame && voice.startFrame < event.endFrame)) throw new Error('Event sound overlaps voice.')
  }
  for (let index = 0; index < events.length; index++) {
    if (events.slice(index + 1).some(other => events[index].startFrame < other.endFrame && other.startFrame < events[index].endFrame)) throw new Error('Event sounds overlap.')
  }
  const output = Array.from({ length: channels }, () => new Float32Array(totalFrames))
  for (const track of tracks) {
    const length = track.endFrame - track.startFrame
    for (let offset = 0; offset < length; offset++) {
      const sourceIndex = track.loop ? offset % track.channels[0].length : offset
      const fadeIn = track.fadeInFrames ? Math.min(1, offset / track.fadeInFrames) : 1
      const fadeOut = track.fadeOutFrames ? Math.min(1, (length - 1 - offset) / track.fadeOutFrames) : 1
      const gain = track.gain * Math.min(fadeIn, fadeOut)
      for (let channel = 0; channel < channels; channel++) {
        // Mono output averages stereo; stereo output duplicates mono.
        const sample = channels === 1 && track.channels.length === 2
          ? (track.channels[0][sourceIndex] + track.channels[1][sourceIndex]) / 2
          : track.channels[Math.min(channel, track.channels.length - 1)][sourceIndex]
        if (!Number.isFinite(sample)) throw new Error('Invalid audio sample.')
        output[channel][track.startFrame + offset] += sample * gain
      }
    }
  }
  let peak = 0
  for (const channel of output) for (const sample of channel) peak = Math.max(peak, Math.abs(sample))
  const peakGain = peak > 1 ? 1 / peak : 1
  if (peakGain < 1) for (const channel of output) for (let index = 0; index < channel.length; index++) channel[index] *= peakGain
  return { channels: output, peakGain }
}
