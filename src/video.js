// Video yönetimi: yönetici yüklemesi (R2 çok parçalı) ve yetkili katılımcıya akıtma (Range destekli).
// Videolar herkese açık bir adreste durmaz; yalnızca giriş yapmış ve eğitime atanmış kullanıcıya akar.

import { HttpError, json, parseId, randomToken } from './util.js';
import { one, run, requireAdmin, requireUser } from './core.js';

const MAX_VIDEO_BYTES = 3 * 1024 * 1024 * 1024; // 3 GiB
const MAX_PART_BYTES = 32 * 1024 * 1024;        // tek istekte en fazla 32 MiB (Workers sınırı 100 MB)
const OPEN_RANGE_CHUNK = 8 * 1024 * 1024;       // "bytes=0-" isteklerinde tek seferde en fazla 8 MiB döner
const ALLOWED_TYPES = ['video/mp4', 'video/webm'];

function bucket(env) {
  if (!env.VIDEOS) throw new HttpError(503, 'Video depolama (R2) yapılandırılmamış. wrangler.jsonc içindeki r2_buckets ayarını kontrol edin.');
  return env.VIDEOS;
}

export async function deleteVideoObjects(env, keys) {
  if (!env.VIDEOS || !keys.length) return;
  try { await env.VIDEOS.delete(keys); } catch (e) { console.error('Video silinemedi:', e); }
}

async function topicForUpload(env, id) {
  const t = await one(env, 'SELECT id, video_key FROM topics WHERE id = ?', id);
  if (!t) throw new HttpError(404, 'Konu bulunamadı.');
  const used = await one(env, 'SELECT COUNT(*) AS n FROM topic_progress WHERE topic_id = ?', id);
  if (used.n > 0) throw new HttpError(409, 'Bu konuyu izleyen katılımcılar var. Kayıtların tutarlılığı için videosu değiştirilemez veya silinemez.');
  return t;
}

// ---------- Yönetici: yükleme ----------
async function startUpload(ctx) {
  await requireAdmin(ctx);
  const id = parseId(ctx.params.id, 'Konu');
  await topicForUpload(ctx.env, id);
  const b = await ctx.body();
  const type = String(b.type || '');
  if (!ALLOWED_TYPES.includes(type)) throw new HttpError(400, 'Yalnızca MP4 veya WebM video yüklenebilir.');
  const size = Number(b.size);
  if (!Number.isFinite(size) || size <= 0 || size > MAX_VIDEO_BYTES) throw new HttpError(400, 'Video boyutu en fazla 3 GB olabilir.');
  const key = `topics/${id}/${randomToken().slice(0, 24)}`;
  const mpu = await bucket(ctx.env).createMultipartUpload(key, { httpMetadata: { contentType: type } });
  return json({ key, upload_id: mpu.uploadId });
}

async function uploadPart(ctx) {
  await requireAdmin(ctx);
  const id = parseId(ctx.params.id, 'Konu');
  const key = ctx.url.searchParams.get('key') || '';
  const uploadId = ctx.url.searchParams.get('upload_id') || '';
  const n = Number(ctx.url.searchParams.get('n'));
  if (!key.startsWith(`topics/${id}/`) || !uploadId) throw new HttpError(400, 'Yükleme bilgisi geçersiz.');
  if (!Number.isInteger(n) || n < 1 || n > 10000) throw new HttpError(400, 'Parça numarası geçersiz.');
  const declared = Number(ctx.request.headers.get('content-length'));
  if (declared > MAX_PART_BYTES) throw new HttpError(413, 'Parça çok büyük.');
  const buf = await ctx.request.arrayBuffer();
  if (buf.byteLength === 0 || buf.byteLength > MAX_PART_BYTES) throw new HttpError(400, 'Parça boyutu geçersiz.');
  const part = await bucket(ctx.env).resumeMultipartUpload(key, uploadId).uploadPart(n, buf);
  return json({ partNumber: part.partNumber, etag: part.etag });
}

