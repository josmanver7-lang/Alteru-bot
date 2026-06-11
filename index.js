import * as db from "./database.js";
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

// ================================
// CUOTAS + TIEMPOS
// ================================

const ADMIN_USER_ID = process.env.ADMIN_USER_ID || process.env.OWNER_ID;

const TRIVIA_LIMIT = 3;
const TRIVIA_WINDOW_MS = 12 * 60 * 60 * 1000;

const EXPEDITION_LIMIT = 2;
const EXPEDITION_WINDOW_MS = 12 * 60 * 60 * 1000;

// Mapas de control en memoria activa
let personajesCache = {};
let loreCache = null;
let tablonSelection = [];
const triviaGames = new Map();
const expeditions = new Map();
const conversationMemory = new Map();

// ================================
// COMPAÑEROS
// ================================

const companions = {
  alteru: {
    nombre: "Altéru",
    clase: "Capitán",
    habilidad: "Rugido del León",
    efecto: "+20% éxito general en expediciones.",
    coste: 500,
    nivel: 3
  },
  cirdil: {
    nombre: "Círdil",
    clase: "Guerrero",
    habilidad: "Escudo de Gondor",
    efecto: "+15% contra enemigos poderosos y reduce daño recibido.",
    coste: 250
  },
  duilon: {
    nombre: "Duilon",
    clase: "Campeón",
    habilidad: "Deseo de Lucha",
    efecto: "+25% contra enemigos numerosos.",
    coste: 200
  },
  andaer: {
    nombre: "Andaer",
    clase: "Guerrero",
    habilidad: "Instinto Escudero",
    efecto: "20% de bloquear un golpe por completo.",
    coste: 150
  },
  nieriel: {
    nombre: "Nieriel",
    clase: "Capitán",
    habilidad: "Instinto de Supervivencia",
    efecto: "Evita encontrar enemigos con peligro superior a tu nivel.",
    coste: 150
  },
  faelon: {
    nombre: "Faelon",
    clase: "Guardián Rúnico",
    habilidad: "Sabiduría de Imladris",
    efecto: "Restaura +10 de salud al final de cada encuentro.",
    coste: 100
  },
  montaraces: {
    nombre: "Montaraces de Arathir",
    clase: "Cazadores",
    habilidad: "Exploradores del Norte",
    efecto: "+30% éxito en expediciones.",
    coste: 1000,
    nivel: 5
  }
};

// ==========================================
//          FUNCIONES AUXILIARES
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

function normalizeDifficulty(value) {
  return normalizeText(value || "normal");
}

function formatRemainingTime(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function normalizeKey(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s+/g, "_");
}

function buildPersonajesCache(input) {
  if (Array.isArray(input)) {
    return Object.fromEntries(
      input
        .filter(Boolean)
        .map(p => {
          const key = normalizeKey(p.id || p.nombre);
          return [key, p];
        })
    );
  }

  if (input && typeof input === "object") {
    return Object.fromEntries(
      Object.entries(input).map(([k, v]) => [normalizeKey(k), v])
    );
  }

  return {};
}

function getPersonaje(id) {
  return personajesCache[normalizeKey(id)] || null;
}

function getOwnedCompanions(profile) {
  const list = profile?.activeCompanions?.length
    ? profile.activeCompanions
    : (profile?.hiredCompanions || profile?.companions || []);

  return [...new Set(list.map(normalizeKey))];
}

