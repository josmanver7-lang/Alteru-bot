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
    const historiaPath = path.join(__dirname, 'historia_completa.txt');
    const historia = await readFile(historiaPath, 'utf8');
    lore.historia_completa = historia.slice(0, 25000); 
  } catch (err) {
    lore.historia_completa = "Usa la información de la ficha de personaje.";
  }
  return lore;
}

async function loadQuestions() {
  try {
    const raw = await readFile(path.join(__dirname, 'preguntas.json'), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return [];
  }
}

// ==========================================
//         CONFIGURACIÓN DEL CLIENTE
// ==========================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

function buildSystemPrompt(lore) {
  return `
Eres Altéru, Capitán de Gondor. Tu objetivo es CONVERSAR, ROLEAR y CONECTAR con quien te habla.
FICHA Y MISIÓN ACTUAL: ${JSON.stringify(lore, null, 2)}
HISTORIA RECIENTE (Contexto): ${lore.historia_completa}
`.trim();
}

const conversationMemory = new Map();
const triviaGames = new Map();
const processedMessages = new Set(); // Restaurado para evitar duplicados

async function askOpenRouter(userId, userMessage, lore) {
  const systemPrompt = buildSystemPrompt(lore);
  const history = conversationMemory.get(userId) || [];

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: userMessage }
  ];

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model: MODEL, messages, temperature: 0.85, max_tokens: 400 })
  });

  if (!res.ok) throw new Error(`OpenRouter ${res.status}`);

  const data = await res.json();
  const reply = data?.choices?.[0]?.message?.content?.trim();

  history.push({ role: 'user', content: userMessage });
  history.push({ role: 'assistant', content: reply });
  if (history.length > 40) history.shift();
  conversationMemory.set(userId, history);
  return reply;
}

let loreCache = null;

client.once('ready', async () => {
  loreCache = await loadAlteruLore();
  console.log(`Logueado como ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  // Manejo de mensajes procesados
  if (processedMessages.has(message.id)) return;
  processedMessages.add(message.id);
  setTimeout(() => processedMessages.delete(message.id), 60000);

  if (message.author.bot) return;

  const content = message.content.trim();
  const args = content.split(/\s+/);
  const command = args[0].toLowerCase();

  // COMANDOS DE PUNTOS Y RANKING (DB)
  if (command === '!puntos') {
    const points = await db.getPoints(message.author.id);
    return message.reply(`🏆 Tienes ${points} puntos.`);
  }

  if (command === '!ranking') {
    const ranking = await db.getRanking(10);
    let text = '🏆 Ranking Global\n\n';
    ranking.forEach((r, i) => text += `${i + 1}. <@${r.userId}> - ${r.points} pts\n`);
    return message.reply(text);
  }

  // TRIVIA
  if (command === '!trivia') {
    if (triviaGames.has(message.author.id)) return message.reply('Ya tienes una trivia activa.');
    const questions = await loadQuestions();
    const question = questions[Math.floor(Math.random() * questions.length)];
    const timeout = setTimeout(async () => {
        triviaGames.delete(message.author.id);
        await message.channel.send(`⌛ Tiempo agotado. La respuesta era: ${question.respuesta}`);
    }, 15000);
    triviaGames.set(message.author.id, { answer: question.respuesta, points: question.puntos, timeout });
    return message.reply(`📜 ${question.pregunta}`);
  }

  if (triviaGames.has(message.author.id) && !content.startsWith('!')) {
    const game = triviaGames.get(message.author.id);
    clearTimeout(game.timeout);
    triviaGames.delete(message.author.id);
    
    const cleanUser = normalizeText(content);
    const cleanAnswer = normalizeText(game.answer);
    
    const answerWords = cleanAnswer.split(' ').filter(w => w.length > 3);
    const matchCount = answerWords.filter(w => cleanUser.includes(w)).length;
    
    if (cleanUser.includes(cleanAnswer) || (answerWords.length > 0 && matchCount >= Math.ceil(answerWords.length / 2))) {
      await db.addPoints(message.author.id, game.points);
      return message.reply(`✅ Correcto. Total: ${await db.getPoints(message.author.id)} pts.`);
    }
    return message.reply(`❌ Incorrecto. La respuesta era: ${game.answer}`);
  }

  // CHAT (!a)
  if (command === '!a') {
    const prompt = content.slice(args[0].length).trim();
    if (!prompt) return message.reply('Escribe algo para hablar.');
    try {
      if (!loreCache) loreCache = await loadAlteruLore();
      await message.channel.sendTyping();
      const reply = await askOpenRouter(message.author.id, prompt, loreCache);
      await message.reply(reply.slice(0, 2000));
    } catch (err) {
      console.error(err);
      await message.reply('¿Qué dijiste? No te oí.');
    }
  }
});

client.login(DISCORD_TOKEN);
