// Aşama 2 tarayıcı testi: video yükleme, kontrol soruları, ileri sarma engeli, tamamlama, raporlar.
// Önce `PORT=8788 node test/devserver.mjs` çalışıyor olmalı. VIDEO=/yol/test.webm (≥ 30 sn) verilmelidir.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = process.env.BASE || 'http://localhost:8788';
const OUT = process.env.OUT || '/tmp/e2e2';
const VIDEO = process.env.VIDEO;
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];
const watch = (p) => { p.on('console', (m) => { if (m.type() === 'error' && !/status of 40[0-9]/.test(m.text())) errors.push(m.text()); }); p.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message)); };

// ---- Yönetici ----
const actx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'tr-TR' });
const ap = await actx.newPage(); watch(ap);
await ap.goto(BASE);
await ap.fill('#a_setup_code', 'deneme-kodu-123'); await ap.fill('#a_full_name', 'Mehmet Karma');
await ap.fill('#a_username', 'yonetici'); await ap.fill('#a_password', 'Sifre12345');
await ap.click('button:has-text("Kurulumu tamamla")');
await ap.waitForSelector('text=Hoş geldiniz');

const post = async (path, body) => { const r = await actx.request.post(BASE + path, { data: body, headers: { origin: BASE } }); assert.ok(r.ok(), path + ' ' + await r.text()); return r.json(); };
const course = await post('/api/admin/courses', { title: 'Temel İSG', description: 'Deneme' });
const sec = await post(`/api/admin/courses/${course.id}/sections`, { title: 'Genel Konular' });
await post(`/api/admin/sections/${sec.id}/topics`, { title: 'Video konusu', content: 'Kısa not.' });
await post(`/api/admin/sections/${sec.id}/topics`, { title: 'Yazılı konu', content: 'Sadece metin.' });
const usr = await post('/api/admin/users', { full_name: 'Ali Yılmaz', username: 'ali.yilmaz', role: 'learner', job_title: 'Kalıpçı' });
await post('/api/admin/assignments', { course_id: course.id, user_ids: [usr.id] });

// Video yükleme (arayüzden)
await ap.goto(`${BASE}/#/admin/courses/${course.id}`);
await ap.waitForSelector('.topic-row');
await ap.locator('.topic-row', { hasText: 'Video konusu' }).locator('button:has-text("Video")').click();
await ap.setInputFiles('#video_file', VIDEO);
await ap.screenshot({ path: `${OUT}/01-video-modal.png` });
await ap.click('dialog button:has-text("Videoyu yükle")');
await ap.waitForSelector('.chip:has-text("video 0:")', { timeout: 30000 });
await ap.screenshot({ path: `${OUT}/02-video-yuklendi.png`, fullPage: true });

// Kontrol sorusu ekleme (arayüzden): 0:10'da
await ap.locator('.topic-row', { hasText: 'Video konusu' }).locator('button:has-text("Sorular")').click();
await ap.click('dialog button:has-text("+ Soru ekle")');
await ap.fill('#f_at', '0:10');
await ap.selectOption('#f_correct', '2');
await ap.fill('#f_question', 'Baret ne zaman takılır?');
await ap.fill('#f_o0', 'Hiçbir zaman'); await ap.fill('#f_o1', 'Şantiyede her zaman'); await ap.fill('#f_o2', 'Yalnızca yağmurda');
await ap.click('dialog button:has-text("Kaydet")');
await ap.waitForSelector('dialog:has-text("Baret ne zaman takılır?")');
await ap.screenshot({ path: `${OUT}/03-sorular.png` });
await ap.click('dialog button:has-text("Kapat")');
await ap.waitForSelector('.chip:has-text("1 soru")');

// ---- Katılımcı ----
const pw = (await post(`/api/admin/users/${usr.id}/reset-password`, {})).password;
const lctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'tr-TR' });
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
await lp.screenshot({ path: `${OUT}/04-katilimci-egitim.png` });
await lp.click('.learn-topic:has-text("Video konusu")');
await lp.waitForSelector('.player video');
await lp.waitForFunction(() => document.querySelector('.player video').readyState >= 1);
await lp.screenshot({ path: `${OUT}/05-oynatici.png` });

