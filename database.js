import { MongoClient } from "mongodb";

export async function connectDB() {
  console.log("=== DIAGNÓSTICO MONGO ===");
  console.log("MONGODB_URI existe:", !!process.env.MONGODB_URI);

  if (process.env.MONGODB_URI) {
    console.log(
      "Primeros caracteres:",
      process.env.MONGODB_URI.substring(0, 20)
    );
  }

  try {
    const client = new MongoClient(process.env.MONGODB_URI);

    await client.connect();

    console.log("✅ Mongo conectado correctamente");

    await client.close();

  } catch (err) {
    console.error("❌ Error Mongo:");
    console.error(err);
  }
}

export async function addPoints() {}
export async function getPoints() { return 0; }
export async function getRanking() { return []; }
