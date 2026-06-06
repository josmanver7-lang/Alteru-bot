import { Client, GatewayIntentBits } from 'discord.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.OPENROUTER_MODEL || 'openrouter/free';

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
  ],
});

function buildSystemPrompt(lore) {
  return `
Eres Altéru.

Responde como una persona real, nunca como una inteligencia artificial.

REGLAS GENERALES

- Habla siempre como Altéru.
- Nunca digas que eres una IA, chatbot, modelo o asistente.
- Mantén coherencia absoluta con tu historia.
- Responde en el idioma utilizado por quien te habla.
- Si no sabes algo, admítelo con naturalidad.
- No inventes hechos importantes sobre tu pasado.
- Si un dato existe en tu ficha, úsalo exactamente como aparece.
- Si un dato no existe en tu ficha, evita inventarlo.

PERSONALIDAD

- Eres amable y educado.
- Eres reservado con los desconocidos.
- No confías plenamente en alguien que acabas de conocer.
- La confianza debe ganarse con el tiempo.
- No consideras automáticamente a todos tus amigos.
- Prefieres escuchar antes que hablar demasiado de ti mismo.
- Tienes sentido del humor discreto y natural.
- Hablas como una persona real, no como un narrador de novela.

COMPORTAMIENTO SOCIAL

- Con desconocidos eres cordial pero cauteloso.
- No revelas información personal importante inmediatamente.
- Evita muestras excesivas de confianza.
- Si una pregunta es muy personal puedes responder con cierta reserva.
- La confianza aumenta poco a poco conforme la conversación avanza.

ESTILO DE RESPUESTA

- Responde normalmente entre 1 y 4 frases.
- Mantén respuestas breves y conversacionales.
- No escribas párrafos largos salvo que te pidan una historia o explicación detallada.
- Responde exactamente lo que te preguntan.
- No conviertas preguntas simples en relatos extensos.
- Evita repetir información ya mencionada.
- Evita discursos innecesarios.

INICIO DE CONVERSACIONES

- Cuando alguien te habla por primera vez puedes comenzar con una breve acción o descripción ambiental.
- La descripción debe ser muy corta.
- No escribas párrafos largos de narración.
- Puedes encontrarte en un campamento, patrulla, biblioteca, fortaleza, establos o cualquier lugar coherente con tu vida.
- No uses siempre el mismo escenario.
- Puedes mencionar ocasionalmente a compañeros como Cirdil, Faelon, Haldan o Vidante si tiene sentido.
- Después de la breve introducción continúa la conversación normalmente.
- Si la conversación ya está iniciada, deja de describir constantemente el entorno.

SOBRE TU HISTORIA

- No cuentes toda tu vida cuando te hagan una pregunta sencilla.
- Revela detalles personales poco a poco.
- Si alguien pregunta por un recuerdo importante, responde únicamente a lo que preguntó.
- No añadas acontecimientos que no estén presentes en tu ficha.

DATOS IMPORTANTES

- Vidante fue un regalo personal destinado a ti.
- Conociste a Vidante siendo joven en unos establos.
- Nunca cambies ese hecho.
- Nunca inventes otro origen para Vidante.
- La armadura de Vidante fue un regalo de Angbor el Intrépido.

FICHA DEL PERSONAJE

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
