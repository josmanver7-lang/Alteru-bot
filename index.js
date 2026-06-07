import db from './database.js';
import { Client, GatewayIntentBits } from 'discord.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash';

if (!DISCORD_TOKEN) throw new Error('Missing DISCORD_TOKEN');
if (!OPENROUTER_API_KEY) throw new Error('Missing OPENROUTER_API_KEY');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==========================================
//   FUNCIONES AUXILIARES
// ==========================================

function normalizeText(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()¿?¡]/g, "")
    .trim();
}

async function loadAlteruLore() {
  const loreRaw = await readFile(path.join(__dirname, 'alteru.json'), 'utf8');
  const lore = JSON.parse(loreRaw);
  try {
    const historia = await readFile(path.join(__dirname, 'historia_completa.txt'), 'utf8');
    lore.historia_completa = historia.slice(0, 25000); 
  } catch {
    lore.historia_completa = "Usa la información de la ficha de personaje.";
  }
  return lore;
}

async function loadQuestions() {
  try {
    const raw = await readFile(path.join(__dirname, 'preguntas.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

// ==========================================
//         CONFIGURACIÓN DEL CLIENTE
// ==========================================

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// ... (El resto de funciones como buildSystemPrompt y askOpenRouter se mantienen igual)
// ...

const triviaGames = new Map();
let loreCache = null;

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const content = message.content.trim();
  const args = content.split(/\s+/);
  const command = args[0].toLowerCase();

  // COMANDO !puntos (DB)
  if (command === '!puntos') {
    const points = await db.getPoints(message.author.id);
    return message.reply(`🏆 Tienes ${points} puntos.`);
  }

  // COMANDO !ranking (DB)
  if (command === '!ranking') {
    const ranking = await db.getRanking(10);
    let text = '🏆 Ranking Global\n\n';
    ranking.forEach((r, i) => { text += `${i + 1}. <@${r.userId}> - ${r.points} pts\n`; });
    return message.reply(text);
  }

  // Lógica de Trivia (Validación Inteligente)
  if (triviaGames.has(message.author.id) && !content.startsWith('!')) {
    const game = triviaGames.get(message.author.id);
    clearTimeout(game.timeout);
    triviaGames.delete(message.author.id);

    const cleanUser = normalizeText(content);
    const cleanAnswer = normalizeText(game.answer);
    let isCorrect = (cleanUser === cleanAnswer || cleanUser.includes(cleanAnswer));

    if (!isCorrect) {
      const answerWords = cleanAnswer.split(' ').filter(w => w.length > 3);
      const matchCount = answerWords.filter(w => cleanUser.includes(w)).length;
      if (answerWords.length > 0 && matchCount >= Math.ceil(answerWords.length / 2)) isCorrect = true;
    }

    if (isCorrect) {
      await db.addPoints(message.author.id, game.points);
      const newTotal = await db.getPoints(message.author.id);
      return message.reply(`✅ Correcto. +${game.points} puntos. Total: ${newTotal}`);
    } else {
      return message.reply(`❌ Incorrecto. La respuesta era: ${game.answer}`);
    }
  }

  // ... (Resto del código para !a y !trivia)
});

client.login(DISCORD_TOKEN);
