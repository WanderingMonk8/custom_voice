/** Limits speculative sound work; confirmed cues can jump ahead of queued prefetches. */
export class SoundLoadQueue {
  private readonly pending: Array<{ id: string; task: () => Promise<void>; resolve: () => void; priority: boolean }> = []
  private readonly requests = new Map<string, Promise<void>>()
  private running = 0
  private closed = false

  constructor(private readonly limit = 2) {}

  enqueue(id: string, task: () => Promise<void>, priority = false): Promise<void> {
    if (this.closed) return Promise.resolve()
    const existing = this.requests.get(id)
    if (existing) {
      if (priority) { const item = this.pending.find(entry => entry.id === id); if (item) item.priority = true }
      return existing
    }
    let resolve!: () => void
    const promise = new Promise<void>(done => { resolve = done })
    this.requests.set(id, promise)
    this.pending.push({ id, task, resolve, priority })
    this.drain()
    return promise
  }

  cancel(): void {
    this.closed = true
    for (const item of this.pending.splice(0)) item.resolve()
  }

  private drain(): void {
    while (!this.closed && this.running < this.limit && this.pending.length) {
      const index = this.pending.findIndex(item => item.priority)
      const item = this.pending.splice(index < 0 ? 0 : index, 1)[0]
      this.running++
      void Promise.resolve().then(item.task).catch(() => undefined).finally(() => {
        this.running--
        item.resolve()
        this.drain()
      })
    }
  }
}
