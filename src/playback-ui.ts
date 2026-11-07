export interface PlaybackButtonState {
  html: string
  title: string | null
  ariaLabel: string | null
  ariaPressed: string | null
}

/** One pointer gesture toggles autoplay without also activating the play button. */
export class PlaybackLongPress<T> {
  private active: { target: T; pointerId: number; x: number; y: number; timer: ReturnType<typeof setTimeout>; fired: boolean } | null = null
  private suppressed: T | null = null
  private expiry: ReturnType<typeof setTimeout> | null = null
  constructor(private readonly toggle: () => void, private readonly delay = 650) {}
  start(target: T, pointerId: number, x: number, y: number): void {
    this.cancel()
    this.suppressed = null
    const active = { target, pointerId, x, y, fired: false, timer: setTimeout(() => {
      if (this.active !== active) return
      active.fired = true
      this.suppressed = target
      this.toggle()
    }, this.delay) }
    this.active = active
  }
  move(pointerId: number, x: number, y: number): void {
    if (this.active?.pointerId === pointerId && !this.active.fired && Math.hypot(x - this.active.x, y - this.active.y) > 10) this.cancel()
  }
  end(pointerId: number): void {
    if (this.active?.pointerId !== pointerId) return
    const fired = this.active.fired
    clearTimeout(this.active.timer)
    this.active = null
    if (fired) this.expiry = setTimeout(() => { this.suppressed = null; this.expiry = null }, 1000)
  }
  consumeClick(target: T): boolean {
    if (this.suppressed !== target) return false
    this.suppressed = null
    if (this.expiry) clearTimeout(this.expiry)
    this.expiry = null
    return true
  }
  isHolding(target: T): boolean { return this.active?.target === target }
  cancel(): void {
    if (this.active) clearTimeout(this.active.timer)
    if (this.expiry) clearTimeout(this.expiry)
    this.active = null
    this.expiry = null
    this.suppressed = null
  }
}

/** Highlight native controls without replacing their playback or accessibility state. */
export function syncAutoplayIndicators(buttons: Iterable<HTMLButtonElement>, enabled: boolean, getMessageId: (button: HTMLButtonElement) => string | null): void {
  for (const button of buttons) {
    if (enabled && getMessageId(button)) button.dataset.chatVoiceAutoplay = 'true'
    else delete button.dataset.chatVoiceAutoplay
  }
}

/** Synchronize existing or newly rendered native controls with the shared playback state. */
export function syncPlaybackButtons(
  buttons: Iterable<HTMLButtonElement>,
  activeMessageId: string | null,
  getMessageId: (button: HTMLButtonElement) => string | null,
  states: Map<HTMLButtonElement, PlaybackButtonState>,
  stopIcon: string,
): void {
  for (const button of buttons) {
    const messageId = getMessageId(button)
    if (!messageId) continue
    const playing = activeMessageId === messageId
    const idle = states.get(button)
    if (!playing) {
      if (!idle) continue
      button.innerHTML = idle.html
      if (idle.title === null) button.removeAttribute('title')
      else button.setAttribute('title', idle.title)
      if (idle.ariaLabel === null) button.removeAttribute('aria-label')
      else button.setAttribute('aria-label', idle.ariaLabel)
      if (idle.ariaPressed === null) button.removeAttribute('aria-pressed')
      else button.setAttribute('aria-pressed', idle.ariaPressed)
      delete button.dataset.chatVoiceNativeTts
      delete button.dataset.playing
      states.delete(button)
      continue
    }
    if (!idle) states.set(button, {
      html: button.innerHTML,
      title: button.getAttribute('title'),
      ariaLabel: button.getAttribute('aria-label'),
      ariaPressed: button.getAttribute('aria-pressed'),
    })
    // The host can replace a control's children while retaining the element.
    // Avoid rewriting unchanged children, which would retrigger the observer.
    if (button.dataset.playing === 'true' && button.querySelector('[data-chat-voice-stop]')) continue
    const label = 'Stop custom voice playback'
    const hasText = !!button.querySelector(':scope > span')
    button.dataset.chatVoiceNativeTts = 'true'
    button.dataset.playing = 'true'
    button.innerHTML = `${stopIcon}${hasText ? `<span>${label}</span>` : ''}`
    button.title = label
    button.setAttribute('aria-label', label)
    button.setAttribute('aria-pressed', 'true')
  }
}
