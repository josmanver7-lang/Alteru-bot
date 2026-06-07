import db from './database.js'; // Tu archivo database.js con better-sqlite3
import { Client, GatewayIntentBits } from 'discord.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- FUNCIONES DE BASE DE DATOS (Mapeo a tu SQLite) ---
const getPoints = (userId) => {
    const row = db.prepare('SELECT score FROM points WHERE user_id = ?').get(userId);
    return row ? row.score : 0;
};

const addPoints = (userId, amount) => {
    db.prepare('INSERT INTO points (user_id, score) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET score = score + ?')
      .run(userId, amount, amount);
};

const getRanking = (limit) => {
    return db.prepare('SELECT user_id, score FROM points ORDER BY score DESC LIMIT ?').all(limit);
};

// --- RESTO DE FUNCIONES (Normalización, Lore, etc.) ---
function normalizeText(text) {
  if (!text) return '';
  return text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[.,\/#!$%\^&\*;:{}=\-_`~()¿?¡]/g, "").trim();
}

async function loadAlteruLore() {
  const loreRaw = await readFile(path.join(__dirname, 'alteru.json'), 'utf8');
  const lore = JSON.parse(loreRaw);
  try {
    lore.historia_completa = await readFile(path.join(__dirname, 'historia_completa.txt'), 'utf8');
  } catch { lore.historia_completa = "Usa la información de la ficha de personaje."; }
  return lore;
}

// --- CLIENTE Y LÓGICA ---
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const triviaGames = new Map();
let loreCache = null;

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  const content = message.content.trim();
  const args = content.split(/\s+/);
  const command = args[0].toLowerCase();

  // COMANDO !puntos
  if (command === '!puntos') {
    const score = getPoints(message.author.id);
    return message.reply(`🏆 Tienes ${score} puntos.`);
  }

  // COMANDO !ranking
  if (command === '!ranking') {
    const ranking = getRanking(10);
    let text = '🏆 Ranking Global\n\n';
    ranking.forEach((r, i) => text += `${i + 1}. <@${r.user_id}> - ${r.score} pts\n`);
    return message.reply(text);
  }

  // TRIVIA
  if (command === '!trivia') {
     // ... (tu lógica de trivia)
  }

  // VALIDACIÓN DE TRIVIA
  if (triviaGames.has(message.author.id) && !content.startsWith('!')) {
    const game = triviaGames.get(message.author.id);
    clearTimeout(game.timeout);
    triviaGames.delete(message.author.id);
    
    if (normalizeText(content).includes(normalizeText(game.answer))) {
      addPoints(message.author.id, game.points);
      return message.reply(`✅ Correcto. Total: ${getPoints(message.author.id)} pts.`);
    }
  }
});

client.login(DISCORD_TOKEN);
