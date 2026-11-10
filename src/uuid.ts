/**
 * Local RFC 9562-compliant UUID v7 fallback for non-secure Lumiverse
 * contexts and older hosts that do not expose Spindle's UUID helper.
 * The helper is preferred by backends; this keeps older installations
 * functional without relying on `crypto.randomUUID()`.
 */
let lastTimestamp = 0
let counter = 0

const uuidBytes = (): Uint8Array => {
  const now = Math.max(0, Math.min(Number(2n ** 48n - 1n), Date.now()))
  let timestamp = now

  if (timestamp === lastTimestamp) {
    counter = (counter + 1) & 0xfff
    if (counter === 0 && timestamp < Number(2n ** 48n - 1n)) {
      timestamp += 1
      lastTimestamp = timestamp
    } else {
      lastTimestamp = timestamp
    }
  } else {
    counter = 0
    lastTimestamp = timestamp
  }

  const bytes = new Uint8Array(16)
  const value = BigInt(timestamp)
  bytes[0] = Number((value >> 40n) & 0xffn)
  bytes[1] = Number((value >> 32n) & 0xffn)
  bytes[2] = Number((value >> 24n) & 0xffn)
  bytes[3] = Number((value >> 16n) & 0xffn)
  bytes[4] = Number((value >> 8n) & 0xffn)
  bytes[5] = Number(value & 0xffn)
  bytes[6] = 0x70 | ((counter >> 8) & 0x0f)
  bytes[7] = counter & 0xff
  for (let index = 8; index < 16; index += 1) bytes[index] = Math.floor(Math.random() * 256)
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  return bytes
}

const UUID_HEX = Array.from({ length: 256 }, (_, index) => index.toString(16).padStart(2, '0'))

/** Generate an RFC 9562-compliant UUID v7 without browser crypto APIs. */
export function generateUuidV7(): string {
  const bytes = uuidBytes()
  return [
    UUID_HEX[bytes[0]] + UUID_HEX[bytes[1]] + UUID_HEX[bytes[2]] + UUID_HEX[bytes[3]],
    UUID_HEX[bytes[4]] + UUID_HEX[bytes[5]],
    UUID_HEX[bytes[6]] + UUID_HEX[bytes[7]],
    UUID_HEX[bytes[8]] + UUID_HEX[bytes[9]],
    Array.from(bytes.slice(10), byte => UUID_HEX[byte]).join(''),
  ].join('-')
}
