// Veritabanı şeması. Tablolar yoksa ilk istekte otomatik oluşturulur.
// Not: Mevzuat gereği eğitim kayıtları saklanmak zorunda olduğundan kullanıcılar
// silinmez, yalnızca pasife alınır (bkz. users.active).

export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS companies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    hazard_class TEXT NOT NULL DEFAULT 'az_tehlikeli'
      CHECK (hazard_class IN ('az_tehlikeli','tehlikeli','cok_tehlikeli')),
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','learner')),
    tc_no TEXT,
    job_title TEXT,
    company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS login_attempts (
    key TEXT PRIMARY KEY,
    fails INTEGER NOT NULL,
    locked_until INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS courses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    position INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    assigned_at INTEGER NOT NULL,
    UNIQUE (user_id, course_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sections_course ON sections(course_id, position)`,
  `CREATE INDEX IF NOT EXISTS idx_topics_section ON topics(section_id, position)`,
  `CREATE INDEX IF NOT EXISTS idx_assign_user ON assignments(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_assign_course ON assignments(course_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
];

let ready = null;

export function ensureSchema(db) {
  if (!ready) {
    ready = db
      .batch(SCHEMA_STATEMENTS.map((s) => db.prepare(s)))
      .catch((e) => {
        ready = null; // bir sonraki istekte tekrar dene
        throw e;
      });
  }
  return ready;
}
