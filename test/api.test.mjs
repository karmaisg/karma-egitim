import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createD1 } from './d1shim.mjs';
import { SCHEMA_STATEMENTS } from '../src/schema.js';

const ORIGIN = 'https://egitim.test';
const env = { DB: createD1(), SETUP_CODE: 'kurulum-kodu-123', ASSETS: { fetch: async () => new Response('asset') } };

class Client {
  constructor() { this.cookie = ''; }
  async call(...a) {
    // Katılımcılar eğitim verilerine ulaşmadan önce aydınlatma metnini onaylamalıdır (testlerde otomatik onaylanır).
    let r = await this._call(...a);
    if (r.status === 403 && r.data && r.data.code === 'consent_required') {
      await this._call('POST', '/api/my/consent', { accept: true });
      r = await this._call(...a);
    }
    return r;
  }
  async _call(method, path, body, extraHeaders = {}) {
    const headers = { 'content-type': 'application/json', origin: ORIGIN, ...extraHeaders };
    if (this.cookie) headers.cookie = this.cookie;
    const res = await worker.fetch(new Request(ORIGIN + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
    const sc = res.headers.get('set-cookie');
    if (sc) {
      const val = sc.split(';')[0];
      this.cookie = val.endsWith('=') ? '' : val;
    }
    let data = null;
    try { data = await res.json(); } catch { /* boş */ }
    return { status: res.status, data, headers: res.headers };
  }
  get(p) { return this.call('GET', p); }
  post(p, b = {}) { return this.call('POST', p, b); }
  put(p, b = {}) { return this.call('PUT', p, b); }
  del(p) { return this.call('DELETE', p, {}); }
}

const admin = new Client();
const learner = new Client();
const anon = new Client();
const ids = {};

test('kurulum: kod olmadan ve yanlış kodla reddedilir, doğru kodla yönetici oluşur', async () => {
  assert.equal((await anon.get('/api/setup-status')).data.needed, true);
  let r = await anon.post('/api/setup', { setup_code: 'yanlis', username: 'yonetici', full_name: 'Test Yönetici', password: 'Sifre1234' });
  assert.equal(r.status, 403);
  r = await admin.post('/api/setup', { setup_code: 'kurulum-kodu-123', username: 'Yonetici', full_name: 'Test Yönetici', password: 'Sifre1234' });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie'), /HttpOnly/);
  assert.match(r.headers.get('set-cookie'), /SameSite=Strict/);
  assert.equal((await anon.get('/api/setup-status')).data.needed, false);
  // ikinci kurulum denemesi engellenir
  r = await anon.post('/api/setup', { setup_code: 'kurulum-kodu-123', username: 'baska', full_name: 'X Y', password: 'Sifre1234' });
  assert.equal(r.status, 403);
});

test('kurulum kodu tanımlı değilse kurulum yapılamaz', async () => {
  const env2 = { DB: createD1(), ASSETS: env.ASSETS };
  // Şema önbelleği tek veritabanı içindir (canlıda böyle); bu ikinci veritabanına tabloları elle kur.
  await env2.DB.batch(SCHEMA_STATEMENTS.map((s) => env2.DB.prepare(s)));
  const res = await worker.fetch(new Request(ORIGIN + '/api/setup', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ setup_code: '', username: 'abc', full_name: 'A B', password: 'Sifre1234' }),
  }), env2);
  assert.equal(res.status, 503);
});

test('oturum: /me, yanlış şifre, çıkış', async () => {
  let r = await admin.get('/api/me');
  assert.equal(r.data.user.role, 'admin');
  assert.equal(r.data.user.username, 'yonetici');
  r = await anon.get('/api/me');
  assert.equal(r.data.user, null);
  r = await anon.post('/api/login', { username: 'yonetici', password: 'yanlis-sifre' });
  assert.equal(r.status, 401);
  r = await anon.post('/api/login', { username: 'yok-boyle-biri', password: 'yanlis-sifre' });
  assert.equal(r.status, 401);
  assert.equal(r.data.error, 'Kullanıcı adı veya şifre hatalı.');
  const other = new Client();
  r = await other.post('/api/login', { username: 'YONETICI', password: 'Sifre1234' });
  assert.equal(r.status, 200);
  await other.post('/api/logout');
  assert.equal((await other.get('/api/me')).data.user, null);
});

test('yetkisiz erişim engellenir', async () => {
  assert.equal((await anon.get('/api/admin/users')).status, 401);
  assert.equal((await anon.get('/api/my/courses')).status, 401);
});