// İleri sarma denemesi
await lp.evaluate(() => { document.querySelector('.player video').currentTime = 30; });
await lp.waitForTimeout(600);
const t1 = await lp.evaluate(() => document.querySelector('.player video').currentTime);
assert.ok(t1 < 5, 'ileri sarma engellenmeli, konum: ' + t1);

// Oynat: soru 10. sn'de çıkmalı
await lp.click('.player-bar button:has-text("Oynat")');
await lp.waitForSelector('.player-question:not(.hidden)', { timeout: 20000 });
const tq = await lp.evaluate(() => document.querySelector('.player video').currentTime);
assert.ok(tq >= 9.5 && tq <= 11.5, 'soru ~10. sn olmalı: ' + tq);
assert.equal(await lp.evaluate(() => document.querySelector('.player video').paused), true);
await lp.screenshot({ path: `${OUT}/06-soru.png` });
// yanlış cevap
await lp.click('.pq-option:has-text("Hiçbir zaman")');
await lp.waitForSelector('.pq-feedback:has-text("Yanlış")');
// doğru cevap
await lp.click('.pq-option:has-text("Şantiyede her zaman")');
await lp.waitForSelector('.player-question.hidden', { state: 'attached' });
await lp.waitForFunction(() => !document.querySelector('.player video').paused, null, { timeout: 5000 });

// Sekme gizlenince duraklama (görünürlük olayını simüle et)
await lp.evaluate(() => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  document.dispatchEvent(new Event('visibilitychange'));
});
await lp.waitForFunction(() => document.querySelector('.player video').paused);
await lp.waitForSelector('.player-notice:not(.hidden)');
await lp.screenshot({ path: `${OUT}/07-sekme-duraklat.png` });
await lp.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });

// Videonun sonuna hızlı geç: sunucu ileri sarmayı reddettiği için gerçek zamanlı izlenmeli (kalan ~28 sn)
await lp.click('.player-bar button:has-text("Oynat")');
await lp.waitForSelector('.chip:has-text("Konu tamamlandı"):not(.hidden)', { timeout: 60000 });
await lp.screenshot({ path: `${OUT}/08-tamamlandi.png` });

// Yazılı konu
await lp.goto(`${BASE}/#/learner/course/${course.id}`);
await lp.click('.learn-topic:has-text("Yazılı konu")');
await lp.waitForTimeout(5500); // sunucu en az 5 sn okuma süresi ister
await lp.click('button:has-text("Konuyu tamamladım")');
await lp.waitForSelector('button:has-text("Tamamlandı ✓")');
await lp.goto(`${BASE}/#/learner/course/${course.id}`);
await lp.waitForSelector('.course-progress');
assert.match(await lp.textContent('.course-progress'), /%100/);
await lp.screenshot({ path: `${OUT}/09-egitim-tamam.png` });

// ---- Raporlar ----
await ap.goto(`${BASE}/#/admin/reports`);
await ap.waitForSelector('td:has-text("Ali Yılmaz")');
assert.match(await ap.textContent('tbody'), /%100/);
await ap.screenshot({ path: `${OUT}/10-rapor.png` });
await ap.click('button:has-text("Ayrıntı")');
await ap.waitForSelector('dialog:has-text("Etkinlik günlüğü")');
const dtxt = await ap.textContent('dialog');
for (const k of ['Sisteme giriş yaptı', 'Konuyu açtı', 'Kontrol sorusu: yanlış cevap', 'Kontrol sorusu: doğru cevap', 'Sekmeden ayrıldı', 'Konuyu tamamladı']) assert.ok(dtxt.includes(k), 'günlükte yok: ' + k);
await ap.screenshot({ path: `${OUT}/11-rapor-detay.png` });

assert.deepEqual(errors, [], 'konsol hataları: ' + errors.join(' | '));
console.log('STAGE2 E2E OK');
await browser.close();
