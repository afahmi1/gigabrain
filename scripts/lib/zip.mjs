// Minimal deterministic ZIP writer/reader (deflate, UTF-8 names, sorted entries, fixed timestamp; no external tool).
import zlib from "node:zlib";

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const epoch = process.env.SOURCE_DATE_EPOCH ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000) : new Date(Date.UTC(2026, 0, 1));
const dosTime = ((epoch.getUTCHours() << 11) | (epoch.getUTCMinutes() << 5) | (epoch.getUTCSeconds() >> 1)) & 0xffff;
const dosDate = (((epoch.getUTCFullYear() - 1980) << 9) | ((epoch.getUTCMonth() + 1) << 5) | epoch.getUTCDate()) & 0xffff;
export function makeZip(entries) { // entries: [{ name, data: Buffer }]
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : 1)), parts = [], central = [];
  let offset = 0;
  for (const { name, data } of sorted) {
    const nb = Buffer.from(name, "utf8"), crc = crc32(data), z = zlib.deflateRawSync(data, { level: 9 });
    const stored = z.length >= data.length, body = stored ? data : z, method = stored ? 0 : 8;
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(method, 8);
    h.writeUInt16LE(dosTime, 10); h.writeUInt16LE(dosDate, 12); h.writeUInt32LE(crc, 14); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nb.length, 26);
    parts.push(h, nb, body);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE((3 << 8) | 20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(method, 10);
    c.writeUInt16LE(dosTime, 12); c.writeUInt16LE(dosDate, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nb.length, 28);
    c.writeUInt32LE((0o100644 << 16) >>> 0, 38); c.writeUInt32LE(offset, 42);
    central.push(c, nb); offset += h.length + nb.length + body.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(sorted.length, 8); end.writeUInt16LE(sorted.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}
export function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])); if (eocd < 0) throw new Error("no end-of-central-directory");
  const n = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16); const out = new Map();
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central header");
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lo = buf.readUInt32LE(p + 42), name = buf.toString("utf8", p + 46, p + 46 + nl);
    const ln = buf.readUInt16LE(lo + 26), lx = buf.readUInt16LE(lo + 28), start = lo + 30 + ln + lx, raw = buf.subarray(start, start + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    if (data.length !== usize || crc32(data) !== crc) throw new Error(`CRC/size mismatch: ${name}`);
    out.set(name, data); p += 46 + nl + xl + cl;
  }
  return out;
}

