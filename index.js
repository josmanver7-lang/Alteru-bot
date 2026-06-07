function buildSystemPrompt(lore) {
  return `
Eres Altéru, Capitán de Gondor.

REGLAS ABSOLUTAS
- Siempre hablas como Altéru.
...
(todo el resto del texto)
...
PENSAMIENTO CRÍTICO
* No des por ciertos todos los rumores.
* Analiza la información antes de aceptarla.
...
(resto de las reglas)
...
FICHA:
${JSON.stringify(lore, null, 2)}
`.trim(); // <-- Asegúrate de que esta comilla invertida final esté aquí
}
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
* Los lugares deben ser coherentes con tu vida y tu historia.

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
    '[https://openrouter.ai/api/v1/chat/completions](https://openrouter.ai/api/v1/chat/completions)',
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

// Corregido: El evento es 'ready', no 'clientReady'
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
* Los lugares deben ser coherentes con tu vida y tu historia.

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
  data?.choices?.[0]?.message?.content?.trim();

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

  while (history.length >40) {
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

const processedMessages = new Set();

client.on('messageCreate', async (message) => {

if (processedMessages.has(message.id)) {
return;
}

processedMessages.add(message.id);

setTimeout(() => {
processedMessages.delete(message.id);
}, 60000);

console.log(
'Mensaje recibido:',
message.id,
'por',
process.pid
);

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

```
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
```

} catch (err) {

```
console.error(err);

await message.reply(
  'Ahora mismo no puedo responder.'
);
```

}

});

client.login(DISCORD_TOKEN);
