import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as db from "./database.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EVENT_CHANNEL_ID = process.env.ANNOUNCEMENTS_CHANNEL_ID || "1514198998838284288";

// ================================
// VARIABLES PARA IA
// ================================
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

const TWELVE_HOURS = 12 * 60 * 60 * 1000;
const MERCHANT_OPEN_MS = 2 * 60 * 60 * 1000;
const CYCLE_STATE_KEY = "cycle_state";

const companionIds = ["alteru", "cirdil", "duinor", "andaer", "nieriel", "faelon", "montaraces"];

const companionNames = {
  alteru: "Altéru",
  cirdil: "Círdil",
  duinor: "Duinor",
  andaer: "Andaer",
  nieriel: "Nieriel",
  faelon: "Faelon",
  montaraces: "Montaraces de Arathir"
};

const merchantNames = ["Smeagle", "Mablung", "Berenil", "Galdor", "Rúmil", "Cucurella", "Ithron", "Cristiano Ronaldo"];

const merchantCities = [
  "Calembel", "Linhir", "Pelargir", "Morlad", "Sardol", "Ost Ardnír", "Dínadab",
  "Lothgobel", "Ethring", "Ost Anglebed", "Bâr Húrin", "Dol Amroth", "Arnach",
  "Minas Tirith", "Ost Rimmon", "Folde Este", "Andrast", "Edoras", "Folde Oeste",
  "Bree", "Esteldín", "Combe", "Cair Andros", "Ciudad de Valle", "Ost Guruth"
];

let schedulerPersonajesCache = {};
let merchantCloseTimer = null;

// Memoria para askGroq
const conversationMemory = new Map();

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

// ===============================================
// FUNCIÓN PRINCIPAL DE IA
// ===============================================
async function chatWithAI({
  systemPrompt = "",
  messages = [],
  temperature = 0.85,
  maxTokens = 512 
}) {
  const payloadMessages = [];

  if (systemPrompt.trim()) {
    payloadMessages.push({ role: "system", content: systemPrompt.trim() });
  }

  for (const msg of messages) {
    if (!msg || !msg.content) continue;
    payloadMessages.push({
      role: msg.role === "assistant" ? "assistant" : "user",
      content: String(msg.content)
    });
  }

  // 1) GROQ
  try {
    if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY no configurada");

    const res = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: payloadMessages,
        temperature,
        max_tokens: maxTokens
      })
    });

    if (!res.ok) {
      const details = await res.text().catch(() => "");
      throw new Error(`Groq ${res.status}: ${details}`);
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    const clean = Array.isArray(text)
      ? text.map(part => part?.text || "").join("").trim()
      : String(text || "").trim();

    if (clean && clean !== "undefined" && clean !== "null") return clean;
  } catch (err) {
    console.error("Groq error:", err);
  }

  // 2) OPENROUTER / RESPALDO
  try {
    if (!OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY no configurada");

    const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.OPENROUTER_REFERER || "https://chat.openai.com",
        "X-Title": process.env.OPENROUTER_TITLE || "Campamento de Altéru"
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: payloadMessages,
        temperature,
        max_tokens: maxTokens
      })
    });

    if (!res.ok) {
      const details = await res.text().catch(() => "");
      throw new Error(`OpenRouter ${res.status}: ${details}`);
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    const clean = Array.isArray(text)
      ? text.map(part => part?.text || "").join("").trim()
      : String(text || "").trim();

    return clean || "";
  } catch (err) {
    console.error("OpenRouter fallback error:", err);
    return "";
  }
}

async function askGroq(userId, userMessage, lore) {
  const profile = await db.getProfile(userId);
  const systemPrompt = buildSystemPrompt(lore, profile);

  if (!conversationMemory.has(userId)) {
    conversationMemory.set(userId, []);
  }

  const history = conversationMemory.get(userId);
  history.push({ role: "user", content: userMessage });
  if (history.length > 10) history.shift();

  try {
    const reply = await chatWithAI({
      systemPrompt,
      messages: history,
      temperature: 0.85,
      maxTokens: 300
    });

    const finalReply = String(reply || "").trim() || "Altéru: *observa los senderos lejanos con suspicacia*";

    history.push({ role: "assistant", content: finalReply });
    if (history.length > 10) history.shift();

    return finalReply;
  } catch {
    return "Altéru: *observa los senderos lejanos con suspicacia*";
  }
}

