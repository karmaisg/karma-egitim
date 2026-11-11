// Derleme zamanı araçları (yazı tipi paketleri hazırlanırken kullanılır; Worker çalışırken yüklenmez).
const enc = new TextEncoder();

export async function deflate(bytes) {
  const cs = new CompressionStream('deflate');
  const w = cs.writable.getWriter();
  w.write(bytes); w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}
export const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

// ---------- TrueType ----------
export class TTF {
  constructor(bytes) {
    this.b = bytes;
    this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = this.v.getUint16(4);
    this.tables = {};
    for (let i = 0; i < n; i++) {
      const o = 12 + i * 16;
      const tag = String.fromCharCode(...bytes.subarray(o, o + 4));
      this.tables[tag] = { offset: this.v.getUint32(o + 8), length: this.v.getUint32(o + 12) };
    }
    for (const t of ['head', 'hhea', 'maxp', 'hmtx', 'cmap', 'loca', 'glyf']) if (!this.tables[t]) throw new Error('Yazı tipi desteklenmiyor: ' + t);
    const head = this.tables.head.offset;
    this.unitsPerEm = this.v.getUint16(head + 18);
    this.locaFormat = this.v.getInt16(head + 50);
    this.bbox = [this.v.getInt16(head + 36), this.v.getInt16(head + 38), this.v.getInt16(head + 40), this.v.getInt16(head + 42)];
    this.numGlyphs = this.v.getUint16(this.tables.maxp.offset + 4);
    const hhea = this.tables.hhea.offset;
    this.ascent = this.v.getInt16(hhea + 4);
    this.descent = this.v.getInt16(hhea + 6);
    this.numHMetrics = this.v.getUint16(hhea + 34);
    this.cmap = this.readCmap();
  }
  readCmap() {
    const base = this.tables.cmap.offset;
    const n = this.v.getUint16(base + 2);
    let pick = null;
    for (let i = 0; i < n; i++) {
      const pid = this.v.getUint16(base + 4 + i * 8); const eid = this.v.getUint16(base + 6 + i * 8); const off = this.v.getUint32(base + 8 + i * 8);
      const fmt = this.v.getUint16(base + off);
      const score = (pid === 3 && eid === 10 && fmt === 12) ? 4 : (pid === 3 && eid === 1 && fmt === 4) ? 3 : (pid === 0 && fmt === 4) ? 2 : (pid === 0 && fmt === 12) ? 2 : 0;
      if (score && (!pick || score > pick.score)) pick = { score, off: base + off, fmt };
    }
    if (!pick) throw new Error('Yazı tipinde Unicode eşlemesi yok.');
    const map = new Map();
    const v = this.v;
    if (pick.fmt === 12) {
      const groups = v.getUint32(pick.off + 12);
      for (let g = 0; g < groups; g++) {
        const o = pick.off + 16 + g * 12;
        const s = v.getUint32(o); const e = v.getUint32(o + 4); const gid = v.getUint32(o + 8);
        for (let c = s; c <= e && c - s < 70000; c++) map.set(c, gid + (c - s));
      }
    } else {
      const segX2 = v.getUint16(pick.off + 6); const seg = segX2 / 2;
      const endO = pick.off + 14; const startO = endO + segX2 + 2; const deltaO = startO + segX2; const rangeO = deltaO + segX2;
      for (let s = 0; s < seg; s++) {
        const end = v.getUint16(endO + s * 2); const start = v.getUint16(startO + s * 2);
        const delta = v.getInt16(deltaO + s * 2); const ro = v.getUint16(rangeO + s * 2);
        for (let c = start; c <= end && c !== 0xFFFF; c++) {
          let gid;
          if (ro === 0) gid = (c + delta) & 0xFFFF;
          else {
            const gOff = rangeO + s * 2 + ro + (c - start) * 2;
            gid = v.getUint16(gOff);
            if (gid) gid = (gid + delta) & 0xFFFF;
          }
          if (gid) map.set(c, gid);
        }
      }
    }
    return map;
  }
  gid(cp) { return this.cmap.get(cp) || 0; }
  advance(gid) {
    const i = Math.min(gid, this.numHMetrics - 1);
    return this.v.getUint16(this.tables.hmtx.offset + i * 4);
  }
  glyphRange(gid) {
    const loca = this.tables.loca.offset;
    const [s, e] = this.locaFormat === 0
      ? [this.v.getUint16(loca + gid * 2) * 2, this.v.getUint16(loca + gid * 2 + 2) * 2]
      : [this.v.getUint32(loca + gid * 4), this.v.getUint32(loca + gid * 4 + 4)];
    return [this.tables.glyf.offset + s, this.tables.glyf.offset + e];
  }
  // Bileşik harflerin (Ç, Ö, Ğ, Ş gibi) parçalarını da ekler
  closure(gids) {
    const all = new Set([0, ...gids]);
    const queue = [...all];
    while (queue.length) {
      const g = queue.pop();
      const [s, e] = this.glyphRange(g);
      if (e - s < 10 || this.v.getInt16(s) >= 0) continue;
      let p = s + 10; let flags;
      do {
        flags = this.v.getUint16(p);
        const comp = this.v.getUint16(p + 2);
        if (!all.has(comp)) { all.add(comp); queue.push(comp); }
        p += 4 + (flags & 1 ? 4 : 2);
        if (flags & 0x8) p += 2; else if (flags & 0x40) p += 4; else if (flags & 0x80) p += 8;
      } while (flags & 0x20);
    }
    return all;
  }
  // Yalnızca kullanılan glifleri içeren küçük bir TTF üretir (glif numaraları değişmez).
  subset(gids) {
    const keep = this.closure(gids);
    const chunks = []; const loca = new Uint32Array(this.numGlyphs + 1);
    let size = 0;
    for (let g = 0; g < this.numGlyphs; g++) {
      loca[g] = size;
      if (keep.has(g)) {
        const [s, e] = this.glyphRange(g);
        if (e > s) { let len = e - s; chunks.push(this.b.subarray(s, e)); const pad = (4 - (len % 4)) % 4; if (pad) chunks.push(new Uint8Array(pad)); size += len + pad; }
      }
    }
    loca[this.numGlyphs] = size;
    const glyf = concat(chunks);
    const locaBytes = new Uint8Array(loca.buffer.byteLength);
    const lv = new DataView(locaBytes.buffer);
    loca.forEach((x, i) => lv.setUint32(i * 4, x));
    const copy = (tag) => { const t = this.tables[tag]; return t ? this.b.slice(t.offset, t.offset + t.length) : null; };
    const head = copy('head');
    new DataView(head.buffer).setInt16(50, 1); // uzun loca
    new DataView(head.buffer).setUint32(8, 0);
    const parts = { head, hhea: copy('hhea'), maxp: copy('maxp'), hmtx: copy('hmtx'), loca: locaBytes, glyf };
    for (const t of ['cvt ', 'fpgm', 'prep']) { const c = copy(t); if (c) parts[t] = c; }
    const tags = Object.keys(parts).sort();
    const dir = 12 + tags.length * 16;
    let off = dir;
    const bodies = []; const records = [];
    for (const tag of tags) {
      const data = parts[tag]; const padded = (4 - (data.length % 4)) % 4;
      let sum = 0; const dv = new DataView(concat([data, new Uint8Array(padded)]).buffer);
      for (let i = 0; i < dv.byteLength; i += 4) sum = (sum + dv.getUint32(i)) >>> 0;
      records.push({ tag, sum, off, len: data.length });
      bodies.push(data, new Uint8Array(padded));
      off += data.length + padded;
    }
    const header = new Uint8Array(dir); const hv = new DataView(header.buffer);
    hv.setUint32(0, 0x00010000); hv.setUint16(4, tags.length);
    const sr = 2 ** Math.floor(Math.log2(tags.length));
    hv.setUint16(6, sr * 16); hv.setUint16(8, Math.log2(sr)); hv.setUint16(10, tags.length * 16 - sr * 16);
    records.forEach((r, i) => {
      for (let k = 0; k < 4; k++) header[12 + i * 16 + k] = r.tag.charCodeAt(k);
      hv.setUint32(12 + i * 16 + 4, r.sum); hv.setUint32(12 + i * 16 + 8, r.off); hv.setUint32(12 + i * 16 + 12, r.len);
    });
    return concat([header, ...bodies]);
  }
}

