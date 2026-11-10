// Sınavlar (Yönetmelik md. 16): ön test (16/1), konu sınavları ve eğitim sonu sınavı (16/2).
// Başarı: 100 üzerinden en az 60 puan; ilk sınavdan sonra en fazla 2 hak daha (toplam 3 deneme) (16/3).
// Her denemede soru ve seçenek sırası karıştırılır; sorular, seçenekler ve cevaplar kayıt altına alınır.

import { HttpError, json, reqStr, parseId } from './util.js';
import { one, all, run, requireAdmin, requireUser, logEvent } from './core.js';

const PASS_SCORE = 60;
const MAX_ATTEMPTS = 3;
const KINDS = ['on_test', 'konu', 'final'];

function shuffle(arr) {
  const a = [...arr];
  const buf = new Uint32Array(a.length);
  crypto.getRandomValues(buf);
  for (let i = a.length - 1; i > 0; i--) {
    const j = buf[i] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function validateQuestion(b) {
  const question = reqStr(b.question, 'Soru', { max: 500 });
  if (!Array.isArray(b.options) || b.options.length < 2 || b.options.length > 5) throw new HttpError(400, 'Soru için 2 ile 5 arasında seçenek girin.');
  const options = b.options.map((o) => reqStr(o, 'Seçenek', { max: 300 }));
  if (new Set(options.map((o) => o.toLocaleLowerCase('tr'))).size !== options.length) throw new HttpError(400, 'Seçenekler birbirinden farklı olmalı.');
  const correct = Number(b.correct);
  if (!Number.isInteger(correct) || correct < 0 || correct >= options.length) throw new HttpError(400, 'Doğru seçenek geçersiz.');
  return { question, options, correct };
}

// ---------- Durum hesabı ----------
async function examAttemptStats(env, userId, examId, maxAttempts) {
  const rows = await all(env,
    'SELECT id, finished_at, score, passed, started_at FROM exam_attempts WHERE user_id = ? AND exam_id = ? ORDER BY id', userId, examId);
  const grant = await one(env, 'SELECT MAX(attempts_at_grant) AS n FROM exam_grants WHERE user_id = ? AND exam_id = ?', userId, examId);
  const used = Math.max(0, rows.length - (grant?.n || 0));
  const finished = rows.filter((r) => r.finished_at);
  const open = rows.find((r) => !r.finished_at) || null;
  return {
    rows, used, open,
    left: Math.max(0, maxAttempts - used),
    passed: finished.some((r) => r.passed === 1),
    best: finished.length ? Math.max(...finished.map((r) => r.score)) : null,
  };
}

// Sınavın bu katılımcı için açık olup olmadığını belirler.
async function contentGate(env, userId, exam) {
  if (exam.kind === 'on_test') return null;
  if (exam.kind === 'konu') {
    const p = await one(env, 'SELECT completed FROM topic_progress WHERE user_id = ? AND topic_id = ?', userId, exam.topic_id);
    return p?.completed ? null : 'Önce bu konuyu tamamlamalısınız.';
  }
  const open = await one(env,
    `SELECT COUNT(*) AS n FROM topics t JOIN sections s ON s.id = t.section_id
      WHERE s.course_id = ? AND NOT EXISTS (SELECT 1 FROM topic_progress p WHERE p.topic_id = t.id AND p.user_id = ? AND p.completed = 1)`,
    exam.course_id, userId);
  if (open.n > 0) return 'Önce eğitimin tüm konularını tamamlamalısınız.';
  const pending = await all(env,
    `SELECT e.id, e.max_attempts FROM exams e
      WHERE e.course_id = ? AND e.kind = 'konu' AND EXISTS (SELECT 1 FROM exam_questions q WHERE q.exam_id = e.id AND q.active = 1)`, exam.course_id);
  for (const e of pending) {
    if (!(await examAttemptStats(env, userId, e.id, e.max_attempts)).passed) return 'Önce konu sınavlarını başarıyla geçmelisiniz.';
  }
  return null;
}

async function learnerExamView(env, userId, exam) {
  const st = await examAttemptStats(env, userId, exam.id, exam.max_attempts);
  const reason = await contentGate(env, userId, exam);
  let state;
  if (st.passed) state = 'gecti';
  else if (reason) state = 'kilitli';
  else if (st.open) state = 'devam';
  else if (st.left <= 0) state = 'hak_doldu';
  else state = 'hazir';
  return {
    id: exam.id, kind: exam.kind, topic_id: exam.topic_id, title: exam.title,
    question_count: exam.question_count, pass_score: exam.pass_score, max_attempts: exam.max_attempts,
    state, reason, attempts_used: st.used, attempts_left: st.left, best_score: st.best,
    attempts: st.rows.filter((r) => r.finished_at).slice(-10).map((r) => ({ id: r.id, finished_at: r.finished_at, score: r.score, passed: r.passed === null ? null : !!r.passed })),
  };
}

const examsWithCounts = (env, whereSql, ...params) => all(env,
  `SELECT e.*, (SELECT COUNT(*) FROM exam_questions q WHERE q.exam_id = e.id AND q.active = 1) AS question_count,
          (SELECT COUNT(*) FROM exam_questions q WHERE q.exam_id = e.id) AS total_questions,
          (SELECT COUNT(*) FROM exam_attempts a WHERE a.exam_id = e.id) AS attempt_count
     FROM exams e WHERE ${whereSql}
    ORDER BY CASE e.kind WHEN 'on_test' THEN 0 WHEN 'konu' THEN 1 ELSE 2 END, e.id`, ...params);

// ---------- Katılımcı ----------
async function assignedExam(ctx, examId) {
  const u = await requireUser(ctx);
  const exam = (await examsWithCounts(ctx.env, 'e.id = ?', examId))[0];
  if (!exam) throw new HttpError(404, 'Sınav bulunamadı.');
  const ok = await one(ctx.env, 'SELECT id FROM assignments WHERE user_id = ? AND course_id = ?', u.id, exam.course_id);
  if (!ok) throw new HttpError(404, 'Sınav bulunamadı.');
  return { u, exam };
}

async function myCourseExams(ctx) {
  const u = await requireUser(ctx);
  const courseId = parseId(ctx.params.id, 'Eğitim');
  const ok = await one(ctx.env, 'SELECT id FROM assignments WHERE user_id = ? AND course_id = ?', u.id, courseId);
  if (!ok) throw new HttpError(404, 'Bu eğitim size atanmamış.');
  const exams = (await examsWithCounts(ctx.env, 'e.course_id = ? AND (SELECT COUNT(*) FROM exam_questions q WHERE q.exam_id = e.id AND q.active = 1) > 0', courseId));
  const out = [];
  for (const e of exams) out.push(await learnerExamView(ctx.env, u.id, e));
  return json({ exams: out });
}

function publicQuestions(plan, qmap) {
  return plan.map((p) => {
    const q = qmap.get(p.q);
    const opts = JSON.parse(q.options);
    return { id: q.id, question: q.question, options: p.perm.map((i) => opts[i]) };
  });
}

async function startExam(ctx) {
  const { u, exam } = await assignedExam(ctx, parseId(ctx.params.id, 'Sınav'));
  if (exam.question_count < 1) throw new HttpError(409, 'Bu sınavda henüz soru yok.');
  const view = await learnerExamView(ctx.env, u.id, exam);
  if (view.state === 'gecti') throw new HttpError(409, 'Bu sınavı zaten başarıyla geçtiniz.');
  if (view.state === 'kilitli') throw new HttpError(403, view.reason);
  if (view.state === 'hak_doldu') throw new HttpError(403, 'Bu sınav için deneme hakkınız doldu. Eğitime yeniden katılmanız gerekir; lütfen eğitim yöneticinizle iletişime geçin.');

  const st = await examAttemptStats(ctx.env, u.id, exam.id, exam.max_attempts);
  let attempt = st.open ? await one(ctx.env, 'SELECT * FROM exam_attempts WHERE id = ?', st.open.id) : null;
  if (!attempt) {
    const qs = await all(ctx.env, 'SELECT id, options FROM exam_questions WHERE exam_id = ? AND active = 1', exam.id);
    const plan = shuffle(qs).map((q) => ({ q: q.id, perm: shuffle(JSON.parse(q.options).map((_, i) => i)) }));
    const res = await run(ctx.env, 'INSERT INTO exam_attempts (exam_id, user_id, started_at, total, plan) VALUES (?,?,?,?,?)',
      exam.id, u.id, Date.now(), plan.length, JSON.stringify(plan));
    const id = res.meta.last_row_id;
    // Aynı anda gelen çifte istekle hak aşımını engelle
    const after = await examAttemptStats(ctx.env, u.id, exam.id, exam.max_attempts);
    if (after.used > exam.max_attempts) {
      await run(ctx.env, 'DELETE FROM exam_attempts WHERE id = ?', id);
      throw new HttpError(409, 'Deneme hakkınız doldu.');
    }
    attempt = await one(ctx.env, 'SELECT * FROM exam_attempts WHERE id = ?', id);
    await logEvent(ctx.env, u.id, 'sinav_basladi', { topicId: exam.topic_id, courseId: exam.course_id, detail: `${exam.title} — ${after.used}. deneme` });
  }
  const plan = JSON.parse(attempt.plan);
  const qrows = await all(ctx.env, `SELECT id, question, options FROM exam_questions WHERE id IN (${plan.map(() => '?').join(',')})`, ...plan.map((p) => p.q));
  return json({
    attempt_id: attempt.id,
    exam: { id: exam.id, title: exam.title, kind: exam.kind, pass_score: exam.pass_score },
    questions: publicQuestions(plan, new Map(qrows.map((q) => [q.id, q]))),
  });
}

async function submitAttempt(ctx) {
  const u = await requireUser(ctx);
  const id = parseId(ctx.params.id, 'Deneme');
  const attempt = await one(ctx.env, 'SELECT * FROM exam_attempts WHERE id = ? AND user_id = ?', id, u.id);
  if (!attempt) throw new HttpError(404, 'Deneme bulunamadı.');
  if (attempt.finished_at) throw new HttpError(409, 'Bu sınav zaten teslim edilmiş.');
  const exam = await one(ctx.env, 'SELECT * FROM exams WHERE id = ?', attempt.exam_id);
  const b = await ctx.body();
  if (!Array.isArray(b.answers)) throw new HttpError(400, 'Cevaplar geçersiz.');
  const given = new Map();
  for (const a of b.answers) {
    const qid = Number(a?.question_id);
    if (!Number.isInteger(qid)) continue;
    given.set(qid, a.selected === null || a.selected === undefined ? null : Number(a.selected));
  }

  const plan = JSON.parse(attempt.plan);
  const qrows = await all(ctx.env, `SELECT id, question, options, correct FROM exam_questions WHERE id IN (${plan.map(() => '?').join(',')})`, ...plan.map((p) => p.q));
  const qmap = new Map(qrows.map((q) => [q.id, q]));
  const stmts = [];
  const results = [];
  let correctCount = 0;
  for (const p of plan) {
    const q = qmap.get(p.q);
    const opts = JSON.parse(q.options);
    const shown = p.perm.map((i) => opts[i]);
    const correctIndex = p.perm.indexOf(q.correct);
    let sel = given.has(q.id) ? given.get(q.id) : null;
    if (sel !== null && !(Number.isInteger(sel) && sel >= 0 && sel < shown.length)) sel = null;
    const ok = sel !== null && sel === correctIndex;
    if (ok) correctCount++;
    results.push({ question_id: q.id, is_correct: ok });
    stmts.push(ctx.env.DB.prepare(
      'INSERT INTO exam_answers (attempt_id, question_id, question_text, options, correct_index, selected, is_correct) VALUES (?,?,?,?,?,?,?)')
      .bind(id, q.id, q.question, JSON.stringify(shown), correctIndex, sel, ok ? 1 : 0));
  }
  const score = plan.length ? Math.round((correctCount * 100) / plan.length) : 0;
  const passed = exam.kind === 'on_test' ? null : (score >= exam.pass_score ? 1 : 0);
  // Çifte teslimi engelle: yalnızca henüz bitmemiş deneme kapatılır.
  const upd = await run(ctx.env, 'UPDATE exam_attempts SET finished_at = ?, correct_count = ?, score = ?, passed = ? WHERE id = ? AND finished_at IS NULL',
    Date.now(), correctCount, score, passed, id);
  if (!upd.meta.changes) throw new HttpError(409, 'Bu sınav zaten teslim edilmiş.');
  await ctx.env.DB.batch(stmts);
  await logEvent(ctx.env, u.id, 'sinav_bitti', { topicId: exam.topic_id, courseId: exam.course_id, detail: `${exam.title}: ${score} puan (${correctCount}/${plan.length})${passed === 1 ? ' — başarılı' : passed === 0 ? ' — başarısız' : ''}` });

  const view = await learnerExamView(ctx.env, u.id, { ...exam, question_count: plan.length });
  return json({ score, passed: passed === null ? null : !!passed, correct_count: correctCount, total: plan.length, pass_score: exam.pass_score, results, attempts_left: view.attempts_left, state: view.state });
}

// ---------- Yönetici: sınav ve soru yönetimi ----------
async function listCourseExams(ctx) {
  await requireAdmin(ctx);
  const courseId = parseId(ctx.params.id, 'Eğitim');
  return json({ exams: await examsWithCounts(ctx.env, 'e.course_id = ?', courseId) });
}

async function createExam(ctx) {
  await requireAdmin(ctx);
  const courseId = parseId(ctx.params.id, 'Eğitim');
  if (!(await one(ctx.env, 'SELECT id FROM courses WHERE id = ?', courseId))) throw new HttpError(404, 'Eğitim bulunamadı.');
  const b = await ctx.body();
  if (!KINDS.includes(b.kind)) throw new HttpError(400, 'Sınav türü geçersiz.');
  let topicId = null;
  let title;
  if (b.kind === 'konu') {
    topicId = parseId(b.topic_id, 'Konu');
    const t = await one(ctx.env, 'SELECT t.id, t.title FROM topics t JOIN sections s ON s.id = t.section_id WHERE t.id = ? AND s.course_id = ?', topicId, courseId);
    if (!t) throw new HttpError(404, 'Konu bu eğitimde bulunamadı.');
    title = `${t.title} — konu sınavı`;
  } else {
    title = b.kind === 'final' ? 'Eğitim sonu sınavı' : 'Ön test (seviye tespiti)';
  }
  try {
    const res = await run(ctx.env, 'INSERT INTO exams (course_id, topic_id, kind, title, pass_score, max_attempts, created_at) VALUES (?,?,?,?,?,?,?)',
      courseId, topicId, b.kind, title, PASS_SCORE, b.kind === 'on_test' ? 1 : MAX_ATTEMPTS, Date.now());
    return json({ id: res.meta.last_row_id }, 201);
  } catch (e) {
    if (/UNIQUE/i.test(String(e.message))) throw new HttpError(409, 'Bu sınav zaten oluşturulmuş.');
    throw e;
  }
}

async function deleteExam(ctx) {
  await requireAdmin(ctx);
  const id = parseId(ctx.params.id, 'Sınav');
  const n = await one(ctx.env, 'SELECT COUNT(*) AS n FROM exam_attempts WHERE exam_id = ?', id);
  if (n.n > 0) throw new HttpError(409, 'Bu sınava giren katılımcılar var. Kayıtların korunması için silinemez; soruları pasife alabilirsiniz.');
  await run(ctx.env, 'DELETE FROM exams WHERE id = ?', id);
  return json({ ok: true });
}

async function listQuestions(ctx) {
  await requireAdmin(ctx);
  const id = parseId(ctx.params.id, 'Sınav');
  const exam = (await examsWithCounts(ctx.env, 'e.id = ?', id))[0];
  if (!exam) throw new HttpError(404, 'Sınav bulunamadı.');
  const qs = await all(ctx.env, 'SELECT id, question, options, correct, active FROM exam_questions WHERE exam_id = ? ORDER BY position, id', id);
  return json({ exam, locked: exam.attempt_count > 0, questions: qs.map((q) => ({ ...q, options: JSON.parse(q.options), active: !!q.active })) });
}

async function createQuestion(ctx) {
  await requireAdmin(ctx);
  const id = parseId(ctx.params.id, 'Sınav');
  if (!(await one(ctx.env, 'SELECT id FROM exams WHERE id = ?', id))) throw new HttpError(404, 'Sınav bulunamadı.');
  const q = validateQuestion(await ctx.body());
  const pos = await one(ctx.env, 'SELECT COALESCE(MAX(position), 0) + 1 AS p FROM exam_questions WHERE exam_id = ?', id);
  const res = await run(ctx.env, 'INSERT INTO exam_questions (exam_id, question, options, correct, position, created_at) VALUES (?,?,?,?,?,?)',
    id, q.question, JSON.stringify(q.options), q.correct, pos.p, Date.now());
  return json({ id: res.meta.last_row_id }, 201);
}

async function questionExam(ctx) {
  await requireAdmin(ctx);
  const id = parseId(ctx.params.id, 'Soru');
  const q = await one(ctx.env, 'SELECT id, exam_id FROM exam_questions WHERE id = ?', id);
  if (!q) throw new HttpError(404, 'Soru bulunamadı.');
  const n = await one(ctx.env, 'SELECT COUNT(*) AS n FROM exam_attempts WHERE exam_id = ?', q.exam_id);
  return { id, locked: n.n > 0 };
}

async function updateQuestion(ctx) {
  const { id, locked } = await questionExam(ctx);
  if (locked) throw new HttpError(409, 'Bu sınava giren katılımcılar var. Kayıtların tutarlılığı için soru değiştirilemez; pasife alıp yeni soru ekleyebilirsiniz.');
  const q = validateQuestion(await ctx.body());
  await run(ctx.env, 'UPDATE exam_questions SET question = ?, options = ?, correct = ? WHERE id = ?', q.question, JSON.stringify(q.options), q.correct, id);
  return json({ ok: true });
}

async function deleteQuestion(ctx) {
  const { id, locked } = await questionExam(ctx);
  if (locked) throw new HttpError(409, 'Bu sınava giren katılımcılar var. Soru silinemez; pasife alabilirsiniz.');
  await run(ctx.env, 'DELETE FROM exam_questions WHERE id = ?', id);
  return json({ ok: true });
}

async function setQuestionActive(ctx) {
  const { id } = await questionExam(ctx);
  const b = await ctx.body();
  await run(ctx.env, 'UPDATE exam_questions SET active = ? WHERE id = ?', b.active ? 1 : 0, id);
  return json({ ok: true });
}

async function grantAttempts(ctx) {
  const admin = await requireAdmin(ctx);
  const examId = parseId(ctx.params.id, 'Sınav');
  const b = await ctx.body();
  const userId = parseId(b.user_id, 'Katılımcı');
  const exam = await one(ctx.env, 'SELECT * FROM exams WHERE id = ?', examId);
  if (!exam) throw new HttpError(404, 'Sınav bulunamadı.');
  const assigned = await one(ctx.env, 'SELECT id FROM assignments WHERE user_id = ? AND course_id = ?', userId, exam.course_id);
  if (!assigned) throw new HttpError(404, 'Katılımcıya bu eğitim atanmamış.');
  const cnt = await one(ctx.env, 'SELECT COUNT(*) AS n FROM exam_attempts WHERE exam_id = ? AND user_id = ?', examId, userId);
  const note = b.note ? reqStr(b.note, 'Not', { max: 300 }) : null;
  await run(ctx.env, 'INSERT INTO exam_grants (exam_id, user_id, granted_by, attempts_at_grant, note, granted_at) VALUES (?,?,?,?,?,?)',
    examId, userId, admin.id, cnt.n, note, Date.now());
  await logEvent(ctx.env, userId, 'sinav_hakki_verildi', { topicId: exam.topic_id, courseId: exam.course_id, detail: `${exam.title}${note ? ' — ' + note : ''}` });
  return json({ ok: true });
}

// ---------- Yönetici: raporlar ----------
async function examReport(ctx) {
  await requireAdmin(ctx);
  const q = ctx.url.searchParams;
  const courseId = q.get('course_id') ? parseId(q.get('course_id'), 'Eğitim') : null;
  const userId = q.get('user_id') ? parseId(q.get('user_id'), 'Katılımcı') : null;
  const rows = await all(ctx.env,
    `SELECT a.id, a.user_id, u.full_name, u.username, c.name AS company_name, co.id AS course_id, co.title AS course_title,
            e.id AS exam_id, e.title AS exam_title, e.kind, a.started_at, a.finished_at, a.total, a.correct_count, a.score, a.passed,
            (SELECT COUNT(*) FROM exam_attempts b WHERE b.exam_id = a.exam_id AND b.user_id = a.user_id AND b.id <= a.id) AS attempt_no
       FROM exam_attempts a
       JOIN exams e ON e.id = a.exam_id JOIN courses co ON co.id = e.course_id
       JOIN users u ON u.id = a.user_id LEFT JOIN companies c ON c.id = u.company_id
      WHERE (? IS NULL OR co.id = ?) AND (? IS NULL OR u.id = ?)
      ORDER BY a.started_at DESC LIMIT 2000`, courseId, courseId, userId, userId);
  return json({ rows: rows.map((r) => ({ ...r, passed: r.passed === null ? null : !!r.passed })) });
}

async function attemptDetail(ctx) {
  await requireAdmin(ctx);
  const id = parseId(ctx.params.id, 'Deneme');
  const a = await one(ctx.env,
    `SELECT a.id, a.started_at, a.finished_at, a.total, a.correct_count, a.score, a.passed, e.title AS exam_title, e.pass_score,
            u.full_name, u.username
       FROM exam_attempts a JOIN exams e ON e.id = a.exam_id JOIN users u ON u.id = a.user_id WHERE a.id = ?`, id);
  if (!a) throw new HttpError(404, 'Deneme bulunamadı.');
  const answers = await all(ctx.env, 'SELECT question_text, options, correct_index, selected, is_correct FROM exam_answers WHERE attempt_id = ? ORDER BY id', id);
  return json({ attempt: { ...a, passed: a.passed === null ? null : !!a.passed }, answers: answers.map((r) => ({ ...r, options: JSON.parse(r.options), is_correct: !!r.is_correct })) });
}

export function examRoutes(add) {
  add('GET', '/api/my/courses/:id/exams', myCourseExams);
  add('POST', '/api/my/exams/:id/start', startExam);
  add('POST', '/api/my/attempts/:id/submit', submitAttempt);

  add('GET', '/api/admin/courses/:id/exams', listCourseExams);
  add('POST', '/api/admin/courses/:id/exams', createExam);
  add('DELETE', '/api/admin/exams/:id', deleteExam);
  add('GET', '/api/admin/exams/:id/questions', listQuestions);
  add('POST', '/api/admin/exams/:id/questions', createQuestion);
  add('PUT', '/api/admin/exam-questions/:id', updateQuestion);
  add('DELETE', '/api/admin/exam-questions/:id', deleteQuestion);
  add('POST', '/api/admin/exam-questions/:id/active', setQuestionActive);
  add('POST', '/api/admin/exams/:id/grant', grantAttempts);
  add('GET', '/api/admin/reports/exams', examReport);
  add('GET', '/api/admin/attempts/:id', attemptDetail);
}
