// Katılım takibi (Yönetmelik md. 12/4, 12/5, 17/2):
//  - Katılımcının video konumu sunucuda doğrulanır; gerçek zamandan hızlı ilerleme (ileri sarma) kabul edilmez.
//  - Videonun belirli saniyelerinde çıkan kontrol soruları cevaplanmadan konu ilerleyemez/tamamlanamaz.
//  - Giriş-çıkış, sekme değiştirme, soru cevapları ve tamamlama etkinlik günlüğüne yazılır.
//  - Yönetici raporları bu kayıtlardan üretilir.

import { HttpError, json, parseId, reqStr, textBlock } from './util.js';
import { one, all, run, requireUser, requireAdmin, logEvent } from './core.js';

const MIN_HEARTBEAT_GAP_MS = 5000;   // bundan sık gelen konum bildirimleri yok sayılır (tolerans şişirmeyi önler)
const MAX_ELAPSED_S = 120;           // tek bildirimde sayılacak en fazla gerçek süre
const SPEED_TOLERANCE = 1.1;         // oynatma hızı 1x; küçük sapmalara tolerans
const END_SLACK_S = 3;               // videonun bitmesine bu kadar saniye kala "bitti" sayılır
const CLIENT_EVENTS = {
  opened: 'konu_acildi',
  tab_hidden: 'sekme_degisti',
  tab_visible: 'sekmeye_dondu',
  left: 'konudan_ayrildi',
};

// ---------- Yardımcılar ----------
async function learnerTopic(ctx, topicId) {
  const u = await requireUser(ctx);
  const t = await one(ctx.env,
    `SELECT t.id, t.title, t.content, t.video_key, t.video_duration, t.section_id, s.course_id
       FROM topics t JOIN sections s ON s.id = t.section_id WHERE t.id = ?`, topicId);
  if (!t) throw new HttpError(404, 'Konu bulunamadı.');
  if (u.role === 'admin') return { u, t, preview: true };
  const ok = await one(ctx.env, 'SELECT id FROM assignments WHERE user_id = ? AND course_id = ?', u.id, t.course_id);
  if (!ok) throw new HttpError(404, 'Konu bulunamadı.');
  return { u, t, preview: false };
}

// Kayıt yoksa oluşturur. created: kayıt bu çağrıda mı oluştu (ilk bildirimi ayırt etmek için).
async function ensureProgress(env, userId, topicId) {
  const now = Date.now();
  const res = await run(env,
    `INSERT OR IGNORE INTO topic_progress (user_id, topic_id, started_at, last_heartbeat_at) VALUES (?,?,?,?)`,
    userId, topicId, now, now);
  const row = await one(env, 'SELECT * FROM topic_progress WHERE user_id = ? AND topic_id = ?', userId, topicId);
  return { row, created: res.meta.changes > 0 };
}

const nextUnanswered = (env, userId, topicId) => one(env,
  `SELECT c.id, c.at_second FROM checkpoints c
    WHERE c.topic_id = ?
      AND NOT EXISTS (SELECT 1 FROM checkpoint_answers a WHERE a.checkpoint_id = c.id AND a.user_id = ? AND a.is_correct = 1)
    ORDER BY c.at_second LIMIT 1`, topicId, userId);

const publicProgress = (r) => ({
  max_position: r.max_position, last_position: r.last_position,
  watched_seconds: Math.round(r.watched_seconds), completed: !!r.completed,
});

