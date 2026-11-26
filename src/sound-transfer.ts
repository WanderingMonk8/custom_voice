import { MAX_FAVORITE_SOUND_BYTES, SOUND_TRANSFER_CHUNK_BYTES } from './sound-library'

interface UploadState {
  owner: string
  data: Uint8Array
  offset: number
  touched: number
  finishing: boolean
}

/** Bounded temporary upload buffers, scoped to one authenticated frontend session. */
export class SoundUploadTransfers {
  private readonly uploads = new Map<string, UploadState>()
  constructor(private readonly id: () => string, private readonly now: () => number = Date.now) {}

  private scheduleExpiry(id: string): void {
    const timer = setTimeout(() => {
      const upload = this.uploads.get(id)
      if (!upload) return
      if (!upload.finishing && this.now() - upload.touched >= 120_000) this.uploads.delete(id)
      else this.scheduleExpiry(id)
    }, 120_000)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  }

  private cleanup(): void {
    const cutoff = this.now() - 120_000
    for (const [id, upload] of this.uploads) if (!upload.finishing && upload.touched < cutoff) this.uploads.delete(id)
  }

  begin(owner: string, size: number): string {
    this.cleanup()
    if (!owner || !Number.isSafeInteger(size) || size < 1 || size > MAX_FAVORITE_SOUND_BYTES) throw new Error('Invalid upload size or session.')
    if ([...this.uploads.values()].some(upload => upload.owner === owner)) throw new Error('Another sound upload is already in progress.')
    const reserved = [...this.uploads.values()].reduce((sum, upload) => sum + upload.data.length, 0)
    if (reserved + size > 64 * 1024 * 1024) throw new Error('Sound upload capacity is busy. Try again shortly.')
    const id = this.id()
    if (this.uploads.has(id)) throw new Error('Sound upload ID already exists.')
    this.uploads.set(id, { owner, data: new Uint8Array(size), offset: 0, touched: this.now(), finishing: false })
    this.scheduleExpiry(id)
    return id
  }

  append(owner: string, id: string, offset: number, bytes: Uint8Array): void {
    this.cleanup()
    const upload = this.uploads.get(id)
    if (!upload || upload.owner !== owner) throw new Error('Sound upload not found.')
    if (upload.finishing || !Number.isSafeInteger(offset) || offset !== upload.offset || !(bytes instanceof Uint8Array)
      || !bytes.length || bytes.length > SOUND_TRANSFER_CHUNK_BYTES || offset + bytes.length > upload.data.length) throw new Error('Invalid sound upload chunk.')
    upload.data.set(bytes, offset)
    upload.offset += bytes.length
    upload.touched = this.now()
  }

  take(owner: string, id: string): Uint8Array {
    this.cleanup()
    const upload = this.uploads.get(id)
    if (!upload || upload.owner !== owner) throw new Error('Sound upload not found.')
    if (upload.finishing || upload.offset !== upload.data.length) throw new Error('Sound upload is incomplete or already finishing.')
    upload.finishing = true
    return upload.data
  }

  cancel(owner: string, id: string): void {
    const upload = this.uploads.get(id)
    if (upload?.owner === owner && !upload.finishing) this.uploads.delete(id)
  }

  release(owner: string, id: string): void {
    if (this.uploads.get(id)?.owner === owner) this.uploads.delete(id)
  }
}
