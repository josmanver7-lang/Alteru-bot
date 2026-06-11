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
  "Simón Bolívar",
  "Mablung",
  "Bifur",
  "Cristiano Ronaldo",
  "Galdor",
  "Rúmil",
  "Thalion",
  "Ithron"
];

const merchantCities = [
  "Calembel", "Linhir", "Pelargir", "Morlad", "Sardol", "Ost Ardnír", "Dínadab",
  "Lothgobel", "Ethring", "Ost Anglebed", "Bâr Húrin", "Dol Amroth", "Arnach",
  "Minas Tirith", "Ost Rimmon", "Folde Este", "Andrast", "Edoras", "Folde Oeste",
  "Bree", "Esteldín", "Combe", "Cair Andros", "Ciudad de Valle", "Ost Guruth"
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function truncate(text, max = 1800) {
  const clean = String(text || "").trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1).trimEnd() + "…";
}

function scheduleLoop(getDelay, task) {
  let stopped = false;
  let timeoutId = null;

  const run = async () => {
    if (stopped) return;

    let delay = 0;
    try {
      delay = await getDelay();
    } catch (err) {
      console.error("Scheduler delay error:", err);
      delay = TWELVE_HOURS;
    }

    timeoutId = setTimeout(async () => {
      if (stopped) return;

      try {
        await task();
      } catch (err) {
        console.error("Scheduler task error:", err);
      }

      if (!stopped) {
        run();
      }
    }, Math.max(0, delay));
  };

  run();

  return () => {
    stopped = true;
    if (timeoutId) clearTimeout(timeoutId);
  };
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
    return personajes.find(p => String(p.id || p.nombre || "").toLowerCase() === id) || {};
  }
  return personajes?.[id] || {};
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
          content:
            "Escribes textos de ambientación para un bot de Discord ambientado en un campamento de la Tierra Media. Responde solo con el texto pedido, sin explicaciones."
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

async function ensureTablonSelection() {
  const current = await db.getEventState("tablon");
  if (Array.isArray(current?.selection) && current.selection.length === 5) {
    return current.selection;
  }

  const missions = await loadJson("misiones.json").catch(() => []);
  const selection = [...missions].sort(() => Math.random() - 0.5).slice(0, 5);

  await db.setEventState("tablon", {
    lastAt: Date.now(),
    nextAt: Date.now() + TWELVE_HOURS,
    selection
  });

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

  await db.setEventState("tablon", {
    lastAt: Date.now(),
    nextAt: Date.now() + TWELVE_HOURS,
    selection
  });

  await channel.send(`🌅 **Actualización del tablón**\n\n${truncate(text)}`);
}

async function openMerchant(client) {
  const existing = await db.getEventState("merchant");
  if (existing?.active) return;

  const channel = await fetchChannel(client);
  if (!channel) return;

  const merchantName = pick(merchantNames);
  const destination = pick(merchantCities);

  const stock = await loadJson("mercader.json").catch(() => ({ items: [] }));
  const items = Array.isArray(stock.items) ? stock.items : [];

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

  const stockLines = items
    .slice(0, 6)
    .map(item => `• ${item.nombre} — ${item.precio} pts`)
    .join("\n");

  await channel.send(
    `🚚 **Llega el mercader ambulante**\n\n${truncate(intro)}\n\n${
      stockLines ? `**Mercancía destacada:**\n${stockLines}` : ""
    }`.trim()
  );

  await db.setEventState("merchant", {
    active: true,
    name: merchantName,
    destination,
    openedAt: Date.now(),
    closesAt: Date.now() + MERCHANT_OPEN_MS,
    nextAt: Date.now() + TWELVE_HOURS,
    stock: items
  });

  setTimeout(async () => {
    const state = await db.getEventState("merchant");
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
    });
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

  const theme = Math.random() < 0.45
    ? "Thûlazar, el enemigo principal del campamento, y cómo desorienta a los viajeros"
    : pick(themes);

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
    text =
`💬 ${personaA.nombre || companionNames[a]}: Thûlazar sigue dejando su rastro en los caminos; lo noto en el viento.
💬 ${personaB.nombre || companionNames[b]}: Entonces habrá que vigilar mejor. ¿Dónde lo viste esta vez?`;
  }

  await channel.send(`💬 **Conversación entre compañeros**\n\n${truncate(text, 1900)}`);
}

async function resumeMerchantIfNeeded(client) {
  const state = await db.getEventState("merchant");
  if (!state?.active) return;

  const remaining = Math.max(0, state.closesAt - Date.now());
  if (remaining <= 0) return;

  const channel = await fetchChannel(client);
  if (!channel) return;

  setTimeout(async () => {
    const latest = await db.getEventState("merchant");
    if (!latest?.active) return;

    await channel.send(
      `🧳 **El mercader se retira**\n\n${latest.name}: Lo siento, debo recoger y partir. Mi próximo destino me espera. Capitán Altéru, gracias por dejarme el espacio; espero volver pronto.`
    );

    await db.setEventState("merchant", {
      active: false,
      name: latest.name,
      destination: latest.destination,
      openedAt: latest.openedAt,
      closedAt: Date.now(),
      nextAt: Date.now() + TWELVE_HOURS
    });
  }, remaining);
}

function startSchedulers(client, loreCache) {
  ensureTablonSelection().catch(console.error);
  resumeMerchantIfNeeded(client).catch(console.error);

  scheduleLoop(
    async () => {
      const state = await db.getEventState("tablon");
      return state?.nextAt ? Math.max(0, state.nextAt - Date.now()) : TWELVE_HOURS;
    },
    () => refreshTablonSelection(client, loreCache)
  );

  scheduleLoop(
    async () => {
      const state = await db.getEventState("merchant");
      return state?.nextAt ? Math.max(0, state.nextAt - Date.now()) : TWELVE_HOURS;
    },
    () => openMerchant(client)
  );

  scheduleLoop(
    async () => {
      const state = await db.getEventState("dialogue");
      return state?.nextAt ? Math.max(0, state.nextAt - Date.now()) : TWELVE_HOURS;
    },
    async () => {
      await companionDialogue(client, loreCache);
      await db.setEventState("dialogue", {
        lastAt: Date.now(),
        nextAt: Date.now() + TWELVE_HOURS
      });
    }
  );
}

export { startSchedulers };
