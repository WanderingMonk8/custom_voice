import { generateUuidV7 } from './uuid'
import { isFreesoundCc0 } from './freesound'

/** Small, per-user foundation for the future sound-effects library. */
export interface SoundUserStorage {
  read(path: string, userId?: string): Promise<string>
  write(path: string, data: string, userId?: string): Promise<void>
  readBinary(path: string, userId?: string): Promise<Uint8Array>
  writeBinary(path: string, data: Uint8Array, userId?: string): Promise<void>
  delete(path: string, userId?: string): Promise<void>
  list(prefix?: string, userId?: string): Promise<string[]>
  exists(path: string, userId?: string): Promise<boolean>
  move(from: string, to: string, userId?: string): Promise<void>
}

export type SoundKind = 'ambience' | 'event'
export interface SoundProvenance {
  provider: 'freesound'
  soundId: number
  creator: string
  license: string
  sourceUrl: string
}
export interface FavoriteSound {
  version: 1
  id: string
  name: string
  description: string
  tags: string[]
  kind: SoundKind
  mime: string
  bytes: number
  createdAt: string
  provenance?: SoundProvenance
}

export interface NewFavoriteSound {
  name: string
  description?: string
  tags?: string[]
  kind: SoundKind
  mime: string
  provenance?: SoundProvenance
}

const ROOT = 'sound-effects/v1'
const RECORDS = `${ROOT}/favorites`
const AUDIO = `${ROOT}/audio`
// Large files use bounded chunks so no single RPC exceeds the host message limit.
export const MAX_FAVORITE_SOUND_BYTES = 24 * 1024 * 1024
export const SOUND_TRANSFER_CHUNK_BYTES = 1024 * 1024
export const MAX_FAVORITE_SOUNDS = 200
export const MAX_FAVORITE_LIBRARY_BYTES = 100 * 1024 * 1024
const ID_PATTERN = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u
const writes = new Map<string, Promise<void>>()

function normalizeProvenance(value: unknown): SoundProvenance | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  if (item.provider !== 'freesound' || !Number.isSafeInteger(item.soundId) || (item.soundId as number) < 1
    || typeof item.creator !== 'string' || !item.creator.trim() || item.creator.length > 120
    || typeof item.license !== 'string' || !item.license.trim() || item.license.length > 300) return undefined
  return { provider: 'freesound', soundId: item.soundId as number, creator: item.creator.trim(), license: item.license.trim(), sourceUrl: `https://freesound.org/s/${item.soundId}/` }
}

function serializeUserWrite<T>(userId: string | undefined, task: () => Promise<T>): Promise<T> {
  const key = userId ?? '__extension_owner__'
  const previous = writes.get(key) ?? Promise.resolve()
  const result = previous.catch(() => undefined).then(task)
  const tail = result.then(() => undefined, () => undefined)
  writes.set(key, tail)
  void tail.then(() => { if (writes.get(key) === tail) writes.delete(key) })
  return result
}

function assertId(id: string): void {
  if (!ID_PATTERN.test(id)) throw new Error('Invalid sound ID.')
}

function recordPath(id: string): string { assertId(id); return `${RECORDS}/${id}.json` }
function audioPath(id: string): string { assertId(id); return `${AUDIO}/${id}.audio` }

function readRecord(value: unknown, id: string): FavoriteSound | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (row.version !== 1 || row.id !== id || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 120
    || typeof row.description !== 'string' || row.description.length > 500 || !Array.isArray(row.tags) || row.tags.length > 20
    || !row.tags.every(tag => typeof tag === 'string' && !!tag.trim() && tag.length <= 40)
    || (row.kind !== 'ambience' && row.kind !== 'event')
    || typeof row.mime !== 'string' || !/^audio\/(?:mpeg|wav|ogg|mp4|webm)$/u.test(row.mime)
    || typeof row.bytes !== 'number' || !Number.isInteger(row.bytes) || row.bytes < 1 || row.bytes > MAX_FAVORITE_SOUND_BYTES
    || typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt))) return null
  if (row.provenance !== undefined) {
    const provenance = normalizeProvenance(row.provenance)
    if (!provenance || (row.provenance as Record<string, unknown>).sourceUrl !== provenance.sourceUrl) return null
  }
  return row as unknown as FavoriteSound
}

/** Only allow common audio containers whose signature agrees with their MIME. */
function validAudio(data: Uint8Array, mime: string): boolean {
  const ascii = (at: number, text: string) => [...text].every((char, index) => data[at + index] === char.charCodeAt(0))
  if (mime === 'audio/wav') return data.length >= 12 && ascii(0, 'RIFF') && ascii(8, 'WAVE')
  if (mime === 'audio/ogg') return data.length >= 4 && ascii(0, 'OggS')
  if (mime === 'audio/mp4') return data.length >= 12 && ascii(4, 'ftyp')
  if (mime === 'audio/webm') return data.length >= 4 && data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3
  if (mime === 'audio/mpeg') return data.length >= 4 && (ascii(0, 'ID3') || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0))
  return false
}

/** Each favorite has its own immutable record; no shared index can lose concurrent additions. */
export class SoundLibrary {
  constructor(private readonly storage: SoundUserStorage, private readonly makeId: () => string = generateUuidV7) {}

