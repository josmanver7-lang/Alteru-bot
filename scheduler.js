import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as db from "./database.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EVENT_CHANNEL_ID = process.env.ANNOUNCEMENTS_CHANNEL_ID || "1514198998838284288";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.OPENROUTER_MODEL || "google/gemini-2.5-flash";

const TWELVE_HOURS = 12 * 60 * 60 * 1000;
const MERCHANT_OPEN_MS = 2 * 60 * 60 * 1000;

const CARACAS_OFFSET_MS = -4 * 60 * 60 * 1000;
const CYCLE_TIMES = [
  { hour: 11, minute: 30 },
  { hour: 23, minute: 30 }
];

const companionIds = ["alteru", "cirdil", "duilon", "andaer", "nieriel", "faelon", "montaraces"];

const companionNames = {
  alteru: "Altéru",
  cirdil: "Círdil",
  duilon: "Duilon",
  andaer: "Andaer",
  nieriel: "Nieriel",
  faelon: "Faelon",
  montaraces: "Montaraces de Arathir"
};

const merchantNames = [
  "Barahir",
  "Mablung",
  "Berenil",
  "Galdor",
  "Rúmil",
  "Thalion",
  "Ithron",
  "Haldir"
];

const merchantCities = [
  "Calembel", "Linhir", "Pelargir", "Morlad", "Sardol", "Ost Ardnír", "Dínadab",
  "Lothgobel", "Ethring", "Ost Anglebed", "Bâr Húrin", "Dol Amroth", "Arnach",
  "Minas Tirith", "Ost Rimmon", "Folde Este", "Andrast", "Edoras", "Folde Oeste",
  "Bree", "Esteldín", "Combe", "Cair Andros", "Ciudad de Valle", "Ost Guruth"
];

let schedulerPersonajesCache = {};
let merchantCloseTimer = null;
let boundaryTimer = null;
let cycleEventTimers = [];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomBetween(minMs, maxMs) {
  return Math.floor(minMs + Math.random() * (maxMs - minMs));
}

function truncate(text, max = 1800) {
  const clean = String(text || "").trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1).trimEnd() + "…";
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

function formatRemainingTime(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatPrice(value) {
  return `${Math.max(1, Math.round(Number(value || 0)))} pts`;
}

function formatEffect(effect = {}) {
  const parts = [];
  if (effect.salud) parts.push(`Salud +${effect.salud}`);
  if (effect.damageBonus) parts.push(`Daño +${effect.damageBonus}`);
  if (effect.successBonus) parts.push(`Éxito +${Math.round(effect.successBonus * 100)}%`);
  if (effect.damageReduction) parts.push(`Daño recibido -${Math.round(effect.damageReduction * 100)}%`);
  if (effect.afinidad) parts.push(`Afinidad +${effect.afinidad}`);
  if (effect.soloProximaExpedicion) parts.push("Solo próxima expedición");
  if (effect.soloProximoEncuentro) parts.push("Solo próximo encuentro");
  return parts.length ? parts.join(" | ") : "Sin efecto definido";
}

function stripCompanionPrefix(text, companionName) {
  const raw = String(text || "").trim();
  const re = new RegExp(`^${companionName}\\s*:\\s*`, "i");
  return raw.replace(re, "").trim();
}

function compactLine(text, maxWords = 40) {
  const words = String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  return `${words.slice(0, maxWords).join(" ")}…`;
}

function getPersonaje(personajes, id) {
  if (Array.isArray(personajes)) {
    return personajes.find(p => normalizeKey(p.id || p.nombre || "") === normalizeKey(id)) || {};
  }
  return personajes?.[normalizeKey(id)] || {};
}

function getPersonalityText(id) {
  const p = getPersonaje(schedulerPersonajesCache, id);
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

async function loadJson(filename) {
  const raw = await readFile(path.join(__dirname, filename), "utf8");
  return JSON.parse(raw);
}

async function loadPersonajes(loreCache) {
  if (loreCache?.personajes) return loreCache.personajes;
  try {
    const raw = await readFile(path.join(__dirname, "personajes.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function hydrateSchedulerPersonajesCache(loreCache) {
  const loaded = await loadPersonajes(loreCache).catch(() => ({}));
  schedulerPersonajesCache = loaded || {};
}

async function fetchChannel(client) {
  const channel = await client.channels.fetch(EVENT_CHANNEL_ID).catch(() => null);
  return channel?.isTextBased() ? channel : null;
}

async function generateAIText(prompt) {
  if (!OPENROUTER_API_KEY) return "";

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: "system",
          content: "Escribes textos de ambientación para un bot de Discord ambientado en un campamento de la Tierra Media. Responde solo con el texto pedido, sin explicaciones."
        },
        { role: "user", content: prompt }
      ],
      temperature: 0.9,
      max_tokens: 240
    })
  });

  if (!res.ok) {
    const fallback = await res.text().catch(() => "");
    throw new Error(`OpenRouter ${res.status}: ${fallback}`);
  }

  const data = await res.json();
  return data?.choices?.[0]?.message?.content?.trim() || "";
}

