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
// ESCENAS MANUALES Y DIÁLOGOS IA
// ==========================================

const companionScenes = [
  {
    id: "escena_1",
    text: `*Todos los compañeros están sentados en torno a la fogata compartiendo la cena, Andaer el más inquieto decide romper hielo y pregunta mirando a Altéru:* 💬 Andaer: "¿No ha habido alguna otra pista sobre el nigromante? Me dijeron que ayer otro viajero que decidió explorar solo se perdió y dijo haber sentido una presencia maligna cerca de un claro con una piedra en el centro, pero por miedo no quiso acercarse."\n\n*Cirdil que estaba junto a él le continuó:* 💬 Cirdil: "Acompañé ayer a un enano pero el muy sensato llevó una antorcha, de no ser por eso nos hubiésemos perdido en la oscuridad, pero logramos encontrar el camino y acampar cerca."\n\n*Altéru se removió un poco sobre el tronco en el que estaba sentado junto a Nieriel y tras aclararse un poco la voz dijo:*\n\n💬 Altéru: "Thûlazar debe estar en alguna parte, no podrá esconderse para siempre. Estoy esperando al viajero que me traiga más pistas y vayamos juntos a cazarlo."`
  },
  {
    id: "escena_2",
    text: `*Duinor enseña a Andaer como mantener la postura en un combate contra enemigos numerosos.*\n\n💬 Duinor: "Con mi mandoble mantengo al enemigo a distancia, y atacó a quienes creo más valientes, es como un la fila de pilares, si el más grande se cae los demás se vienen abajo."\n\n*Andaer trataba de mantenerse fuera del alcance del arma del campeón Lamedoniano, pero tras esperar el momento se acercó a su rival y le apoyó su espada de práctica en el cuello*\n\n💬 Andaer: "Eso si entre tus enemigos no hay alguien tan valiente como el Leal Escudero de Altéru."\n\n💬 Duinor: "No creas que por decir eso van a promoverte a Sargento."`
  },
  {
    id: "escena_3",
    text: `*Faelon enseña a Nieriel cómo usar la planta de Athelas, usando a uno de los montaraces de Arathir como paciente de prácticas."\n\n💬 Faelon: "En nuestro refugio cada herida es cuidada con el conocimiento y la dedicación que ameritan, no es sólo los ingredientes que aplicas, sino comprender los efectos negativos de cualquier descuido."\n\n*Nieriel seguía las indicaciones de su instructor sin interrumpir sus indicaciones aplicando una manta húmeda con ungüentos especiales para cortes."\n\n💬 Nieriel: "Será mejor que te apoyes y reposes hasta mañana, seguro que al amanecer la herida estará cerrada y sin que haya ninguna infección."\n\n*El montaraz silencioso obedeció a la doncella del cisne y se recostó para tratar de encontrar el sueño.*`
  },
  {
    id: "escena_4",
    text: `*Amanecía otro día en el campamento y Cirdil se preparaba para encender la fragua, reunió el carbón y la leña y luego de limpiar avivó el fuego hasta que logró la constancia adecuada.*\n\n💬 Duinor: "¿Me afilas el mandoble? Siempre dices no tener tiempo. Ninguno sabe mejor que tú tratar con tanta destreza esa muela de piedra ¿Podrás hacerlo?"\n\n*Cirdil sonreía mientras negaba con la cabeza, preparando sus herramientas para calentar el acero.*\n\n💬 Cirdil: "¿Y yo que obtengo a cambio? Mira todo el trabajo que tengo, y ya le prometí a una de las viajeras acompañarla a una misión en Anfalas. Es muy hermosa por cierto. Pero déjame ver que puedo hacer, quizás cuando termine de preparar esto."\n\n💬 Duinor: "Ya me lo prometiste, estaré cerca de aquí para que no lo olvides."`
  },
  {
    id: "escena_5",
    text: `*Altéru estaba en su tienda charlando con un mercader y entró Cirdil interrumpiendo la conversación.*\n\n💬 Cirdil: "Nieriel quiere que sepas que queda poca carne y han estado llegando varios viajeros durante la semana, me envió a preguntarte que debemos hacer."\n\n💬 Altéru: "¿Los montaraces aún no regresan?" *Cirdil negó rápidamente* "Entonces ordena una partida de caza con los viajeros que estén desocupados, diles que tendrán un descuento en la armeria, Faelon puede ir con ellos."\n\n💬 Cirdil: "Pero es mi armeria. Esta bien, ¡Eh! Eres Bifur ¿No? Me gustan los frutos secos que vendes, se que te debo de la última vez pero avísame cuando te instales para pagarte, además me vas a dar otros dos kilos y te los pago la próxima vez que vengas."`
  },
  {
    id: "escena_6",
    text: `*Andaer agotado de intentar aprender a usar el arco decentemente decidió rendirse y frustrado se lo regresó a su dueño*\n\n💬 Faelon: "No te impacientes muchacho, tu ímpetu puede llegar a ser tu mayor enemigo si no lo sabes controlar."\n\n💬 Andaer: "Tú debes tener mucha paciencia, supongo ¿No es aburrido vivir tanto?"\n\n💬 Faelon: "Para nosotros es un regalo, contemplamos esta tierra con otros ojos, y aunque ha perdido mucho la belleza de otros tiempos no hay amanecer al que no sienta deseos de agradecer a quienes crearon este mundo para nosotros."\n\n💬 Andaer: "¿Cuantos años dijiste que tenias?"\n\n💬 Faelon: "Quinientos tres."`
  },
  {
    id: "escena_7",
    text: `*Nieriel salía de la tienda abruptamente con cierta molestia, algo poco común en ella, detrás le seguía Altéru llamándola y tratando de que se detuviera*\n\n💬 Altéru: "¿Por qué me lo haces tan difícil? Solo quiero que no te arriesgues demasiado más allá del reino, solamente quiero..."\n\n💬 Nieriel: "¿Protegerme? eso ya lo sé, pero no puedes tenerme aquí siempre si hay tantas personas necesitando ayuda contra los invasores en las fronteras. Al traerme de Dol Amrorh me dijiste que tendríamos aventuras y..."\n\n*Altéru puso su índice en sus labios y beso su mejilla izquierda.*\n\n💬 Altéru: "Aún no hemos salido a ninguna expedición, todavía estamos comenzando. Además tampoco olvides que te hice otra promesa ¿La olvidas?"\n\n*Nieriel se cruzó de brazos resignadose y dejándose rodear por él apoyó su cabeza en el hombro derecho el capitán.*`
  },
  {
    id: "escena_8",
    text: `*Los ocho montaraces llegaron una noche con uno de los viajeros de mayor renombre con un gran botín y tres ciervos.*\n\n💬 Montaraz: "Señor la misión fue un absoluto éxito, acabamos con el capitán orco y sus guerreros, logramos traer lo que puede ver. El viajero le entregará el resto del informe."\n\n💬 Altéru: "Todas estas baratijas nos servirán para reforjar espadas, sin duda fue un buen botín, Cirdil estará contento, casi se estaba quedando sin nada que echar a su fragata."\n\n💬 Montaraz: "Hablamos con uno de los locales y nos llevó hasta un ermitaño quien afirmó saber sobre nuestro amigo."\n\n*Altéru lo interrumpió.*\n\n💬 Altéru: "Vayamos a mi tienda y cuéntame lo que te dijo".`
  },
  {
    id: "escena_9",
    text: `*Andaer había llegado con varios campesinos desde Ethring con varios varios materiales de construcción y unas cuantas gallinas y dos gallos.*\n\n💬 Nieriel: "Se acabaron los amaneceres en silencio."\n\n*Duinor curioso se acercó a ellos y los ayudó a ubicar el mejor lugar para poner un lugar gallinero en el campamento.*\n\n💬 Faelon: "¿Altéru lo sabe?"\n\n*Altéru salió de su tienda al oír el alboroto y dijo:*\n\n💬 Altéru: "Detrás de tu tienda, que sean a ti al primero que despierten."`
  },
  {
    id: "escena_10",
    text: `*Nieriel le daba un masaje en la espalda a Altéru mientras él conversaba con sus compañeros en la tienda*\n\n💬 Cirdil: "Esos piel oscura eran unos verdaderos desquiciados, peleaban sin importarles su propia vida, nisiquiera llevaban armadura, casi no tenias tiempo de atacar a alguno porque otro podría noquearte con su garrote si te descuidas."\n\n💬 Duinor: "De no ser porque el viejo Tarannon, que su alma repose en paz y Elphir el flanco derecho hubiera caído, allí la batalla estaría perdida. Los hacheros de Lossarnach defendieron muy bien contra esos Haradrim con escudos de cuero y yelmos intimidantes."\n\n💬 Andaer: "Mi madre no me dejó acudir a la batalla pero la carga de Altéru junto a Imrahil, sus hijos y Angbor el Intrépido se cantará en los salones del príncipe y en los festines usuales de Linhir por muchos años."`
  },
  {
    id: "escena_12",
    text: `*Altéru en su tienda discutía con varios emisarios de la capital quienes eran conocidos por intentar dañar la imagen del capital de las colinas en Minas Tirith*\n\n💬 Altéru: "Proteger nuestras tierras y a nuestra gente ¿No es nuestro deber? Yo sirvo a Gondor, a nadie más. Y ese es aquí nuestro trabajo."\n\n💬 Vorondil: "No eres más que un malcriado que obedece su propio ego, tus acciones siguen siendo rechazadas por muchos consejeros en la capital y al igual que por el honorable Senescal, hijo del sabio Ecthelion II ¿Cómo osas tu a pasearte por el reino como un héroe que no necesitamos? Ve y vuelve a tu casa, en Pinnath Gelin seguro que hay short muchos viñedos a los que atender."\n\n💬 Altéru: "Les permitiré descansar con nosotros esa noche y compartir nuestra cena, pero no abusen de mi hospitalidad"\n\n💬 Vorondil: "No la necesitaremos, no deseamos pasar el resto del día entre gallinas revoloteando de un lado a otro, vamonos compañeros".\n\n💬 Altéru: "Saludos al excelentísimo Senescal Denethor II de mi parte, que salir y pasear alrededor del árbol blanco es buen ejercicio para tomar el sol de vez en cuando."`
  },
  {
    id: "escena_13",
    text: `*Un jinete de la marca se acercó al campamento en solitario, fue bien recibido y Altéru salió de su tienda para atenderlo*\n\n💬 Altéru: "Saludos, estimado Jinete, pocos son los siervos del rey de Rohan en acercarse a estas tierras y menos en pisar mi humilde campamento."\n\n*El jinete hizo una leve reverencia, se quitó el casco y mostró sus facciones eorlingas.*\n\n💬 Rohirrim: "Es un gran honor conocerle Capitán de las Colinas, aquel que sobrevivió a las penurias del sur. Sus historias han llegado hasta el Folde Este y más allá, nuestras fronteras son atravesadas por orcos desde muy al norte, necesitamos su ayuda para enviar exploradores que cubran el lejano Anorien. En la capital nuestras peticiones no son escuchadas."\n\n💬 Altéru: "Así será Jinete de la Marca, cuenta con mi ayuda, háblale de mi a tu señor."\n\n💬 Rohirrim: "Lo haré, mi señor Eomer estará muy complacido en conocerle."`
  },
  {
    id: "escena_14",
    text: `*Llovía con fuerza esa noche y uno de los montaraces de guardia a esa hora dio la alarma de ataque*\n\n💬 Montaraz: "¡Estamos bajo ataque!"\n\n*Todos los guerreros se dispusieron en los lugares más vulnerables del campamento para defenderse de hordas de trasgos que venían de la montaña y por el camino escondido del norte venían dos trolls de las cavernas.*\n\n*Los montaraces se subieron a las torres improvisadas y disparaban a todo el que se acercaba, Altéru y Nieriel pelearon juntos, intentando que los trasgos no intentarán quemar ninguna tienda. Andaer, Duinor y Cirdil pelearon con ferocidad animados por el constante sonido del cuerno del capitán Altéru.*\n\n💬 Altéru: "Esa armadura no te luce mal mi vida ¿No te lo había dicho?" *A lo que Nieriel sonrió alzando su escudo y espada*\n\n*Tras una hora de combate los pocos trasgos que quedaron huyeron y Faelon se preparó para atender las heridas de todos.*`
  },
  {
    id: "escena_15",
    text: `*Varios campesinos llegaron a las puertas del campamento pidiendo ayuda contra unos huargos que se habían adentrado en la zona norte entre Lamedon y Blackroot Vale.*\n\n💬 Altéru: "No hay tiempo de colocar ningún aviso de expedición, escogan a los viajeros más dispuestos y vayan a darles caza."\n\n💬 Nieriel: "¿Tú iras?"\n\n💬 Altéru: "No, nos quedaremos aquí, espero recibir la visita de unos marineros para comerciar provisiones con Linhir."`
  },
  {
    id: "escena_16",
    text: `*Un viajero acompañado por Faelon y Cirdil trajeron a un capitán corsario amordazado frente a la tienda del capitán, colocándolo de rodillas.*\n\n💬 Altéru: "¿Sabes quien soy no? ¿Y sabes que me gusta hacerle a los capitanes piratas que se dedican a hacer el mal en nuestras tierras? No me respondas, por tus ojos se que lo sabes. ¡Traiganme una estaca afilada en la punta! No. Que estoy bromeando."\n\n💬 Altéru: "Llévenlo a la jaula de las gallinas y busquenle otro lugar a las aves, tengo preguntas que hacerle a nuestro invitado."\n\n*Faelon y Cirdil obedecieron y se llevaron al prisionero detrás de la tienda de Andaer y Duinor.*`
  },
  {
    id: "escena_17",
    text: `*Una noche oscura iluminada por las estrellas, Altéru que no podía dormir, se levantó tratando de no despertar a Nieriel y se dirigió a una de las torres de vigilancia donde uno de los montaraces hacia guardia*\n\n💬 Altéru: "¿Puedo subir? Es que simplemente no puedo dormir y deseo conversar un poco. ¿Alguna novedad que reportar?"\n\n💬 Montaraz: "Todo está tranquilo señor, durante mi guardia no ha habido nada que reportar."\n\n💬 Altéru: "¿Cómo te sientes aquí? Sabes que también lo extraño y pienso lo descuidado que fue al dejar que aquello pasara. Pero es el riesgo a los que nos exponemos."\n\n💬 Montaraz: "El Capitán Arathir era el mejor hombre al que conocí, después de usted. Nos conocíamos de toda la vida y siempre le seguimos. Ahora obedemiemos su última voluntad y estamos bajo sus ordenes."\n\n💬 Altéru: "Más allá de eso, quiero que te sientas bien, no estamos en el norte, al menos no por ahora. Continua vigilando, no quisiera otro ataque de alimañas de las montañas.\n\n💬 Montaraz: "Así será señor."`
  },
  {
    id: "escena_18",
    text: `*Altéru se encontraba conversando con varios viajeros recién llegados junto a Nieriel, en los que había Hobbits, Enanos, Élfos incluso un hombre oso, o Beórnida. Hasta que Cirdil lo llamó a cierta distancia.*\n\n💬 Cirdil: "Altéru necesito hablar contigo"\n\n💬 Altéru: "¿Qué pasa? ¿Ocurre algo?"\n\n💬 Cirdil: "Ya sabes que mi mujer está embarazada y debe tener ya seis meses, así que me gustaría ir a verla, entonces te quería preguntar si me podía ausentar una semana."\n\n💬 Altéru: "Claro, ve y mira como sigue, envíale mi saludos, pero no te demores demasiado, sabes que aquí necesitamos manos."\n\n💬 Cirdil: "Gracias Altéru, sabes que eres como un hermano."\n\n💬 Altéru: "Tú igual, cuando tu hijo nazca le diré que soy su tío. Bueno, márchate cuando te quieras ir, toma el camino principal y no acampes lejos de una ciudad."`
  },
  {
    id: "escena_19",
    text: `*Altéru tenía algunos minutos buscando a Faelon hasta que se le ocurrió buscarlo en su tienda, allí lo encontró sumido en sus pergaminos, leyendo gracias a la luz de una pequeña vela a la que le quedaba poco menos de unos treinta minutos*\n\n💬 Altéru: "Elfo, estaba buscándote. Quería preguntarte sobre... ¿Qué es eso que lees?"\n\n💬 Faelon: "¿Cuál? ¿Este o este otro? Estoy haciendo algunas comparaciones. El que tengo a mi derecha narra la batalla de Azanulbizar, una lucha memorable entre Enanos y trasgos."\n\n*Altéru se acercó más a él y trató de leer por encima un poco aquel pergamino*\n\n💬 Altéru: "Quince mil Enanos contra sesenta mil orcos, debió ser una masacre."\n\n💬 Faelon: "Y la fue, aunque orcos y trasgos murieron o huyeron casi todos, muchos Enanos no sobrevivieron aquel combate. A Imladris llegaron las noticias, una agridulce. Un enemigo que teníamos muy cerca habia desaparecido, pero tantos hombres de Thráin II que habían caído, fue doloroso incluso para nosotros."`
  },
  {
    id: "escena_20",
    text: `*Había una pequeña discusión en la tienda que era atendida aveces por Duinor y aveces por Faelon, en la que Altéru tuvo que intervenir.*\n\n💬 Altéru: "¿Qué ocurre Duinor? ¿Y cuál es este alboroto?"\n\n💬 Duinor: "Se quejan de los precios Altéru, las provisiones de camino casi duplican su precio de una semana a otra, y se quejan por esto."\n\n"¡Es injusto, es un robo!" *Bramó uno de los viajeros.*\n\n💬 Altéru: "Entiendo que estén molestos porque los precios no son estables, pero estamos en estado de guerra y la economía se tambalea, no soy yo quien decide los precios, sino las caravanas y comerciantes que llegan cada día para comerciar. A ellos también les afecta y a cada Gondoriano que viva dentro de los límites de nuestro reino. Alguno de ustedes quizás ayer luchó contra un troll lo derrotó ¿Y hoy se queja por el precio de un pan de lembas? Dejar tanto escándalo que tengo visitas por atender, van a pensar que esto es un nido de bandidos."`
  }
];