function summarizePersonality(id) {
  const p = getPersonaje(id);
  const raw = p?.personalidad || p?.descripcion || p?.tono || "";

  const words = String(raw)
    .replace(/[^\p{L}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

  return words.slice(0, 2).join(" ") || "Sin definir";
}

function personalityShort(text) {
  const parts = String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (!parts.length) return "Sin definir";
  return parts.slice(0, 2).join(" ");
}

function getPersonalityText(id) {
  const p = getPersonaje(id);
  if (!p) return "Sin definir";

  const raw =
    p.personalidadCorta ||
    p.personalidadBreve ||
    p.personalidad ||
    p.rasgos ||
    p.caracter ||
    p.descripcionCorta ||
    p.descripcion ||
    p.tono ||
    "";

  const text = String(raw).trim();
  return text || "Sin definir";
}

function getCompanionEffect(id) {
  return companions[id]?.efecto || "Sin efecto definido.";
}

function getCompanionIcon(id) {
  switch (normalizeKey(id)) {
    case "cirdil":
    case "andaer":
      return "🛡️";
    case "duilon":
      return "⚔️";
    case "alteru":
    case "nieriel":
      return "🎖️";
    case "montaraces":
      return "🏹";
    case "faelon":
      return "🌿";
    default:
      return "•";
  }
}

function stripCompanionPrefix(text, companionName) {
  const raw = String(text || "").trim();
  const re = new RegExp(`^${companionName}\\s*:\\s*`, "i");
  return raw.replace(re, "").trim();
}

function compactLine(text, maxWords = 12) {
  const words = String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

  if (words.length <= maxWords) return words.join(" ");
  return `${words.slice(0, maxWords).join(" ")}…`;
}

function getAffinityBonus(profile, companionId) {
  const affinity = profile.affinity || {};
  const value = affinity[normalizeKey(companionId)] || affinity[companionId] || 0;

  if (value >= 75) return 0.10;
  if (value >= 50) return 0.05;
  return 0;
}

function getCompanionBonus(profile) {
  const list = getOwnedCompanions(profile);

  return {
    captainBonus: list.includes("alteru") ? 0.20 : 0,
    strongEnemyBonus: list.includes("cirdil") ? 0.15 : 0,
    numerousEnemyBonus: list.includes("duilon") ? 0.25 : 0,
    blockChance: list.includes("andaer") ? 0.20 : 0,
    rangerBonus: list.includes("montaraces") ? 0.30 : 0,
    damageReduction: list.includes("cirdil") ? 0.20 : 0,
    faelonHeal: list.includes("faelon") ? 10 : 0,
    nierielSafe: list.includes("nieriel") ? true : false
  };
}

function getAffinityGain(companionId, encounter, mode, outcome) {
  const id = normalizeKey(companionId);
  const tipo = normalizeKey(encounter?.tipo || "");
  const categoria = normalizeKey(encounter?.categoria || "");
  const peligro = encounter?.peligro || 0;

  let gain = 1;

  if (id === "alteru" || id === "nieriel") gain = 1;

  if (id === "cirdil") {
    gain = peligro >= 4 || tipo === "enemigo_poderoso" || tipo === "jefe" ? 3 : 1;
  }
  if (id === "duilon") {
    gain = tipo === "enemigo_numeroso" ? 3 : 1;
  }
  if (id === "andaer") {
    gain = outcome === "derrota" ? 3 : 2;
  }
  if (id === "faelon") {
    gain = tipo === "evento_especial" || categoria === "social" ? 3 : 1;
  }
  if (id === "montaraces") {
    gain = categoria === "exploracion" || tipo === "terreno" ? 3 : 2;
  }

  if (mode === "mision_completada") {
    if (id === "alteru" || id === "nieriel") gain = 1;
    else gain = Math.max(gain, 2);
  }

  return gain;
}

async function applyAffinityToParty(userId, profile, encounter, mode, outcome) {
  const list = getOwnedCompanions(profile);
  let total = 0;

  for (const compId of list) {
    const gain = getAffinityGain(compId, encounter, mode, outcome);
    total += gain;
    await db.addAffinity(userId, compId, gain);
  }

  return total;
}

async function applyAffinityToPartyDetailed(userId, profile, encounter, mode, outcome) {
  const list = getOwnedCompanions(profile);
  let total = 0;
  const details = [];

  for (const compId of list) {
    const gain = getAffinityGain(compId, encounter, mode, outcome);
    total += gain;
    await db.addAffinity(userId, compId, gain);

    const name = companions[compId]?.nombre || compId;
    details.push(`• **${name}**: +${gain} afinidad`);
  }

  return { total, details };
}

function pickCompanionForScene(profile, encounter) {
  const list = getOwnedCompanions(profile);
  if (!list.length) return null;

  const titulo = normalizeKey(encounter?.titulo || "");
  const tipo = normalizeKey(encounter?.tipo || "");
  const categoria = normalizeKey(encounter?.categoria || "");
  const id = normalizeKey(encounter?.id || "");

  const isElfScene = titulo.includes("elf") || id.includes("elf") || id === "exploradores_elficos";

  if (isElfScene && list.includes("faelon")) return "faelon";

  if (tipo === "enemigo_numeroso" || titulo.includes("trasgo") || titulo.includes("corsario") || titulo.includes("bandido")) {
    if (list.includes("duilon")) return "duilon";
  }

  if (tipo === "enemigo_poderoso" || tipo === "jefe" || (encounter?.peligro || 0) >= 4) {
    if (list.includes("cirdil")) return "cirdil";
    if (list.includes("alteru")) return "alteru";
  }

  if (tipo === "evento_especial" || categoria === "social") {
    if (list.includes("faelon")) return "faelon";
    if (list.includes("nieriel")) return "nieriel";
  }

  return list[0];
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

function getAffinityRank(value) {
  if (value >= 100) return "Compañero de Confianza";
  if (value >= 75) return "Amigo Cercano";
  if (value >= 50) return "Aliado";
  if (value >= 25) return "Conocido";
  return "Desconocido";
}

function getDangerText(peligro) {
  if (peligro <= 2) return "Bajo";
  if (peligro <= 4) return "Moderado";
  if (peligro <= 6) return "Alto";
  return "Extremo";
}

function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

async function refreshTablonSelection() {
  const missions = await loadMissions();
  tablonSelection = shuffleArray(missions).slice(0, 5);
}

async function clearExpeditionParty(userId) {
  await db.updateTravelerData(userId, {
    activeCompanions: [],
    companions: []
  });
}

async function awardMissionCompletion(userId, profile, xpAmount, pointAmount) {
  const beforeLevel = db.calculateLevel(profile.xp || 0);
  const beforeRank = obtenerRango(profile.points || 0);

  await db.addXP(userId, xpAmount);
  await db.addPoints(userId, pointAmount);

  const updated = await db.getProfile(userId);
  const afterLevel = db.calculateLevel(updated.xp || 0);
  const afterRank = obtenerRango(updated.points || 0);

  const lines = [];

  if (afterLevel > beforeLevel) {
    lines.push(`📚 ¡Felicidades! Has ascendido al nivel **${afterLevel}**.`);
  }

  if (afterRank !== beforeRank) {
    lines.push(`🏅 ¡Felicidades! Has ascendido de rango, ahora eres conocido como **${afterRank}**.`);
  }

  return lines.join("\n");
}

function applyFaelonHeal(profile) {
  const list = getOwnedCompanions(profile);
  if (!list.includes("faelon")) return null;

  const saludActual = profile.salud !== undefined ? profile.salud : 100;
  const nuevaSalud = Math.min(100, saludActual + 10);

  return { saludActual, nuevaSalud };
}

function getEncounterSubOptions(encounter, encountersPool = []) {
  if (!encounter) return [];

  const directList = Array.isArray(encounter.subencuentros)
    ? encounter.subencuentros
    : Array.isArray(encounter.subescenarios)
      ? encounter.subescenarios
      : Array.isArray(encounter.variantes)
        ? encounter.variantes
        : [];

  const direct = directList
    .slice(0, 3)
    .map(item => {
      if (!item) return null;

      if (typeof item === "string") {
        return encountersPool.find(e => e.id === item) || null;
      }

      if (typeof item === "object") {
        return item;
      }

      return null;
    })
    .filter(Boolean);

  const linked = encountersPool.filter(e =>
    e &&
    (e.parentId === encounter.id ||
      e.grupo === encounter.id ||
      e.padre === encounter.id)
  );

  const unique = [...new Map([...direct, ...linked].map(e => [e.id || normalizeKey(e.titulo), e])).values()];
  return unique.slice(0, 3);
}

function chooseEncounterVariant(encounter, encountersPool = []) {
  const options = getEncounterSubOptions(encounter, encountersPool);
  if (!options.length) return encounter;

  const chosen = options[Math.floor(Math.random() * options.length)];
  return {
    ...encounter,
    ...chosen,
    parentId: encounter.id,
    variantOf: encounter.id,
    subEncounter: true
  };
}

// ==========================================
//        LLAMADAS API E INTERACCIONES IA
// ==========================================

async function companionReaction(companionId, context, mode = "encounter") {
  const personaje = getPersonaje(companionId);
  const nombre = personaje?.nombre || companions[companionId]?.nombre || companionId;

  const personalidad = personaje?.personalidad || personaje?.descripcion || personaje?.tono || "";
  const arma = personaje?.arma || personaje?.equipo?.arma || personaje?.armamento?.arma || "";
  const armadura = personaje?.armadura || personaje?.equipo?.armadura || personaje?.armamento?.armadura || "";

  const titulo = context?.titulo || "sin título";
  const tipo = context?.tipo || "desconocido";
  const categoria = context?.categoria || "desconocida";
  const descripcion = context?.descripcion || context?.textoExito || context?.textoFracaso || "";

  if (!personaje) return `${nombre}: *asiente en silencio*`;

  if (normalizeKey(nombre) === "faelon" && (normalizeKey(titulo).includes("elf") || normalizeKey(context?.id || "").includes("elf"))) {
    return `Faelon: Mira, amigos.`;
  }

  const prompt = `
Eres ${nombre}.

Personalidad:
${personalidad || "reservado y expresivo a su manera"}

Arma:
${arma || "No especificada"}

Armadura:
${armadura || "No especificada"}

Situación:
Modo: ${mode}
Título: ${titulo}
Tipo: ${tipo}
Categoría: ${categoria}
Descripción: ${descripcion}

Responde con una sola línea muy corta.
Máximo 12 palabras.
Puede ser frase o gesto entre asteriscos.
Coloca el nombre una sola vez al inicio.
`.trim();

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.85,
        max_tokens: 40
      })
    });

    if (!res.ok) return `${nombre}: *asiente en silencio*`;

    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content?.trim() || "*asiente en silencio*";
    const clean = stripCompanionPrefix(raw, nombre);

    return `${nombre}: ${compactLine(clean, 12)}`;
  } catch {
    return `${nombre}: *asiente en silencio*`;
  }
}