function getNextCaracasBoundaryMs(ms = Date.now()) {
  const nowLocal = new Date(ms + CARACAS_OFFSET_MS);

  const candidates = CYCLE_TIMES.map(({ hour, minute }) => {
    const d = new Date(nowLocal);
    d.setUTCHours(hour, minute, 0, 0);
    if (d.getTime() <= nowLocal.getTime()) d.setUTCDate(d.getUTCDate() + 1);
    return d.getTime() - CARACAS_OFFSET_MS;
  });

  return Math.min(...candidates);
}

function scheduleAt(ms, fn) {
  const delay = Math.max(0, ms - Date.now());
  return setTimeout(() => {
    Promise.resolve(fn()).catch(err => console.error(err));
  }, delay);
}

function clearCycleTimers() {
  for (const t of cycleEventTimers) clearTimeout(t);
  cycleEventTimers = [];
}

function scheduleCycleRandomEvents(cycleStartMs, plans) {
  for (const plan of plans) {
    const when = cycleStartMs + randomBetween(plan.minOffsetMs, plan.maxOffsetMs);
    cycleEventTimers.push(scheduleAt(when, plan.task));
  }
}

function getCompanionLore(companionId) {
  const personaje = getPersonaje(schedulerPersonajesCache, companionId);
  return {
    nombre: personaje?.nombre || companionNames[companionId] || companionId,
    personalidad: personaje?.personalidad || personaje?.descripcion || personaje?.tono || "",
    arma: personaje?.arma || personaje?.equipo?.arma || personaje?.armamento?.arma || "",
    armadura: personaje?.armadura || personaje?.equipo?.armadura || personaje?.armamento?.armadura || "",
    clase: personaje?.clase || ""
  };
}

function getEncounterReactionStyle(encounter = {}) {
  const tipo = normalizeKey(encounter?.tipo || "");
  const categoria = normalizeKey(encounter?.categoria || "");
  const titulo = normalizeKey(encounter?.titulo || "");
  const desc = String(encounter?.descripcion || "").toLowerCase();

  if (tipo === "enemigo_poderoso" || tipo === "jefe" || (encounter?.peligro || 0) >= 4) return "combate tenso, golpe a golpe, con riesgo real";
  if (tipo === "enemigo_numeroso" || categoria === "combate") return "choque contra varios enemigos, presión constante y ritmo rápido";
  if (tipo === "obstaculo" || categoria === "terreno") return "avance difícil, terreno hostil y cuidado en cada paso";
  if (tipo === "evento_especial" || categoria === "social" || categoria === "exploracion") return "encuentro inesperado, ambiente de viaje y reacción natural";
  if (titulo.includes("perdido") || desc.includes("desorient") || desc.includes("camino")) return "desorientación, tensión y búsqueda de orientación";
  return "situación de viaje, reacción breve y natural";
}

async function companionReaction(companionId, context, mode = "encounter") {
  const lore = getCompanionLore(companionId);
  const nombre = lore.nombre;
  const titulo = context?.titulo || "sin título";
  const tipo = context?.tipo || "desconocido";
  const categoria = context?.categoria || "desconocida";
  const descripcion = context?.descripcion || context?.textoExito || context?.textoFracaso || "";
  const peligro = context?.peligro ?? 0;
  const estiloEncuentro = getEncounterReactionStyle(context);

  if (!nombre) return `*asiente en silencio*`;

  const prompt = `
Eres ${nombre}.

Personalidad:
${lore.personalidad || "reservado y expresivo a su manera"}

Clase:
${lore.clase || "desconocida"}

Arma:
${lore.arma || "No especificada"}

Armadura:
${lore.armadura || "No especificada"}

Situación:
Modo: ${mode}
Título: ${titulo}
Tipo: ${tipo}
Categoría: ${categoria}
Peligro: ${peligro}
Estilo del encuentro: ${estiloEncuentro}
Descripción:
${descripcion}

Instrucciones:
- Responde con una sola línea corta.
- Máximo 40 palabras.
- El nombre debe aparecer solo una vez al inicio.
- Si es combate, menciona el arma o la postura.
- Si es obstáculo, reacciona al terreno o al riesgo.
- Si es evento especial, comenta la escena de forma natural.
- Español.
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
        max_tokens: 90
      })
    });

    if (!res.ok) return `${nombre}: *observa el camino de regreso en silencio*`;
    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content?.trim() || "*observa el camino de regreso en silencio*";
    const clean = stripCompanionPrefix
