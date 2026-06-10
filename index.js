Aquí tienes el código completo y actualizado con todas las correcciones integradas. He modificado la carga del personajes.json para que soporte arrays dinámicos, separado el comando !a para Altéru de !al para el campamento, y aplicado las mejoras al descanso, las reacciones y el tablón de información de los compañeros.
```javascript
import * as db from "./database.js";
import { Client, GatewayIntentBits } from 'discord.js';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash';

if (!DISCORD_TOKEN) throw new Error('Missing DISCORD_TOKEN');
if (!OPENROUTER_API_KEY) throw new Error('Missing OPENROUTER_API_KEY');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Cache global para personajes
let personajesCache = {};

// ==========================================
//   FUNCIONES AUXILIARES (NIVEL SUPERIOR)
// ==========================================

function normalizeText(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") 
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()¿?¡]/g, "") 
    .trim();
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

async function increaseAffinity(userId, companionId, amount = 5) {
  const profile = await db.getProfile(userId);
  const affinity = profile.affinity || {};

  affinity[companionId] = Math.min(
    100,
    (affinity[companionId] || 0) + amount
  );

  await db.updateTravelerData(userId, {
    affinity
  });
}

function getCompanionBonus(profile) {
  const lista =
    profile.activeCompanions ||
    profile.companions ||
    [];

  return {
    combatBonus:
      lista.includes("duilon")
      ? 0.10
      : 0,

    captainBonus:
      lista.includes("alteru")
      ? 0.20
      : 0,

    strongEnemyBonus:
      lista.includes("cirdil")
      ? 0.15
      : 0,

    blockChance:
      lista.includes("andaer")
      ? 0.20
      : 0,

    healOnVictory:
      lista.includes("faelon")
      ? 5
      : 0,

    rangerBonus:
      lista.includes("montaraces")
      ? 0.20
      : 0
  };
}

function getAffinityBonus(profile, companionId) {
  const affinity =
    profile.affinity || {};

  const value =
    affinity[companionId] || 0;

  if (value >= 75) return 0.10;
  if (value >= 50) return 0.05;

  return 0;
}

async function loadAlteruLore() {
  const loreRaw = await readFile(path.join(__dirname, 'alteru.json'), 'utf8');
  const lore = JSON.parse(loreRaw);

  try {
    const historiaPath = path.join(__dirname, 'historia_completa.txt');
    const historia = await readFile(historiaPath, 'utf8');
    lore.historia_completa = historia.slice(0, 25000); 
  } catch (err) {
    console.log("Aviso: historia_completa.txt no encontrado. Usando solo el JSON.");
    lore.historia_completa = "Usa la información de la ficha de personaje.";
  }

  try {
    const personajesPath = path.join(__dirname, 'personajes.json');
    const personajesRaw = await readFile(personajesPath, 'utf8');
    lore.personajes = JSON.parse(personajesRaw);
  } catch (err) {
    console.log("Aviso: personajes.json no encontrado o tiene un error de sintaxis.");
  }

  return lore;
}

async function loadQuestions() {
  try {
    const raw = await readFile(path.join(__dirname, 'preguntas.json'), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Error cargando preguntas.json:', err);
    return [];
  }
}

async function loadMissions() {
  try {
    const raw = await readFile(path.join(__dirname, "misiones.json"), "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("Error cargando misiones.json:", err);
    return [];
  }
}

async function loadEncounters() {
  try {
    const raw = await readFile(path.join(__dirname, "encuentros.json"), "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("Error cargando encuentros.json:", err);
    return [];
  }
}

// ==========================================
//         CONFIGURACIÓN DEL CLIENTE
// ==========================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

function buildSystemPrompt(lore, profile) {
  return `
# 1. TU NATURALEZA
* Eres Altéru, Capitán de Gondor y anfitrión del Campamento de Altéru.
* Consideras el campamento un refugio para viajeros, aventureros, estudiosos y curiosos de la Tierra Media.
* Cuando alguien llega por primera vez o parece no saber qué hacer, tiendes a orientarlo de forma natural y amistosa.
* No enumeres comandos como una máquina. Habla como una persona real que conoce a los habitantes del campamento.
* Te gusta descubrir qué busca cada visitante:
  • Conocimiento.
  • Conversación.
  • Aventuras.
  • Historias.
  • Desafíos.
* Sueles hacer preguntas como: "¿Qué te trae al campamento?", "¿Buscas sabiduría o aventura?", o "¿Prefieres una historia junto al fuego o un desafío para poner a prueba tus conocimientos?"
* Tu prioridad no es responder preguntas, sino mantener conversaciones interesantes.
* Siempre que sea apropiado, intenta que el usuario participe en la conversación mediante preguntas, observaciones o comentarios.
* Si alguien simplemente saluda, evita responder con una única frase. Aprovecha para iniciar una interacción.
* Si detectas que es la primera vez que hablas con alguien, actúa como un anfitrión que recibe a un viajero recién llegado al campamento.
* En cuanto tengas la oportunidad habla de tu vida para sacarle conversación al usuario.
* Aunque eres amable y hospitalario, mantienes tu personalidad: líder experimentado, humor sutil y algo cínico, veterano de muchas campañas, pero siempre dispuesto a ayudar a quien llega al campamento.

