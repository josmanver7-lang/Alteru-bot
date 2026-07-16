// ==========================================
// CONFIGURACIÓN GENERAL - Campamento de Altéru
// ==========================================

export const ADMIN_USER_ID = process.env.ADMIN_USER_ID || "276922628613079040";

export const TRIVIA_LIMIT = 3;
export const TRIVIA_WINDOW_MS = 12 * 60 * 60 * 1000;

export const EXPEDITION_LIMIT = 3;
export const EXPEDITION_WINDOW_MS = 12 * 60 * 60 * 1000;

export const EXPLORATION_LIMIT = 1;
export const EXPLORATION_WINDOW_MS = 12 * 60 * 60 * 1000;

export const EXPLORATION_POINT_MIN = 10;
export const EXPLORATION_POINT_MAX = 200;

// Niveles
export const LEVEL_XP_REQUIREMENTS = {
  1: 0, 2: 1000, 3: 2500, 4: 5000, 5: 10000, 
  6: 17500, 7: 27500, 8: 42500, 9: 62500, 10: 82500
};

// Matriz de Combate
export const COMBAT_MATRIX = {
    meleeBonus:    { cavalryBonus: 2.0,  thrownBonus: -1.5, rangedBonus: -1.5, magicBonus: -2.0 },
    rangedBonus:   { meleeBonus: 1.5,    magicBonus: 1.5,   thrownBonus: -1.5, cavalryBonus: -2.0 },
    thrownBonus:   { rangedBonus: 1.5,   magicBonus: 1.5,   meleeBonus: 1.5,   cavalryBonus: -1.5 },
    magicBonus:    { meleeBonus: 2.0,    rangedBonus: -1.5, thrownBonus: -1.5, cavalryBonus: -1.5 },
    cavalryBonus:  { rangedBonus: 2.0,   thrownBonus: 1.5,  magicBonus: 1.5,   meleeBonus: -2.0 }
};

export const INVENTORY_CATEGORIES = ["consumibles", "armas", "armaduras", "permanentes", "utilidades", "monturas", "bardas"];

// Compañeros (se puede mover después a companions.js)
export const companions = {
  // ... (por ahora déjalo vacío o copia solo una parte, luego lo movemos)
};

export default {
  ADMIN_USER_ID,
  TRIVIA_LIMIT,
  // ... puedes agregar más
};
