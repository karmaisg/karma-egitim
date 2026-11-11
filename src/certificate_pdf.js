// Katılım belgesi PDF'i. 1. sayfa: örnek belgenin (A4 yatay, süslü çerçeveli) birebir yerleşimi.
// 2. sayfa (ve gerekirse devamı): eğitim konuları ve süreleri.
import { PdfDoc, hexColor } from './pdf.js';

const W = 841.89;
const H = 595.3;
const BLUE = hexColor('#0E3A89');
const BLACK = [0, 0, 0];
const GRAY = hexColor('#D9D9D9');

const trUpper = (s) => String(s || '').toLocaleUpperCase('tr-TR');
export const fmtDate = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

export function datesText(dates) {
  const d = dates.map(fmtDate);
  if (d.length <= 1) return `${d[0] || ''} tarihinde`;
  return `${d.slice(0, -1).join(', ')} ve ${d[d.length - 1]} tarihlerinde`;
}
export function hoursText(h) {
  const n = Number(h);
  return `${Number.isInteger(n) ? n : String(n).replace('.', ',')} saat`;
}
const LETTERS = 'abcçdefgğhıijklmnoöprsştuüvyz'.split('');
const letter = (i) => (i < LETTERS.length ? LETTERS[i] + ')' : `${i + 1})`);