// ---------- Katılımcı ----------
async function getTopic(ctx) {
  const { u, t, preview } = await learnerTopic(ctx, parseId(ctx.params.id, 'Konu'));
  const cps = await all(ctx.env, 'SELECT id, at_second, question, options FROM checkpoints WHERE topic_id = ? ORDER BY at_second', t.id);
  const answered = preview ? [] : await all(ctx.env,
    `SELECT DISTINCT a.checkpoint_id FROM checkpoint_answers a JOIN checkpoints c ON c.id = a.checkpoint_id
      WHERE a.user_id = ? AND c.topic_id = ? AND a.is_correct = 1`, u.id, t.id);
  const done = new Set(answered.map((r) => r.checkpoint_id));
  const progress = preview ? null : await one(ctx.env, 'SELECT * FROM topic_progress WHERE user_id = ? AND topic_id = ?', u.id, t.id);
  const course = await one(ctx.env, 'SELECT id, title FROM courses WHERE id = ?', t.course_id);
  return json({
    topic: {
      id: t.id, title: t.title, content: t.content, course_id: t.course_id, course_title: course.title,
      has_video: !!t.video_key, video_duration: t.video_duration,
      checkpoints: cps.map((c) => ({ id: c.id, at_second: c.at_second, question: c.question, options: JSON.parse(c.options), answered: done.has(c.id) })),
      progress: progress ? publicProgress(progress) : { max_position: 0, last_position: 0, watched_seconds: 0, completed: false },
      preview,
    },
  });
}

async function heartbeat(ctx) {
  const { u, t, preview } = await learnerTopic(ctx, parseId(ctx.params.id, 'Konu'));
  if (preview) return json({ preview: true });
  if (!t.video_key) throw new HttpError(400, 'Bu konuda video yok.');
  const b = await ctx.body();
  const pos = Number(b.position);
  if (!Number.isFinite(pos)) throw new HttpError(400, 'Konum geçersiz.');
  const playing = b.playing === true;
  const dur = t.video_duration;

  const { row, created } = await ensureProgress(ctx.env, u.id, t.id);
  if (row.completed) return json({ ...publicProgress(row), clamped: false, limit: null });

  const now = Date.now();
  const gap = now - row.last_heartbeat_at;
  // Çok sık gelen bildirim: konum ilerletilmez, süre birikmeye devam eder (kaydı yeni oluşturan ilk bildirim hariç)
  if (!created && gap < MIN_HEARTBEAT_GAP_MS) {
    return json({ ...publicProgress(row), clamped: false, limit: null, throttled: true });
  }
  const elapsed = Math.min(gap / 1000, MAX_ELAPSED_S);

  const pending = await nextUnanswered(ctx.env, u.id, t.id);
  let allowed = row.max_position + elapsed * SPEED_TOLERANCE + 1;
  allowed = Math.min(allowed, dur);
  if (pending) allowed = Math.min(allowed, pending.at_second);

  const p = Math.min(Math.max(pos, 0), dur);
  const clamped = p > allowed + 0.5;
  const newMax = Math.max(row.max_position, Math.min(p, allowed));
  const lastPos = Math.min(p, newMax);
  const watched = row.watched_seconds + (playing ? Math.min(elapsed, 20) : 0);

  let completed = 0;
  if (newMax >= dur - END_SLACK_S && !pending) completed = 1;

  await run(ctx.env,
    `UPDATE topic_progress SET max_position = ?, last_position = ?, watched_seconds = ?, last_heartbeat_at = ?,
            completed = ?, completed_at = CASE WHEN ? = 1 THEN ? ELSE completed_at END
      WHERE user_id = ? AND topic_id = ?`,
    newMax, lastPos, watched, now, completed, completed, now, u.id, t.id);

  if (clamped) await logEvent(ctx.env, u.id, 'ileri_sarma_engellendi', { topicId: t.id, courseId: t.course_id, detail: `${Math.round(p)}. sn istendi, izin verilen ${Math.round(newMax)}. sn` });
  if (completed) await logEvent(ctx.env, u.id, 'konu_tamamlandi', { topicId: t.id, courseId: t.course_id });

  return json({
    max_position: newMax, last_position: lastPos, watched_seconds: Math.round(watched), completed: !!completed,
    clamped, limit: pending ? pending.at_second : null,
  });
}

async function clientEvent(ctx) {
  const { u, t, preview } = await learnerTopic(ctx, parseId(ctx.params.id, 'Konu'));
  const b = await ctx.body();
  const name = CLIENT_EVENTS[b.event];
  if (!name) throw new HttpError(400, 'Olay türü geçersiz.');
  if (preview) return json({ ok: true });
  if (b.event === 'opened') await ensureProgress(ctx.env, u.id, t.id);
  await logEvent(ctx.env, u.id, name, { topicId: t.id, courseId: t.course_id });
  return json({ ok: true });
}

