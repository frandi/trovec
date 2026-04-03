// CRC32 lookup table (IEEE polynomial 0xEDB88320)
const TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let crc = i;
  for (let j = 0; j < 8; j++) {
    crc = (crc & 1) ? (crc >>> 1) ^ 0xEDB88320 : crc >>> 1;
  }
  TABLE[i] = crc;
}

export function crc32(data: Buffer, seed = 0xFFFFFFFF): number {
  let crc = seed;
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ TABLE[(crc ^ data[i]) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
