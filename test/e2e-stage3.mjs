// Aşama 3 tarayıcı testi: sınav hazırlama (yönetici), sınava girme (katılımcı), sonuçlar ve hak tanıma.
// Önce `PORT=8788 node test/devserver.mjs` çalışıyor olmalı.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = process.env.BASE || 'http://localhost:8788';
const OUT = process.env.OUT || '/tmp/e2e3';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const errors = [];
const watch = (p) => { p.on('console', (m) => { if (m.type() === 'error' && !/status of 40[0-9]/.test(m.text())) errors.push(m.text()); }); p.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message)); };

const actx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'tr-TR' });
const ap = await actx.newPage(); watch(ap);
await ap.goto(BASE);
await ap.fill('#a_setup_code', 'deneme-kodu-123'); await ap.fill('#a_full_name', 'Mehmet Karma');
await ap.fill('#a_username', 'yonetici'); await ap.fill('#a_password', 'Sifre12345');
await ap.click('button:has-text("Kurulumu tamamla")');
await ap.waitForSelector('text=Hoş geldiniz');
const post = async (path, body) => { const r = await actx.request.post(BASE + path, { data: body, headers: { origin: BASE } }); assert.ok(r.ok(), path + ' ' + await r.text()); return r.json(); };
const course = await post('/api/admin/courses', { title: 'Temel İSG' });
const sec = await post(`/api/admin/courses/${course.id}/sections`, { title: 'Genel Konular' });
const t1 = await post(`/api/admin/sections/${sec.id}/topics`, { title: 'Yüksekte çalışma', content: 'Emniyet kemeri kullanılır.' });
const usr = await post('/api/admin/users', { full_name: 'Ali Yılmaz', username: 'ali.yilmaz', role: 'learner' });
await post('/api/admin/assignments', { course_id: course.id, user_ids: [usr.id] });
const fin = await post(`/api/admin/courses/${course.id}/exams`, { kind: 'final' });
for (let i = 1; i <= 2; i++) await post(`/api/admin/exams/${fin.id}/questions`, { question: `Final sorusu ${i}?`, options: ['Yanlış', 'Doğru'], correct: 1 });

// ---- Yönetici: konu sınavı soruları (arayüzden) ----
await ap.goto(`${BASE}/#/admin/courses/${course.id}`);
await ap.waitForSelector('.topic-row');
await ap.locator('.topic-row', { hasText: 'Yüksekte çalışma' }).locator('button:has-text("Sınav")').click();
await ap.waitForSelector('dialog:has-text("konu sınavı")');
const addQ = async (q, opts, correct) => {
  await ap.click('dialog button:has-text("+ Soru ekle")');
  await ap.fill('#f_question', q);
  for (let i = 0; i < opts.length; i++) await ap.fill('#f_o' + i, opts[i]);
  await ap.selectOption('#f_correct', String(correct));
  await ap.click('dialog button:has-text("Kaydet")');
  await ap.waitForSelector(`dialog:has-text("${q}")`);
};
await addQ('Hangi KKD yüksekte çalışmada zorunludur?', ['Gözlük', 'Emniyet kemeri', 'Kulaklık'], 2);
await addQ('Yüksekte çalışma kaç metreden başlar?', ['2 metre', '5 metre', '10 metre', '20 metre'], 1);
await addQ('İskele kontrolü kimin sorumluluğundadır?', ['Yetkili kişi', 'Herkes ilgisiz', 'Ziyaretçi'], 1);
await ap.screenshot({ path: `${OUT}/01-yonetici-sinav.png` });
await ap.click('dialog button:has-text("Kapat")');
await ap.waitForSelector('button:has-text("Sınav (3)")');
await ap.screenshot({ path: `${OUT}/02-yonetici-egitim.png`, fullPage: true });

// ---- Katılımcı ----
const pw = (await post(`/api/admin/users/${usr.id}/reset-password`, {})).password;
const lctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, locale: 'tr-TR' });
const lp = await lctx.newPage(); watch(lp);
await lp.goto(BASE);
await lp.fill('#a_username', 'ali.yilmaz'); await lp.fill('#a_password', pw);
await lp.click('button:has-text("Giriş yap")');
await lp.waitForSelector('#consent_chk, h1:has-text("Eğitimlerim")');
if (await lp.locator('#consent_chk').count()) {
  // Aydınlatma metni onayı: işaretlenmeden düğme kapalı olmalı
  assert.equal(await lp.locator('button:has-text("Onaylıyorum ve devam ediyorum")').isDisabled(), true);
  if (process.env.OUT || true) await lp.screenshot({ path: (process.env.OUT || '/tmp') + '/consent-' + Date.now() + '.png' });
  await lp.check('#consent_chk');
  await lp.click('button:has-text("Onaylıyorum ve devam ediyorum")');
}
await lp.waitForSelector('h1:has-text("Eğitimlerim")');
await lp.click('a.course-card');
await lp.waitForSelector('.learn-topic');
await lp.screenshot({ path: `${OUT}/03-katilimci-egitim.png`, fullPage: true });
// konu bitmeden konu sınavı kilitli, final kilitli
assert.ok(await lp.locator('.exam-row', { hasText: 'konu sınavı' }).locator('.chip:has-text("Kilitli")').count());
assert.ok(await lp.locator('.exam-row', { hasText: 'Eğitim sonu' }).locator('.chip:has-text("Kilitli")').count());
await lp.click('.exam-row:has-text("konu sınavı")');
await lp.waitForSelector('.callout:has-text("Önce bu konuyu tamamlamalısınız")');

