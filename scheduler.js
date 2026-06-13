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
const CYCLE_HOURS = [0, 12];
const CYCLE_STATE_KEY = "scheduler_cycle";

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

const merchantNames = ["Smeagle", "Mablung", "Berenil", "Galdor", "Rúmil", "Thalion", "Ithron", "Cristiano Ronaldo"];

const merchantCities = [
  "Calembel", "Linhir", "Pelargir", "Morlad", "Sardol", "Ost Ardnír", "Dínadab",
  "Lothgobel", "Ethring", "Ost Anglebed", "Bâr Húrin", "Dol Amroth", "Arnach",
  "Minas Tirith", "Ost Rimmon", "Folde Este", "Andrast", "Edoras", "Folde Oeste",
  "Bree", "Esteldín", "Combe", "Cair Andros", "Ciudad de Valle", "Ost Guruth"
];

let schedulerPersonajesCache = {};
let boundaryTimer = null;
let merchantCloseTimer = null;
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

function clearCycleTimers() {
  for (const t of cycleEventTimers) clearTimeout(t);
  cycleEventTimers.length = 0;
}

function scheduleCycleRandomEvents(cycleStartMs, events) {
  for (const ev of events) {
    const offset = randomBetween(ev.minOffsetMs, ev.maxOffsetMs);
    const targetMs = cycleStartMs + offset;
    const delay = targetMs - Date.now();
    if (delay <= 0) {
      setTimeout(ev.task, 0);
    } else {
      cycleEventTimers.push(setTimeout(ev.task, delay));
    }
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

function getPersonaje(personajes, id) {
  if (Array.isArray(personajes)) {
    return personajes.find(p => normalizeKey(p.id || p.nombre || "") === normalizeKey(id)) || {};
  }
  return personajes?.[normalizeKey(id)] || {};
}

async function hydrateSchedulerPersonajesCache(loreCache) {
  schedulerPersonajesCache = await loadPersonajes(loreCache).catch(() => ({}));
}

async function fetchChannel(client) {
  const channel = await client.channels.fetch(EVENT_CHANNEL_ID).catch(() => null);
  return channel?.isTextBased() ? channel : null;
}

async function generateAITextStrict(prompt, maxTokens = 24) {
  if (!OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY no está configurada");
  }

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
      max_tokens: maxTokens
    })
  });

  if (!res.ok) {
    const details = await res.text().catch(() => "");
    throw new Error(`OpenRouter ${res.status}: ${details}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("OpenRouter devolvió texto vacío");
  return text;
}

async function ai(prompt, maxTokens = 24) {
  if (!OPENROUTER_API_KEY) return "";
  try {
    return await generateAITextStrict(prompt, maxTokens);
  } catch {
    return "";
  }
}

function shiftCaracas(ms = Date.now()) {
  return new Date(ms + CARACAS_OFFSET_MS);
}

function getCycleBounds(ms = Date.now()) {
  const local = shiftCaracas(ms);
  const hour = local.getUTCHours();
  const startLocal = new Date(local);
  startLocal.setUTCHours(hour < 12 ? 0 : 12, 0, 0, 0);
  const endLocal = new Date(startLocal);
  endLocal.setUTCHours(startLocal.getUTCHours() + 12, 0, 0, 0);

  return {
    cycleStartAt: startLocal.getTime() - CARACAS_OFFSET_MS,
    cycleEndAt: endLocal.getTime() - CARACAS_OFFSET_MS
  };
}

function getNextBoundaryMs(ms = Date.now()) {
  const local = shiftCaracas(ms);
  const candidates = CYCLE_HOURS.map(hour => {
    const d = new Date(local);
    d.setUTCHours(hour, 0, 0, 0);
    if (d.getTime() <= local.getTime()) d.setUTCDate(d.getUTCDate() + 1);
    return d.getTime() - CARACAS_OFFSET_MS;
  });
  return Math.min(...candidates);
}

async function getCycleState() {
  return await db.getEventState(CYCLE_STATE_KEY).catch(() => null);
}

async function setCycleState(value) {
  await db.setEventState(CYCLE_STATE_KEY, value).catch(() => {});
}

async function markSlotDone(group, slotId) {
  const state = await getCycleState();
  if (!state) return;

  const key = group === "merchant" ? "merchantSlots" : "dialogueSlots";
  const slots = Array.isArray(state[key]) ? state[key] : [];
  let changed = false;

  const updated = slots.map(slot => {
    if (slot.id !== slotId || slot.done) return slot;
    changed = true;
    return { ...slot, done: true, doneAt: Date.now() };
  });

  if (!changed) return;
  await setCycleState({ ...state, [key]: updated, updatedAt: Date.now() });
}

function getCompanionLore(companionId) {
  const personaje = schedulerPersonajesCache?.[normalizeKey(companionId)] || null;
  return {
    nombre: personaje?.nombre || companionNames[companionId] || companionId,
    personalidad: personaje?.personalidad || personaje?.descripcion || personaje?.tono || "",
    arma: personaje?.arma || personaje?.equipo?.arma || personaje?.armamento?.arma || "",
    armadura: personaje?.armadura || personaje?.equipo?.armadura || personaje?.armamento?.armadura || "",
    clase: personaje?.clase || ""
  };
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

  if (!nombre) return `*asiente en silencio*`;

  const titulo = context?.titulo || "sin título";
  const tipo = context?.tipo || "desconocido";
  const categoria = context?.categoria || "desconocida";
  const descripcion = context?.descripcion || context?.textoExito || context?.textoFracaso || "";
  const peligro = context?.peligro ?? 0;

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
    const raw = await generateAITextStrict(prompt, 24);
    const clean = stripCompanionPrefix(raw, nombre);
    return `${nombre}: ${compactLine(clean, 40)}`;
  } catch {
    return `${nombre}: *observa en silencio*`;
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
  } catch {
    return [];
  }
}

async function loadMissions() {
  try {
    const raw = await readFile(path.join(__dirname, "misiones.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function loadEncounters() {
  try {
    const raw = await readFile(path.join(__dirname, "encuentros.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

// ==========================================
//   FUNCIONES DE SELECCIÓN DE CATÁLOGO
// ==========================================

async function getCatalogSelection(key, fallbackItems, limit = 12) {
  const state = await db.getEventState(key);
  if (Array.isArray(state?.selection) && state.selection.length) {
    return state.selection.slice(0, limit);
  }
  return [...(fallbackItems || [])].slice(0, limit);
}

async function getCatalogStateItems(catalogName, catalogItems) {
  const state = await db.getEventState(catalogName).catch(() => null);

  const items = Array.isArray(state?.selection) && state.selection.length
    ? state.selection
    : catalogItems;

  return { state, items };
}

function getCatalogItems(data) {
  if (Array.isArray(data)) return data;
  return data?.items || data?.equipo || [];
}

async function renderCatalog(catalogName, items, title) {
  let texto = `🏪 **${title}**\n\n`;
  for (const item of items) {
    const price = await db.getDynamicPrice(catalogName, item);
    texto += `• **${item.nombre}**\n`;
    texto += `ID: ${item.id}\n`;
    texto += `Precio: ${formatPrice(price)}\n`;
    if (item.tipo) texto += `Tipo: ${item.tipo}\n`;
    if (item.slot) texto += `Slot: ${item.slot}\n`;
    texto += `Efecto: ${formatEffect(item.efecto)}\n`;
    if (item.descripcion) texto += `Descripción: ${item.descripcion}\n`;
    texto += `\n`;
  }
  texto += `Más adelante podrás usar \`!comprar <id>\` o \`!equipar <id>\`.`;
  return texto;
}

function formatEffect(effect = {}) {
  const parts = [];

  if (effect.salud) parts.push(`Salud +${effect.salud}`);
  if (effect.damageBonus) parts.push(`Daño +${effect.damageBonus}`);
  if (effect.successBonus) parts.push(`Éxito +${Math.round(effect.successBonus * 100)}%`);
  if (effect.damageReduction) parts.push(`Daño recibido -${Math.round(effect.damageReduction * 100)}%`);
  if (effect.afinidad) parts.push(`Afinidad +${effect.afinidad}`);
  if (effect.reduceDanioSiguienteEncuentro) parts.push(`- ${effect.reduceDanioSiguienteEncuentro} daño siguiente`);
  if (effect.soloProximaExpedicion) parts.push(`Duración: próxima expedición`);
  if (effect.soloProximoEncuentro) parts.push(`Duración: próximo encuentro`);

  return parts.length ? parts.join(" | ") : "Sin efecto definido";
}

function formatPrice(value) {
  return `${Number(value || 0)} pts`;
}

async function getCurrentMerchantState() {
  const state = await db.getEventState("merchant");
  return state || null;
}

async function getCurrentTablonSelection() {
  const state = await db.getEventState("tablon");
  if (Array.isArray(state?.selection) && state.selection.length) return state.selection;

  const missions = await loadMissions();
  const shuffled = [...missions].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, 5);
}

