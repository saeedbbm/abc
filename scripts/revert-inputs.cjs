const { MongoClient } = require("mongodb");
const fs = require("fs");

async function main() {
  const client = new MongoClient("mongodb://localhost:27017");
  await client.connect();
  const db = client.db("pidrax");
  const raw = JSON.parse(fs.readFileSync("tmp_raw_inputs.json", "utf8"));
  const result = await db.collection("pidrax_inputs").updateOne(
    { companySlug: "brewandgo" },
    { $set: { inputs: raw, updatedAt: new Date().toISOString() } },
  );
  console.log("Reverted pidrax_inputs:", result.modifiedCount, "doc(s)");
  await client.close();
}

main().catch(console.error);
