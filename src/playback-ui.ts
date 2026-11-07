export interface PlaybackButtonState {
  html: string
  title: string | null
  ariaLabel: string | null
  ariaPressed: string | null
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
