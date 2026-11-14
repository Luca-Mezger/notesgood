// Minimal ZIP reader (stored + deflate, ZIP64 aware). Reads entries lazily from a Blob,
// so a multi-gigabyte export never has to fit in memory at once.

export interface ZipEntry { name: string; size: number; data(): Promise<ArrayBuffer> }

const u64 = (v: DataView, o: number) => Number(v.getBigUint64(o, true));

export async function readZip(file: Blob): Promise<ZipEntry[]> {
  const tailLen = Math.min(file.size, 66000);
  const tail = new DataView(await file.slice(file.size - tailLen).arrayBuffer());
  let e = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('Not a ZIP file');
  let count = tail.getUint16(e + 10, true), cdSize = tail.getUint32(e + 12, true), cdOff = tail.getUint32(e + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
    const loc = e - 20;
    if (loc < 0 || tail.getUint32(loc, true) !== 0x07064b50) throw new Error('Unsupported ZIP file');
    const z = new DataView(await file.slice(u64(tail, loc + 8), u64(tail, loc + 8) + 56).arrayBuffer());
    if (z.getUint32(0, true) !== 0x06064b50) throw new Error('Unsupported ZIP file');
    count = u64(z, 32); cdSize = u64(z, 40); cdOff = u64(z, 48);
  }
  const cdBuf = await file.slice(cdOff, cdOff + cdSize).arrayBuffer();
  const cd = new DataView(cdBuf);
  const dec = new TextDecoder();
  const out: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.byteLength; i++) {
    if (cd.getUint32(p, true) !== 0x02014b50) break;
    const method = cd.getUint16(p + 10, true);
    let comp = cd.getUint32(p + 20, true), size = cd.getUint32(p + 24, true), off = cd.getUint32(p + 42, true);
    const nameLen = cd.getUint16(p + 28, true), extraLen = cd.getUint16(p + 30, true), commentLen = cd.getUint16(p + 32, true);
    const name = dec.decode(new Uint8Array(cdBuf, p + 46, nameLen));
    // ZIP64 extra field carries the values that did not fit in 32 bits, in this order.
    let x = p + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = cd.getUint16(x, true), len = cd.getUint16(x + 2, true);
      if (id === 1) {
        let q = x + 4;
        if (size === 0xffffffff) { size = u64(cd, q); q += 8; }
        if (comp === 0xffffffff) { comp = u64(cd, q); q += 8; }
        if (off === 0xffffffff) { off = u64(cd, q); }
      }
      x += 4 + len;
    }
    p = xEnd + commentLen;
    if (name.endsWith('/')) continue;
    out.push({
      name, size,
      async data() {
        const lh = new DataView(await file.slice(off, off + 30).arrayBuffer());
        if (lh.getUint32(0, true) !== 0x04034b50) throw new Error('Corrupt ZIP entry');
        const start = off + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
        const raw = file.slice(start, start + comp);
        if (method === 0) return raw.arrayBuffer();
        if (method !== 8) throw new Error('Unsupported ZIP compression');
        return new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
      },
    });
  }
  return out;
}
