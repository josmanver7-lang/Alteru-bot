import Database from 'better-sqlite3';

const db = new Database('alteru.db');

// Crear tabla si no existe
db.exec(`
CREATE TABLE IF NOT EXISTS points (
  user_id TEXT PRIMARY KEY,
  score INTEGER NOT NULL DEFAULT 0
)
`);

// Exportamos un objeto que contiene los métodos que tu index.js está buscando
export default {
    getPoints: (userId) => {
        const row = db.prepare('SELECT score FROM points WHERE user_id = ?').get(userId);
        return row ? row.score : 0;
    },

    addPoints: (userId, amount) => {
        db.prepare(`
            INSERT INTO points (user_id, score) 
            VALUES (?, ?) 
            ON CONFLICT(user_id) DO UPDATE SET score = score + ?
        `).run(userId, amount, amount);
    },

    getRanking: (limit) => {
        return db.prepare('SELECT user_id, score FROM points ORDER BY score DESC LIMIT ?').all(limit);
    }
};
