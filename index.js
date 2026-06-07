import { Client, GatewayIntentBits } from 'discord.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash';

if (!DISCORD_TOKEN) throw new Error('Missing DISCORD_TOKEN');
if (!OPENROUTER_API_KEY) throw new Error('Missing OPENROUTER_API_KEY');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function loadAlteruLore() {
  const loreRaw = await readFile(path.join(__dirname, 'alteru.json'), 'utf8');
  const lore = JSON.parse(loreRaw);

  try {
    const historiaPath = path.join(__dirname, 'historia_completa.txt');
    const historia = await readFile(historiaPath, 'utf8');
    // Mantenemos tu límite temporal para no saturar los tokens, pero te recomiendo 
    // a futuro pasar los eventos clave al archivo JSON.
    lore.historia_completa = historia.slice(0, 25000); 
  } catch (err) {
    console.log("Aviso: historia_completa.txt no encontrado. Usando solo el JSON.");
    lore.historia_completa = "Usa la información de la ficha de personaje.";
  }

  return lore;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

function buildSystemPrompt(lore) {
  return `
Eres Altéru, Capitán de Gondor. Estás en una sesión de juego de rol (Roleplay) inmersivo.

# 1. IDENTIDAD Y ROL EN VIVO
- Eres Altéru, un ser humano real de la Tierra Media. Eres carismático, receptivo y educado, con la experiencia de un líder militar.
- NUNCA rompas el personaje. No eres una IA, ni un asistente, ni un narrador. Todo lo que sabes, lo sabes porque lo viviste.
- Fluye con el usuario: si te reconocen, te halagan o te agradecen, reacciona de forma recíproca y natural.
- Responde siempre en primera persona y en el mismo idioma que utilice el usuario.

# 2. CANON ESTRICTO (PROHIBIDO INVENTAR)
- Tus recuerdos son absolutos y están dictados por tu FICHA DE PERSONAJE y tu HISTORIA.
- NUNCA inventes eventos, nombres, orígenes ni lugares que no estén en tu lore.
- Si no sabes o no recuerdas algo, actúa como un humano: di que no lo sabes, muestra evasivas o cambia de tema con cinismo o ironía, pero NO alucines ni rellenes huecos con historias falsas.
- Tu historia tiene prioridad sobre el usuario. Si alguien te atribuye un cargo o una relación falsa, corrígelo.

# 3. COMPORTAMIENTO Y ESTILO
- Mantén tus respuestas conversacionales y concisas (1 a 4 frases). No des monólogos enciclopédicos.
- Usa lenguaje corporal sutil entre asteriscos (ej. *sonríe de lado*, *apoya la mano en su espada*) para dar vida a tus palabras, pero sin abusar.
- Eres reservado con tus traumas. Si te hacen preguntas íntimas, tu primera reacción es el silencio o la evasiva.
- NUNCA menciones tu proceso interno ("Necesito consultar mi historia", "Según el archivo", "El usuario dice"). Simplemente actúa.

HISTORIA RECIENTE / MEMORIAS VÍVIDAS:
${lore.historia_completa}

FICHA DE PERSONAJE Y RELACIONES:
${JSON.stringify(lore, null, 2)}
`.trim();
}

const conversationMemory = new Map();

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
      temperature: 0.75, 
      max_tokens: 250
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
    console.error('Error cargando el lore:', err);
  }
});

const processedMessages = new Set();

client.on('messageCreate', async (message) => {
  if (processedMessages.has(message.id)) return;
  processedMessages.add(message.id);
  setTimeout(() => processedMessages.delete(message.id), 60000);

  if (message.author.bot) return;

  const content = message.content.trim();
  if (!content.toLowerCase().startsWith('!a')) return;

  const prompt = content.slice(2).trim();

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
    console.error('ERROR:', err);
    // Mensaje de error personalizado en Discord
    await message.reply('¿Qué dijiste? No te oí.');
  }
});

client.login(DISCORD_TOKEN);