async function companionReactions(profile, context, mode = "encounter", maxLines = 3, outcome = "encounter") {
  const ids = [...new Set(getOwnedCompanions(profile))].slice(0, maxLines);
  const lines = [];

  for (const id of ids) {
    const line = await companionReaction(id, context, mode);
    if (line) lines.push(`💬 ${line}`);
  }

  return lines.join("\n");
}

async function announceDawnReset(client) {
  const dawnCompanionId = [
    "faelon", "nieriel", "cirdil", "andaer", "duilon", "alteru", "montaraces"
  ][Math.floor(Math.random() * 7)];

  const line = await companionReaction(
    dawnCompanionId,
    {
      titulo: "Amanecer",
      tipo: "evento_especial",
      categoria: "social",
      descripcion: "Las nuevas tareas despiertan con la luz del alba."
    },
    "amanecer"
  );

  const channelId = process.env.ANNOUNCEMENTS_CHANNEL_ID;
  if (!channelId) return;

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (channel?.isTextBased()) {
    await channel.send(`🌅 ${line}`);
  }
}

function buildSystemPrompt(lore, profile) {
  return `
## 1. TU NATURALEZA
* Eres Altéru, capitán de Gondor y anfitrión del Campamento de Altéru.
* Tu carácter es el de un líder veterano: directo, observador y con humor sobrio.
* No hablas como una máquina: conversas como alguien que conoce el campamento y sus riesgos.
* Mantén siempre el diálogo vivo por encima del formato de un bot tradicional.

## 2. REGLAS DE ORO
* Nunca digas que eres una IA. Usa acciones o gestos entre asteriscos para ambientar la escena.

## 3. RELACIÓN CON EL VIAJERO
Raza: ${profile?.race || "desconocida"}
Clase: ${profile?.class || "desconocida"}
Puntos: ${profile?.points || 0}
Rango: ${obtenerRango(profile?.points || 0)}
`.trim();
}

async function askOpenRouter(userId, userMessage, lore) {
  const profile = await db.getProfile(userId);
  const systemPrompt = buildSystemPrompt(lore, profile);

  if (!conversationMemory.has(userId)) {
    conversationMemory.set(userId, []);
  }
  const history = conversationMemory.get(userId);
  history.push({ role: "user", content: userMessage });
  if (history.length > 10) history.shift();

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "system", content: systemPrompt }, ...history],
        temperature: 0.85
      })
    });

    if (!res.ok) return "Altéru: *revisa los planos tácticos en silencio*";
    const data = await res.json();
    const reply = data?.choices?.[0]?.message?.content?.trim() || "*asiente*";

    history.push({ role: "assistant", content: reply });
    if (history.length > 10) history.shift();
    return reply;
  } catch {
    return "Altéru: *observa los senderos lejanos con suspicacia*";
  }
}

// ==========================================
//         CARGA DE ARCHIVOS JSON/TEXT
// ==========================================

async function loadAlteruLore() {
  const loreRaw = await readFile(path.join(__dirname, 'alteru.json'), 'utf8');
  const lore = JSON.parse(loreRaw);
  try {
    const historiaPath = path.join(__dirname, 'historia_completa.txt');
    const historia = await readFile(historiaPath, 'utf8');
    lore.historia_completa = historia.slice(0, 25000); 
  } catch {
    lore.historia_completa = "Usa la información de la ficha de personaje.";
  }
  try {
    const personajesPath = path.join(__dirname, 'personajes.json');
    const personajesRaw = await readFile(personajesPath, 'utf8');
    lore.personajes = JSON.parse(personajesRaw);
  } catch {
    console.log("Aviso: personajes.json no encontrado.");
  }
  return lore;
}

async function loadQuestions() {
  try {
    const raw = await readFile(path.join(__dirname, 'preguntas.json'), 'utf8');
    return JSON.parse(raw);
  } catch { return []; }
}

async function loadMissions() {
  try {
    const raw = await readFile(path.join(__dirname, "misiones.json"), "utf8");
    return JSON.parse(raw);
  } catch { return []; }
}

