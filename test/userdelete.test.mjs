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
    const headers = { 'content-type': 'application/json', origin: ORIGIN };
    if (this.cookie) headers.cookie = this.cookie;
    const res = await worker.fetch(new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    const sc = res.headers.get('set-cookie');
    if (sc) { const v = sc.split(';')[0]; this.cookie = v.endsWith('=') ? '' : v; }
    let data = null; try { data = await res.json(); } catch { /* boş */ }
    return { status: res.status, data };
  }
}
const admin = new Client();
const q = (sql, ...p) => env.DB.prepare(sql).bind(...p);

test('deneme katılımcısı silinince video kilidi kalkar; korumalar çalışır', async () => {
  await admin.call('POST', '/api/setup', { setup_code: 'kurulum-kodu-123', username: 'yonetici', full_name: 'Test Yönetici', password: 'Sifre1234' });
  const course = (await admin.call('POST', '/api/admin/courses', { title: 'Yanlış eğitim' })).data.id;
  const sec = (await admin.call('POST', `/api/admin/courses/${course}/sections`, { title: 'B' })).data.id;
  const topic = (await admin.call('POST', `/api/admin/sections/${sec}/topics`, { title: 'K', content: 'x' })).data.id;
  const deneme = (await admin.call('POST', '/api/admin/users', { username: 'deneme', full_name: 'Deneme Kişi' })).data.id;
  const gercek = (await admin.call('POST', '/api/admin/users', { username: 'gercek', full_name: 'Gerçek Kişi' })).data.id;
  for (const u of [deneme, gercek]) {
    await admin.call('POST', '/api/admin/assignments', { course_id: course, user_ids: [u] });
    await q('INSERT INTO topic_progress (user_id, topic_id, started_at, last_heartbeat_at) VALUES (?,?,?,?)', u, topic, 1, 1).run();
  }
  // kilit: katılımcı kaydı varken video değiştirilemez
  const kilit = () => admin.call('POST', `/api/admin/topics/${topic}/video/start`, { type: 'video/mp4', size: 12 });
  assert.equal((await kilit()).status, 409);
  // yanlış onay metni reddedilir
  assert.equal((await admin.call('DELETE', `/api/admin/users/${deneme}`, { confirm: 'yanlis' })).status, 400);
  // sertifikalı katılımcı silinemez
  await q('INSERT INTO certificates (number, user_id, course_id, issued_at, snapshot) VALUES (?,?,?,?,?)', 'T-1', gercek, course, 1, '{}').run();
  assert.equal((await admin.call('DELETE', `/api/admin/users/${gercek}`, { confirm: 'gercek' })).status, 409);
  // kendi hesabı ve yönetici silinemez
  const adminId = (await admin.call('GET', '/api/me')).data.user.id;
  assert.equal((await admin.call('DELETE', `/api/admin/users/${adminId}`, { confirm: 'yonetici' })).status, 400);
  // deneme katılımcısı silinir, ama hâlâ başka kayıt (gerçek) var → kilit sürer
  assert.equal((await admin.call('DELETE', `/api/admin/users/${deneme}`, { confirm: 'deneme' })).status, 200);
  assert.equal((await q('SELECT COUNT(*) AS n FROM topic_progress WHERE user_id = ?', deneme).first()).n, 0);
  assert.equal((await kilit()).status, 409);
  // gerçek katılımcının kaydı yoksa (silinmişse) kilit kalkar: sertifikayı kaldırıp sil
  await q('DELETE FROM certificates WHERE user_id = ?', gercek).run();
  assert.equal((await admin.call('DELETE', `/api/admin/users/${gercek}`, { confirm: 'gercek' })).status, 200);
  assert.equal((await kilit()).status, 200);
  assert.equal((await admin.call('DELETE', '/api/admin/users/99999', { confirm: 'x' })).status, 404);
});
