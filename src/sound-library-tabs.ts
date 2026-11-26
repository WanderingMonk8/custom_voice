/** Update the two sound-library source panels without rebuilding their content. */
export function selectSoundLibraryTab(panels: readonly HTMLElement[], buttons: readonly HTMLButtonElement[], index: number, focus = false): void {
  if (!Number.isInteger(index) || index < 0 || index >= panels.length || panels.length !== buttons.length) return
  for (let n = 0; n < panels.length; n++) {
    const selected = n === index
    panels[n].hidden = !selected
    buttons[n].setAttribute('aria-selected', String(selected))
    buttons[n].tabIndex = selected ? 0 : -1
  }
  if (focus) buttons[index].focus()
}
