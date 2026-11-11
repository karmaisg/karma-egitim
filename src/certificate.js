// Katılım belgesi (Yönetmelik md. 17): uygunluk kontrolü, belge kaydı, PDF indirme, belge ayarları.
import { HttpError, json, reqStr, parseId } from './util.js';
import { one, all, run, requireAdmin, requireUser, logEvent } from './core.js';
import { examAttemptStats } from './exams.js';
import { buildCertificatePdf, loadAssets } from './certificate_pdf.js';

const DEFAULT_ORG = 'KARMA OSGB Eğitim Denetim Danışmanlık Müh. San. ve Tic. Ltd. Şti.';
const TZ_OFFSET_MS = 3 * 3600 * 1000; // Türkiye saati (UTC+3, yaz saati uygulaması yok)
const dayOf = (ms) => new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 10);

// ---------- Ayarlar ----------
async function getOrgTitle(env) {
  const r = await one(env, "SELECT value FROM settings WHERE key = 'org_title'");
  return r?.value || DEFAULT_ORG;
}

async function getSettings(ctx) {
  await requireAdmin(ctx);
  return json({ org_title: await getOrgTitle(ctx.env), default_org_title: DEFAULT_ORG });
}

async function putSettings(ctx) {
  await requireAdmin(ctx);
  const b = await ctx.body();
  const title = reqStr(b.org_title, 'OSGB unvanı', { max: 200 });
  await run(ctx.env, "INSERT INTO settings (key, value) VALUES ('org_title', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", title);
  return json({ ok: true });
}

function parseTrainers(raw) {
  try {
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr.filter((t) => t && typeof t.name === 'string' && t.name.trim()).slice(0, 2).map((t) => ({ name: t.name.trim(), title: String(t.title || '').trim() })) : [];
  } catch { return []; }
}

async function getCourseCert(ctx) {
  await requireAdmin(ctx);
  const id = parseId(ctx.params.id, 'Eğitim');
  const c = await one(ctx.env, 'SELECT cert_hours, cert_in_person, cert_remote, trainers FROM courses WHERE id = ?', id);
  if (!c) throw new HttpError(404, 'Eğitim bulunamadı.');
  return json({ hours: c.cert_hours, in_person: !!c.cert_in_person, remote: !!c.cert_remote, trainers: parseTrainers(c.trainers) });
}

async function putCourseCert(ctx) {
  await requireAdmin(ctx);
  const id = parseId(ctx.params.id, 'Eğitim');
  if (!(await one(ctx.env, 'SELECT id FROM courses WHERE id = ?', id))) throw new HttpError(404, 'Eğitim bulunamadı.');
  const b = await ctx.body();
  const hours = Number(String(b.hours).replace(',', '.'));
  if (!Number.isFinite(hours) || hours <= 0 || hours > 200) throw new HttpError(400, 'Eğitim süresi 0 ile 200 saat arasında olmalı.');
  if (!b.in_person && !b.remote) throw new HttpError(400, 'Eğitimin şeklini seçin (yüz yüze ve/veya uzaktan).');
  const trainers = [];
  for (const t of Array.isArray(b.trainers) ? b.trainers.slice(0, 2) : []) {
    if (!t || (!String(t.name || '').trim() && !String(t.title || '').trim())) continue;
    trainers.push({ name: reqStr(t.name, 'Eğitici adı soyadı', { max: 100 }), title: String(t.title || '').trim().slice(0, 100) });
  }
  await run(ctx.env, 'UPDATE courses SET cert_hours = ?, cert_in_person = ?, cert_remote = ?, trainers = ? WHERE id = ?',
    hours, b.in_person ? 1 : 0, b.remote ? 1 : 0, JSON.stringify(trainers), id);
  return json({ ok: true });
}