async function answerCheckpoint(ctx) {
  const u = await requireUser(ctx);
  const id = parseId(ctx.params.id, 'Soru');
  const cp = await one(ctx.env,
    `SELECT c.id, c.topic_id, c.at_second, c.correct, c.options, s.course_id
       FROM checkpoints c JOIN topics t ON t.id = c.topic_id JOIN sections s ON s.id = t.section_id WHERE c.id = ?`, id);
  if (!cp) throw new HttpError(404, 'Soru bulunamadı.');
  const assigned = await one(ctx.env, 'SELECT id FROM assignments WHERE user_id = ? AND course_id = ?', u.id, cp.course_id);
  if (!assigned) throw new HttpError(404, 'Soru bulunamadı.');
  const b = await ctx.body();
  const selected = Number(b.selected);
  const optionCount = JSON.parse(cp.options).length;
  if (!Number.isInteger(selected) || selected < 0 || selected >= optionCount) throw new HttpError(400, 'Seçenek geçersiz.');

  // Konum bildirimleri 15 sn arayla geldiğinden, son bildirimden bu yana geçen gerçek süre de hesaba katılır.
  const prog = await one(ctx.env, 'SELECT max_position, last_heartbeat_at FROM topic_progress WHERE user_id = ? AND topic_id = ?', u.id, cp.topic_id);
  const reachable = prog
    ? prog.max_position + Math.min((Date.now() - prog.last_heartbeat_at) / 1000, MAX_ELAPSED_S) * SPEED_TOLERANCE + 1
    : 0;
  if (!prog || reachable < cp.at_second - END_SLACK_S) throw new HttpError(400, 'Bu soruya henüz gelmediniz.');

  const already = await one(ctx.env, 'SELECT id FROM checkpoint_answers WHERE user_id = ? AND checkpoint_id = ? AND is_correct = 1', u.id, id);
  if (already) return json({ correct: true });
  const correct = selected === cp.correct ? 1 : 0;
  await run(ctx.env, 'INSERT INTO checkpoint_answers (user_id, checkpoint_id, selected, is_correct, answered_at) VALUES (?,?,?,?,?)',
    u.id, id, selected, correct, Date.now());
  await logEvent(ctx.env, u.id, correct ? 'kontrol_sorusu_dogru' : 'kontrol_sorusu_yanlis', { topicId: cp.topic_id, courseId: cp.course_id, detail: `Soru ${id}, ${cp.at_second}. sn` });
  return json({ correct: !!correct });
}

// Videosuz (yalnızca metin) konular okunarak tamamlanır.
async function completeTextTopic(ctx) {
  const { u, t, preview } = await learnerTopic(ctx, parseId(ctx.params.id, 'Konu'));
  if (preview) return json({ preview: true });
  if (t.video_key) throw new HttpError(400, 'Video içeren konular videoyu izleyerek tamamlanır.');
  const { row } = await ensureProgress(ctx.env, u.id, t.id);
  if (row.completed) return json({ completed: true });
  if (Date.now() - row.started_at < 5000) throw new HttpError(400, 'Lütfen konuyu okuduktan sonra tamamlayın.');
  const now = Date.now();
  await run(ctx.env, 'UPDATE topic_progress SET completed = 1, completed_at = ?, last_heartbeat_at = ? WHERE user_id = ? AND topic_id = ?', now, now, u.id, t.id);
  await logEvent(ctx.env, u.id, 'konu_tamamlandi', { topicId: t.id, courseId: t.course_id });
  return json({ completed: true });
}

