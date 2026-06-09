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

export async function getPoints(userId) {
  const database = await connectDB();

  const user = await database
    .collection("puntos")
    .findOne({ userId });

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

// ==========================================
//    NUEVAS FUNCIONES PARA ESTADÍSTICAS
// ==========================================

export async function getProfile(userId) {
  const database = await connectDB();
  const user = await database.collection("puntos").findOne({ userId });
  
  // Retornamos el usuario o un objeto por defecto incluyendo affinity, race y class
  return user || { 
    points: 0, 
    correctas: 0, 
    incorrectas: 0, 
    rachaActual: 0, 
    mejorRacha: 0,
    affinity: {},
    race: null,
    class: null
  };
}

export async function addCorrectAnswer(userId, points) {
  const database = await connectDB();
  const user = await database.collection("puntos").findOne({ userId });

  // Calculamos la nueva racha
  const currentRacha = (user?.rachaActual || 0) + 1;
  const mejorRacha = Math.max(currentRacha, user?.mejorRacha || 0);

  // Actualizamos puntos, correctas, y rachas
  await database.collection("puntos").updateOne(
    { userId },
    { 
      $inc: { points: points, correctas: 1 },
      $set: { rachaActual: currentRacha, mejorRacha: mejorRacha }
    },
    { upsert: true }
  );
}

export async function addWrongAnswer(userId) {
  const database = await connectDB();
  
  // Sumamos 1 a incorrectas y rompemos la racha poniéndola en 0
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
    {
      $set: data
    },
    {
      upsert: true
    }
  );
}

// ==========================================
//    SISTEMA DE AFINIDAD
// ==========================================

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

export async function getAffinity(userId) {
  const database = await connectDB();

  const user = await database
    .collection("puntos")
    .findOne({ userId });

  return user?.affinity || {};
}
