import Database from 'better-sqlite3';

const db = new Database('alteru.db');

db.exec(`
CREATE TABLE IF NOT EXISTS points (
  user_id TEXT PRIMARY KEY,
  score INTEGER NOT NULL DEFAULT 0
)
`);

export default db;
