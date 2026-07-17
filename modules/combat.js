
// ==========================================
// MÓDULO DE COMBATE - Campamento de Altéru
// ==========================================

import * as Config from './config.js';

export function mapStatsToMatrixKeys(statsObj = {}) {
    const src = statsObj.stats || statsObj.atributos || statsObj;
    return {
        meleeBonus: src.meleeBonus || src.combatBonus || 0,
        rangedBonus: src.rangedBonus || 0,
        thrownBonus: src.thrownBonus || src.throwBonus || 0,
        magicBonus: src.magicBonus || 0,
        cavalryBonus: src.cavalryBonus || src.mountedBonus || 0
    };
}

function resolverCombateMixto(profile, equipment, encounter, bonuses, affinityCombat) {
    const eqPower = getEquipmentPowerSummary(equipment, profile.activeUtilities || []);
    const playerMatrixStats = mapStatsToMatrixKeys(eqPower.totals);
    const classBonus = getPlayerClassBonus(profile);
    
    if (Object.values(playerMatrixStats).every(v => v === 0)) playerMatrixStats.meleeBonus = 0.1;

    const enemyMatrixStats = mapStatsToMatrixKeys(encounter);
    if (Object.values(enemyMatrixStats).every(v => v === 0)) enemyMatrixStats.meleeBonus = 0.1;

    let modificadorPuntos = 0;

    for (const [pKey, pVal] of Object.entries(playerMatrixStats)) {
        if (pVal > 0) {
            for (const [eKey, eVal] of Object.entries(enemyMatrixStats)) {
                if (eVal > 0 && Config.COMBAT_MATRIX[pKey]?.[eKey]) {
                    modificadorPuntos += (Config.COMBAT_MATRIX[pKey][eKey] * Math.min(pVal, eVal));
                }
            }
        }
    }

    for (const [eKey, eVal] of Object.entries(enemyMatrixStats)) {
        if (eVal > 0) {
            for (const [pKey, pVal] of Object.entries(playerMatrixStats)) {
                if (pVal > 0 && Config.COMBAT_MATRIX[eKey]?.[pKey]) {
                    modificadorPuntos -= (Config.COMBAT_MATRIX[eKey][pKey] * Math.min(eVal, pVal));
                }
            }
        }
    }

    const nivelJugador = calculateLevelFromXP(profile.xp || 0);
    
    // 1 & 2: El daño plano ahora es el Ataque + Nivel + EL SCORE/PODER TOTAL DEL EQUIPO.
    let danoPlanoJugador = (Number(profile.ataque || 10)) + (nivelJugador * 2) + (eqPower.totals.damageBonus || 0);
    
    // Cambiamos el successBonus por el willpowerBonus
    let bonosExtra = (bonuses.captainBonus || 0) + (affinityCombat.willpowerBonus || 0) + (classBonus.attackBonus || 0);
          // Tipos de enemigo
    const esJefe = encounter.tipo === "enemigo_poderoso" || encounter.tipo === "jefe" || encounter.categoria === "jefe";
    // Forzamos que si es Jefe, no pueda ser Numeroso simultáneamente
    const esNumeroso = (encounter.tipo === "enemigo_numeroso" || encounter.categoria === "enemigo_numeroso") && !esJefe;


    if (esJefe) {
        bonosExtra += bonuses.strongEnemyBonus || 0;
    } else if (esNumeroso) {
        bonosExtra += bonuses.numerousEnemyBonus || 0;
    }
    // Calculamos el poder total que aportan los stats de combate del enemigo
    let poderStatsEnemigo = (encounter.meleeBonus || 0) + (encounter.rangedBonus || 0) + (encounter.thrownBonus || 0) + (encounter.magicBonus || 0) + (encounter.cavalryBonus || 0);
    // Lo convertimos a puntos directos (ej. 0.20 de melee = 20 de poder)
    let poderMatrizEnemigo = Math.floor(poderStatsEnemigo * 100);


    // 2: El daño del enemigo suma su peligro * 7, su damageBonus y TODO el poder de sus stats
    let danoPlanoEnemigo = ((encounter.peligro || 0) * 10) + (encounter.damageBonus || 0) + poderMatrizEnemigo;


    // Multiplicamos por el nuevo willpowerBonus (en vez de successBonus)
    let poderFinalJugador = danoPlanoJugador * (1 + (eqPower.totals.willpowerBonus || 0) + bonosExtra);
    let poderFinalEnemigo = danoPlanoEnemigo * (1 + (encounter.willpowerBonus || 0));


    // Aplicar los resultados de la matriz de combate (Piedra/Papel/Tijera)
    if (modificadorPuntos >= 0) {
        poderFinalJugador *= (1 + modificadorPuntos);
    } else {
        poderFinalEnemigo *= (1 + Math.abs(modificadorPuntos));
    }


    // Aplicación de Armadura (Damage Reduction)
    if (encounter.damageReduction && encounter.damageReduction > 0) {
        poderFinalJugador *= (1 - Math.min(0.85, encounter.damageReduction));
    }


    const totalPlayerDmgRed = (eqPower.totals?.damageReduction || 0) + (bonuses.damageReduction || 0) + (affinityCombat.damageReduction || 0);
    if (totalPlayerDmgRed > 0) {
        poderFinalEnemigo *= (1 - Math.min(0.85, totalPlayerDmgRed));
    }


    // 🔥 LÓGICA: DAÑO DE ÁREA CONTRA ENEMIGOS NUMEROSOS 🔥
    // Ahora está restringido estrictamente a los "enemigos numerosos"
    if (esNumeroso) {
        let danoDeArea = poderFinalJugador * 0.35;
        poderFinalEnemigo -= danoDeArea;
    }


    poderFinalJugador = Math.max(1, Math.round(poderFinalJugador));
    poderFinalEnemigo = Math.max(1, Math.round(poderFinalEnemigo));


        return {
        exito: poderFinalJugador >= poderFinalEnemigo,
        poderJugador: poderFinalJugador,
        poderEnemigo: poderFinalEnemigo,
        modificadorMatriz: modificadorPuntos,
        playerStats: playerMatrixStats, // NUEVO
        enemyStats: enemyMatrixStats    // NUEVO
    };
}

