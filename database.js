// ==========================================
// database.js
// ==========================================

import { MongoClient } from "mongodb";

const client = new MongoClient(process.env.MONGODB_URI);

let db;

export async function connectDB() {
  if (!db) {
    await client.connect();
    db = client.db("alteru");
    console.log("✅ MongoDB conectado");
  }
  return db;
}

export async function addPoints(userId, amount) {
  const database = await connectDB();
  await database.collection("puntos").updateOne(
    { userId },
    { $inc: { points: amount } },
    { upsert: true }
  );
}

export async function spendPoints(userId, amount) {
  const database = await connectDB();
  await database.collection("puntos").updateOne(
    { userId },
    { $inc: { points: -amount } },
    { upsert: true }
  );
}

export async function addXP(userId, amount) {
  const database = await connectDB();
  await database.collection("puntos").updateOne(
    { userId },
    { $inc: { xp: amount } },
    { upsert: true }
  );
}

export function calculateLevel(xp = 0) {
  return Math.floor(xp / 1000) + 1;
}

export async function getPoints(userId) {
  const database = await connectDB();
  const user = await database.collection("puntos").findOne({ userId });
  return user?.points || 0;
}

export async function getRanking() {
  const database = await connectDB();
  return await database.collection("puntos")
    .find()
    .sort({ points: -1 })
    .limit(10)
    .toArray();
}

export async function getProfile(userId) {
  const database = await connectDB();
  const user = await database.collection("puntos").findOne({ userId });
  return user || {
    userId,
    points: 0,
    xp: 0,
    race: "",
    class: "",
    salud: 100,
    correctas: 0,
    incorrectas: 0,
    rachaActual: 0,
    mejorRacha: 0,
    hiredCompanions: [],
    companions: [],
    activeCompanions: [],
    affinity: {}
  };
}

export async function addCorrectAnswer(userId, points) {
  const database = await connectDB();
  const user = await database.collection("puntos").findOne({ userId });

  const currentRacha = (user?.rachaActual || 0) + 1;
  const mejorRacha = Math.max(currentRacha, user?.mejorRacha || 0);

  await database.collection("puntos").updateOne(
    { userId },
    {
      $inc: { points, correctas: 1 },
      $set: { rachaActual: currentRacha, mejorRacha }
    },
    { upsert: true }
  );
}

export async function addWrongAnswer(userId) {
  const database = await connectDB();
  await database.collection("puntos").updateOne(
    { userId },
    {
      $inc: { incorrectas: 1 },
      $set: { rachaActual: 0 }
    },
    { upsert: true }
  );
}

export async function updateTravelerData(userId, data) {
  const database = await connectDB();
  await database.collection("puntos").updateOne(
    { userId },
    { $set: data },
    { upsert: true }
  );
}

export async function addAffinity(userId, companion, amount) {
  const database = await connectDB();
  await database.collection("puntos").updateOne(
    { userId },
    {
      $inc: {
        [`affinity.${companion}`]: amount
      }
    },
    { upsert: true }
  );
}

export async function hireCompanion(userId, companionId) {
  const database = await connectDB();
  await database.collection("puntos").updateOne(
    { userId },
    {
      $addToSet: {
        hiredCompanions: companionId,
        companions: companionId
      }
    },
    { upsert: true }
  );
}

// ================================
// CUOTAS PERSISTENTES BASE DE DATOS
// ================================

export async function getQuotaState(userId, kind, windowMs) {
  const database = await connectDB();
  const user = await database.collection("puntos").findOne({ userId });

  const attemptsKey = `${kind}Attempts`;
  const resetKey = `${kind}ResetAt`;

  const now = Date.now();
  let attempts = user?.[attemptsKey] || 0;
  let resetAt = user?.[resetKey] || 0;

  if (!resetAt || now >= resetAt) {
    attempts = 0;
    resetAt = now + windowMs;

    await database.collection("puntos").updateOne(
      { userId },
      {
        $set: {
          [attemptsKey]: 0,
          [resetKey]: resetAt
        }
      },
      { upsert: true }
    );
  }

  return { attempts, resetAt };
}

