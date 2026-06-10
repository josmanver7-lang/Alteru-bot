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
// CONFIGURACIÓN Y CONSTANTES
// ================================
const ADMIN_USER_ID = process.env.ADMIN_USER_ID || process.env.OWNER_ID;

const TRIVIA_LIMIT = 3;
const TRIVIA_WINDOW_MS = 12 * 60 * 60 * 1000;

const EXPEDITION_LIMIT = 2;
const EXPEDITION_WINDOW_MS = 12 * 60 * 60 * 1000;

// Caches y mapas de control global
let personajesCache = {};
let loreCache = null;
const triviaGames = new Map();
const expeditions = new Map();

// Base de Datos Estática de Compañeros locales
const companions = {
  montaraces: { nombre: "Montaraces del Norte", clase: "Exploradores", habilidad: "+15% de efectividad en exploración", coste: 150, nivel: 1 },
  alteru: { nombre: "Altéru Amän", clase: "Capitán", habilidad: "+20% de experiencia general", coste: 0, nivel: 1 },
  cirdil: { nombre: "Círdil", clase: "Guardián", habilidad: "+15% vs enemigos poderosos y 20% reducción de daño", coste: 100, nivel: 5 },
  duilon: { nombre: "Duilon", clase: "Campeón", habilidad: "+25% vs grupos de enemigos numerosos", coste: 120, nivel: 5 },
  andaer: { nombre: "Andaer", clase: "Cazador", habilidad: "+20% de probabilidad de bloqueo táctico", coste: 80, nivel: 3 },
  nieriel: { nombre: "Nieriel", clase: "Caballero del Cisne", habilidad: "+10% de inspiración heroica general", coste: 200, nivel: 10 },
  faelon: { nombre: "Faelon", clase: "Sanador (Elfo)", habilidad: "Sanación en eventos especiales y encuentros sociales", coste: 90, nivel: 4 }
};

// ================================
// FUNCIONES HELPERS
// ================================

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
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

function getPersonaje(id) {
  return personajesCache[normalizeKey(id)] || null;
}

function getOwnedCompanions(profile) {
  const list = profile?.activeCompanions?.length
    ? profile.activeCompanions
    : (profile?.hiredCompanions || profile?.companions || []);

  return [...new Set(list.map(normalizeKey))];
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
    rangerBonus: list.includes("montaraces") ? 0.15 : 0,
    damageReduction: list.includes("cirdil") ? 0.20 : 0
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

function summarizePersonality(id) {
  const p = getPersonaje(id);
  return p?.personalidad || p?.descripcion || "Reservado y leal.";
}

function pickCompanionForScene(profile, encounter) {
  const list = getOwnedCompanions(profile);
  if (!list.length) return null;
  return list[Math.floor(Math.random() * list.length)];
}

// Simuladores estáticos de carga de archivos de configuración externos
async function loadQuestions() { return []; }
async function loadMissions() { return []; }
async function loadAlteruLore() { return "Lore de Middle-earth y Altéru."; }

// ================================
// LLAMADAS CHAT COMPLETIONS (OPENROUTER)
// ================================

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

// ================================
// INICIALIZACIÓN DEL BOT DISCORD
// ================================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

client.once("clientReady", async () => {
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
      : parsed;
  } catch {
    personajesCache = {};
  }

  console.log(`Logged in as ${client.user.tag}`);
});