const COMPANION_SCENES_KEY = "companion_scenes";
const COMPANION_SCENE_HISTORY_LIMIT = 15;

async function companionDialogue(client, loreCache, slotId = null) {
  const channel = await fetchChannel(client);
  if (!channel) return;

  const personajes = await loadPersonajes(loreCache);
  const historyText = String(loreCache?.historia_completa || "").slice(0, 3000);

  // Seleccionamos un par de escenas manuales para darle contexto y estilo a la IA
  const sampleScenesContext = [...companionScenes]
    .sort(() => Math.random() - 0.5)
    .slice(0, 2)
    .map(s => s.text)
    .join("\n\n---\n\n");

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
      `Contexto general de historia útil:\n${historyText}\n\n` +
      `Toma como base de datos de estilo narrativo estas interacciones previas:\n${sampleScenesContext}\n\n` +
      `Reglas:\n` +
      `- Entre 200 y 300 palabras.\n` +
      `- Debe parecer una escena de rol natural, similar a los ejemplos de estilo provistos.\n` +
      `- Cada intervención debe llevar el nombre del personaje al inicio, y acciones entre asteriscos.\n` +
      `- Uno habla y el otro responde o pregunta.\n` +
      `- Si el tema es entrenamiento, debe sentirse como un combate amistoso con espadas de madera.\n` +
      `- Español.\n` +
      `- No pongas título.\n` +
      `- Usa solo información a la que tengas acceso respecto al personaje. No inventes nada.`,
      350 
    );
  } catch (err) {
    console.error("Error generando diálogo entre compañeros:", err);
  }

  if (!text || text === "*observa en silencio*") {
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

function chunkDiscordText(text, limit = 1900) {
  const chunks = [];
  const paragraphs = String(text || "").split(/\n{2,}/);
  let current = "";

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;

    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = "";
    }

    if (paragraph.length <= limit) {
      current = paragraph;
      continue;
    }

    let start = 0;
    while (start < paragraph.length) {
      chunks.push(paragraph.slice(start, start + limit));
      start += limit;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

async function sendLongScene(channel, text) {
  const chunks = chunkDiscordText(text, 1900);
  if (!chunks.length) return;

  for (const chunk of chunks) {
    await channel.send(chunk);
  }
}

async function getCompanionSceneState() {
  return await db.getEventState(COMPANION_SCENES_KEY).catch(() => null);
}

async function saveCompanionSceneState(state) {
  await db.setEventState(COMPANION_SCENES_KEY, state).catch(() => {});
}

async function pickCompanionSceneForCycle(cycleStartMs = getCycleBounds().cycleStartAt, slot = 0) {
  const state = await getCompanionSceneState();

  const scenesPosted = Array.isArray(state?.scenesPosted) ? [...state.scenesPosted] : [];
  const history = Array.isArray(state?.history) ? [...state.history] : [];

  // Comprobar si ya existe una asignada en este slot y extraerla solo por su ID
  const existingForSlot = scenesPosted.find(entry => entry.slot === slot);
  if (state?.cycleId === cycleStartMs && existingForSlot) {
    const searchId = existingForSlot.sceneId || existingForSlot.scene?.id;
    if (searchId) {
      const freshScene = companionScenes.find(s => s.id === searchId);
      if (freshScene) return freshScene; 
      // Si freshScene no existe, significa que fue borrada del código duro. Pasamos de largo para escoger otra.
    }
  }

  const recent = new Set(history.slice(-COMPANION_SCENE_HISTORY_LIMIT));
  const usedIds = new Set(scenesPosted.map(entry => entry.sceneId || entry.scene?.id).filter(Boolean));

  let pool = companionScenes.filter(scene => !recent.has(scene.id) && !usedIds.has(scene.id));

  if (!pool.length) {
    pool = companionScenes.filter(scene => !usedIds.has(scene.id));
  }

  if (!pool.length) {
    pool = companionScenes;
  }

  const chosen = pool[Math.floor(Math.random() * pool.length)];
  if (!chosen) return null;

  // Actualizamos o añadimos la escena para este slot (guardando solo el ID, para evitar fantasmas en caché)
  const existingIndex = scenesPosted.findIndex(entry => entry.slot === slot);
  if (existingIndex > -1) {
    scenesPosted[existingIndex] = { slot, sceneId: chosen.id, postedAt: Date.now() };
  } else {
    scenesPosted.push({ slot, sceneId: chosen.id, postedAt: Date.now() });
  }

  await saveCompanionSceneState({
    cycleId: cycleStartMs,
    postedAt: state?.postedAt || Date.now(),
    scenesPosted,
    history: [...history, chosen.id].slice(-COMPANION_SCENE_HISTORY_LIMIT)
  });

  return chosen;
}

async function publishCompanionScene(client, cycleStartMs = getCycleBounds().cycleStartAt, slot = 0) {
  const channel = await fetchChannel(client);
  if (!channel) return;

  const scene = await pickCompanionSceneForCycle(cycleStartMs, slot);
  if (!scene) return;

  const header = scene.title ? `🌿 **${scene.title}**\n\n` : "";
  await sendLongScene(channel, `${header}${scene.text}`);
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
    await companionDialogue(client, loreCache, slot.id);
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
