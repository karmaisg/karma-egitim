import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createD1 } from './d1shim.mjs';
import { createR2 } from './r2shim.mjs';

const ORIGIN = 'https://egitim.test';
const env = { DB: createD1(), VIDEOS: createR2(), SETUP_CODE: 'kurulum-kodu-123', ASSETS: { fetch: async () => new Response('asset') } };

class Client {
  constructor() { this.cookie = ''; }
  async call(method, path, body, headers = {}, raw = false) {
    const h = { origin: ORIGIN, ...headers };
    if (!raw) h['content-type'] = 'application/json';
    if (this.cookie) h.cookie = this.cookie;
    const res = await worker.fetch(new Request(ORIGIN + path, {
      method, headers: h, body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)),
    }), env);
    const sc = res.headers.get('set-cookie');
    if (sc) { const v = sc.split(';')[0]; this.cookie = v.endsWith('=') ? '' : v; }
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  }
  get(p, h) { return this.call('GET', p, undefined, h); }
  post(p, b = {}) { return this.call('POST', p, b); }
  put(p, b = {}) { return this.call('PUT', p, b); }
  del(p) { return this.call('DELETE', p, {}); }
}

const admin = new Client(); const ali = new Client(); const veli = new Client();
const ids = {};
const raw = env.DB._raw;

// Gerçek zamanın geçmesini beklemeden simüle et: son bildirim zamanını geriye çek.
const advance = (userId, topicId, ms = 6000) =>
  raw.prepare('UPDATE topic_progress SET last_heartbeat_at = last_heartbeat_at - ? WHERE user_id = ? AND topic_id = ?').run(ms, userId, topicId);
const hb = (c, position, playing = true) => c.post(`/api/my/topics/${ids.topic}/heartbeat`, { position, playing });

test('hazırlık: yönetici, katılımcılar, eğitim ve konular', async () => {
  assert.equal((await admin.post('/api/setup', { setup_code: 'kurulum-kodu-123', username: 'yonetici', full_name: 'Yönetici Bey', password: 'Sifre1234' })).status, 200);
  let r = await admin.post('/api/admin/users', { username: 'ali', full_name: 'Ali Yılmaz', password: 'AliSifre123' }); ids.ali = r.data.id;
  r = await admin.post('/api/admin/users', { username: 'veli', full_name: 'Veli Kaya', password: 'VeliSifre123' }); ids.veli = r.data.id;
  assert.equal((await ali.post('/api/login', { username: 'ali', password: 'AliSifre123' })).status, 200);
  assert.equal((await veli.post('/api/login', { username: 'veli', password: 'VeliSifre123' })).status, 200);
  ids.course = (await admin.post('/api/admin/courses', { title: 'Temel İSG' })).data.id;
  ids.section = (await admin.post(`/api/admin/courses/${ids.course}/sections`, { title: 'Genel' })).data.id;
  ids.topic = (await admin.post(`/api/admin/sections/${ids.section}/topics`, { title: 'Video konu', content: 'Anlatım' })).data.id;
  ids.textTopic = (await admin.post(`/api/admin/sections/${ids.section}/topics`, { title: 'Metin konu', content: 'Yalnızca metin' })).data.id;
  assert.equal((await admin.post('/api/admin/assignments', { course_id: ids.course, user_ids: [ids.ali] })).status, 201); // veli atanmadı
});