// ================================
// EVENTO PRINCIPAL MESSAGECREATE
// ================================

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const content = message.content;
  const textNormalize = normalizeText(content);

  // --------------------------------
  // CONTROL ACTIVO DE TRIVIA
  // --------------------------------
  if (triviaGames.has(message.author.id)) {
    const game = triviaGames.get(message.author.id);

    const correctRaw = game.question.respuestaCorrecta || game.question.respuesta || game.question.answer || "";
    const correctNormalize = normalizeText(correctRaw);

    let isCorrect = textNormalize === correctNormalize;

    const indexMap = {
      a: 0, b: 1, c: 2, d: 3,
      1: 0, 2: 1, 3: 2, 4: 3
    };

    if (!isCorrect && Array.isArray(game.options) && game.options.length) {
      const selectedIndex = indexMap[textNormalize];
      if (selectedIndex !== undefined && game.options[selectedIndex]) {
        const selectedAnswer = normalizeText(game.options[selectedIndex]);
        isCorrect = selectedAnswer === correctNormalize;
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
        game.difficulty === "legendario" ? 80 : 20;

      await db.addCorrectAnswer(message.author.id, points);
      return message.reply(`🎉 ¡Correcto! +${points} puntos.`);
    }

    if (!content.startsWith("!")) {
      clearTimeout(game.timeout);
      triviaGames.delete(message.author.id);
      await db.addWrongAnswer(message.author.id);

      return message.reply(`❌ Incorrecto. La respuesta correcta era: ||${correctRaw}||.`);
    }
  }

  // Filtrado básico de comandos
  if (!content.startsWith("!")) return;

  const args = content.split(/\s+/);
  const command = args[0].toLowerCase();

  // --------------------------------
  // COMANDO !A (ROLEPLAY CON ALTÉRU)
  // --------------------------------
  if (command === '!a') {
    const promptText = content.slice(args[0].length).trim();
    const profile = await db.getProfile(message.author.id);

    if (!profile.race) {
      const races = ["elfo", "enano", "hobbit", "hombre", "beornida", "beórnida"];
      const foundRace = races.find(r => textNormalize.includes(r));
      if (foundRace) await db.updateTravelerData(message.author.id, { race: foundRace });
    }

    if (profile.race && !profile.class) {
      const classes = ["guardian", "guardián", "campeon", "campeón", "cazador", "capitan", "capitán", "maestre del saber", "minstrel", "burglar", "runekeeper", "warden", "brawler", "mariner"];
      const foundClass = classes.find(c => textNormalize.includes(c));
      if (foundClass) await db.updateTravelerData(message.author.id, { class: foundClass });
    }

    if (!promptText) return message.reply('Escribe algo después de !a para hablar con Altéru.');

    try {
      const pAlt = getPersonaje("alteru") || companions.alteru;
      const resText = "*El capitán te escucha atentamente y responde con sabiduría mercenaria...*";
      return message.reply(`${pAlt.nombre}: ${compactLine(resText, 12)}`);
    } catch {
      return message.reply(`Altéru Amän: *asiente en silencio*`);
    }
  }

  // --------------------------------
  // COMANDO !TRIVIA
  // --------------------------------
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

  // --------------------------------
  // COMANDOS DE RESETEO ADMINISTRATIVO
  // --------------------------------
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

  // --------------------------------
  // COMANDOS DE COMPAÑEROS (!COMPANEROS / !COMPAÑEROS)
  // --------------------------------
  if (command === "!companeros" || command === "!compañeros") {
    let texto = "🤝 Compañeros disponibles\n\n";
    const orden = ["montaraces", "alteru", "cirdil", "duilon", "andaer", "nieriel", "faelon"];

    for (const id of orden) {
      const comp = companions[id];
      const req = comp.nivel ? `Nivel ${comp.nivel}` : "Ninguno";
      const personalidad = summarizePersonality(id);

      texto += `${getCompanionIcon(id)} **${comp.nombre}** — ${comp.clase}\n`;
      texto += `Habilidad: ${comp.habilidad}\n`;
      texto += `Coste: ${comp.coste} pts\n`;
      texto += `Requisito: ${req}\n`;
      texto += `Personalidad: ${personalityShort(personalidad)}\n\n`;
    }

    return message.reply(texto);
  }

  // --------------------------------
  // COMANDO !GRUPO
  // --------------------------------
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

  // --------------------------------
  // COMANDO !CONTRATAR
  // --------------------------------
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

  // --------------------------------
  // COMANDO !TABLON
  // --------------------------------
  if (command === "!tablon") {
    const missions = await loadMissions();
    let texto = "**Te acercas al tablón de anuncios y ves varias expediciones.**\n\n";

    missions.slice(0, 5).forEach((m, i) => {
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
      const personalidad = summarizePersonality(id);
      texto += `${getCompanionIcon(id)} **${comp.nombre}** — ${comp.clase}\n`;
      texto += `Habilidad: ${comp.habilidad}\n`;
      texto += `Coste: ${comp.coste} pts\n`;
      texto += `Requisito: ${req}\n`;
      texto += `Personalidad: ${personalityShort(personalidad)}\n\n`;
    }

    texto += "Usa !contratar <nombre>\n";
    texto += "Usa !expedicion <numero>";
    return message.reply(texto);
  }

  // --------------------------------
  // COMANDO !EXPEDICION
  // --------------------------------
  if (command === "!expedicion") {
    const state = await db.getQuotaState(message.author.id, "expedicion", EXPEDITION_WINDOW_MS);

    if (state.attempts >= EXPEDITION_LIMIT) {
      return message.reply(`⚠️ Agotaste tus expediciones. Vuelve en ${formatRemainingTime(state.resetAt - Date.now())}.`);
    }

    const numero = parseInt(args[1]);
    if (isNaN(numero)) return message.reply("Usa !expedicion <numero>");

    const missions = await loadMissions();
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

  // --------------------------------
  // COMANDO !INTERACTUAR
  // --------------------------------
  if (command === "!interactuar") {
    if (!expeditions.has(message.author.id)) {
      return message.reply("No estás en una expedición.");
    }

    const expedition = expeditions.get(message.author.id);

    if (!expedition.currentEncounter) {
      return message.reply("No hay ningún encuentro activo.");
    }

    if (expedition.currentEncounter.tipo !== "evento_especial") {
      return message.reply("No hay nada con lo que interactuar aquí.");
    }

    const profile = await db.getProfile(message.author.id);

    const xp = expedition.currentEncounter.xp || 10;
    expedition.xpEarned += xp;
    expedition.progress += 1;

    const chosen = pickCompanionForScene(profile, expedition.currentEncounter);
    let texto = `Has decidido involucrarte en la situación.\n\n📚 +${xp} XP\n\n🛤️ Continúas tu viaje.\n\nUsa !desafiar para seguir avanzando.`;

    if (chosen) {
      const reaction = await companionReaction(chosen, expedition.currentEncounter, "interaccion");
      if (reaction) texto += `\n\n💬 ${reaction}`;
      await db.addAffinity(message.author.id, chosen, getAffinityGain(chosen, expedition.currentEncounter, "interaccion", "interaccion"));
    }

    expedition.currentEncounter = null;
    return message.reply(texto);
  }

  // --------------------------------
  // COMANDO !DESAFIAR Y FINAL DE EXPEDICIÓN
  // --------------------------------
  if (command === "!desafiar") {
    if (!expeditions.has(message.author.id)) {
      return message.reply("No estás en una expedición.");
    }

    const expedition = expeditions.get(message.author.id);
    const profile = await db.getProfile(message.author.id);

    // Condición de salida: Si ya no quedan encuentros o la expedición llegó a su fin
    const totalEncounters = expedition.mission.encuentros || 3; 
    if (expedition.progress >= totalEncounters || expedition.failed) {
      
      // BLOCK: FINAL DE EXPEDICIÓN
      const activeIds = getOwnedCompanions(profile);
      const affinityGained = await applyAffinityToParty(message.author.id, profile, expedition.mission, "mision_completada", "victoria");

      const xpTotal = expedition.xpEarned + (expedition.mission.xp || 0);
      const puntosTotal = expedition.pointsEarned + (expedition.mission.puntos || 0);

      await db.addXP(message.author.id, xpTotal);
      await db.addPoints(message.author.id, puntosTotal);

      const finalReactions = [];
      for (const cid of activeIds.slice(0, 3)) {
        const line = await companionReaction(cid, expedition.mission, "mision_completada");
        if (line) finalReactions.push(`💬 ${line}`);
      }

      await db.updateTravelerData(message.author.id, {
        activeCompanions: []
      });

      expeditions.delete(message.author.id);

      return message.reply(
`🎉 **Misión completada con éxito**

${expedition.mission.textoExito || "¡Has completado con éxito la expedición!"}

🏆 Puntos obtenidos: +${puntosTotal}
📚 XP obtenida: +${xpTotal}
🤝 Afinidad adquirida: +${affinityGained}

${finalReactions.join("\n")}`.trim()
      );
    }

    // Generación lógica de un encuentro aleatorio simulado
    const encounter = {
      id: `m_${expedition.missionId}_enc_${expedition.progress}`,
      titulo: "Encuentro en los Caminos Salvajes",
      tipo: expedition.progress % 2 === 0 ? "enemigo_numeroso" : "enemigo_poderoso",
      categoria: "exploracion",
      descripcion: "Una fuerza imprevista intercepta al grupo entre las sombras.",
      peligro: 4
    };

    expedition.currentEncounter = encounter;
    let textoEncuentro = `🛤️ **Progreso de la expedición: (${expedition.progress + 1}/${totalEncounters})**\n\n**${encounter.titulo}**\n${encounter.descripcion}`;

    // BLOCK: REACCIONES AL GENERAR EL ENCUENTRO
    const reactionIds = [...new Set(getOwnedCompanions(profile))].slice(0, 3);
    const reactions = [];

    for (const cid of reactionIds) {
      const line = await companionReaction(cid, encounter, "encounter");
      if (line) reactions.push(`💬 ${line}`);
    }

    if (reactions.length) {
      textoEncuentro += `\n\n${reactions.join("\n")}`;
    }

    // Resolución directa interna (Éxito simulado en este punto de ejemplo)
    const activeEncounter = encounter;
    const outcome = "victoria"; 

    if (outcome === "victoria") {
      const affinityGained = await applyAffinityToParty(message.author.id, profile, activeEncounter, "victoria", "victoria");
      expedition.xpEarned += 20;
      expedition.pointsEarned += 10;
      textoEncuentro += `\n\n⚔️ **¡Desafío superado!** Afinidad ganada: +${affinityGained}. Escribe !desafiar de nuevo para seguir.`;
    } else {
      const affinityGainedLoss = await applyAffinityToParty(message.author.id, profile, activeEncounter, "derrota", "derrota");
      textoEncuentro += `\n\n❌ **Fracaso en el encuentro.** Cohesión de grupo afectada: +${affinityGainedLoss}.`;
    }

    expedition.progress += 1;
    return message.reply(textoEncuentro);
  }
});

function personalityShort(text) {
  const parts = String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (!parts.length) return "Sin definir";
  return parts.slice(0, 2).join(" ");
}

client.login(DISCORD_TOKEN);
