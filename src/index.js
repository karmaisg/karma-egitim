// KARMA OSGB Eğitim Platformu - sunucu (Cloudflare Worker)
// Aşama 1: giriş, yönetici paneli, eğitim/bölüm/konu yapısı, firma, katılımcı, atama.

import { ensureSchema } from './schema.js';
import { COOKIE, one, all, run, currentUser, requireUser, requireAdmin, logEvent } from './core.js';
import { videoRoutes, deleteVideoObjects } from './video.js';
import { progressRoutes } from './progress.js';
import {
  HttpError, json, reqStr, optStr, textBlock, parseId, username as vUsername, tcNo,
  checkPasswordStrength, hashPassword, verifyPassword, getDummyHash, timingSafeEqual,
  randomToken, sha256Hex, generatePassword, parseCookies,
} from './util.js';

const SESSION_MS = 12 * 60 * 60 * 1000; // 12 saat
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const HAZARDS = ['az_tehlikeli', 'tehlikeli', 'cok_tehlikeli'];

// ---------- Oturum ----------
function cookieHeader(url, value, maxAge) {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}

async function startSession(ctx, userId) {
  const token = randomToken();
  const now = Date.now();
  await run(ctx.env, 'DELETE FROM sessions WHERE expires_at < ?', now);
  await run(ctx.env, 'INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?,?,?,?)',
    await sha256Hex(token), userId, now, now + SESSION_MS);
  return cookieHeader(ctx.url, token, SESSION_MS / 1000);
}

// ---------- Kurulum ve giriş ----------
async function setupStatus(ctx) {
  const row = await one(ctx.env, 'SELECT COUNT(*) AS n FROM users');
  return json({ needed: row.n === 0 });
}

async function setup(ctx) {
  const row = await one(ctx.env, 'SELECT COUNT(*) AS n FROM users');
  if (row.n > 0) throw new HttpError(403, 'Kurulum zaten yapılmış.');
  const expected = ctx.env.SETUP_CODE;
  if (!expected || String(expected).length < 8) {
    throw new HttpError(503, 'Kurulum kodu (SETUP_CODE) Cloudflare ayarlarında henüz tanımlanmamış.');
  }
  const b = await ctx.body();
  if (!timingSafeEqual(String(b.setup_code || ''), String(expected))) {
    throw new HttpError(403, 'Kurulum kodu hatalı.');
  }
  const uname = vUsername(b.username);
  const fullName = reqStr(b.full_name, 'Ad soyad', { max: 100 });
  const pw = checkPasswordStrength(b.password);
  const res = await run(ctx.env,
    'INSERT INTO users (username, password_hash, full_name, role, created_at) VALUES (?,?,?,?,?)',
    uname, await hashPassword(pw), fullName, 'admin', Date.now());
  const cookie = await startSession(ctx, res.meta.last_row_id);
  return json({ ok: true }, 200, { 'set-cookie': cookie });
}

async function login(ctx) {
  const b = await ctx.body();
  const uname = String(b.username || '').trim().toLowerCase().slice(0, 40);
  const password = String(b.password || '').slice(0, 100);
  const ip = ctx.request.headers.get('cf-connecting-ip') || 'local';
  const key = `${uname}|${ip}`;
  const now = Date.now();

  const att = await one(ctx.env, 'SELECT locked_until FROM login_attempts WHERE key = ?', key);
  if (att && att.locked_until > now) {
    throw new HttpError(429, 'Çok fazla hatalı deneme yapıldı. Lütfen 15 dakika sonra tekrar deneyin.');
  }

  const user = uname ? await one(ctx.env, 'SELECT * FROM users WHERE username = ?', uname) : null;
  const ok = await verifyPassword(password, user ? user.password_hash : await getDummyHash());
  if (!user || !ok || !user.active) {
    await run(ctx.env,
      `INSERT INTO login_attempts (key, fails, locked_until, updated_at) VALUES (?,1,0,?)
       ON CONFLICT(key) DO UPDATE SET
         fails = CASE WHEN fails + 1 >= ? THEN 0 ELSE fails + 1 END,
         locked_until = CASE WHEN fails + 1 >= ? THEN ? ELSE 0 END,
         updated_at = excluded.updated_at`,
      key, now, MAX_FAILS, MAX_FAILS, now + LOCK_MS);
    throw new HttpError(401, 'Kullanıcı adı veya şifre hatalı.');
  }
  await run(ctx.env, 'DELETE FROM login_attempts WHERE key = ?', key);
  await logEvent(ctx.env, user.id, 'giris');
  const cookie = await startSession(ctx, user.id);
  return json({ ok: true, role: user.role }, 200, { 'set-cookie': cookie });
}

