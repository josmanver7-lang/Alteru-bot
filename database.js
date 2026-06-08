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