test('video yükleme: çok parçalı, doğrulamalar ve CSRF', async () => {
  const bad = await admin.post(`/api/admin/topics/${ids.topic}/video/start`, { type: 'video/avi', size: 100 });
  assert.equal(bad.status, 400);
  assert.equal((await admin.post(`/api/admin/topics/${ids.topic}/video/start`, { type: 'video/mp4', size: 4 * 1024 ** 3 })).status, 400);
  const start = await admin.post(`/api/admin/topics/${ids.topic}/video/start`, { type: 'video/mp4', size: 12 });
  assert.equal(start.status, 200);
  const { key, upload_id } = start.data;
  assert.ok(key.startsWith(`topics/${ids.topic}/`));

  const part = (n, bytes, headers = { 'x-karma-upload': '1' }, k = key) =>
    admin.call('PUT', `/api/admin/topics/${ids.topic}/video/part?key=${encodeURIComponent(k)}&upload_id=${upload_id}&n=${n}`, bytes, { 'content-type': 'application/octet-stream', ...headers }, true);

  assert.equal((await part(1, new Uint8Array([0, 1, 2, 3, 4, 5]), {})).status, 403, 'özel başlık olmadan reddedilmeli');
  assert.equal((await part(1, new Uint8Array([0, 1, 2, 3, 4, 5]), { 'x-karma-upload': '1', origin: 'https://evil.example' })).status, 403);
  assert.equal((await part(1, new Uint8Array([0]), undefined, 'topics/999/baska')).status, 400, 'başka konunun anahtarı reddedilmeli');
  assert.equal((await part(0, new Uint8Array([0]))).status, 400);
  const p1 = await part(1, new Uint8Array([0, 1, 2, 3, 4, 5]));
  const p2 = await part(2, new Uint8Array([6, 7, 8, 9, 10, 11]));
  assert.equal(p1.status, 200);
  assert.ok(p1.data.etag);

  // katılımcı video yükleyemez
  assert.equal((await ali.post(`/api/admin/topics/${ids.topic}/video/start`, { type: 'video/mp4', size: 12 })).status, 403);

  assert.equal((await admin.post(`/api/admin/topics/${ids.topic}/video/complete`, { key, upload_id, type: 'video/mp4', duration: 0, parts: [p1.data, p2.data] })).status, 400);
  const done = await admin.post(`/api/admin/topics/${ids.topic}/video/complete`, { key, upload_id, type: 'video/mp4', name: 'egitim.mp4', duration: 20, parts: [p1.data, p2.data] });
  assert.equal(done.status, 200);
  assert.equal(done.data.size, 12);
  ids.videoKey = key;

  const tree = (await admin.get(`/api/admin/courses/${ids.course}`)).data;
  const t = tree.sections[0].topics[0];
  assert.equal(t.has_video, 1);
  assert.equal(t.video_duration, 20);
  assert.equal(t.video_name, 'egitim.mp4');
  assert.ok(!('video_key' in t), 'depolama anahtarı istemciye sızmamalı');
});

test('video akıtma: yetki ve Range', async () => {
  const url = `/api/my/topics/${ids.topic}/video`;
  assert.equal((await new Client().get(url)).status, 401, 'girişsiz erişim yok');
  assert.equal((await veli.get(url)).status, 404, 'atanmamış katılımcı erişemez');
  let r = await ali.get(url, { range: 'bytes=2-5' });
  assert.equal(r.status, 206);
  assert.deepEqual([...r.data], [2, 3, 4, 5]);
  assert.equal(r.headers.get('content-range'), 'bytes 2-5/12');
  assert.equal(r.headers.get('content-type'), 'video/mp4');
  assert.match(r.headers.get('cache-control'), /no-store/);
  r = await ali.get(url, { range: 'bytes=10-' });
  assert.deepEqual([...r.data], [10, 11]);
  r = await ali.get(url, { range: 'bytes=-3' });
  assert.deepEqual([...r.data], [9, 10, 11]);
  assert.equal((await ali.get(url, { range: 'bytes=50-' })).status, 416);
  r = await ali.get(url);
  assert.equal(r.status, 200);
  assert.equal(r.data.length, 12);
  assert.equal((await admin.get(url, { range: 'bytes=0-1' })).status, 206, 'yönetici önizleyebilir');
});

