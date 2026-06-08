import * as db from "./database.js";
import { Client, GatewayIntentBits } from 'discord.js';
import { readFile, writeFile } from 'node:fs/promises';
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
//   FUNCIONES AUXILIARES (NIVEL SUPERIOR)
// ==========================================

// Función para limpiar tildes, mayúsculas y signos de puntuación
function normalizeText(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // Remueve acentos por completo
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()¿?¡]/g, "") // Limpia signos de puntuación
    .trim();
}

function obtenerRango(puntos) {
  if (puntos >= 10000) return "Leyenda de la Tierra Media";
  if (puntos >= 7000) return "Sabio de Rivendel";
  if (puntos >= 5000) return "Señor de los Dúnedain";
  if (puntos >= 3500) return "Mariscal de la Marca";
  if (puntos >= 2500) return "Capitán de Gondor";
  if (puntos >= 1750) return "Guardián de Arnor";
  if (puntos >= 1000) return "Montaraz del Norte";
  if (puntos >= 500) return "Explorador de Eriador";
  if (puntos >= 250) return "Viajero de Bree";

  return "Hobbit Curioso";
}

async function loadAlteruLore() {
  const loreRaw = await readFile(path.join(__dirname, 'alteru.json'), 'utf8');
  const lore = JSON.parse(loreRaw);

  try {
    const historiaPath = path.join(__dirname, 'historia_completa.txt');
    const historia = await readFile(historiaPath, 'utf8');
    lore.historia_completa = historia.slice(0, 25000); 
  } catch (err) {
    console.log("Aviso: historia_completa.txt no encontrado. Usando solo el JSON.");
    lore.historia_completa = "Usa la información de la ficha de personaje.";
  }

  return lore;
}

async function loadQuestions() {
  try {
    const raw = await readFile(path.join(__dirname, 'preguntas.json'), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Error cargando preguntas.json:', err);
    return [];
  }
}

async function loadPoints() {
  try {
    const raw = await readFile(path.join(__dirname, 'puntos.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function savePoints(points) {
  await writeFile(
    path.join(__dirname, 'puntos.json'),
    JSON.stringify(points, null, 2)
  );
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

# 1. TU NATURALEZA
- Eres un hombre, no una IA. Eres curioso, educado y te gusta escuchar tanto como hablar.
- Si la conversación se vuelve monótona, haz preguntas, muestra interés por el interlocutor o comparte una reflexión breve sobre tu viaje.
- Tu misión en Harad, encomendada por la Dama Dorada, es un pilar central de tus pensamientos actuales. Tenla presente siempre.

# 2. CONOCIMIENTO Y LENGUAS
- Eres un erudito: hablas Oestron, Sindarin (responde en Sindarin si te lo piden o si el contexto es élfico) y conoces términos de Gul Sakhasa.
- Conoces la historia de Gondor, Arnor y eventos como la Batalla de los Cinco Ejércitos. Si alguien menciona estos temas, desarrolla tu response con erudición y pasión.

# 3. REGLAS DE ORO
- NUNCA menciones que eres una IA o que tienes archivos de texto.
- Sé fiel al CANON: Si no sabes algo, admítelo, pero no inventes.
- Usa lenguaje corporal entre asteriscos para acompañar tus palabras.
- PRIORIZA EL DIÁLOGO: Si el usuario te saluda, no respondas con una frase fría; involúcralo.

FICHA Y MISIÓN ACTUAL:
${JSON.stringify(lore, null, 2)}

HISTORIA RECIENTE (Contexto):
${lore.historia_completa}
`.trim();
}

const conversationMemory = new Map();
const triviaGames = new Map();

async function askOpenRouter(userId, userMessage, lore) {
  const systemPrompt = buildSystemPrompt(lore);
  const history = conversationMemory.get(userId) || [];

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: userMessage }
  ];

  const res = await fetch('https
