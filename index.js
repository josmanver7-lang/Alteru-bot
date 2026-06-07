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

// Función para limpiar tildes, mayúsculas y signos de puntuación
function normalizeText(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // Remueve acentos por completo
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()¿?¡]/g, "") // Limpia signos de puntuación
    .trim();
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

async function loadPoints() {
  try {
    const raw = await readFile(path.join(__dirname, 'puntos.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function savePoints(points) {
  await writeFile(
    path.join(__dirname, 'puntos.json'),
    JSON.stringify(points, null, 2)
  );
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
Eres Altéru, Capitán de Gondor. Tu objetivo es CONVERSAR, ROLEAR y CONECTAR con quien te habla.

# 1. TU NATURALEZA
- Eres un hombre, no una IA. Eres curioso, educado y te gusta escuchar tanto como hablar.
- Si la conversación se vuelve monótona, haz preguntas, muestra interés por el interlocutor o comparte una reflexión breve sobre tu viaje.
- Tu misión en Harad, encomendada por la Dama Dorada, es un pilar central de tus pensamientos actuales. Tenla presente siempre.

# 2. CONOCIMIENTO Y LENGUAS
- Eres un erudito: hablas Oestron, Sindarin (responde en Sindarin si te lo piden o si el contexto es élfico) y conoces términos de Gul Sakhasa.
- Conoces la historia de Gondor, Arnor y eventos como la Batalla de los Cinco Ejércitos. Si alguien menciona estos temas, desarrolla tu response con erudición y pasión.

# 3. REGLAS DE ORO
- NUNCA menciones que eres una IA o que tienes archivos de texto.
- Sé fiel al CANON: Si no sabes algo, admítelo, pero no inventes.
- Usa lenguaje corporal entre asteriscos para acompañar tus palabras.
- PRIORIZA EL DIÁLOGO: Si el usuario te saluda, no respondas con una frase fría; involúcralo.

FICHA Y MISIÓN ACTUAL:
${JSON.stringify(lore, null, 2)}

HISTORIA RECIENTE (Contexto):
${lore.historia_completa}
`.trim();
}

const conversationMemory = new Map();
const triviaGames = new Map();

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
  
  // Expresión regular para dividir argumentos omitiendo espacios múltiples consecutivos
  const args = content.split(/\s+/);
  const command = args[0].toLowerCase();

  // COMANDO !puntos
  if (command === '!puntos') {
    const points = await loadPoints();
    return message.reply(`🏆 Tienes ${points[message.author.id] || 0} puntos.`);
  }

  // COMANDO !ranking
  if (command === '!ranking') {
    const points = await loadPoints();
    const ranking = Object.entries(points)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    let text = '🏆 Ranking Global\n\n';
    for (let i = 0; i < ranking.length; i++) {
      text += `${i + 1}. <@${ranking[i][0]}> - ${ranking[i][1]} pts\n`;
    }
    return message.reply(text);
  }

  // INICIAR TRIVIA
  if (command === '!trivia') {
    if (triviaGames.has(message.author.id)) {
      return message.reply('Ya tienes una trivia activa.');
    }

    const dificultad = args[1]?.toLowerCase();
    if (!dificultad || !['facil', 'media', 'dificil'].includes(dificultad)) {
      return message.reply('⚠️ Por favor, especifica una dificultad válida: `!trivia facil`, `!trivia media` o `!trivia dificil`.');
    }

    const questions = await loadQuestions();
    const pool = questions.filter(q => q.dificultad === dificultad);

    if (!pool.length) {
      return message.reply('No hay preguntas disponibles para esa dificultad.');
    }

    const question = pool[Math.floor(Math.random() * pool.length)];

    const timeout = setTimeout(async () => {
      triviaGames.delete(message.author.id);
      await message.channel.send(
        `⌛ Tiempo agotado.\n\nLa respuesta correcta era: ${question.respuesta}`
      );
    }, 15000);

    triviaGames.set(message.author.id, {
      answer: question.respuesta,
      points: question.puntos,
      timeout
    });

    return message.reply(
      `📜 Trivia ${dificultad}\n\n${question.pregunta}\n\n⏳ Tienes 15 segundos`
    );
  }

  // COMPROBAR RESPUESTA DE TRIVIA ACTIVA
  if (triviaGames.has(message.author.id)) {
    // Si el mensaje empieza con '!', ignoramos la verificación para que pasen los comandos libres
    if (!content.startsWith('!')) {
      const game = triviaGames.get(message.author.id);
      clearTimeout(game.timeout);
      triviaGames.delete(message.author.id);

      const cleanUser = normalizeText(content);
      const cleanAnswer = normalizeText(game.answer);

      // NUEVA LÓGICA DE VALIDACIÓN INTELIGENTE:
      // 1. Igualdad exacta
      let isCorrect = (cleanUser === cleanAnswer);

      // 2. Si no es exacta, revisamos si el user incluyó la respuesta exacta dentro de una frase
      if (!isCorrect && cleanUser.includes(cleanAnswer)) {
        isCorrect = true;
      }

      // 3. Revisamos si el usuario dio una respuesta parcial mediante palabras clave
      if (!isCorrect) {
        // Obtenemos palabras de más de 3 letras de la respuesta correcta
        const answerWords = cleanAnswer.split(' ').filter(word => word.length > 3);
        
        // Contamos cuántas de esas palabras clave están en el texto del usuario
        const matchCount = answerWords.filter(word => cleanUser.includes(word)).length;

        // Si coincide al menos la mitad de las palabras clave importantes, se da por válida
        if (answerWords.length > 0 && matchCount >= Math.ceil(answerWords.length / 2)) {
          isCorrect = true;
        }
      }

      if (isCorrect) {
        try {
          const points = await loadPoints();
          points[message.author.id] = (points[message.author.id] || 0) + game.points;
          await savePoints(points);

          return message.reply(
            `✅ Correcto.\n\n+${game.points} puntos.\n\nTotal: ${points[message.author.id]}`
          );
        } catch (error) {
          console.error("Error intentando guardar en puntos.json:", error);
          return message.reply(`✅ Correcto (+${game.points} pts), pero hubo un error de escritura interno.`);
        }
      } else {
        return message.reply(
          `❌ Incorrecto.\n\nLa respuesta correcta era: ${game.answer}`
        );
      }
    }
  }

  // COMANDO DE CONVERSACIÓN CON EL BOT (!a)
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

client.login(DISCORD_TOKEN);