async function generateAITextStrict(prompt, maxTokens = 200) {
  return await chatWithAI({
    systemPrompt: "Escribes textos de ambientación para un bot de Discord ambientado en un campamento de la Tierra Media. Responde solo con el texto pedido, sin explicaciones adicionales.",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.9,
    maxTokens
  });
}

async function ai(prompt, maxTokens = 200) {
  try {
    const text = await generateAITextStrict(prompt, maxTokens);
    const clean = String(text || "").trim();
    return clean || "*observa en silencio*";
  } catch {
    return "*observa en silencio*";
  }
}

// ==========================================
// UTILERÍAS
// ==========================================

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
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

function getCycleBounds(ms = Date.now()) {
  const d = new Date(ms);
  const hour = d.getUTCHours();
  const start = new Date(d);
  start.setUTCHours(hour < 12 ? 0 : 12, 0, 0, 0);
  const end = new Date(start);
  end.setUTCHours(start.getUTCHours() + 12, 0, 0, 0);

  return {
    cycleStartAt: start.getTime(),
    cycleEndAt: end.getTime()
  };
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

function compactLine(text, maxWords = 80) {
  const words = String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

  if (words.length <= maxWords) return words.join(" ");
  return `${words.slice(0, maxWords).join(" ")}…`;
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
- Responde con un mensaje un poco más largo y detallado, de aproximadamente 100 a 150 caracteres (unas 20 a 30 palabras).
- El nombre debe aparecer solo una vez al inicio.
- Si es combate, menciona el arma, la táctica o la postura de manera épica.
- Si es obstáculo, reacciona al terreno o al riesgo de forma inmersiva.
- Si es evento especial, comenta la escena de forma natural y viva.
- Español.
`.trim();

  try {
    const raw = await generateAITextStrict(prompt, 150); 
    if (!raw || !String(raw).trim()) {
      return `${nombre}: *observa en silencio*`;
    }

    const clean = stripCompanionPrefix(raw, nombre);
    return `${nombre}: ${compactLine(clean, 80)}`;
  } catch {
    return `${nombre}: *observa en silencio*`;
  }
}

function getOwnedCompanions(profile) {
  const list = profile?.activeCompanions?.length
    ? profile.activeCompanions
    : (profile?.hiredCompanions || profile?.companions || []);

  return [...new Set(list.map(normalizeKey))];
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
    text = await generateAITextStrict(prompt, 250); 
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

// ==========================================
// INICIALIZACIÓN Y ROTACIÓN DE INVENTARIOS
// ==========================================

async function ensureCatalogStates() {
  const [tienda, armeria, mercader, establo] = await Promise.all([
    loadJson("tienda.json").catch(() => ({})),
    loadJson("armeria.json").catch(() => ({})),
    loadJson("mercader.json").catch(() => ({})),
    loadJson("establo.json").catch(() => ({})) 
  ]);

  const tiendaItems = Array.isArray(tienda?.items) ? tienda.items : Array.isArray(tienda) ? tienda : [];
  const armeriaItems = Array.isArray(armeria?.items) ? armeria.items : Array.isArray(armeria?.equipo) ? armeria.equipo : Array.isArray(armeria) ? armeria : [];
  const mercaderItems = Array.isArray(mercader?.items) ? mercader.items : Array.isArray(mercader) ? mercader : [];
  const establoItems = Array.isArray(establo?.items) ? establo.items : Array.isArray(establo) ? establo : [];

  const armeriaShuffled = [...armeriaItems].sort(() => Math.random() - 0.5);

  const existingTienda = await db.getEventState("tienda").catch(() => null);
  if (!existingTienda?.selection?.length) {
    await db.setEventState("tienda", {
      selection: [...tiendaItems].sort(() => Math.random() - 0.5).slice(0, 15), 
      lastAt: Date.now(),
      nextAt: Date.now() + TWELVE_HOURS,
      cycleId: Date.now()
    }).catch(() => {});
  }

  const existingArmeria1 = await db.getEventState("armeria1").catch(() => null);
  if (!existingArmeria1?.selection?.length) {
    await db.setEventState("armeria1", {
      selection: armeriaShuffled.slice(0, 15),
      lastAt: Date.now(),
      nextAt: Date.now() + TWELVE_HOURS,
      cycleId: Date.now()
    }).catch(() => {});
  }

  const existingArmeria2 = await db.getEventState("armeria2").catch(() => null);
  if (!existingArmeria2?.selection?.length) {
    await db.setEventState("armeria2", {
      selection: armeriaShuffled.slice(15, 30),
      lastAt: Date.now(),
      nextAt: Date.now() + TWELVE_HOURS,
      cycleId: Date.now()
    }).catch(() => {});
  }

  const existingMercader = await db.getEventState("mercader").catch(() => null);
  if (!existingMercader?.selection?.length) {
    await db.setEventState("mercader", {
      selection: [...mercaderItems].sort(() => Math.random() - 0.5).slice(0, 15), 
      lastAt: Date.now(),
      nextAt: Date.now() + TWELVE_HOURS,
      cycleId: Date.now()
    }).catch(() => {});
  }

  const existingEstablo = await db.getEventState("establo").catch(() => null);
  if (!existingEstablo?.selection?.length) {
    await db.setEventState("establo", {
      selection: [...establoItems].sort(() => Math.random() - 0.5).slice(0, 15),
      lastAt: Date.now(),
      nextAt: Date.now() + TWELVE_HOURS,
      cycleId: Date.now()
    }).catch(() => {});
  }
}

async function refreshCatalogPricesAndSelections(cycleStartAt = Date.now()) {
  const currentTienda = await db.getEventState("tienda").catch(() => null);
  const currentArmeria1 = await db.getEventState("armeria1").catch(() => null);
  const currentArmeria2 = await db.getEventState("armeria2").catch(() => null);
  const currentMercader = await db.getEventState("mercader").catch(() => null);
  const currentEstablo = await db.getEventState("establo").catch(() => null); 

  if (
    currentTienda?.cycleId === cycleStartAt &&
    currentArmeria1?.cycleId === cycleStartAt &&
    currentArmeria2?.cycleId === cycleStartAt &&
    currentMercader?.cycleId === cycleStartAt &&
    currentEstablo?.cycleId === cycleStartAt && 
    Array.isArray(currentTienda?.selection) &&
    Array.isArray(currentArmeria1?.selection) &&
    Array.isArray(currentArmeria2?.selection) &&
    Array.isArray(currentMercader?.selection) &&
    Array.isArray(currentEstablo?.selection) 
  ) {
    return;
  }

  const [tienda, armeria, mercader, establo] = await Promise.all([
    loadJson("tienda.json").catch(() => ({})),
    loadJson("armeria.json").catch(() => ({})),
    loadJson("mercader.json").catch(() => ({})),
    loadJson("establo.json").catch(() => ({}))
  ]);

  const tiendaItems = Array.isArray(tienda?.items) ? tienda.items : Array.isArray(tienda) ? tienda : [];
  const armeriaItems = Array.isArray(armeria?.items) ? armeria.items : Array.isArray(armeria?.equipo) ? armeria.equipo : Array.isArray(armeria) ? armeria : [];
  const mercaderItems = Array.isArray(mercader?.items) ? mercader.items : Array.isArray(mercader) ? mercader : [];
  const establoItems = Array.isArray(establo?.items) ? establo.items : Array.isArray(establo) ? establo : [];

  const armeriaShuffled = [...armeriaItems].sort(() => Math.random() - 0.5);

  await db.setEventState("tienda", {
    selection: [...tiendaItems].sort(() => Math.random() - 0.5).slice(0, 15),
    lastAt: cycleStartAt,
    nextAt: cycleStartAt + TWELVE_HOURS,
    cycleId: cycleStartAt
  }).catch(() => {});

  await db.setEventState("armeria1", {
    selection: armeriaShuffled.slice(0, 15),
    lastAt: cycleStartAt,
    nextAt: cycleStartAt + TWELVE_HOURS,
    cycleId: cycleStartAt
  }).catch(() => {});

  await db.setEventState("armeria2", {
    selection: armeriaShuffled.slice(15, 30), 
    lastAt: cycleStartAt,
    nextAt: cycleStartAt + TWELVE_HOURS,
    cycleId: cycleStartAt
  }).catch(() => {});

  await db.setEventState("mercader", {
    selection: [...mercaderItems].sort(() => Math.random() - 0.5).slice(0, 15),
    lastAt: cycleStartAt,
    nextAt: cycleStartAt + TWELVE_HOURS,
    cycleId: cycleStartAt
  }).catch(() => {});

  await db.setEventState("establo", {
    selection: [...establoItems].sort(() => Math.random() - 0.5).slice(0, 15),
    lastAt: cycleStartAt,
    nextAt: cycleStartAt + TWELVE_HOURS,
    cycleId: cycleStartAt
  }).catch(() => {});

  if (typeof db.rerollMarketPrices === "function") {
    await db.rerollMarketPrices("tienda", tiendaItems).catch(() => {});
    await db.rerollMarketPrices("armeria1", armeriaItems).catch(() => {});
    await db.rerollMarketPrices("armeria2", armeriaItems).catch(() => {});
    await db.rerollMarketPrices("mercader", mercaderItems).catch(() => {});
    await db.rerollMarketPrices("establo", establoItems).catch(() => {}); 
  }
}

// ==========================================
// MERCADER AMBULANTE
// ==========================================

async function closeMerchant(client) {
  const state = await db.getEventState("merchant").catch(() => null);
  if (!state?.active) return;
  
  const channel = await fetchChannel(client);
  if (channel) {
    await channel.send(`🚚 **EL MERCADER SE MARCHA**\n\nEl mercader ambulante empaca sus cosas y se retira del campamento. "¡Hasta la próxima, viajeros!"`);
  }
  
  await db.setEventState("merchant", { ...state, active: false }).catch(() => {});
}

async function resumeMerchantIfNeeded(client) {
  const state = await db.getEventState("merchant").catch(() => null);
  if (!state?.active || !state?.closesAt) return;

  const delay = state.closesAt - Date.now();
  if (delay <= 0) {
    await closeMerchant(client);
  } else {
    if (merchantCloseTimer) clearTimeout(merchantCloseTimer);
    merchantCloseTimer = setTimeout(() => closeMerchant(client), delay);
  }
}

async function openMerchant(client) {
  const existing = await db.getEventState("merchant").catch(() => null);
  if (existing?.active) return;

  const channel = await fetchChannel(client);
  if (!channel) {
    console.error("No se pudo obtener el canal de anuncios para el mercader.");
    return;
  }

  const merchantName = pick(merchantNames);
  const destination = pick(merchantCities);

  let intro = `🚚 **LLEGA EL MERCADER AMBULANTE**\n\n${merchantName} llega con sus bultos y pide permiso para instalarse junto a la tienda. Dice que solo permanecerá dos horas antes de seguir hacia ${destination}. Te invito a que veas mi mercancía, usa !mercader, seguro que encuentras algo útil.`;

  try {
    const aiText = await generateAITextStrict(
      `Escribe una frase corta y ambientada de llegada del mercader ${merchantName} y aclarando que luego debe partir hacia ${destination}. (No confundir con la ubicación del campamento) Español.`,
      150 
    );
    if (aiText?.trim()) intro = `🚚 **LLEGA EL MERCADER AMBULANTE**\n\n${aiText.trim()}`;
  } catch (err) {
    console.error("Error generando llegada del mercader:", err);
  }

  try {
    await channel.send(intro);
  } catch (err) {
    console.error("No se pudo enviar el mensaje del mercader:", err);
    return;
  }

  const closesAt = Date.now() + MERCHANT_OPEN_MS;
  await db.setEventState("merchant", {
    active: true,
    name: merchantName,
    destination,
    openedAt: Date.now(),
    closesAt: closesAt,
    nextAt: Date.now() + TWELVE_HOURS
  }).catch(() => {});

  if (merchantCloseTimer) clearTimeout(merchantCloseTimer);
  merchantCloseTimer = setTimeout(() => closeMerchant(client), MERCHANT_OPEN_MS);
}

// ==========================================
// SCHEDULER FIJO AUTOMÁTICO
// ==========================================

const FIXED_AUTO_SLOTS = [
  { id: "dialogue_ia_0400", type: "dialogue", hour: 4, minute: 0 },
  { id: "merchant_0900", type: "merchant", hour: 9, minute: 0 },
  { id: "merchant_1400", type: "merchant", hour: 14, minute: 0 },
  { id: "relation_scene_1900", type: "relation", hour: 19, minute: 0, sceneSlot: 1 },
];

const FIXED_AUTO_STATE_KEY = "fixed_auto_scheduler_v1";

let fixedAutoTimer = null;
let fixedAutoBusy = false;

function getUTCDateKey(date = new Date()) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0")
  ].join("-");
}

function getUTCMidnightMs(date = new Date()) {
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    0, 0, 0, 0
  );
}

async function getFixedAutoState() {
  return await db.getEventState(FIXED_AUTO_STATE_KEY).catch(() => null);
}

async function saveFixedAutoState(state) {
  await db.setEventState(FIXED_AUTO_STATE_KEY, state).catch(() => {});
}

function ensureFixedAutoStateShape(state) {
  return {
    dateKey: state?.dateKey || getUTCDateKey(),
    fired: Array.isArray(state?.fired) ? state.fired : [],
    updatedAt: state?.updatedAt || Date.now()
  };
}

async function runFixedSlot(client, loreCache, slot, dayStartMs) {
  if (slot.type === "merchant") {
    await openMerchant(client);
    return;
  }

  if (slot.type === "relation") {
    await publishCompanionScene(client, dayStartMs, slot.sceneSlot);
    return;
  }

  if (slot.type === "dialogue") {
  await companionReaction(pick(companionIds), { titulo: "Diálogo Automático", tipo: "evento_especial", categoria: "social", descripcion: "Escena automática del scheduler." }, "auto");
  }
}

async function processFixedAutoSlots(client, loreCache) {
  if (fixedAutoBusy) return;
  fixedAutoBusy = true;

  try {
    const now = new Date();
    const nowMs = now.getTime();
    
    const dayStartMs = getUTCMidnightMs(now); 

    const { cycleStartAt } = getCycleBounds(nowMs);
    const cycleKey = `cycle-${cycleStartAt}`;

    const state = ensureFixedAutoStateShape(await getFixedAutoState());

    if (state.dateKey !== cycleKey) {
      state.dateKey = cycleKey;
      state.fired = [];
      state.updatedAt = Date.now();
      await saveFixedAutoState(state);

      await refreshTablonSelection(client, loreCache, cycleStartAt).catch(console.error);
      await refreshCatalogPricesAndSelections(cycleStartAt).catch(console.error);
    }

    for (const slot of FIXED_AUTO_SLOTS) {
      const slotTime = Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        slot.hour,
        slot.minute,
        0,
        0
      );

      if (nowMs < slotTime) continue;
      if (state.fired.includes(slot.id)) continue;

      state.fired.push(slot.id);
      state.updatedAt = Date.now();
      await saveFixedAutoState(state);

      await runFixedSlot(client, loreCache, slot, dayStartMs);
    }
  } finally {
    fixedAutoBusy = false;
  }
}

export async function startSchedulers(client, loreCache) {
  await hydrateSchedulerPersonajesCache(loreCache).catch(() => {});
  await ensureCatalogStates().catch(console.error);
  await resumeMerchantIfNeeded(client).catch(console.error);

  await processFixedAutoSlots(client, loreCache).catch(console.error);

  if (fixedAutoTimer) clearInterval(fixedAutoTimer);
  fixedAutoTimer = setInterval(() => {
    processFixedAutoSlots(client, loreCache).catch(err => {
      console.error("Fixed auto scheduler error:", err);
    });
  }, 30 * 1000);
}

export async function rerollAllPrices(tiendaItems, armeriaItems, mercaderItems) {
  if (typeof db.rerollMarketPrices !== "function") return;
  await db.rerollMarketPrices("tienda", tiendaItems).catch(() => {});
  await db.rerollMarketPrices("armeria1", armeriaItems).catch(() => {});
  await db.rerollMarketPrices("armeria2", armeriaItems).catch(() => {});
  await db.rerollMarketPrices("mercader", mercaderItems).catch(() => {});
}