test('kontrol soruları: doğrulama ve yönetim', async () => {
  const base = `/api/admin/topics/${ids.topic}/checkpoints`;
  assert.equal((await admin.post(base, { at_second: 5, question: 'Soru?', options: ['Tek'], correct: 0 })).status, 400);
  assert.equal((await admin.post(base, { at_second: 25, question: 'Soru?', options: ['A', 'B'], correct: 0 })).status, 400, 'video süresinden sonra olamaz');
  assert.equal((await admin.post(base, { at_second: 5, question: 'Soru?', options: ['A', 'B'], correct: 5 })).status, 400);
  assert.equal((await admin.post(`/api/admin/topics/${ids.textTopic}/checkpoints`, { at_second: 5, question: 'Q', options: ['A', 'B'], correct: 0 })).status, 400, 'videosuz konuya eklenemez');
  let r = await admin.post(base, { at_second: 5, question: 'Başlık 1: Kask ne zaman takılır?', options: ['Hiçbir zaman', 'Şantiyede daima', 'Yalnızca yağmurda'], correct: 1 });
  assert.equal(r.status, 201); ids.cp1 = r.data.id;
  r = await admin.post(base, { at_second: 15, question: 'Başlık 2: Acil çıkış?', options: ['Kapalı tutulur', 'Açık tutulur'], correct: 1 });
  ids.cp2 = r.data.id;
  r = await admin.get(base);
  assert.deepEqual(r.data.checkpoints.map((c) => c.at_second), [5, 15]);
  assert.equal(r.data.checkpoints[0].correct, 1);
  assert.equal((await ali.get(base)).status, 403);
  // katılımcıya giden konu bilgisinde doğru cevap bulunmamalı
  r = await ali.get(`/api/my/topics/${ids.topic}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.topic.checkpoints.length, 2);
  assert.ok(!('correct' in r.data.topic.checkpoints[0]));
  assert.equal(r.data.topic.has_video, true);
  assert.equal(r.data.topic.video_duration, 20);
  assert.ok(!('video_key' in r.data.topic));
  assert.equal((await veli.get(`/api/my/topics/${ids.topic}`)).status, 404);
});

test('ileri sarma engeli, kontrol sorusu zorunluluğu ve tamamlanma', async () => {
  // ilk bildirim: kayıt açılır
  let r = await hb(ali, 0);
  assert.equal(r.status, 200);
  assert.equal(r.data.max_position, 0);
  // hemen ardından ileri sarma denemesi: sık bildirim yok sayılır
  r = await hb(ali, 18);
  assert.equal(r.data.throttled, true);
  assert.equal(r.data.max_position, 0);

  // gerçek zamanda 6 sn geçti: 5. saniyedeki soruya kadar gidebilir
  advance(ids.ali, ids.topic);
  r = await hb(ali, 5);
  assert.equal(r.data.max_position, 5);
  assert.equal(r.data.clamped, false);

  // 6 sn daha geçti ama 18. saniyeye atlamak istiyor ve soru cevaplanmadı: engellenir
  advance(ids.ali, ids.topic);
  r = await hb(ali, 18);
  assert.equal(r.data.clamped, true);
  assert.equal(r.data.max_position, 5);
  assert.equal(r.data.limit, 5);

  // henüz gelinmemiş soruya cevap verilemez
  assert.equal((await ali.post(`/api/my/checkpoints/${ids.cp2}/answer`, { selected: 1 })).status, 400);
  // yanlış, sonra doğru cevap
  assert.equal((await ali.post(`/api/my/checkpoints/${ids.cp1}/answer`, { selected: 0 })).data.correct, false);
  advance(ids.ali, ids.topic);
  r = await hb(ali, 9);
  assert.equal(r.data.max_position, 5, 'yanlış cevap ilerletmez');
  assert.equal((await ali.post(`/api/my/checkpoints/${ids.cp1}/answer`, { selected: 1 })).data.correct, true);
  assert.equal((await ali.post(`/api/my/checkpoints/${ids.cp1}/answer`, { selected: 1 })).data.correct, true, 'tekrar cevap zararsız');
  assert.equal((await ali.post(`/api/my/checkpoints/${ids.cp1}/answer`, { selected: 9 })).status, 400);

  // doğru cevaptan sonra ilerleyebilir; ama gerçek süreden fazla atlayamaz
  advance(ids.ali, ids.topic);
  r = await hb(ali, 19);
  assert.equal(r.data.clamped, true);
  assert.ok(r.data.max_position > 5 && r.data.max_position <= 15, `max=${r.data.max_position}`);
  advance(ids.ali, ids.topic, 10000);
  r = await hb(ali, 15);
  assert.equal(r.data.max_position, 15);
  assert.equal(r.data.completed, false, 'ikinci soru cevaplanmadan tamamlanmaz');

  assert.equal((await ali.post(`/api/my/checkpoints/${ids.cp2}/answer`, { selected: 1 })).data.correct, true);
  advance(ids.ali, ids.topic, 10000);
  r = await hb(ali, 20);
  assert.equal(r.data.completed, true);

  const topic = (await ali.get(`/api/my/topics/${ids.topic}`)).data.topic;
  assert.equal(topic.progress.completed, true);
  assert.equal(topic.checkpoints.every((c) => c.answered), true);
  const tree = (await ali.get(`/api/my/courses/${ids.course}`)).data;
  assert.equal(tree.sections[0].topics[0].progress.completed, true);
  assert.equal(tree.sections[0].topics[1].progress.completed, false);
});

test('tamamlanan konuda izleme süresi gerçek süreyi aşmaz', async () => {
  const row = raw.prepare('SELECT watched_seconds FROM topic_progress WHERE user_id = ? AND topic_id = ?').get(ids.ali, ids.topic);
  // Testte 5 bildirim x en fazla 20 sn sayılır; gerçek sistemde gerçek zaman sınırlar. Üst sınır kontrolü:
  assert.ok(row.watched_seconds > 0 && row.watched_seconds <= 100, `watched=${row.watched_seconds}`);
});

test('metin konusu: erken tamamlanamaz, video konusu metin yoluyla tamamlanamaz', async () => {
  assert.equal((await ali.post(`/api/my/topics/${ids.topic}/complete`)).status, 400);
  assert.equal((await ali.post(`/api/my/topics/${ids.textTopic}/event`, { event: 'opened' })).status, 200);
  assert.equal((await ali.post(`/api/my/topics/${ids.textTopic}/complete`)).status, 400);
  raw.prepare('UPDATE topic_progress SET started_at = started_at - 6000 WHERE user_id = ? AND topic_id = ?').run(ids.ali, ids.textTopic);
  assert.equal((await ali.post(`/api/my/topics/${ids.textTopic}/complete`)).data.completed, true);
  assert.equal((await ali.post(`/api/my/topics/${ids.textTopic}/event`, { event: 'bilinmeyen' })).status, 400);
  assert.equal((await veli.post(`/api/my/topics/${ids.textTopic}/complete`)).status, 404);
});

test('sekme olayları günlüğe yazılır', async () => {
  for (const e of ['opened', 'tab_hidden', 'tab_visible', 'left']) {
    assert.equal((await ali.post(`/api/my/topics/${ids.topic}/event`, { event: e })).status, 200);
  }
});

test('raporlar: ilerleme ve etkinlik günlüğü', async () => {
  let r = await admin.get('/api/admin/reports/progress');
  assert.equal(r.status, 200);
  assert.equal(r.data.rows.length, 1);
  const row = r.data.rows[0];
  assert.equal(row.full_name, 'Ali Yılmaz');
  assert.equal(row.topics_total, 2);
  assert.equal(row.topics_completed, 2);
  assert.equal(row.percent, 100);
  assert.ok(row.last_login > 0);
  assert.equal((await ali.get('/api/admin/reports/progress')).status, 403);

  r = await admin.get(`/api/admin/reports/activity?user_id=${ids.ali}&course_id=${ids.course}`);
  const names = r.data.events.map((e) => e.event);
  for (const expected of ['giris', 'ileri_sarma_engellendi', 'kontrol_sorusu_yanlis', 'kontrol_sorusu_dogru', 'konu_tamamlandi', 'sekme_degisti', 'sekmeye_dondu', 'konu_acildi', 'konudan_ayrildi']) {
    assert.ok(names.includes(expected), `${expected} günlükte yok: ${names.join(',')}`);
  }
  assert.equal(r.data.answers.length, 3);
  assert.equal(r.data.answers.filter((a) => !a.is_correct).length, 1);
  assert.equal((await admin.get('/api/admin/reports/activity')).status, 400);
  assert.equal((await ali.get(`/api/admin/reports/activity?user_id=${ids.ali}`)).status, 403);
});

test('giriş ve çıkış kaydı', async () => {
  const c = new Client();
  await c.post('/api/login', { username: 'veli', password: 'VeliSifre123' });
  await c.post('/api/logout');
  const r = await admin.get(`/api/admin/reports/activity?user_id=${ids.veli}`);
  const names = r.data.events.map((e) => e.event);
  assert.ok(names.includes('giris') && names.includes('cikis'));
});

test('kayıt bütünlüğü: izlenen konunun videosu/soruları/kendisi değiştirilemez', async () => {
  assert.equal((await admin.del(`/api/admin/topics/${ids.topic}/video`)).status, 409);
  assert.equal((await admin.post(`/api/admin/topics/${ids.topic}/video/start`, { type: 'video/mp4', size: 12 })).status, 409);
  assert.equal((await admin.del(`/api/admin/checkpoints/${ids.cp1}`)).status, 409);
  assert.equal((await admin.put(`/api/admin/checkpoints/${ids.cp1}`, { at_second: 6, question: 'x', options: ['a', 'b'], correct: 0 })).status, 409);
  assert.equal((await admin.del(`/api/admin/topics/${ids.topic}`)).status, 409);
  assert.equal((await admin.del(`/api/admin/sections/${ids.section}`)).status, 409);
  // atamayı kaldırsak bile ilerleme kayıtları eğitimin silinmesini engeller
  const list = (await admin.get('/api/admin/assignments')).data.assignments;
  for (const a of list) await admin.del(`/api/admin/assignments/${a.id}`);
  assert.equal((await admin.del(`/api/admin/courses/${ids.course}`)).status, 409);
  assert.ok(env.VIDEOS._objects.has(ids.videoKey), 'video dosyası korunmalı');
});

test('izlenmemiş konuda video değiştirilebilir ve eski dosya silinir', async () => {
  const c = (await admin.post('/api/admin/courses', { title: 'Yeni' })).data.id;
  const s = (await admin.post(`/api/admin/courses/${c}/sections`, { title: 'B' })).data.id;
  const t = (await admin.post(`/api/admin/sections/${s}/topics`, { title: 'T' })).data.id;
  const upload = async (bytes) => {
    const st = await admin.post(`/api/admin/topics/${t}/video/start`, { type: 'video/webm', size: bytes.length });
    const p = await admin.call('PUT', `/api/admin/topics/${t}/video/part?key=${encodeURIComponent(st.data.key)}&upload_id=${st.data.upload_id}&n=1`, bytes, { 'content-type': 'application/octet-stream', 'x-karma-upload': '1' }, true);
    const done = await admin.post(`/api/admin/topics/${t}/video/complete`, { key: st.data.key, upload_id: st.data.upload_id, type: 'video/webm', duration: 10, parts: [p.data] });
    assert.equal(done.status, 200);
    return st.data.key;
  };
  const k1 = await upload(new Uint8Array([1, 2, 3]));
  const k2 = await upload(new Uint8Array([4, 5, 6, 7]));
  assert.ok(!env.VIDEOS._objects.has(k1), 'eski video silinmeli');
  assert.ok(env.VIDEOS._objects.has(k2));
  assert.equal((await admin.del(`/api/admin/topics/${t}/video`)).status, 200);
  assert.ok(!env.VIDEOS._objects.has(k2));
  // konu silinince video da silinir
  const k3 = await upload(new Uint8Array([9]));
  assert.equal((await admin.del(`/api/admin/topics/${t}`)).status, 200);
  assert.ok(!env.VIDEOS._objects.has(k3));
});

test('R2 tanımlı değilse anlaşılır hata verir', async () => {
  const env2 = { DB: env.DB, ASSETS: env.ASSETS };
  const fresh = (await admin.post(`/api/admin/sections/${ids.section}/topics`, { title: 'İlerlemesiz konu' })).data.id;
  const res = await worker.fetch(new Request(ORIGIN + `/api/admin/topics/${fresh}/video/start`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: admin.cookie },
    body: JSON.stringify({ type: 'video/mp4', size: 10 }),
  }), env2);
  assert.equal(res.status, 503);
});
