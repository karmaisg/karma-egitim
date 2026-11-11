// Bağımlılıksız küçük PDF yazıcı (Cloudflare Workers ve Node'da çalışır).
// Çalışma anında yalnızca hazır parçaları birleştirir (yazı tipi paketleri tools/build-fonts.mjs ile önceden hazırlanır),
// böylece ücretsiz plandaki kısa işlemci süresi sınırına takılmaz.
// - Gömülü TrueType yazı tipleri (Identity-H, ToUnicode ile: kopyalama/arama çalışır)
// - PNG arka plan (8 bit RGB), çizgi/dikdörtgen/kutucuk, hizalı metin, harf aralığı

const enc = new TextEncoder();

const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const num = (n) => (Math.round(n * 1000) / 1000).toString();
const hex4 = (n) => n.toString(16).padStart(4, '0').toUpperCase();
const rgb = (c) => c.map((v) => num(v)).join(' ');
export const hexColor = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

class Font {
  constructor(key, meta, bin) { this.key = key; this.meta = meta; this.bin = bin; }
  gid(cp) { return this.meta.cmap[cp] ?? this.meta.fallback; }
  glyphs(str) { return [...str].map((ch) => this.gid(ch.codePointAt(0))); }
  width(str, size, charSpace = 0) {
    let w = 0; let n = 0;
    for (const ch of str) { w += this.meta.adv[this.gid(ch.codePointAt(0))] || 0; n++; }
    return (w * size) / this.meta.upm + charSpace * n;
  }
  // Satırları verilen genişliğe göre sarar
  wrap(str, size, maxWidth) {
    const words = str.split(/\s+/).filter(Boolean);
    const lines = []; let cur = '';
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w;
      if (cur && this.width(t, size) > maxWidth) { lines.push(cur); cur = w; } else cur = t;
    }
    if (cur) lines.push(cur);
    return lines;
  }
}

class Page {
  constructor(w, h) { this.w = w; this.h = h; this.ops = []; this.fonts = new Set(); this.images = new Set(); }
  // y: sayfanın ÜSTÜNDEN ölçülür; metinde y taban çizgisidir.
  text(font, size, x, y, str, { color = [0, 0, 0], charSpace = 0, align = 'left' } = {}) {
    if (!str) return;
    const width = font.width(str, size, charSpace);
    const eff = width - (charSpace && align !== 'left' ? charSpace : 0);
    const px = align === 'center' ? x - eff / 2 : align === 'right' ? x - eff : x;
    const hexs = font.glyphs(str).map(hex4).join('');
    this.fonts.add(font);
    this.ops.push(`BT /${font.key} ${num(size)} Tf ${rgb(color)} rg ${num(charSpace)} Tc ${num(px)} ${num(this.h - y)} Td <${hexs}> Tj ET`);
  }
  line(x1, y1, x2, y2, { width = 0.5, color = [0, 0, 0] } = {}) {
    this.ops.push(`${num(width)} w ${rgb(color)} RG ${num(x1)} ${num(this.h - y1)} m ${num(x2)} ${num(this.h - y2)} l S`);
  }
  rect(x, y, w, h, { fill = null, stroke = null, width = 0.5 } = {}) {
    const pre = [];
    if (fill) pre.push(`${rgb(fill)} rg`);
    if (stroke) pre.push(`${num(width)} w ${rgb(stroke)} RG`);
    this.ops.push(`${pre.join(' ')} ${num(x)} ${num(this.h - y - h)} ${num(w)} ${num(h)} re ${fill && stroke ? 'B' : fill ? 'f' : 'S'}`);
  }
  image(img, x, y, w, h) {
    this.images.add(img);
    this.ops.push(`q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(this.h - y - h)} cm /${img.key} Do Q`);
  }
  // ☒ / ☐ kutucuğu (yazı tipine bağımlı olmadan çizilir)
  checkbox(x, y, size, checked, color = [0, 0, 0]) {
    this.rect(x, y, size, size, { stroke: color, width: 0.8 });
    if (checked) {
      this.line(x + 1.6, y + 1.6, x + size - 1.6, y + size - 1.6, { width: 0.9, color });
      this.line(x + size - 1.6, y + 1.6, x + 1.6, y + size - 1.6, { width: 0.9, color });
    }
  }
}