// Konuyu tamamla
await lp.goto(`${BASE}/#/learner/course/${course.id}/topic/${t1.id}`);
await lp.waitForSelector('button:has-text("Konuyu tamamladım")');
await lp.waitForTimeout(5500);
await lp.click('button:has-text("Konuyu tamamladım")');
await lp.waitForSelector('button:has-text("Tamamlandı ✓")');
await lp.click('.exam-card');
await lp.waitForSelector('button:has-text("Sınava başla")');
await lp.screenshot({ path: `${OUT}/04-sinav-bilgi.png` });

// 1. deneme: bilerek yanlış (hepsini ilk seçenek işaretle, ardından boş bırak)
await lp.click('button:has-text("Sınava başla")');
await lp.waitForSelector('.exam-q');
assert.equal(await lp.locator('.exam-q').count(), 3);
await lp.locator('.exam-q').first().locator('input').first().check();
await lp.screenshot({ path: `${OUT}/05-sinav.png`, fullPage: true });
await lp.click('button:has-text("Sınavı bitir")');
await lp.waitForSelector('dialog:has-text("boş bıraktınız")');
await lp.click('dialog button:has-text("Evet, bitir")');
await lp.waitForSelector('.result');
const r1 = await lp.textContent('.result');
assert.match(r1, /Kalan deneme hakkınız: 2/);
await lp.screenshot({ path: `${OUT}/06-sonuc-basarisiz.png` });

// 2. deneme: doğru cevapları metne göre seç
const pick = async (map) => {
  const qs = lp.locator('.exam-q');
  for (let i = 0; i < await qs.count(); i++) {
    const text = await qs.nth(i).locator('legend').textContent();
    const want = Object.entries(map).find(([k]) => text.includes(k))[1];
    await qs.nth(i).locator('label', { hasText: want }).locator('input').check();
  }
};
await lp.goto(`${BASE}/#/learner/course/${course.id}`);
await lp.click('.exam-row:has-text("konu sınavı")');
await lp.click('button:has-text("Sınava başla")');
await lp.waitForSelector('.exam-q');
await pick({ 'KKD': 'Emniyet kemeri', 'kaç metre': '2 metre', 'İskele': 'Yetkili kişi' });
await lp.click('button:has-text("Sınavı bitir")');
await lp.click('dialog button:has-text("Evet, bitir")');
await lp.waitForSelector('.result-pass');
assert.equal((await lp.textContent('.score b')).trim(), '100', 'tüm sorular doğru olmalı');
await lp.screenshot({ path: `${OUT}/07-sonuc-basarili.png` });

// Final sınavı artık açık
await lp.goto(`${BASE}/#/learner/course/${course.id}`);
await lp.click('.exam-row:has-text("Eğitim sonu")');
await lp.waitForSelector('button:has-text("Sınava başla")');
await lp.screenshot({ path: `${OUT}/08-final-hazir.png` });
// Final sınavında bilerek başarısız ol (her soruda 'Yanlış' seçeneği)
await lp.click('button:has-text("Sınava başla")');
await lp.waitForSelector('.exam-q');
const fq = lp.locator('.exam-q');
for (let i = 0; i < await fq.count(); i++) await fq.nth(i).locator('label', { hasText: 'Yanlış' }).locator('input').check();
await lp.click('button:has-text("Sınavı bitir")');
await lp.click('dialog button:has-text("Evet, bitir")');
await lp.waitForSelector('.result-fail');

// ---- Yönetici: sonuçlar ----
await ap.goto(`${BASE}/#/admin/exams`);
await ap.waitForSelector('td:has-text("Ali Yılmaz")');
assert.equal(await ap.locator('tbody tr').count(), 3);
const body = await ap.textContent('tbody');
assert.match(body, /Başarısız/); assert.match(body, /Başarılı/);
await ap.screenshot({ path: `${OUT}/09-sonuclar.png` });
// Sonradan geçilen konu sınavının eski başarısız satırında 'Hak tanı' yok; yalnızca final satırında var
assert.equal(await ap.locator('button:has-text("Hak tanı")').count(), 1);
await ap.locator('tbody tr', { hasText: 'Eğitim sonu sınavı' }).locator('button:has-text("Cevaplar")').click();
await ap.waitForSelector('dialog:has-text("Yanlış"), dialog:has-text("Boş")');
await ap.screenshot({ path: `${OUT}/10-cevap-detay.png` });
await ap.click('dialog button:has-text("Kapat")');
await ap.locator('tbody tr', { hasText: 'Eğitim sonu sınavı' }).locator('button:has-text("Hak tanı")').click();
await ap.fill('#f_note', 'Eğitime yeniden katıldı');
await ap.click('dialog button:has-text("Hak tanı")');
await ap.waitForSelector('text=Yeni hak tanındı');

assert.deepEqual(errors, [], 'konsol hataları: ' + errors.join(' | '));
console.log('STAGE3 E2E OK');
await browser.close();