  async add(input: NewFavoriteSound, data: Uint8Array, userId?: string): Promise<FavoriteSound> {
    return serializeUserWrite(userId, async () => {
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    const description = typeof input.description === 'string' ? input.description.trim() : ''
    const tags = Array.isArray(input.tags) ? input.tags.map(tag => typeof tag === 'string' ? tag.trim() : '') : []
    const mime = typeof input.mime === 'string' ? input.mime.trim().toLowerCase() : ''
    const provenance = input.provenance === undefined ? undefined : normalizeProvenance(input.provenance)
    if (input.provenance !== undefined && !provenance) throw new Error('Invalid sound provenance.')
    if (provenance && !isFreesoundCc0(provenance.license)) throw new Error('Only CC0 Freesound imports are supported until recording attribution is available.')
    if (!name || name.length > 120 || description.length > 500 || tags.length > 20 || tags.some(tag => !tag || tag.length > 40)
      || (input.kind !== 'ambience' && input.kind !== 'event')) throw new Error('Invalid favorite sound metadata.')
    if (!(data instanceof Uint8Array) || data.length < 1 || data.length > MAX_FAVORITE_SOUND_BYTES || !validAudio(data, mime)) {
      throw new Error('Invalid or oversized audio file.')
    }
    const existing = await this.list(userId)
    if (existing.length >= MAX_FAVORITE_SOUNDS || existing.reduce((total, item) => total + item.bytes, 0) + data.byteLength > MAX_FAVORITE_LIBRARY_BYTES) {
      throw new Error('Sound library is full. Remove a favorite before adding another.')
    }
    const id = this.makeId().toLowerCase()
    const metaPath = recordPath(id)
    const bytesPath = audioPath(id)
    if (await this.storage.exists(metaPath, userId) || await this.storage.exists(bytesPath, userId)) throw new Error('Sound ID already exists.')
    const record: FavoriteSound = { version: 1, id, name, description, tags, kind: input.kind, mime, bytes: data.byteLength, createdAt: new Date().toISOString(), ...(provenance ? { provenance } : {}) }
    try {
      await this.storage.writeBinary(bytesPath, data, userId)
      await this.storage.write(metaPath, JSON.stringify(record), userId)
    } catch (error) {
      // Best effort only: a failed host write may itself leave partial files.
      await Promise.allSettled([this.storage.delete(metaPath, userId), this.storage.delete(bytesPath, userId)])
      throw error
    }
    return record
    })
  }

  async list(userId?: string): Promise<FavoriteSound[]> {
    const entries = await this.storage.list(RECORDS, userId)
    const result: FavoriteSound[] = []
    for (const entry of entries) {
      const match = /^([a-f0-9-]+)\.json$/u.exec(entry)
      if (!match || !ID_PATTERN.test(match[1])) continue
      const raw = await this.storage.read(recordPath(match[1]), userId)
      let parsed: unknown
      try { parsed = JSON.parse(raw) } catch { continue }
      const record = readRecord(parsed, match[1])
      if (record && await this.storage.exists(audioPath(record.id), userId)) result.push(record)
    }
    return result.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  }

  async read(id: string, userId?: string): Promise<{ record: FavoriteSound; data: Uint8Array }> {
    const record = readRecord(JSON.parse(await this.storage.read(recordPath(id), userId)), id)
    if (!record) throw new Error('Invalid sound record.')
    const data = await this.storage.readBinary(audioPath(id), userId)
    if (data.byteLength !== record.bytes || !validAudio(data, record.mime)) throw new Error('Sound audio is missing or invalid.')
    return { record, data }
  }

  async remove(id: string, userId?: string): Promise<void> {
    return serializeUserWrite(userId, async () => {
    const metadata = recordPath(id)
    const audio = audioPath(id)
    // Validate the record before deleting either file; a foreign/missing ID never touches another path.
    const record = readRecord(JSON.parse(await this.storage.read(metadata, userId)), id)
    if (!record) throw new Error('Invalid sound record.')
    await this.storage.delete(metadata, userId)
    await this.storage.delete(audio, userId)
    })
  }

  async edit(id: string, input: Pick<NewFavoriteSound, 'name' | 'description' | 'tags' | 'kind'>, userId?: string): Promise<FavoriteSound> {
    return serializeUserWrite(userId, async () => {
      const metadata = recordPath(id)
      const current = readRecord(JSON.parse(await this.storage.read(metadata, userId)), id)
      if (!current) throw new Error('Invalid sound record.')
      const name = typeof input.name === 'string' ? input.name.trim() : ''
      const description = typeof input.description === 'string' ? input.description.trim() : ''
      const tags = Array.isArray(input.tags) ? input.tags.map(tag => typeof tag === 'string' ? tag.trim() : '') : []
      if (!name || name.length > 120 || description.length > 500 || tags.length > 20 || tags.some(tag => !tag || tag.length > 40)
        || (input.kind !== 'ambience' && input.kind !== 'event')) throw new Error('Invalid favorite sound metadata.')
      const next: FavoriteSound = { ...current, name, description, tags, kind: input.kind }
      const temp = `${ROOT}/pending/${this.makeId()}.json`
      try {
        await this.storage.write(temp, JSON.stringify(next), userId)
        await this.storage.move(temp, metadata, userId)
      } catch (error) {
        await this.storage.delete(temp, userId).catch(() => undefined)
        throw error
      }
      return next
    })
  }
}