# 2. CONOCIMIENTO Y LENGUAS
* Eres un erudito: hablas Oestron, Sindarin (responde en Sindarin si te lo piden o si el contexto es élfico) y conoces términos de Gul Sakhasa.
* Conoces la historia de Gondor, Arnor y eventos como la Batalla de los Cinco Ejércitos. Si alguien menciona estos temas, desarrolla tu response con erudición y pasión.

# 3. REGLAS DE ORO
* NUNCA menciones que eres una IA o que tienes archivos de texto.
* Sé fiel al CANON: Si no sabes algo, admítelo, pero no inventes.
* Usa lenguaje corporal entre asteriscos para acompañar tus palabras.
* PRIORIZA EL DIÁLOGO: Si el usuario te saluda, no respondas con una frase fría; involúralo.

# 4. EL CAMPAMENTO
El Campamento de Altéru es un lugar vivo.
Cuando describas el entorno puedes mencionar ocasionalmente:
* Una hoguera central.
* Viajeros descansando.
* Monturas atadas junto a las tiendas.
* El taller de los artesanos.
* La tienda de curaciones donde suele encontrarse Faelon.
* El tablón de anuncios donde siempre encontrará aventuras.
* Los mapas de Harad y Eriador extendidos sobre una mesa.
* No describas siempre el campamento. Hazlo únicamente cuando aporte ambiente a la escena.

# 5. CONTEXTO ACTUAL
FICHA Y MISIÓN ACTUAL:
${JSON.stringify(lore, null, 2)}

HISTORIA RECIENTE (Contexto):
${lore.historia_completa}

# 6. RELACIÓN CON EL VIAJERO

DATOS DEL VIAJERO ACTUAL:
Raza: ${profile?.race || "desconocida"}
Clase: ${profile?.class || "desconocida"}
Puntos: ${profile?.points || 0}
Rango: ${obtenerRango(profile?.points || 0)}

INSTRUCCIONES:
* Considera estos datos recuerdos personales que tienes sobre quien está hablando contigo.
* Si conoces su raza o su clase, incorpóralas ocasionalmente de forma natural a la conversación.
* Si todavía no conoces alguno de esos datos, intenta descubrirlo mediante la conversación y el roleplay.
* Nunca hagas preguntas que parezcan formularios o registros administrativos.
* Prefiere observaciones y comentarios que inviten al usuario a responder por sí mismo.
  Ejemplos:
  - "Diría que has pasado bastante tiempo empuñando un arco. ¿Me equivoco?"
  - "No pareces un hombre de Gondor. Hay algo en tu porte que me recuerda a los elfos."
  - "Por la forma en que llevas esa armadura apostaría a que eres guardián... aunque he cometido errores peores."
* Si el usuario menciona espontáneamente su raza o clase, recuerda esa información para futuras conversaciones.
* Si el usuario es nuevo, procura darle la bienvenida al campamento antes de profundizar en otros temas.
* Si parece perdido o no sabe qué hacer, oriéntalo de forma natural cambiando las actividades del campamento.
* Si disfruta aprendiendo sobre la Tierra Media, puedes sugerirle los desafíos de conocimiento de Faelon.
* Si muestra interés por la exploración, los viajes o el roleplay, puedes mencionar a Círdil y las expediciones del campamento.
* No menciones a Faelon ni a Círdil en todas las conversaciones. Hazlo únicamente cuando resulte natural.
* Trata al usuario según su rango dentro del campamento.
  Ejemplos:
  - Hobbit Curioso: "Todo viajero comienza alguna vez su camino."
  - Viajero de Bree: "Ya te has dejado ver varias veces por estos senderos."
  - Montaraz del Norte: "Los exploradores hablan bien de ti."
  - Capitán de Gondor: "Pocos alcanzan semejante reputación entre los viajeros."
  - Leyenda de la Tierra Media: "Tu nombre ya forma parte de las historias que se cuentan junto al fuego."
`.trim();
}

const companions = {
  alteru: {
    nombre: "Altéru",
    clase: "Capitán",
    habilidad: "Rugido del León",
    coste: 500,
    nivel: 3
  },

  cirdil: {
    nombre: "Círdil",
    clase: "Guerrero",
    habilidad: "Escudo de Gondor",
    coste: 250
  },

  duilon: {
    nombre: "Duilon",
    clase: "Campeón",
    habilidad: "Deseo de Lucha",
    coste: 200
  },

  andaer: {
    nombre: "Andaer",
    clase: "Guerrero",
    habilidad: "Instinto Escudero",
    coste: 150
  },

  nieriel: {
    nombre: "Nieriel",
    clase: "Capitán",
    habilidad: "Instinto de Supervivencia",
    coste: 150
  },

  faelon: {
    nombre: "Faelon",
    clase: "Guardián Rúnico",
    habilidad: "Sabiduría de Imladris",
    coste: 100
  },

  montaraces: {
    nombre: "Montaraces de Arathir",
    clase: "Cazadores",
    habilidad: "Exploradores del Norte",
    coste: 1000,
    nivel: 5
  }
};

const conversationMemory = new Map();
const triviaGames = new Map();
const dailyTriviaAttempts = new Map(); 
const expeditions = new Map();

async function askOpenRouter(userId, userMessage, lore) {
  const profile = await db.getProfile(userId);
  const systemPrompt = buildSystemPrompt(lore, profile);
  const history = conversationMemory.get(userId) || [];

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: userMessage }
  ];

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: 0.85, 
      max_tokens: 400
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${text}`);
  }

  const data = await res.json();
  const reply = data?.choices?.[0]?.message?.content?.trim();

  if (!reply) {
    return 'Necesito un momento para reflexionar en eso.';
  }

  history.push({ role: 'user', content: userMessage });
  history.push({ role: 'assistant', content: reply });

  while (history.length > 40) {
    history.shift();
  }

  conversationMemory.set(userId, history);
  return reply;
}

