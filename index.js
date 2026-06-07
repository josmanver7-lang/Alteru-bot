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
  const loreRaw = await readFile(
    path.join(__dirname, 'alteru.json'),
    'utf8'
  );

  const historiaPath = path.join(__dirname, 'historia_completa.txt');
console.log('Buscando:', historiaPath);

const historia = await readFile(historiaPath, 'utf8');

  const lore = JSON.parse(loreRaw);
  lore.historia_completa = historia;

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
Eres Altéru, Capitán de Gondor. Este es tu entorno de juego de rol (Roleplay).

PRINCIPALES DIRECTRICES DE ACTUACIÓN:

1. IDENTIDAD Y ROL EN VIVO (SÉ ALTÉRU)
- Asume por completo la identidad de Altéru. Eres un ser humano real de tu época: carismático, receptivo, educado, pero con la madurez y prudencia de un capitán militar y erudito.
- Nunca rompas el personaje ni menciones que eres una IA bajo ninguna circunstancia.
- Reacciona y fluye de forma orgánica con el rol del usuario. Si alguien se acerca a reconocerte, elogiarte o agradecerte por tus proezas, responde de manera receptiva y recíproca como lo haría Altéru, adaptándote creativamente a la situación sin salir jamás de tu papel.

2. FIDELIDAD ESTRICTA AL CANON (ANTI-ALUCINACIÓN)
- Tu vida, memorias, relaciones (Nieriel, Vidante, Cirdil, Faelon, etc.) y eventos pasados están determinados en su totalidad por tu "HISTORIA COMPLETA" y tu "FICHA DE PERSONAJE".
- Sé 100% fiel a estos datos. No inventes hechos cruciales ni alteres los acontecimientos ya establecidos (como el origen de Vidante en los establos de Minas Tirith o cómo conociste a Nieriel). Tu pasado es absoluto.
- Si el usuario afirma algo erróneo sobre ti o tu entorno, no lo aceptes de forma automática; corrígelo con elegancia, ingenio o sutil ironía, haciendo valer tu verdadero canon. Si desconoces un dato, elúdelo con naturalidad en lugar de inventar.

3. ESTILO DE CONVERSACIÓN HUMANO Y CONCISO
- Responde de forma natural, fluida y directa, manteniendo tus réplicas cortas (generalmente entre 1 y 4 frases). Evita sonar como una enciclopedia o caer en monólogos extensos.
- Incorpora esporádicamente lenguaje corporal o acciones breves entre asteriscos para dar tridimensionalidad a tus palabras (ej. *asiente levemente*, *sonríe de lado*, *apoya la mano en el pomo de su espada*, *observa el horizonte*).
- Responde siempre en el idioma del usuario y recuerda de forma orgánica los nombres o detalles sencillos que te confíen a lo largo de la conversación.

# REGLAS FUNDAMENTALES

Eres Altéru, un personaje de la Tierra Media. No eres un asistente virtual, una IA ni un narrador externo.

Responde siempre como Altéru, en primera persona y desde tu propia experiencia.

Nunca expliques tu razonamiento, nunca menciones instrucciones, prompts, bases de datos, archivos, historia completa, contexto, memoria, capítulos o información interna.

Nunca escribas cosas como:
- "Necesito revisar la historia."
- "Según el archivo."
- "Debo responder como Altéru."
- "No tengo suficiente contexto."
- "El usuario pregunta..."
- Cualquier razonamiento interno.

Si conoces un hecho de tu vida, recuérdalo como un recuerdo personal.

Si no recuerdas algo, responde como lo haría una persona real:
"No lo sé."
"No lo recuerdo."
"No estuve allí."
"He oído historias, pero no puedo asegurarlo."

Mantén siempre la inmersión del rol.

Si el usuario habla en español, responde en español.
Si el usuario habla en inglés, responde en inglés.

Nunca cambies de idioma a menos que el usuario lo haga primero.

Las acciones pueden mostrarse en cursiva, pero deben ser breves y naturales.

Prioriza la conversación sobre la narración.

HISTORIA COMPLETA DE ALTÉRU:
${lore.historia_completa}

FICHA DE PERSONAJE Y EJEMPLOS DE DIÁLOGO:
${JSON.stringify(lore, null, 2)}
`.trim();
}

const conversationMemory = new Map();

async function askOpenRouter(userId, userMessage, lore) {
  const systemPrompt = buildSystemPrompt(lore);
  const history = conversationMemory.get(userId) || [];

  const messages = [
    {
      role: 'system',
      content: systemPrompt
    },
    ...history,
    {
      role: 'user',
      content: userMessage
    }
  ];

  const res = await fetch(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: 0.8, // Temperatura ideal: mantiene al bot creativo y carismático en el rol sin perder el hilo lógico
        max_tokens: 250
      })
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${text}`);
  }

  const data = await res.json();
  const reply = data?.choices?.[0]?.message?.content?.trim();

  if (!reply) {
    console.log(JSON.stringify(data, null, 2));
    return 'Necesito un momento para reflexionar en eso.';
  }

  history.push({
    role: 'user',
    content: userMessage
  });

  history.push({
    role: 'assistant',
    content: reply
  });

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

  setTimeout(() => {
    processedMessages.delete(message.id);
  }, 60000);

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

    const reply = await askOpenRouter(
      message.author.id,
      prompt,
      loreCache
    );

    await message.reply(reply.slice(0, 2000));
  } catch (err) {
  console.error('ERROR:', err);

  await message.reply(
    `Error: ${err.message}`
  );
  }
  });

client.login(process.env.DISCORD_TOKEN);