async function completeUpload(ctx) {
  await requireAdmin(ctx);
  const id = parseId(ctx.params.id, 'Konu');
  const topic = await topicForUpload(ctx.env, id);
  const b = await ctx.body();
  const key = String(b.key || '');
  if (!key.startsWith(`topics/${id}/`) || !b.upload_id) throw new HttpError(400, 'Yükleme bilgisi geçersiz.');
  if (!ALLOWED_TYPES.includes(b.type)) throw new HttpError(400, 'Video türü geçersiz.');
  const duration = Math.round(Number(b.duration));
  if (!Number.isFinite(duration) || duration < 1 || duration > 6 * 3600) throw new HttpError(400, 'Video süresi okunamadı.');
  if (!Array.isArray(b.parts) || b.parts.length === 0 || b.parts.length > 10000) throw new HttpError(400, 'Parça listesi geçersiz.');
  const parts = b.parts.map((p) => ({ partNumber: Number(p.partNumber), etag: String(p.etag) }));
  const obj = await bucket(ctx.env).resumeMultipartUpload(key, String(b.upload_id)).complete(parts);
  const name = String(b.name || 'video').slice(0, 200);
  await run(ctx.env,
    'UPDATE topics SET video_key = ?, video_name = ?, video_type = ?, video_size = ?, video_duration = ? WHERE id = ?',
    key, name, b.type, obj.size, duration, id);
  if (topic.video_key && topic.video_key !== key) await deleteVideoObjects(ctx.env, [topic.video_key]);
  return json({ ok: true, size: obj.size, duration });
}

async function removeVideo(ctx) {
  await requireAdmin(ctx);
  const id = parseId(ctx.params.id, 'Konu');
  const t = await topicForUpload(ctx.env, id);
  await run(ctx.env, 'UPDATE topics SET video_key = NULL, video_name = NULL, video_type = NULL, video_size = NULL, video_duration = NULL WHERE id = ?', id);
  if (t.video_key) await deleteVideoObjects(ctx.env, [t.video_key]);
  return json({ ok: true });
}

// ---------- Akıtma ----------
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start; let end;
  if (m[1] === '') { // son N bayt
    const n = Number(m[2]);
    if (n === 0) return 'bad';
    start = Math.max(0, size - n); end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? Math.min(size - 1, start + OPEN_RANGE_CHUNK - 1) : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'bad';
  return { start, end };
}

async function streamVideo(ctx) {
  const u = await requireUser(ctx);
  const topicId = parseId(ctx.params.id, 'Konu');
  const t = await one(ctx.env,
    `SELECT t.video_key, t.video_type, t.video_size, s.course_id
       FROM topics t JOIN sections s ON s.id = t.section_id WHERE t.id = ?`, topicId);
  if (!t || !t.video_key) throw new HttpError(404, 'Video bulunamadı.');
  if (u.role !== 'admin') {
    const ok = await one(ctx.env, 'SELECT id FROM assignments WHERE user_id = ? AND course_id = ?', u.id, t.course_id);
    if (!ok) throw new HttpError(404, 'Video bulunamadı.');
  }
  const size = t.video_size;
  const base = {
    'content-type': t.video_type || 'video/mp4',
    'accept-ranges': 'bytes',
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'content-disposition': 'inline',
  };
  const rangeHeader = ctx.request.headers.get('range');
  const range = rangeHeader ? parseRange(rangeHeader, size) : null;
  if (range === 'bad') return new Response(null, { status: 416, headers: { ...base, 'content-range': `bytes */${size}` } });
  if (!range) {
    const obj = await bucket(ctx.env).get(t.video_key);
    if (!obj) throw new HttpError(404, 'Video bulunamadı.');
    return new Response(obj.body, { status: 200, headers: { ...base, 'content-length': String(size) } });
  }
  const length = range.end - range.start + 1;
  const obj = await bucket(ctx.env).get(t.video_key, { range: { offset: range.start, length } });
  if (!obj) throw new HttpError(404, 'Video bulunamadı.');
  return new Response(obj.body, {
    status: 206,
    headers: { ...base, 'content-range': `bytes ${range.start}-${range.end}/${size}`, 'content-length': String(length) },
  });
}

export function videoRoutes(add) {
  add('POST', '/api/admin/topics/:id/video/start', startUpload);
  add('PUT', '/api/admin/topics/:id/video/part', uploadPart, { raw: true });
  add('POST', '/api/admin/topics/:id/video/complete', completeUpload);
  add('DELETE', '/api/admin/topics/:id/video', removeVideo);
  add('GET', '/api/my/topics/:id/video', streamVideo);
}
