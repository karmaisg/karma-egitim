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
  // ---- Aşama 2: katılım takibi ----
  // Video içinde belirli saniyede çıkan kısa kontrol soruları (md. 12/5: katılımı destekleme)
  `CREATE TABLE IF NOT EXISTS checkpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    at_second INTEGER NOT NULL,
    question TEXT NOT NULL,
    options TEXT NOT NULL,
    correct INTEGER NOT NULL
  )`,
  // Katılımcının konu bazlı ilerlemesi (md. 12/4: tamamlama oranı)
  `CREATE TABLE IF NOT EXISTS topic_progress (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    max_position REAL NOT NULL DEFAULT 0,
    last_position REAL NOT NULL DEFAULT 0,
    watched_seconds INTEGER NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    last_heartbeat_at INTEGER NOT NULL,
    completed_at INTEGER,
    PRIMARY KEY (user_id, topic_id)
  )`,
  `CREATE TABLE IF NOT EXISTS checkpoint_answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    checkpoint_id INTEGER NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
    selected INTEGER NOT NULL,
    is_correct INTEGER NOT NULL,
    answered_at INTEGER NOT NULL
  )`,
  // Giriş-çıkış ve katılım olayları (md. 12/4: kayıt altına alma, izleme, raporlama)
  `CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    topic_id INTEGER REFERENCES topics(id) ON DELETE SET NULL,
    course_id INTEGER REFERENCES courses(id) ON DELETE SET NULL,
    event TEXT NOT NULL,
    detail TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_checkpoints_topic ON checkpoints(topic_id, at_second)`,
  `CREATE INDEX IF NOT EXISTS idx_progress_topic ON topic_progress(topic_id)`,
  `CREATE INDEX IF NOT EXISTS idx_answers_user ON checkpoint_answers(user_id, checkpoint_id)`,
  `CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_log(user_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_sections_course ON sections(course_id, position)`,
  `CREATE INDEX IF NOT EXISTS idx_topics_section ON topics(section_id, position)`,
  `CREATE INDEX IF NOT EXISTS idx_assign_user ON assignments(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_assign_course ON assignments(course_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
];

// Mevcut (Aşama 1'den kalma) veritabanlarına sonradan eklenen sütunlar.
// SQLite'ta "ADD COLUMN IF NOT EXISTS" olmadığından önce sütunun varlığı kontrol edilir.
const TOPIC_COLUMNS = [
  ['video_key', 'TEXT'],
  ['video_name', 'TEXT'],
  ['video_type', 'TEXT'],
  ['video_size', 'INTEGER'],
  ['video_duration', 'INTEGER'], // saniye
];

async function migrate(db) {
  const have = (await db.prepare("SELECT name FROM pragma_table_info('topics')").all()).results.map((r) => r.name);
  const missing = TOPIC_COLUMNS.filter(([name]) => !have.includes(name));
  if (missing.length) {
    await db.batch(missing.map(([name, type]) => db.prepare(`ALTER TABLE topics ADD COLUMN ${name} ${type}`)));
  }
}

let ready = null;

export function ensureSchema(db) {
  if (!ready) {
    ready = db
      .batch(SCHEMA_STATEMENTS.map((s) => db.prepare(s)))
      .then(() => migrate(db))
      .catch((e) => {
        ready = null; // bir sonraki istekte tekrar dene
        throw e;
      });
  }
  return ready;
}
