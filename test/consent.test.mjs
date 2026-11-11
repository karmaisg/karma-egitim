import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createD1 } from './d1shim.mjs';
import { createR2 } from './r2shim.mjs';

const ORIGIN = 'https://egitim.test';
const env = { DB: createD1(), VIDEOS: createR2(), SETUP_CODE: 'kurulum-kodu-123', ASSETS: { fetch: async () => new Response('yok', { status: 404 }) } };
class Client {
  constructor() { this.cookie = ''; }
  async call(method, p, body, extra = {}) {
    const h = { origin: ORIGIN, 'content-type': 'application/json', ...extra };
    if (this.cookie) h.cookie = this.cookie;
    const res = await worker.fetch(new Request(ORIGIN + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    const sc = res.headers.get('set-cookie');
    if (sc) { const v = sc.split(';')[0]; this.cookie = v.endsWith('=') ? '' : v; }
    return { status: res.status, data: await res.json() };
  }
}
const admin = new Client(); const ali = new Client(); const veli = new Client();
let course; let aliId;

test('aydınlatma onayı: hazırlık', async () => {
  await admin.call('POST', '/api/setup', { setup_code: 'kurulum-kodu-123', full_name: 'Yön', username: 'yonetici', password: 'Sifre12345' });
  course = (await admin.call('POST', '/api/admin/courses', { title: 'Eğitim' })).data.id;
  for (const [c, n] of [[ali, 'ali'], [veli, 'veli']]) {
    const u = (await admin.call('POST', '/api/admin/users', { full_name: n.toUpperCase(), username: n, role: 'learner', password: 'Parola12345x' })).data;
    if (c === ali) aliId = u.id;
    await admin.call('POST', '/api/admin/assignments', { course_id: course, user_ids: [u.id] });
    assert.equal((await c.call('POST', '/api/login', { username: n, password: 'Parola12345x' })).status, 200);
  }
});

test('onay verilmeden eğitim verisi kapalı, metin açık', async () => {
  let r = await ali.call('GET', '/api/my/courses');
  assert.equal(r.status, 403); assert.equal(r.data.code, 'consent_required');
  assert.equal((await ali.call('GET', `/api/my/courses/${course}`)).data.code, 'consent_required');
  assert.equal((await ali.call('GET', `/api/my/courses/${course}/certificate`)).data.code, 'consent_required');
  assert.equal((await ali.call('GET', '/api/me')).status, 200);
  r = await ali.call('GET', '/api/my/consent');
  assert.equal(r.status, 200); assert.equal(r.data.accepted, false);
  assert.ok(r.data.blocks.some((b) => b.h === '1. Veri Sorumlusu'));
  assert.ok(r.data.blocks.some((b) => b.h === 'VERİ SORUMLUSU'));
  assert.equal((await admin.call('GET', '/api/admin/courses')).status, 200); // yönetici etkilenmez
});

test('onay: işaretlemeden olmaz, onaylayınca kayıt ve erişim', async () => {
  assert.equal((await ali.call('POST', '/api/my/consent', {})).status, 400);
  assert.equal((await ali.call('POST', '/api/my/consent', { accept: 'true' })).status, 400);
  const r = await ali.call('POST', '/api/my/consent', { accept: true }, { 'cf-connecting-ip': '203.0.113.7', 'user-agent': 'TestTarayici/1.0' });
  assert.equal(r.status, 200);
  assert.equal((await ali.call('GET', '/api/my/courses')).data.courses.length, 1);
  assert.equal((await ali.call('GET', '/api/my/consent')).data.accepted, true);
  // ikinci onay yeni kayıt/etkinlik üretmez
  const first = (await ali.call('GET', '/api/my/consent')).data.accepted_at;
  await ali.call('POST', '/api/my/consent', { accept: true });
  assert.equal((await ali.call('GET', '/api/my/consent')).data.accepted_at, first);
  assert.equal(env.DB._raw.prepare("SELECT COUNT(*) n FROM consents WHERE user_id = ?").get(aliId).n, 1);
  assert.equal(env.DB._raw.prepare("SELECT COUNT(*) n FROM activity_log WHERE event = 'aydinlatma_onayi'").get().n, 1);
  // diğer katılımcı hâlâ kapalı
  assert.equal((await veli.call('GET', '/api/my/courses')).status, 403);
});

test('yönetici onay listesi ve yetki', async () => {
  const r = await admin.call('GET', '/api/admin/consents');
  assert.equal(r.status, 200);
  assert.equal(r.data.consents.length, 2);
  assert.equal(r.data.consents[0].full_name, 'VELI'); // bekleyenler önce
  assert.equal(r.data.consents[0].accepted_at, null);
  const a = r.data.consents[1];
  assert.equal(a.ip, '203.0.113.7'); assert.equal(a.user_agent, 'TestTarayici/1.0'); assert.match(a.text_hash, /^[0-9a-f]{64}$/);
  assert.equal((await ali.call('GET', '/api/admin/consents')).status, 403);
});

test('metin sürümü değişirse yeniden onay gerekir', async () => {
  env.DB._raw.prepare("UPDATE consents SET version = 'v0' WHERE user_id = ?").run(aliId);
  assert.equal((await ali.call('GET', '/api/my/courses')).data.code, 'consent_required');
});