// ---------- Uygunluk ----------
// Belge için: tüm konular tamamlanmış ve (varsa) konu sınavları ile eğitim sonu sınavı geçilmiş olmalı.
export async function certificateEligibility(env, userId, courseId) {
  const reasons = [];
  let completedAt = 0;
  const topics = await all(env,
    `SELECT t.id, t.title, p.completed, p.completed_at
       FROM topics t JOIN sections s ON s.id = t.section_id
       LEFT JOIN topic_progress p ON p.topic_id = t.id AND p.user_id = ?
      WHERE s.course_id = ?`, userId, courseId);
  if (topics.length === 0) reasons.push('Bu eğitimde henüz konu bulunmuyor.');
  const open = topics.filter((t) => !t.completed).length;
  if (open) reasons.push(`${open} konu henüz tamamlanmadı.`);
  for (const t of topics) completedAt = Math.max(completedAt, t.completed_at || 0);

  const exams = await all(env,
    `SELECT e.id, e.title, e.max_attempts FROM exams e
      WHERE e.course_id = ? AND e.kind IN ('konu','final') AND EXISTS (SELECT 1 FROM exam_questions q WHERE q.exam_id = e.id AND q.active = 1)`, courseId);
  for (const e of exams) {
    const st = await examAttemptStats(env, userId, e.id, e.max_attempts);
    if (!st.passed) { reasons.push(`"${e.title}" henüz başarıyla geçilmedi.`); continue; }
    const pass = await one(env, 'SELECT MAX(finished_at) AS t FROM exam_attempts WHERE exam_id = ? AND user_id = ? AND passed = 1', e.id, userId);
    completedAt = Math.max(completedAt, pass?.t || 0);
  }
  return { eligible: reasons.length === 0, reasons, completed_at: completedAt || Date.now(), has_final: exams.length > 0 };
}

async function trainingDates(env, userId, courseId, completedAt) {
  const rows = await all(env,
    `SELECT created_at FROM activity_log
      WHERE user_id = ? AND course_id = ? AND event IN ('kontrol_sorusu_dogru','konu_tamamlandi','sinav_bitti')`, userId, courseId);
  const days = new Set(rows.map((r) => dayOf(r.created_at)));
  days.add(dayOf(completedAt));
  return [...days].sort();
}

// ---------- Belge oluşturma ----------
async function buildSnapshot(env, userId, courseId, completedAt) {
  const u = await one(env,
    `SELECT u.full_name, u.job_title, c.name AS company_name, c.employer_1, c.employer_2
       FROM users u LEFT JOIN companies c ON c.id = u.company_id WHERE u.id = ?`, userId);
  const course = await one(env, 'SELECT title, cert_hours, cert_in_person, cert_remote, trainers FROM courses WHERE id = ?', courseId);
  const a = await one(env, 'SELECT training_type FROM assignments WHERE user_id = ? AND course_id = ?', userId, courseId);
  const secs = await all(env, 'SELECT id, title FROM sections WHERE course_id = ? ORDER BY position, id', courseId);
  const topics = await all(env,
    `SELECT t.section_id, t.title, t.video_duration FROM topics t JOIN sections s ON s.id = t.section_id
      WHERE s.course_id = ? ORDER BY t.position, t.id`, courseId);
  return {
    name: u.full_name, job_title: u.job_title || '', company_name: u.company_name || '',
    employers: [u.employer_1, u.employer_2].filter(Boolean),
    org_title: await getOrgTitle(env), course_title: course.title,
    hours: course.cert_hours, in_person: !!course.cert_in_person, remote: !!course.cert_remote,
    trainers: parseTrainers(course.trainers), training_type: a?.training_type === 'tekrar' ? 'tekrar' : 'ilk',
    dates: await trainingDates(env, userId, courseId, completedAt), issued_date: dayOf(completedAt),
    sections: secs.map((s) => ({
      title: s.title,
      topics: topics.filter((t) => t.section_id === s.id).map((t) => ({ title: t.title, minutes: t.video_duration ? Math.max(1, Math.round(t.video_duration / 60)) : 0 })),
    })),
  };
}

async function issueCertificate(env, userId, courseId) {
  const existing = await one(env, 'SELECT id, number, issued_at FROM certificates WHERE user_id = ? AND course_id = ?', userId, courseId);
  if (existing) return { ...existing, created: false };
  const el = await certificateEligibility(env, userId, courseId);
  if (!el.eligible) throw new HttpError(403, 'Katılım belgesi için eğitimi tamamlamanız gerekir: ' + el.reasons.join(' '));
  const snap = await buildSnapshot(env, userId, courseId, el.completed_at);
  const now = Date.now();
  await run(env, 'INSERT OR IGNORE INTO certificates (user_id, course_id, issued_at, snapshot) VALUES (?,?,?,?)', userId, courseId, now, JSON.stringify(snap));
  const row = await one(env, 'SELECT id, number, issued_at FROM certificates WHERE user_id = ? AND course_id = ?', userId, courseId);
  if (!row.number) {
    const number = `KRM-${new Date(row.issued_at + TZ_OFFSET_MS).getUTCFullYear()}-${String(row.id).padStart(6, '0')}`;
    await run(env, 'UPDATE certificates SET number = ? WHERE id = ? AND number IS NULL', number, row.id);
    row.number = number;
    await logEvent(env, userId, 'belge_duzenlendi', { courseId, detail: number });
  }
  return { ...row, created: true };
}

