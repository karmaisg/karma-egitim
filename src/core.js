// Ortak çekirdek: veritabanı kısayolları ve oturum/yetki denetimi.
import { HttpError, parseCookies, sha256Hex } from './util.js';

export const COOKIE = 'karma_session';

export const one = (env, sql, ...p) => env.DB.prepare(sql).bind(...p).first();
export const all = async (env, sql, ...p) => (await env.DB.prepare(sql).bind(...p).all()).results;
export const run = (env, sql, ...p) => env.DB.prepare(sql).bind(...p).run();

export async function currentUser(ctx) {
  if (ctx._user !== undefined) return ctx._user;
  const token = parseCookies(ctx.request.headers.get('cookie'))[COOKIE];
  let user = null;
  if (token) {
    const id = await sha256Hex(token);
    user = await one(
      ctx.env,
      `SELECT u.id, u.username, u.full_name, u.role, u.company_id
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ? AND s.expires_at > ? AND u.active = 1`,
      id, Date.now(),
    );
  }
  ctx._user = user || null;
  return ctx._user;
}

export async function requireUser(ctx) {
  const u = await currentUser(ctx);
  if (!u) throw new HttpError(401, 'Oturum açmanız gerekiyor.');
  return u;
}

export async function requireAdmin(ctx) {
  const u = await requireUser(ctx);
  if (u.role !== 'admin') throw new HttpError(403, 'Bu işlem için yönetici yetkisi gerekiyor.');
  return u;
}

// Etkinlik günlüğüne kayıt ekler (md. 12/4: giriş-çıkış ve katılım kayıtları).
export function logEvent(env, userId, event, { topicId = null, courseId = null, detail = null } = {}) {
  return run(env,
    'INSERT INTO activity_log (user_id, topic_id, course_id, event, detail, created_at) VALUES (?,?,?,?,?,?)',
    userId, topicId, courseId, event, detail, Date.now());
}
