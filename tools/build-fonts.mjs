// Yazı tipi paketlerini hazırlar: tools/fonts/*.ttf  ->  public/pdf/fonts/<ad>.json + <ad>.bin
// Neden: Cloudflare ücretsiz planında istek başına çok kısa işlemci süresi vardır; yazı tiplerini her belgede
// ayrıştırmak yerine bir kez burada küçültüp hazır paket olarak saklıyoruz.
// Çalıştırma: node tools/build-fonts.mjs
import fs from 'node:fs';
import path from 'node:path';
import { TTF, deflate } from '../src/ttf.js';

const FONTS = {
  carlito: 'Carlito-Regular.ttf',
  carlitoBold: 'Carlito-Bold.ttf',
  serif: 'LiberationSerif-Regular.ttf',
  poppins: 'Poppins-Regular.ttf',
  poppinsBold: 'Poppins-Bold.ttf',
};

// Belgede kullanılabilecek karakterler: ASCII, Latin-1, Latin Genişletilmiş-A (Türkçe/Kürtçe harfler) ve yaygın noktalama
const CHARSET = [];
const range = (a, b) => { for (let c = a; c <= b; c++) CHARSET.push(c); };
range(0x20, 0x7E); range(0xA0, 0xFF); range(0x100, 0x17F);
CHARSET.push(0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2026, 0x20BA);

const hex4 = (n) => n.toString(16).padStart(4, '0').toUpperCase();
const outDir = path.resolve('public/pdf/fonts');
fs.mkdirSync(outDir, { recursive: true });

for (const [key, file] of Object.entries(FONTS)) {
  const ttf = new TTF(new Uint8Array(fs.readFileSync(path.join('tools/fonts', file))));
  const cmap = {}; const gids = new Set();
  for (const cp of CHARSET) { const g = ttf.gid(cp); if (g) { cmap[cp] = g; gids.add(g); } }
  const sub = ttf.subset([...gids]);
  const bin = await deflate(sub);
  const sc = 1000 / ttf.unitsPerEm;
  const sorted = [...gids].sort((a, b) => a - b);
  const adv = {}; for (const g of sorted) adv[g] = ttf.advance(g);
  const w = sorted.map((g) => `${g} [${Math.round(adv[g] * sc)}]`).join(' ');
  const rev = new Map(); for (const [cp, g] of Object.entries(cmap)) if (!rev.has(g)) rev.set(g, Number(cp));
  let tu = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Adobe-Identity-UCS def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange\n';
  for (let i = 0; i < sorted.length; i += 100) {
    const part = sorted.slice(i, i + 100);
    tu += `${part.length} beginbfchar\n` + part.map((g) => `<${hex4(g)}> <${hex4(rev.get(g))}>`).join('\n') + '\nendbfchar\n';
  }
  tu += 'endcmap CMapName currentdict /CMap defineresource pop end end';
  const meta = {
    name: key, upm: ttf.unitsPerEm, ascent: Math.round(ttf.ascent * sc), descent: Math.round(ttf.descent * sc),
    bbox: ttf.bbox.map((v) => Math.round(v * sc)), cmap, adv, w, tounicode: tu, length1: sub.length,
    fallback: cmap[0x3F] || cmap[0x20],
  };
  fs.writeFileSync(path.join(outDir, key + '.json'), JSON.stringify(meta));
  fs.writeFileSync(path.join(outDir, key + '.bin'), bin);
  console.log(key.padEnd(14), 'glif', gids.size, 'boyut', bin.length, 'bayt');
}
