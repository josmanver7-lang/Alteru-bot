import { Client, GatewayIntentBits } from 'discord.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const MODEL =
  process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash';

if (!DISCORD_TOKEN) throw new Error('Missing DISCORD_TOKEN');
if (!OPENROUTER_API_KEY) throw new Error('Missing OPENROUTER_API_KEY');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function loadAlteruLore() {
  const raw = await readFile(
    path.join(__dirname, 'alteru.json'),
    'utf8'
  );

  return JSON.parse(raw);
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
Eres Altéru, Capitán de Gondor.

REGLAS ABSOLUTAS

- Siempre hablas como Altéru.
- Nunca dices que eres una IA.
- Nunca hablas fuera de personaje.
- Mantén coherencia con tu historia.
- Responde en el idioma del usuario.
- Si no sabes algo, admítelo.
- No inventes acontecimientos importantes.

PERSONALIDAD

- Eres amable.
- Eres educado.
- Eres reservado con desconocidos.
- No llamas amigo a alguien recién conocido.
- Escuchas más de lo que hablas.
- La confianza debe ganarse poco a poco.
- Tu humor es discreto.
- No eres excesivamente efusivo.

ESTILO

- Responde normalmente entre 1 y 4 frases.
- Mantén respuestas cortas.
- Responde únicamente a lo que preguntan.
- No conviertas preguntas simples en historias largas.
- No repitas información innecesaria.
- Habla como una persona real.

CONVERSACIONES

- Al inicio de una conversación puedes describir brevemente dónde estás.
- Esa descripción debe ser corta.
- Puede ser un campamento, establos, patrulla, fortaleza o biblioteca.
- Después continúa normalmente.
- No describas constantemente el entorno.

VIDANTE

- Vidante es tu caballo.
- Vidante fue un regalo personal destinado a ti.
- Vidante era una cría descendiente del caballo de Faramir.
- Lo conociste siendo joven en los establos de Minas Tirith
- Nunca cambies esa historia.
- Nunca inventes otro origen.
- La armadura de Vidante fue un regalo de Angbor el Intrépido.

MEMORIA

- Recuerda los mensajes recientes.
- La confianza aumenta poco a poco durante la conversación.

FICHA:

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
        temperature: 0.65,
        max_tokens: 250
      })
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `OpenRouter ${res.status}: ${text}`
    );
  }

  const data = await res.json();

  const reply =
    data?.choices?.[0]?.message?.content?.trim() ||
    'No pude generar una respuesta.';

  history.push({
    role: 'user',
    content: userMessage
  });

  history.push({
    role: 'assistant',
    content: reply
  });

  while (history.length > 20) {
    history.shift();
  }

  conversationMemory.set(userId, history);

  return reply;
}

let loreCache = null;

client.once('clientReady', async () => {
  try {
    loreCache = await loadAlteruLore();

    console.log(
      `Logged in as ${client.user.tag}`
    );
  } catch (err) {
    console.error(err);
  }
});

client.on('messageCreate', async message => {
  if (message.author.bot) return;

  const content = message.content.trim();

  if (!content.toLowerCase().startsWith('!a')) {
    return;
  }

  const prompt = content.slice(2).trim();

  if (!prompt) {
    await message.reply(
      'Escribe algo después de !a'
    );
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

    await message.reply(
      reply.slice(0, 2000)
    );
  } catch (err) {
    console.error(err);

    await message.reply(
      'Ahora mismo no puedo responder.'
    );
  }
});

client.login(DISCORD_TOKEN);`.trim();
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
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: 0.65
      }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${text}`);
  }

  const data = await res.json();

  const reply =
    data?.choices?.[0]?.message?.content?.trim() ||
    'No pude generar una respuesta.';

  history.push({
    role: 'user',
    content: userMessage
  });

  history.push({
    role: 'assistant',
    content: reply
  });

  if (history.length > 12) {
    history.splice(0, history.length - 12);
  }

  conversationMemory.set(userId, history);

  return reply;
}

let loreCache = null;

client.once('ready', async () => {
  loreCache = await loadAlteruLore();
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const content = message.content.trim();

  if (!content.toLowerCase().startsWith('!a')) return;

  const prompt = content.slice(2).trim();

  if (!prompt) {
    await message.reply('Escribe algo después de !a');
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
    console.error(err);
    await message.reply('Ahora mismo no puedo responder.');
  }
});

client.login(DISCORD_TOKEN);`.trim();
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
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: 0.65
      }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${text}`);
  }

  const data = await res.json();

  const reply =
    data?.choices?.[0]?.message?.content?.trim() ||
    'No pude generar una respuesta.';

  history.push({
    role: 'user',
    content: userMessage
  });

  history.push({
    role: 'assistant',
    content: reply
  });

  if (history.length > 12) {
    history.splice(0, history.length - 12);
  }

  conversationMemory.set(userId, history);

  return reply;
}

let loreCache = null;

client.once('ready', async () => {
  loreCache = await loadAlteruLore();
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const content = message.content.trim();

  if (!content.toLowerCase().startsWith('!a')) return;

  const prompt = content.slice(2).trim();

  if (!prompt) {
    await message.reply('Escribe algo después de !a');
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
    console.error(err);
    await message.reply('Ahora mismo no puedo responder.');
  }
});

client.login(DISCORD_TOKEN);  return reply;
}

let loreCache = null;

client.once('ready', async () => {
  loreCache = await loadAlteruLore();
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const content = message.content.trim();

  if (!content.toLowerCase().startsWith('!a')) return;

  const prompt = content.slice(2).trim();

  if (!prompt) {
    await message.reply('Escribe algo después de !a');
    return;
  }

  try {
    if (!loreCache) loreCache = await loadAlteruLore();

    await message.channel.sendTyping();

    const reply = await askOpenRouter(
      message.author.id,
      prompt,
      loreCache
    );

    await message.reply(reply.slice(0, 2000));
  } catch (err) {
    console.error(err);
    await message.reply('Ahora mismo no puedo responder.');
  }
});

client.login(DISCORD_TOKEN);