// snap: belge anındaki bilgiler (veritabanında saklanan kayıt)
// assets: { fonts: {carlito, carlitoBold, serif, poppins, poppinsMedium}, frame: Uint8Array }
export function buildCertificatePdf(snap, assets) {
  const doc = new PdfDoc();
  doc.title = `Katılım Belgesi — ${snap.name}`;
  const F = {};
  for (const [k, pack] of Object.entries(assets.fonts)) F[k] = doc.addFont(pack);
  const frame = doc.addPng(assets.frame);

  // ---------- 1. sayfa ----------
  const p = doc.addPage(W, H);
  p.image(frame, 41.7, 19.6, 759.6, 536.8); // örnek belgedeki konum ve boyut

  // Başlık: mavi, serif, geniş harf aralıklı (görünen genişlik ≈ 628 pt, 112,5 → 740,5)
  const title = 'TEMEL EĞİTİM BELGESİ';
  const base = F.serif.width(title, 36);
  const cs = (628 - base) / (title.length - 1);
  p.text(F.serif, 36, 112.5, 98 + 0.891 * 36, title, { color: BLUE, charSpace: cs });

  const cx = W / 2;
  p.text(F.poppinsBold, 18.5, cx, 153.9 + 0.969 * 20, trUpper(snap.name), { align: 'center' });
  p.text(F.poppinsBold, 13.5, cx, 187.1 + 0.969 * 15, trUpper(snap.job_title), { align: 'center' });

  const para = `Çalışanların İş Sağlığı ve Güvenliği Eğitimlerinin Usul ve Esasları Hakkında Yönetmelik kapsamında ${snap.org_title} tarafından ${datesText(snap.dates)} gerçekleştirilen temel eğitim sonunda düzenlenmiştir.`;
  F.poppins.wrap(para, 14, 606).forEach((line, i) => p.text(F.poppins, 14, cx, 214.3 + i * 18.1 + 0.969 * 15, line, { align: 'center' }));

  // Alan tablosu (etiket: kalın, değer: normal) — satır aralığı 17,1 pt
  const X0 = 113.5; const X1 = 329.5; const X2 = 545.5;
  const row = (i) => 302.1 + i * 17.12 + 0.952 * 14;
  const label = (i, t) => p.text(F.carlitoBold, 14, X0, row(i), t);
  const val = (i, x, t) => p.text(F.carlito, 14, x, row(i), t);
  const boxed = (i, x, t, checked) => {
    p.text(F.carlito, 14, x, row(i), t);
    p.checkbox(x + F.carlito.width(t, 14) + 5, row(i) - 9.4, 9.4, checked);
  };
  label(0, 'Belge düzenlenme tarihi:'); val(0, X1, fmtDate(snap.issued_date));
  label(1, 'Eğitimin süresi:'); val(1, X1, hoursText(snap.hours));
  label(2, 'Eğitimin türü:');
  boxed(2, X1, 'İlk defa verilen temel eğitim', snap.training_type !== 'tekrar');
  boxed(2, X2, 'Tekrar verilen temel eğitim', snap.training_type === 'tekrar');
  label(3, 'Eğitimin şekli:');
  boxed(3, X1, 'Yüz yüze', !!snap.in_person);
  boxed(3, X2, 'Uzaktan', !!snap.remote);
  label(4, 'Eğiticilerin adı soyadı ve unvanı:');
  const [t1, t2] = snap.trainers;
  if (t1) { val(4, X1, t1.name); val(5, X1, t1.title); }
  if (t2) { val(4, X2, t2.name); val(5, X2, t2.title); }
  label(6, 'Eğiticilerin imzası:');
  // imza boşluğu: 7. ve 8. satırlar
  label(9, 'Çalışanın işyerinin unvanı:'); val(9, X1, snap.company_name || '');
  label(10, 'İşveren/işveren vekili adı soyadı:');
  if (snap.employers[0]) val(10, X1, snap.employers[0]);
  if (snap.employers[1]) val(10, X2, snap.employers[1]);
  label(11, 'İşveren/işveren vekili imzası:');

  // ---------- 2. sayfa: eğitim konuları ----------
  const FS = 9.5; const LH = 11.4; const PADY = 1.3;
  const colTopic = 278; const colTime = 49.6;
  const lx = 92.7;
  const rx = lx + colTopic + colTime + 0.1;
  const top0 = 132; const bottom = 528;
  const cols = [{ x: lx }, { x: rx }];

  const flat = [];
  snap.sections.forEach((s, si) => {
    flat.push({ type: 'section', text: `${si + 1}. ${trUpper(s.title)}` });
    s.topics.forEach((t, ti) => flat.push({ type: 'topic', text: `${letter(ti)} ${t.title}`, minutes: t.minutes }));
  });

  let page = null; let col = 0; let y = 0; let pageNo = 1;
  const header = (pg, c, yy) => {
    const x = cols[c].x;
    pg.rect(x, yy, colTopic, 17, { fill: GRAY, stroke: BLACK, width: 0.6 });
    pg.rect(x + colTopic, yy, colTime, 17, { fill: GRAY, stroke: BLACK, width: 0.6 });
    pg.text(F.carlitoBold, FS, x + colTopic / 2, yy + 12, 'EĞİTİM KONULARI', { align: 'center' });
    pg.text(F.carlitoBold, FS, x + colTopic + colTime / 2, yy + 12, 'SÜRE', { align: 'center' });
    return yy + 17;
  };
  const newPage = () => {
    page = doc.addPage(W, H); pageNo++; col = 0;
    if (pageNo === 2) page.text(F.carlitoBold, 20, cx, 85.8 + 0.952 * 20, 'EĞİTİM KONULARI', { align: 'center' });
    y = header(page, 0, pageNo === 2 ? top0 : 60);
    page._top = pageNo === 2 ? top0 : 60;
  };
  newPage();

  const advance = () => {
    if (col === 0) { col = 1; y = header(page, 1, page._top); } else newPage();
  };
  for (const item of flat) {
    const x = cols[col].x;
    const lines = F.carlito.wrap(item.text, FS, colTopic - (item.type === 'section' ? 10 : 18));
    const h = Math.max(1, lines.length) * LH + PADY * 2;
    if (y + h > bottom) { advance(); }
    const cxx = cols[col].x;
    if (item.type === 'section') {
      page.rect(cxx, y, colTopic + colTime, h, { fill: GRAY, stroke: BLACK, width: 0.4 });
      lines.forEach((l, i) => page.text(F.carlitoBold, FS, cxx + 5, y + PADY + 0.952 * FS + i * LH, l));
    } else {
      page.rect(cxx, y, colTopic, h, { stroke: BLACK, width: 0.4 });
      page.rect(cxx + colTopic, y, colTime, h, { stroke: BLACK, width: 0.4 });
      lines.forEach((l, i) => page.text(F.carlito, FS, cxx + (i === 0 ? 8 : 17), y + PADY + 0.952 * FS + i * LH, l));
      if (item.minutes) page.text(F.carlito, FS, cxx + colTopic + colTime / 2, y + PADY + 0.952 * FS, `${item.minutes} dk`, { align: 'center' });
    }
    y += h;
    void x;
  }
  if (flat.length === 0) page.text(F.carlito, FS, lx + 6, y + 14, 'Bu eğitimde kayıtlı konu bulunmuyor.');

  // Alt bilgi: belge numarası (tüm ek sayfalarda)
  const total = doc.pages.length;
  doc.pages.forEach((pg, i) => {
    if (i === 0) return;
    pg.text(F.carlito, 8, lx, 560, `Belge No: ${snap.number}`, { color: hexColor('#666666') });
    pg.text(F.carlito, 8, W - lx, 560, `Sayfa ${i + 1} / ${total}`, { color: hexColor('#666666'), align: 'right' });
  });
  return doc.build();
}

// getBytes('fonts/carlito.json') gibi göreli adla dosya baytlarını döndüren bir işlev verilir.
export async function loadAssets(getBytes) {
  const dec = new TextDecoder();
  const fonts = {};
  for (const k of ['carlito', 'carlitoBold', 'serif', 'poppins', 'poppinsBold']) {
    const [meta, bin] = await Promise.all([getBytes(`fonts/${k}.json`), getBytes(`fonts/${k}.bin`)]);
    fonts[k] = { meta: JSON.parse(dec.decode(meta)), bin };
  }
  return { fonts, frame: await getBytes('cerceve.png') };
}
