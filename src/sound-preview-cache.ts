/** Expendable browser-session cache; favorites and recordings never depend on it. */
export class SoundPreviewCache {
  private readonly entries = new Map<string, { bytes: Uint8Array<ArrayBuffer>; touched: number }>()
  private total = 0

  constructor(
    private readonly budget = 32 * 1024 * 1024,
    private readonly itemLimit = 8 * 1024 * 1024,
    private readonly ttlMs = 15 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  private remove(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    this.total -= entry.bytes.byteLength
  }

  get(key: string): Uint8Array<ArrayBuffer> | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (this.now() - entry.touched >= this.ttlMs) { this.remove(key); return undefined }
    entry.touched = this.now()
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.bytes.slice()
  }

  put(key: string, bytes: Uint8Array<ArrayBuffer>): void {
    if (!key || !bytes.byteLength || bytes.byteLength > this.itemLimit || bytes.byteLength > this.budget) return
    this.remove(key)
    for (const [cachedKey, entry] of this.entries) if (this.now() - entry.touched >= this.ttlMs) this.remove(cachedKey)
    while (this.total + bytes.byteLength > this.budget) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.remove(oldest)
    }
    const copy = bytes.slice()
    this.entries.set(key, { bytes: copy, touched: this.now() })
    this.total += copy.byteLength
  }

  clear(): void { this.entries.clear(); this.total = 0 }
}
