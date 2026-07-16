// ==========================================
// UTILIDADES GENERALES - Campamento de Altéru
// ==========================================

export function normalizeKey(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s+/g, "_");
}

export function normalizeText(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") 
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()¿?¡]/g, "") 
    .trim();
}

export function normalizeDifficulty(value) {
  return normalizeText(value || "normal");
}

export function formatRemainingTime(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function compactLine(text, maxWords = 40) {
  const words = String(text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  return `${words.slice(0, maxWords).join(" ")}…`;
}

export function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function chunkDiscordText(text, limit = 1900) {
  const chunks = [];
  const blocks = String(text).split("\n\n");
  let current = "";

  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    if (block.length <= limit) {
      current = block;
    } else {
      let start = 0;
      while (start < block.length) {
        chunks.push(block.slice(start, start + limit));
        start += limit;
      }
      current = "";
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export async function replyLong(message, text) {
  const chunks = chunkDiscordText(text, 1900);
  if (!chunks.length) return message.reply("—");

  const first = await message.reply(chunks[0]);
  for (const chunk of chunks.slice(1)) {
    await message.channel.send(chunk);
  }
  return first;
}

export function formatPrice(value) {
  return `${Number(value || 0)} pts`;
}

export function getDangerText(peligro) {
  if (peligro <= 2) return "Bajo";
  if (peligro <= 4) return "Moderado";
  if (peligro <= 6) return "Alto";
  return "Extremo";
}

export function getCompanionIcon(id) {
  switch (normalizeKey(id)) {
    case "cirdil":
    case "andaer": return "🛡️";
    case "duinor": return "⚔️";
    case "alteru":
    case "nieriel": return "🎖️";
    case "montaraces": return "🏹";
    case "faelon": return "🌿";
    default: return "•";
  }
    }
