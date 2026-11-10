// Tarayıcı uçtan uca testi (Playwright). Önce `node test/devserver.mjs` çalışıyor olmalı.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.env.BASE || 'http://localhost:8787';
const OUT = process.env.OUT || '/tmp/e2e';
import fs from 'node:fs';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const consoleErrors = [];
const watch = (page) => {
  // Testte bilerek yapılan yanlış kod (403) / yanlış şifre (401) denemelerinin tarayıcı günlükleri sayılmaz.
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of 40[13]/.test(m.text())) consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push('PAGEERROR ' + e.message));
};

// ---- Yönetici ----
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, locale: 'tr-TR' });
const page = await ctx.newPage();
watch(page);
await page.goto(BASE);
await page.waitForSelector('text=İlk kurulum');
await page.screenshot({ path: `${OUT}/01-kurulum.png` });

// yanlış kod
await page.fill('#a_setup_code', 'yanlis-kod-xx');
await page.fill('#a_full_name', 'Mehmet Karma');
await page.fill('#a_username', 'yonetici');
await page.fill('#a_password', 'Sifre12345');
await page.click('button:has-text("Kurulumu tamamla")');
await page.waitForSelector('.form-error:not(.hidden)');
assert.match(await page.textContent('.form-error'), /Kurulum kodu hatalı/);
await page.fill('#a_setup_code', 'deneme-kodu-123');
await page.click('button:has-text("Kurulumu tamamla")');
await page.waitForSelector('text=Hoş geldiniz, Mehmet');
await page.screenshot({ path: `${OUT}/02-ozet.png` });

// firma
await page.click('nav >> text=Firmalar');
await page.click('button:has-text("+ Yeni firma")');
await page.fill('#f_name', 'Örnek İnşaat A.Ş.');
await page.selectOption('#f_hazard_class', 'cok_tehlikeli');
await page.click('dialog button:has-text("Kaydet")');
await page.waitForSelector('td:has-text("Örnek İnşaat A.Ş.")');

// eğitim
await page.click('nav >> text=Eğitimler');
await page.click('button:has-text("+ Yeni eğitim")');
await page.fill('#f_title', 'Temel İş Sağlığı ve Güvenliği Eğitimi');
await page.fill('#f_description', 'Çok tehlikeli sınıf işyerleri için 16 saatlik temel eğitim.');
await page.click('dialog button:has-text("Oluştur")');
await page.waitForSelector('h1:has-text("Temel İş Sağlığı")');
await page.click('button:has-text("+ Bölüm ekle")');
await page.fill('#f_title', 'Genel Konular');
await page.click('dialog button:has-text("Ekle")');
await page.waitForSelector('h3:has-text("Genel Konular")');
await page.click('button:has-text("+ Bölüm ekle")');
await page.fill('#f_title', 'Sağlık Konuları');
await page.click('dialog button:has-text("Ekle")');
await page.waitForSelector('h3:has-text("Sağlık Konuları")');
// konu ekle (ilk bölüme)
await page.locator('section', { hasText: 'Genel Konular' }).first().locator('button:has-text("+ Konu ekle")').click();
await page.fill('#f_title', 'Çalışma mevzuatı');
await page.fill('#f_content', 'Birinci satır.\nİkinci satır <script>window.__xss = 1</script>');
await page.click('dialog button:has-text("Ekle")');
await page.waitForSelector('.t-title:has-text("Çalışma mevzuatı")');
await page.locator('section', { hasText: 'Genel Konular' }).first().locator('button:has-text("+ Konu ekle")').click();
await page.fill('#f_title', 'İSG kanunu');
await page.click('dialog button:has-text("Ekle")');
await page.waitForSelector('.t-title:has-text("İSG kanunu")');
// sıralama: ikinci konuyu yukarı al
await page.locator('.topic-row', { hasText: 'İSG kanunu' }).locator('button[aria-label="Yukarı taşı"]').click();
await page.waitForFunction(() => document.querySelector('.topic-row .t-title b')?.textContent === 'İSG kanunu');
await page.screenshot({ path: `${OUT}/03-egitim-duzenle.png`, fullPage: true });

