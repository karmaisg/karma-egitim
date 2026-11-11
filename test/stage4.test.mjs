import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import worker from '../src/index.js';
import { createD1 } from './d1shim.mjs';
import { createR2 } from './r2shim.mjs';

const ORIGIN = 'https://egitim.test';
const PUBLIC = path.resolve('public');
const assetsShim = {
  fetch: async (req) => {
    const p = path.join(PUBLIC, new URL(req.url).pathname);
    if (!p.startsWith(PUBLIC) || !fs.existsSync(p)) return new Response('yok', { status: 404 });
    return new Response(fs.readFileSync(p));
  },
};
const env = { DB: createD1(), VIDEOS: createR2(), SETUP_CODE: 'kurulum-kodu-123', ASSETS: assetsShim };
const raw = env.DB._raw;

class Client {
  constructor() { this.cookie = ''; }
  async res(method, p, body) {
    const h = { origin: ORIGIN, 'content-type': 'application/json' };
    if (this.cookie) h.cookie = this.cookie;
    const res = await worker.fetch(new Request(ORIGIN + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    const sc = res.headers.get('set-cookie');
    if (sc) { const v = sc.split(';')[0]; this.cookie = v.endsWith('=') ? '' : v; }
    return res;
  }
  async call(method, p, body) {
    let r = await this.res(method, p, body); let data = await r.json();
    // Katılımcılar eğitim verilerine ulaşmadan önce aydınlatma metnini onaylamalıdır (testlerde otomatik onaylanır).
    if (r.status === 403 && data.code === 'consent_required' && !this.noConsent) {
      await this.res('POST', '/api/my/consent', { accept: true });
      r = await this.res(method, p, body); data = await r.json();
    }
    return { status: r.status, data };
  }
  get(p) { return this.call('GET', p); }
  post(p, b = {}) { return this.call('POST', p, b); }
  put(p, b = {}) { return this.call('PUT', p, b); }
}
const admin = new Client(); const ali = new Client(); const veli = new Client(); const ayse = new Client();
const ids = {};

const pdfText = (bytes) => {
  const f = path.join(os.tmpdir(), `karma-test-${process.pid}-${Math.random().toString(36).slice(2)}.pdf`);
  fs.writeFileSync(f, bytes);
  const r = spawnSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf-8' });
  fs.unlinkSync(f);
  return r.status === 0 ? r.stdout : null;
};
const finishTopic = async (client, userId, topicId) => {
  await client.post(`/api/my/topics/${topicId}/event`, { event: 'opened' });
  raw.prepare('UPDATE topic_progress SET started_at = started_at - 6000 WHERE user_id = ? AND topic_id = ?').run(userId, topicId);
  assert.equal((await client.post(`/api/my/topics/${topicId}/complete`)).status, 200);
};
async function passFinal(client) {
  const start = await client.post(`/api/my/exams/${ids.final}/start`);
  assert.equal(start.status, 200, JSON.stringify(start.data));
  const qs = (await admin.get(`/api/admin/exams/${ids.final}/questions`)).data.questions;
  const answers = start.data.questions.map((q) => ({ question_id: q.id, selected: q.options.indexOf(qs.find((x) => x.id === q.id).options[qs.find((x) => x.id === q.id).correct]) }));
  const r = await client.post(`/api/my/attempts/${start.data.attempt_id}/submit`, { answers });
  assert.equal(r.data.passed, true);
}

test('hazırlık', async () => {
  assert.equal((await admin.post('/api/setup', { setup_code: 'kurulum-kodu-123', username: 'yonetici', full_name: 'Yönetici Bey', password: 'Sifre1234' })).status, 200);
  const co = await admin.post('/api/admin/companies', { name: 'Erkos Çevre ve İş Güvenliği A.Ş.', hazard_class: 'tehlikeli', employer_1: 'Kaan KOSTAK', employer_2: 'Burak ERTEK' });
  assert.equal(co.status, 201); ids.company = co.data.id;
  const list = (await admin.get('/api/admin/companies')).data.companies;
  assert.equal(list[0].employer_1, 'Kaan KOSTAK'); assert.equal(list[0].employer_2, 'Burak ERTEK');
  ids.ali = (await admin.post('/api/admin/users', { username: 'ali', full_name: 'Ali Yılmaz', password: 'AliSifre123', job_title: 'Satış Sorumlusu', company_id: ids.company })).data.id;
  ids.ayse = (await admin.post('/api/admin/users', { username: 'ayse', full_name: 'Ayşe Öztürk', password: 'AyseSifre123', job_title: 'Kalıpçı', company_id: ids.company })).data.id;
  ids.veli = (await admin.post('/api/admin/users', { username: 'veli', full_name: 'Veli Kaya', password: 'VeliSifre123' })).data.id;
  for (const [c, u, p] of [[ali, 'ali', 'AliSifre123'], [ayse, 'ayse', 'AyseSifre123'], [veli, 'veli', 'VeliSifre123']]) await c.post('/api/login', { username: u, password: p });
  ids.course = (await admin.post('/api/admin/courses', { title: 'Temel İSG' })).data.id;
  const s1 = (await admin.post(`/api/admin/courses/${ids.course}/sections`, { title: 'Genel konular' })).data.id;
  const s2 = (await admin.post(`/api/admin/courses/${ids.course}/sections`, { title: 'Sağlık konuları' })).data.id;
  ids.t1 = (await admin.post(`/api/admin/sections/${s1}/topics`, { title: 'Çalışma mevzuatı', content: 'a' })).data.id;
  ids.t2 = (await admin.post(`/api/admin/sections/${s2}/topics`, { title: 'İlkyardım', content: 'b' })).data.id;
  ids.final = (await admin.post(`/api/admin/courses/${ids.course}/exams`, { kind: 'final' })).data.id;
  for (let i = 1; i <= 2; i++) await admin.post(`/api/admin/exams/${ids.final}/questions`, { question: `Soru ${i}?`, options: ['Yanlış', 'Doğru'], correct: 1 });
  await admin.post('/api/admin/assignments', { course_id: ids.course, user_ids: [ids.ali] });
  await admin.post('/api/admin/assignments', { course_id: ids.course, user_ids: [ids.ayse], training_type: 'tekrar' });
});

test('belge ayarları: doğrulama ve yetki', async () => {
  const base = `/api/admin/courses/${ids.course}/certificate-settings`;
  assert.equal((await admin.put(base, { hours: 0, in_person: false, remote: true, trainers: [] })).status, 400);
  assert.equal((await admin.put(base, { hours: 8, in_person: false, remote: false, trainers: [] })).status, 400, 'şekil seçilmeli');
  assert.equal((await ali.put(base, { hours: 8, in_person: false, remote: true, trainers: [] })).status, 403);
  const ok = await admin.put(base, { hours: '16', in_person: false, remote: true, trainers: [{ name: 'İrem Hande ŞENKAL', title: 'B Sınıfı İş Güvenliği Uzmanı' }, { name: 'Dr.Sedat AKAR', title: 'İşyeri Hekimi' }, { name: 'Üçüncü', title: 'x' }] });
  assert.equal(ok.status, 200);
  const got = (await admin.get(base)).data;
  assert.equal(got.hours, 16); assert.equal(got.remote, true); assert.equal(got.in_person, false); assert.equal(got.trainers.length, 2, 'en çok 2 eğitici');
  assert.equal((await admin.put('/api/admin/settings', { org_title: '' })).status, 400);
  assert.equal((await admin.put('/api/admin/settings', { org_title: 'Deneme OSGB Ltd. Şti.' })).status, 200);
  assert.equal((await admin.get('/api/admin/settings')).data.org_title, 'Deneme OSGB Ltd. Şti.');
  assert.equal((await ali.get('/api/admin/settings')).status, 403);
});

test('uygunluk: tamamlanmadan belge verilmez', async () => {
  const st = (await ali.get(`/api/my/courses/${ids.course}/certificate`)).data;
  assert.equal(st.eligible, false); assert.ok(st.reasons.length >= 2); assert.equal(st.issued, null);
  const r = await ali.post(`/api/my/courses/${ids.course}/certificate`);
  assert.equal(r.status, 403); assert.match(r.data.error, /tamamlamanız gerekir/);
  assert.equal((await ali.get(`/api/my/courses/${ids.course}/certificate.pdf`)).status, 404);
  assert.equal((await veli.get(`/api/my/courses/${ids.course}/certificate`)).status, 404, 'atanmamış');
  await finishTopic(ali, ids.ali, ids.t1);
  assert.equal((await ali.post(`/api/my/courses/${ids.course}/certificate`)).status, 403, 'bir konu ve sınav eksik');
  await finishTopic(ali, ids.ali, ids.t2);
  const st2 = (await ali.get(`/api/my/courses/${ids.course}/certificate`)).data;
  assert.equal(st2.eligible, false); assert.match(st2.reasons.join(' '), /Eğitim sonu sınavı/);
});

test('belge düzenleme, numara ve PDF içeriği (tek gün)', async () => {
  await passFinal(ali);
  const r = await ali.post(`/api/my/courses/${ids.course}/certificate`);
  assert.equal(r.status, 201);
  assert.match(r.data.number, /^KRM-\d{4}-000001$/);
  const again = await ali.post(`/api/my/courses/${ids.course}/certificate`);
  assert.equal(again.status, 200); assert.equal(again.data.number, r.data.number, 'aynı belge tekrar verilir');
  assert.equal((await ali.get(`/api/my/courses/${ids.course}/certificate`)).data.issued.number, r.data.number);

  const res = await ali.res('GET', `/api/my/courses/${ids.course}/certificate.pdf`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.match(res.headers.get('content-disposition'), /attachment; filename="katilim-belgesi-KRM-\d{4}-000001\.pdf"/);
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.equal(String.fromCharCode(...bytes.slice(0, 5)), '%PDF-');
  ids.aliPdf = bytes;
  const text = pdfText(bytes);
  if (text === null) return console.log('pdftotext yok; PDF metin kontrolü atlandı');
  const d = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
  const tr = `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
  for (const k of ['TEMEL EĞİTİM BELGESİ', 'ALİ YILMAZ', 'SATIŞ SORUMLUSU', 'Deneme OSGB Ltd. Şti.', `${tr} tarihinde gerçekleştirilen`, '16 saat',
    'İlk defa verilen temel eğitim', 'Uzaktan', 'İrem Hande ŞENKAL', 'B Sınıfı İş Güvenliği Uzmanı', 'Dr.Sedat AKAR', 'İşyeri Hekimi',
    'Erkos Çevre ve İş Güvenliği A.Ş.', 'Kaan KOSTAK', 'Burak ERTEK', 'EĞİTİM KONULARI', '1. GENEL KONULAR', 'a) Çalışma mevzuatı', '2. SAĞLIK KONULARI', 'a) İlkyardım', 'Belge No: KRM-']) {
    assert.ok(text.includes(k), `PDF'te bulunamadı: ${k}\n${text.slice(0, 1500)}`);
  }
});

test('belge dondurulur: sonradan değişen bilgiler eski belgeyi etkilemez', async () => {
  raw.prepare("UPDATE users SET full_name = 'Başka Ad' WHERE id = ?").run(ids.ali);
  await admin.put('/api/admin/settings', { org_title: 'Yeni Unvan A.Ş.' });
  await admin.put(`/api/admin/courses/${ids.course}/certificate-settings`, { hours: 4, in_person: true, remote: true, trainers: [] });
  const res = await ali.res('GET', `/api/my/courses/${ids.course}/certificate.pdf`);
  const text = pdfText(new Uint8Array(await res.arrayBuffer()));
  if (text === null) return;
  assert.ok(text.includes('ALİ YILMAZ') && !text.includes('BAŞKA AD'));
  assert.ok(text.includes('Deneme OSGB Ltd. Şti.') && !text.includes('Yeni Unvan'));
  assert.ok(text.includes('16 saat'));
  raw.prepare("UPDATE users SET full_name = 'Ali Yılmaz' WHERE id = ?").run(ids.ali);
});

test('iki günlük eğitim: iki tarih, "tekrar" türü, boş eğitici', async () => {
  await admin.put('/api/admin/settings', { org_title: 'Deneme OSGB Ltd. Şti.' });
  await admin.put(`/api/admin/courses/${ids.course}/certificate-settings`, { hours: 8, in_person: true, remote: false, trainers: [] });
  await finishTopic(ayse, ids.ayse, ids.t1);
  // ilk günün olayını dünle
  raw.prepare("UPDATE activity_log SET created_at = created_at - 86400000 WHERE user_id = ? AND event = 'konu_tamamlandi'").run(ids.ayse);
  raw.prepare('UPDATE topic_progress SET completed_at = completed_at - 86400000 WHERE user_id = ?').run(ids.ayse);
  await finishTopic(ayse, ids.ayse, ids.t2);
  await passFinal(ayse);
  const r = await ayse.post(`/api/my/courses/${ids.course}/certificate`);
  assert.equal(r.status, 201); assert.match(r.data.number, /-000002$/);
  const snap = JSON.parse(raw.prepare('SELECT snapshot FROM certificates WHERE user_id = ?').get(ids.ayse).snapshot);
  assert.equal(snap.dates.length, 2); assert.ok(snap.dates[0] < snap.dates[1]);
  assert.equal(snap.training_type, 'tekrar'); assert.equal(snap.in_person, true); assert.equal(snap.remote, false);
  const text = pdfText(new Uint8Array(await (await ayse.res('GET', `/api/my/courses/${ids.course}/certificate.pdf`)).arrayBuffer()));
  if (text === null) return;
  const f = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
  assert.ok(text.includes(`${f(snap.dates[0])} ve ${f(snap.dates[1])} tarihlerinde`), text.slice(0, 900));
  assert.ok(text.includes('8 saat') && text.includes('AYŞE ÖZTÜRK') && text.includes('KALIPÇI'));
});

test('yönetici: belge listesi, indirme, tür değişimi kilidi, yetkiler', async () => {
  const list = (await admin.get('/api/admin/certificates')).data.certificates;
  assert.equal(list.length, 2);
  assert.ok(list.every((c) => /^KRM-\d{4}-\d{6}$/.test(c.number)));
  const pdf = await admin.res('GET', `/api/admin/certificates/${list[0].id}/pdf`);
  assert.equal(pdf.status, 200); assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal((await ali.get('/api/admin/certificates')).status, 403);
  assert.equal((await ali.res('GET', `/api/admin/certificates/${list[0].id}/pdf`)).status, 403);
  const asg = (await admin.get('/api/admin/assignments')).data.assignments;
  const aliAsg = asg.find((a) => a.user_id === ids.ali);
  assert.ok(aliAsg.certificate_number);
  assert.equal((await admin.put(`/api/admin/assignments/${aliAsg.id}`, { training_type: 'tekrar' })).status, 409, 'belge sonrası değişmez');
  await admin.post('/api/admin/assignments', { course_id: ids.course, user_ids: [ids.veli] });
  const veliAsg = (await admin.get('/api/admin/assignments')).data.assignments.find((a) => a.user_id === ids.veli);
  assert.equal((await admin.put(`/api/admin/assignments/${veliAsg.id}`, { training_type: 'garip' })).status, 400);
  assert.equal((await admin.put(`/api/admin/assignments/${veliAsg.id}`, { training_type: 'tekrar' })).status, 200);
});

test('PDF üretimi hızlı ve çok konulu eğitimde sayfa taşar', async () => {
  const sec = (await admin.post(`/api/admin/courses/${ids.course}/sections`, { title: 'Uzun bölüm' })).data.id;
  for (let i = 0; i < 70; i++) await admin.post(`/api/admin/sections/${sec}/topics`, { title: `Çok uzun bir konu başlığı numarası ${i + 1} — güvenli çalışma yöntemleri ve alınması gereken önlemler`, content: 'x' });
  // yeni konular eklendiği için ali'nin eski belgesi etkilenmemeli; yeni kullanıcı için anlık görüntüyü doğrudan kur
  const { buildCertificatePdf, loadAssets } = await import('../src/certificate_pdf.js');
  const assets = await loadAssets(async (n) => new Uint8Array(fs.readFileSync(path.join(PUBLIC, 'pdf', n))));
  const snap = JSON.parse(raw.prepare('SELECT snapshot FROM certificates WHERE user_id = ?').get(ids.ali).snapshot);
  snap.number = 'KRM-2026-000001';
  snap.sections = [{ title: 'Uzun bölüm', topics: Array.from({ length: 70 }, (_, i) => ({ title: `Çok uzun bir konu başlığı numarası ${i + 1} — güvenli çalışma yöntemleri ve alınması gereken önlemler`, minutes: 10 })) }];
  const bytes = buildCertificatePdf(snap, assets);
  const text = pdfText(bytes);
  if (text !== null) { assert.ok(text.includes('Sayfa 3 / 3') || text.includes('Sayfa 2 / ')); assert.ok(text.includes('numarası 70')); }
  assert.ok(bytes.length < 600000, 'PDF boyutu makul olmalı: ' + bytes.length);
});
