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
  return await database
    .collection("puntos")
    .find({})
    .sort({ points: -1 })
    .limit(10)
    .toArray();
}

export async function getProfile(userId) {
  const database = await connectDB();
  const user = await database.collection("puntos").findOne({ userId });

  return user || {
    points: 0,
    xp: 0,
    salud: 100,
    nivel: 1,
    correctas: 0,
    incorrectas: 0,
    rachaActual: 0,
    mejorRacha: 0,
    affinity: {},
    hiredCompanions: [],
    activeCompanions: [],
    companions: []
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

export async function getCompanions(userId) {
  const database = await connectDB();
  const profile = await database.collection("puntos").findOne({ userId });
  return profile?.hiredCompanions || profile?.companions || [];
}