// katılımcı
await page.click('nav >> text=Katılımcılar');
await page.click('button:has-text("+ Yeni katılımcı")');
await page.fill('#f_full_name', 'Ali Yılmaz');
await page.fill('#f_username', 'ali.yilmaz');
await page.selectOption('#f_company_id', { label: 'Örnek İnşaat A.Ş.' });
await page.fill('#f_job_title', 'Kalıpçı');
await page.click('dialog button:has-text("Oluştur")');
await page.waitForSelector('.cred code');
const creds = await page.locator('.cred code').allTextContents();
assert.equal(creds[0], 'ali.yilmaz');
const learnerPw = creds[1];
assert.equal(learnerPw.length, 10);
await page.screenshot({ path: `${OUT}/04-sifre-gosterimi.png` });
await page.click('dialog button:has-text("Tamam")');
await page.waitForSelector('td:has-text("Ali Yılmaz")');
// Alanlar birbirine karışmamalı (hızlı yazımda odak kayması hatası için regresyon kontrolü)
const aliRow = page.locator('tbody tr', { hasText: 'ali.yilmaz' });
assert.equal((await aliRow.locator('td').first().locator('b').textContent()).trim(), 'Ali Yılmaz');
assert.match(await aliRow.locator('td').nth(1).textContent(), /Kalıpçı/);
await page.screenshot({ path: `${OUT}/05-katilimcilar.png` });

// atama
await page.click('nav >> text=Atamalar');
await page.selectOption('#as_course', { label: 'Temel İş Sağlığı ve Güvenliği Eğitimi' });
await page.locator('.pick', { hasText: 'Ali Yılmaz' }).click();
await page.click('button:has-text("Seçilenlere ata")');
await page.waitForSelector('td:has-text("Temel İş Sağlığı ve Güvenliği Eğitimi")');
await page.screenshot({ path: `${OUT}/06-atama.png`, fullPage: true });
await page.click('button:has-text("Çıkış")');
await page.waitForSelector('text=Hesabınızla giriş yaparak');
await page.screenshot({ path: `${OUT}/07-giris.png` });

// ---- Katılımcı ----
const lctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'tr-TR' });
const lp = await lctx.newPage();
watch(lp);
await lp.goto(BASE);
await lp.fill('#a_username', 'ali.yilmaz');
await lp.fill('#a_password', 'yanlis-sifre');
await lp.click('button:has-text("Giriş yap")');
await lp.waitForSelector('.form-error:not(.hidden)');
assert.match(await lp.textContent('.form-error'), /hatalı/);
await lp.fill('#a_password', learnerPw);
await lp.click('button:has-text("Giriş yap")');
await lp.waitForSelector('h1:has-text("Eğitimlerim")');
assert.equal(await lp.locator('nav a').count(), 1, 'katılımcıda yönetici menüsü olmamalı');
await lp.screenshot({ path: `${OUT}/08-katilimci-ana.png` });
await lp.click('a.course-card');
await lp.waitForSelector('.learn-topic');
await lp.screenshot({ path: `${OUT}/09-katilimci-egitim.png` });
await lp.click('.learn-topic:has-text("Çalışma mevzuatı")');
await lp.waitForSelector('.content-box');
const txt = await lp.textContent('.content-box');
assert.ok(txt.includes('<script>'), 'script etiketi düz metin olarak gösterilmeli');
assert.equal(await lp.evaluate(() => window.__xss), undefined, 'XSS çalışmamalı');
await lp.screenshot({ path: `${OUT}/10-katilimci-konu.png` });
// yönetici adresine gitmeyi dene
await lp.goto(BASE + '/#/admin/users');
await lp.waitForSelector('h1:has-text("Eğitimlerim")');
// şifre değiştir
await lp.click('button:has-text("Şifre")');
await lp.fill('#f_current_password', learnerPw);
await lp.fill('#f_new_password', 'YeniSifre2026');
await lp.fill('#f_again', 'YeniSifre2026');
await lp.click('dialog button:has-text("Şifreyi değiştir")');
await lp.waitForSelector('.toast:has-text("Şifreniz değiştirildi")');

// ---- Mobil görünüm ----
const mctx = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'tr-TR' });
const mp = await mctx.newPage();
watch(mp);
await mp.goto(BASE);
await mp.fill('#a_username', 'ali.yilmaz');
await mp.fill('#a_password', 'YeniSifre2026');
await mp.click('button:has-text("Giriş yap")');
await mp.waitForSelector('h1:has-text("Eğitimlerim")');
await mp.screenshot({ path: `${OUT}/11-mobil.png` });
const overflow = await mp.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
assert.equal(overflow, false, 'mobilde yatay kaydırma olmamalı');

await browser.close();
console.log('Konsol hataları:', consoleErrors.length ? consoleErrors : 'yok');
assert.equal(consoleErrors.length, 0);
console.log('E2E TAMAM');
