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
const CYCLE_HOURS = [11:05, 23:05];

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

const merchantNames = ["Barahir", "Mablung", "Berenil", "Galdor", "Rúmil", "Thalion", "Ithron", "Haldir"];

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

  const candidates = CYCLE_HOURS.map(hour => {
    const d = new Date(nowLocal);
    d.setUTCHours(hour, 0, 0, 0);
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

async function ensureTablonSelection() {
  const current = await db.getEventState("tablon").catch(() => null);
  if (Array.isArray(current?.selection) && current.selection.length === 5) return current.selection;

  const missions = await loadJson("misiones.json").catch(() => []);
  const selection = [...missions].sort(() => Math.random() - 0.5).slice(0, 5);

  await db.setEventState("tablon", {
    cycleId: Date.now(),
    lastAt: Date.now(),
    nextAt: Date.now() + TWELVE_HOURS,
    selection
  }).catch(() => {});

  return selection;
}

async function rollCatalogSelection(key, items, limit = 12) {
  const selection = [...items].sort(() => Math.random() - 0.5).slice(0, Math.min(limit, items.length));
  await db.setEventState(key, { selection, lastAt: Date.now(), nextAt: Date.now() + TWELVE_HOURS, cycleId: Date.now() }).catch(() => {});
  return selection;
}

async function refreshTablonSelection(client, loreCache) {
  const channel = await fetchChannel(client);
  if (!channel) return;

  const personajes = await loadPersonajes(loreCache);
  const announcerId = pick(companionIds);
  const announcer = getPersonaje(personajes, announcerId);

  const prompt = `
Escribe un mensaje de ambientación en español, de entre 90 y 140 palabras.

El personaje es ${announcer.nombre || companionNames[announcerId]}.
Debe acercarse al tablón de anuncios, martillear un par de veces y clavar cinco nuevas expediciones.
Luego se retira para continuar con sus tareas.
Tono natural, de rol y con vida de campamento.
No menciones que es una IA.
`.trim();

  let text = await generateAIText(prompt).catch(() => "");
  if (!text) {
    text = `${announcer.nombre || companionNames[announcerId]} se acerca al tablón de anuncios, martillea un par de veces y clava cinco nuevas expediciones antes de retirarse a continuar con sus tareas.`;
  }

  const missions = await loadJson("misiones.json").catch(() => []);
  const selection = [...missions].sort(() => Math.random() - 0.5).slice(0, 5);
  await db.setEventState("tablon", { cycleId: Date.now(), lastAt: Date.now(), nextAt: Date.now() + TWELVE_HOURS, selection }).catch(() => {});
  await channel.send(`🌅 **Actualización del tablón**\n\n${truncate(text)}`);
}

async function refreshCatalogPricesAndSelections() {
  const tienda = await loadJson("tienda.json").catch(() => ({}));
  const armeria = await loadJson("armeria.json").catch(() => ({}));
  const mercader = await loadJson("mercader.json").catch(() => ({}));

  const tiendaItems = Array.isArray(tienda?.items) ? tienda.items : [];
  const armeriaItems = Array.isArray(armeria?.items) ? armeria.items : (Array.isArray(armeria?.equipo) ? armeria.equipo : []);
  const mercaderItems = Array.isArray(mercader?.items) ? mercader.items : [];

  await rollCatalogSelection("tienda", tiendaItems, 12);
  await rollCatalogSelection("armeria", armeriaItems, 12);
  await rollCatalogSelection("mercader", mercaderItems, 12);

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
  const catalogItems = Array.isArray(stockCatalog.items) ? stockCatalog.items : [];
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

  let intro = await generateAIText(prompt).catch(() => "");
  if (!intro) {
    intro = `${merchantName}: ¡Bienvenidos a mi negocio! Tengo mercancías que podrían interesarles, pero solo puedo quedarme dos horas. Después partiré hacia ${destination}.`;
  }

  const stockLines = items.slice(0, 6).map(item => `• ${item.nombre} — ${item.precioBase ?? item.precio ?? 0} pts`).join("\n");
  await channel.send(`🚚 **Llega el mercader ambulante**\n\n${truncate(intro)}\n\n${stockLines ? `**Mercancía destacada:**\n${stockLines}` : ""}`.trim());

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

    let farewell = await generateAIText(closePrompt).catch(() => "");
    if (!farewell) {
      farewell = `${state.name}: Lo siento, debo recoger y partir. Mi próximo destino me espera. Capitán Altéru, gracias por dejarme el espacio; espero volver pronto.`;
    }

    await channel.send(`🧳 **El mercader se retira**\n\n${truncate(farewell)}`);

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

async function companionDialogue(client, loreCache) {
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

  const theme = Math.random() < 0.45 ? "Thûlazar, el enemigo principal del campamento, y cómo desorienta a los viajeros" : pick(themes);

  const prompt = `
Escribe un diálogo breve en español entre dos compañeros del Campamento de Altéru.

Compañero A: ${personaA.nombre || companionNames[a]}
Personalidad A: ${personaA.personalidad || personaA.descripcion || personaA.tono || "sin definir"}

Compañero B: ${personaB.nombre || companionNames[b]}
Personalidad B: ${personaB.personalidad || personaB.descripcion || personaB.tono || "sin definir"}

Tema:
${theme}

Contexto de historia útil:
${history}

Reglas:
- Entre 220 y 320 palabras.
- Debe parecer una escena de rol natural.
- Cada intervención debe llevar el nombre del personaje al inicio.
- Uno habla y el otro responde o pregunta.
- Si aparece Altéru, puede contar una hazaña o hablar de Thûlazar.
- Español.
- No menciones que es una IA.
`.trim();

  let text = await generateAIText(prompt).catch(() => "");
  if (!text) {
    text = `💬 ${personaA.nombre || companionNames[a]}: Thûlazar sigue dejando su rastro en los caminos; lo noto en el viento.\n💬 ${personaB.nombre || companionNames[b]}: Entonces habrá que vigilar mejor. ¿Dónde lo viste esta vez?`;
  }

  await channel.send(`💬 **Conversación entre compañeros**\n\n${truncate(text, 1900)}`);
}

async function openCycleEvents(cycleStartMs, client, loreCache) {
  clearCycleTimers();
  await refreshTablonSelection(client, loreCache).catch(console.error);
  await refreshCatalogPricesAndSelections().catch(console.error);

  scheduleCycleRandomEvents(cycleStartMs, [
    { minOffsetMs: 60 * 60 * 1000, maxOffsetMs: 4 * 60 * 60 * 1000, task: () => openMerchant(client) },
    { minOffsetMs: 6 * 60 * 60 * 1000, maxOffsetMs: 10 * 60 * 60 * 1000, task: () => openMerchant(client) }
  ]);

  scheduleCycleRandomEvents(cycleStartMs, [
    { minOffsetMs: 2 * 60 * 60 * 1000, maxOffsetMs: 5 * 60 * 60 * 1000, task: () => companionDialogue(client, loreCache) },
    { minOffsetMs: 7 * 60 * 60 * 1000, maxOffsetMs: 11 * 60 * 60 * 1000, task: () => companionDialogue(client, loreCache) }
  ]);
}

async function resumeMerchantIfNeeded(client) {
  const state = await db.getEventState("merchant").catch(() => null);
  if (!state?.active) return;

  const remaining = Math.max(0, state.closesAt - Date.now());
  if (remaining <= 0) return;

  const channel = await fetchChannel(client);
  if (!channel) return;

  if (merchantCloseTimer) clearTimeout(merchantCloseTimer);
  merchantCloseTimer = setTimeout(async () => {
    const latest = await db.getEventState("merchant").catch(() => null);
    if (!latest?.active) return;

    await channel.send(`🧳 **El mercader se retira**\n\n${latest.name}: Lo siento, debo recoger y partir. Mi próximo destino me espera. Capitán Altéru, gracias por dejarme el espacio; espero volver pronto.`);
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

function scheduleCaracasCycle(client, loreCache) {
  let stopped = false;

  const scheduleNext = () => {
    if (stopped) return;
    const nextMs = getNextCaracasBoundaryMs();
    const delay = Math.max(0, nextMs - Date.now());

    boundaryTimer = setTimeout(async () => {
      if (stopped) return;
      try {
        await openCycleEvents(Date.now(), client, loreCache);
      } catch (err) {
        console.error("Scheduler boundary error:", err);
      }
      scheduleNext();
    }, delay);
  };

  scheduleNext();

  return () => {
    stopped = true;
    if (boundaryTimer) clearTimeout(boundaryTimer);
    if (merchantCloseTimer) clearTimeout(merchantCloseTimer);
    clearCycleTimers();
  };
}

export async function startSchedulers(client, loreCache) {
  await hydrateSchedulerPersonajesCache(loreCache).catch(() => {});
  await ensureTablonSelection().catch(console.error);
  await refreshCatalogPricesAndSelections().catch(console.error);
  await resumeMerchantIfNeeded(client).catch(console.error);
  scheduleCaracasCycle(client, loreCache);
}

export async function rerollAllPrices(tiendaItems, armeriaItems, mercaderItems) {
  if (typeof db.rerollMarketPrices === "function") {
    await db.rerollMarketPrices("tienda", tiendaItems).catch(() => {});
    await db.rerollMarketPrices("armeria", armeriaItems).catch(() => {});
    await db.rerollMarketPrices("mercader", mercaderItems).catch(() => {});
  }
}
