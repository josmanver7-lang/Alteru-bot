import * as db from "./database.js";
import { startSchedulers } from "./scheduler.js";
import { Client, GatewayIntentBits } from 'discord.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

if (!DISCORD_TOKEN) throw new Error('Missing DISCORD_TOKEN');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


// VARIABLES PARA IA

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

async function chatWithAI({
  systemPrompt = "",
  messages = [],
  temperature = 0.85,
  maxTokens = 250 // Aumentado para evitar recortes en mensajes de RP
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

  // 2) OPERATOR / respaldo
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

// ================================
// CUOTAS + TIEMPOS
// ================================

const ADMIN_USER_ID = process.env.ADMIN_USER_ID || process.env.OWNER_ID;

const TRIVIA_LIMIT = 3;
const TRIVIA_WINDOW_MS = 12 * 60 * 60 * 1000;

const EXPEDITION_LIMIT = 3;
const EXPEDITION_WINDOW_MS = 12 * 60 * 60 * 1000;

// ================================
// MAPAS EN MEMORIA
// ================================

let personajesCache = {};
let loreCache = null;
let tablonSelection = [];
const triviaGames = new Map();
const expeditions = new Map();
const conversationMemory = new Map();

let tiendaCache = null;
let armeriaCache = null;
let mercaderCache = null;

// ================================
// COMPAÑEROS Y BONIFICACIONES
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
  duinor: {
    nombre: "Duinor",
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

const ITEM_TIER_VALUES = { ninguno: 0, none: 0, comun: 1, forjado: 2, superior: 3, legendario: 4 }; 
const PLAYER_CLASS_BONUS = { 
  guardian: { damageReduction: 0.06 }, 
  vigilante: { explorationBonus: 0.06, successBonus: 0.03 }, 
  campeon: { attackBonus: 0.08, successBonus: 0.03 }, 
  cazador: { explorationBonus: 0.05, rangerBonus: 0.04 }, 
  luchador: { attackBonus: 0.06, damageReduction: 0.02 }, 
  bardo: { negotiationBonus: 0.08 }, 
  guardian_runico: { specialBonus: 0.08, damageReduction: 0.04 }, 
  capitan: { negotiationBonus: 0.08, successBonus: 0.04 }, 
  sabio: { specialBonus: 0.06, explorationBonus: 0.04 }, 
  saqueador: { attackBonus: 0.05, explorationBonus: 0.03 }, 
  marinero: { explorationBonus: 0.08, successBonus: 0.03 }, 
  beornida: { attackBonus: 0.06, damageReduction: 0.04 } 
}; 

const COMPANION_BASE_EQUIPMENT = { 
  alteru: { arma: "Superior", armadura: "Superior", guantes: "Superior", piernas: "Superior", botas: "Legendario", capa: "Legendario", casco: "Superior", hombros: "Superior", anillo1: "Superior", anillo2: "Superior", amuleto: "Ninguno", accesorio: "Ninguno" }, 
  cirdil: { arma: "Superior", armadura: "Forjado", guantes: "Forjado", piernas: "Forjado", botas: "Forjado", capa: "Ninguno", casco: "Forjado", hombros: "Forjado", anillo1: "Forjado", anillo2: "Ninguno", amuleto: "Ninguno", accesorio: "Forjado" }, 
  duinor: { arma: "Superior", armadura: "Superior", guantes: "Superior", piernas: "Superior", botas: "Superior", capa: "Ninguno", casco: "Ninguno", hombros: "Superior", anillo1: "Superior", anillo2: "Ninguno", amuleto: "Ninguno", accesorio: "Ninguno" }, 
  andaer: { arma: "Forjado", armadura: "Forjado", guantes: "Forjado", piernas: "Forjado", botas: "Forjado", capa: "Ninguno", casco: "Forjado", hombros: "Forjado", anillo1: "Forjado", anillo2: "Ninguno", amuleto: "Ninguno", accesorio: "Forjado" }, 
  faelon: { arma: "Forjado", armadura: "Forjado", guantes: "Comun", piernas: "Forjado", botas: "Forjado", capa: "Ninguno", casco: "Ninguno", hombros: "Ninguno", anillo1: "Superior", anillo2: "Forjado", amuleto: "Legendario", accesorio: "Superior" }, 
  nieriel: { arma: "Superior", armadura: "Superior", guantes: "Superior", piernas: "Superior", botas: "Superior", capa: "Forjado", casco: "Superior", hombros: "Superior", anillo1: "Superior", anillo2: "Ninguno", amuleto: "Ninguno", accesorio: "Forjado" }, 
  montaraces: { arma: "Superior", armadura: "Forjado", guantes: "Forjado", piernas: "Forjado", botas: "Forjado", capa: "Superior", casco: "Ninguno", hombros: "Ninguno", anillo1: "Superior", anillo2: "Ninguno", amuleto: "Forjado", accesorio: "Ninguno" } 
};

const INVENTORY_CATEGORIES = ["consumibles", "armas", "armaduras", "permanentes", "regalos", "utilidades"];

// ==========================================
//          FUNCIONES AUXILIARES
// ==========================================

function getPlayerClassKey(profile = {}) { 
  return normalizeKey(profile?.class || profile?.clase || ""); 
} 

function getPlayerClassBonus(profile = {}) { 
  return PLAYER_CLASS_BONUS[getPlayerClassKey(profile)] || {}; 
} 

function getPlayerClassBonusText(profile = {}) { 
  const bonus = getPlayerClassBonus(profile); 
  const parts = []; 
  if (bonus.attackBonus) parts.push(`+${Math.round(bonus.attackBonus * 100)}% Ataque`); 
  if (bonus.damageReduction) parts.push(`+${Math.round(bonus.damageReduction * 100)}% Defensa`); 
  if (bonus.explorationBonus) parts.push(`+${Math.round(bonus.explorationBonus * 100)}% Exploración`); 
  if (bonus.negotiationBonus) parts.push(`+${Math.round(bonus.negotiationBonus * 100)}% Negociación`); 
  if (bonus.specialBonus) parts.push(`+${Math.round(bonus.specialBonus * 100)}% Especial`); 
  if (bonus.rangerBonus) parts.push(`+${Math.round(bonus.rangerBonus * 100)}% Rastreo`); 
  if (bonus.successBonus) parts.push(`+${Math.round(bonus.successBonus * 100)}% Éxito`); 
  return parts.length ? parts.join(" | ") : "Sin bonos de clase"; 
}

function getProfilePowerSummary(profile = {}, equipment = {}) { 
  const lvl = typeof db.calculateLevel === "function" ? db.calculateLevel(profile.xp || 0) : Math.floor((profile.xp || 0) / 1000) + 1; 
  const eqData = getEquipmentPowerSummary(equipment, profile.activeUtilities || []);
  const totals = eqData.totals;
  const classBonus = getPlayerClassBonus(profile); 
  const classPct = Object.values(classBonus).reduce((sum, v) => sum + (typeof v === "number" ? v : 0), 0); 
  const score = Math.max( 1, Math.round( (lvl * 10) + ((totals.damageBonus || 0) * 5) + ((totals.successBonus || 0) * 100) + ((totals.damageReduction || 0) * 100) + (classPct * 100) ) ); 
  return { score, level: lvl, bonusText: getPlayerClassBonusText(profile) }; 
} 

function getEquipmentPowerSummary(equipment = {}, activeUtilities = []) { 
  const totals = sumEquipmentTotals(equipment); 
  
  for (const util of activeUtilities) {
      if (!util || !util.efecto) continue;
      const uStats = getItemPower(util.efecto);
      totals.damageBonus += uStats.damageBonus;
      totals.successBonus += uStats.successBonus;
      totals.damageReduction += uStats.damageReduction;
      totals.explorationBonus += uStats.explorationBonus;
      totals.stealthBonus += uStats.stealthBonus;
      totals.negotiationBonus += uStats.negotiationBonus;
      totals.perceptionBonus += uStats.perceptionBonus;
      totals.combatBonus += uStats.combatBonus;
      totals.survivalBonus += uStats.survivalBonus;
      totals.willpowerBonus += uStats.willpowerBonus;
      totals.healingBonus += uStats.healingBonus;
  }

  const score = Math.max( 1, Math.round( ((totals.damageBonus || 0) * 5) + ((totals.successBonus || 0) * 100) + ((totals.damageReduction || 0) * 100) ) ); 
  return { score, totals, detailText: formatEquipmentTotals(totals) }; 
} 

function getCompanionBaseSummary(companionId) { 
  const base = getCompanionBasePower(companionId); 
  return `Poder ${Math.round(base.total * 2)} | Defensa +${Math.round(base.damageReduction * 100)}%`; 
}

async function loadCatalog(filename) {
  try {
    const raw = await readFile(path.join(__dirname, filename), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function formatPrice(value) {
  return `${Number(value || 0)} pts`;
}

// INVENTARIO HELPER
function normalizeInventory(inventory = {}) {
  const base = Object.fromEntries(INVENTORY_CATEGORIES.map(c => [c, []]));
  const raw = inventory && typeof inventory === "object" ? inventory : {};

  for (const cat of INVENTORY_CATEGORIES) {
    const arr = Array.isArray(raw[cat]) ? raw[cat] : [];
    base[cat] = arr
      .filter(Boolean)
      .map(item => ({
        ...item,
        cantidad: Math.max(1, Number(item.cantidad || 1))
      }));
  }

  return base;
}

function normalizeItemEntry(item, extra = {}) {
  return {
    id: item.id,
    nombre: item.nombre,
    tipo: item.tipo || item.slot || "general",
    slot: item.slot || null,
    raza: item.raza || "general",
    rareza: item.rareza || "comun",
    precioBase: Number(item.precioBase ?? item.precio ?? 0),
    efecto: item.efecto || {},
    descripcion: item.descripcion || "",
    cantidad: 1,
    ...extra
  };
}

function getInventoryCategoryForItem(item) {
  const tipo = normalizeKey(item?.tipo || "");
  const slot = normalizeKey(item?.slot || "");

  if (tipo === "consumible" || tipo === "regalo" || tipo === "utilidad") {
    if (tipo === "regalo") return "regalos";
    if (tipo === "utilidad") return "utilidades";
    return "consumibles";
  }

  if (["arma", "arma_1_mano", "arma_2_manos", "daga", "daga_1_mano"].includes(slot)) {
    return "armas";
  }

  if (slot === "escudo") {
    return "armaduras"; // Simplificado a armaduras para la busqueda
  }

  if (["pecho", "armadura", "casco", "hombros", "brazos", "piernas"].includes(slot)) {
    return "armaduras";
  }

  if (["capa", "anillo", "reliquia", "amuleto", "accesorio"].includes(slot)) {
    return "permanentes";
  }

  return "permanentes";
}

function findInventoryItem(inventory, query) {
  const q = normalizeKey(query);

  for (const cat of INVENTORY_CATEGORIES) {
    const found = (inventory?.[cat] || []).find(item =>
      normalizeKey(item.id) === q || normalizeKey(item.nombre) === q
    );
    if (found) return { category: cat, item: found };
  }

  return null;
}

function isStackableItem(item) {
  const tipo = normalizeKey(item?.tipo || "");
  return tipo === "consumible" || tipo === "regalo" || tipo === "utilidad";
}

function getEquipSlotForItem(item, currentEquipment = {}) {
  const slot = normalizeKey(item?.slot || item?.tipo || "");

  if (slot === "arma_2_manos") return "arma";

  if (["arma", "arma_1_mano", "daga", "daga_1_mano"].includes(slot)) {
    if (!currentEquipment.arma1) return "arma1";
    if (!currentEquipment.arma2) return "arma2";
    return null;
  }

  if (slot === "escudo") return "escudo";

  if (slot === "pecho" || slot === "armadura") return "armadura";
  if (slot === "casco") return "casco";
  if (slot === "hombros") return "hombros";
  if (slot === "brazos") return "brazos";
  if (slot === "piernas") return "piernas";
  if (slot === "pies") return "pies";
  if (slot === "capa") return "capa";

  if (slot === "anillo") {
    if (!currentEquipment.anillo1) return "anillo1";
    if (!currentEquipment.anillo2) return "anillo2";
    return null;
  }

  if (slot === "amuleto") {
    if (!currentEquipment.amuleto) return "amuleto";
    if (!currentEquipment.accesorio) return "accesorio";
    return null;
  }

  if (slot === "accesorio") {
    if (!currentEquipment.accesorio) return "accesorio";
    if (!currentEquipment.amuleto) return "amuleto";
    return null;
  }

  if (slot === "reliquia") {
    if (!currentEquipment.amuleto) return "amuleto";
    if (!currentEquipment.accesorio) return "accesorio";
    return null;
  }

  return null;
}

function getItemPower(effect = {}) {
  return {
    damageBonus: Number(effect.damageBonus || 0),
    successBonus: Number(effect.successBonus || 0),
    damageReduction: Number(effect.damageReduction || 0),
    explorationBonus: Number(effect.explorationBonus || 0),
    stealthBonus: Number(effect.stealthBonus || 0),
    negotiationBonus: Number(effect.negotiationBonus || 0),
    perceptionBonus: Number(effect.perceptionBonus || 0),
    combatBonus: Number(effect.combatBonus || 0),
    survivalBonus: Number(effect.survivalBonus || 0),
    willpowerBonus: Number(effect.willpowerBonus || 0),
    healingBonus: Number(effect.healingBonus || 0)
  };
}

function formatEffect(effect = {}) {
  const parts = [];

  if (effect.salud) parts.push(`Salud +${effect.salud}`);
  if (effect.damageBonus) parts.push(`Daño +${effect.damageBonus}`);
  if (effect.damageReduction) parts.push(`Daño recibido -${Math.round(effect.damageReduction * 100)}%`);
  if (effect.successBonus) parts.push(`Éxito +${Math.round(effect.successBonus * 100)}%`);

  if (effect.explorationBonus) parts.push(`Exploración +${Math.round(effect.explorationBonus * 100)}%`);
  if (effect.stealthBonus) parts.push(`Sigilo +${Math.round(effect.stealthBonus * 100)}%`);
  if (effect.negotiationBonus) parts.push(`Negociación +${Math.round(effect.negotiationBonus * 100)}%`);
  if (effect.perceptionBonus) parts.push(`Visión +${Math.round(effect.perceptionBonus * 100)}%`);
  if (effect.combatBonus) parts.push(`Combate +${Math.round(effect.combatBonus * 100)}%`);
  if (effect.survivalBonus) parts.push(`Resistencia +${Math.round(effect.survivalBonus * 100)}%`);
  if (effect.willpowerBonus) parts.push(`Voluntad +${Math.round(effect.willpowerBonus * 100)}%`);
  if (effect.healingBonus) parts.push(`Sanación +${Math.round(effect.healingBonus * 100)}%`);

  if (effect.afinidad) parts.push(`Afinidad +${effect.afinidad}`);
  if (effect.reduceDanioSiguienteEncuentro) parts.push(`- ${effect.reduceDanioSiguienteEncuentro} daño siguiente`);

  return parts.length ? parts.join(" | ") : "Sin efecto definido";
 }

function sumEquipmentTotals(equipment = {}) {
  const totals = {
    damageBonus: 0,
    successBonus: 0,
    damageReduction: 0,
    explorationBonus: 0,
    stealthBonus: 0,
    negotiationBonus: 0,
    perceptionBonus: 0,
    combatBonus: 0,
    survivalBonus: 0,
    willpowerBonus: 0,
    healingBonus: 0
  };

  for (const item of Object.values(equipment || {})) {
    if (!item) continue;
    const effect = item.efecto || item.effect || {};
    const stats = getItemPower(effect);

    totals.damageBonus += stats.damageBonus;
    totals.successBonus += stats.successBonus;
    totals.damageReduction += stats.damageReduction;
    totals.explorationBonus += stats.explorationBonus;
    totals.stealthBonus += stats.stealthBonus;
    totals.negotiationBonus += stats.negotiationBonus;
    totals.perceptionBonus += stats.perceptionBonus;
    totals.combatBonus += stats.combatBonus;
    totals.survivalBonus += stats.survivalBonus;
    totals.willpowerBonus += stats.willpowerBonus;
    totals.healingBonus += stats.healingBonus;
  }

  return totals;
}

function formatEquipmentTotals(totals) {
  const parts = [];
  if (totals.damageBonus) parts.push(`+${totals.damageBonus} Daño`);
  if (totals.successBonus) parts.push(`+${Math.round(totals.successBonus * 100)}% Éxito`);
  if (totals.damageReduction) parts.push(`+${Math.round(totals.damageReduction * 100)}% Defensa`);
  if (totals.explorationBonus) parts.push(`+${Math.round(totals.explorationBonus * 100)}% Exploración`);
  if (totals.stealthBonus) parts.push(`+${Math.round(totals.stealthBonus * 100)}% Sigilo`);
  if (totals.negotiationBonus) parts.push(`+${Math.round(totals.negotiationBonus * 100)}% Negociación`);
  if (totals.perceptionBonus) parts.push(`+${Math.round(totals.perceptionBonus * 100)}% Percepción`);
  if (totals.combatBonus) parts.push(`+${Math.round(totals.combatBonus * 100)}% Combate`);
  if (totals.survivalBonus) parts.push(`+${Math.round(totals.survivalBonus * 100)}% Supervivencia`);
  if (totals.willpowerBonus) parts.push(`+${Math.round(totals.willpowerBonus * 100)}% Voluntad`);
  if (totals.healingBonus) parts.push(`+${Math.round(totals.healingBonus * 100)}% Sanación`);

  return parts.length ? parts.join(" | ") : "Sin bonos extra";
}

function formatInventoryLine(item) {
  const qty = Math.max(1, Number(item.cantidad || 1));
  return `• **${item.nombre}**${qty > 1 ? ` x${qty}` : ""}`;
}

async function getCatalogPool() {
  const pool = [];

  const tienda = tiendaCache || await loadCatalog("tienda.json").catch(() => null);
  const armeria = armeriaCache || await loadCatalog("armeria.json").catch(() => null);
  const merchantState = await db.getEventState("merchant").catch(() => null);

  const tiendaItems = Array.isArray(tienda)
    ? tienda
    : Array.isArray(tienda?.items)
      ? tienda.items
      : [];

  const armeriaItems = Array.isArray(armeria)
    ? armeria
    : Array.isArray(armeria?.items)
      ? armeria.items
      : Array.isArray(armeria?.equipo)
        ? armeria.equipo
        : [];

  for (const item of tiendaItems) {
    pool.push({ ...item, catalogName: "tienda" });
  }

  for (const item of armeriaItems) {
    pool.push({ ...item, catalogName: "armeria" });
  }

  if (merchantState?.active && Array.isArray(merchantState.stock)) {
    for (const item of merchantState.stock) {
      pool.push({ ...item, catalogName: "mercader" });
    }
  }

  return pool;
}

async function findCatalogItemByQuery(query) {
  const q = normalizeKey(query);
  const pool = await getCatalogPool();

  return pool.find(item => {
    const id = normalizeKey(item.id);
    const nombre = normalizeKey(item.nombre);
    return id === q || nombre === q || nombre.includes(q);
  }) || null;
}

async function getCurrentPriceForItem(item) {
  const catalogName = item.catalogName || "tienda";
  if (typeof db.getDynamicPrice === "function") {
    return await db.getDynamicPrice(catalogName, item);
  }
  return Number(item.precioBase ?? item.precio ?? 0);
}

async function getCurrentTablonSelection() {
  const state = await db.getEventState("tablon");
  if (Array.isArray(state?.selection) && state.selection.length) return state.selection;

  const missions = await loadMissions();
  const shuffled = [...missions].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, 5);
}

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

function getCompanionIcon(id) {
  switch (normalizeKey(id)) {
    case "cirdil":
    case "andaer":
      return "🛡️";
    case "duinor":
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

function compactLine(text, maxWords = 40) {
  const words = String(text || "")
    .replace(/\s+/g, " সপ্তাহের")
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

function getCompanionEquipmentFromPersonaje(companionId) {
  const personaje = personajesCache[normalizeKey(companionId)] || null;
  if (!personaje) return {};

  const fromNested =
    personaje.equipo ||
    personaje.armamento ||
    personaje.equipment ||
    personaje.items ||
    {};

  return {
    ...fromNested,
    arma: fromNested.arma || personaje.arma || "",
    escudo: fromNested.escudo || personaje.escudo || "",
    armadura: fromNested.armadura || personaje.armadura || "",
    guantes: fromNested.guantes || personaje.guantes || "",
    piernas: fromNested.piernas || personaje.piernas || "",
    botas: fromNested.botas || personaje.botas || "",
    capa: fromNested.capa || personaje.capa || "",
    casco: fromNested.casco || personaje.casco || "",
    hombros: fromNested.hombros || personaje.hombros || "",
    anillo1: fromNested.anillo1 || personaje.anillo1 || "",
    anillo2: fromNested.anillo2 || personaje.anillo2 || "",
    amuleto: fromNested.amuleto || personaje.amuleto || "",
    accesorio: fromNested.accesorio || personaje.accesorio || ""
  };
}

function getCompanionBasePower(companionId) {
  const key = normalizeKey(companionId);

  const personajeLoadout = getCompanionEquipmentFromPersonaje(key);
  const fallbackLoadout = COMPANION_BASE_EQUIPMENT[key] || {};

  const loadout = Object.keys(personajeLoadout).length
    ? personajeLoadout
    : fallbackLoadout;

  const total = Object.values(loadout).reduce(
    (sum, tier) => sum + (ITEM_TIER_VALUES[normalizeKey(tier)] || 0),
    0
  );

  return {
    total,
    successBonus: Math.min(total * 0.0025, 0.12),
    damageReduction: Math.min(total * 0.0015, 0.08)
  };
}

function getCompanionBonus(profile) {
  const list = getOwnedCompanions(profile);
  const bonus = {
    captainBonus: 0, strongEnemyBonus: 0, numerousEnemyBonus: 0,
    blockChance: 0, rangerBonus: 0, damageReduction: 0,
    faelonHeal: 0, nierielSafe: false, baseSuccessBonus: 0, baseDamageReduction: 0
  };

  for (const id of list) {
    const base = getCompanionBasePower(id);
    bonus.baseSuccessBonus += base.successBonus;
    bonus.baseDamageReduction += base.damageReduction;

    switch (normalizeKey(id)) {
      case "alteru": bonus.captainBonus += 0.20; break;
      case "cirdil": bonus.strongEnemyBonus += 0.15; bonus.damageReduction += 0.20; break;
      case "duinor": bonus.numerousEnemyBonus += 0.25; break;
      case "andaer": bonus.blockChance += 0.20; break;
      case "nieriel": bonus.nierielSafe = true; break;
      case "faelon": bonus.faelonHeal += 10; break;
      case "montaraces": bonus.rangerBonus += 0.30; break;
    }
  }

  bonus.baseSuccessBonus = Math.min(bonus.baseSuccessBonus, 0.20);
  bonus.baseDamageReduction = Math.min(bonus.baseDamageReduction, 0.15);
  return bonus;
}

function getAffinityGain() {
  const roll = Math.random();
  return roll < 0.5 ? 0 : 1;
}

function getAffinityRankText(companionId, rank) {
  const name = companions[companionId]?.nombre || companionId;

  const lines = {
    Desconocido: `${name}: ...`,
    Conocido: `${name}: Empiezo a acostumbrarme a ti.`,
    Aliado: `${name}: Ya luchamos como un buen equipo.`,
    "Amigo Cercano": `${name}: Me alegra verte a mi lado.`,
    "Compañero de Confianza": `${name}: Puedo contar contigo sin mirar atrás.`
  };

  return lines[rank] || `${name}: ...`;
}

function getAffinityCombatBonus(profile, owned = []) {
  const affinity = profile.affinity || {};
  let successBonus = 0;
  let damageReduction = 0;

  for (const compId of owned) {
    const value = affinity[compId] || affinity[normalizeKey(compId)] || 0;

    if (value >= 100) {
      successBonus += 0.08;
      damageReduction += 0.06;
    } else if (value >= 75) {
      successBonus += 0.06;
      damageReduction += 0.05;
    } else if (value >= 50) {
      successBonus += 0.04;
      damageReduction += 0.03;
    } else if (value >= 25) {
      successBonus += 0.02;
      damageReduction += 0.01;
    }
  }

  return {
    successBonus: Math.min(successBonus, 0.18),
    damageReduction: Math.min(damageReduction, 0.15)
  };
}

async function addAffinityWithRankMessage(userId, companionId, encounter, mode, outcome) {
  const beforeProfile = await db.getProfile(userId);
  const beforeValue = (beforeProfile.affinity || {})[companionId] || 0;
  const beforeRank = getAffinityRank(beforeValue);

  const gain = getAffinityGain(encounter, mode, outcome);
  await db.addAffinity(userId, companionId, gain);

  const afterValue = beforeValue + gain;
  const afterRank = getAffinityRank(afterValue);

  return {
    gain,
    rankMessage: beforeRank !== afterRank ? getAffinityRankText(companionId, afterRank) : null
  };
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

function normalizeFinalAction(value) {
  const key = normalizeKey(value);

  if (["huir", "escapar", "retirarse", "retirada", "abandonar"].includes(key)) return "retirarse";
  if (["rodear", "flanquear", "rodeo"].includes(key)) return "rodear";
  if (["atacar", "asalto", "embestir"].includes(key)) return "atacar";

  return key;
}

function getFinalScenarioActionText(encounter = {}, action = "atacar", outcome = "success") {
  const key = normalizeFinalAction(action);

  const block =
    encounter?.actionText?.[key] ||
    encounter?.resultados?.[key] ||
    encounter?.finales?.[key] ||
    encounter?.final?.[key] ||
    {};

  if (typeof block === "string") return block;

  if (outcome === "success") {
    return block.successText || block.textoExito || block.exito || "";
  }

  return block.failText || block.textoFracaso || block.fracaso || "";
}

function getFinalScenarioReactionIds(action, owned = []) {
  const poolByAction = {
    atacar: ["duinor", "cirdil", "alteru"],
    rodear: ["nieriel", "faelon", "andaer"],
    retirarse: ["nieriel", "faelon", "alteru"]
  };

  return poolByAction[normalizeFinalAction(action)] || owned.slice(0, 3);
}

function getFinalScenarioAffinityTargets(action, owned = []) {
  const poolByAction = {
    atacar: ["duinor", "cirdil", "alteru"],
    rodear: ["nieriel", "faelon", "andaer"],
    retirarse: ["nieriel", "faelon"]
  };

  return (poolByAction[normalizeFinalAction(action)] || owned).filter(id => owned.includes(id));
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
    companions: [],
    hiredCompanions: []
  });
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

function buildEncounterCard(encounter, commandHint = "!desafiar", powerBlock = "") {
  const peligroTexto = encounter?.peligro ? getDangerText(encounter.peligro) : "Ninguno";

  let text =
`⚠️ **${encounter.titulo}**

${encounter.descripcion || "Te adentras en territorio desconocido..."}`;

  if (powerBlock) {
    text += `\n\n${powerBlock}`;
  }

  text += `\n\nPeligro: ${peligroTexto}\nUsa: ${commandHint}`;

  return text;
}

// ==========================================
//        ESCENARIOS FINALES
// ==========================================

const FINAL_SCENE_COMMANDS = {
  "!atacar": "atacar",
  "!rodear": "rodear",
  "!explorar": "explorar",
  "!infiltrar": "infiltrar",
  "!negociar": "negociar",
  "!esperar": "esperar",
  "!volver": "retirarse",
  "!retirarse": "retirarse",
  "!abandonar": "retirarse"
};

const FINAL_SCENE_RULES = {
  atacar: { successChance: 0.68, rewardMultiplierSuccess: 1, rewardMultiplierFailure: 1, damageOnFail: 18 },
  rodear: { successChance: 0.84, rewardMultiplierSuccess: 1, rewardMultiplierFailure: 1, damageOnFail: 8 },
  explorar: { successChance: 0.82, rewardMultiplierSuccess: 1, rewardMultiplierFailure: 1, damageOnFail: 6 },
  infiltrar: { successChance: 0.75, rewardMultiplierSuccess: 1, rewardMultiplierFailure: 1, damageOnFail: 10 },
  negociar: { successChance: 0.62, rewardMultiplierSuccess: 1, rewardMultiplierFailure: 1, damageOnFail: 4 },
  esperar: { successChance: 0.90, rewardMultiplierSuccess: 1, rewardMultiplierFailure: 1, damageOnFail: 2 },
  retirarse: { successChance: 0.99, rewardMultiplierSuccess: 1, rewardMultiplierFailure: 1, damageOnFail: 0 }
};

function getFinalScenarioConfig(mission = {}, expedition = {}) {
  const raw =
    expedition.finalScenario ||
    mission.escenarioFinal ||
    mission.finalScenario ||
    mission.finalEscenario ||
    {};

  const enabled = raw.enabled !== false;
  const hasEnemies = raw.hasEnemies ?? raw.tieneEnemigos ?? true;

  let allowedActions = Array.isArray(raw.allowedActions) && raw.allowedActions.length
    ? raw.allowedActions
    : null;

  if (!allowedActions || !allowedActions.length) {
    allowedActions = hasEnemies
      ? ["atacar", "rodear", "explorar", "infiltrar", "negociar", "retirarse"]
      : ["explorar", "infiltrar", "negociar", "retirarse"];
  }

  allowedActions = [...new Set(allowedActions.map(a => normalizeKey(a)))];

  if (!hasEnemies) {
    allowedActions = allowedActions.filter(a => a !== "atacar");
  }

  return {
    enabled,
    title:
      raw.titulo ||
      raw.title ||
      mission.titulo ||
      "Escenario final",

    description:
      raw.description ||
      raw.descripcion ||
      mission.escenarioFinal?.descripcion ||
      mission.descripcion ||
      expedition?.currentEncounter?.descripcion ||
      "Te enfrentas al desenlace de tu expedición.",

    hasEnemies,
    enemyLabel: raw.enemyLabel || raw.enemigo || "enemigos",
    enemyChance: Number(raw.enemyChance ?? raw.probabilidadEnemigo ?? 0.6),
    danger: Number(raw.peligro ?? raw.danger ?? raw.nivelPeligro ?? 0),
    rewardMultiplier: Number(raw.rewardMultiplier ?? 1),
    xpBonus: Number(raw.xpBonus ?? 0),
    pointsBonus: Number(raw.pointsBonus ?? 0),
    allowedActions,
    actionText: raw.actionText || {},
    successText: raw.successText || {},
    failureText: raw.failureText || {},
    completionText: raw.completionText || {},
    affinityBonus: Number(raw.affinityBonus ?? 0)
  };
}

function getFinalScenarioAllowedText(scenario = {}) {
  const fallback = ["atacar", "rodear", "explorar", "infiltrar", "negociar", "esperar", "retirarse"];
  const allowed = Array.isArray(scenario.allowedActions) && scenario.allowedActions.length
    ? scenario.allowedActions
    : fallback;

  return allowed.map(a => `\`!${a}\``).join(", ");
}

function getFinalScenarioDangerText(scenario = {}) {
  const danger = Number(scenario.danger ?? scenario.peligro ?? 0);
  if (!danger) return "Ninguno";
  return getDangerText(danger);
}

function getFinalScenarioActionStartText(action, expedition) {
  const scenario = expedition.finalScenario || {};
  const title = scenario.titulo || expedition.mission?.titulo || "Escenario final";
  const act = normalizeKey(action);

  switch (act) {
    case "atacar":
      return `🗡️ **${title}**\n\nDecides atacar de frente. No hay marcha atrás: tomas posición y buscas romper la defensa enemiga resuelto a vencer.`;
    case "rodear":
      return `🧭 **${title}**\n\nDecides rodear la zona y buscar una entrada menos expuesta. El terreno puede jugar a tu favor... o en tu contra.`;
    case "explorar":
      return `👀 **${title}**\n\nDecides avanzar con cautela y observar mejor el lugar antes de actuar. Cada detalle puede cambiar el resultado.`;
    case "infiltrar":
      return `🕵️ **${title}**\n\nDecides infiltrarte sin llamar la atención. Si hay una oportunidad, intentarás aprovecharla.`;
    case "negociar":
      return `💬 **${title}**\n\nDecides hablar antes de empuñar el acero. Quizá todavía haya una salida sin sangre.`;
    case "esperar":
      return `⏳ **${title}**\n\nDecides esperar y observar. A veces el movimiento correcto es no moverse todavía.`;
    case "retirarse":
      return `↩️ **${title}**\n\nDecides retirarte y entregar el informe tal como está. No siempre la victoria exige pelear.`;
    default:
      return `⚠️ **${title}**\n\nTomas una decisión en el instante decisivo.`;
  }
}

function rollFinalScenarioEnemyPresence(scenario = {}) {
  if (scenario.hasEnemies === false) return false;

  const chance = Number(scenario.enemyChance ?? 0.6);
  const clamped = Math.max(0, Math.min(chance, 1));

  return Math.random() < clamped;
}

function buildFinalResolutionText(action, success, scenario) {
  if (success) {
    return scenario?.completionText?.success ? `${scenario.completionText.success}` : "";
  } else {
    return scenario?.completionText?.failure ? `${scenario.completionText.failure}` : "La situación no se resolvió como esperabas.";
  }
}

async function startFinalScenario(message, expedition) {
  const scenario = getFinalScenarioConfig(expedition.mission || {}, expedition);
  expedition.finalScenario = scenario;
  
  const profile = await db.getProfile(message.author.id);
  const equipmentRaw = await db.getEquipment?.(message.author.id).catch(() => null);
  const equipment = getResolvedEquipment(profile, equipmentRaw);
  const party = [...new Set(getOwnedCompanions(profile))];
  const encounter = expedition.currentEncounter || scenario;
  const hasEnemies = encounter.enemyPresent ?? encounter.hasEnemies ?? scenario.hasEnemies ?? true;

  const dangerText = getFinalScenarioDangerText(scenario);

  if (!hasEnemies) {
    const mission = expedition.mission || {};
    const completionText =
      scenario.completionText?.success ||
      scenario.completionText ||
      `Llevas a los refugiados a un lugar seguro y regresas al campamento con la misión cumplida.`;

    const xpReward = expedition.xpEarned + Number(scenario.xpBonus ?? 0) + Number(mission.xp ?? 10);
    const pointReward = expedition.pointsEarned + Number(scenario.pointsBonus ?? 0) + Number(mission.puntos ?? 5);

    const affinityTargets = getFinalScenarioAffinityTargets("retirarse", party);
    const affinityLines = [];

    for (const cid of affinityTargets) {
      const result = await addAffinityWithRankMessage(
        message.author.id,
        cid,
        encounter,
        "retirarse",
        "victoria"
      );

      expedition.affinityLog = expedition.affinityLog || {};
      expedition.affinityLog[cid] = (expedition.affinityLog[cid] || 0) + result.gain;

      affinityLines.push(`• **${companions[cid]?.nombre || cid}**: +${result.gain} afinidad`);
      if (result.rankMessage) affinityLines.push(`  ${result.rankMessage}`);
    }

    const reactions = [];
    for (const cid of party.slice(0, 3)) {
      const line = await companionReaction(cid, encounter, "mision_completada");
      if (line) reactions.push(`💬 ${line}`);
    }

    await db.addXP(message.author.id, xpReward);
    await db.addPoints(message.author.id, pointReward);
    const utilMsg = await decrementUtilities(message.author.id);

    await clearExpeditionParty(message.author.id);
    expedition.pendingFinalScenario = false;
    expedition.finalScenarioShown = false;
    expedition.currentEncounter = null;
    expeditions.delete(message.author.id);

    let text = `✅ **${scenario.titulo || scenario.title || mission.titulo || "Escenario final"}**\n\n${scenario.description || scenario.descripcion || mission.descripcion || ""}\n\nPeligro: ${dangerText}\n\n${completionText}\n\n🏆 Recompensa Total: +${pointReward} pts | +${xpReward} XP`;

    if (affinityLines.length) {
      text += `\n\n🤝 Afinidad ganada:\n${affinityLines.join("\n")}`;
    }

    if (reactions.length) {
      text += `\n\n${reactions.join("\n")}`;
    }

    text += `\n\nLa expedición ha concluido.` + utilMsg;
    return message.reply(text);
  }

  const reactions = [];
  for (const cid of party.slice(0, 3)) {
    const line = await companionReaction(cid, {
      titulo: scenario.titulo || scenario.title || expedition.mission?.titulo || "Escenario final",
      tipo: "escenario_final",
      categoria: scenario.categoria || "final",
      descripcion: scenario.description || scenario.descripcion || expedition.mission?.descripcion || "",
      peligro: scenario.danger || scenario.peligro || 0
    }, "encounter");

    if (line) reactions.push(`💬 ${line}`);
  }

  const descToUse =
  scenario.description ||
  "Te enfrentas al desenlace de tu expedición.";
  
  const intro =
    scenario.introText ||
    `🏁 **${scenario.titulo || scenario.title || expedition.mission?.titulo || "Escenario final"}**\n\n${descToUse}\n\nPeligro: ${dangerText}\n\nAcciones disponibles: ${getFinalScenarioAllowedText(scenario)}.`;

  let text = intro;
  if (powerBlock) text += `\n\n${powerBlock}`;
  if (reactions.length) text += `\n\n${reactions.join("\n")}`;

  return replyLong(message, text);
}

async function resolveFinalScenarioAction(message, expedition, action) {
  const scenario = expedition.finalScenario;
  if (!scenario || (!scenario.active && !expedition.pendingFinalScenario)) return false;

  const normalizedAction = normalizeKey(action);
  const allowed = Array.isArray(scenario.allowedActions) && scenario.allowedActions.length
    ? scenario.allowedActions.map(normalizeKey)
    : ["atacar", "rodear", "explorar", "infiltrar", "negociar", "esperar", "retirarse"];

  if (!allowed.includes(normalizedAction)) {
    await message.reply(`⚠️ En este escenario solo puedes usar: ${getFinalScenarioAllowedText(scenario)}.`);
    return true;
  }

  const profile = await db.getProfile(message.author.id);
  const party = [...new Set(getOwnedCompanions(profile))];
  const combatBonus = getCompanionBonus(profile);
  const affinityCombat = getAffinityCombatBonus(profile, party);
  const mission = expedition.mission || {};
  const playerClassBonus = getPlayerClassBonus(profile);

  const activeEncounter = expedition.currentEncounter || {
    ...scenario,
    tipo: "escenario_final",
    categoria: "final",
    active: true
  };

  const rules =
    FINAL_SCENE_RULES[normalizedAction] ||
    FINAL_SCENE_RULES.explorar;

  let successChance = Number(rules.successChance ?? 0.5);
  const finalDanger = Number(scenario.danger ?? scenario.peligro ?? 0);

  if (finalDanger >= 7) successChance -= 0.12;
  else if (finalDanger >= 5) successChance -= 0.08;
  else if (finalDanger >= 3) successChance -= 0.04;
  else if (finalDanger > 0) successChance += 0.02;
  
  if (normalizedAction === "atacar") {
    successChance += affinityCombat.successBonus;
    successChance += combatBonus.captainBonus * 0.2;
    successChance += combatBonus.strongEnemyBonus * 0.1;
    successChance += scenario.hasEnemies ? 0.12 : -0.30;
    successChance += playerClassBonus.attackBonus || 0;
  } else if (normalizedAction === "rodear") {
    successChance += combatBonus.nierielSafe ? 0.10 : 0;
    successChance += combatBonus.rangerBonus * 0.05;
    successChance += scenario.hasEnemies ? 0.08 : 0.04;
    successChance += playerClassBonus.explorationBonus || 0;
  } else if (normalizedAction === "explorar") {
    successChance += combatBonus.nierielSafe ? 0.08 : 0;
    successChance += combatBonus.rangerBonus * 0.06;
    successChance += playerClassBonus.explorationBonus || 0;
  } else if (normalizedAction === "infiltrar") {
    successChance += combatBonus.nierielSafe ? 0.05 : 0;
    successChance += combatBonus.damageReduction * 0.02;
  } else if (normalizedAction === "negociar") {
    successChance += party.includes("alteru") ? 0.04 : 0;
    successChance += party.includes("faelon") ? 0.05 : 0;
    successChance += playerClassBonus.negotiationBonus || 0;
  } else if (normalizedAction === "esperar") {
    successChance += 0.02;
  } else if (normalizedAction === "retirarse") {
    successChance += 0.18;
  }

  if (typeof scenario.successModifier === "number") {
    successChance += scenario.successModifier;
  }

  // Adding utility & equip bonus!
  const equipmentRaw = await db.getEquipment?.(message.author.id).catch(() => null);
  const equipment = getResolvedEquipment(profile, equipmentRaw);
  const eqPower = getEquipmentPowerSummary(equipment, profile.activeUtilities || []);
  successChance += eqPower.totals.successBonus || 0;

  successChance = Math.max(0.05, Math.min(successChance, 0.95));
  const success = Math.random() < successChance;

  const owned = [...new Set(getOwnedCompanions(profile))];
  const reactionIds = getFinalScenarioReactionIds(normalizedAction, owned);
  const affinityTargets = getFinalScenarioAffinityTargets(normalizedAction, owned);
  const affinityLines = [];

  if (success) {
    const xpGain = expedition.xpEarned + Number(scenario.xpBonus ?? 0) + Number(mission.xp ?? 10);
    const pointsGain = expedition.pointsEarned + Number(scenario.pointsBonus ?? 0) + Number(mission.puntos ?? 5);

    if (xpGain > 0) await db.addXP(message.author.id, xpGain);
    if (pointsGain > 0) await db.addPoints(message.author.id, pointsGain);

    expedition.affinityLog = expedition.affinityLog || {};

    for (const cid of affinityTargets) {
      const result = await addAffinityWithRankMessage(message.author.id, cid, activeEncounter, normalizedAction, "victoria");
      expedition.affinityLog[cid] = (expedition.affinityLog[cid] || 0) + result.gain;

      affinityLines.push(`• **${companions[cid]?.nombre || cid}**: +${result.gain} afinidad`);
      if (result.rankMessage) affinityLines.push(`  ${result.rankMessage}`);
    }

    const reactions = [];
    for (const cid of reactionIds) {
      if (!owned.includes(cid)) continue;
      const line = await companionReaction(cid, activeEncounter, normalizedAction);
      if (line) reactions.push(`💬 ${line}`);
    }

    const baseDescription =
  scenario.description ||
  scenario.descripcion ||
  expedition.currentEncounter?.descripcion ||
  expedition.mission?.descripcion ||
  "Te enfrentas al desenlace de la expedición.";

   const actionText =
  scenario.actionText?.[normalizedAction] ||
  `${baseDescription}`;

    const finalResolutionText = buildFinalResolutionText(normalizedAction, true, scenario);
    const utilMsg = await decrementUtilities(message.author.id);

    await clearExpeditionParty(message.author.id);
    expedition.pendingFinalScenario = false;
    expedition.finalScenarioShown = false;
    expedition.currentEncounter = null;
    expeditions.delete(message.author.id);

    let texto = `✅ **Escenario final resuelto**\n\n${scenario.title || "Escenario final"}\n\n${actionText}\n`;
    if (finalResolutionText) texto += `\n${finalResolutionText}\n`;
    texto += `\n🏆 Recompensa Total Acumulada: +${pointsGain} pts | +${xpGain} XP`;

    if (affinityLines.length) {
      texto += `\n\n🤝 Afinidad ganada:\n${affinityLines.join("\n")}`;
    }

    if (reactions.length) {
      texto += `\n\n${reactions.join("\n")}`;
    }

    texto += `\n\nLa expedición ha concluido.` + utilMsg;
    return message.reply(texto);
  } else {
    // FALLO EN EL ESCENARIO FINAL
    const xpGain = expedition.xpEarned + Math.floor(Number(mission.xp ?? 10) / 2);
    const pointsGain = expedition.pointsEarned + Math.floor(Number(mission.puntos ?? 5) / 2);
    
    let damage = Number(rules.damageOnFail || 10);
    const totalDmgRed = (combatBonus.damageReduction || 0) + (affinityCombat.damageReduction || 0) + (combatBonus.baseDamageReduction || 0) + (eqPower.totals.damageReduction || 0);
    damage = Math.floor(damage * (1 - totalDmgRed));
    
    const nuevaSalud = Math.max(0, (profile.salud !== undefined ? profile.salud : 100) - damage);

    if (xpGain > 0) await db.addXP(message.author.id, xpGain);
    if (pointsGain > 0) await db.addPoints(message.author.id, pointsGain);
    await db.updateTravelerData(message.author.id, { salud: nuevaSalud });

    const finalResolutionText = buildFinalResolutionText(normalizedAction, false, scenario);
    const utilMsg = await decrementUtilities(message.author.id);

    await clearExpeditionParty(message.author.id);
    expedition.pendingFinalScenario = false;
    expedition.finalScenarioShown = false;
    expedition.currentEncounter = null;
    expeditions.delete(message.author.id);

    let texto = `❌ **Escenario final infructuoso**\n`;
    if (finalResolutionText) texto += `\n${finalResolutionText}\n`;
    texto += `\nRecibes ${damage} de daño. (Salud: ${nuevaSalud}/100)\n🏆 Recompensa parcial acumulada: +${pointsGain} pts | +${xpGain} XP\n\nLa expedición ha concluido.` + utilMsg;
    return message.reply(texto);
  }
}

// ==========================================
//        LLAMADAS API E INTERACCIONES IA
// ==========================================

function getCompanionLore(companionId) {
  const personaje = getPersonaje(companionId);

  return {
    nombre: personaje?.nombre || companions[companionId]?.nombre || companionId,
    personalidad: personaje?.personalidad || personaje?.descripcion || personaje?.tono || "",
    clase: personaje?.clase || companions[companionId]?.clase || ""
  };
}

async function companionReaction(companionId, context, mode = "encounter") {
  const lore = getCompanionLore(companionId);
  const nombre = lore.nombre;

  if (!nombre) return `*se prepara*`;

  const titulo = context?.titulo || "sin título";
  const tipo = context?.tipo || "desconocido";
  const categoria = context?.categoria || "desconocida";
  const peligro = context?.peligro ?? 0;

  let descripcionRaw =
    context?.descripcion ||
    context?.textoExito ||
    context?.textoFracaso ||
    "La situación se desenvuelve ante ti.";

  if (typeof descripcionRaw === "object") {
    descripcionRaw = "La situación se desarrolla y debes reaccionar rápido.";
  }

  const descripcion = String(descripcionRaw).substring(0, 500);

  const systemPrompt = `Eres ${nombre}.
Personalidad: ${lore.personalidad || "reservado y expresivo"}
Clase: ${lore.clase || "desconocida"}
Contexto de la situación:
- Modo: ${mode}
- Título: ${titulo} (${tipo})
- Peligro: ${peligro}

Instrucciones vitales:
- Responde SÓLO con una sola línea corta de diálogo o acción (máximo 15 palabras).
- Reacciona a la situación descrita o comenta tu acción según tu especialidad.
- Comienza siempre la línea con tu nombre seguido de dos puntos.
- Usa español fluido.`;

  try {
    const raw = await chatWithAI({
      systemPrompt,
      messages: [{ role: "user", content: descripcion }],
      temperature: 0.85,
      maxTokens: 120
    });

    const text = String(raw || "").trim();
    if (!text || text === "*observa en silencio*") {
      return `${nombre}: *asiente con expresión concentrada*`;
    }

    const clean = text.replace(new RegExp(`^${nombre}\\s*:\\s*`, "i"), "").trim();
    return `${nombre}: ${compactLine(clean, 25)}`;
  } catch (err) {
    console.error("Catch Error (companionReaction):", err);
    return `${nombre}: *observa en silencio*`;
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
  } catch (err) {
    console.error("Catch Error (askGroq):", err);
    return "Altéru: *observa los senderos lejanos con suspicacia*";
  }
}

async function announceDawnReset(client) {
  const dawnCompanionId = [
    "faelon", "nieriel", "cirdil", "andaer", "duinor", "alteru", "montaraces"
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
`.trim();
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
//   FUNCIONES DE SELECCIÓN DE CATÁLOGO
// ==========================================

async function getCatalogStateItems(catalogName, catalogItems) {
  const state = await db.getEventState(catalogName).catch(() => null);

  const items = Array.isArray(state?.selection) && state.selection.length
    ? state.selection
    : catalogItems;

  return { state, items };
}

function getResolvedEquipment(profile = {}, equipmentRaw = null) {
  if (equipmentRaw && typeof equipmentRaw === "object" && !Array.isArray(equipmentRaw)) {
    return equipmentRaw;
  }

  if (profile?.equipment && typeof profile.equipment === "object" && !Array.isArray(profile.equipment)) {
    return profile.equipment;
  }

  if (profile?.equipo && typeof profile.equipo === "object" && !Array.isArray(profile.equipo)) {
    return profile.equipo;
  }

  return {};
}

function findInventoryItemLoose(inventory, query) {
  const q = normalizeKey(query);

  for (const [category, items] of Object.entries(inventory || {})) {
    if (!Array.isArray(items)) continue;

    for (const item of items) {
      const id = normalizeKey(item?.id || "");
      const nombre = normalizeKey(item?.nombre || "");

      if (id === q || nombre === q || nombre.includes(q)) {
        return { category, item };
      }
    }
  }

  return null;
}

function saveResolvedEquipment(profile = {}, equipment = {}) {
  const payload = {
    equipment,
    equipo: equipment
  };

  return payload;
}

async function renderCatalog(catalogName, items, title, profile = {}, cycleId = 0) {
  let texto = `🏪 **${title}**\n\n`;

  for (const item of items) {
    const price = await db.getDynamicPrice(catalogName, item);
    const remaining = profile ? getItemRemainingSlots(profile, catalogName, item, cycleId) : null;
    const maxSlots = getDefaultSlots(catalogName, item);

    texto += `• **${item.nombre}**\n`;
    texto += `ID: ${item.id}\n`;
    if (item.tipo) texto += `Tipo: ${item.tipo}\n`;
    if (item.slot) texto += `Slot: ${item.slot}\n`;
    texto += `Precio: ${formatPrice(price)}\n`;
    texto += `Slots: ${remaining}/${maxSlots}\n`;
    texto += `Efecto: ${formatEffect(item.efecto)}\n`;
    if (item.descripcion && catalogName !== "armeria" && catalogName !== "armeria1" && catalogName !== "armeria2") {
      texto += `Descripción: ${item.descripcion}\n`;
    }
    texto += `\n`;
  }

  texto += `Más adelante podrás usar \`!comprar <id>\`, \`!equipar <id>\` o \`!usar <id>\`.`;
  return texto;
}

function chunkDiscordText(text, limit = 1900) {
  const chunks = [];
  const blocks = String(text).split("\n\n");
  let current = "";

  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block}` : block;

    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }

    if (current) chunks.push(current);

    if (block.length <= limit) {
      current = block;
    } else {
      let start = 0;
      while (start < block.length) {
        chunks.push(block.slice(start, start + limit));
        start += limit;
      }
      current = "";
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

async function replyLong(message, text) {
  const chunks = chunkDiscordText(text, 1900);
  if (!chunks.length) return message.reply("—");

  const first = await message.reply(chunks[0]);
  for (const chunk of chunks.slice(1)) {
    await message.channel.send(chunk);
  }

  return first;
}

async function decrementUtilities(userId) {
  const profile = await db.getProfile(userId);
  let utils = profile.activeUtilities || [];
  if (!utils.length) return "";
  let expired = [];
  utils = utils.map(u => {
      u.usesLeft = (u.usesLeft || 1) - 1;
      if (u.usesLeft <= 0) expired.push(u.nombre);
      return u;
  }).filter(u => u.usesLeft > 0);
  await db.updateTravelerData(userId, { activeUtilities: utils });
  if (expired.length) return `\n⚠️ Se han agotado: ${expired.join(", ")}.`;
  return "";
}

// ==========================================
//         CONFIGURACIÓN DEL CLIENTE
// ==========================================

const ALLOWED_CHANNEL_IDS = new Set([
  "1514198998838284288",
  "1512731937473560622"
]);
  
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

  tiendaCache = await loadCatalog("tienda.json");
  armeriaCache = await loadCatalog("armeria.json");
  mercaderCache = await loadCatalog("mercader.json");

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
  await startSchedulers(client, loreCache);

  console.log(`Logged in as ${client.user.tag}`);
});

function getCatalogItems(data) {
  if (Array.isArray(data)) return data;
  return data?.items || data?.equipo || [];
}

function getDefaultSlots(catalogName, item = {}) {
  const explicitSlots = Number(item.slots ?? item.maxSlots ?? item.cupos ?? item.limite);

  if (Number.isFinite(explicitSlots) && explicitSlots > 0) {
    return explicitSlots;
  }

  const tipo = normalizeKey(item.tipo || "");
  const slot = normalizeKey(item.slot || "");

  if (catalogName === "armeria" || catalogName === "armeria1" || catalogName === "armeria2") {
    return 1;
  }

  if (catalogName === "tienda") {
    if (tipo === "regalo") return 1;
    if (tipo === "consumible" || tipo === "utilidad") return 3;
    return 3;
  }

  if (catalogName === "mercader") {
    if (tipo === "regalo") return 1;
    return 3;
  }

  if (slot === "arma" || slot === "pecho" || slot === "armadura" || slot === "casco" || slot === "hombros" || slot === "brazos" || slot === "piernas" || slot === "pies") {
    return 1;
  }

  return 1;
}

function ensureCatalogUsage(profile, catalogName, cycleId) {
  const current = profile.catalogUsage || {};
  const existing = current[catalogName];

  if (existing?.cycleId === cycleId && existing?.items && typeof existing.items === "object") {
    return current;
  }

  return {
    ...current,
    [catalogName]: {
      cycleId,
      items: {}
    }
  };
}

function getItemRemainingSlots(profile, catalogName, item, cycleId) {
  const currentUsage = profile.catalogUsage?.[catalogName];
  const used = currentUsage?.cycleId === cycleId
    ? Number(currentUsage?.items?.[item.id] || 0)
    : 0;

  return Math.max(0, getDefaultSlots(catalogName, item) - used);
}

function consumeCatalogSlot(profile, catalogName, item, cycleId) {
  const usage = ensureCatalogUsage(profile, catalogName, cycleId);
  usage[catalogName].items[item.id] = Number(usage[catalogName].items[item.id] || 0) + 1;
  return usage;
}

const VALID_RACES = ["Hombre", "Enano", "Elfo", "Hobbit", "Beornida"];

const VALID_CLASSES = [
  "Guardián",
  "Vigilante",
  "Campeón",
  "Cazador",
  "Luchador",
  "Bardo",
  "Guardián Rúnico",
  "Capitán",
  "Sabio",
  "Saqueador",
  "Marinero",
  "Beórnida"
];

const CLASS_KEY_TO_LABEL = {
  guardian: "Guardián",
  vigilante: "Vigilante",
  campeon: "Campeón",
  cazador: "Cazador",
  luchador: "Luchador",
  bardo: "Bardo",
  guardian_runico: "Guardián Rúnico",
  capitan: "Capitán",
  sabio: "Sabio",
  saqueador: "Saqueador",
  marinero: "Marinero",
  beornida: "Beórnida"
};

const STARTER_ITEMS_BY_CLASS = {
  guardian: { id: "espada_larga_tier1", nombre: "Espada Larga", slot: "arma", hands: 1, tipo: "arma", raza: "general", rareza: "comun", precioBase: 0, descripcion: "Arma inicial.", efecto: { damageBonus: 1 } },
  vigilante: { id: "lanza_corta_tier1", nombre: "Lanza Corta", slot: "arma", hands: 1, tipo: "arma", raza: "general", rareza: "comun", precioBase: 0, descripcion: "Arma inicial.", efecto: { damageBonus: 1 } },
  campeon: { id: "mandoble_simple_tier1", nombre: "Mandoble Simple", slot: "arma", hands: 2, tipo: "arma", raza: "general", rareza: "comun", precioBase: 0, descripcion: "Arma inicial.", efecto: { damageBonus: 2 } },
  cazador: { id: "arco_caza_tier1", nombre: "Arco de Caza", slot: "arma", hands: 2, tipo: "arma", raza: "general", rareza: "comun", precioBase: 0, descripcion: "Arma inicial.", efecto: { damageBonus: 2 } },
  luchador: { id: "guantes_tachonados_tier1", nombre: "Guantes de Cuero Tachonado", slot: "arma", hands: 1, tipo: "arma", raza: "general", rareza: "comun", precioBase: 0, descripcion: "Arma inicial.", efecto: { damageBonus: 1 } },
  bardo: { id: "daga_bronce_tier1", nombre: "Daga de Bronce", slot: "arma", hands: 1, tipo: "arma", raza: "general", rareza: "comun", precioBase: 0, descripcion: "Arma inicial.", efecto: { damageBonus: 1 } },
  capitan: { id: "espada_larga_capitan_tier1", nombre: "Espada Larga", slot: "arma", hands: 1, tipo: "arma", raza: "general", rareza: "comun", precioBase: 0, descripcion: "Arma inicial.", efecto: { damageBonus: 1 } },
  guardian_runico: { id: "espada_larga_runica_tier1", nombre: "Espada Larga", slot: "arma", hands: 1, tipo: "arma", raza: "general", rareza: "comun", precioBase: 0, descripcion: "Arma inicial.", efecto: { damageBonus: 1 } },
  sabio: { id: "baston_magico_tier1", nombre: "Bastón Mágico", slot: "arma", hands: 2, tipo: "arma", raza: "general", rareza: "comun", precioBase: 0, descripcion: "Arma inicial.", efecto: { damageBonus: 2 } },
  saqueador: { id: "daga_bronce_saqueador_tier1", nombre: "Daga de Bronce", slot: "arma", hands: 1, tipo: "arma", raza: "general", rareza: "comun", precioBase: 0, descripcion: "Arma inicial.", efecto: { damageBonus: 1 } },
  marinero: { id: "espada_larga_marinero_tier1", nombre: "Espada Larga", slot: "arma", hands: 1, tipo: "arma", raza: "general", rareza: "comun", precioBase: 0, descripcion: "Arma inicial.", efecto: { damageBonus: 1 } },
  beornida: { id: "hacha_pesada_leñador_tier1", nombre: "Hacha Pesada de Leñador", slot: "arma", hands: 2, tipo: "arma", raza: "general", rareza: "comun", precioBase: 0, descripcion: "Arma inicial.", efecto: { damageBonus: 2 } }
};

function parseOption(input, options) {
  const q = normalizeKey(input);
  return options.find(option => normalizeKey(option) === q) || null;
}

function parseClassChoice(input) {
  const q = normalizeKey(input);

  for (const [key, label] of Object.entries(CLASS_KEY_TO_LABEL)) {
    if (normalizeKey(key) === q || normalizeKey(label) === q) {
      return key;
    }
  }

  return null;
}

function getStarterItemForClass(classKey) {
  return STARTER_ITEMS_BY_CLASS[normalizeKey(classKey)] || null;
}

function buildOnboardingIntroText() {
  return (
`🎖️ Altéru: Hola, soy Altéru. Te doy la bienvenida a mi campamento. Soy capitán de Gondor y me conocen como el Capitán de las Colinas, porque nací en Pinnath Gelin. He luchado en diferentes batallas y he logrado varias hazañas defendiendo nuestro reino, así que me alegra mucho ver un rostro aliado.

Si estás dispuesto a ayudarnos, lo primero que me gustaría saber es: ¿cuál es tu nombre?`
  );
}

function buildRacePrompt(name) {
  return (
`🎖️ Altéru: Muy bien, ${name}. Mi esposa Nieriel lleva los registros de todos en el campamento para saber quién falta cuando no regresa de una expedición. Mi siguiente pregunta es: ¿cuál es tu raza?

[Hombre, Enano, Elfo, Hobbit, Beornida]`
  );
}

function buildAgePrompt() {
  return `🎖️ Altéru: ¿Qué edad tienes?`;
}

function buildClassPrompt() {
  return (
`🎖️ Altéru: ¿Cuál es tu estilo de combate?

[Guardián, Vigilante, Campeón, Cazador, Luchador, Bardo, Guardián Rúnico, Capitán, Sabio, Saqueador, Marinero, Beórnida]`
  );
}

function buildStarterGiftText(classKey, starterItem) {
  const classLabel = CLASS_KEY_TO_LABEL[classKey] || classKey;
  const itemName = starterItem?.nombre || "tu arma inicial";

  return (
`🎖️ Altéru: Perfecto. Como regalo de bienvenida te entregaré un arma para tu clase: **${itemName}**.

Esta arma queda registrada en tu inventario y podrás revisarla con **!inventario**.
Si más adelante quieres verla equipada, usa **!equipo** y luego **!equipar** cuando convenga.

A mi espalda encontrarás el **!tablon** de expediciones. Allí verás tareas por cumplir. También puedes **!contratar** a cualquiera de mis compañeros antes de una misión.

¿Te gustaría conocer otras áreas del campamento? Responde **sí** o **no**.`
  );
}

function buildTourNoText() {
  return (
`🎖️ Altéru: Muy bien. Espero que la información que te di te haya servido. Cuanto antes comiences a prepararte, mucho mejor. Si quieres obtener puntos de otra manera, también puedes buscar a Faelon el Elfo, quien siempre tiene alguna **!trivia** interesante que te pondrá a pensar. ¡Espero oír grandes noticias de ti!`
  );
}

function buildTourYesText() {
  return (
`🎖️ Altéru: Bien. A mi derecha encontrarás la **!tienda**, donde puedes **!comprar** muchos artículos útiles para tus viajes. Te recomiendo pasar siempre que quieras realizar una expedición y revisar que en tu **!inventario** tengas lo que necesites.

🎖️ Altéru: A mi izquierda está la herrería y la **!armeria**, dirigida por mi amigo Cirdil, quien me ha acompañado en muchas aventuras. Allí podrás encontrar todo lo necesario para armarte mejor: espadas, escudos, armaduras y más. Mira tu **!equipo** y asegúrate de estar bien pertrechado. Cuando quieras comprar cualquier artículo, usa **!comprar** y luego **!equipar** si conviene. Si no necesitas algo de tu inventario, siempre tienes la opción de **!vender**.

🎖️ Altéru: Si no tienes más preguntas, espero que puedas alistarte cuanto antes y ponerse manos a la obra. Hay mucho por hacer y muchos rincones que limpiar. No olvides estar bien preparado o acompañado, porque afuera hay muchos peligros, pásate por la tienda del elfo Faelon, seguro tendrá alguna !trivia divertida para ¡Pero contestale correctamente! O se molestará. 

🎖️ Altéru: Si encuentras o escuchas algo sobre un nigromante llamado **Thûlazar**, házmelo saber. Es nuestro mayor enemigo. ¡Espero oír grandes hazañas de ti!

🎖️ Altéru: Si necesitas algo más, estaré en mi tienda con **!a**, o también puedes hablar con mi esposa con **!n**.`
  );
}

async function grantStarterItem(userId, profile, classKey) {
  const starterItem = getStarterItemForClass(classKey);
  if (!starterItem) return null;

  const inventory = normalizeInventory(profile.inventory);
  const category = getInventoryCategoryForItem(starterItem);
  const exists = (inventory[category] || []).some(item => normalizeKey(item.id) === normalizeKey(starterItem.id));

  if (!exists) {
    inventory[category].push(
      normalizeItemEntry(starterItem, {
        cantidad: 1,
        origen: "onboarding",
        starterItem: true
      })
    );
  }

  await db.updateTravelerData(userId, {
    inventory: normalizeInventory(inventory),
    starterItemGranted: true
  });

  return starterItem;
}

function canEquipItem(profile, item, equipment = {}) { 
  const race = normalizeKey(profile?.race || ""); 
  const classKey = normalizeKey(profile?.class || ""); 
  
  if (!race || !classKey) { 
    return { ok: false, reason: "Debes definir tu raza y clase en tu perfil antes de equipar." }; 
  } 
  
  const itemRace = normalizeKey(item?.raza || item?.race || ""); 
  const itemRaces = Array.isArray(item?.allowedRaces) ? item.allowedRaces.map(normalizeKey) : []; 
  const itemClasses = Array.isArray(item?.allowedClasses) ? item.allowedClasses.map(normalizeKey) : []; 
  const hands = Number(item?.hands || 1); 
  const offhand = equipment?.escudo || equipment?.offhand || equipment?.segundaMano || null; 
  
  if (itemRaces.length && !itemRaces.includes("general") && !itemRaces.includes(race)) { 
    return { ok: false, reason: "Tu raza no puede usar ese objeto." }; 
  } 
  
  if (itemRace && itemRace !== "general" && itemRace !== "none" && itemRace !== "ninguno" && itemRace !== race) { 
    return { ok: false, reason: "Tu raza no puede usar ese objeto." }; 
  } 
  
  if (itemClasses.length && !itemClasses.includes(classKey)) { 
    return { ok: false, reason: "Tu clase no puede usar ese objeto." }; 
  } 
  
  if (hands === 2 && offhand) { 
    return { ok: false, reason: "No puedes usar un arma de dos manos junto con un objeto de mano secundaria." }; 
  } 
  
  if (item?.slot === "escudo" && Number(equipment?.arma?.hands || 1) === 2) { 
    return { ok: false, reason: "No puedes usar escudo con un arma de dos manos." }; 
  } 
  
  return { ok: true }; 
}

async function handleOnboarding(message, profile) {
  const userId = message.author.id;
  const content = message.content.trim();
  const stage = profile.onboardingStage || null;
  const normalized = normalizeKey(content);

  if (!stage) {
    await db.updateTravelerData(userId, { onboardingStage: "name" });
    return message.reply(buildOnboardingIntroText());
  }

  if (stage === "name") {
    if (!content || content.startsWith("!")) {
      return message.reply("Escribe tu nombre en texto normal, sin comandos.");
    }

    await db.updateTravelerData(userId, {
      name: content,
      onboardingStage: "race"
    });

    return message.reply(buildRacePrompt(content));
  }

  if (stage === "race") {
    const race = parseOption(content, VALID_RACES);
    if (!race) {
      return message.reply(`Raza no válida. Usa una de estas: ${VALID_RACES.join(", ")}.`);
    }

    await db.updateTravelerData(userId, {
      race,
      onboardingStage: "age"
    });

    return message.reply(buildAgePrompt());
  }

  if (stage === "age") {
    const age = Number.parseInt(content, 10);
    if (!Number.isFinite(age) || age < 10 || age > 500) {
      return message.reply("Escribe una edad válida en números.");
    }

    await db.updateTravelerData(userId, {
      age,
      onboardingStage: "class"
    });

    return message.reply(buildClassPrompt());
  }

  if (stage === "class") {
    const classKey = parseClassChoice(content);
    if (!classKey) {
      return message.reply(`Clase no válida. Usa una de estas: ${VALID_CLASSES.join(", ")}.`);
    }

    const starterItem = await grantStarterItem(userId, profile, classKey);

    await db.updateTravelerData(userId, {
      class: CLASS_KEY_TO_LABEL[classKey],
      onboardingStage: "tour",
      onboardingCompleted: false
    });

    return message.reply(buildStarterGiftText(classKey, starterItem));
  }

  if (stage === "tour") {
    const yesAnswers = ["si", "sí", "s", "claro", "vale", "ok", "okay"];
    const noAnswers = ["no", "n"];

    if (yesAnswers.includes(normalized)) {
      await db.updateTravelerData(userId, {
        onboardingCompleted: true,
        onboardingStage: null
      });
      return message.reply(buildTourYesText());
    }

    if (noAnswers.includes(normalized)) {
      await db.updateTravelerData(userId, {
        onboardingCompleted: true,
        onboardingStage: null
      });
      return message.reply(buildTourNoText());
    }

    return message.reply("Responde con **sí** o **no**.");
  }

  return null;
}

// ==========================================
//          MANEJO DE MENSAJES Y COMANDOS
// ==========================================

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  if (!ALLOWED_CHANNEL_IDS.has(message.channelId)) return;

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

  const activeExpedition = expeditions.get(message.author.id);
  if (activeExpedition?.finalScenario?.active || activeExpedition?.pendingFinalScenario) {
    const finalAction = FINAL_SCENE_COMMANDS[command];

    if (finalAction) {
      return resolveFinalScenarioAction(message, activeExpedition, finalAction);
    }

    if (command !== "!volver" && command !== "!info" && command !== "!ayuda") {
      return message.reply(
        `🎯 Estás en un escenario final. Usa: ${getFinalScenarioAllowedText(activeExpedition.finalScenario)}.`
      );
    }
  }

  const profileForOnboarding = await db.getProfile(message.author.id);

  if (!profileForOnboarding.onboardingCompleted) {
    const result = await handleOnboarding(message, profileForOnboarding);
    if (result) return result;
  }

  // Comandos de Perfil y Sistema de Estadísticas
  if (command === "!perfil") { 
    const profile = await db.getProfile(message.author.id); 
    const equipmentRaw = await db.getEquipment?.(message.author.id).catch?.(() => null); 
    const equipment = getResolvedEquipment(profile, equipmentRaw); 
    const power = getProfilePowerSummary(profile, equipment); 
    return message.reply( 
`👤 **PERFIL DE VIAJERO** Nombre: ${profile.nombre || profile.name || "No definido"} 
Raza: ${profile.race || "No definida"} | Clase: ${profile.class || "No definida"} 
Bono de clase: ${power.bonusText} 
Poder total: ${power.score} 
Nivel: ${power.level} (${profile.xp || 0} XP) 
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

  if (command === "!inventario") {
    const profile = await db.getProfile(message.author.id);
    const inventory = normalizeInventory(profile.inventory);

    let texto = "🎒 **INVENTARIO**\n\n";

    for (const cat of INVENTORY_CATEGORIES) {
      const items = inventory[cat] || [];
      texto += `__${cat.toUpperCase()}__\n`;

      if (!items.length) {
        texto += "• Vacío\n\n";
        continue;
      }

      for (const item of items) {
        texto += `${formatInventoryLine(item)}\n`;
      }

      texto += "\n";
    }

    return message.reply(texto.trim());
  }

  if (command === "!equipo") { 
    const profile = await db.getProfile(message.author.id); 
    const equipmentRaw = await db.getEquipment?.(message.author.id).catch?.(() => null); 
    const equipment = getResolvedEquipment(profile, equipmentRaw); 
    const eqPower = getEquipmentPowerSummary(equipment, profile.activeUtilities || []); 
    let texto = "🛡️ **EQUIPO EQUIPADO**\n\n"; 
    
    const slots = [ 
      ["arma", "Arma"], ["escudo", "Escudo"], ["armadura", "Armadura"], ["casco", "Casco"], 
      ["hombros", "Hombros"], ["brazos", "Brazos"], ["piernas", "Piernas"], 
      ["pies", "Pies"], ["capa", "Capa"], ["anillo1", "Anillo 1"], 
      ["anillo2", "Anillo 2"], ["amuleto", "Amuleto"], ["accesorio", "Accesorio"] 
    ]; 
    
    for (const [slotKey, label] of slots) { 
      const item = equipment?.[slotKey]; 
      texto += `${label}: ${item?.nombre || "—"}\n`; 
    } 

    const utils = profile.activeUtilities || [];
    if (utils.length > 0) {
      texto += `\n**Utilidades Activas**\n`;
      for (const util of utils) {
        texto += `• ${util.nombre} (${util.usesLeft} usos)\n`;
      }
    }
    
    texto += `\n⚔️ **Poder total del equipo**: ${eqPower.score}\n`; 
    texto += `✨ **Índice añadido total**\n${formatEquipmentTotals(eqPower.totals)}\n`; 
    return message.reply(texto); 
  }
  
  if (command === "!equipar") {
    const profile = await db.getProfile(message.author.id);
    
    if (!profile.race || !profile.class) { 
      return message.reply("Debes definir tu raza y clase en tu perfil antes de equipar."); 
    }

    const query = args.slice(1).join(" ").trim();
    if (!query) return message.reply("Usa `!equipar <nombre del objeto>`.");

    const inventory = normalizeInventory(profile.inventory);
    const found = findInventoryItemLoose(inventory, query);

    if (!found) {
      return message.reply("No tienes ese objeto en el inventario.");
    }

    const { category, item } = found;

    if (item.tipo === "utilidad" || item.tipo === "consumible") {
      return message.reply(`Ese objeto es un consumible o utilidad. Usa \`!usar <nombre>\`.`);
    }

    const equipmentRaw = await db.getEquipment?.(message.author.id).catch?.(() => null);
    const equipment = getResolvedEquipment(profile, equipmentRaw);

    const equipSlot = getEquipSlotForItem(item, equipment);
    if (!equipSlot) {
      return message.reply(`**${item.nombre}** no se puede equipar.`);
    }

    const equippedBefore = equipment[equipSlot] || null;

    if (item.cantidad > 1 && !isStackableItem(item)) {
      return message.reply(`Solo puedes equipar una unidad de **${item.nombre}**.`);
    }

    if (equippedBefore && normalizeKey(equippedBefore.id) === normalizeKey(item.id)) {
      return message.reply(`**${item.nombre}** ya está equipado.`);
    }

    const equipCheck = canEquipItem(profile, item, equipment);
    if (!equipCheck.ok) {
      return message.reply(equipCheck.reason);
    }

    equipment[equipSlot] = item;

    const idx = inventory[category].findIndex(x => normalizeKey(x.id) === normalizeKey(item.id));
    if (idx !== -1) {
      if (isStackableItem(inventory[category][idx])) {
        inventory[category][idx].cantidad = Math.max(0, Number(inventory[category][idx].cantidad || 1) - 1);
        if (inventory[category][idx].cantidad <= 0) inventory[category].splice(idx, 1);
      } else {
        inventory[category].splice(idx, 1);
      }
    }

    if (equippedBefore) {
      const oldCategory = getInventoryCategoryForItem(equippedBefore);
      inventory[oldCategory].push(normalizeItemEntry(equippedBefore, {
        cantidad: 1,
        recuperadoPor: "equipar"
      }));
    }

    const equipmentPayload = saveResolvedEquipment(profile, equipment);

    if (typeof db.setEquipment === "function") {
      await db.setEquipment(message.author.id, equipment);
    }

    await db.updateTravelerData(message.author.id, {
      inventory: normalizeInventory(inventory),
      ...equipmentPayload
    });

    return message.reply(`⚙️ Has equipado **${item.nombre}** en **${equipSlot}**.`);
  }

  if (command === "!usar") {
    const query = args.slice(1).join(" ").trim();
    if (!query) return message.reply("Usa `!usar <nombre del objeto>`.");

    const profile = await db.getProfile(message.author.id);
    const inventory = normalizeInventory(profile.inventory);
    const found = findInventoryItemLoose(inventory, query);

    if (!found) return message.reply("No tienes ese objeto en tu inventario.");
    const { category, item } = found;

    let replyMsg = "";

    if (item.efecto?.salud) {
      const saludActual = profile.salud !== undefined ? profile.salud : 100;
      if (saludActual >= 100) return message.reply("Ya tienes la salud al máximo.");
      const nuevaSalud = Math.min(100, saludActual + item.efecto.salud);
      await db.updateTravelerData(message.author.id, { salud: nuevaSalud });
      replyMsg = `❤️ Has consumido **${item.nombre}** y recuperado ${item.efecto.salud} de salud. (Salud: ${nuevaSalud}/100)`;
    } else if (item.tipo === "utilidad" || item.tipo === "consumible") {
      const activeUtils = profile.activeUtilities || [];
      if (activeUtils.some(u => normalizeKey(u.id) === normalizeKey(item.id))) {
        return message.reply(`Ya tienes **${item.nombre}** activo.`);
      }
      
      let uses = 1;
      if (item.tipo === "utilidad" || normalizeKey(item.nombre).includes("cuerda") || normalizeKey(item.nombre).includes("cantimplora")) {
        uses = 3;
      }
      if (normalizeKey(item.nombre).includes("pipa") || normalizeKey(item.nombre).includes("tabaco")) {
        uses = 1;
      }

      activeUtils.push({ ...item, usesLeft: uses });
      await db.updateTravelerData(message.author.id, { activeUtilities: activeUtils });

      const ef = formatEffect(item.efecto);
      replyMsg = `✨ Has usado **${item.nombre}**. Obtienes un bono activo: ${ef} (Duración: ${uses} expediciones).`;
    } else {
      return message.reply(`No puedes usar **${item.nombre}** de esta forma. Intenta equiparlo si es armadura o arma.`);
    }

    const idx = inventory[category].findIndex(x => normalizeKey(x.id) === normalizeKey(item.id));
    if (idx !== -1) {
      if (isStackableItem(item) && inventory[category][idx].cantidad > 1) {
        inventory[category][idx].cantidad -= 1;
      } else {
        inventory[category].splice(idx, 1);
      }
      await db.updateTravelerData(message.author.id, { inventory });
    }

    return message.reply(replyMsg);
  }

  // Comandos de Utilidades Generales y Gestión Base
  if (command === "!info" || command === "!ayuda") { 
    return message.reply( 
`📜 Campamento de Altéru 

👤 PERFIL 
!perfil, !puntos, !nivel, !afinidad, !inventario, !equipo 

📊 ESTADÍSTICAS 
!ranking 

🤝 COMPAÑEROS 
!campamento, !companeros, !contratar <nombre>, !grupo 

🗺️ EXPEDICIONES 
!tablon, !expedicion <numero>, !desafiar, !interactuar, !volver, !curar 

🛍️ COMERCIO 
!tienda, !armeria1, !armeria2, !mercader, !comprar <item>, !vender <item>, !equipar <item>, !usar <item> 

📚 TRIVIA 
!trivia <facil/normal/dificil/legendario> (O puedes dejarlo vacío para aleatorio)

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

  if (command === "!companeros" || command === "!compañeros" || command === "!campamento") { 
    let texto = "🤝 **Compañeros disponibles**\n\n"; 
    const orden = ["montaraces", "alteru", "cirdil", "duinor", "andaer", "nieriel", "faelon"]; 
    for (const id of orden) { 
      const comp = companions[id]; 
      const req = comp.nivel ? `Nivel ${comp.nivel}` : "Ninguno"; 
      texto += `${getCompanionIcon(id)} **${comp.nombre}** — ${comp.clase}\n`; 
      texto += `Habilidad: ${comp.habilidad}\n`; 
      texto += `Poder base: ${getCompanionBaseSummary(id)}\n`; 
      texto += `Efecto: ${comp.efecto}\n`; 
      texto += `Coste: ${comp.coste} pts\n`; 
      texto += `Requisito: ${req}\n`; 
      texto += `Personalidad: ${getPersonalityText(id)}\n\n`; 
    } 
    return message.reply(texto); 
  }

  if (command === "!tablon") {
    const state = await db.getEventState("tablon").catch(() => null);

    let selection = Array.isArray(state?.selection) && state.selection.length
      ? state.selection
      : null;

    if (!selection) {
      const missions = await loadMissions();

      if (!missions.length) {
        return message.reply("No hay expediciones disponibles en este momento.");
      }

      selection = [...missions]
        .sort(() => Math.random() - 0.5)
        .slice(0, 5);

      await db.setEventState("tablon", {
        cycleId: state?.cycleId || Date.now(),
        lastAt: Date.now(),
        nextAt: Date.now() + (12 * 60 * 60 * 1000),
        selection
      }).catch(() => {});
    }

    let texto = "**Te acercas al tablón de anuncios y ves varias expediciones.**\n\n";

    selection.forEach((m, i) => {
      texto += `${i + 1}. ${m.titulo}\n`;
      texto += `📍 ${m.destino}\n`;
      texto += `⚠ Nivel ${m.nivel}\n`;
      texto += `🎖 ${m.puntos} pts\n`;
      texto += `📚 ${m.xp} XP\n\n`;
    });

    texto += "────────────────\n\n";
    texto += "🤝 Compañeros del campamento\n\n";

    const orden = ["montaraces", "alteru", "cirdil", "duinor", "andaer", "nieriel", "faelon"];

    for (const id of orden) {
      const comp = companions[id];
      const req = comp.nivel ? `Nivel ${comp.nivel}` : "Ninguno";

      texto += `${getCompanionIcon(id)} **${comp.nombre}** — ${comp.clase}\n`;
      texto += `Habilidad: ${comp.habilidad}\n`;
      texto += `Efecto: ${comp.efecto}\n`;
      texto += `Coste: ${comp.coste} pts\n`;
      texto += `Requisito: ${req}\n`;
    }

    texto += "Usa `!contratar <nombre>`\nUsa `!expedicion <numero>`";

    return replyLong(message, texto);
  }

  if (command === "!tienda") {
    const data = tiendaCache || await loadCatalog("tienda.json");
    const catalogItems = getCatalogItems(data);

    if (!catalogItems.length) {
      return message.reply("La tienda está vacía o no está disponible.");
    }

    const profile = await db.getProfile(message.author.id);
    const { state, items } = await getCatalogStateItems("tienda", catalogItems);
    const cycleId = state?.cycleId || state?.nextAt || state?.lastAt || 0;
    const limitedItems = items.slice(0, 12);

    const texto = await renderCatalog("tienda", limitedItems, "TIENDA DEL CAMPAMENTO", profile, cycleId);
    return replyLong(message, texto);
  }

  if (command === "!armeria1") {
    const state = await db.getEventState("armeria1").catch(() => null);
    const items = Array.isArray(state?.selection) ? state.selection : [];
    if (!items.length) {
      return message.reply("No hay objetos disponibles en Armería 1.");
    }
    const profile = await db.getProfile(message.author.id);
    const cycleId = state?.cycleId || state?.nextAt || state?.lastAt || 0;
    const texto = await renderCatalog("armeria1", items, "ARMERÍA 1", profile, cycleId);
    return replyLong(message, texto);
  }

  if (command === "!armeria2") {
    const state = await db.getEventState("armeria2").catch(() => null);
    const items = Array.isArray(state?.selection) ? state.selection : [];
    if (!items.length) {
      return message.reply("No hay objetos disponibles en Armería 2.");
    }
    const profile = await db.getProfile(message.author.id);
    const cycleId = state?.cycleId || state?.nextAt || state?.lastAt || 0;
    const texto = await renderCatalog("armeria2", items, "ARMERÍA 2", profile, cycleId);
    return replyLong(message, texto);
  }

  if (command === "!armeria") {
    return message.reply("La armería está dividida en dos partes: usa `!armeria1` o `!armeria2`.");
  }

  if (command === "!mercader") {
    const state = await db.getEventState("merchant").catch(() => null);

    if (!state?.active) {
      return message.reply("El mercader ambulante no está en el campamento en este momento.");
    }

    const catalog = mercaderCache || await loadCatalog("mercader.json");
    const catalogItems = getCatalogItems(catalog);

    if (!catalogItems.length) {
      return message.reply("El mercader no tiene mercancía disponible.");
    }

    const stock = Array.isArray(state.stock) && state.stock.length
      ? state.stock
      : catalogItems;

    const profile = await db.getProfile(message.author.id);
    const cycleId = state?.cycleId || state?.nextAt || state?.lastAt || state?.openedAt || 0;
    const items = stock.slice(0, 12);

    const header =
      `🚚 **MERCADER AMBULANTE**\n\n` +
      `Nombre: **${state.name || "Desconocido"}**\n` +
      `Destino próximo: ${state.destination || "Desconocido"}\n` +
      `Tiempo restante: ${formatRemainingTime((state.closesAt || Date.now()) - Date.now())}\n\n`;

    const texto = header + await renderCatalog("mercader", items, "MERCADER AMBULANTE", profile, cycleId);
    return replyLong(message, texto);
  }

  if (command === "!comprar") {
    const query = args.slice(1).join(" ").trim();
    if (!query) return message.reply("Usa `!comprar <nombre o id>`.");

    const profile = await db.getProfile(message.author.id);
    const inventory = normalizeInventory(profile.inventory);
    const found = await findCatalogItemByQuery(query);

    if (!found) {
      return message.reply("No encuentro ese objeto en la tienda, la armería o el mercader.");
    }

    const catalogName = found.catalogName || "tienda";
    let actualCatalogName = catalogName;

    // Si es un objeto de armeria genérico, buscamos en cuál sub-armería está activo
    if (catalogName === "armeria") {
      const state1 = await db.getEventState("armeria1").catch(() => null);
      const state2 = await db.getEventState("armeria2").catch(() => null);
      const is1 = state1?.selection?.some(i => normalizeKey(i.id) === normalizeKey(found.id));
      const is2 = state2?.selection?.some(i => normalizeKey(i.id) === normalizeKey(found.id));

      if (is1) actualCatalogName = "armeria1";
      else if (is2) actualCatalogName = "armeria2";
      else actualCatalogName = "armeria1"; // fallback seguro
    }

    const cycleState = await db.getEventState(actualCatalogName === "mercader" ? "merchant" : actualCatalogName).catch(() => null);
    const cycleId = cycleState?.cycleId || cycleState?.nextAt || cycleState?.lastAt || cycleState?.openedAt || 0;

    const remaining = getItemRemainingSlots(profile, actualCatalogName, found, cycleId);
    if (remaining <= 0) {
      return message.reply(`⚠️ No te quedan slots disponibles para **${found.nombre}** en este ciclo.`);
    }

    const price = await db.getDynamicPrice(actualCatalogName, found);
    const category = getInventoryCategoryForItem(found);
    const stackable = isStackableItem(found);
    const existing = inventory[category].find(item => normalizeKey(item.id) === normalizeKey(found.id));

    if (!stackable && existing) {
      return message.reply(`Ya posees **${found.nombre}**.`);
    }

    if ((profile.points || 0) < price) {
      return message.reply(`Necesitas **${price}** puntos para comprar **${found.nombre}**.`);
    }

    await db.spendPoints(message.author.id, price);

    if (stackable && existing) {
      existing.cantidad = Math.max(1, Number(existing.cantidad || 1)) + 1;
    } else {
      inventory[category].push(
        normalizeItemEntry(found, {
          precioCompra: price,
          catalogo: actualCatalogName
        })
      );
    }

    const catalogUsage = consumeCatalogSlot(profile, actualCatalogName, found, cycleId);

    await db.updateTravelerData(message.author.id, {
      inventory: normalizeInventory(inventory),
      catalogUsage
    });

    return message.reply(`🛒 Has comprado **${found.nombre}** por **${price}** puntos.`);
  }

  if (command === "!vender") {
    const query = args.slice(1).join(" ").trim();
    if (!query) return message.reply("Usa `!vender <nombre del objeto>`.");

    const profile = await db.getProfile(message.author.id);
    const inventory = normalizeInventory(profile.inventory);
    const found = findInventoryItem(inventory, query);

    if (!found) {
      return message.reply("No tienes ese objeto en el inventario.");
    }

    const { category, item } = found;
    const equipment = await db.getEquipment(message.author.id).catch(() => ({}));

    const equippedIds = Object.values(equipment)
      .filter(Boolean)
      .map(x => normalizeKey(x.id));

    if (equippedIds.includes(normalizeKey(item.id))) {
      return message.reply(`No puedes vender **${item.nombre}** porque lo llevas equipado.`);
    }

    const basePrice = Number(
      item.precioBase ??
      item.precioCompra ??
      item.precio ??
      0
    );

    const sellPrice = Math.max(1, Math.floor(basePrice * 0.75));

    if (isStackableItem(item) && Number(item.cantidad || 1) > 1) {
      const idx = inventory[category].findIndex(x => normalizeKey(x.id) === normalizeKey(item.id));
      if (idx !== -1) {
        inventory[category][idx].cantidad = Math.max(0, Number(inventory[category][idx].cantidad || 1) - 1);
        if (inventory[category][idx].cantidad <= 0) {
          inventory[category].splice(idx, 1);
        }
      }
    } else {
      const idx = inventory[category].findIndex(x => normalizeKey(x.id) === normalizeKey(item.id));
      if (idx !== -1) {
        inventory[category].splice(idx, 1);
      }
    }

    await db.addPoints(message.author.id, sellPrice);
    await db.updateTravelerData(message.author.id, {
      inventory: normalizeInventory(inventory)
    });

    return message.reply(`💰 Has vendido **${item.nombre}** por **${sellPrice}** puntos.`);
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
    await db.addAffinity(message.author.id, id, 2);

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
  
    let texto = "🤝 **Tus Compañeros:**\n\n";
  
    for (const id of [...new Set(lista)]) {
      const valor = (profile.affinity || {})[id] || 0;
      texto += `${getCompanionIcon(id)} **${companions[id]?.nombre || id}** — Afinidad ${valor}%\n`;
    }
  
    return message.reply(texto);
  }

  if (command === "!curar") {
    const expedition = expeditions.get(message.author.id);
    const canHealAtStart =
      expedition?.pendingStartHeal &&
      expedition?.currentEncounter === null &&
      expedition?.progress === 0;

    if (expedition && !canHealAtStart) {
      return message.reply("⚠️ No puedes curarte en medio de una expedición. Termina o usa `!volver` primero.");
    }

    const profile = await db.getProfile(message.author.id);
    const saludActual = profile.salud !== undefined ? profile.salud : 100;

    if (saludActual >= 100) {
      return message.reply(
        "🌿 Faelon te mira con calma desde su tienda: estás en plena forma. Regresa si necesitas mi ayuda."
      );
    }

    await db.updateTravelerData(message.author.id, { salud: 100 });

    if (expedition?.pendingStartHeal) {
      expedition.pendingStartHeal = false;
    }

    return message.reply(
      `🌿 **Tienda de Faelon**\n\nFaelon toma hojas de Rivendel, prepara un ungüento suave y limpia tus heridas con cuidado. El dolor cede poco a poco hasta dejarte de nuevo en pie.\n\n❤️ Salud restaurada: **100/100**\n\nFaelon te observa con serenidad y te aconseja no andar solo.`
    );
  }

  const POWER_TIER_TABLE = {
  1: {
    dangerLabel: "Prácticamente desnudo",
    powerMin: 6,
    powerMax: 10,
    composition: "Casi todo tier 1. Sin armadura o con piezas mínimas.",
    armorRead: "Va prácticamente desnudo."
  },
  2: {
    dangerLabel: "Defensa pobre",
    powerMin: 11,
    powerMax: 16,
    composition: "Mayoría tier 1, con una o dos piezas tier 2.",
    armorRead: "Tiene protección ligera y desordenada."
  },
  3: {
    dangerLabel: "Equipo básico",
    powerMin: 17,
    powerMax: 24,
    composition: "Tier 1 dominante con varias piezas tier 2.",
    armorRead: "Usa equipo modesto, todavía vulnerable."
  },
  4: {
    dangerLabel: "Equipo competente",
    powerMin: 25,
    powerMax: 34,
    composition: "Tier 2 dominante, alguna pieza tier 1 o tier 3 puntual.",
    armorRead: "Posee una armadura que lo hace una amenaza seria."
  },
  5: {
    dangerLabel: "Amenaza seria",
    powerMin: 35,
    powerMax: 44,
    composition: "Tier 2 fuerte con alguna pieza tier 3.",
    armorRead: "Se nota un salto claro de calidad en su protección."
  },
  6: {
    dangerLabel: "Veteranos",
    powerMin: 45,
    powerMax: 56,
    composition: "Tier 3 emergente y varias piezas sólidas de tier 2.",
    armorRead: "Su equipo está curtido y es muy peligroso."
  },
  7: {
    dangerLabel: "Élite local",
    powerMin: 57,
    powerMax: 70,
    composition: "Tier 3 dominante, con base consistente.",
    armorRead: "Ya parece alguien con equipo profesional."
  },
  8: {
    dangerLabel: "Élite dura",
    powerMin: 71,
    powerMax: 86,
    composition: "Tier 3 fuerte con piezas tier 4 puntuales.",
    armorRead: "Posee armadura de gran calidad."
  },
  9: {
    dangerLabel: "Amenaza mayor",
    powerMin: 87,
    powerMax: 104,
    composition: "Tier 4 presente, respaldado por tier 3 de alta calidad.",
    armorRead: "Su nivel de equipo es letal y de alto nivel."
  },
  10: {
    dangerLabel: "Jefe / monstruo",
    powerMin: 105,
    powerMax: 124,
    composition: "Tier 4 dominante. Composición de élite completa.",
    armorRead: "Es un rival monstruoso revestido en poder."
  }
};

function clampNumber(value, min, max) {
  const n = Number(value);
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function getDangerTierProfile(danger = 1) {
  const d = clampNumber(danger, 1, 10);
  return POWER_TIER_TABLE[d] || POWER_TIER_TABLE[1];
}

function getTravelerCorePower(profile = {}) {
  const level = typeof db.calculateLevel === "function"
    ? db.calculateLevel(profile.xp || 0)
    : Math.floor((profile.xp || 0) / 1000) + 1;

  const health = Number(profile.salud ?? 100);
  const points = Number(profile.points || 0);
  const classBonus = getPlayerClassBonus(profile);
  const classScore = Math.round(
    Object.values(classBonus).reduce((sum, v) => sum + (typeof v === "number" ? v : 0), 0) * 100
  );

  const score = Math.max(
    1,
    Math.round(
      (level * 10) +
      Math.floor(health / 10) +
      Math.floor(points / 25) +
      classScore
    )
  );

  return {
    score,
    level,
    health,
    points,
    rank: obtenerRango(points),
    classScore,
    classText: getPlayerClassBonusText(profile)
  };
}

function getCompanionPowerDetails(profile = {}) {
  const owned = [...new Set(getOwnedCompanions(profile))];

  const details = owned.map(id => {
    const base = getCompanionBasePower(id);
    const eqScore = Math.round(base.total * 2);
    const clsScore = Math.round((base.successBonus * 100) + (base.damageReduction * 100));
    const score = Math.max(1, eqScore + clsScore);

    return {
      id,
      nombre: companions[id]?.nombre || id,
      score,
      eqScore,
      clsScore,
      base
    };
  });

  const total = details.reduce((sum, c) => sum + c.score, 0);

  return {
    total,
    details
  };
}

function getEnemyPowerSummary(encounter = {}) {
  if (!encounter || typeof encounter !== "object") {
    return {
      peligro: 0,
      tipo: "desconocido",
      categoria: "desconocida"
    };
  }

  const peligro = Number(encounter.peligro ?? 0);

  return {
    peligro,
    tipo: encounter.tipo || "desconocido",
    categoria: encounter.categoria || "desconocida"
  };
}

function getPowerComparisonText(delta) {
  if (delta >= 20) return "Ventaja aplastante";
  if (delta >= 10) return "Ventaja clara";
  if (delta >= 3) return "Ventaja ligera";
  if (delta >= -2) return "Equilibrio";
  if (delta >= -9) return "Desventaja ligera";
  if (delta >= -19) return "Desventaja clara";
  return "Desventaja brutal";
}

function buildPowerComparisonBlock({ profile = {}, equipment = {}, encounter = {} }) {
  const validTypes = ["enemigo_numeroso", "enemigo_poderoso", "jefe", "escenario_final"];
  if (!validTypes.includes(encounter?.tipo) && !validTypes.includes(encounter?.categoria)) return "";

  const traveler = getTravelerCorePower(profile);
  const eq = getEquipmentPowerSummary(equipment, profile.activeUtilities || []);
  const classText = getPlayerClassBonusText(profile);
  const eqText = formatEquipmentTotals(eq.totals);

  const party = getCompanionPowerDetails(profile);
  const companionLines = party.details.length
    ? party.details.map(c => `• **${c.nombre}**: Éxito +${Math.round(c.base.successBonus * 100)}% | Defensa +${Math.round(c.base.damageReduction * 100)}% | Poder Eq. ${c.eqScore}`).join("\n")
    : "• Sin compañeros";

  const enemy = getEnemyPowerSummary(encounter);
  const enemyTier = getDangerTierProfile(enemy.peligro);

  const dmg = encounter.dano || (enemy.peligro * 8 + (encounter.tipo === "jefe" ? 20 : 0));
  const def = Math.min(85, enemy.peligro * 6 + (encounter.tipo === "jefe" ? 15 : 0));

  let enemyStats = `Daño aprox. ${dmg} | Defensa ${def}%`;
  if (encounter.efectos || encounter.stats) {
     const stats = encounter.efectos || encounter.stats;
     if (stats.sigilo) enemyStats += ` | Sigilo ${stats.sigilo}%`;
     if (stats.percepcion) enemyStats += ` | Percepción ${stats.percepcion}%`;
     if (stats.voluntad) enemyStats += ` | Voluntad ${stats.voluntad}%`;
  }

  const expeditionTotal = traveler.score + eq.score + party.total;
  const enemyScore = (enemy.peligro * 15) + (encounter.tipo === "jefe" ? 30 : 0);
  const delta = expeditionTotal - enemyScore;
  const comparison = getPowerComparisonText(delta);

  return (
`📊 **TABLA DE PODER Y ESTADÍSTICAS**

**Tu lado**
• Nivel: ${traveler.level} | Salud: ${traveler.health}/100
• **Stats de Clase**: ${classText !== "Sin bonos de clase" ? classText : "Ninguno"}
• **Stats de Equipo**: ${eqText !== "Sin bonos extra" ? eqText : "Ninguno"}
• **Poder Total Aprox.**: ${traveler.score + eq.score}

**Compañeros**
${companionLines}

**Enemigo (${enemy.tipo.replace(/_/g, " ")})**
• Peligro: ${getDangerText(enemy.peligro)} (Tier ${enemy.peligro})
• Armadura: ${enemyTier.armorRead}
• Stats Enemigo: ${enemyStats}

**Comparativa General**
• Balance de Poder: ${comparison}`
  );
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

    const missions = await getCurrentTablonSelection();
    const mission = missions[numero - 1];
    if (!mission) return message.reply("Esa misión no existe.");

    const profile = await db.getProfile(message.author.id);
    const saludActual = profile.salud !== undefined ? profile.salud : 100; 
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
      pendingStartHeal: true,
      mission,
      progress: 0,
      currentEncounter: null,
      xpEarned: 0,
      pointsEarned: 0,
      failed: false,
      threat: 0,
      affinityLog: {},
      pendingFinalScenario: false,
      finalScenarioShown: false,
      finalScenario: getFinalScenarioConfig(mission)
    });

    await db.updateTravelerData(message.author.id, {
      activeCompanions
    });

    const avisoSalud = saludActual < 100 ? `⚠️ Vas herido (${saludActual}/100). Puedes pasar por la tienda de Faelon antes para que puedas  \`!curar\` tus heridas.\n\n` : ""; 
    const textoExpedicion = `📜 ${mission.titulo}\n\n📍 Destino: ${mission.destino}\n\n${mission.descripcion}\n\nUsa !desafiar para comenzar el viaje.`;

    return replyLong(message, `${avisoSalud}${textoExpedicion}`);
  }

  if (command === "!interactuar") {
    const expedition = expeditions.get(message.author.id);
    const special = expedition?.currentEncounter;

    if (!special) {
      return message.reply("No hay nada con lo que interactuar aquí.");
    }

    if (special.tipo !== "evento_especial") {
      return message.reply("Usa !desafiar para este encuentro.");
    }

    special.interacted = true;
    const profile = await db.getProfile(message.author.id);

    // Otorgar éxito y avanzar progreso de la expedición directamente
    const xpGanada = special.xp || 10;
    const puntosGanados = special.puntos || 5;

    expedition.xpEarned += xpGanada;
    expedition.pointsEarned += puntosGanados;
    expedition.progress += 1;

    let textoVictoria = `🌟 **Interacción completada**\n\nHas resuelto el suceso de *${special.titulo}*.\n\n+${xpGanada} XP`;
    if (puntosGanados > 0) textoVictoria += `\n+${puntosGanados} Puntos`;

    const ownedComps = getOwnedCompanions(profile);
    const affinityGained = [];
    for (const cid of [...new Set(ownedComps)]) {
      const result = await addAffinityWithRankMessage(message.author.id, cid, special, "victoria", "victoria");
      expedition.affinityLog[cid] = (expedition.affinityLog[cid] || 0) + result.gain;
      affinityGained.push(`• **${companions[cid]?.nombre || cid}**: +${result.gain} afinidad`);
      if (result.rankMessage) affinityGained.push(`  ${result.rankMessage}`);
    }

    if (affinityGained.length) textoVictoria += `\n\n🤝 Afinidad ganada:\n${affinityGained.join("\n")}`;

    const reactionIds = [...new Set(ownedComps)].slice(0, 3);
    const reactions = [];
    for (const cid of reactionIds) {
      const line = await companionReaction(cid, special, "victoria");
      if (line) reactions.push(`💬 ${line}`);
    }
    if (reactions.length) textoVictoria += `\n\n${reactions.join("\n")}`;

    expedition.currentEncounter = null;
    const totalEncuentros = expedition.mission.encuentros?.length || 0;

    if (expedition.progress < totalEncuentros) {
      textoVictoria += `\n\n🛤️ El camino continúa.\n\nUsa !desafiar para seguir viajando.`;
      return message.reply(textoVictoria);
    }

    if (expedition.finalScenario?.enabled && !expedition.finalScenarioShown) {
      expedition.finalScenarioShown = true;
      expedition.pendingFinalScenario = true;
      const enemyPresent = rollFinalScenarioEnemyPresence(expedition.finalScenario);
      expedition.currentEncounter = {
        ...expedition.finalScenario,
        tipo: "escenario_final",
        categoria: "final",
        active: true,
        enemyPresent,
        allowedActions: enemyPresent ? expedition.finalScenario.allowedActions : ["retirarse"]
      };
      textoVictoria += `\n\n⚠️ **Has llegado al final de la expedición.** Usa \`!desafiar\` para encarar el último escenario.`;
      return message.reply(textoVictoria);
    }

    const xpTotal = expedition.xpEarned + (expedition.mission.xp || 0);
    const puntosTotal = expedition.pointsEarned + (expedition.mission.puntos || 0);

    const beforeProfile = await db.getProfile(message.author.id);
    const beforeLevel = typeof db.calculateLevel === "function" ? db.calculateLevel(beforeProfile.xp || 0) : Math.floor((beforeProfile.xp || 0) / 1000) + 1;
    const beforeRank = obtenerRango(beforeProfile.points || 0);

    await db.addXP(message.author.id, xpTotal);
    await db.addPoints(message.author.id, puntosTotal);

    const afterProfile = await db.getProfile(message.author.id);
    const afterLevel = typeof db.calculateLevel === "function" ? db.calculateLevel(afterProfile.xp || 0) : Math.floor((afterProfile.xp || 0) / 1000) + 1;
    const afterRank = obtenerRango(afterProfile.points || 0);

    const finalAffinityEntries = Object.entries(expedition.affinityLog || {});
    const finalAffinityText = finalAffinityEntries.length
      ? finalAffinityEntries.map(([id, value]) => `• **${companions[id]?.nombre || id}**: +${value} afinidad`).join("\n")
      : "• Ninguna";

    const finalReactions = [];
    for (const cid of ownedComps.slice(0, 3)) {
      const line = await companionReaction(cid, expedition.mission, "mision_completada");
      if (line) finalReactions.push(`💬 ${line}`);
    }

    const utilMsg = await decrementUtilities(message.author.id);

    await clearExpeditionParty(message.author.id);
    expedition.pendingFinalScenario = false;
    expeditions.delete(message.author.id);

    textoVictoria += `\n\n🎉 **Misión completada con éxito**\n\n${expedition.mission.textoExito || "¡Has completado con éxito la expedición!"}\n\n🏆 Puntos obtenidos: +${puntosTotal}\n📚 XP obtenida: +${xpTotal}\n\n🤝 Afinidad ganada total:\n${finalAffinityText}`;
    if (afterLevel > beforeLevel) textoVictoria += `\n\n📚 **Ascenso de nivel**\n¡Felicidades! Has subido al nivel **${afterLevel}**.`;
    if (afterRank !== beforeRank) textoVictoria += `\n🏅 **Ascenso de rango**\n¡Felicidades! Has ascendido de rango, ahora eres conocido como **${afterRank}**.`;
    if (finalReactions.length) textoVictoria += `\n\n${finalReactions.join("\n")}`;

    textoVictoria += utilMsg;
    return message.reply(textoVictoria);
  }
  
  if (command === "!volver") {
    if (!expeditions.has(message.author.id)) {
      return message.reply("No estás en una expedición.");
    }

    const expedition = expeditions.get(message.author.id);
    const partialXP = expedition.xpEarned || 0;
    const partialPoints = expedition.pointsEarned || 0;

    if (partialXP > 0 || partialPoints > 0) {
    await db.addXP(message.author.id, partialXP);
    await db.addPoints(message.author.id, partialPoints);
    }

    expeditions.delete(message.author.id);
    await clearExpeditionParty(message.author.id);
    const utilMsg = await decrementUtilities(message.author.id);

    return message.reply(`⛺ Regresas a salvo al campamento base. Expedición abortada.${utilMsg}`);
  }

  if (command === "!desafiar") {
    if (!expeditions.has(message.author.id)) {
      return message.reply("No estás en ninguna expedición activa. Usa `!tablon`.");
    }

    const expedition = expeditions.get(message.author.id);
    const profile = await db.getProfile(message.author.id);
    const owned = getOwnedCompanions(profile);
    const equipmentRaw = await db.getEquipment?.(message.author.id).catch(() => null);
    const equipment = getResolvedEquipment(profile, equipmentRaw);

    expedition.affinityLog = expedition.affinityLog || {};
    if (typeof expedition.pendingFinalScenario !== "boolean") {
      expedition.pendingFinalScenario = false;
    }

    const affinityCombat = getAffinityCombatBonus(profile, owned);

    const recordAffinity = async (compId, encounter, mode, outcome) => {
      const result = await addAffinityWithRankMessage(message.author.id, compId, encounter, mode, outcome);
      expedition.affinityLog[compId] = (expedition.affinityLog[compId] || 0) + result.gain;
      return result;
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

    if (expedition.currentEncounter && expedition.currentEncounter.tipo === "evento_especial" && !expedition.currentEncounter.interacted) {
      return message.reply("🌟 Este es un evento especial. Debes usar `!interactuar` para involucrarte o `!volver` para huir.");
    }

    // === GENERAR NUEVO ENCUENTRO ===
    if (expedition.currentEncounter === null) {
      const encuentroId = expedition.mission.encuentros?.[expedition.progress];

      // Misión completada o avance al final
      if (!encuentroId) {
        if (expedition.finalScenario?.enabled && !expedition.finalScenarioShown) {
          expedition.finalScenarioShown = true;
          expedition.pendingFinalScenario = true;
          const enemyPresent = rollFinalScenarioEnemyPresence(expedition.finalScenario);
          expedition.currentEncounter = {
            ...expedition.finalScenario,
            tipo: "escenario_final",
            categoria: "final",
            active: true,
            enemyPresent,
            allowedActions: enemyPresent ? expedition.finalScenario.allowedActions : ["retirarse"]
          };
          const escenario = expedition.currentEncounter;

          let textoFinalScenario = `🌑 **Escenario final**\n\n${escenario.descripcion}\n\n`;

          textoFinalScenario += enemyPresent
            ? `⚔️ Presencia enemiga detectada.\nUsa: ${escenario.allowedActions.join(", ")}`
            : `🕊️ El área parece segura por ahora.\nPuedes retirarte.`;

          return message.reply(textoFinalScenario);
        }

        const xpTotal = expedition.xpEarned + (expedition.mission.xp || 0);
        const puntosTotal = expedition.pointsEarned + (expedition.mission.puntos || 0);

        const beforeProfile = await db.getProfile(message.author.id);
        const beforeLevel = typeof db.calculateLevel === "function" ? db.calculateLevel(beforeProfile.xp || 0) : Math.floor((beforeProfile.xp || 0) / 1000) + 1;
        const beforeRank = obtenerRango(beforeProfile.points || 0);

        await db.addXP(message.author.id, xpTotal);
        await db.addPoints(message.author.id, puntosTotal);

        const afterProfile = await db.getProfile(message.author.id);
        const afterLevel = typeof db.calculateLevel === "function" ? db.calculateLevel(afterProfile.xp || 0) : Math.floor((afterProfile.xp || 0) / 1000) + 1;
        const afterRank = obtenerRango(afterProfile.points || 0);

        const affinityEntries = Object.entries(expedition.affinityLog || {});
        const affinityText = affinityEntries.length
          ? affinityEntries.map(([id, value]) => `• **${companions[id]?.nombre || id}**: +${value} afinidad`).join("\n")
          : "• Ninguna";

        const finalReactions = [];
        for (const cid of owned.slice(0, 3)) {
          const line = await companionReaction(cid, expedition.mission, "mision_completada");
          if (line) finalReactions.push(`💬 ${line}`);
        }

        const utilMsg = await decrementUtilities(message.author.id);

        await clearExpeditionParty(message.author.id);
        expedition.pendingFinalScenario = false;
        expeditions.delete(message.author.id);

        let textoFinal = `🎉 **Misión completada con éxito**\n\n${expedition.mission.textoExito || "¡Has completado con éxito la expedición!"}\n\n🏆 Puntos obtenidos: +${puntosTotal}\n📚 XP obtenida: +${xpTotal}\n\n🤝 Afinidad ganada:\n${affinityText}`;
        if (afterLevel > beforeLevel) textoFinal += `\n\n📚 **Ascenso de nivel**\n¡Felicidades! Has subido al nivel **${afterLevel}**.`;
        if (afterRank !== beforeRank) textoFinal += `\n🏅 **Ascenso de rango**\n¡Felicidades! Has ascendido de rango, ahora eres conocido como **${afterRank}**.`;
        if (finalReactions.length) textoFinal += `\n\n${finalReactions.join("\n")}`;

        textoFinal += utilMsg;
        return message.reply(textoFinal);
      }

      const encounters = await loadEncounters();
      const destino = normalizeKey(expedition.mission.destino);

      let lista = encounters.filter(e => {
        const coincideEncuentro = e.tipo === encuentroId || e.categoria === encuentroId;
        const coincideRegion = Array.isArray(e.region) && e.region.some(r => normalizeKey(r) === destino);
        return coincideEncuentro && coincideRegion;
      });

      const xpActual = profile.xp || 0;
      const nivelJugador = typeof db.calculateLevel === "function" ? db.calculateLevel(xpActual) : Math.floor(xpActual / 1000) + 1;

      if (owned.includes("nieriel")) {
        const safe = lista.filter(e => (e.peligro ?? 0) <= nivelJugador);
        if (safe.length) lista = safe;
      }

      if (!lista.length) {
        lista = [{
          id: `fallback_${encuentroId}_${Date.now()}`,
          titulo: "Encuentro de respaldo",
          descripcion: "La expedición avanza hacia un obstáculo improvisado.",
          tipo: encuentroId,
          categoria: encuentroId,
          peligro: Math.max(1, Math.min(10, nivelJugador))
        }];
      }

      const encounterBase = lista[Math.floor(Math.random() * lista.length)];

      expedition.pendingStartHeal = false;
      expedition.currentEncounter = encounterBase;
      expedition.phase = "running";

      const powerBlock = buildPowerComparisonBlock({ profile, equipment, encounter: encounterBase });
      const accionRequerida = encounterBase.tipo === "evento_especial" ? "!interactuar" : "!desafiar";
      let textoEncuentro = buildEncounterCard(encounterBase, accionRequerida, powerBlock);

      const reactionIds = [...new Set(owned)].slice(0, 3);
      const reactions = [];
      for (const cid of reactionIds) {
        const line = await companionReaction(cid, encounterBase, "encounter");
        if (line) reactions.push(`💬 ${line}`);
      }

      if (reactions.length) textoEncuentro += `\n\n${reactions.join("\n")}`;
      return message.reply(textoEncuentro);
    }

    // === RESOLVER ENCUENTRO ACTUAL ===
    let activeEncounter = expedition.currentEncounter;

    if (activeEncounter.tipo === "escenario_final") {
      expedition.pendingFinalScenario = true;
      return startFinalScenario(message, expedition);
    }

    const encounters = await loadEncounters();
    const subOptions = getEncounterSubOptions(activeEncounter, encounters);

    if (!activeEncounter.subEncounter && subOptions.length > 0) {
      const chosen = subOptions[Math.floor(Math.random() * subOptions.length)];
      const variant = { ...activeEncounter, ...chosen, parentId: activeEncounter.id, variantOf: activeEncounter.id, subEncounter: true };
      expedition.currentEncounter = variant;

      const powerBlock = buildPowerComparisonBlock({ profile, equipment, encounter: variant });
      let textoEncuentro = buildEncounterCard(variant, "!desafiar", powerBlock);

      const reactionIds = [...new Set(owned)].slice(0, 3);
      const reactions = [];
      for (const cid of reactionIds) {
        const line = await companionReaction(cid, variant, "encounter");
        if (line) reactions.push(`💬 ${line}`);
      }

      if (reactions.length) textoEncuentro += `\n\n${reactions.join("\n")}`;

      return message.reply(`Avanzas en el escenario y se revela un nuevo desafío...\n\n${textoEncuentro}`);
    }

    const bonuses = getCompanionBonus(profile);
    const playerClassBonus = getPlayerClassBonus(profile);
    const eqPower = getEquipmentPowerSummary(equipment, profile.activeUtilities || []);

    let affinityBonus = 0;
    for (const comp of owned) affinityBonus += getAffinityBonus(profile, comp);

    let baseSuccess = 0.65 + bonuses.captainBonus + bonuses.rangerBonus + affinityCombat.successBonus + affinityBonus;
    baseSuccess += bonuses.baseSuccessBonus || 0;
    baseSuccess += eqPower.totals.successBonus || 0; // Utilidades y equipo
    
    if (activeEncounter.tipo === "enemigo_poderoso" || activeEncounter.tipo === "jefe" || (activeEncounter.peligro || 0) >= 4) {
      baseSuccess += bonuses.strongEnemyBonus;
    }
    if (activeEncounter.tipo === "enemigo_numeroso") baseSuccess += bonuses.numerousEnemyBonus;
    if (activeEncounter.tipo === "jefe") baseSuccess += 0.05;
    if (activeEncounter.tipo === "evento_especial") baseSuccess += playerClassBonus.specialBonus || 0;
    if (activeEncounter.tipo === "obstaculo") baseSuccess += playerClassBonus.explorationBonus || 0;
    if (activeEncounter.tipo === "jefe" || activeEncounter.tipo === "enemigo_poderoso") baseSuccess += playerClassBonus.attackBonus || 0;

    const success = Math.random() < Math.min(baseSuccess, 0.95);

    if (success) {
      const xpGanada = activeEncounter.xp || 10;
      const puntosGanados = activeEncounter.puntos || 5;

      expedition.xpEarned += xpGanada;
      expedition.pointsEarned += puntosGanados;
      expedition.progress += 1;

      let textoVictoria = `✅ **Éxito**\n\nHas superado el desafío de *${activeEncounter.titulo}*.\n\n+${xpGanada} XP`;
      if (puntosGanados > 0) textoVictoria += `\n+${puntosGanados} Puntos`;

      const affinityGained = [];
      for (const cid of [...new Set(owned)]) {
        const result = await recordAffinity(cid, activeEncounter, "victoria", "victoria");
        affinityGained.push(`• **${companions[cid]?.nombre || cid}**: +${result.gain} afinidad`);
        if (result.rankMessage) affinityGained.push(`  ${result.rankMessage}`);
      }

      if (affinityGained.length) textoVictoria += `\n\n🤝 Afinidad ganada:\n${affinityGained.join("\n")}`;

      const faelonHeal = await healWithFaelon();
      if (faelonHeal) textoVictoria += `\n❤️ Faelon restaura +10 salud (${faelonHeal.nuevaSalud}/100).`;

      const reactionIds = [...new Set(owned)].slice(0, 3);
      const reactions = [];
      for (const cid of reactionIds) {
        const line = await companionReaction(cid, activeEncounter, "victoria");
        if (line) reactions.push(`💬 ${line}`);
      }
      if (reactions.length) textoVictoria += `\n\n${reactions.join("\n")}`;

      expedition.currentEncounter = null;
      const totalEncuentros = expedition.mission.encuentros?.length || 0;

      if (expedition.progress < totalEncuentros) {
        textoVictoria += `\n\n🛤️ El camino continúa.\n\nUsa !desafiar para seguir viajando.`;
        return message.reply(textoVictoria);
      }

      if (expedition.finalScenario?.enabled && !expedition.finalScenarioShown) {
        expedition.finalScenarioShown = true;
        expedition.pendingFinalScenario = true;
        const enemyPresent = rollFinalScenarioEnemyPresence(expedition.finalScenario);
        expedition.currentEncounter = {
          ...expedition.finalScenario,
          tipo: "escenario_final",
          categoria: "final",
          active: true,
          enemyPresent,
          allowedActions: enemyPresent ? expedition.finalScenario.allowedActions : ["retirarse"]
        };
        textoVictoria += `\n\n⚠️ **Has llegado al final de la expedición.** Usa \`!desafiar\` para encarar el último escenario.`;
        return message.reply(textoVictoria);
      }

      const xpTotal = expedition.xpEarned + (expedition.mission.xp || 0);
      const puntosTotal = expedition.pointsEarned + (expedition.mission.puntos || 0);

      const beforeProfile = await db.getProfile(message.author.id);
      const beforeLevel = typeof db.calculateLevel === "function" ? db.calculateLevel(beforeProfile.xp || 0) : Math.floor((beforeProfile.xp || 0) / 1000) + 1;
      const beforeRank = obtenerRango(beforeProfile.points || 0);

      await db.addXP(message.author.id, xpTotal);
      await db.addPoints(message.author.id, puntosTotal);

      const afterProfile = await db.getProfile(message.author.id);
      const afterLevel = typeof db.calculateLevel === "function" ? db.calculateLevel(afterProfile.xp || 0) : Math.floor((afterProfile.xp || 0) / 1000) + 1;
      const afterRank = obtenerRango(afterProfile.points || 0);

      const finalAffinityEntries = Object.entries(expedition.affinityLog || {});
      const finalAffinityText = finalAffinityEntries.length
        ? finalAffinityEntries.map(([id, value]) => `• **${companions[id]?.nombre || id}**: +${value} afinidad`).join("\n")
        : "• Ninguna";

      const finalReactions = [];
      for (const cid of owned.slice(0, 3)) {
        const line = await companionReaction(cid, expedition.mission, "mision_completada");
        if (line) finalReactions.push(`💬 ${line}`);
      }

      const utilMsg = await decrementUtilities(message.author.id);

      await clearExpeditionParty(message.author.id);
      expedition.pendingFinalScenario = false;
      expeditions.delete(message.author.id);

      textoVictoria += `\n\n🎉 **Misión completada con éxito**\n\n${expedition.mission.textoExito || "¡Has completado con éxito la expedición!"}\n\n🏆 Puntos obtenidos: +${puntosTotal}\n📚 XP obtenida: +${xpTotal}\n\n🤝 Afinidad ganada total:\n${finalAffinityText}`;
      if (afterLevel > beforeLevel) textoVictoria += `\n\n📚 **Ascenso de nivel**\n¡Felicidades! Has subido al nivel **${afterLevel}**.`;
      if (afterRank !== beforeRank) textoVictoria += `\n🏅 **Ascenso de rango**\n¡Felicidades! Has ascendido de rango, ahora eres conocido como **${afterRank}**.`;
      if (finalReactions.length) textoVictoria += `\n\n${finalReactions.join("\n")}`;

      textoVictoria += utilMsg;
      return message.reply(textoVictoria);

    } else {
      const saludActual = profile.salud !== undefined ? profile.salud : 100;

      if (owned.length > 0 && Math.random() < 0.15) {
        const salvadorId = owned[Math.floor(Math.random() * owned.length)];
        const salvador = companions[salvadorId]?.nombre || "Un compañero";
        const reaction = await companionReaction(salvadorId, activeEncounter, "salvacion");

        return message.reply(`🛡️ **¡Salvado por los pelos!**\n\n${salvador} interviene en el último segundo, bloqueando el ataque de *${activeEncounter.titulo}*.\n\n❤️ Salud intacta: ${saludActual}/100\n\n${reaction ? `💬 ${reaction}\n\n` : ""}Usa \`!desafiar\` para intentarlo de nuevo o \`!volver\` para huir.`);
      }

      let danoEnemigo = activeEncounter.dano || Math.floor(Math.random() * 25) + 20;
      const totalDmgRed = (bonuses.damageReduction || 0) + (affinityCombat.damageReduction || 0) + (bonuses.baseDamageReduction || 0) + (eqPower.totals.damageReduction || 0);
      danoEnemigo = Math.floor(danoEnemigo * (1 - totalDmgRed));

      const nuevaSalud = saludActual - danoEnemigo;

      const affinityGainedLoss = [];
      for (const cid of [...new Set(owned)]) {
        const result = await recordAffinity(cid, activeEncounter, "derrota", "derrota");
        affinityGainedLoss.push(`• **${companions[cid]?.nombre || cid}**: +${result.gain} afinidad`);
        if (result.rankMessage) affinityGainedLoss.push(`  ${result.rankMessage}`);
      }

      const reactionIds = [...new Set(owned)].slice(0, 3);
      const reactions = [];
      for (const cid of reactionIds) {
        const line = await companionReaction(cid, activeEncounter, "derrota");
        if (line) reactions.push(`💬 ${line}`);
      }

      if (nuevaSalud <= 0) {
        const utilMsg = await decrementUtilities(message.author.id);
        await clearExpeditionParty(message.author.id);
        expedition.pendingFinalScenario = false;
        expeditions.delete(message.author.id);

        return message.reply(`💀 **Has caído en combate**\n\nEl ataque de *${activeEncounter.titulo}* fue demasiado fuerte. Recibes ${danoEnemigo} de daño.\n\nLa expedición fracasa. Eres rescatado y devuelto al campamento.\n\n*(Tu salud ha sido restaurada)*\n\n🤝 Afinidad ganada:\n${affinityGainedLoss.length ? affinityGainedLoss.join("\n") : "• Ninguna"}${reactions.length ? `\n\n${reactions.join("\n")}` : ""}` + utilMsg);
      }

      await db.updateTravelerData(message.author.id, { salud: nuevaSalud });

      return message.reply(`⚠️ **Recibes Daño**\n\nRecibes ${danoEnemigo} de daño en *${activeEncounter.titulo}*.\n\n❤️ Salud restante: ${nuevaSalud}/100\n\n🤝 Afinidad ganada:\n${affinityGainedLoss.length ? affinityGainedLoss.join("\n") : "• Ninguna"}\n\nUsa \`!desafiar\` para reintentar o \`!volver\` para huir.${reactions.length ? `\n\n${reactions.join("\n")}` : ""}`);
    }
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

    let difficulty;
    if (args[1]) {
      difficulty = normalizeDifficulty(args[1]);
    } else {
      const diffs = ["facil", "normal", "dificil"];
      difficulty = diffs[Math.floor(Math.random() * diffs.length)];
    }

    const allowed = ["facil", "normal", "dificil", "legendario"];
    if (!allowed.includes(difficulty)) {
      return message.reply("⚠️ Dificultad inválida. Usa: `!trivia facil`, `!trivia normal`, `!trivia dificil` o `!trivia legendario`.");
    }

    const profile = await db.getProfile(message.author.id);
    const questions = await loadQuestions();
    
    const history = profile.triviaHistory || [];
    let filtered = questions.filter(q => normalizeDifficulty(q.dificultad || q.difficulty || "normal") === difficulty && !history.includes(q.pregunta || q.question));

    if (!filtered.length) {
      filtered = questions.filter(q => normalizeDifficulty(q.dificultad || q.difficulty || "normal") === difficulty);
      history.length = 0;
    }

    if (!filtered.length) {
      return message.reply(`No hay preguntas configuradas para la dificultad: **${difficulty}**.`);
    }

    const question = filtered[Math.floor(Math.random() * filtered.length)];
    history.push(question.pregunta || question.question);
    if (history.length > 20) history.shift();
    await db.updateTravelerData(message.author.id, { triviaHistory: history });

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
    "!al": "alteru",
    "!c": "cirdil",
    "!d": "duinor",
    "!an": "andaer",
    "!n": "nieriel",
    "!f": "faelon",
    "!m": "montaraces"
  };

  if (companionCommands[command]) {
    const companionId = companionCommands[command];
    const mensaje = content.slice(args[0].length).trim();
    if (!mensaje) return message.reply("Escribe algo después del comando.");

    const personaje = getPersonaje(companionId) || companions[companionId];
    if (!personaje) return message.reply("Ese compañero no está disponible.");

    const profile = await db.getProfile(message.author.id);
    const affinity = (profile.affinity || {})[companionId] || 0;

    const systemPrompt = `Eres ${personaje.nombre}.
Personalidad: ${personaje.personalidad || personaje.descripcion || personaje.tono || companions[companionId]?.efecto || "reservado"}
Afinidad con el viajero: ${affinity}
Trata al viajero según esta escala:
0-24 desconocido, 25-49 conocido, 50-74 aliado, 75-99 amigo cercano, 100 compañero de confianza
Instrucciones:
Responde con una sola línea corta (máximo 12 palabras). Reacciona natural al jugador.`;

    try {
      const reply = await chatWithAI({
        systemPrompt,
        messages: [{ role: "user", content: mensaje }],
        temperature: 0.9,
        maxTokens: 120
      });

      const clean = String(reply || "").trim();
      await db.addAffinity(message.author.id, companionId, 1);

      return message.reply(
        clean.startsWith(personaje.nombre)
          ? clean
          : `${personaje.nombre}: ${compactLine(clean || "*asiente*", 18)}`
      );
    } catch (err) {
      console.error("Groq Catch Error (Direct RP):", err);
      return message.reply(`${personaje.nombre}: *asiente en silencio*`);
    }
  }

  // Comando de Roleplay Principal con Altéru (!a)
  if (command === "!a") {
    const prompt = content.slice(args[0].length).trim();
    if (!prompt) return message.reply('Escribe algo después de !a para hablar con Altéru.');

    try {
      if (!loreCache) loreCache = await loadAlteruLore();
      await message.channel.sendTyping();
      const reply = await askGroq(message.author.id, prompt, loreCache);
      return message.reply(reply);
    } catch (err) {
      console.error("Unhandled Error during !a process:", err);
      return message.reply("¿Qué dijiste? No te oí.");
    }
  }
});

client.login(DISCORD_TOKEN);