test('brute-force koruması: 5 hatalı denemeden sonra kilitlenir', async () => {
  const victim = new Client();
  for (let i = 0; i < 5; i++) {
    const r = await victim.call('POST', '/api/login', { username: 'kilit.testi', password: 'x' }, { 'cf-connecting-ip': '1.2.3.4' });
    assert.equal(r.status, 401);
  }
  const r = await victim.call('POST', '/api/login', { username: 'kilit.testi', password: 'x' }, { 'cf-connecting-ip': '1.2.3.4' });
  assert.equal(r.status, 429);
  // başka IP'den aynı kullanıcı adı kilitlenmez
  const r2 = await victim.call('POST', '/api/login', { username: 'kilit.testi', password: 'x' }, { 'cf-connecting-ip': '9.9.9.9' });
  assert.equal(r2.status, 401);
});

test('CSRF: yabancı Origin ve JSON olmayan içerik reddedilir', async () => {
  let r = await admin.call('POST', '/api/admin/companies', { name: 'Zararlı', hazard_class: 'tehlikeli' }, { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  r = await admin.call('POST', '/api/admin/companies', { name: 'Zararlı', hazard_class: 'tehlikeli' }, { 'content-type': 'text/plain' });
  assert.equal(r.status, 415);
});

test('firma işlemleri', async () => {
  let r = await admin.post('/api/admin/companies', { name: 'Örnek İnşaat A.Ş.', hazard_class: 'cok_tehlikeli' });
  assert.equal(r.status, 201);
  ids.company = r.data.id;
  r = await admin.post('/api/admin/companies', { name: 'Bozuk', hazard_class: 'yok' });
  assert.equal(r.status, 400);
  r = await admin.put(`/api/admin/companies/${ids.company}`, { name: 'Örnek İnşaat Anonim Şirketi', hazard_class: 'cok_tehlikeli' });
  assert.equal(r.status, 200);
  r = await admin.get('/api/admin/companies');
  assert.equal(r.data.companies[0].name, 'Örnek İnşaat Anonim Şirketi');
});

test('katılımcı oluşturma: şifre üretilir, doğrulama kuralları çalışır', async () => {
  let r = await admin.post('/api/admin/users', { username: 'Ali.Yilmaz', full_name: 'Ali Yılmaz', company_id: ids.company, tc_no: '10000000146', job_title: 'Kalıpçı' });
  assert.equal(r.status, 201);
  assert.equal(r.data.username, 'ali.yilmaz');
  assert.equal(r.data.password.length, 10);
  ids.learner = r.data.id;
  ids.learnerPw = r.data.password;
  r = await admin.post('/api/admin/users', { username: 'ali.yilmaz', full_name: 'Başka' });
  assert.equal(r.status, 409);
  r = await admin.post('/api/admin/users', { username: 'Türkçe', full_name: 'X Y' });
  assert.equal(r.status, 400);
  r = await admin.post('/api/admin/users', { username: 'kisa.sifre', full_name: 'X Y', password: '123' });
  assert.equal(r.status, 400);
  r = await admin.post('/api/admin/users', { username: 'tc.hatali', full_name: 'X Y', tc_no: '01234567890' });
  assert.equal(r.status, 400);
  r = await admin.post('/api/admin/users', { username: 'firma.yok', full_name: 'X Y', company_id: 9999 });
  assert.equal(r.status, 400);
  r = await admin.get('/api/admin/users');
  const ali = r.data.users.find((u) => u.username === 'ali.yilmaz');
  assert.equal(ali.company_name, 'Örnek İnşaat Anonim Şirketi');
  assert.ok(!('password_hash' in ali), 'şifre özeti API yanıtında yer almamalı');
  assert.ok(!JSON.stringify(r.data).includes('pbkdf2'));
});

test('katılımcı girişi ve yönetici ekranlarına erişememesi', async () => {
  let r = await learner.post('/api/login', { username: 'ali.yilmaz', password: ids.learnerPw });
  assert.equal(r.status, 200);
  assert.equal(r.data.role, 'learner');
  assert.equal((await learner.get('/api/admin/users')).status, 403);
  assert.equal((await learner.post('/api/admin/courses', { title: 'x' })).status, 403);
  assert.equal((await learner.get('/api/my/courses')).data.courses.length, 0);
});

test('eğitim → bölüm → konu yapısı ve sıralama', async () => {
  let r = await admin.post('/api/admin/courses', { title: 'Temel İSG Eğitimi', description: 'Çok tehlikeli sınıf' });
  assert.equal(r.status, 201);
  ids.course = r.data.id;
  r = await admin.post(`/api/admin/courses/${ids.course}/sections`, { title: 'Genel Konular' });
  ids.s1 = r.data.id;
  r = await admin.post(`/api/admin/courses/${ids.course}/sections`, { title: 'Sağlık Konuları' });
  ids.s2 = r.data.id;
  r = await admin.post(`/api/admin/sections/${ids.s1}/topics`, { title: 'Çalışma mevzuatı', content: 'İlk satır\nİkinci satır' });
  ids.t1 = r.data.id;
  r = await admin.post(`/api/admin/sections/${ids.s1}/topics`, { title: 'İSG kanunu' });
  ids.t2 = r.data.id;
  r = await admin.get(`/api/admin/courses/${ids.course}`);
  assert.deepEqual(r.data.sections.map((s) => s.title), ['Genel Konular', 'Sağlık Konuları']);
  assert.deepEqual(r.data.sections[0].topics.map((t) => t.title), ['Çalışma mevzuatı', 'İSG kanunu']);
  assert.equal(r.data.sections[0].topics[0].content, 'İlk satır\nİkinci satır');

  // konuyu aşağı taşı, sonra bölümü yukarı taşı
  await admin.post(`/api/admin/topics/${ids.t1}/move`, { direction: 'down' });
  await admin.post(`/api/admin/sections/${ids.s2}/move`, { direction: 'up' });
  r = await admin.get(`/api/admin/courses/${ids.course}`);
  assert.deepEqual(r.data.sections.map((s) => s.title), ['Sağlık Konuları', 'Genel Konular']);
  assert.deepEqual(r.data.sections[1].topics.map((t) => t.title), ['İSG kanunu', 'Çalışma mevzuatı']);
  // en üstteki yukarı taşınırsa değişmez, hata vermez
  assert.equal((await admin.post(`/api/admin/sections/${ids.s2}/move`, { direction: 'up' })).status, 200);
  assert.equal((await admin.post(`/api/admin/sections/${ids.s2}/move`, { direction: 'sideways' })).status, 400);

  r = await admin.put(`/api/admin/topics/${ids.t2}`, { title: '6331 sayılı Kanun', content: 'Yeni içerik' });
  assert.equal(r.status, 200);
  r = await admin.put(`/api/admin/sections/${ids.s1}`, { title: 'Genel Konular (1)' });
  assert.equal(r.status, 200);
  assert.equal((await admin.post(`/api/admin/courses/${ids.course}/sections`, { title: '   ' })).status, 400);
  assert.equal((await admin.post('/api/admin/courses/999/sections', { title: 'x' })).status, 404);
});

test('atama: yinelenen atama sayılmaz, katılımcı yalnızca atanan eğitimi görür', async () => {
  let r = await admin.post('/api/admin/assignments', { course_id: ids.course, user_ids: [ids.learner] });
  assert.equal(r.status, 201);
  assert.equal(r.data.added, 1);
  r = await admin.post('/api/admin/assignments', { course_id: ids.course, user_ids: [ids.learner, ids.learner] });
  assert.equal(r.data.added, 0);
  assert.equal(r.data.already_assigned, 1);
  assert.equal((await admin.post('/api/admin/assignments', { course_id: ids.course, user_ids: [] })).status, 400);

  r = await learner.get('/api/my/courses');
  assert.equal(r.data.courses.length, 1);
  assert.equal(r.data.courses[0].topic_count, 2);
  r = await learner.get(`/api/my/courses/${ids.course}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.sections.length, 2);

  // atanmamış eğitim görünmez
  const c2 = (await admin.post('/api/admin/courses', { title: 'Atanmamış Eğitim' })).data.id;
  assert.equal((await learner.get(`/api/my/courses/${c2}`)).status, 404);
  // yönetici katılımcı atamasına yöneticiyi dahil edemez (yalnızca learner rolü)
  r = await admin.post('/api/admin/assignments', { course_id: c2, user_ids: [1] });
  assert.equal(r.status, 400);
});

test('atanmış eğitim silinemez; atama kaldırılınca silinebilir', async () => {
  assert.equal((await admin.del(`/api/admin/courses/${ids.course}`)).status, 409);
  const list = (await admin.get('/api/admin/assignments')).data.assignments;
  assert.equal(list.length, 1);
  assert.equal(list[0].full_name, 'Ali Yılmaz');
  assert.equal((await admin.del(`/api/admin/assignments/${list[0].id}`)).status, 200);
  assert.equal((await learner.get(`/api/my/courses/${ids.course}`)).status, 404);
  assert.equal((await admin.del(`/api/admin/courses/${ids.course}`)).status, 200);
  assert.equal((await admin.get(`/api/admin/courses/${ids.course}`)).status, 404);
  // bölümler ve konular da silinmiş olmalı (CASCADE)
  const n = env.DB._raw.prepare('SELECT COUNT(*) AS n FROM topics').get().n;
  assert.equal(n, 0);
});

test('firma silme: bağlı katılımcı varsa engellenir', async () => {
  assert.equal((await admin.del(`/api/admin/companies/${ids.company}`)).status, 409);
});

test('şifre sıfırlama ve değiştirme', async () => {
  let r = await admin.post(`/api/admin/users/${ids.learner}/reset-password`, {});
  assert.equal(r.status, 200);
  const newPw = r.data.password;
  // eski oturum kapanır, eski şifre geçmez
  assert.equal((await learner.get('/api/me')).data.user, null);
  assert.equal((await learner.post('/api/login', { username: 'ali.yilmaz', password: ids.learnerPw })).status, 401);
  assert.equal((await learner.post('/api/login', { username: 'ali.yilmaz', password: newPw })).status, 200);

  r = await learner.post('/api/change-password', { current_password: 'yanlis', new_password: 'YeniSifre99' });
  assert.equal(r.status, 400);
  r = await learner.post('/api/change-password', { current_password: newPw, new_password: 'kisa' });
  assert.equal(r.status, 400);
  r = await learner.post('/api/change-password', { current_password: newPw, new_password: 'YeniSifre99' });
  assert.equal(r.status, 200);
  assert.equal((await learner.get('/api/me')).data.user.username, 'ali.yilmaz'); // bu oturum açık kalır
  const fresh = new Client();
  assert.equal((await fresh.post('/api/login', { username: 'ali.yilmaz', password: 'YeniSifre99' })).status, 200);
});

test('pasife alınan katılımcı giremez ve oturumu kapanır; yönetici kendini pasife alamaz', async () => {
  let r = await admin.put(`/api/admin/users/${ids.learner}`, { full_name: 'Ali Yılmaz', role: 'learner', active: false, company_id: ids.company });
  assert.equal(r.status, 200);
  assert.equal((await learner.get('/api/me')).data.user, null);
  assert.equal((await new Client().post('/api/login', { username: 'ali.yilmaz', password: 'YeniSifre99' })).status, 401);
  const adminId = (await admin.get('/api/me')).data.user.id;
  r = await admin.put(`/api/admin/users/${adminId}`, { full_name: 'Test Yönetici', role: 'learner', active: true });
  assert.equal(r.status, 400);
  r = await admin.put(`/api/admin/users/${adminId}`, { full_name: 'Test Yönetici', role: 'admin', active: false });
  assert.equal(r.status, 400);
  // pasif katılımcıya yeni atama yapılamaz
  const c = (await admin.post('/api/admin/courses', { title: 'Yeni' })).data.id;
  assert.equal((await admin.post('/api/admin/assignments', { course_id: c, user_ids: [ids.learner] })).status, 400);
});

test('özet sayıları', async () => {
  const r = await admin.get('/api/admin/summary');
  assert.equal(r.status, 200);
  assert.equal(typeof r.data.learners, 'number');
  assert.equal(r.data.companies, 1);
});

test('SQL enjeksiyonu denemesi zararsızdır', async () => {
  const r = await anon.post('/api/login', { username: "x' OR '1'='1", password: "' OR '1'='1" });
  assert.equal(r.status, 401);
  const r2 = await admin.post('/api/admin/courses', { title: "Robert'); DROP TABLE users;--" });
  assert.equal(r2.status, 201);
  assert.equal((await admin.get('/api/admin/users')).status, 200);
});

test('bilinmeyen yol ve geçersiz gövde', async () => {
  assert.equal((await admin.get('/api/yok')).status, 404);
  const res = await worker.fetch(new Request(ORIGIN + '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: '{bozuk',
  }), env);
  assert.equal(res.status, 400);
  const res2 = await worker.fetch(new Request(ORIGIN + '/index.html'), env);
  assert.equal(await res2.text(), 'asset');
});