// ---------- PDF ----------
let assetsPromise = null;
function getAssets(ctx) {
  if (!assetsPromise) {
    const origin = new URL(ctx.request.url).origin;
    assetsPromise = loadAssets(async (name) => {
      const res = await ctx.env.ASSETS.fetch(new Request(`${origin}/pdf/${name}`));
      if (!res.ok) throw new HttpError(500, 'Belge dosyaları okunamadı.');
      return new Uint8Array(await res.arrayBuffer());
    }).catch((e) => { assetsPromise = null; throw e; });
  }
  return assetsPromise;
}

async function pdfResponse(ctx, cert) {
  const snap = JSON.parse(cert.snapshot);
  const bytes = buildCertificatePdf({ ...snap, number: cert.number }, await getAssets(ctx));
  return new Response(bytes, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="katilim-belgesi-${cert.number}.pdf"`,
      'cache-control': 'private, no-store',
    },
  });
}

// ---------- Katılımcı ----------
async function assignedCourse(ctx) {
  const u = await requireUser(ctx);
  const courseId = parseId(ctx.params.id, 'Eğitim');
  if (!(await one(ctx.env, 'SELECT id FROM assignments WHERE user_id = ? AND course_id = ?', u.id, courseId))) throw new HttpError(404, 'Bu eğitim size atanmamış.');
  return { u, courseId };
}

async function myCertificateStatus(ctx) {
  const { u, courseId } = await assignedCourse(ctx);
  const cert = await one(ctx.env, 'SELECT number, issued_at FROM certificates WHERE user_id = ? AND course_id = ?', u.id, courseId);
  if (cert) return json({ eligible: true, reasons: [], issued: cert });
  const el = await certificateEligibility(ctx.env, u.id, courseId);
  return json({ eligible: el.eligible, reasons: el.reasons, issued: null });
}

async function myIssueCertificate(ctx) {
  const { u, courseId } = await assignedCourse(ctx);
  const c = await issueCertificate(ctx.env, u.id, courseId);
  return json({ number: c.number, issued_at: c.issued_at }, c.created ? 201 : 200);
}

async function myCertificatePdf(ctx) {
  const { u, courseId } = await assignedCourse(ctx);
  const cert = await one(ctx.env, 'SELECT id, number, snapshot FROM certificates WHERE user_id = ? AND course_id = ?', u.id, courseId);
  if (!cert) throw new HttpError(404, 'Bu eğitim için henüz katılım belgesi düzenlenmemiş.');
  return pdfResponse(ctx, cert);
}

// ---------- Yönetici ----------
async function listCertificates(ctx) {
  await requireAdmin(ctx);
  const rows = await all(ctx.env,
    `SELECT ce.id, ce.number, ce.issued_at, u.full_name, u.username, co.name AS company_name, c.title AS course_title
       FROM certificates ce JOIN users u ON u.id = ce.user_id JOIN courses c ON c.id = ce.course_id
       LEFT JOIN companies co ON co.id = u.company_id ORDER BY ce.issued_at DESC LIMIT 2000`);
  return json({ certificates: rows });
}

async function adminCertificatePdf(ctx) {
  await requireAdmin(ctx);
  const cert = await one(ctx.env, 'SELECT id, number, snapshot FROM certificates WHERE id = ?', parseId(ctx.params.id, 'Belge'));
  if (!cert) throw new HttpError(404, 'Belge bulunamadı.');
  return pdfResponse(ctx, cert);
}

export function certificateRoutes(add) {
  add('GET', '/api/admin/settings', getSettings);
  add('PUT', '/api/admin/settings', putSettings);
  add('GET', '/api/admin/courses/:id/certificate-settings', getCourseCert);
  add('PUT', '/api/admin/courses/:id/certificate-settings', putCourseCert);
  add('GET', '/api/admin/certificates', listCertificates);
  add('GET', '/api/admin/certificates/:id/pdf', adminCertificatePdf);

  add('GET', '/api/my/courses/:id/certificate', myCertificateStatus);
  add('POST', '/api/my/courses/:id/certificate', myIssueCertificate);
  add('GET', '/api/my/courses/:id/certificate.pdf', myCertificatePdf);
}
