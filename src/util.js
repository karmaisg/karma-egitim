// Ortak yardımcılar: hata sınıfı, JSON yanıtı, doğrulama, şifre/oturum güvenliği.

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

// ---------- Doğrulama ----------

export function reqStr(v, label, { min = 1, max = 200 } = {}) {
  if (typeof v !== 'string') throw new HttpError(400, `${label} gerekli.`);
  const s = v.trim();
  if (s.length < min) throw new HttpError(400, `${label} gerekli.`);
  if (s.length > max) throw new HttpError(400, `${label} en fazla ${max} karakter olabilir.`);
  return s;
}

export function optStr(v, label, max = 200) {
  if (v === null || v === undefined || v === '') return null;
  return reqStr(v, label, { max });
}

export function textBlock(v, label, max = 20000) {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'string') throw new HttpError(400, `${label} metin olmalı.`);
  if (v.length > max) throw new HttpError(400, `${label} en fazla ${max} karakter olabilir.`);
  return v;
}

export function parseId(v, label = 'Kayıt') {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${label} numarası geçersiz.`);
  return n;
}

export function username(v) {
  const s = reqStr(v, 'Kullanıcı adı', { min: 3, max: 40 }).toLowerCase();
  if (!/^[a-z0-9._-]+$/.test(s)) {
    throw new HttpError(400, 'Kullanıcı adı yalnızca küçük harf (a-z, Türkçe karakter hariç), rakam, nokta, tire ve alt çizgi içerebilir.');
  }
  return s;
}

export function tcNo(v) {
  const s = optStr(v, 'T.C. kimlik no', 11);
  if (s === null) return null;
  if (!/^[1-9][0-9]{10}$/.test(s)) throw new HttpError(400, 'T.C. kimlik no 11 haneli olmalı ve 0 ile başlamamalı.');
  return s;
}

export function checkPasswordStrength(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw new HttpError(400, 'Şifre en az 8 karakter olmalı.');
  if (pw.length > 100) throw new HttpError(400, 'Şifre en fazla 100 karakter olabilir.');
  return pw;
}

// ---------- Şifre ve oturum güvenliği (WebCrypto) ----------

const enc = new TextEncoder();
const PBKDF2_ITERATIONS = 100000; // Cloudflare Workers üst sınırı

function toB64(buf) {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(s) {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toB64(salt)}$${toB64(bits)}`;
}

export function timingSafeEqual(a, b) {
  const x = a instanceof Uint8Array ? a : enc.encode(String(a));
  const y = b instanceof Uint8Array ? b : enc.encode(String(b));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1000 || iterations > PBKDF2_ITERATIONS) return false;
  const bits = await pbkdf2(password, fromB64(parts[2]), iterations);
  return timingSafeEqual(new Uint8Array(bits), fromB64(parts[3]));
}

let dummyHash = null;
// Kullanıcı bulunamasa bile aynı süreyi harcamak için (kullanıcı adı tahmin saldırılarına karşı).
export function getDummyHash() {
  if (!dummyHash) dummyHash = hashPassword('dummy-password-for-timing');
  return dummyHash;
}

export function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Karıştırılabilen karakterler (0/O, 1/l/I) olmadan okunaklı şifre üretir.
const PW_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function generatePassword(length = 10) {
  const out = [];
  const limit = 256 - (256 % PW_ALPHABET.length);
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const b of bytes) {
      if (b < limit && out.length < length) out.push(PW_ALPHABET[b % PW_ALPHABET.length]);
    }
  }
  return out.join('');
}

export function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
