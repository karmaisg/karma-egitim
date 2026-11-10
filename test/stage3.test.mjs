import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createD1 } from './d1shim.mjs';
import { createR2 } from './r2shim.mjs';

const ORIGIN = 'https://egitim.test';
const env = { DB: createD1(), VIDEOS: createR2(), SETUP_CODE: 'kurulum-kodu-123', ASSETS: { fetch: async () => new Response('asset') } };

class Client {
  constructor() { this.cookie = ''; }
  async call(method, path, body) {
    const h = { origin: ORIGIN, 'content-type': 'application/json' };
    if (this.cookie) h.cookie = this.cookie;
    const res = await worker.fetch(new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    const sc = res.headers.get('set-cookie');
    if (sc) { const v = sc.split(';')[0]; this.cookie = v.endsWith('=') ? '' : v; }
    return { status: res.status, data: await res.json() };
  }
  get(p) { return this.call('GET', p); }
  post(p, b = {}) { return this.call('POST', p, b); }
  put(p, b = {}) { return this.call('PUT', p, b); }
  del(p) { return this.call('DELETE', p, {}); }
}
const admin = new Client(); const ali = new Client(); const veli = new Client();
const ids = {};
const raw = env.DB._raw;

// Soru kimliği -> doğru seçenek metni (yönetici görünümünden)
async function correctMap(examId) {
  const { data } = await admin.get(`/api/admin/exams/${examId}/questions`);
  return new Map(data.questions.filter((q) => q.active).map((q) => [q.id, q.options[q.correct]]));
}
// mode: 'dogru' | 'yanlis' | sayı (o kadar doğru)
async function takeExam(client, examId, mode) {
  const start = await client.post(`/api/my/exams/${examId}/start`);
  if (start.status !== 200) return { start };
  const correct = await correctMap(examId);
  const qs = start.data.questions;
  let nCorrect = mode === 'dogru' ? qs.length : mode === 'yanlis' ? 0 : mode;
  const answers = qs.map((q) => {
    const rightIdx = q.options.indexOf(correct.get(q.id));
    let selected;
    if (nCorrect-- > 0) selected = rightIdx; else selected = q.options.findIndex((_, i) => i !== rightIdx);
    return { question_id: q.id, selected };
  });
  const submit = await client.post(`/api/my/attempts/${start.data.attempt_id}/submit`, { answers });
  return { start, submit };
}
const finishTopic = async (userId, topicId, client) => {
  await client.post(`/api/my/topics/${topicId}/event`, { event: 'opened' });
  raw.prepare('UPDATE topic_progress SET started_at = started_at - 6000 WHERE user_id = ? AND topic_id = ?').run(userId, topicId);
  assert.equal((await client.post(`/api/my/topics/${topicId}/complete`)).status, 200);
};
const addQ = (examId, n, offset = 0) => Promise.all(Array.from({ length: n }, (_, i) =>
  admin.post(`/api/admin/exams/${examId}/questions`, { question: `Soru ${offset + i + 1}?`, options: ['Yanlış A', 'Doğru', 'Yanlış C'], correct: 1 })));

test('hazırlık', async () => {
  assert.equal((await admin.post('/api/setup', { setup_code: 'kurulum-kodu-123', username: 'yonetici', full_name: 'Yönetici Bey', password: 'Sifre1234' })).status, 200);
  ids.ali = (await admin.post('/api/admin/users', { username: 'ali', full_name: 'Ali Yılmaz', password: 'AliSifre123' })).data.id;
  ids.veli = (await admin.post('/api/admin/users', { username: 'veli', full_name: 'Veli Kaya', password: 'VeliSifre123' })).data.id;
  await ali.post('/api/login', { username: 'ali', password: 'AliSifre123' });
  await veli.post('/api/login', { username: 'veli', password: 'VeliSifre123' });
  ids.course = (await admin.post('/api/admin/courses', { title: 'Temel İSG' })).data.id;
  ids.course2 = (await admin.post('/api/admin/courses', { title: 'Başka eğitim' })).data.id;
  ids.section = (await admin.post(`/api/admin/courses/${ids.course}/sections`, { title: 'Genel' })).data.id;
  ids.t1 = (await admin.post(`/api/admin/sections/${ids.section}/topics`, { title: 'Konu 1', content: 'a' })).data.id;
  ids.t2 = (await admin.post(`/api/admin/sections/${ids.section}/topics`, { title: 'Konu 2', content: 'b' })).data.id;
  const sec2 = (await admin.post(`/api/admin/courses/${ids.course2}/sections`, { title: 'X' })).data.id;
  ids.otherTopic = (await admin.post(`/api/admin/sections/${sec2}/topics`, { title: 'Dış konu', content: 'c' })).data.id;
  assert.equal((await admin.post('/api/admin/assignments', { course_id: ids.course, user_ids: [ids.ali] })).status, 201);
});

test('sınav oluşturma: türler, tekrar ve yetki', async () => {
  assert.equal((await admin.post(`/api/admin/courses/${ids.course}/exams`, { kind: 'saçma' })).status, 400);
  assert.equal((await admin.post(`/api/admin/courses/${ids.course}/exams`, { kind: 'konu' })).status, 400, 'konu sınavı için konu gerekir');
  assert.equal((await admin.post(`/api/admin/courses/${ids.course}/exams`, { kind: 'konu', topic_id: ids.otherTopic })).status, 404, 'başka eğitimin konusu');
  assert.equal((await ali.post(`/api/admin/courses/${ids.course}/exams`, { kind: 'final' })).status, 403);
  let r = await admin.post(`/api/admin/courses/${ids.course}/exams`, { kind: 'konu', topic_id: ids.t1 }); assert.equal(r.status, 201); ids.e1 = r.data.id;
  r = await admin.post(`/api/admin/courses/${ids.course}/exams`, { kind: 'konu', topic_id: ids.t2 }); ids.e2 = r.data.id;
  r = await admin.post(`/api/admin/courses/${ids.course}/exams`, { kind: 'final' }); assert.equal(r.status, 201); ids.final = r.data.id;
  r = await admin.post(`/api/admin/courses/${ids.course}/exams`, { kind: 'on_test' }); ids.pre = r.data.id;
  assert.equal((await admin.post(`/api/admin/courses/${ids.course}/exams`, { kind: 'final' })).status, 409, 'ikinci final olmaz');
  assert.equal((await admin.post(`/api/admin/courses/${ids.course}/exams`, { kind: 'konu', topic_id: ids.t1 })).status, 409);
  const list = (await admin.get(`/api/admin/courses/${ids.course}/exams`)).data.exams;
  assert.equal(list.length, 4);
  const pre = list.find((e) => e.kind === 'on_test');
  assert.equal(pre.max_attempts, 1);
  assert.equal(list.find((e) => e.kind === 'final').pass_score, 60);
});

test('soru doğrulama', async () => {
  const bad = (b) => admin.post(`/api/admin/exams/${ids.e1}/questions`, b);
  assert.equal((await bad({ question: 'x', options: ['tek'], correct: 0 })).status, 400);
  assert.equal((await bad({ question: 'x', options: ['a', 'A'], correct: 0 })).status, 400, 'aynı seçenekler');
  assert.equal((await bad({ question: 'x', options: ['a', 'b'], correct: 2 })).status, 400);
  assert.equal((await bad({ question: '', options: ['a', 'b'], correct: 0 })).status, 400);
  assert.equal((await bad({ question: 'x', options: ['1', '2', '3', '4', '5', '6'], correct: 0 })).status, 400);
  assert.equal((await ali.post(`/api/admin/exams/${ids.e1}/questions`, { question: 'x', options: ['a', 'b'], correct: 0 })).status, 403);
  for (const id of [ids.e1, ids.e2]) { const rs = await addQ(id, 3); assert.ok(rs.every((r) => r.status === 201)); }
  await addQ(ids.final, 4); await addQ(ids.pre, 2);
});

test('katılımcı: kilit, atama ve cevap sızıntısı', async () => {
  const view = (await ali.get(`/api/my/courses/${ids.course}/exams`)).data.exams;
  assert.equal(view.length, 4);
  assert.equal(view.find((e) => e.id === ids.e1).state, 'kilitli');
  assert.equal(view.find((e) => e.id === ids.final).state, 'kilitli');
  assert.equal(view.find((e) => e.id === ids.pre).state, 'hazir');
  assert.equal((await ali.post(`/api/my/exams/${ids.e1}/start`)).status, 403, 'konu bitmeden sınav açılmaz');
  assert.equal((await veli.post(`/api/my/exams/${ids.pre}/start`)).status, 404, 'atanmamış katılımcı');
  assert.equal((await veli.get(`/api/my/courses/${ids.course}/exams`)).status, 404);
  const s = await ali.post(`/api/my/exams/${ids.pre}/start`);
  assert.equal(s.status, 200);
  assert.equal(JSON.stringify(s.data).includes('correct'), false, 'doğru cevap istemciye gönderilmemeli');
  assert.equal(s.data.questions.length, 2);
  const again = await ali.post(`/api/my/exams/${ids.pre}/start`);
  assert.equal(again.data.attempt_id, s.data.attempt_id, 'yarım kalan deneme devam eder');
  // başkasının denemesini teslim edemez
  assert.equal((await veli.post(`/api/my/attempts/${s.data.attempt_id}/submit`, { answers: [] })).status, 404);
  // boş teslim: 0 puan; ön testte geçti/kaldı yok
  const sub = await ali.post(`/api/my/attempts/${s.data.attempt_id}/submit`, { answers: [] });
  assert.equal(sub.status, 200); assert.equal(sub.data.score, 0); assert.equal(sub.data.passed, null);
  assert.equal((await ali.post(`/api/my/attempts/${s.data.attempt_id}/submit`, { answers: [] })).status, 409, 'çifte teslim');
  assert.equal((await ali.post(`/api/my/exams/${ids.pre}/start`)).status, 403, 'ön test tek hak');
});

test('konu sınavı: geçme, puanlama ve tekrar engeli', async () => {
  await finishTopic(ids.ali, ids.t1, ali);
  assert.equal((await ali.get(`/api/my/courses/${ids.course}/exams`)).data.exams.find((e) => e.id === ids.e1).state, 'hazir');
  const r = await takeExam(ali, ids.e1, 2); // 3 sorudan 2 doğru = 67
  assert.equal(r.submit.data.score, 67);
  assert.equal(r.submit.data.passed, true);
  assert.equal(r.submit.data.state, 'gecti');
  assert.equal(JSON.stringify(r.submit.data).includes('Doğru"'), false);
  assert.equal((await ali.post(`/api/my/exams/${ids.e1}/start`)).status, 409, 'geçilen sınav tekrarlanmaz');
});

test('başarısızlık: 3 hak, hak dolunca kilit, yönetici yeni hak tanır', async () => {
  await finishTopic(ids.ali, ids.t2, ali);
  let r = await takeExam(ali, ids.e2, 1); // 33 puan
  assert.equal(r.submit.data.score, 33); assert.equal(r.submit.data.passed, false); assert.equal(r.submit.data.attempts_left, 2);
  r = await takeExam(ali, ids.e2, 'yanlis'); assert.equal(r.submit.data.score, 0); assert.equal(r.submit.data.attempts_left, 1);
  // final, konu sınavı geçilmeden açılmaz
  assert.equal((await ali.post(`/api/my/exams/${ids.final}/start`)).status, 403);
  r = await takeExam(ali, ids.e2, 'yanlis'); assert.equal(r.submit.data.state, 'hak_doldu');
  const blocked = await ali.post(`/api/my/exams/${ids.e2}/start`);
  assert.equal(blocked.status, 403); assert.match(blocked.data.error, /hakkınız doldu/);
  // yönetici hak tanır
  assert.equal((await ali.post(`/api/admin/exams/${ids.e2}/grant`, { user_id: ids.ali })).status, 403);
  assert.equal((await admin.post(`/api/admin/exams/${ids.e2}/grant`, { user_id: ids.veli, note: 'x' })).status, 404, 'atanmamış katılımcıya hak verilmez');
  assert.equal((await admin.post(`/api/admin/exams/${ids.e2}/grant`, { user_id: ids.ali, note: 'Eğitime yeniden katıldı' })).status, 200);
  r = await takeExam(ali, ids.e2, 'dogru');
  assert.equal(r.submit.data.score, 100); assert.equal(r.submit.data.passed, true);
});

test('eğitim sonu sınavı: tüm konular ve konu sınavları tamamlanınca açılır', async () => {
  const f = (await ali.get(`/api/my/courses/${ids.course}/exams`)).data.exams.find((e) => e.id === ids.final);
  assert.equal(f.state, 'hazir');
  const r = await takeExam(ali, ids.final, 'dogru');
  assert.equal(r.submit.data.score, 100);
  assert.equal(r.start.data.questions.length, 4);
});

test('kayıt koruma: sınav girilen soru/sınav/konu silinemez veya değişemez', async () => {
  const qs = (await admin.get(`/api/admin/exams/${ids.e1}/questions`)).data;
  assert.equal(qs.locked, true);
  const q = qs.questions[0];
  assert.equal((await admin.put(`/api/admin/exam-questions/${q.id}`, { question: 'Değişti', options: ['a', 'b'], correct: 0 })).status, 409);
  assert.equal((await admin.del(`/api/admin/exam-questions/${q.id}`)).status, 409);
  assert.equal((await admin.del(`/api/admin/exams/${ids.e1}`)).status, 409);
  assert.equal((await admin.del(`/api/admin/topics/${ids.t1}`)).status, 409);
  assert.equal((await admin.del(`/api/admin/courses/${ids.course}`)).status, 409);
  // pasife alma serbest; yeni soru eklenebilir ve sonraki denemeye girer
  assert.equal((await admin.post(`/api/admin/exam-questions/${q.id}/active`, { active: false })).status, 200);
  assert.equal((await admin.get(`/api/admin/exams/${ids.e1}/questions`)).data.questions.find((x) => x.id === q.id).active, false);
  // sınavı hiç girilmemiş olan değiştirilebilir (yeni sınav)
  const fresh = await admin.post(`/api/admin/courses/${ids.course2}/exams`, { kind: 'final' });
  const nq = await admin.post(`/api/admin/exams/${fresh.data.id}/questions`, { question: 'Q', options: ['a', 'b'], correct: 0 });
  assert.equal((await admin.put(`/api/admin/exam-questions/${nq.data.id}`, { question: 'Q2', options: ['a', 'b', 'c'], correct: 2 })).status, 200);
  assert.equal((await admin.del(`/api/admin/exam-questions/${nq.data.id}`)).status, 200);
  assert.equal((await admin.del(`/api/admin/exams/${fresh.data.id}`)).status, 200);
});

test('kayıtlar: sınav raporu, cevap detayı ve etkinlik günlüğü', async () => {
  const rep = (await admin.get(`/api/admin/reports/exams?course_id=${ids.course}`)).data.rows;
  assert.equal(rep.length, 7);
  const e2rows = rep.filter((r) => r.exam_id === ids.e2).sort((a, b) => a.attempt_no - b.attempt_no);
  assert.deepEqual(e2rows.map((r) => r.attempt_no), [1, 2, 3, 4]);
  assert.deepEqual(e2rows.map((r) => r.score), [33, 0, 0, 100]);
  assert.equal(e2rows[0].full_name, 'Ali Yılmaz');
  const d = (await admin.get(`/api/admin/attempts/${e2rows[0].id}`)).data;
  assert.equal(d.answers.length, 3);
  assert.equal(d.answers.filter((a) => a.is_correct).length, 1);
  assert.ok(d.answers.every((a) => Array.isArray(a.options) && a.options.length === 3 && typeof a.correct_index === 'number'));
  assert.equal((await ali.get(`/api/admin/attempts/${e2rows[0].id}`)).status, 403);
  assert.equal((await ali.get('/api/admin/reports/exams')).status, 403);
  const ev = (await admin.get(`/api/admin/reports/activity?user_id=${ids.ali}&course_id=${ids.course}`)).data.events.map((e) => e.event);
  for (const k of ['sinav_basladi', 'sinav_bitti', 'sinav_hakki_verildi']) assert.ok(ev.includes(k), k);
});

test('soru ve seçenek sırası karıştırılır', async () => {
  const fresh = (await admin.post(`/api/admin/courses/${ids.course2}/exams`, { kind: 'on_test' })).data.id;
  for (let i = 0; i < 12; i++) await admin.post(`/api/admin/exams/${fresh}/questions`, { question: `S${i}`, options: ['1', '2', '3', '4'], correct: 0 });
  await admin.post('/api/admin/assignments', { course_id: ids.course2, user_ids: [ids.veli] });
  const s = await veli.post(`/api/my/exams/${fresh}/start`);
  const order = s.data.questions.map((q) => q.question).join();
  assert.notEqual(order, Array.from({ length: 12 }, (_, i) => `S${i}`).join(), 'soru sırası karışmalı (olasılık dışı rastlantı ~1/479001600)');
  assert.ok(s.data.questions.some((q) => q.options.join('') !== '1234'));
});