function normalizeText(text) {
  if (!text) return "";
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

function getPersonajeById(id) {
  return schedulerPersonajesCache[normalizeKey(id)] || null;
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

function getPersonalityText(id) {
  const p = getPersonajeById(id);
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
  return companionNames[id]?.efecto || "Sin efecto definido.";
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

async function refreshTablonSelection(client, loreCache, cycleStartMs) {
  const channel = await fetchChannel(client);
  if (!channel) return;

  const current = await db.getEventState("tablon").catch(() => null);
  if (current?.cycleId === cycleStartMs && current?.postedAt) return;

  const personajes = await loadPersonajes(loreCache);
  const announcerId = pick(companionIds);
  const announcer = getPersonaje(personajes, announcerId);
  const announcerName = announcer?.nombre || companionNames[announcerId] || announcerId;

  const prompt = `
Escribe un mensaje de ambientación en español, de unas 60 a 90 palabras.

El personaje es ${announcerName}.
Debe acercarse al tablón de anuncios, martillear algunas veces y clavar cinco nuevas expediciones.
Luego se retira para continuar con sus tareas.
Tono natural, de rol y con vida de campamento.
No pongas título.
No menciones que es una IA.
`.trim();

  let text;
  try {
    text = await generateAITextStrict(prompt, 24);
  } catch (err) {
    console.error("Error generando texto IA del tablón:", err);
    text = `${announcerName} cruza el campamento, revisa el tablón y clava cinco expediciones nuevas antes de seguir con sus tareas.`;
  }

  const missions = await loadJson("misiones.json").catch(() => []);
  const selection = [...missions].sort(() => Math.random() - 0.5).slice(0, 5);

  await db.setEventState("tablon", {
    cycleId: cycleStartMs,
    postedAt: Date.now(),
    lastAt: Date.now(),
    nextAt: Date.now() + TWELVE_HOURS,
    selection
  }).catch(() => {});

  await channel.send(`🌅 **ACTUALIZACIÓN DEL TABLÓN** 🌅\n\n${truncate(text)}`);
}

async function ensureCatalogStates() {
  const [tienda, armeria, mercader] = await Promise.all([
    loadJson("tienda.json").catch(() => ({})),
    loadJson("armeria.json").catch(() => ({})),
    loadJson("mercader.json").catch(() => ({}))
  ]);

  const tiendaItems = Array.isArray(tienda?.items) ? tienda.items : Array.isArray(tienda) ? tienda : [];
  const armeriaItems = Array.isArray(armeria?.items) ? armeria.items : Array.isArray(armeria?.equipo) ? armeria.equipo : Array.isArray(armeria) ? armeria : [];
  const mercaderItems = Array.isArray(mercader?.items) ? mercader.items : Array.isArray(mercader) ? mercader : [];

  const existingTienda = await db.getEventState("tienda").catch(() => null);
  if (!existingTienda?.selection?.length) {
    await db.setEventState("tienda", {
      selection: [...tiendaItems].sort(() => Math.random() - 0.5).slice(0, 12),
      lastAt: Date.now(),
      nextAt: Date.now() + TWELVE_HOURS,
      cycleId: Date.now()
    }).catch(() => {});
  }

  const existingArmeria = await db.getEventState("armeria").catch(() => null);
  if (!existingArmeria?.selection?.length) {
    await db.setEventState("armeria", {
      selection: [...armeriaItems].sort(() => Math.random() - 0.5).slice(0, 12),
      lastAt: Date.now(),
      nextAt: Date.now() + TWELVE_HOURS,
      cycleId: Date.now()
    }).catch(() => {});
  }

  const existingMercader = await db.getEventState("mercader").catch(() => null);
  if (!existingMercader?.selection?.length) {
    await db.setEventState("mercader", {
      selection: [...mercaderItems].sort(() => Math.random() - 0.5).slice(0, 12),
      lastAt: Date.now(),
      nextAt: Date.now() + TWELVE_HOURS,
      cycleId: Date.now()
    }).catch(() => {});
  }
}

async function refreshCatalogPricesAndSelections(cycleStartAt = Date.now()) {
  const currentTienda = await db.getEventState("tienda").catch(() => null);
  const currentArmeria = await db.getEventState("armeria").catch(() => null);
  const currentMercader = await db.getEventState("mercader").catch(() => null);

  if (
    currentTienda?.cycleId === cycleStartAt &&
    currentArmeria?.cycleId === cycleStartAt &&
    currentMercader?.cycleId === cycleStartAt &&
    Array.isArray(currentTienda?.selection) &&
    Array.isArray(currentArmeria?.selection) &&
    Array.isArray(currentMercader?.selection)
  ) {
    return;
  }

  const [tienda, armeria, mercader] = await Promise.all([
    loadJson("tienda.json").catch(() => ({})),
    loadJson("armeria.json").catch(() => ({})),
    loadJson("mercader.json").catch(() => ({}))
  ]);

  const tiendaItems = Array.isArray(tienda?.items) ? tienda.items : Array.isArray(tienda) ? tienda : [];
  const armeriaItems = Array.isArray(armeria?.items) ? armeria.items : Array.isArray(armeria?.equipo) ? armeria.equipo : Array.isArray(armeria) ? armeria : [];
  const mercaderItems = Array.isArray(mercader?.items) ? mercader.items : Array.isArray(mercader) ? mercader : [];

  await db.setEventState("tienda", {
    selection: [...tiendaItems].sort(() => Math.random() - 0.5).slice(0, 12),
    lastAt: cycleStartAt,
    nextAt: cycleStartAt + TWELVE_HOURS,
    cycleId: cycleStartAt
  }).catch(() => {});

  await db.setEventState("armeria", {
    selection: [...armeriaItems].sort(() => Math.random() - 0.5).slice(0, 12),
    lastAt: cycleStartAt,
    nextAt: cycleStartAt + TWELVE_HOURS,
    cycleId: cycleStartAt
  }).catch(() => {});

  await db.setEventState("mercader", {
    selection: [...mercaderItems].sort(() => Math.random() - 0.5).slice(0, 12),
    lastAt: cycleStartAt,
    nextAt: cycleStartAt + TWELVE_HOURS,
    cycleId: cycleStartAt
  }).catch(() => {});

  if (typeof db.rerollMarketPrices === "function") {
    await db.rerollMarketPrices("tienda", tiendaItems).catch(() => {});
    await db.rerollMarketPrices("armeria", armeriaItems).catch(() => {});
    await db.rerollMarketPrices("mercader", mercaderItems).catch(() => {});
  }
}

async function openMerchant(client) {
  const existing = await db.getEventState("merchant").catch(() => null);
  if (existing?.active) return;

  const channel = await fetchChannel(client);
  if (!channel) return;

  const merchantName = pick(merchantNames);
  const destination = pick(merchantCities);

  const stockCatalog = await loadJson("mercader.json").catch(() => ({ items: [] }));
  const catalogItems = Array.isArray(stockCatalog.items)
    ? stockCatalog.items
    : Array.isArray(stockCatalog)
      ? stockCatalog
      : [];

  const catalogState = await db.getEventState("mercader").catch(() => null);
  const items = Array.isArray(catalogState?.selection) && catalogState.selection.length
    ? catalogState.selection
    : catalogItems;

  const prompt = `
Escribe un mensaje de llegada de un mercader ambulante para Discord, en español, de entre 60 y 90 palabras.

Debe incluir:
- Su nombre: ${merchantName}
- Que pide permiso para instalarse junto a la tienda
- Que dice que solo permanecerá 2 horas
- Que después seguirá hacia ${destination}
- Tono de rol medieval/Tierra Media
- Natural, cálido y convincente
- Termina con una invitación breve: "Te invito a que veas mi mercancía, usa !mercader."
No menciones que es una IA.
`.trim();

  let intro;
  try {
    intro = await generateAITextStrict(prompt, 24);
  } catch (err) {
    console.error("Error generando llegada del mercader:", err);
    intro = `${merchantName} llega con sus bultos y pide permiso para instalarse junto a la tienda. Dice que solo permanecerá dos horas antes de seguir hacia ${destination}. Te invito a que veas mi mercancía, usa !mercader.`;
  }

  await channel.send(
    `🚚 **LLEGA EL MERCADER AMBULANTE**\n\n` +
    `${truncate(String(intro).replace(/^🚚\s*/i, '').trim())}`
  );

  await db.setEventState("merchant", {
    active: true,
    name: merchantName,
    destination,
    openedAt: Date.now(),
    closesAt: Date.now() + MERCHANT_OPEN_MS,
    nextAt: Date.now() + TWELVE_HOURS,
    stock: items.slice(0, 12)
  }).catch(() => {});

  if (merchantCloseTimer) clearTimeout(merchantCloseTimer);
  merchantCloseTimer = setTimeout(async () => {
    const state = await db.getEventState("merchant").catch(() => null);
    if (!state?.active) return;

    const closePrompt = `
Escribe un mensaje de despedida de un mercader ambulante para Discord, en español, de entre 60 y 90 palabras.

Debe incluir:
- Su nombre: ${state.name}
- Que agradece a Capitán Altéru por dejarle el espacio
- Que debe recoger y partir
- Que su próximo destino es ${state.destination}
- Que se aleja del campamento con su animal de carga o sus bultos
- Tono de rol medieval/Tierra Media
No menciones que es una IA.
`.trim();

    let farewell;
    try {
      farewell = await generateAITextStrict(closePrompt, 24);
    } catch (err) {
      console.error("Error generando despedida del mercader:", err);
      farewell = `${state.name} agradece a Capitán Altéru por dejarle el espacio, recoge sus bultos y parte hacia ${state.destination}.`;
    }

    await channel.send(`🧳 **EL MERCADER SE RETIRA**\n\n${truncate(farewell)}`);

    await db.setEventState("merchant", {
      active: false,
      name: state.name,
      destination: state.destination,
      openedAt: state.openedAt,
      closedAt: Date.now(),
      nextAt: Date.now() + TWELVE_HOURS
    }).catch(() => {});
  }, MERCHANT_OPEN_MS);
}

async function companionDialogue(client, loreCache, slotId = null) {
  const channel = await fetchChannel(client);
  if (!channel) return;

  const personajes = await loadPersonajes(loreCache);
  const history = String(loreCache?.historia_completa || "").slice(0, 5000);

  const a = pick(companionIds);
  let b = pick(companionIds);
  while (b === a) b = pick(companionIds);

  const personaA = getPersonaje(personajes, a);
  const personaB = getPersonaje(personajes, b);

  const nombreA = personaA.nombre || companionNames[a];
  const nombreB = personaB.nombre || companionNames[b];

  const themes = [
    { type: "battle", text: "una vieja batalla del pasado" },
    { type: "companions", text: "una conversación tranquila entre compañeros" },
    { type: "camp", text: "un recuerdo del campamento al amanecer" },
    { type: "expedition", text: "una historia sobre una expedición peligrosa" },
    { type: "training_swords", text: "un entrenamiento con espadas de madera en el patio central del campamento" },
    { type: "thulazar", text: "Altéru hablando sobre Thûlazar, el enemigo principal del campamento, y cómo afecta a los viajeros haciéndoles perder el sentido de la orientación" }
  ];

  const theme = pick(themes);

  let text = "";
  try {
    text = await ai(
      `Escribe un diálogo breve en español entre dos compañeros del Campamento de Altéru.\n\n` +
      `Compañero A: ${nombreA}\n` +
      `Personalidad A: ${personaA.personalidad || personaA.descripcion || personaA.tono || "sin definir"}\n\n` +
      `Compañero B: ${nombreB}\n` +
      `Personalidad B: ${personaB.personalidad || personaB.descripcion || personaB.tono || "sin definir"}\n\n` +
      `Tema:\n${theme.text}\n\n` +
      `Contexto de historia útil:\n${history}\n\n` +
      `Reglas:\n` +
      `- Entre 80 y 140 palabras.\n` +
      `- Debe parecer una escena de rol natural.\n` +
      `- Cada intervención debe llevar el nombre del personaje al inicio.\n` +
      `- Uno habla y el otro responde o pregunta.\n` +
      `- Si el tema es entrenamiento, debe sentirse como un combate amistoso con espadas de madera.\n` +
      `- Español.\n` +
      `- No pongas título.\n` +
      `- No menciones que es una IA.`,
      24
    );
  } catch (err) {
    console.error("Error generando diálogo entre compañeros:", err);
  }

  if (!text) {
    text =
      `${nombreA}: Vamos. Hoy quiero ver si sigues tan rápido como ayer.\n` +
      `${nombreB}: En el patio central, con espadas de madera, no pienso dejarme ganar tan fácil.\n` +
      `${nombreA}: Entonces mueve esos pies. No voy a darte tregua.\n` +
      `${nombreB}: Mejor. Así el entrenamiento vale la pena.`;
  } else {
    text = String(text)
      .replace(/^💬\s*/i, "")
      .replace(/^🗣️\s*/i, "")
      .replace(/^##.*\n/i, "")
      .trim();
  }

  await channel.send(`💬 **CONVERSACIÓN ENTRE COMPAÑEROS**\n\n${truncate(text, 1500)}`);

  if (slotId) await markSlotDone("dialogue", slotId).catch(() => {});
}

async function openCycleEvents(cycleStartMs, client, loreCache) {
  clearCycleTimers();
  await refreshTablonSelection(client, loreCache, cycleStartMs).catch(console.error);
  await refreshCatalogPricesAndSelections(cycleStartMs).catch(console.error);

  scheduleCycleRandomEvents(cycleStartMs, [
    {
      minOffsetMs: 1 * 60 * 60 * 1000,
      maxOffsetMs: 5 * 60 * 60 * 1000,
      task: () => openMerchant(client)
    }
  ]);

  scheduleCycleRandomEvents(cycleStartMs, [
    {
      minOffsetMs: 6 * 60 * 60 * 1000,
      maxOffsetMs: 11 * 60 * 60 * 1000,
      task: () => companionDialogue(client, loreCache)
    }
  ]);
}

async function resumeMerchantIfNeeded(client) {
  const state = await db.getEventState("merchant").catch(() => null);
  if (!state?.active) return;

  const remaining = Math.max(0, state.closesAt - Date.now());
  if (remaining <= 0) {
    await db.clearEventState("merchant").catch(async () => {
      await db.setEventState("merchant", { active: false, closedAt: Date.now() }).catch(() => {});
    });
    return;
  }

  const channel = await fetchChannel(client);
  if (!channel) return;

  if (merchantCloseTimer) clearTimeout(merchantCloseTimer);
  merchantCloseTimer = setTimeout(async () => {
    const latest = await db.getEventState("merchant").catch(() => null);
    if (!latest?.active) return;

    await channel.send(`🧳 **EL MERCADER SE RETIRA**\n\n${latest.name}: Lo siento, debo recoger y partir. Mi próximo destino me espera. Capitán Altéru, gracias por dejarme el espacio; espero volver pronto.`);
    await db.setEventState("merchant", {
      active: false,
      name: latest.name,
      destination: latest.destination,
      openedAt: latest.openedAt,
      closedAt: Date.now(),
      nextAt: Date.now() + TWELVE_HOURS
    }).catch(() => {});
  }, remaining);
}

function scheduleNextBoundary(client, loreCache) {
  if (boundaryTimer) clearTimeout(boundaryTimer);

  const nextMs = getNextBoundaryMs();
  boundaryTimer = setTimeout(async () => {
    try {
      const bounds = getCycleBounds(nextMs);
      await openCycleEvents(bounds.cycleStartAt, client, loreCache);
    } catch (err) {
      console.error("Scheduler boundary error:", err);
    }
    scheduleNextBoundary(client, loreCache);
  }, Math.max(0, nextMs - Date.now()));
}

export async function startSchedulers(client, loreCache) {
  await hydrateSchedulerPersonajesCache(loreCache).catch(() => {});
  await ensureCatalogStates().catch(console.error);
  await resumeMerchantIfNeeded(client).catch(console.error);

  const bounds = getCycleBounds();
  await openCycleEvents(bounds.cycleStartAt, client, loreCache).catch(console.error);

  scheduleNextBoundary(client, loreCache);
}

export async function rerollAllPrices(tiendaItems, armeriaItems, mercaderItems) {
  if (typeof db.rerollMarketPrices !== "function") return;
  await db.rerollMarketPrices("tienda", tiendaItems).catch(() => {});
  await db.rerollMarketPrices("armeria", armeriaItems).catch(() => {});
  await db.rerollMarketPrices("mercader", mercaderItems).catch(() => {});
}