async function logout(ctx) {
  const u = await currentUser(ctx);
  if (u) await logEvent(ctx.env, u.id, 'cikis');
  const token = parseCookies(ctx.request.headers.get('cookie'))[COOKIE];
  if (token) await run(ctx.env, 'DELETE FROM sessions WHERE id = ?', await sha256Hex(token));
  return json({ ok: true }, 200, { 'set-cookie': cookieHeader(ctx.url, '', 0) });
}

async function me(ctx) {
  const u = await currentUser(ctx);
  if (!u) return json({ user: null });
  const company = u.company_id
    ? await one(ctx.env, 'SELECT name FROM companies WHERE id = ?', u.company_id) : null;
  return json({ user: { id: u.id, username: u.username, full_name: u.full_name, role: u.role, company: company?.name ?? null } });
}

async function changePassword(ctx) {
  const u = await requireUser(ctx);
  const b = await ctx.body();
  const row = await one(ctx.env, 'SELECT password_hash FROM users WHERE id = ?', u.id);
  if (!(await verifyPassword(String(b.current_password || ''), row.password_hash))) {
    throw new HttpError(400, 'Mevcut şifre hatalı.');
  }
  const pw = checkPasswordStrength(b.new_password);
  await run(ctx.env, 'UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(pw), u.id);
  // Diğer cihazlardaki oturumları kapat, bu oturum kalsın
  const token = parseCookies(ctx.request.headers.get('cookie'))[COOKIE];
  await run(ctx.env, 'DELETE FROM sessions WHERE user_id = ? AND id <> ?', u.id, await sha256Hex(token));
  return json({ ok: true });
}

// ---------- Yönetici: özet ----------
async function adminSummary(ctx) {
  await requireAdmin(ctx);
  const env = ctx.env;
  const [learners, courses, assignments, companies] = await Promise.all([
    one(env, "SELECT COUNT(*) AS n FROM users WHERE role = 'learner' AND active = 1"),
    one(env, 'SELECT COUNT(*) AS n FROM courses'),
    one(env, 'SELECT COUNT(*) AS n FROM assignments'),
    one(env, 'SELECT COUNT(*) AS n FROM companies'),
  ]);
  return json({ learners: learners.n, courses: courses.n, assignments: assignments.n, companies: companies.n });
}

// ---------- Yönetici: firmalar ----------
function hazard(v) {
  if (!HAZARDS.includes(v)) throw new HttpError(400, 'Tehlike sınıfı geçersiz.');
  return v;
}

async function listCompanies(ctx) {
  await requireAdmin(ctx);
  const rows = await all(ctx.env,
    `SELECT c.id, c.name, c.hazard_class,
            (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id AND u.active = 1) AS user_count
       FROM companies c ORDER BY c.name COLLATE NOCASE`);
  return json({ companies: rows });
}

async function createCompany(ctx) {
  await requireAdmin(ctx);
  const b = await ctx.body();
  const name = reqStr(b.name, 'Firma adı', { max: 150 });
  const res = await run(ctx.env, 'INSERT INTO companies (name, hazard_class, created_at) VALUES (?,?,?)',
    name, hazard(b.hazard_class), Date.now());
  return json({ id: res.meta.last_row_id }, 201);
}

async function updateCompany(ctx) {
  await requireAdmin(ctx);
  const id = parseId(ctx.params.id, 'Firma');
  const b = await ctx.body();
  const res = await run(ctx.env, 'UPDATE companies SET name = ?, hazard_class = ? WHERE id = ?',
    reqStr(b.name, 'Firma adı', { max: 150 }), hazard(b.hazard_class), id);
  if (!res.meta.changes) throw new HttpError(404, 'Firma bulunamadı.');
  return json({ ok: true });
}

async function deleteCompany(ctx) {
  await requireAdmin(ctx);
  const id = parseId(ctx.params.id, 'Firma');
  const n = await one(ctx.env, 'SELECT COUNT(*) AS n FROM users WHERE company_id = ?', id);
  if (n.n > 0) throw new HttpError(409, 'Bu firmaya bağlı katılımcılar var. Önce katılımcıların firmasını değiştirin.');
  await run(ctx.env, 'DELETE FROM companies WHERE id = ?', id);
  return json({ ok: true });
}

// ---------- Yönetici: kullanıcılar ----------
async function companyIdOrNull(env, v) {
  if (v === null || v === undefined || v === '') return null;
  const id = parseId(v, 'Firma');
  if (!(await one(env, 'SELECT id FROM companies WHERE id = ?', id))) throw new HttpError(400, 'Seçilen firma bulunamadı.');
  return id;
}

function role(v) {
  if (v !== 'admin' && v !== 'learner') throw new HttpError(400, 'Rol geçersiz.');
  return v;
}

async function listUsers(ctx) {
  await requireAdmin(ctx);
  const rows = await all(ctx.env,
    `SELECT u.id, u.username, u.full_name, u.role, u.tc_no, u.job_title, u.company_id, u.active,
            c.name AS company_name,
            (SELECT COUNT(*) FROM assignments a WHERE a.user_id = u.id) AS assignment_count
       FROM users u LEFT JOIN companies c ON c.id = u.company_id
      ORDER BY u.active DESC, u.full_name COLLATE NOCASE`);
  return json({ users: rows });
}

async function createUser(ctx) {
  await requireAdmin(ctx);
  const b = await ctx.body();
  const uname = vUsername(b.username);
  const fullName = reqStr(b.full_name, 'Ad soyad', { max: 100 });
  const r = b.role ? role(b.role) : 'learner';
  const password = b.password ? checkPasswordStrength(b.password) : generatePassword(10);
  if (await one(ctx.env, 'SELECT id FROM users WHERE username = ?', uname)) {
    throw new HttpError(409, 'Bu kullanıcı adı zaten kullanılıyor.');
  }
  const res = await run(ctx.env,
    `INSERT INTO users (username, password_hash, full_name, role, tc_no, job_title, company_id, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    uname, await hashPassword(password), fullName, r, tcNo(b.tc_no),
    optStr(b.job_title, 'Görev', 100), await companyIdOrNull(ctx.env, b.company_id), Date.now());
  // Şifre yalnızca bu yanıtta gösterilir; veritabanında sadece özeti saklanır.
  return json({ id: res.meta.last_row_id, username: uname, password }, 201);
}

async function updateUser(ctx) {
  const admin = await requireAdmin(ctx);
  const id = parseId(ctx.params.id, 'Kullanıcı');
  const b = await ctx.body();
  const target = await one(ctx.env, 'SELECT id, role FROM users WHERE id = ?', id);
  if (!target) throw new HttpError(404, 'Kullanıcı bulunamadı.');
  const newRole = b.role ? role(b.role) : target.role;
  const active = b.active === false || b.active === 0 ? 0 : 1;
  if (id === admin.id && (newRole !== 'admin' || !active)) {
    throw new HttpError(400, 'Kendi yönetici yetkinizi kaldıramaz veya hesabınızı pasife alamazsınız.');
  }
  await run(ctx.env,
    `UPDATE users SET full_name = ?, role = ?, tc_no = ?, job_title = ?, company_id = ?, active = ? WHERE id = ?`,
    reqStr(b.full_name, 'Ad soyad', { max: 100 }), newRole, tcNo(b.tc_no),
    optStr(b.job_title, 'Görev', 100), await companyIdOrNull(ctx.env, b.company_id), active, id);
  if (!active) await run(ctx.env, 'DELETE FROM sessions WHERE user_id = ?', id);
  return json({ ok: true });
}

async function resetPassword(ctx) {
  await requireAdmin(ctx);
  const id = parseId(ctx.params.id, 'Kullanıcı');
  const b = await ctx.body();
  if (!(await one(ctx.env, 'SELECT id FROM users WHERE id = ?', id))) throw new HttpError(404, 'Kullanıcı bulunamadı.');
  const password = b.password ? checkPasswordStrength(b.password) : generatePassword(10);
  await run(ctx.env, 'UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(password), id);
  await run(ctx.env, 'DELETE FROM sessions WHERE user_id = ?', id);
  return json({ password });
}

// ---------- Yönetici: eğitimler, bölümler, konular ----------
async function listCourses(ctx) {
  await requireAdmin(ctx);
  const rows = await all(ctx.env,
    `SELECT c.id, c.title, c.description,
            (SELECT COUNT(*) FROM sections s WHERE s.course_id = c.id) AS section_count,
            (SELECT COUNT(*) FROM topics t JOIN sections s ON s.id = t.section_id WHERE s.course_id = c.id) AS topic_count,
            (SELECT COUNT(*) FROM assignments a WHERE a.course_id = c.id) AS assignment_count
       FROM courses c ORDER BY c.title COLLATE NOCASE`);
  return json({ courses: rows });
}

async function courseTree(env, courseId) {
  const course = await one(env, 'SELECT id, title, description FROM courses WHERE id = ?', courseId);
  if (!course) return null;
  const sections = await all(env, 'SELECT id, title, position FROM sections WHERE course_id = ? ORDER BY position, id', courseId);
  const topics = await all(env,
    `SELECT t.id, t.section_id, t.title, t.content, t.position,
            t.video_name, t.video_size, t.video_duration, (t.video_key IS NOT NULL) AS has_video,
            (SELECT COUNT(*) FROM checkpoints c WHERE c.topic_id = t.id) AS checkpoint_count
       FROM topics t JOIN sections s ON s.id = t.section_id
      WHERE s.course_id = ? ORDER BY t.position, t.id`, courseId);
  for (const s of sections) s.topics = topics.filter((t) => t.section_id === s.id);
  return { course, sections };
}

async function getCourse(ctx) {
  await requireAdmin(ctx);
  const tree = await courseTree(ctx.env, parseId(ctx.params.id, 'Eğitim'));
  if (!tree) throw new HttpError(404, 'Eğitim bulunamadı.');
  return json(tree);
}

async function createCourse(ctx) {
  await requireAdmin(ctx);
  const b = await ctx.body();
  const res = await run(ctx.env, 'INSERT INTO courses (title, description, created_at) VALUES (?,?,?)',
    reqStr(b.title, 'Eğitim adı', { max: 200 }), textBlock(b.description, 'Açıklama', 2000), Date.now());
  return json({ id: res.meta.last_row_id }, 201);
}

async function updateCourse(ctx) {
  await requireAdmin(ctx);
  const id = parseId(ctx.params.id, 'Eğitim');
  const b = await ctx.body();
  const res = await run(ctx.env, 'UPDATE courses SET title = ?, description = ? WHERE id = ?',
    reqStr(b.title, 'Eğitim adı', { max: 200 }), textBlock(b.description, 'Açıklama', 2000), id);
  if (!res.meta.changes) throw new HttpError(404, 'Eğitim bulunamadı.');
  return json({ ok: true });
}

async function deleteCourse(ctx) {
  await requireAdmin(ctx);
  const id = parseId(ctx.params.id, 'Eğitim');
  const n = await one(ctx.env, 'SELECT COUNT(*) AS n FROM assignments WHERE course_id = ?', id);
  if (n.n > 0) {
    throw new HttpError(409, 'Bu eğitim katılımcılara atanmış. Eğitim kayıtlarının korunması için önce atamaları kaldırmanız gerekir.');
  }
  const used = await one(ctx.env,
    `SELECT COUNT(*) AS n FROM topic_progress p JOIN topics t ON t.id = p.topic_id JOIN sections s ON s.id = t.section_id WHERE s.course_id = ?`, id);
  if (used.n > 0) throw new HttpError(409, 'Bu eğitimde katılımcı ilerleme kayıtları var. Kayıtların korunması için silinemez.');
  const videos = await all(ctx.env,
    `SELECT t.video_key FROM topics t JOIN sections s ON s.id = t.section_id WHERE s.course_id = ? AND t.video_key IS NOT NULL`, id);
  await run(ctx.env, 'DELETE FROM courses WHERE id = ?', id);
  await deleteVideoObjects(ctx.env, videos.map((v) => v.video_key));
  return json({ ok: true });
}

async function createSection(ctx) {
  await requireAdmin(ctx);
  const courseId = parseId(ctx.params.id, 'Eğitim');
  if (!(await one(ctx.env, 'SELECT id FROM courses WHERE id = ?', courseId))) throw new HttpError(404, 'Eğitim bulunamadı.');
  const b = await ctx.body();
  const pos = await one(ctx.env, 'SELECT COALESCE(MAX(position), 0) + 1 AS p FROM sections WHERE course_id = ?', courseId);
  const res = await run(ctx.env, 'INSERT INTO sections (course_id, title, position) VALUES (?,?,?)',
    courseId, reqStr(b.title, 'Bölüm adı', { max: 200 }), pos.p);
  return json({ id: res.meta.last_row_id }, 201);
}

async function updateSection(ctx) {
  await requireAdmin(ctx);
  const id = parseId(ctx.params.id, 'Bölüm');
  const b = await ctx.body();
  const res = await run(ctx.env, 'UPDATE sections SET title = ? WHERE id = ?', reqStr(b.title, 'Bölüm adı', { max: 200 }), id);
  if (!res.meta.changes) throw new HttpError(404, 'Bölüm bulunamadı.');
  return json({ ok: true });
}

async function deleteSection(ctx) {
  await requireAdmin(ctx);
  const id = parseId(ctx.params.id, 'Bölüm');
  const used = await one(ctx.env,
    'SELECT COUNT(*) AS n FROM topic_progress p JOIN topics t ON t.id = p.topic_id WHERE t.section_id = ?', id);
  if (used.n > 0) throw new HttpError(409, 'Bu bölümdeki konularda katılımcı ilerleme kayıtları var. Kayıtların korunması için silinemez.');
  const videos = await all(ctx.env, 'SELECT video_key FROM topics WHERE section_id = ? AND video_key IS NOT NULL', id);
  await run(ctx.env, 'DELETE FROM sections WHERE id = ?', id);
  await deleteVideoObjects(ctx.env, videos.map((v) => v.video_key));
  return json({ ok: true });
}

async function createTopic(ctx) {
  await requireAdmin(ctx);
  const sectionId = parseId(ctx.params.id, 'Bölüm');
  if (!(await one(ctx.env, 'SELECT id FROM sections WHERE id = ?', sectionId))) throw new HttpError(404, 'Bölüm bulunamadı.');
  const b = await ctx.body();
  const pos = await one(ctx.env, 'SELECT COALESCE(MAX(position), 0) + 1 AS p FROM topics WHERE section_id = ?', sectionId);
  const res = await run(ctx.env, 'INSERT INTO topics (section_id, title, content, position) VALUES (?,?,?,?)',
    sectionId, reqStr(b.title, 'Konu adı', { max: 200 }), textBlock(b.content, 'Konu içeriği'), pos.p);
  return json({ id: res.meta.last_row_id }, 201);
}

async function updateTopic(ctx) {
  await requireAdmin(ctx);
  const id = parseId(ctx.params.id, 'Konu');
  const b = await ctx.body();
  const res = await run(ctx.env, 'UPDATE topics SET title = ?, content = ? WHERE id = ?',
    reqStr(b.title, 'Konu adı', { max: 200 }), textBlock(b.content, 'Konu içeriği'), id);
  if (!res.meta.changes) throw new HttpError(404, 'Konu bulunamadı.');
  return json({ ok: true });
}

async function deleteTopic(ctx) {
  await requireAdmin(ctx);
  const id = parseId(ctx.params.id, 'Konu');
  const used = await one(ctx.env, 'SELECT COUNT(*) AS n FROM topic_progress WHERE topic_id = ?', id);
  if (used.n > 0) throw new HttpError(409, 'Bu konuda katılımcı ilerleme kayıtları var. Kayıtların korunması için silinemez.');
  const t = await one(ctx.env, 'SELECT video_key FROM topics WHERE id = ?', id);
  await run(ctx.env, 'DELETE FROM topics WHERE id = ?', id);
  if (t?.video_key) await deleteVideoObjects(ctx.env, [t.video_key]);
  return json({ ok: true });
}

// Bölüm/konu sırasını bir adım yukarı veya aşağı taşır (komşusuyla yer değiştirir).
function mover(table, parentCol) {
  return async (ctx) => {
    await requireAdmin(ctx);
    const id = parseId(ctx.params.id, 'Kayıt');
    const b = await ctx.body();
    if (b.direction !== 'up' && b.direction !== 'down') throw new HttpError(400, 'Yön geçersiz.');
    const cur = await one(ctx.env, `SELECT id, ${parentCol} AS parent, position FROM ${table} WHERE id = ?`, id);
    if (!cur) throw new HttpError(404, 'Kayıt bulunamadı.');
    const siblings = await all(ctx.env, `SELECT id FROM ${table} WHERE ${parentCol} = ? ORDER BY position, id`, cur.parent);
    const ids = siblings.map((s) => s.id);
    const i = ids.indexOf(id);
    const j = b.direction === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= ids.length) return json({ ok: true });
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await ctx.env.DB.batch(ids.map((sid, idx) =>
      ctx.env.DB.prepare(`UPDATE ${table} SET position = ? WHERE id = ?`).bind(idx + 1, sid)));
    return json({ ok: true });
  };
}

// ---------- Yönetici: atamalar ----------
async function listAssignments(ctx) {
  await requireAdmin(ctx);
  const rows = await all(ctx.env,
    `SELECT a.id, a.assigned_at, a.user_id, u.full_name, u.username, u.active, c.name AS company_name,
            a.course_id, co.title AS course_title
       FROM assignments a
       JOIN users u ON u.id = a.user_id
       JOIN courses co ON co.id = a.course_id
       LEFT JOIN companies c ON c.id = u.company_id
      ORDER BY a.assigned_at DESC, a.id DESC`);
  return json({ assignments: rows });
}

async function createAssignments(ctx) {
  await requireAdmin(ctx);
  const b = await ctx.body();
  const courseId = parseId(b.course_id, 'Eğitim');
  if (!(await one(ctx.env, 'SELECT id FROM courses WHERE id = ?', courseId))) throw new HttpError(404, 'Eğitim bulunamadı.');
  if (!Array.isArray(b.user_ids) || b.user_ids.length === 0) throw new HttpError(400, 'En az bir katılımcı seçin.');
  if (b.user_ids.length > 500) throw new HttpError(400, 'Tek seferde en fazla 500 katılımcı atanabilir.');
  const ids = [...new Set(b.user_ids.map((v) => parseId(v, 'Katılımcı')))];
  const valid = await all(ctx.env,
    `SELECT id FROM users WHERE active = 1 AND role = 'learner' AND id IN (${ids.map(() => '?').join(',')})`, ...ids);
  const validIds = valid.map((v) => v.id);
  if (validIds.length === 0) throw new HttpError(400, 'Seçilen katılımcılar bulunamadı veya pasif.');
  const now = Date.now();
  const before = await one(ctx.env, 'SELECT COUNT(*) AS n FROM assignments WHERE course_id = ?', courseId);
  await ctx.env.DB.batch(validIds.map((uid) =>
    ctx.env.DB.prepare('INSERT OR IGNORE INTO assignments (user_id, course_id, assigned_at) VALUES (?,?,?)').bind(uid, courseId, now)));
  const after = await one(ctx.env, 'SELECT COUNT(*) AS n FROM assignments WHERE course_id = ?', courseId);
  const added = after.n - before.n;
  return json({ added, already_assigned: validIds.length - added }, 201);
}

async function deleteAssignment(ctx) {
  await requireAdmin(ctx);
  await run(ctx.env, 'DELETE FROM assignments WHERE id = ?', parseId(ctx.params.id, 'Atama'));
  return json({ ok: true });
}

// ---------- Katılımcı ----------
async function myCourses(ctx) {
  const u = await requireUser(ctx);
  const rows = await all(ctx.env,
    `SELECT c.id, c.title, c.description, a.assigned_at,
            (SELECT COUNT(*) FROM sections s WHERE s.course_id = c.id) AS section_count,
            (SELECT COUNT(*) FROM topics t JOIN sections s ON s.id = t.section_id WHERE s.course_id = c.id) AS topic_count
       FROM assignments a JOIN courses c ON c.id = a.course_id
      WHERE a.user_id = ? ORDER BY a.assigned_at DESC, a.id DESC`, u.id);
  return json({ courses: rows });
}

async function myCourse(ctx) {
  const u = await requireUser(ctx);
  const courseId = parseId(ctx.params.id, 'Eğitim');
  const assigned = await one(ctx.env, 'SELECT id FROM assignments WHERE user_id = ? AND course_id = ?', u.id, courseId);
  if (!assigned) throw new HttpError(404, 'Bu eğitim size atanmamış.');
  const tree = await courseTree(ctx.env, courseId);
  const prog = await all(ctx.env,
    `SELECT p.topic_id, p.max_position, p.watched_seconds, p.completed
       FROM topic_progress p JOIN topics t ON t.id = p.topic_id JOIN sections s ON s.id = t.section_id
      WHERE p.user_id = ? AND s.course_id = ?`, u.id, courseId);
  const byTopic = new Map(prog.map((r) => [r.topic_id, r]));
  for (const sec of tree.sections) {
    for (const t of sec.topics) {
      const r = byTopic.get(t.id);
      t.progress = r ? { completed: !!r.completed, max_position: r.max_position, watched_seconds: r.watched_seconds } : { completed: false, max_position: 0, watched_seconds: 0 };
    }
  }
  return json(tree);
}

// ---------- Yönlendirme ----------
const routes = [];
// options.raw: gövde JSON değil ikili veridir (video parçası); CSRF için özel başlık + aynı Origin şart koşulur.
const add = (method, path, handler, options = {}) =>
  routes.push([method, new RegExp('^' + path.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler, options]);

add('GET', '/api/setup-status', setupStatus);
add('POST', '/api/setup', setup);
add('POST', '/api/login', login);
add('POST', '/api/logout', logout);
add('GET', '/api/me', me);
add('POST', '/api/change-password', changePassword);

add('GET', '/api/admin/summary', adminSummary);
add('GET', '/api/admin/companies', listCompanies);
add('POST', '/api/admin/companies', createCompany);
add('PUT', '/api/admin/companies/:id', updateCompany);
add('DELETE', '/api/admin/companies/:id', deleteCompany);

add('GET', '/api/admin/users', listUsers);
add('POST', '/api/admin/users', createUser);
add('PUT', '/api/admin/users/:id', updateUser);
add('POST', '/api/admin/users/:id/reset-password', resetPassword);

add('GET', '/api/admin/courses', listCourses);
add('POST', '/api/admin/courses', createCourse);
add('GET', '/api/admin/courses/:id', getCourse);
add('PUT', '/api/admin/courses/:id', updateCourse);
add('DELETE', '/api/admin/courses/:id', deleteCourse);
add('POST', '/api/admin/courses/:id/sections', createSection);
add('PUT', '/api/admin/sections/:id', updateSection);
add('DELETE', '/api/admin/sections/:id', deleteSection);
add('POST', '/api/admin/sections/:id/move', mover('sections', 'course_id'));
add('POST', '/api/admin/sections/:id/topics', createTopic);
add('PUT', '/api/admin/topics/:id', updateTopic);
add('DELETE', '/api/admin/topics/:id', deleteTopic);
add('POST', '/api/admin/topics/:id/move', mover('topics', 'section_id'));

add('GET', '/api/admin/assignments', listAssignments);
add('POST', '/api/admin/assignments', createAssignments);
add('DELETE', '/api/admin/assignments/:id', deleteAssignment);

add('GET', '/api/my/courses', myCourses);
add('GET', '/api/my/courses/:id', myCourse);

videoRoutes(add);
progressRoutes(add);

export async function handleApi(request, env) {
  const url = new URL(request.url);
  const method = request.method;

  let found = null;
  for (const [m, re, handler, options] of routes) {
    if (m !== method) continue;
    const match = re.exec(url.pathname);
    if (match) { found = { handler, options, params: match.groups || {} }; break; }
  }
  if (!found) throw new HttpError(404, 'Bulunamadı.');

  // CSRF koruması: değiştiren isteklerde Origin aynı site olmalı ve içerik JSON olmalı.
  if (method !== 'GET' && method !== 'HEAD') {
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) throw new HttpError(403, 'İstek reddedildi.');
    if (found.options.raw) {
      // İkili yükleme: tarayıcıların başka siteden gönderemeyeceği özel başlık ve aynı Origin zorunlu.
      if (origin !== url.origin || request.headers.get('x-karma-upload') !== '1') throw new HttpError(403, 'İstek reddedildi.');
    } else if (!(request.headers.get('content-type') || '').includes('application/json')) {
      throw new HttpError(415, 'İçerik türü JSON olmalı.');
    }
  }

  let cached;
  const ctx = {
    request, env, url, params: found.params,
    async body() {
      if (cached === undefined) {
        try { cached = await request.json(); } catch { throw new HttpError(400, 'Geçersiz istek içeriği.'); }
        if (cached === null || typeof cached !== 'object' || Array.isArray(cached)) throw new HttpError(400, 'Geçersiz istek içeriği.');
      }
      return cached;
    },
  };
  return found.handler(ctx);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      await ensureSchema(env.DB);
      return await handleApi(request, env);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error('Beklenmeyen hata:', e);
      return json({ error: 'Beklenmeyen bir hata oluştu.' }, 500);
    }
  },
};