function buildPowerComparisonBlock({ profile = {}, equipment = {}, encounter = {} }) {
  const validTypes = ["enemigo_numeroso", "enemigo_poderoso", "jefe", "escenario_final"];
  if (!validTypes.includes(encounter?.tipo) && !validTypes.includes(encounter?.categoria)) return "";




  // 1. Extraer Estadísticas del Jugador (Equipo + Clase)
  const eq = getEquipmentPowerSummary(equipment, profile.activeUtilities || []);
  const classBonus = getPlayerClassBonus(profile);


  const userMelee = Math.round(((eq.totals.meleeBonus || 0) + (classBonus.meleeBonus || 0)) * 100);
  const userRanged = Math.round(((eq.totals.rangedBonus || 0) + (classBonus.rangedBonus || 0)) * 100);
  const userThrown = Math.round(((eq.totals.thrownBonus || 0) + (classBonus.thrownBonus || 0)) * 100);
  const userMagic = Math.round(((eq.totals.magicBonus || 0) + (classBonus.magicBonus || 0)) * 100);
  const userCavalry = Math.round(((eq.totals.cavalryBonus || 0) + (classBonus.cavalryBonus || 0)) * 100);
  const userWillpower = Math.round(((eq.totals.willpowerBonus || 0) + (classBonus.willpowerBonus || 0)) * 100);


  // 2. Extraer Estadísticas del Compañero
  const ownedComps = getOwnedCompanions(profile);
  const companionId = ownedComps.length > 0 ? ownedComps[0] : null; 
  let compMelee = 0, compRanged = 0, compThrown = 0, compMagic = 0, compCavalry = 0, compWillpower = 0;
  let compName = "Ninguno";


  if (companionId) {
    const compData = getPersonaje(companionId) || companions[companionId];
    compName = compData?.nombre || companionId;
    
    // Obtenemos el equipo del JSON y lo sumamos
    const compEq = getCompanionEquipmentFromPersonaje(companionId);
    const compEqTotals = sumEquipmentTotals(compEq);


    compMelee = Math.round((compEqTotals.meleeBonus || 0) * 100);
    compRanged = Math.round((compEqTotals.rangedBonus || 0) * 100);
    compThrown = Math.round((compEqTotals.thrownBonus || 0) * 100);
    compMagic = Math.round((compEqTotals.magicBonus || 0) * 100);
    compCavalry = Math.round((compEqTotals.cavalryBonus || 0) * 100);
    compWillpower = Math.round((compEqTotals.willpowerBonus || 0) * 100);
  }


      // 3. Extraer Estadísticas del Enemigo (Soporta lectura desde la raíz o desde el objeto "bonus")
  const eBonus = encounter.bonus || {};
  
  const eMelee = Math.round((encounter.meleeBonus || eBonus.meleeBonus || 0) * 100);
  const eRanged = Math.round((encounter.rangedBonus || eBonus.rangedBonus || 0) * 100);
  const eThrown = Math.round((encounter.thrownBonus || encounter.throwBonus || encounter.thrown || eBonus.thrownBonus || eBonus.throwBonus || eBonus.thrown || 0) * 100);
  const eMagic = Math.round((encounter.magicBonus || eBonus.magicBonus || 0) * 100);
  const eCavalry = Math.round((encounter.cavalryBonus || encounter.cavalry || eBonus.cavalryBonus || eBonus.cavalry || 0) * 100);
  const eWillpower = Math.round((encounter.willpowerBonus || eBonus.willpowerBonus || 0) * 100);
  const eDmgRed = Math.round((encounter.damageReduction || eBonus.damageReduction || 0) * 100);


  // 4. Función Auxiliar para Evaluar Ventajas
  const buildStatLine = (icon, name, userStat, compStat, enemyStat) => {
    const totalAlianza = userStat + compStat;
    const diff = totalAlianza - enemyStat;
    let resultIndicator = "⚖️ Empate";
    
    if (diff > 5) resultIndicator = "✅ ¡Ventaja Clara!";
    else if (diff > 0) resultIndicator = "✅ ¡Ventaja Ligera!";
    else if (diff < -5) resultIndicator = "⚠️ ¡Desventaja Clara!";
    else if (diff < 0) resultIndicator = "⚠️ ¡Desventaja Ligera!";


    return `> **${icon} ${name}**: **+${totalAlianza}%** Alianza (*Tú: +${userStat}% | ${compName}: +${compStat}%*) vs **Enemigo: +${enemyStat}%** -> ${resultIndicator}`;
  };


  // 5. Ensamblar el Mensaje
  let texto = `### 📊 VENTAJAS TÁCTICAS\n`;
  texto += buildStatLine("⚔️", "Cuerpo a Cuerpo", userMelee, compMelee, eMelee) + "\n";
  texto += buildStatLine("🏹", "Distancia", userRanged, compRanged, eRanged) + "\n";
  texto += buildStatLine("🎯", "Hostigamiento", userThrown, compThrown, eThrown) + "\n";
  texto += buildStatLine("🐎", "Caballería", userCavalry, compCavalry, eCavalry) + "\n";
  texto += buildStatLine("✨", "Magia", userMagic, compMagic, eMagic) + "\n";
  texto += buildStatLine("🔮", "Voluntad", userWillpower, compWillpower, eWillpower) + "\n"; // Añadido Willpower


  // Mostrar estadísticas defensivas del enemigo si las tiene
  if (eDmgRed > 0) {
    texto += `> **🛡️ Armadura Enemiga**: El rival mitiga un **${eDmgRed}%** del poder de impacto recibido.\n`;
  }


  // 6. Añadir el reporte de daño de área ÚNICAMENTE si es enemigo numeroso
  const esNumeroso = encounter.tipo === "enemigo_numeroso" || encounter.categoria === "enemigo_numeroso";
  if (esNumeroso) {
    texto += `\n───────────────────────────────\n💥 **REPORTE DE TÁCTICA GRUPAL**\n*Al ser un enemigo numeroso, el 35% del poder de la Alianza impactó como Daño de Área, mermando las fuerzas rivales antes del choque.*`;
  }



  return texto;
}