async function loadEncounters() {
  try {
    const raw = await readFile(path.join(__dirname, "encuentros.json"), "utf8");
    return JSON.parse(raw);
  } catch { return []; }
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

client.once("ready", async () => {
  await db.connectDB();
  loreCache = await loadAlteruLore();

  try {
    const raw = await readFile(path.join(__dirname, "personajes.json"), "utf8");
    const parsed = JSON.parse(raw);
    personajesCache = Array.isArray(parsed)
      ? Object.fromEntries(
          parsed
            .filter(p => p && (p.id || p.nombre))
            .map(p => {
              const key = normalizeKey(p.id || p.nombre);
              return [key, p];
            })
        )
      : buildPersonajesCache(parsed);
  } catch {
    personajesCache = {};
  }

  await refreshTablonSelection();

  console.log(`Logged in as ${client.user.tag}`);
});

// ==========================================
//          MANEJO DE MENSAJES Y COMANDOS
// ==========================================

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const content = message.content.trim();
  const args = content.split(/\s+/);
  const command = args[0].toLowerCase();

  // ========================================
  // CONTROL ACTIVO DE TRIVIA
  // ========================================
  if (triviaGames.has(message.author.id)) {
    const game = triviaGames.get(message.author.id);
    const textNormalize = normalizeText(content);

    const correctRaw =
      game.question.respuestaCorrecta ||
      game.question.respuesta ||
      game.question.answer ||
      "";

    const correctNormalize = normalizeText(correctRaw);
    let isCorrect = textNormalize === correctNormalize;

    const optionIndex = {
      a: 0, b: 1, c: 2, d: 3,
      1: 0, 2: 1, 3: 2, 4: 3
    };

    if (!isCorrect && Array.isArray(game.options) && game.options.length) {
      const idx = optionIndex[textNormalize];
      if (idx !== undefined && game.options[idx]) {
        isCorrect = normalizeText(game.options[idx]) === correctNormalize;
      }
    }

    if (!isCorrect && textNormalize.includes(correctNormalize)) {
      isCorrect = true;
    }

    if (isCorrect) {
      clearTimeout(game.timeout);
      triviaGames.delete(message.author.id);

      const points =
        game.difficulty === "facil" ? 10 :
        game.difficulty === "normal" ? 20 :
        game.difficulty === "dificil" ? 40 :
        game.difficulty === "legendario" ? 80 :
        20;

      await db.addCorrectAnswer(message.author.id, points);
      return message.reply(`🎉 ¡Correcto! +${points} puntos.`);
    }

    if (!command.startsWith("!")) {
      clearTimeout(game.timeout);
      triviaGames.delete(message.author.id);
      await db.addWrongAnswer(message.author.id);

      return message.reply(`❌ Incorrecto. La respuesta correcta era: ||${correctRaw}||.`);
    }
  }

  // Comandos de Perfil y Sistema de Estadísticas
  if (command === "!perfil") {
    const profile = await db.getProfile(message.author.id);
    const lvl = db.calculateLevel(profile.xp || 0);
    return message.reply(
`👤 **PERFIL DE VIAJERO**
Raza: ${profile.race || "No definida"} | Clase: ${profile.class || "No definida"}
Rango: ${obtenerRango(profile.points || 0)} | Nivel: ${lvl} (${profile.xp || 0} XP)
Puntos: ${profile.points || 0} | ❤️ Salud: ${profile.salud !== undefined ? profile.salud : 100}/100

📊 Trivia: Correctas: ${profile.correctas || 0} | Incorrectas: ${profile.incorrectas || 0}
🔥 Racha Actual: ${profile.rachaActual || 0} | Mejor: ${profile.mejorRacha || 0}`
    );
  }

  if (command === "!puntos") {
    const pts = await db.getPoints(message.author.id);
    return message.reply(`💰 Tienes **${pts}** puntos.`);
  }

  if (command === "!nivel") {
    const profile = await db.getProfile(message.author.id);
    return message.reply(`⭐ Tu nivel actual es **${db.calculateLevel(profile.xp)}** (XP total: ${profile.xp || 0}).`);
  }

  if (command === "!ranking") {
    const ranking = await db.getRanking();
    let res = "🏆 **RANKING DE VIAJEROS**\n\n";
    ranking.forEach((u, i) => { res += `${i + 1}. <@${u.userId}> — ${u.points} pts\n`; });
    return message.reply(res);
  }

  if (command === "!afinidad") {
    const profile = await db.getProfile(message.author.id);
    const affinity = profile.affinity || {};
    let txt = "🤝 **AFINIDAD CON COMPAÑEROS**\n\n";
    Object.keys(companions).forEach(id => {
      const val = affinity[id] || 0;
      txt += `${getCompanionIcon(id)} **${companions[id].nombre}**: ${val}/100 (${getAffinityRank(val)})\n`;
    });
    return message.reply(txt);
  }

  // Comandos de Utilidades Generales y Gestión Base
  if (command === "!info" || command === "!ayuda") {
    return message.reply(
`📜 Campamento de Altéru

👤 PERFIL
!perfil, !puntos, !nivel, !ranking, !afinidad

🤝 COMPAÑEROS
!campamento, !companeros, !contratar <nombre>, !grupo

🗺️ EXPEDICIONES
!tablon, !expedicion <numero>, !desafiar, !interactuar, !volver

📚 TRIVIA
!trivia <facil/normal/dificil/legendario>

🔥 ROLEPLAY
!a <mensaje> (Hablar con Altéru) o directos (!al, !c, !d, !an, !n, !f)`
    );
  }

  if (command === "!resetear") {
    const target = message.mentions.users.first() || message.author;

    if (target.id !== message.author.id && message.author.id !== ADMIN_USER_ID) {
      return message.reply("No tienes permiso para resetear a otro usuario.");
    }

    await db.resetQuotaState(target.id, "trivia", TRIVIA_WINDOW_MS);
    return message.reply(`🔄 Trivia reiniciada para <@${target.id}>.`);
  }

  if (command === "!reiniciar") {
    const target = message.mentions.users.first() || message.author;

    if (target.id !== message.author.id && message.author.id !== ADMIN_USER_ID) {
      return message.reply("No tienes permiso para reiniciar a otro usuario.");
    }

    await db.resetQuotaState(target.id, "expedicion", EXPEDITION_WINDOW_MS);
    return message.reply(`🔄 Expediciones reiniciadas para <@${target.id}>.`);
  }

  if (command === "!companeros" || command === "!compañeros") {
    let texto = "🤝 **Compañeros disponibles**\n\n";
    const orden = ["montaraces", "alteru", "cirdil", "duilon", "andaer", "nieriel", "faelon"];
  
    for (const id of orden) {
      const comp = companions[id];
      const req = comp.nivel ? `Nivel ${comp.nivel}` : "Ninguno";
  
      texto += `${getCompanionIcon(id)} **${comp.nombre}** — ${comp.clase}\n`;
      texto += `Habilidad: ${comp.habilidad}\n`;
      texto += `Efecto: ${comp.efecto}\n`;
      texto += `Coste: ${comp.coste} pts\n`;
      texto += `Requisito: ${req}\n`;
      texto += `Personalidad: ${getPersonalityText(id)}\n\n`;
    }
  
    return message.reply(texto);
  }

  if (command === "!campamento") {
    let texto = "🏕️ **CAMPAMENTO DE ALTÉRU**\n\n";
    const orden = ["montaraces", "alteru", "cirdil", "duilon", "andaer", "nieriel", "faelon"];
  
    for (const id of orden) {
      const comp = companions[id];
      const req = comp.nivel ? `Nivel ${comp.nivel}` : "Ninguno";
  
      texto += `${getCompanionIcon(id)} **${comp.nombre}** — ${comp.clase}\n`;
      texto += `Habilidad: ${comp.habilidad}\n`;
      texto += `Efecto: ${comp.efecto}\n`;
      texto += `Coste: ${comp.coste} pts\n`;
      texto += `Requisito: ${req}\n`;
      texto += `Personalidad: ${getPersonalityText(id)}\n\n`;
    }
  
    return message.reply(texto);
  }

  if (command === "!tablon") {
    if (!tablonSelection.length) {
      await refreshTablonSelection();
    }

    const missions = tablonSelection.length ? tablonSelection : await loadMissions();
    let texto = "**Te acercas al tablón de anuncios y ves varias expediciones.**\n\n";

    missions.forEach((m, i) => {
      texto += `${i + 1}. ${m.titulo}\n`;
      texto += `📍 ${m.destino}\n`;
      texto += `⚠ Nivel ${m.nivel}\n`;
      texto += `🎖 ${m.puntos} pts\n`;
      texto += `📚 ${m.xp} XP\n\n`;
    });

    texto += "────────────────\n\n";
    texto += "🤝 Compañeros del campamento\n\n";

    const orden = ["montaraces", "alteru", "cirdil", "duilon", "andaer", "nieriel", "faelon"];

    for (const id of orden) {
      const comp = companions[id];
      const req = comp.nivel ? `Nivel ${comp.nivel}` : "Ninguno";

      texto += `${getCompanionIcon(id)} **${comp.nombre}** — ${comp.clase}\n`;
      texto += `Habilidad: ${comp.habilidad}\n`;
      texto += `Efecto: ${comp.efecto}\n`;
      texto += `Coste: ${comp.coste} pts\n`;
      texto += `Requisito: ${req}\n`;
      texto += `Personalidad: ${getPersonalityText(id)}\n\n`;
    }

    texto += "Usa !contratar <nombre>\n";
    texto += "Usa !expedicion <numero>";
    return message.reply(texto);
  }

  if (command === "!contratar") {
    if (!args[1]) return message.reply("Usa !contratar <nombre>");

    const id = normalizeKey(args[1]);
    if (!companions[id]) return message.reply("Ese compañero no existe.");

    const companion = companions[id];
    const profile = await db.getProfile(message.author.id);
    const owned = getOwnedCompanions(profile);

    if (owned.includes(id)) {
      return message.reply(`Ya has contratado a ${companion.nombre}.`);
    }

    const xpActual = profile.xp || 0;
    const nivelJugador = typeof db.calculateLevel === "function"
      ? db.calculateLevel(xpActual)
      : Math.floor(xpActual / 1000) + 1;

    if (companion.nivel && nivelJugador < companion.nivel) {
      return message.reply(`Necesitas nivel ${companion.nivel} para contratar a ${companion.nombre}.`);
    }

    if ((profile.points || 0) < companion.coste) {
      return message.reply(`Necesitas ${companion.coste} puntos.`);
    }

    await db.spendPoints(message.author.id, companion.coste);
    await db.hireCompanion(message.author.id, id);
    await db.addAffinity(message.author.id, id, 5);

    const scene = {
      titulo: `Contratación de ${companion.nombre}`,
      tipo: "evento_especial",
      categoria: "social",
      descripcion: `El viajero contrata a ${companion.nombre}.`
    };

    const reaction = await companionReaction(id, scene, "contratacion");

    return message.reply(
      `🤝 Has contratado a ${companion.nombre}.\n\n${reaction || ""}`.trim()
    );
  }

  if (command === "!grupo") {
    const profile = await db.getProfile(message.author.id);
    const lista = getOwnedCompanions(profile);

    if (!lista.length) {
      return message.reply("No has contratado compañeros.");
    }

    const affinity = profile.affinity || {};
    let texto = "🤝 **Tus Compañeros:**\n\n";

    for (const id of [...new Set(lista)]) {
      const valor = affinity[id] || 0;
      texto += `${getCompanionIcon(id)} **${companions[id]?.nombre || id}** — Afinidad ${valor}%\n`;
    }

    return message.reply(texto);
  }

  // ========================================
  // SISTEMA DE EXPEDICIONES
  // ========================================
  if (command === "!expedicion") {
    const state = await db.getQuotaState(message.author.id, "expedicion", EXPEDITION_WINDOW_MS);

    if (state.attempts >= EXPEDITION_LIMIT) {
      return message.reply(`⚠️ Agotaste tus expediciones. Vuelve en ${formatRemainingTime(state.resetAt - Date.now())}.`);
    }

    const numero = parseInt(args[1]);
    if (isNaN(numero)) return message.reply("Usa !expedicion <numero>");

    // Se asegura de tomar la misión correspondiente de tablonSelection si está activa, o usar loadMissions()
    const missions = tablonSelection.length ? tablonSelection : await loadMissions();
    const mission = missions[numero - 1];
    if (!mission) return message.reply("Esa misión no existe.");

    const profile = await db.getProfile(message.author.id);
    const xpActual = profile.xp || 0;
    const nivelJugador = typeof db.calculateLevel === "function"
      ? db.calculateLevel(xpActual)
      : Math.floor(xpActual / 1000) + 1;

    if (mission.nivel && nivelJugador < mission.nivel) {
      return message.reply(`⚠️ Necesitas nivel ${mission.nivel} para realizar esta expedición.\n\nTu nivel actual es ${nivelJugador}.`);
    }

    if (expeditions.has(message.author.id)) {
      return message.reply("Ya estás en una expedición.");
    }

    await db.setQuotaState(message.author.id, "expedicion", state.attempts + 1, state.resetAt);

    const activeCompanions = getOwnedCompanions(profile);

    expeditions.set(message.author.id, {
      missionId: mission.id,
      mission,
      progress: 0,
      currentEncounter: null,
      xpEarned: 0,
      pointsEarned: 0,
      failed: false,
      threat: 0
    });

    await db.updateTravelerData(message.author.id, {
      activeCompanions
    });

    return message.reply(
`📜 ${mission.titulo}

📍 Destino: ${mission.destino}

${mission.descripcion}

Usa !desafiar para comenzar el viaje.`
    );
  }

  if (command === "!interactuar") {
    if (!expeditions.has(message.author.id)) {
      return message.reply("No estás en una expedición.");
    }
  
    const expedition = expeditions.get(message.author.id);
    const profile = await db.getProfile(message.author.id);
    const owned = getOwnedCompanions(profile);
  
    if (!expedition.currentEncounter) {
      return message.reply("No hay ningún encuentro activo.");
    }
  
    if (expedition.currentEncounter.tipo !== "evento_especial") {
      return message.reply("No hay nada con lo que interactuar aquí.");
    }
  
    expedition.affinityLog = expedition.affinityLog || {};
  
    const chosen = pickCompanionForScene(profile, expedition.currentEncounter);
    const xp = expedition.currentEncounter.xp || 10;
  
    expedition.xpEarned += xp;
    expedition.progress += 1;
  
    let texto = `Has decidido involucrarte en la situación.\n\n📚 +${xp} XP`;
  
    if (chosen) {
      const gain = getAffinityGain(chosen, expedition.currentEncounter, "interaccion", "interaccion");
      expedition.affinityLog[chosen] = (expedition.affinityLog[chosen] || 0) + gain;
      await db.addAffinity(message.author.id, chosen, gain);
  
      const companionName = companions[chosen]?.nombre || chosen;
      const reaction = await companionReaction(chosen, expedition.currentEncounter, "interaccion");
  
      texto += `\n🤝 Afinidad con **${companionName}**: +${gain}`;
      if (reaction) {
        texto += `\n\n💬 ${reaction}`;
      }
    }
  
    if (owned.includes("faelon")) {
      const saludActual = profile.salud !== undefined ? profile.salud : 100;
      const nuevaSalud = Math.min(100, saludActual + 10);
  
      if (nuevaSalud !== saludActual) {
        await db.updateTravelerData(message.author.id, { salud: nuevaSalud });
        texto += `\n❤️ Faelon restaura +10 salud (${nuevaSalud}/100).`;
      }
    }
  
    const reactions = [];
    for (const cid of [...new Set(owned)].slice(0, 3)) {
      if (cid === chosen) continue;
      const line = await companionReaction(cid, expedition.currentEncounter, "interaccion");
      if (line) reactions.push(`💬 ${line}`);
    }
  
    expedition.currentEncounter = null;
  
    texto += `\n\n🛤️ Continúas tu viaje.\nUsa !desafiar para seguir avanzando.`;
  
    if (reactions.length) {
      texto += `\n\n${reactions.join("\n")}`;
    }
  
    return message.reply(texto);
  }

  if (command === "!continuar" || command === "!ignorar") {
    return message.reply("Usa !interactuar o !volver.");
  }

  if (command === "!volver") {
    if (!expeditions.has(message.author.id)) {
      return message.reply("No estás en una expedición.");
    }
  
    expeditions.delete(message.author.id);
    await clearExpeditionParty(message.author.id);
  
    return message.reply("⛺ Regresas a salvo al campamento base. Expedición terminada.");
  }

  if (command === "!desafiar") {
    if (!expeditions.has(message.author.id)) {
      return message.reply("No estás en ninguna expedición activa. Elige una en el tablón con `!tablon`.");
    }
  
    const expedition = expeditions.get(message.author.id);
    const profile = await db.getProfile(message.author.id);
    const owned = getOwnedCompanions(profile);
    const xpActual = profile.xp || 0;
    const nivelJugador = typeof db.calculateLevel === "function"
      ? db.calculateLevel(xpActual)
      : Math.floor(xpActual / 1000) + 1;
  
    expedition.affinityLog = expedition.affinityLog || {};
  
    const recordAffinity = async (compId, encounter, mode, outcome) => {
      const gain = getAffinityGain(compId, encounter, mode, outcome);
      expedition.affinityLog[compId] = (expedition.affinityLog[compId] || 0) + gain;
      await db.addAffinity(message.author.id, compId, gain);
      return gain;
    };
  
    const healWithFaelon = async () => {
      if (!owned.includes("faelon")) return null;
  
      const saludActual = profile.salud !== undefined ? profile.salud : 100;
      const nuevaSalud = Math.min(100, saludActual + 10);
  
      if (nuevaSalud !== saludActual) {
        await db.updateTravelerData(message.author.id, { salud: nuevaSalud });
      }
  
      return { saludActual, nuevaSalud };
    };
  
    if (expedition.failed) {
      return message.reply("La expedición ha fracasado o concluido. Usa !volver para regresar al campamento.");
    }
  
    if (expedition.currentEncounter === null) {
      const encuentroId = expedition.mission.encuentros?.[expedition.progress];
  
      if (!encuentroId) {
        const beforeProfile = await db.getProfile(message.author.id);
        const beforeLevel = typeof db.calculateLevel === "function"
          ? db.calculateLevel(beforeProfile.xp || 0)
          : Math.floor((beforeProfile.xp || 0) / 1000) + 1;
        const beforeRank = obtenerRango(beforeProfile.points || 0);
  
        const xpTotal = expedition.xpEarned + (expedition.mission.xp || 0);
        const puntosTotal = expedition.pointsEarned + (expedition.mission.puntos || 0);
  
        await db.addXP(message.author.id, xpTotal);
        await db.addPoints(message.author.id, puntosTotal);
  
        const afterProfile = await db.getProfile(message.author.id);
        const afterLevel = typeof db.calculateLevel === "function"
          ? db.calculateLevel(afterProfile.xp || 0)
          : Math.floor((afterProfile.xp || 0) / 1000) + 1;
        const afterRank = obtenerRango(afterProfile.points || 0);
  
        const affinityEntries = Object.entries(expedition.affinityLog || {});
        const affinityText = affinityEntries.length
          ? affinityEntries
              .map(([id, value]) => `• **${companions[id]?.nombre || id}**: +${value} afinidad`)
              .join("\n")
          : "• Ninguna";
  
        const finalReactions = [];
        for (const cid of owned.slice(0, 3)) {
          const line = await companionReaction(cid, expedition.mission, "mision_completada");
          if (line) finalReactions.push(`💬 ${line}`);
        }
  
        await clearExpeditionParty(message.author.id);
        expeditions.delete(message.author.id);
  
        let textoFinal = `🎉 **Misión completada con éxito**\n\n${expedition.mission.textoExito || "¡Has completado con éxito la expedición!"}\n\n🏆 Puntos obtenidos: +${puntosTotal}\n📚 XP obtenida: +${xpTotal}\n\n🤝 Afinidad ganada:\n${affinityText}`;
  
        if (afterLevel > beforeLevel) {
          textoFinal += `\n\n📚 **Ascenso de nivel**\n¡Felicidades! Has subido al nivel **${afterLevel}**.`;
        }
  
        if (afterRank !== beforeRank) {
          textoFinal += `\n🏅 **Ascenso de rango**\n¡Felicidades! Has ascendido de rango, ahora eres conocido como **${afterRank}**.`;
        }
  
        if (finalReactions.length) {
          textoFinal += `\n\n${finalReactions.join("\n")}`;
        }
  
        return message.reply(textoFinal);
      }
  
      const encounters = await loadEncounters();
      const destino = normalizeKey(expedition.mission.destino);
  
      let lista = encounters.filter(e => {
        const coincideEncuentro = e.tipo === encuentroId || e.categoria === encuentroId;
        const coincideRegion = Array.isArray(e.region) && e.region.some(r => normalizeKey(r) === destino);
        return coincideEncuentro && coincideRegion;
      });
  
      if (owned.includes("nieriel")) {
        const safe = lista.filter(e => (e.peligro ?? 0) <= nivelJugador);
        if (safe.length) lista = safe;
      }
  
      if (!lista.length) {
        await clearExpeditionParty(message.author.id);
        expedition.failed = true;
        expeditions.delete(message.author.id);
        return message.reply("⚠️ No se encontraron encuentros válidos para esta misión. La expedición ha sido cancelada.");
      }
  
      const encounterBase = lista[Math.floor(Math.random() * lista.length)];
      const encounterFinal = chooseEncounterVariant(encounterBase, encounters);
  
      expedition.currentEncounter = encounterFinal;
  
      let comandos =
        encounterFinal.tipo === "evento_especial"
          ? "\n\nComandos:\n!interactuar\n!volver"
          : "\n\nComandos:\n!desafiar\n!volver";
  
      const peligroTexto = encounterFinal.peligro ? getDangerText(encounterFinal.peligro) : "Ninguno";
      let textoEncuentro = `⚔️ **${encounterFinal.titulo}**\n\n${encounterFinal.descripcion || "Te adentras en territorio desconocido..."}\n\nPeligro: ${peligroTexto}${comandos}`;
  
      const reactionIds = [...new Set(owned)].slice(0, 3);
      const reactions = [];
  
      for (const cid of reactionIds) {
        const line = await companionReaction(cid, encounterFinal, "encounter");
        if (line) reactions.push(`💬 ${line}`);
      }
  
      if (reactions.length) {
        textoEncuentro += `\n\n${reactions.join("\n")}`;
      }
  
      return message.reply(textoEncuentro);
    }
  
    const activeEncounter = expedition.currentEncounter;
  
    if (activeEncounter.tipo === "evento_especial") {
      return message.reply("Este es un evento especial. Revisa las opciones anteriores para interactuar (usa !interactuar o !volver).");
    }
  
    const bonuses = getCompanionBonus(profile);
  
    let affinityBonus = 0;
    for (const comp of owned) {
      affinityBonus += getAffinityBonus(profile, comp);
    }
  
    let baseSuccess = 0.65 + bonuses.captainBonus + bonuses.rangerBonus + affinityBonus;
    if ((activeEncounter.peligro || 0) >= 4) baseSuccess += bonuses.strongEnemyBonus;
    if (activeEncounter.tipo === "enemigo_numeroso") baseSuccess += bonuses.numerousEnemyBonus;
    if (activeEncounter.tipo === "jefe") baseSuccess += 0.05;
  
    const success = Math.random() < Math.min(baseSuccess, 0.95);
  
    if (success) {
      const xpGanada = activeEncounter.xp || 10;
      const puntosGanados = activeEncounter.puntos || 5;
  
      expedition.xpEarned += xpGanada;
      expedition.pointsEarned += puntosGanados;
      expedition.progress += 1;
  
      const encounterSnapshot = activeEncounter;
      expedition.currentEncounter = null;
  
      let textoVictoria = `✅ **Éxito**\n\nHas superado el desafío de *${encounterSnapshot.titulo}*.\n\n+${xpGanada} XP`;
      if (puntosGanados > 0) textoVictoria += `\n+${puntosGanados} Puntos`;
  
      const affinityGained = [];
      for (const cid of [...new Set(owned)]) {
        const gain = await recordAffinity(cid, encounterSnapshot, "victoria", "victoria");
        affinityGained.push(`• **${companions[cid]?.nombre || cid}**: +${gain} afinidad`);
      }
  
      if (affinityGained.length) {
        textoVictoria += `\n\n🤝 Afinidad ganada:\n${affinityGained.join("\n")}`;
      }
  
      const faelonHeal = await healWithFaelon();
      if (faelonHeal) {
        textoVictoria += `\n❤️ Faelon restaura +10 salud (${faelonHeal.nuevaSalud}/100).`;
      }
  
      const reactionIds = [...new Set(owned)].slice(0, 3);
      const reactions = [];
      for (const cid of reactionIds) {
        const line = await companionReaction(cid, encounterSnapshot, "victoria");
        if (line) reactions.push(`💬 ${line}`);
      }
      if (reactions.length) {
        textoVictoria += `\n\n${reactions.join("\n")}`;
      }
  
      if (expedition.progress < (expedition.mission.encuentros?.length || 0)) {
        textoVictoria += `\n\n🛤️ El camino continúa.\n\nUsa !desafiar para seguir viajando.`;
        return message.reply(textoVictoria);
      }
  
      const beforeProfile = await db.getProfile(message.author.id);
      const beforeLevel = typeof db.calculateLevel === "function"
        ? db.calculateLevel(beforeProfile.xp || 0)
        : Math.floor((beforeProfile.xp || 0) / 1000) + 1;
      const beforeRank = obtenerRango(beforeProfile.points || 0);
  
      const xpTotal = expedition.xpEarned + (expedition.mission.xp || 0);
      const puntosTotal = expedition.pointsEarned + (expedition.mission.puntos || 0);
  
      await db.addXP(message.author.id, xpTotal);
      await db.addPoints(message.author.id, puntosTotal);
  
      const afterProfile = await db.getProfile(message.author.id);
      const afterLevel = typeof db.calculateLevel === "function"
        ? db.calculateLevel(afterProfile.xp || 0)
        : Math.floor((afterProfile.xp || 0) / 1000) + 1;
      const afterRank = obtenerRango(afterProfile.points || 0);
  
      const finalAffinityEntries = Object.entries(expedition.affinityLog || {});
      const finalAffinityText = finalAffinityEntries.length
        ? finalAffinityEntries
            .map(([id, value]) => `• **${companions[id]?.nombre || id}**: +${value} afinidad`)
            .join("\n")
        : "• Ninguna";
  
      const finalReactions = [];
      for (const cid of owned.slice(0, 3)) {
        const line = await companionReaction(cid, expedition.mission, "mision_completada");
        if (line) finalReactions.push(`💬 ${line}`);
      }
  
      await clearExpeditionParty(message.author.id);
      expeditions.delete(message.author.id);
  
      textoVictoria += `\n\n🎉 **Misión completada con éxito**\n\n${expedition.mission.textoExito || "¡Has completado con éxito la expedición!"}\n\n🏆 Puntos obtenidos: +${puntosTotal}\n📚 XP obtenida: +${xpTotal}\n\n🤝 Afinidad ganada:\n${finalAffinityText}`;
  
      if (afterLevel > beforeLevel) {
        textoVictoria += `\n\n📚 **Ascenso de nivel**\n¡Felicidades! Has subido al nivel **${afterLevel}**.`;
      }
  
      if (afterRank !== beforeRank) {
        textoVictoria += `\n🏅 **Ascenso de rango**\n¡Felicidades! Has ascendido de rango, ahora eres conocido como **${afterRank}**.`;
      }
  
      if (finalReactions.length) {
        textoVictoria += `\n\n${finalReactions.join("\n")}`;
      }
  
      return message.reply(textoVictoria);
    }
  
    const saludActual = profile.salud !== undefined ? profile.salud : 100;
  
    if (owned.length > 0 && Math.random() < 0.15) {
      const salvadorId = owned[Math.floor(Math.random() * owned.length)];
      const salvador = companions[salvadorId]?.nombre || "Un compañero";
      const reaction = await companionReaction(salvadorId, activeEncounter, "salvacion");
  
      return message.reply(
        `🛡️ **¡Salvado por los pelos!**\n\n${salvador} interviene en el último segundo, bloqueando el ataque de *${activeEncounter.titulo}*.\n\n❤️ Salud intacta: ${saludActual}/100\n\n${reaction ? `💬 ${reaction}\n\n` : ""}Usa \`!desafiar\` para intentarlo de nuevo o \`!volver\` para huir.`
      );
    }
  
    let danoEnemigo = activeEncounter.dano || Math.floor(Math.random() * 25) + 20;
    danoEnemigo = Math.floor(danoEnemigo * (1 - bonuses.damageReduction));
  
    const nuevaSalud = saludActual - danoEnemigo;
  
    const affinityGainedLoss = [];
    for (const cid of [...new Set(owned)]) {
      const gain = await recordAffinity(cid, activeEncounter, "derrota", "derrota");
      affinityGainedLoss.push(`• **${companions[cid]?.nombre || cid}**: +${gain} afinidad`);
    }
  
    const reactionIds = [...new Set(owned)].slice(0, 3);
    const reactions = [];
    for (const cid of reactionIds) {
      const line = await companionReaction(cid, activeEncounter, "derrota");
      if (line) reactions.push(`💬 ${line}`);
    }
  
    if (nuevaSalud <= 0) {
      await db.updateTravelerData(message.author.id, {
        activeCompanions: [],
        salud: 100
      });
      expeditions.delete(message.author.id);
  
      return message.reply(
        `💀 **Has caído en combate**\n\nEl ataque de *${activeEncounter.titulo}* fue demasiado fuerte. Recibes ${danoEnemigo} de daño.\n\nLa expedición fracasa. Eres rescatado y devuelto al campamento.\n\n*(Tu salud ha sido restaurada)*\n\n🤝 Afinidad ganada:\n${affinityGainedLoss.length ? affinityGainedLoss.join("\n") : "• Ninguna"}${reactions.length ? `\n\n${reactions.join("\n")}` : ""}`
      );
    }
  
    await db.updateTravelerData(message.author.id, { salud: nuevaSalud });
  
    return message.reply(
      `⚠️ **Recibes Daño**\n\nRecibes ${danoEnemigo} de daño en *${activeEncounter.titulo}*.\n\n❤️ Salud restante: ${nuevaSalud}/100\n\n🤝 Afinidad ganada:\n${affinityGainedLoss.length ? affinityGainedLoss.join("\n") : "• Ninguna"}\n\nUsa \`!desafiar\` para reintentar o \`!volver\` para huir.${reactions.length ? `\n\n${reactions.join("\n")}` : ""}`
    );
  }

  // ========================================
  // SISTEMA DE TRIVIA
  // ========================================
  if (command === "!trivia") {
    const state = await db.getQuotaState(message.author.id, "trivia", TRIVIA_WINDOW_MS);

    if (state.attempts >= TRIVIA_LIMIT) {
      return message.reply(
        `⚠️ Agotaste tus intentos. Vuelve en ${formatRemainingTime(state.resetAt - Date.now())}.`
      );
    }

    const difficulty = normalizeDifficulty(args[1] || "normal");
    const allowed = ["facil", "normal", "dificil", "legendario"];

    if (!allowed.includes(difficulty)) {
      return message.reply("⚠️ Dificultad inválida. Usa: `!trivia facil`, `!trivia normal`, `!trivia dificil` o `!trivia legendario`.");
    }

    const questions = await loadQuestions();
    const filtered = questions.filter(q => normalizeDifficulty(q.dificultad || q.difficulty || "normal") === difficulty);

    if (!filtered.length) {
      return message.reply(`No hay preguntas de dificultad: **${difficulty}**.`);
    }

    const question = filtered[Math.floor(Math.random() * filtered.length)];
    const correctAnswer = question.respuestaCorrecta || question.respuesta || question.answer || "";
    const options = difficulty === "facil" ? [] : (question.opciones || question.options || []);
    const showOptions = difficulty !== "facil" && Array.isArray(options) && options.length > 0;

    const timeout = setTimeout(async () => {
      triviaGames.delete(message.author.id);
      await db.addWrongAnswer(message.author.id);
      await message.channel.send(`⌛ Tiempo agotado para <@${message.author.id}>.\n\nLa respuesta correcta era: ||${correctAnswer}||`);
    }, 15000);

    triviaGames.set(message.author.id, {
      question,
      difficulty,
      options: showOptions ? options : [],
      timeout
    });

    await db.setQuotaState(
      message.author.id,
      "trivia",
      state.attempts + 1,
      state.resetAt
    );

    let promptText =
      `📚 **Pregunta de Trivia (${difficulty.toUpperCase()})**\n` +
      `**Intento ${state.attempts + 1}/${TRIVIA_LIMIT}**\n\n` +
      `${question.pregunta || question.question}`;

    if (showOptions) {
      options.forEach((op, index) => {
        promptText += `\n${index + 1}️⃣ ${op}`;
      });
    }

    promptText += `\n\n⏳ Tienes 15 segundos`;
    return message.reply(promptText);
  }

  // Comandos de Roleplay Directo con los Compañeros
  const companionCommands = {
    "!al": "alteru", "!c": "cirdil", "!d": "duilon", "!an": "andaer", "!n": "nieriel", "!f": "faelon", "!m": "montaraces"
  };

  if (companionCommands[command]) {
    const companionId = companionCommands[command];
    const mensaje = content.slice(args[0].length).trim();
    if (!mensaje) return message.reply("Escribe algo después del comando.");

    const personaje = getPersonaje(companionId);
    if (!personaje) return message.reply("Ese compañero no está disponible.");

    const profile = await db.getProfile(message.author.id);
    const affinity = (profile.affinity || {})[companionId] || 0;

    const prompt = `
Eres ${personaje.nombre}.
Personalidad: ${personaje.personalidad || personaje.descripcion || personaje.tono || ""}
Arma: ${personaje.arma || "No especificada"} | Armadura: ${personaje.armadura || "No especificada"}
Afinidad con el viajero: ${affinity}

Trata al viajero según esta escala:
0-24 desconocido, 25-49 conocido, 50-74 aliado, 75-99 amigo cercano, 100 compañero de confianza

Responde con una sola línea corta (máximo 12 palabras). Coloca tu nombre antes del diálogo.
`.trim();

    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: prompt }], temperature: 0.9, max_tokens: 40 })
      });
      const data = await res.json();
      const respuesta = data?.choices?.[0]?.message?.content?.trim() || "*asiente*";

      await db.addAffinity(message.author.id, companionId, 1);
      return message.reply(`${personaje.nombre}: ${compactLine(respuesta, 12)}`);
    } catch {
      return message.reply(`${personaje.nombre}: *asiente en silencio*`);
    }
  }

  // Comando de Roleplay Principal con Altéru (!a)
  if (command === '!a') {
    const prompt = content.slice(args[0].length).trim();
    const profile = await db.getProfile(message.author.id);
    const text = prompt.toLowerCase();

    if (!profile.race) {
      const races = ["elfo", "enano", "hobbit", "hombre", "beornida", "beórnida"];
      const foundRace = races.find(r => text.includes(r));
      if (foundRace) await db.updateTravelerData(message.author.id, { race: foundRace });
    }

    if (profile.race && !profile.class) {
      const classes = ["guardian", "guardián", "campeon", "campeón", "cazador", "capitan", "capitán", "maestre del saber", "minstrel", "burglar", "runekeeper", "warden", "brawler", "mariner"];
      const foundClass = classes.find(c => text.includes(c));
      if (foundClass) await db.updateTravelerData(message.author.id, { class: foundClass });
    }

    if (!prompt) return message.reply('Escribe algo después de !a para hablar con Altéru.');

    try {
      if (!loreCache) loreCache = await loadAlteruLore();
      await message.channel.sendTyping();
      const reply = await askOpenRouter(message.author.id, prompt, loreCache);
      return message.reply(reply);
    } catch {
      return message.reply("No puedo responder ahora.");
    }
  }
});

client.login(DISCORD_TOKEN);