export class PdfDoc {
  constructor() { this.fonts = []; this.images = []; this.pages = []; this.title = ''; }
  addFont(pack) { const f = new Font('F' + (this.fonts.length + 1), pack.meta, pack.bin); this.fonts.push(f); return f; }
  addPng(bytes) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let p = 8; let ihdr = null; const idat = [];
    while (p < bytes.length) {
      const len = v.getUint32(p); const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
      if (type === 'IHDR') ihdr = { w: v.getUint32(p + 8), h: v.getUint32(p + 12), depth: bytes[p + 16], ctype: bytes[p + 17], interlace: bytes[p + 20] };
      if (type === 'IDAT') idat.push(bytes.subarray(p + 8, p + 8 + len));
      p += 12 + len;
    }
    if (!ihdr || ihdr.depth !== 8 || ihdr.ctype !== 2 || ihdr.interlace !== 0) throw new Error('Yalnızca 8 bit RGB, taramasız PNG desteklenir.');
    const img = { key: 'Im' + (this.images.length + 1), ...ihdr, data: concat(idat) };
    this.images.push(img);
    return img;
  }
  addPage(w, h) { const p = new Page(w, h); this.pages.push(p); return p; }

  build() {
    const objs = [];
    const add = (content) => { objs.push(typeof content === 'string' ? enc.encode(content) : content); return objs.length; };
    const stream = (dict, data) => concat([enc.encode(`<< ${dict} /Length ${data.length} >>\nstream\n`), data, enc.encode('\nendstream')]);
    const reserve = () => { objs.push(null); return objs.length; };
    const set = (id, content) => { objs[id - 1] = typeof content === 'string' ? enc.encode(content) : content; };

    const catalogId = reserve(); const pagesId = reserve();
    const usedFonts = new Set(this.pages.flatMap((p) => [...p.fonts]));
    const fontRefs = new Map();
    for (const f of this.fonts) {
      if (!usedFonts.has(f)) continue;
      const m = f.meta;
      const fileId = add(stream(`/Filter /FlateDecode /Length1 ${m.length1}`, f.bin));
      const name = `${'ABCDEF'}+${m.name}`;
      const descId = add(`<< /Type /FontDescriptor /FontName /${name} /Flags 32 /FontBBox [${m.bbox.join(' ')}] /ItalicAngle 0 /Ascent ${m.ascent} /Descent ${m.descent} /CapHeight ${Math.round(m.ascent * 0.7)} /StemV 80 /FontFile2 ${fileId} 0 R >>`);
      const cidId = add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descId} 0 R /CIDToGIDMap /Identity /DW 1000 /W [${m.w}] >>`);
      const tuId = add(stream('', enc.encode(m.tounicode)));
      fontRefs.set(f, add(`<< /Type /Font /Subtype /Type0 /BaseFont /${name} /Encoding /Identity-H /DescendantFonts [${cidId} 0 R] /ToUnicode ${tuId} 0 R >>`));
    }
    const imgRefs = new Map();
    for (const im of this.images) {
      imgRefs.set(im, add(stream(`/Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors 3 /BitsPerComponent 8 /Columns ${im.w} >>`, im.data)));
    }

    const pageIds = [];
    for (const p of this.pages) {
      const cid = add(stream('', enc.encode(p.ops.join('\n'))));
      const fonts = [...p.fonts].map((f) => `/${f.key} ${fontRefs.get(f)} 0 R`).join(' ');
      const imgs = [...p.images].map((i) => `/${i.key} ${imgRefs.get(i)} 0 R`).join(' ');
      pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${num(p.w)} ${num(p.h)}] /Resources << /Font << ${fonts} >> /XObject << ${imgs} >> >> /Contents ${cid} 0 R >>`));
    }
    set(pagesId, `<< /Type /Pages /Kids [${pageIds.map((i) => i + ' 0 R').join(' ')}] /Count ${pageIds.length} >>`);
    set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
    const info = add(`<< /Title ${pdfUtf16(this.title)} /Producer (KARMA OSGB Egitim Platformu) >>`);

    const parts = [enc.encode('%PDF-1.5\n%\xE2\xE3\xCF\xD3\n')];
    const offsets = []; let pos = parts[0].length;
    objs.forEach((o, i) => {
      offsets.push(pos);
      const head = enc.encode(`${i + 1} 0 obj\n`); const tail = enc.encode('\nendobj\n');
      parts.push(head, o, tail); pos += head.length + o.length + tail.length;
    });
    let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const o of offsets) xref += String(o).padStart(10, '0') + ' 00000 n \n';
    xref += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogId} 0 R /Info ${info} 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
    parts.push(enc.encode(xref));
    return concat(parts);
  }
}

function pdfUtf16(s) {
  let h = 'FEFF';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    h += cp > 0xFFFF ? hex4(0xD800 + ((cp - 0x10000) >> 10)) + hex4(0xDC00 + ((cp - 0x10000) & 0x3FF)) : hex4(cp);
  }
  return `<${h}>`;
}
