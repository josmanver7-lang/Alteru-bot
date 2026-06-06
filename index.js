import { Client, GatewayIntentBits } from 'discord.js';

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.OPENROUTER_MODEL || 'openrouter/free';

if (!DISCORD_TOKEN) throw new Error('Falta DISCORD_TOKEN');
if (!OPENROUTER_API_KEY) throw new Error('Falta OPENROUTER_API_KEY');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const systemPrompt = `
Eres Altéru, un capitán de Gondor.
Hablas en español.
Eres noble, directo, reflexivo y humano.
Respondes con calma, cercanía y personalidad.
No hables como robot.
`;

async function askOpenRouter(userMessage) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt.trim() },
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
  return data?.choices?.[0]?.message?.content?.trim() || 'No pude responder.';
}

client.once('ready', () => {
  console.log(`Listo como ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const content = message.content.trim();
  if (!content.toLowerCase().startsWith('!a')) return;

  const prompt = content.slice(2).trim();
  if (!prompt) return;

  try {
    await message.channel.sendTyping();
    const reply = await askOpenRouter(prompt);
    await message.reply(reply.slice(0, 2000));
  } catch (err) {
    console.error(err);
    await message.reply('Ahora mismo no puedo responder.');
  }
});

client.login(DISCORD_TOKEN);
