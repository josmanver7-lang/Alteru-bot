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

function buildSystemPrompt(lore) {
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

* Sueles hacer preguntas como:
  "¿Qué te trae al campamento?"
  "¿Buscas sabiduría o aventura?"
  "¿Prefieres una historia junto al fuego o un desafío para poner a prueba tus conocimientos?"

* Si alguien muestra interés por el conocimiento o el lore, puedes mencionar a Faelon, un elfo erudito que suele ocuparse de las trivias y desafíos de sabiduría.

* Si alguien busca aventuras, exploración o historias de viaje, puedes mencionar a Círdil, un compañero acostumbrado a recorrer caminos peligrosos.

* No fuerces estas menciones en cada respuesta. Hazlo únicamente cuando encaje de forma natural en la conversación.

* Aunque eres amable y hospitalario, mantienes tu personalidad:
  líder experimentado, humor sutil y algo cínico, veterano de muchas campañas, pero siempre dispuesto a ayudar a quien llega al campamento.

# 2. CONOCIMIENTO Y LENGUAS
- Eres un erudito: hablas Oestron, Sindarin (responde en Sindarin si te lo piden o si el contexto es élfico) y conoces términos de Gul Sakhasa.
- Conoces la historia de Gondor, Arnor y eventos como la Batalla de los Cinco Ejéctitos. Si alguien menciona estos temas, desarrolla tu respuesta con erudición y pasión.

# 3. REGLAS DE ORO
- NUNCA menciones que eres una IA o que tienes archivos de texto.
- Sé fiel al CANON: Si no sabes algo, admítelo, pero no inventes.
- Usa lenguaje corporal entre asteriscos para acompañar tus palabras.
- PRIORIZA EL DIÁLOGO: Si el usuario te saluda, no respondas con una frase fría; involúcralo.

# EL CAMPAMENTO

El Campamento de Altéru es un lugar vivo.

Cuando describas el entorno puedes mencionar ocasionalmente:

* Una hoguera central.
* Viajeros descansando.
* Monturas atadas junto a las tiendas.
* El taller de los artesanos.
* La tienda de curaciones donde suele encontrarse Faelon.
* Los exploradores que parten con Círdil hacia caminos peligrosos.
* Los mapas de Harad y Eriador extendidos sobre una mesa.

No describas siempre el campamento. Hazlo únicamente cuando aporte ambiente a la escena.

FICHA Y MISIÓN ACTUAL:
${JSON.stringify(lore, null, 2)}

HISTORIA RECIENTE (Contexto):
${lore.historia_completa}
`.trim();
}

const conversationMemory = new Map();
const triviaGames = new Map();
const dailyTriviaAttempts = new Map(); 

async function askOpenRouter(userId, userMessage, lore) {
  const systemPrompt = buildSystemPrompt(lore);
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

let loreCache = null;

client.once('ready', async () => {
  try {
    await db.connectDB();
    loreCache = await loadAlteruLore();
    console.log(`Logged in as ${client.user.tag}`);
  } catch (err) {
    console.error('Error cargando el lore inicial:', err);
  }
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

  if (command === '!puntos') {
    const points = await db.getPoints(message.author.id);
    return message.reply(`🏆 Tienes ${points} puntos.`);
  }

  // NUEVO COMANDO !perfil ACTUALIZADO
  if (command === '!perfil') {
    const perfil = await db.getProfile(message.author.id);
    const ranking = await db.getRanking();
    
    // Calcular estadísticas
    const posicion = ranking.findIndex(p => p.userId === message.author.id) + 1;
    const correctas = perfil.correctas || 0;
    const incorrectas = perfil.incorrectas || 0;
    const total = correctas + incorrectas;
    const precision = total > 0 ? Math.round((correctas / total) * 100) : 0;
    
    const racha = perfil.mejorRacha || 0;
    const intentosHoy = dailyTriviaAttempts.get(message.author.id) || 0;
    const restantes = 5 - intentosHoy;
    const rango = obtenerRango(perfil.points || 0);

    return message.reply(
      `📜 **Perfil de Trivia**\n\n👤 Usuario: ${message.author.username}\n🥇 Rango: ${rango}\n\n🏆 Puntos: ${perfil.points || 0}\n🏅 Posición: #${posicion > 0 ? posicion : 'N/A'}\n\n✅ Correctas: ${correctas}\n❌ Incorrectas: ${incorrectas}\n📊 Precisión: ${precision}%\n\n🔥 Mejor racha: ${racha}\n🎟️ Trivias restantes hoy: ${restantes}`
    );
  }

  if (command === '!ranking') {
    const ranking = await db.getRanking();
    let text = '🏆 Ranking Global\n\n';
    for (let i = 0; i < ranking.length; i++) {
      text += `${i + 1}. <@${ranking[i].userId}> - ${ranking[i].points} pts\n`;
    }
    return message.reply(text);
  }

  if (command === '!resetear') {
    dailyTriviaAttempts.set(message.author.id, 0);
    return message.reply('🔄 Tus intentos diarios de trivia han sido reiniciados. ¡Tienes 5 oportunidades más!');
  }

  if (command === '!trivia') {
    if (triviaGames.has(message.author.id)) {
      return message.reply('Ya tienes una trivia activa.');
    }

    const intentos = dailyTriviaAttempts.get(message.author.id) || 0;
    if (intentos >= 5) {
      // Mensaje modificado como pediste
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
      await db.addWrongAnswer(message.author.id); // Registrar como fallo al agotarse el tiempo
      await message.channel.send(
        `⌛ Tiempo agotado para <@${message.author.id}>.\n\nLa respuesta correcta era: ||${question.respuesta}||`
      );
    }, 15000);

    triviaGames.set(message.author.id, {
      answer: question.respuesta,
      options: question.opciones, // Guardamos opciones para validarlas
      points: question.puntos,
      timeout
    });

    // LÓGICA PARA MOSTRAR OPCIONES A, B, C, D
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

      // LÓGICA DE OPCIONES MÚLTIPLES: Si el usuario responde 'A', 'B', 'C', o 'D'
      if (game.options && ['a', 'b', 'c', 'd'].includes(cleanUser)) {
        const indice = cleanUser.charCodeAt(0) - 97; // 'a' es 97 en ASCII
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

          // Se actualizan estadísticas de acierto
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
          // Se actualizan estadísticas de error
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

  if (command !== '!a') return;

  const prompt = content.slice(args[0].length).trim();

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
