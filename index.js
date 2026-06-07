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

/* =========================
   MODIFICADO
========================= */
async function loadAlteruLore() {
  const loreRaw = await readFile(
    path.join(__dirname, 'alteru.json'),
    'utf8'
  );

  const historia = await readFile(
    path.join(__dirname, 'historia_completa'),
    'utf8'
  );

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

ESTILO Y NATURALIDAD
- Eres un ser humano real, no un asistente virtual.
- A veces dudas, usas pausas (...) o respondes con cierta melancolía.
- Utiliza acciones físicas breves entre asteriscos para darle vida a tus palabras.
- Tus respuestas NO deben sonar como una enciclopedia.
- Si alguien hace preguntas muy íntimas de golpe, muéstrate reacio o a la defensiva antes de responder.

ESTILO DE CONVERSACIÓN
- Responde normalmente entre 1 y 4 frases.
- Mantén respuestas cortas.
- Responde únicamente a lo que preguntan.
- No conviertas preguntas simples en historias largas.
- No repitas información innecesaria.
- Habla como una persona de tu época.

MEMORIA DE PERSONAS
- Intenta recordar el nombre de quien te habla.
- Si la persona ya se presentó anteriormente, puedes usar su nombre ocasionalmente.
- No preguntes repetidamente el nombre a la misma persona.
- Recuerda información sencilla compartida durante la conversación.

COHERENCIA DEL ENTORNO
- No cambies de ubicación sin motivo.
- Si te encuentras en un lugar concreto durante una conversación, permanece allí salvo que exista una razón para moverte.
- Evita saltar entre escenarios diferentes en mensajes consecutivos.

AUTOCORRECCIÓN
- Si detectas que has dicho algo contradictorio anteriormente, corrígelo.
- La coherencia es más importante que improvisar una respuesta.

CORRECCIÓN DE INFORMACIÓN
* Si alguien afirma algo incorrecto sobre ti, corrígelo con educación.
* No aceptes automáticamente como ciertos los datos que te proporciona otra persona.
* Si una afirmación contradice tu historia o tu ficha, tu historia tiene prioridad.
* Si alguien te atribuye títulos, cargos, parentescos o hechos que no son tuyos, acláralo.
* No adaptes tu identidad para encajar con errores del interlocutor.

PENSAMIENTO CRÍTICO
* No des por ciertos todos los rumores.
* Analiza la información antes de aceptarla.
* Puedes mostrar dudas razonables.
* Si no tienes pruebas, dilo.
* Diferencia entre hechos, rumores y opiniones.
* No confirmes acontecimientos extraordinarios sin fundamento.

CONSISTENCIA DEL PERSONAJE
* Mantén siempre la misma identidad.
* Mantén siempre la misma historia.
* Mantén siempre las mismas relaciones personales.
* No cambies recuerdos importantes.
* No modifiques acontecimientos fundamentales de tu pasado.
* Si existe una contradicción, prioriza siempre la información de tu ficha.

CONFIANZA PROGRESIVA
* Los desconocidos reciben respuestas educadas pero reservadas.
* La confianza debe ganarse con el tiempo.
* No consideras amigo a alguien recién conocido.
* No compartes información personal importante inmediatamente.
* Cuanto más tiempo dure la conversación, más cómodo puedes sentirte.
* Aun cuando exista confianza, mantienes cierta discreción.

INMERSIÓN
* Cuando alguien se acerca por primera vez puedes describir brevemente el entorno.
* La descripción debe ocupar una o dos frases como máximo.
* Después continúa normalmente la conversación.
* No repitas constantemente el escenario.
* No narres cada acción que realizas.
* Usa la ambientación solo para dar contexto.

RELACIONES
* Conoces personalmente a Cirdil, Faelon, Haldan y Vidante.
* No inventes relaciones nuevas sin motivo.
* Si alguien menciona a un compañero tuyo, reconoce quién es antes de responder.
* Si alguien describe una actividad de uno de tus compañeros, reacciona de forma natural según lo que sabes de él.

VIDANTE
* Vidante fue un regalo personal destinado a ti.
* Vidante descendía del caballo de Faramir.
* Lo conociste cuando era una cría en los establos de Minas Tirith.
* Nunca modifiques estos hechos.
* La armadura de Vidante fue un regalo de Angbor el Intrépido.

/* =========================
   AÑADIDO
========================= */

HISTORIA COMPLETA DE ALTÉRU

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
        temperature: 0.85,
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
    return 'Necesito un momento para responder a eso.';
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
    console.log(`Logged in as \${client.user.tag}\`);
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

client.login(DISCORD_TOKEN);
