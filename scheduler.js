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

async function ai(prompt) {
  if (!OPENROUTER_API_KEY) return "";
// scheduler.js — helper para IA sin texto manual
async function generateAITextStrict(prompt) {
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
      max_tokens: 240
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
Título: ${context?.titulo || "sin título"}
Tipo: ${context?.tipo || "desconocido"}
Categoría: ${context?.categoria || "desconocida"}
Peligro: ${context?.peligro ?? 0}
Estilo del encuentro: ${getEncounterReactionStyle(context)}
Descripción:
${context?.descripcion || context?.textoExito || context?.textoFracaso || ""}

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
    const clean = stripCompanionPrefix(raw, nombre);
    return `${nombre}: ${compactLine(clean, 40)}`;
  } catch {
    return `${nombre}: *observa el camino de regreso en silencio*`;
  }
}

async function getMissionClosingReactions(owned, expedition) {
  const reactions = [];
  for (const cid of [...new Set(owned)].slice(0, 3)) {
    const line = await companionReaction(
      cid,
      {
        titulo: expedition.mission.titulo,
        tipo: expedition.mission.encuentros?.at(-1) || "evento_especial",
        categoria: "mision_completada",
        descripcion: `${expedition.mission.descripcion || ""}\n\n${expedition.mission.textoExito || ""}`
      },
      "mision_completada"
    );
    if (line) reactions.push(`💬 ${line}`);
  }
  return reactions;
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
  const tienda = await loadJson("tienda.json").catch(() => ({}));
  const armeria = await loadJson("armeria.json").catch(() => ({}));
  const mercader = await loadJson("mercader.json").catch(() => ({}));

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

// scheduler.js — tablón sin fallback manual
async function refreshTablonSelection(client, loreCache) {
  const channel = await fetchChannel(client);
  if (!channel) return;

  const personajes = await loadPersonajes(loreCache);
  const announcerId = pick(companionIds);
  const announcer = getPersonaje(personajes, announcerId);
  const announcerName = announcer?.nombre || companionNames[announcerId] || announcerId;

  const prompt = `
Escribe un mensaje de ambientación en español, de entre 90 y 140 palabras.

El personaje es ${announcerName}.
Debe acercarse al tablón de anuncios, martillear algunas veces y clavar cinco nuevas expediciones.
Luego se retira para continuar con sus tareas.
Tono natural, de rol y con vida de campamento.
No menciones que es una IA.
`.trim();

  let text;
  try {
    text = await generateAITextStrict(prompt);
  } catch (err) {
    console.error("Error generando texto IA del tablón:", err);
    return;
  }

  const missions = await loadJson("misiones.json").catch(() => []);
  const selection = [...missions].sort(() => Math.random() - 0.5).slice(0, 5);

  await db.setEventState("tablon", {
    cycleId: Date.now(),
    lastAt: Date.now(),
    nextAt: Date.now() + TWELVE_HOURS,
    selection
  }).catch(() => {});

  await channel.send(`🌅 **ACTUALIZACIÓN DEL TABLÓN** 🌅\n\n${truncate(text)}`);
}

// scheduler.js — mercader sin fallback manual
async function openMerchant(client) {
  const existing = await db.getEventState("merchant").catch(() => null);
  if (existing?.active) return;

  const channel = await fetchChannel(client);
  if (!channel) return;

  const merchantName = pick(merchantNames);
  const destination = pick(merchantCities);
  const stockCatalog = await loadJson("mercader.json").catch(() => ({ items: [] }));
  const catalogItems = Array.isArray(stockCatalog.items) ? stockCatalog.items : Array.isArray(stockCatalog) ? stockCatalog : [];
  const catalogState = await db.getEventState("mercader").catch(() => null);
  const items = Array.isArray(catalogState?.selection) && catalogState.selection.length ? catalogState.selection : catalogItems;

  const prompt = `
Escribe un mensaje de llegada de un mercader ambulante para Discord, en español, de entre 90 y 150 palabras.

Debe incluir:
- Su nombre: ${merchantName}
- Que pide permiso para instalarse junto a la tienda
- Que dice que solo permanecerá 2 horas
- Que después seguirá hacia ${destination}
- Tono de rol medieval/Tierra Media
- Natural, cálido y convincente
No menciones que es una IA.
`.trim();

  let intro;
  try {
    intro = await generateAITextStrict(prompt);
  } catch (err) {
    console.error("Error generando llegada del mercader:", err);
    return;
  }

  const stockLines = items.slice(0, 6).map(item => `• ${item.nombre} — ${item.precioBase ?? item.precio ?? 0} pts`).join("\n");

  await channel.send(`🚚 **LLEGA EL MERCADER AMBULANTE**\n\n${truncate(intro)}\n\n${stockLines ? `**Mercancía destacada:**\n${stockLines}` : ""}`.trim());

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
Escribe un mensaje de despedida de un mercader ambulante para Discord, en español, de entre 90 y 150 palabras.

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
      farewell = await generateAITextStrict(closePrompt);
    } catch (err) {
      console.error("Error generando despedida del mercader:", err);
      return;
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

  const themes = [
    "Thûlazar, el enemigo principal del campamento, y cómo desorienta a los viajeros",
    "una vieja batalla del pasado",
    "un entrenamiento entre compañeros",
    "un recuerdo del campamento al amanecer",
    "una historia sobre una expedición peligrosa"
  ];

  const theme = Math.random() < 0.45
    ? "Thûlazar, el enemigo principal del campamento, y cómo desorienta a los viajeros"
    : pick(themes);

  let text = "";
  try {
    text = await ai(
      `Escribe un diálogo breve en español entre dos compañeros del Campamento de Altéru.\n\n` +
      `Compañero A: ${personaA.nombre || companionNames[a]}\n` +
      `Personalidad A: ${personaA.personalidad || personaA.descripcion || personaA.tono || "sin definir"}\n\n` +
      `Compañero B: ${personaB.nombre || companionNames[b]}\n` +
      `Personalidad B: ${personaB.personalidad || personaB.descripcion || personaB.tono || "sin definir"}\n\n` +
      `Tema:\n${theme}\n\n` +
      `Contexto de historia útil:\n${history}\n\n` +
      `Reglas:\n` +
      `- Entre 220 y 320 palabras.\n` +
      `- Debe parecer una escena de rol natural.\n` +
      `- Cada intervención debe llevar el nombre del personaje al inicio.\n` +
      `- Uno habla y el otro responde o pregunta.\n` +
      `- Si aparece Altéru, puede contar una hazaña o hablar de Thûlazar.\n` +
      `- Español.\n` +
      `- No menciones que es una IA.`
    );
  } catch (err) {
    console.error("Error generando diálogo entre compañeros:", err);
  }

  if (!text) {
    text = `💬 ${personaA.nombre || companionNames[a]}: Thûlazar sigue dejando su rastro en los caminos; lo noto en el viento.\n💬 ${personaB.nombre || companionNames[b]}: Entonces habrá que vigilar mejor. ¿Dónde lo viste esta vez?`;
  }

  await channel.send(`💬 **CONVERSACIÓN ENTRE COMPAÑEROS**\n\n${truncate(text, 1900)}`);

  if (slotId) await markSlotDone("dialogue", slotId).catch(() => {});
}

// scheduler.js — un solo mercader y un solo diálogo por ciclo
async function openCycleEvents(cycleStartMs, client, loreCache) {
  clearCycleTimers();
  await refreshTablonSelection(client, loreCache).catch(console.error);
  await refreshCatalogPricesAndSelections().catch(console.error);

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

  // Un solo diálogo por ciclo, en otra ventana distinta
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