export async function setQuotaState(userId, kind, attempts, resetAt) {
  const database = await connectDB();

  const attemptsKey = `${kind}Attempts`;
  const resetKey = `${kind}ResetAt`;

  await database.collection("puntos").updateOne(
    { userId },
    {
      $set: {
        [attemptsKey]: attempts,
        [resetKey]: resetAt
      }
    },
    { upsert: true }
  );
}

export async function resetQuotaState(userId, kind, windowMs) {
  const now = Date.now();
  await setQuotaState(userId, kind, 0, now + windowMs);
}

// ================================
// ESTADO DE EVENTOS PROGRAMADOS
// ================================

export async function getEventState(key) {
  const database = await connectDB();
  const state = await database.collection("bot_state").findOne({ key });
  return state?.value || null;
}

export async function setEventState(key, value) {
  const database = await connectDB();
  await database.collection("bot_state").updateOne(
    { key },
    {
      $set: {
        value,
        updatedAt: new Date()
      }
    },
    { upsert: true }
  );
}

export async function clearEventState(key) {
  const database = await connectDB();
  await database.collection("bot_state").deleteOne({ key });
}

export async function getMerchantState() {
  return await getEventState("merchant");
}

export async function setMerchantState(value) {
  return await setEventState("merchant", value);
}

export async function clearMerchantState() {
  return await clearEventState("merchant");
}

export async function getTablonState() {
  return await getEventState("tablon");
}

export async function setTablonState(value) {
  return await setEventState("tablon", value);
}

export async function clearTablonState() {
  return await clearEventState("tablon");
}

const MARKET_MIN_MULTIPLIER = 0.25; // -75%
const MARKET_MAX_MULTIPLIER = 1.75;  // +75%

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function randomStep() {
  return (Math.random() * 0.12) + 0.03; // 3% a 15% por ajuste
}

function getMarketKey(catalogName, itemId) {
  return `${catalogName}:${itemId}`;
}

export async function getMarketSnapshot(catalogName) {
  const database = await connectDB();
  const docs = await database.collection("market_prices").find({ catalogName }).toArray();

  return Object.fromEntries(
    docs.map(doc => [doc.itemId, doc.currentPrice])
  );
}

export async function rerollMarketPrices(catalogName, items = []) {
  const database = await connectDB();
  const col = database.collection("market_prices");
  const now = new Date();

  for (const item of items) {
    if (!item?.id) continue;

    const key = getMarketKey(catalogName, item.id);
    const doc = await col.findOne({ _id: key });

    const basePrice = Number(item.precioBase || item.precio || 0);
    const oldMultiplier = Number(doc?.multiplier || 1);
    const lastDirection = Number(doc?.lastDirection || 0);

    let direction;
    if (lastDirection !== 0 && Math.random() < 0.62) {
      direction = lastDirection;
    } else {
      direction = Math.random() < 0.5 ? -1 : 1;
    }

    const nextMultiplier = clamp(
      oldMultiplier + (direction * randomStep()),
      MARKET_MIN_MULTIPLIER,
      MARKET_MAX_MULTIPLIER
    );

    const currentPrice = Math.max(1, Math.round(basePrice * nextMultiplier));

    await col.updateOne(
      { _id: key },
      {
        $set: {
          catalogName,
          itemId: item.id,
          basePrice,
          currentPrice,
          multiplier: nextMultiplier,
          lastDirection: direction,
          updatedAt: now
        }
      },
      { upsert: true }
    );
  }
}

export async function getDynamicPrice(catalogName, item) {
  const database = await connectDB();
  const key = getMarketKey(catalogName, item.id);
  const doc = await database.collection("market_prices").findOne({ _id: key });

  if (doc?.currentPrice) return doc.currentPrice;

  return Number(item.precioBase || item.precio || 0);
                           
}
