// KVKK aydınlatma metni onayı: katılımcı, eğitime başlamadan önce metni okuduğunu onaylar; kayıt altına alınır.
import { one, all, run, requireUser, requireAdmin, logEvent } from './core.js';
import { HttpError, json, sha256Hex } from './util.js';
import { CONSENT_VERSION, CONSENT_TITLE, CONSENT_SUBTITLE, CONSENT_BLOCKS } from './consent_text.js';

let hashCache;
export async function consentHash() {
  hashCache ??= await sha256Hex(JSON.stringify([CONSENT_VERSION, CONSENT_TITLE, CONSENT_SUBTITLE, CONSENT_BLOCKS]));
  return hashCache;
}

export const getConsent = (env, userId) =>
  one(env, 'SELECT accepted_at, text_hash FROM consents WHERE user_id = ? AND version = ?', userId, CONSENT_VERSION);

// Katılımcı API'lerinin (/api/my/*) önünde çalışır: onay yoksa 403 + code.
export async function enforceConsent(ctx, user) {
  if (!user || user.role !== 'learner') return;
  if (await getConsent(ctx.env, user.id)) return;
  throw Object.assign(new HttpError(403, 'Eğitime başlamadan önce aydınlatma metnini onaylamanız gerekir.'), { code: 'consent_required' });
}

async function myConsent(ctx) {
  const u = await requireUser(ctx);
  const c = await getConsent(ctx.env, u.id);
  return json({
    version: CONSENT_VERSION, title: CONSENT_TITLE, subtitle: CONSENT_SUBTITLE, blocks: CONSENT_BLOCKS,
    accepted: !!c, accepted_at: c ? c.accepted_at : null,
  });
}

async function acceptConsent(ctx) {
  const u = await requireUser(ctx);
  const b = await ctx.body();
  if (b.accept !== true) throw new HttpError(400, 'Devam etmek için metni okuyup onaylamanız gerekir.');
  const ip = (ctx.request.headers.get('cf-connecting-ip') || 'local').slice(0, 64);
  const ua = (ctx.request.headers.get('user-agent') || '').slice(0, 300);
  const r = await run(ctx.env,
    `INSERT OR IGNORE INTO consents (user_id, version, text_hash, accepted_at, ip, user_agent) VALUES (?,?,?,?,?,?)`,
    u.id, CONSENT_VERSION, await consentHash(), Date.now(), ip, ua);
  if (r.meta?.changes) await logEvent(ctx.env, u.id, 'aydinlatma_onayi', { detail: CONSENT_VERSION });
  const c = await getConsent(ctx.env, u.id);
  return json({ ok: true, accepted_at: c.accepted_at });
}

async function listConsents(ctx) {
  await requireAdmin(ctx);
  const rows = await all(ctx.env,
    `SELECT u.id AS user_id, u.full_name, u.username, co.name AS company,
            c.version, c.accepted_at, c.ip, c.user_agent, c.text_hash
       FROM users u
       LEFT JOIN companies co ON co.id = u.company_id
       LEFT JOIN consents c ON c.user_id = u.id AND c.version = ?
      WHERE u.role = 'learner'
      ORDER BY (c.accepted_at IS NULL) DESC, u.full_name COLLATE NOCASE`, CONSENT_VERSION);
  return json({ version: CONSENT_VERSION, consents: rows });
}

export function consentRoutes(add) {
  add('GET', '/api/my/consent', myConsent);
  add('POST', '/api/my/consent', acceptConsent);
  add('GET', '/api/admin/consents', listConsents);
}
