import { SoundLibrary, type FavoriteSound, type NewFavoriteSound, type SoundUserStorage } from './sound-library'

// Keep automatic results physically separate from the user's curated favorites.
const PREFIX = 'automatic-cache/'
export const MAX_AUTO_SOUND_CACHE_BYTES = 48 * 1024 * 1024
export const MAX_AUTO_SOUND_CACHE_ITEMS = 40
const pendingWrites = new Map<string, Promise<void>>()

function scopedStorage(storage: SoundUserStorage): SoundUserStorage {
  const path = (value: string) => PREFIX + value
  return {
    read: (value, user) => storage.read(path(value), user),
    write: (value, data, user) => storage.write(path(value), data, user),
    readBinary: (value, user) => storage.readBinary(path(value), user),
    writeBinary: (value, data, user) => storage.writeBinary(path(value), data, user),
    delete: (value, user) => storage.delete(path(value), user),
    list: (value, user) => storage.list(path(value ?? ''), user),
    exists: (value, user) => storage.exists(path(value), user),
    move: (from, to, user) => storage.move(path(from), path(to), user),
  }
}

/** Persistent, bounded automatic results; favorites are never evicted or changed. */
export class AutomaticSoundCache {
  private readonly library: SoundLibrary
  constructor(storage: SoundUserStorage) { this.library = new SoundLibrary(scopedStorage(storage)) }

  list(userId?: string): Promise<FavoriteSound[]> { return this.library.list(userId) }
  read(id: string, userId?: string): Promise<{ record: FavoriteSound; data: Uint8Array }> { return this.library.read(id, userId) }
  remove(id: string, userId?: string): Promise<void> { return this.library.remove(id, userId) }

  async add(input: NewFavoriteSound, bytes: Uint8Array, userId?: string): Promise<FavoriteSound> {
    if (!input.provenance || bytes.byteLength > MAX_AUTO_SOUND_CACHE_BYTES) throw new Error('Invalid automatic cache entry.')
    const key = userId ?? '__extension_owner__'
    const previous = pendingWrites.get(key) ?? Promise.resolve()
    const work = previous.catch(() => undefined).then(async () => {
      const entries = await this.library.list(userId)
      const duplicate = entries.find(entry => entry.kind === input.kind && entry.provenance?.soundId === input.provenance?.soundId)
      if (duplicate) return duplicate
      // Add before eviction so invalid audio or a failed write cannot erase cache entries.
      const result = await this.library.add(input, bytes, userId)
      let size = entries.reduce((sum, item) => sum + item.bytes, 0) + result.bytes
      let count = entries.length + 1
      for (const entry of entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
        if (size <= MAX_AUTO_SOUND_CACHE_BYTES && count <= MAX_AUTO_SOUND_CACHE_ITEMS) break
        await this.library.remove(entry.id, userId)
        size -= entry.bytes; count--
      }
      return result
    })
    const tail = work.then(() => undefined, () => undefined)
    pendingWrites.set(key, tail)
    void tail.then(() => { if (pendingWrites.get(key) === tail) pendingWrites.delete(key) })
    return work
  }
}
