import Database from 'better-sqlite3';

const db = new Database('alteru.db');

// Asegurar que la tabla existe
db.exec(`
CREATE TABLE IF NOT EXISTS points (
  user_id TEXT PRIMARY KEY,
  score INTEGER NOT NULL DEFAULT 0
)
`);

// Preparamos las sentencias para mejorar el rendimiento
const getStmt = db.prepare('SELECT score FROM points WHERE user_id = ?');
const updateStmt = db.prepare('INSERT INTO points (user_id, score) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET score = score + ?');
const setStmt = db.prepare('INSERT INTO points (user_id, score) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET score = ?');
const rankStmt = db.prepare('SELECT user_id, score FROM points ORDER BY score DESC LIMIT ?');

// Exportamos un objeto con las funciones que tu index.js espera
export default {
  async getPoints(userId) {
    const row = getStmt.get(userId);
    return row ? row.score : 0;
  },

  async addPoints(userId, amount) {
    // Esto suma puntos de forma atómica en la BD
    updateStmt.run(userId, amount, amount);
  },

  async getRanking(limit) {
    return rankStmt.all(limit).map(row => ({
      userId: row.user_id,
      points: row.score
    }));
  }
};