// ---------- Yönetici: kontrol soruları ----------
function parseCheckpoint(b, duration) {
  const question = reqStr(b.question, 'Soru', { max: 500 });
  const at = Math.round(Number(b.at_second));
  if (!Number.isFinite(at) || at < 1) throw new HttpError(400, 'Soru zamanı en az 1. saniye olmalı.');
  if (at >= duration) throw new HttpError(400, `Soru zamanı video süresinden (${duration} sn) önce olmalı.`);
  if (!Array.isArray(b.options) || b.options.length < 2 || b.options.length > 4) throw new HttpError(400, 'En az 2, en fazla 4 seçenek girin.');
  const options = b.options.map((o) => reqStr(typeof o === 'string' ? o : '', 'Seçenek', { max: 200 }));
  const correct = Number(b.correct);
  if (!Number.isInteger(correct) || correct < 0 || correct >= options.length) throw new HttpError(400, 'Doğru seçeneği işaretleyin.');
  return { question, at, options: JSON.stringify(options), correct };
}

async function adminTopicForCheckpoint(ctx, topicId) {
  const t = await one(ctx.env, 'SELECT id, video_key, video_duration FROM topics WHERE id = ?', topicId);
  if (!t) throw new HttpError(404, 'Konu bulunamadı.');
  if (!t.video_key) throw new HttpError(400, 'Kontrol sorusu eklemek için önce konuya video yükleyin.');
  const used = await one(ctx.env, 'SELECT COUNT(*) AS n FROM topic_progress WHERE topic_id = ?', topicId);
  if (used.n > 0) throw new HttpError(409, 'Bu konuyu izleyen katılımcılar var. Kayıtların tutarlılığı için sorular değiştirilemez.');
  return t;
}

async function listCheckpoints(ctx) {
  await requireAdmin(ctx);
  const rows = await all(ctx.env, 'SELECT id, at_second, question, options, correct FROM checkpoints WHERE topic_id = ? ORDER BY at_second', parseId(ctx.params.id, 'Konu'));
  return json({ checkpoints: rows.map((r) => ({ ...r, options: JSON.parse(r.options) })) });
}

async function createCheckpoint(ctx) {
  await requireAdmin(ctx);
  const t = await adminTopicForCheckpoint(ctx, parseId(ctx.params.id, 'Konu'));
  const c = parseCheckpoint(await ctx.body(), t.video_duration);
  const res = await run(ctx.env, 'INSERT INTO checkpoints (topic_id, at_second, question, options, correct) VALUES (?,?,?,?,?)',
    t.id, c.at, c.question, c.options, c.correct);
  return json({ id: res.meta.last_row_id }, 201);
}

async function updateCheckpoint(ctx) {
  await requireAdmin(ctx);
  const id = parseId(ctx.params.id, 'Soru');
  const cp = await one(ctx.env, 'SELECT topic_id FROM checkpoints WHERE id = ?', id);
  if (!cp) throw new HttpError(404, 'Soru bulunamadı.');
  const t = await adminTopicForCheckpoint(ctx, cp.topic_id);
  const c = parseCheckpoint(await ctx.body(), t.video_duration);
  await run(ctx.env, 'UPDATE checkpoints SET at_second = ?, question = ?, options = ?, correct = ? WHERE id = ?', c.at, c.question, c.options, c.correct, id);
  return json({ ok: true });
}

async function deleteCheckpoint(ctx) {
  await requireAdmin(ctx);
  const id = parseId(ctx.params.id, 'Soru');
  const cp = await one(ctx.env, 'SELECT topic_id FROM checkpoints WHERE id = ?', id);
  if (!cp) throw new HttpError(404, 'Soru bulunamadı.');
  await adminTopicForCheckpoint(ctx, cp.topic_id);
  await run(ctx.env, 'DELETE FROM checkpoints WHERE id = ?', id);
  return json({ ok: true });
}

