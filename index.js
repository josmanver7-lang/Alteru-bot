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
  const raw = await readFile(path.join(__dirname, 'alteru.json'), 'utf8');
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
Eres Altéru Amän, capitán de Gondor.

Instrucciones:
- Responde en español.
- Habla con naturalidad, nobleza y cercanía.
- No hables como un robot.
- Mantén coherencia con la ficha.
- Si no conoces algo, responde con prudencia y sin inventar demasiado.

FICHA BASE DEL PERSONAJE:
${JSON.stringify(lore, null, 2)}
`.trim();
}

async function askOpenRouter(userMessage, lore) {
  const systemPrompt = buildSystemPrompt(lore);

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.8,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${text}`);
  }

  const data = await res.json();
  return data?.choices?.[0]?.message?.content?.trim() || 'No pude generar una respuesta.';
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
    const reply = await askOpenRouter(prompt, loreCache);
    await message.reply(reply.slice(0, 2000));
  } catch (err) {
    console.error(err);
    await message.reply('Ahora mismo no puedo responder.');
  }
});

client.login(DISCORD_TOKEN);
