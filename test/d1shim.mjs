// Cloudflare D1 arayüzünü node:sqlite üzerinde taklit eder (yalnızca yerel testler için).
import { DatabaseSync } from 'node:sqlite';

export function createD1(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');

  const makeStmt = (sql, params = []) => ({
    bind: (...p) => makeStmt(sql, p),
    async first() {
      const row = db.prepare(sql).get(...params);
      return row ?? null;
    },
    async all() {
      return { results: db.prepare(sql).all(...params), success: true, meta: {} };
    },
    async run() {
      const r = db.prepare(sql).run(...params);
      return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
    _exec() {
      const r = db.prepare(sql).run(...params);
      return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  });

  return {
    prepare: (sql) => makeStmt(sql),
    async batch(stmts) {
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => s._exec());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    _raw: db,
  };
}
