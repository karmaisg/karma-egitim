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
  // Aşama 3: sınavlar (md. 16). kind: 'on_test' (md. 16/1 ön seviye tespiti), 'konu' (konu sonu), 'final' (eğitim sonu, md. 16/2)
  `CREATE TABLE IF NOT EXISTS exams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    topic_id INTEGER REFERENCES topics(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('on_test','konu','final')),
    title TEXT NOT NULL,
    pass_score INTEGER NOT NULL DEFAULT 60,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    created_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_exams_topic ON exams(topic_id) WHERE topic_id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_exams_course_kind ON exams(course_id, kind) WHERE topic_id IS NULL`,
  `CREATE TABLE IF NOT EXISTS exam_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    question TEXT NOT NULL,
    options TEXT NOT NULL,
    correct INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS exam_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    total INTEGER NOT NULL,
    correct_count INTEGER,
    score INTEGER,
    passed INTEGER,
    plan TEXT NOT NULL
  )`,
  // Her cevap, sorunun o andaki metniyle birlikte saklanır (sonradan soru değişse bile sınav kaydı bozulmaz).
  `CREATE TABLE IF NOT EXISTS exam_answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    attempt_id INTEGER NOT NULL REFERENCES exam_attempts(id) ON DELETE CASCADE,
    question_id INTEGER,
    question_text TEXT NOT NULL,
    options TEXT NOT NULL,
    correct_index INTEGER NOT NULL,
    selected INTEGER,
    is_correct INTEGER NOT NULL
  )`,
  // Deneme hakkı tükenen katılımcıya yönetici yeni hak tanıyabilir; eski denemeler silinmez.
  `CREATE TABLE IF NOT EXISTS exam_grants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    attempts_at_grant INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    granted_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_attempts_user_exam ON exam_attempts(user_id, exam_id)`,
  `CREATE INDEX IF NOT EXISTS idx_exam_questions ON exam_questions(exam_id, position)`,
  `CREATE INDEX IF NOT EXISTS idx_exam_answers_attempt ON exam_answers(attempt_id)`,
  `CREATE INDEX IF NOT EXISTS idx_exam_grants ON exam_grants(user_id, exam_id)`,
  // Aşama 4: katılım belgesi (md. 17). Belge, düzenlendiği andaki bilgilerle (snapshot) saklanır.
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS certificates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    number TEXT UNIQUE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    issued_at INTEGER NOT NULL,
    snapshot TEXT NOT NULL,
    UNIQUE (user_id, course_id)
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

const EXTRA_COLUMNS = {
  topics: TOPIC_COLUMNS,
  // Aşama 4
  companies: [['employer_1', 'TEXT'], ['employer_2', 'TEXT']],
  courses: [['cert_hours', 'REAL NOT NULL DEFAULT 8'], ['cert_in_person', 'INTEGER NOT NULL DEFAULT 0'], ['cert_remote', 'INTEGER NOT NULL DEFAULT 1'], ['trainers', 'TEXT']],
  assignments: [['training_type', "TEXT NOT NULL DEFAULT 'ilk'"]],
};

async function migrate(db) {
  for (const [table, cols] of Object.entries(EXTRA_COLUMNS)) {
    const have = (await db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all()).results.map((r) => r.name);
    const missing = cols.filter(([name]) => !have.includes(name));
    if (missing.length) {
      await db.batch(missing.map(([name, type]) => db.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`)));
    }
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
