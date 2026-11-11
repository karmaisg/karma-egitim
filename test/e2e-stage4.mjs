// Aşama 4 tarayıcı testi: belge bilgileri (yönetici), eğitimi bitirme, belgeyi indirme, belge listesi.
// Önce `PORT=8788 node test/devserver.mjs` çalışıyor olmalı. Boş veritabanıyla başlayın.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = process.env.BASE || 'http://localhost:8788';
const OUT = process.env.OUT || '/tmp/e2e4';
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
const post = async (ctx, path, body) => { const r = await ctx.request.post(BASE + path, { data: body, headers: { origin: BASE } }); assert.ok(r.ok(), path + ' ' + await r.text()); return r.json(); };

// Firma: işveren adları arayüzden
await ap.goto(`${BASE}/#/admin/companies`);
await ap.click('button:has-text("+ Yeni firma")');
await ap.fill('#f_name', 'Erkos Çevre ve İş Güvenliği A.Ş.');
await ap.fill('#f_employer_1', 'Kaan KOSTAK'); await ap.fill('#f_employer_2', 'Burak ERTEK');
await ap.click('dialog button:has-text("Kaydet")');
await ap.waitForSelector('td:has-text("Erkos")');
const companies = await (await actx.request.get(BASE + '/api/admin/companies')).json();
const company = companies.companies[0].id;

const course = await post(actx, '/api/admin/courses', { title: 'Temel İSG Eğitimi' });
const sec = await post(actx, `/api/admin/courses/${course.id}/sections`, { title: 'Genel konular' });
const t1 = await post(actx, `/api/admin/sections/${sec.id}/topics`, { title: 'Çalışma mevzuatı ile ilgili bilgiler', content: 'a' });
const t2 = await post(actx, `/api/admin/sections/${sec.id}/topics`, { title: 'İlkyardım', content: 'b' });
const fin = await post(actx, `/api/admin/courses/${course.id}/exams`, { kind: 'final' });
await post(actx, `/api/admin/exams/${fin.id}/questions`, { question: 'Soru 1?', options: ['Yanlış', 'Doğru'], correct: 1 });
const usr = await post(actx, '/api/admin/users', { full_name: 'Ercan Çömek', username: 'ercan', role: 'learner', job_title: 'Satış Sorumlusu', company_id: company });
await post(actx, '/api/admin/assignments', { course_id: course.id, user_ids: [usr.id] });

// Yönetici: belge bilgileri (arayüzden)
await ap.goto(`${BASE}/#/admin/courses/${course.id}`);
await ap.waitForSelector('text=Katılım belgesi');
await ap.locator('section', { hasText: 'Belge bilgileri' }).locator('button:has-text("Düzenle")').click();
await ap.fill('#f_hours', '8');
await ap.selectOption('#f_form', 'remote');
await ap.fill('#f_t1_name', 'İrem Hande ŞENKAL'); await ap.fill('#f_t1_title', 'B Sınıfı İş Güvenliği Uzmanı');
await ap.fill('#f_t2_name', 'Dr.Sedat AKAR'); await ap.fill('#f_t2_title', 'İşyeri Hekimi');
await ap.screenshot({ path: `${OUT}/01-belge-bilgileri.png` });
await ap.click('dialog button:has-text("Kaydet")');
await ap.waitForSelector('text=Belge bilgileri kaydedildi');
await ap.screenshot({ path: `${OUT}/02-egitim-sayfasi.png`, fullPage: true });

// ---- Katılımcı ----
const pw = (await post(actx, `/api/admin/users/${usr.id}/reset-password`, {})).password;
const lctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, locale: 'tr-TR', acceptDownloads: true });
const lp = await lctx.newPage(); watch(lp);
await lp.goto(BASE);
await lp.fill('#a_username', 'ercan'); await lp.fill('#a_password', pw);
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
await lp.waitForSelector('.cert-card');
assert.match(await lp.textContent('.cert-card'), /tamamlamanız gerekir/);
assert.equal(await lp.locator('.cert-card button').count(), 0, 'tamamlanmadan düğme olmamalı');
await lp.screenshot({ path: `${OUT}/03-belge-yok.png`, fullPage: true });

// Eğitimi API ile bitir (konular + final sınavı)
for (const t of [t1.id, t2.id]) {
  await post(lctx, `/api/my/topics/${t}/event`, { event: 'opened' });
  await new Promise((r) => setTimeout(r, 5200));
  await post(lctx, `/api/my/topics/${t}/complete`, {});
}
const start = await post(lctx, `/api/my/exams/${fin.id}/start`, {});
const q = start.questions[0];
await post(lctx, `/api/my/attempts/${start.attempt_id}/submit`, { answers: [{ question_id: q.id, selected: q.options.indexOf('Doğru') }] });

await lp.goto(`${BASE}/#/learner`);
await lp.click('a.course-card');
await lp.waitForSelector('.cert-ready');
await lp.screenshot({ path: `${OUT}/04-belge-hazir.png`, fullPage: true });
const [download] = await Promise.all([lp.waitForEvent('download'), lp.click('.cert-card button')]);
assert.match(download.suggestedFilename(), /^katilim-belgesi-KRM-\d{4}-000001\.pdf$/);
const file = `${OUT}/belge.pdf`;
await download.saveAs(file);
const txt = spawnSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf-8' }).stdout;
for (const k of ['TEMEL EĞİTİM BELGESİ', 'ERCAN ÇÖMEK', 'SATIŞ SORUMLUSU', 'tarihinde gerçekleştirilen temel eğitim', '8 saat', 'İrem Hande ŞENKAL', 'Erkos Çevre ve İş Güvenliği A.Ş.', 'Kaan KOSTAK', 'Burak ERTEK', 'Çalışma mevzuatı ile ilgili bilgiler', 'İlkyardım']) assert.ok(txt.includes(k), 'PDF\'te yok: ' + k);
spawnSync('pdftoppm', ['-r', '90', '-png', file, `${OUT}/belge`]);
await lp.waitForSelector('.cert-card:has-text("Belge no: KRM-")');
await lp.screenshot({ path: `${OUT}/05-belge-alindi.png`, fullPage: true });

// ---- Yönetici: belge listesi ----
await ap.goto(`${BASE}/#/admin/certificates`);
await ap.waitForSelector('td:has-text("KRM-")');
assert.match(await ap.textContent('tbody'), /Ercan Çömek/);
await ap.screenshot({ path: `${OUT}/06-belgeler.png` });
const [dl2] = await Promise.all([ap.waitForEvent('download'), ap.click('a:has-text("PDF indir")')]);
assert.match(dl2.suggestedFilename(), /\.pdf$/);
await ap.click('button:has-text("OSGB unvanı")');
await ap.fill('#f_org_title', 'KARMA OSGB Eğitim Ltd. Şti.');
await ap.click('dialog button:has-text("Kaydet")');
await ap.waitForSelector('text=Unvan kaydedildi');
// Atamalar sayfası: tür ve belge numarası
await ap.goto(`${BASE}/#/admin/assignments`);
await ap.waitForSelector('td:has-text("Belge: KRM-")');
await ap.screenshot({ path: `${OUT}/07-atamalar.png`, fullPage: true });

assert.deepEqual(errors, [], 'konsol hataları: ' + errors.join(' | '));
console.log('STAGE4 E2E OK');
await browser.close();