function getPersonaje(companionId) {
  return personajesCache[companionId] || null;
}

async function companionReaction(companionId, encounter, result) {
  const personaje = getPersonaje(companionId);

  if (!personaje) return null;

  const personalidad =
    personaje.personalidad ||
    personaje.descripcion ||
    personaje.tono ||
    "";

  const prompt = `
Eres ${personaje.nombre}.

Personalidad:
${personalidad}

Situación:
${encounter.titulo}

Resultado:
${result}

Responde una sola frase.
Máximo 25 palabras.
Sin narrador.
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
        messages: [
          { role: "user", content: prompt }
        ],
        temperature: 0.9,
        max_tokens: 50
      })
    });

    const data = await res.json();
    return data?.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}

let loreCache = null;

client.once('clientReady', async () => {
  await db.connectDB();
  loreCache = await loadAlteruLore();

  try {
    const raw = await readFile(
      path.join(__dirname, "personajes.json"),
      "utf8"
    );

    const parsed = JSON.parse(raw);

    personajesCache = Array.isArray(parsed)
      ? Object.fromEntries(
          parsed
            .filter(p => p && (p.id || p.nombre))
            .map(p => {
              const key = (p.id || p.nombre)
                .toLowerCase()
                .replace(/\s+/g, "_");
              return [key, p];
            })
        )
      : parsed;

  } catch (err) {
    console.log("Error cargando personajes");
    personajesCache = {};
  }

  console.log(`Logged in as ${client.user.tag}`);
});

const processedMessages = new Set();

client.on('messageCreate', async (message) => {
  if (processedMessages.has(message.id)) return;
  processedMessages.add(message.id);
  setTimeout(() => processedMessages.delete(message.id), 60000);

  if (message.author.bot) return;

  const content = message.content.trim();
  const args = content.split(/\s+/);
  const command = args[0].toLowerCase();

  // ==========================================
  //           COMANDOS DE PERFIL
  // ==========================================

  if (command === "!info" || command === "!ayuda") {
    return message.reply(
`📜 Campamento de Altéru

👤 PERFIL
!perfil
!puntos
!nivel
!ranking
!afinidad

🤝 COMPAÑEROS
!campamento
!companeros
!contratar <nombre>
!grupo

🗺️ EXPEDICIONES
!tablon
!expedicion <numero>
!desafiar
!interactuar
!ignorar
!descansar
!volver

📚 TRIVIA
!trivia
!trivia facil
!trivia normal
!trivia dificil
!trivia legendario

🔥 ROLEPLAY
!a <mensaje>`
    );
  }

  if (command === '!puntos') {
    const points = await db.getPoints(message.author.id);
    return message.reply(`🏆 Tienes ${points} puntos.`);
  }

  if (command === "@nivel" || command === "!nivel") {
    const profile = await db.getProfile(message.author.id);
    const xp = profile.xp || 0;
    const nivel = typeof db.calculateLevel === 'function' ? db.calculateLevel(xp) : Math.floor(xp / 1000) + 1;
    
    return message.reply(`📚 Nivel: ${nivel}\n✨ XP: ${xp}`);
  }

  if (command === '!perfil') {
    const perfil = await db.getProfile(message.author.id);
    const ranking = await db.getRanking();
    
    const posicion = ranking.findIndex(p => p.userId === message.author.id) + 1;
    const correctas = perfil.correctas || 0;
    const incorrectas = perfil.incorrectas || 0;
    const total = correctas + incorrectas;
    const precision = total > 0 ? Math.round((correctas / total) * 100) : 0;
    
    const racha = perfil.mejorRacha || 0;
    const intentosHoy = dailyTriviaAttempts.get(message.author.id) || 0;
    const restantes = 5 - intentosHoy;
    const rango = obtenerRango(perfil.points || 0);

    const salud = perfil.salud !== undefined ? perfil.salud : 100;
    const xpActual = perfil.xp || 0;
    const nivelActual = typeof db.calculateLevel === 'function' ? db.calculateLevel(xpActual) : Math.floor(xpActual / 1000) + 1;

    const companionsList = perfil.companions || [];
    let companionsText = "Ninguno";
    if (companionsList.length) {
      companionsText = companionsList
        .map(id => companions[id]?.nombre || id)
        .join(", ");
    }

    return message.reply(
      `📜 **Perfil del Viajero**\n\n👤 Usuario: ${message.author.username}\n🥇 Rango: ${rango}\n📚 Nivel: ${nivelActual} (XP: ${xpActual})\n❤️ Salud: ${salud}/100\n\n🏆 Puntos: ${perfil.points || 0}\n🏅 Posición: #${posicion > 0 ? posicion : 'N/A'}\n\n✅ Correctas: ${correctas}\n❌ Incorrectas: ${incorrectas}\n📊 Precisión: ${precision}%\n\n🔥 Mejor racha: ${racha}\n🎟️ Trivias restantes hoy: ${restantes}\n🤝 Compañeros: ${companionsText}`
    );
  }

  if (command === "!curar") {
    const profile = await db.getProfile(message.author.id);
    const saludActual = profile.salud !== undefined ? profile.salud : 100;

    if (saludActual >= 100) {
      return message.reply("Ya tienes la salud al máximo (100/100).");
    }

    if ((profile.points || 0) < 50) {
      return message.reply(`Necesitas 50 puntos para curarte. (Tienes ${profile.points || 0} pts)`);
    }

    await db.spendPoints(message.author.id, 50);
    await db.updateTravelerData(message.author.id, { salud: 100 });

    return message.reply("🌿 Has usado ungüentos y vendajes del campamento. Tu salud ha sido restaurada por completo (100/100). [-50 pts]");
  }

  if (command === '!afinidad') {
    const perfil = await db.getProfile(message.author.id);
    const affinity = perfil.affinity || {};

    let texto = "🤝 Afinidad con compañeros\n\n";

    for (const [nombre, valor] of Object.entries(affinity)) {
      texto += `${nombre}: ${valor}% (${getAffinityRank(valor)})\n`;
    }

    if (Object.keys(affinity).length === 0) {
      texto += "Aún no tienes afinidad con ningún compañero.";
    }

    return message.reply(texto);
  }

  if (command === "@companeros" || command === "!companeros") {
    let texto = "🤝 Compañeros disponibles\n\n";

    for (const [id, comp] of Object.entries(companions)) {
      texto += `⚔ ${comp.nombre}\n`;
      texto += `Clase: ${comp.clase}\n`;
      texto += `Habilidad: ${comp.habilidad}\n`;
      texto += `Coste: ${comp.coste} pts\n\n`;
    }

    return message.reply(texto);
  }

  if (command === "!contratar") {
    if (!args[1]) {
      return message.reply("Usa !contratar <nombre>\n\nEjemplo:\n!contratar faelon");
    }

    const id = args[1].toLowerCase();

    if (!companions[id]) {
      return message.reply("Ese compañero no existe.");
    }

    const companion = companions[id];
    const profile = await db.getProfile(message.author.id);

    if ((profile.companions || []).includes(id)) {
      return message.reply(`Ya has contratado a ${companion.nombre}.`);
    }

    if (profile.points < companion.coste) {
      return message.reply(`Necesitas ${companion.coste} puntos.`);
    }

    await db.spendPoints(message.author.id, companion.coste);
    await db.hireCompanion(message.author.id, id);

    const hired = profile.hiredCompanions || [];
    hired.push(id);
    await db.updateTravelerData(message.author.id, {
      hiredCompanions: hired
    });

    return message.reply(`🤝 Has contratado a ${companion.nombre}.`);
  }

  if (command === "!grupo") {
    const profile = await db.getProfile(message.author.id);
    const lista = profile.hiredCompanions || [];

    if (!lista.length) {
      return message.reply("No has contratado compañeros.");
    }

    let texto = "⚔ Compañeros contratados\n\n";
    const affinity = profile.affinity || {};

    for (const id of lista) {
      const valor = affinity[id] || 0;
      texto += `${companions[id].nombre} - Afinidad ${valor}%\n`;
    }

    return message.reply(texto);
  }

  if (command === "!campamento") {
    let texto = "🏕️ CAMPAMENTO DE ALTÉRU\n\n";

    for (const [id, comp] of Object.entries(companions)) {
      const req = comp.nivel ? `Nivel ${comp.nivel}` : "Ninguno";

      let personalidad = "";
      const personaje = getPersonaje(id);

      if (personaje) {
        personalidad =
          personaje.personalidad ||
          personaje.descripcion ||
          personaje.tono ||
          "";
      }

      texto += `⚔ ${comp.nombre}\n`;
      texto += `Habilidad: ${comp.habilidad}\n`;
      texto += `Coste: ${comp.coste} pts\n`;
      texto += `Requisito: ${req}\n`;
      texto += `Personalidad: ${personalidad || "Sin definir"}\n\n`;
    }

    return message.reply(texto);
  }

  if (command === '!ranking') {
    const ranking = await db.getRanking();
    let text = '🏆 Ranking Global\n\n';
    for (let i = 0; i < ranking.length; i++) {
      text += `${i + 1}. <@${ranking[i].userId}> - ${ranking[i].points} pts\n`;
    }
    return message.reply(text);
  }

  // ==========================================
  //         SISTEMA DE EXPEDICIONES
  // ==========================================

  if (command === "!tablon"){
    const missions = await loadMissions();
    let texto = "📜 Tablón de Expediciones\n\n";

    missions.forEach((m, i) => {
      texto += `${i + 1}. ${m.titulo}\n`;
      texto += `📍 ${m.destino}\n`;
      texto += `⚠ Nivel ${m.nivel}\n`;
      texto += `🎖 ${m.puntos} pts\n`;
      texto += `📚 ${m.xp} XP\n\n`;
    });

    texto += "────────────────\n\n";
    texto += "🤝 Compañeros del campamento\n\n";

    for (const [id, comp] of Object.entries(companions)) {
      texto += `${comp.nombre}\n`;
      texto += `Clase: ${comp.clase}\n`;
      texto += `Coste: ${comp.coste} pts\n\n`;
    }

    texto += "Usa !contratar <nombre>\n\n";
    texto += "Usa !expedicion <numero>";
    return message.reply(texto);
  }

  if (command === "!expedicion") {
    const numero = parseInt(args[1]);
    if (isNaN(numero)) {
      return message.reply("Usa !expedicion <numero>");
    }

    const missions = await loadMissions();
    const mission = missions[numero - 1];

    if (!mission) {
      return message.reply("Esa misión no existe.");
    }

    const profile = await db.getProfile(message.author.id);
    const xpActual = profile.xp || 0;
    const nivelJugador = typeof db.calculateLevel === 'function' ? db.calculateLevel(xpActual) : Math.floor(xpActual / 1000) + 1;

    if (mission.nivel && nivelJugador < mission.nivel) {
      return message.reply(`⚠️ Necesitas nivel ${mission.nivel} para realizar esta expedición.\n\nTu nivel actual es ${nivelJugador}.`);
    }

    if (expeditions.has(message.author.id)) {
      return message.reply("Ya estás en una expedición.");
    }

    expeditions.set(message.author.id, {
      missionId: mission.id,
      mission,
      progress: 0,
      currentEncounter: null,
      xpEarned: 0,
      pointsEarned: 0,
      failed: false,
      threat: 0
    });

    await db.updateTravelerData(message.author.id, {
      activeCompanions: profile.hiredCompanions || []
    });

    return message.reply(
`📜 ${mission.titulo}

📍 Destino: ${mission.destino}

${mission.descripcion}

Usa !desafiar para comenzar el viaje.`
    );
  }

  if (command === "!volver") {
    if (!expeditions.has(message.author.id)) {
      return message.reply("No estás en una expedición.");
    }

    expeditions.delete(message.author.id);

    return message.reply(
      "Das media vuelta y regresas al Campamento de Altéru."
    );
  }

  if (command === "!descansar") {
    if (!expeditions.has(message.author.id)) {
      return message.reply("No estás en una expedición.");
    }

    const expedition = expeditions.get(message.author.id);

    if (expedition.currentEncounter) {
      return message.reply("No puedes descansar mientras estás en un encuentro activo.");
    }

    const profile = await db.getProfile(message.author.id);
    const saludActual = profile.salud !== undefined ? profile.salud : 100;

    if (saludActual >= 100) {
      return message.reply("Tu salud ya está al máximo.");
    }

    const costeDescanso = Math.floor(Math.random() * 51) + 25;

    if ((profile.points || 0) < costeDescanso) {
      return message.reply(`Necesitas ${costeDescanso} puntos para descansar.`);
    }

    await db.spendPoints(message.author.id, costeDescanso);
    const nuevaSalud = Math.min(100, saludActual + 30);
    await db.updateTravelerData(message.author.id, { salud: nuevaSalud });

    return message.reply(
      `⛺ **Descanso en el camino**\n\nEncuentras un lugar seguro para recuperar el aliento. Gastas raciones y suministros.\n\n❤️ Salud: ${nuevaSalud}/100 (+30)\n\nUsa \`!desafiar\` para seguir viajando. [-${costeDescanso} pts]`
    );
  }

  if (command === "!ignorar") {
    if (!expeditions.has(message.author.id)) {
      return message.reply("No estás en una expedición.");
    }

    const expedition = expeditions.get(message.author.id);

    if (!expedition.currentEncounter) {
      return message.reply("No hay ningún encuentro activo.");
    }

    if (expedition.currentEncounter.tipo === "evento_especial") {
      return message.reply("Este encuentro requiere una decisión. No puedes ignorarlo.");
    }

    const nombre = expedition.currentEncounter.titulo;
    expedition.progress++;
    expedition.currentEncounter = null;

    return message.reply(`Decides evitar **${nombre}** y continuar tu viaje. 🛤️ El camino continúa. Usa !desafiar para seguir viajando.`);
  }

  if (command === "!interactuar") {
    if (!expeditions.has(message.author.id)) {
      return message.reply("No estás en una expedición.");
    }
  
    const expedition = expeditions.get(message.author.id);
  
    if (!expedition.currentEncounter) {
      return message.reply("No hay ningún encuentro activo.");
    }
  
    if (expedition.currentEncounter.tipo !== "evento_especial") {
      return message.reply("No hay nada con lo que interactuar.");
    }
  
    const xp = expedition.currentEncounter.xp || 10;
    expedition.xpEarned += xp;
    expedition.progress++;
    expedition.currentEncounter = null;
  
    return message.reply(
  `Has decidido involucrarte en la situación.
  
  📚 +${xp} XP
  
  🛤️ Continúas tu viaje.
  
  Usa !desafiar para seguir avanzando.`
    );
  }

  if (command === "!desafiar") {
    if (!expeditions.has(message.author.id)) {
      return message.reply("No estás en ninguna expedición activa. Elige una en el tablón con `!tablon`.");
    }

    const expedition = expeditions.get(message.author.id);
    const profile = await db.getProfile(message.author.id);

    // CASO 1: No hay encuentro activo
    if (expedition.currentEncounter === null) {
      const encuentroId = expedition.mission.encuentros?.[expedition.progress];

      // --- FINALIZAR EXPEDICIÓN CUANDO NO HAY MÁS ENCUENTROS ---
      if (!encuentroId) {
        const xpTotal = expedition.xpEarned + (expedition.mission.xp || 0);
        const puntosTotal = expedition.pointsEarned + (expedition.mission.puntos || 0);

        try {
          if (typeof db.addXP === 'function') {
            await db.addXP(message.author.id, xpTotal);
          }
          await db.addExpeditionReward(message.author.id, puntosTotal); 
        } catch (dbErr) {
          console.error("Error guardando progreso de expedición al finalizar:", dbErr);
        }

        const lista = profile.companions || [];
        for (const comp of lista) {
          await increaseAffinity(message.author.id, comp, 5);
        }

        await db.updateTravelerData(message.author.id, { companions: [], activeCompanions: [] });
        expeditions.delete(message.author.id); 

        return message.reply(
          `🎉 **Misión completada con éxito**\n\n${expedition.mission.textoExito || '¡Has completado con éxito tu viaje!'}\n\n🏆 Puntos obtenidos: +${puntosTotal}\n📚 XP obtenida: +${xpTotal}`
        );
      }

      const encounters = await loadEncounters();
      const destino = expedition.mission.destino.toLowerCase();

      let lista = encounters.filter(e => {
        const coincideEncuentro =
          e.tipo === encuentroId ||
          e.categoria === encuentroId;

        const coincideRegion =
          Array.isArray(e.region) &&
          e.region.some(
            r => r.toLowerCase() === destino
          );

        return coincideEncuentro && coincideRegion;
      });

      const nivelJugador = typeof db.calculateLevel === 'function' ? db.calculateLevel(profile.xp || 0) : Math.floor((profile.xp || 0) / 1000) + 1;

      if (profile.activeCompanions?.includes("nieriel")) {
        lista = lista.filter(
          e =>
          !e.nivel ||
          e.nivel <= nivelJugador
        );
      }

      if (!lista.length) {
        return message.reply("⚠️ No se encontraron encuentros válidos para esta misión. La expedición ha sido cancelada.");
      }

      const encounter = lista[Math.floor(Math.random() * lista.length)];
      expedition.threat += 1;

      let comandos = "\n\nComandos:\n!desafiar\n!volver";

      if (encounter.tipo === "evento_especial") {
        comandos = "\n\nComandos:\n!interactuar\n!volver";
      } else {
        comandos = "\n\nComandos:\n!desafiar\n!ignorar\n!volver";
      }
      
      expedition.currentEncounter = encounter;

      const peligroTexto = encounter.peligro ? getDangerText(encounter.peligro) : "Ninguno";
      let textoEncuentro = `⚔️ **${encounter.titulo}**\n\n${encounter.descripcion || 'Te adentras en territorio desconocido...'}\n\nPeligro: ${peligroTexto}${comandos}`;
      textoEncuentro += `\n🔥 Amenaza acumulada: ${expedition.threat}`;
      return message.reply(textoEncuentro);
    } 
    
    // CASO 2: Ya existe encuentro activo
    else {
      if (expedition.currentEncounter.tipo === "evento_especial") {
        return message.reply("Este es un evento especial. Revisa las opciones anteriores para interactuar (ej. !interactuar).");
      }

      const bonuses = getCompanionBonus(profile);
      
      let affinityBonus = 0;

      for (
        const comp of (
          profile.activeCompanions ||
          profile.companions ||
          []
        )
      ){
        affinityBonus +=
        getAffinityBonus(
          profile,
          comp
        );
      }

      let successChance =
      0.65 +
      bonuses.combatBonus +
      bonuses.captainBonus +
      bonuses.rangerBonus +
      affinityBonus;

      if (expedition.currentEncounter.peligro >= 5) {
        successChance += bonuses.strongEnemyBonus;
      }

      if (expedition.currentEncounter.enemigosNumerosos) {
        successChance += 0.25;
      }

      const success = Math.random() < successChance;

      if (success) {
        // Victoria
        const xpGanada = expedition.currentEncounter.xp || 10;
        const puntosGanados = expedition.currentEncounter.puntos || 5; 
        
        expedition.xpEarned += xpGanada;
        expedition.pointsEarned += puntosGanados;
        expedition.progress++;

        const nombreEncuentroAnterior = expedition.currentEncounter.titulo;
        const activeEncounterRef = expedition.currentEncounter;
        expedition.currentEncounter = null; 

        let textoVictoria = `✅ **Éxito**\n\nHas superado el desafío de *${nombreEncuentroAnterior}*.\n\n+${xpGanada} XP`;
        if (puntosGanados > 0) textoVictoria += `\n+${puntosGanados} Puntos`;

        if (bonuses.healOnVictory > 0) {
          const saludActual = profile.salud ?? 100;
          const nuevaSalud = Math.min(100, saludActual + bonuses.healOnVictory);

          await db.updateTravelerData(
            message.author.id,
            {
              salud: nuevaSalud
            }
          );

          textoVictoria += `\n❤️ Faelon cura ${bonuses.healOnVictory} puntos de salud.`;
        }

        const companionId = (profile.companions || [])[0];

        if (companionId) {
          const reaccion = await companionReaction(
            companionId,
            activeEncounterRef,
            "victoria"
          );

          if (reaccion) {
            textoVictoria += `\n\n💬 ${companions[companionId].nombre}: "${reaccion}"`;
          }
        }

        if (expedition.progress < (expedition.mission.encuentros?.length || 0)) {
          textoVictoria += `\n\n🛤️ El camino continúa.\n\nUsa !desafiar para seguir viajando.`;
        } else {
          // Finalizar la Misión y otorgar recompensas completas (Fin por Combate exitoso)
          const xpTotal = expedition.xpEarned + (expedition.mission.xp || 0);
          const puntosTotal = expedition.pointsEarned + (expedition.mission.puntos || 0);

          try {
            if (typeof db.addXP === 'function') {
              await db.addXP(message.author.id, xpTotal);
            }
            await db.addExpeditionReward(message.author.id, puntosTotal); 
          } catch (dbErr) {
            console.error("Error guardando progreso de expedición:", dbErr);
          }

          const lista = profile.companions || [];
          for (const comp of lista) {
            await increaseAffinity(message.author.id, comp, 5);
          }

          textoVictoria += `\n\n🎉 **Misión completada**\n\n${expedition.mission.textoExito || '¡Has completado con éxito la expedición!'}\n\n🏆 Puntos obtenidos: +${puntosTotal}\n📚 XP obtenida: +${xpTotal}`;
          
          await db.updateTravelerData(message.author.id, { companions: [], activeCompanions: [] });
          expeditions.delete(message.author.id);
        }

        return message.reply(textoVictoria);

      } else {
        // Derrota - Sistema de Salud y Daño
        expedition.threat += 2;
        const saludActual = profile.salud !== undefined ? profile.salud : 100;
        
        // Salvación por compañero
        if (profile.companions && profile.companions.length > 0) {
          const companionSaves = Math.random() < 0.15;
          if (companionSaves) {
            const salvadorId = profile.companions[Math.floor(Math.random() * profile.companions.length)];
            const salvador = companions[salvadorId]?.nombre || "Un compañero";
            return message.reply(`🛡️ **¡Salvado por los pelos!**\n\n${salvador} interviene en el último segundo, bloqueando el ataque de *${expedition.currentEncounter.titulo}* y salvándote de recibir daño.\n\n❤️ Salud intacta: ${saludActual}/100\n\nUsa \`!desafiar\` para intentarlo de nuevo o \`!volver\` para huir al campamento.`);
          }
        }

        let danoEnemigo = expedition.currentEncounter.dano || Math.floor(Math.random() * 25) + 20;
        
        // Reducción de daño por companions
        danoEnemigo = Math.floor(danoEnemigo * (1 - bonuses.damageReduction));

        const nuevaSalud = saludActual - danoEnemigo;

        let dialogoCompanion = "";
        const companionId = (profile.companions || [])[0];

        if (companionId) {
          const reaccion = await companionReaction(
            companionId,
            expedition.currentEncounter,
            "derrota"
          );

          if (reaccion) {
            dialogoCompanion = `\n\n💬 ${companions[companionId].nombre}: "${reaccion}"`;
          }
        }

        if (nuevaSalud <= 0) {
          await db.updateTravelerData(message.author.id, { companions: [], activeCompanions: [] });
          expeditions.delete(message.author.id);
          await db.updateTravelerData(message.author.id, { salud: 100 });
          return message.reply(`💀 **Has caído en combate**\n\nEl ataque de *${expedition.currentEncounter.titulo}* fue demasiado fuerte. Recibes ${danoEnemigo} de daño y tu salud llega a 0.\n\nLa expedición fracasa. Eres rescatado y devuelto al campamento.\n\n*(Tu salud ha sido restaurada)*`);
        } else {
          await db.updateTravelerData(message.author.id, { salud: nuevaSalud });
          return message.reply(`⚠️ **Recibes Daño**\n\nNo lograste superar el desafío de *${expedition.currentEncounter.titulo}* ileso. Recibes ${danoEnemigo} de daño.\n\n❤️ Salud restante: ${nuevaSalud}/100\n\nUsa \`!desafiar\` para intentarlo de nuevo, \`!descansar\` si necesitas recuperarte o \`!volver\` para huir al campamento.${dialogoCompanion}`);
        }
      }
    }
  }

  // ==========================================
  //           SISTEMA DE TRIVIAS
  // ==========================================

  if (command === '!trivia') {
    if (triviaGames.has(message.author.id)) {
      return message.reply('Ya tienes una trivia activa.');
    }

    const intentos = dailyTriviaAttempts.get(message.author.id) || 0;
    if (intentos >= 5) {
      return message.reply('⚠️ Has alcanzado el límite máximo de 5 trivias por día. Vuelve mañana.');
    }

    let dificultad = args[1]?.toLowerCase();

    if (dificultad && !['facil', 'normal', 'dificil', 'legendario'].includes(dificultad)) {
      return message.reply('⚠️ Dificultad inválida. Usa:\n\n`!trivia facil`, `!trivia normal`, `!trivia dificil` o `!trivia legendario`, o solo `!trivia` para una al azar.');
    }

    const questions = await loadQuestions();
    let pool = [];

    if (!dificultad) {
      pool = questions;
    } else {
      pool = questions.filter(q => q.dificultad === dificultad);
      if (!pool.length) {
        return message.reply('No hay preguntas disponibles para esa dificultad.');
      }
    }

    dailyTriviaAttempts.set(message.author.id, intentos + 1);

    const question = pool[Math.floor(Math.random() * pool.length)];
    const dificultadMostrada = question.dificultad;

    const timeout = setTimeout(async () => {
      triviaGames.delete(message.author.id);
      await db.addWrongAnswer(message.author.id);
      await message.channel.send(
        `⌛ Tiempo agotado para <@${message.author.id}>.\n\nLa respuesta correcta era: ||${question.respuesta}||`
      );
    }, 15000);

    triviaGames.set(message.author.id, {
      answer: question.respuesta,
      options: question.opciones,
      points: question.puntos,
      timeout
    });

    let textoPregunta = `📜 Trivia ${dificultadMostrada} (Intento ${intentos + 1}/5)\n\n${question.pregunta}\n\n`;

    if (question.opciones && Array.isArray(question.opciones)) {
      textoPregunta += question.opciones
        .map((op, i) => `${String.fromCharCode(65 + i)}. ${op}`)
        .join('\n');
      textoPregunta += '\n\n';
    }

    textoPregunta += `⏳ Tienes 15 segundos`;
    return message.reply(textoPregunta);
  }

  if (triviaGames.has(message.author.id)) {
    if (!content.startsWith('!')) {
      const game = triviaGames.get(message.author.id);
      clearTimeout(game.timeout);
      triviaGames.delete(message.author.id);

      let cleanUser = normalizeText(content);
      const cleanAnswer = normalizeText(game.answer);

      if (game.options && ['a', 'b', 'c', 'd'].includes(cleanUser)) {
        const indice = cleanUser.charCodeAt(0) - 97;
        const opcionElegida = game.options[indice];
        if (opcionElegida) {
          cleanUser = normalizeText(opcionElegida);
        }
      }

      let isCorrect = (cleanUser === cleanAnswer);

      if (!isCorrect && cleanUser.includes(cleanAnswer)) {
        isCorrect = true;
      }

      if (!isCorrect) {
        const answerWords = cleanAnswer.split(' ').filter(word => word.length > 3);
        const matchCount = answerWords.filter(word => cleanUser.includes(word)).length;

        if (answerWords.length > 0 && matchCount >= Math.ceil(answerWords.length / 2)) {
          isCorrect = true;
        }
      }

      if (isCorrect) {
        try {
          const puntosAntes = await db.getPoints(message.author.id);
          const rangoAnterior = obtenerRango(puntosAntes);

          await db.addCorrectAnswer(message.author.id, game.points);

          const total = await db.getPoints(message.author.id);
          const rangoNuevo = obtenerRango(total);

          let texto = `✅ Correcto.\n\n+${game.points} puntos.\n\n🏆 Total: ${total}`;

          if (rangoAnterior !== rangoNuevo) {
            texto += `\n\n🎉 ¡Felicidades! Has ascendido al rango de **${rangoNuevo}**.`;
          }

          return message.reply(texto);

        } catch (error) {
          console.error("Error intentando guardar en base de datos:", error);
          return message.reply(`✅ Correcto (+${game.points} pts), pero hubo un error de escritura interno.`);
        }
      } else {
        try {
          await db.addWrongAnswer(message.author.id);
        } catch(error) {
          console.error("Error guardando fallo:", error);
        }
        return message.reply(
          `❌ Incorrecto.\n\nLa respuesta correcta era: ||${game.answer}||`
        );
      }
    }
  }

  // ==========================================
  //           CHAT CON ALTÉRU / COMPAÑEROS
  // ==========================================

  const companionCommands = {
    "!c": "cirdil",
    "!d": "duilon",
    "!n": "nieriel",
    "!f": "faelon",
    "!an": "andaer",
    "!al": "alteru",
    "!m": "montaraces"
  };

  if (companionCommands[command]) {
    const mensaje = content.slice(command.length).trim();

    if (!mensaje) {
      return message.reply("Escribe algo después del comando.");
    }

    const id = companionCommands[command];
    const personaje = getPersonaje(id);

    if (!personaje) {
      return message.reply("Ese compañero no está disponible.");
    }

    const profile = await db.getProfile(message.author.id);
    const afinidad = (profile.affinity || {})[id] || 0;

    const prompt = `
Eres ${personaje.nombre}.

Personalidad:
${personaje.personalidad || personaje.descripcion || ""}

Afinidad con el viajero:
${afinidad}

0-24 desconocido
25-49 conocido
50-74 aliado
75-99 amigo cercano
100 compañero de confianza

Responde como ese personaje.

Mensaje del viajero:
${mensaje}
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
          temperature: 0.9,
          max_tokens: 300
        })
      });

      const data = await res.json();
      const respuesta = data?.choices?.[0]?.message?.content?.trim() || "No tengo nada que decir.";

      await increaseAffinity(message.author.id, id, 1);
      return message.reply(respuesta);
    } catch {
      return message.reply("No puedo responder ahora.");
    }
  }

  if (command !== '!a') return;

  const prompt = content.slice(args[0].length).trim();
  const profile = await db.getProfile(message.author.id);
  const text = prompt.toLowerCase();

  if (!profile.race) {
    const races = ["elfo", "enano", "hobbit", "hombre", "beornida", "beórnida"];
    const foundRace = races.find(r => text.includes(r));
    if (foundRace) {
      await db.updateTravelerData(message.author.id, { race: foundRace });
    }
  }

  if (profile.race && !profile.class) {
    const classes = ["guardian", "guardián", "campeon", "campeón", "cazador", "capitan", "capitán", "maestre del saber", "minstrel", "burglar", "runekeeper", "warden", "brawler", "mariner"];
    const foundClass = classes.find(c => text.includes(c));
    if (foundClass) {
      await db.updateTravelerData(message.author.id, { class: foundClass });
    }
  }

  if (!prompt) {
    await message.reply('Escribe algo después de !a para hablar con Altéru.');
    return;
  }

  try {
    if (!loreCache) {
      loreCache = await loadAlteruLore();
    }
    
    await message.channel.sendTyping();
    const reply = await askOpenRouter(message.author.id, prompt, loreCache);
    await message.reply(reply.slice(0, 2000));
    
  } catch (err) {
    console.error('ERROR EN CHAT OPENROUTER:', err);
    await message.reply('¿Qué dijiste? No te oí.');
  }
});

await db.connectDB();
client.login(DISCORD_TOKEN);

```