// ---------- Yönetici: raporlar ----------
async function progressReport(ctx) {
  await requireAdmin(ctx);
  const rows = await all(ctx.env,
    `SELECT a.id AS assignment_id, u.id AS user_id, u.full_name, u.username, u.tc_no, u.job_title, u.active,
            c.name AS company_name, co.id AS course_id, co.title AS course_title, a.assigned_at,
            (SELECT COUNT(*) FROM topics t JOIN sections s ON s.id = t.section_id WHERE s.course_id = co.id) AS topics_total,
            (SELECT COUNT(*) FROM topic_progress p JOIN topics t ON t.id = p.topic_id JOIN sections s ON s.id = t.section_id
               WHERE p.user_id = u.id AND s.course_id = co.id AND p.completed = 1) AS topics_completed,
            (SELECT COALESCE(SUM(p.watched_seconds), 0) FROM topic_progress p JOIN topics t ON t.id = p.topic_id JOIN sections s ON s.id = t.section_id
               WHERE p.user_id = u.id AND s.course_id = co.id) AS watched_seconds,
            (SELECT MIN(p.started_at) FROM topic_progress p JOIN topics t ON t.id = p.topic_id JOIN sections s ON s.id = t.section_id
               WHERE p.user_id = u.id AND s.course_id = co.id) AS first_activity,
            (SELECT MAX(p.last_heartbeat_at) FROM topic_progress p JOIN topics t ON t.id = p.topic_id JOIN sections s ON s.id = t.section_id
               WHERE p.user_id = u.id AND s.course_id = co.id) AS last_activity,
            (SELECT MAX(l.created_at) FROM activity_log l WHERE l.user_id = u.id AND l.event = 'giris') AS last_login
       FROM assignments a
       JOIN users u ON u.id = a.user_id
       JOIN courses co ON co.id = a.course_id
       LEFT JOIN companies c ON c.id = u.company_id
      ORDER BY co.title COLLATE NOCASE, u.full_name COLLATE NOCASE`);
  return json({
    rows: rows.map((r) => ({
      ...r, watched_seconds: Math.round(r.watched_seconds),
      percent: r.topics_total ? Math.round((r.topics_completed * 100) / r.topics_total) : 0,
    })),
  });
}

async function activityReport(ctx) {
  await requireAdmin(ctx);
  const userId = parseId(ctx.url.searchParams.get('user_id'), 'Kullanıcı');
  const courseId = ctx.url.searchParams.get('course_id');
  const cid = courseId ? parseId(courseId, 'Eğitim') : null;
  // Eğitime özel olaylar + eğitimden bağımsız giriş/çıkış olayları
  const rows = await all(ctx.env,
    `SELECT l.id, l.event, l.detail, l.created_at, l.topic_id, t.title AS topic_title
       FROM activity_log l LEFT JOIN topics t ON t.id = l.topic_id
      WHERE l.user_id = ? AND (? IS NULL OR l.course_id = ? OR l.course_id IS NULL)
      ORDER BY l.created_at DESC, l.id DESC LIMIT 1000`, userId, cid, cid);
  const user = await one(ctx.env, 'SELECT id, full_name, username FROM users WHERE id = ?', userId);
  if (!user) throw new HttpError(404, 'Kullanıcı bulunamadı.');
  const answers = await all(ctx.env,
    `SELECT a.answered_at, a.is_correct, c.at_second, c.question, t.title AS topic_title
       FROM checkpoint_answers a JOIN checkpoints c ON c.id = a.checkpoint_id JOIN topics t ON t.id = c.topic_id
        JOIN sections s ON s.id = t.section_id
      WHERE a.user_id = ? AND (? IS NULL OR s.course_id = ?) ORDER BY a.answered_at DESC LIMIT 1000`, userId, cid, cid);
  return json({ user, events: rows, answers });
}

export function progressRoutes(add) {
  add('GET', '/api/my/topics/:id', getTopic);
  add('POST', '/api/my/topics/:id/heartbeat', heartbeat);
  add('POST', '/api/my/topics/:id/event', clientEvent);
  add('POST', '/api/my/topics/:id/complete', completeTextTopic);
  add('POST', '/api/my/checkpoints/:id/answer', answerCheckpoint);

  add('GET', '/api/admin/topics/:id/checkpoints', listCheckpoints);
  add('POST', '/api/admin/topics/:id/checkpoints', createCheckpoint);
  add('PUT', '/api/admin/checkpoints/:id', updateCheckpoint);
  add('DELETE', '/api/admin/checkpoints/:id', deleteCheckpoint);

  add('GET', '/api/admin/reports/progress', progressReport);
  add('GET', '/api/admin/reports/activity', activityReport);
}
