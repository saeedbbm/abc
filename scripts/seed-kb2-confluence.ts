/**
 * Quick script to seed Arch2 confluence input from a JSON file.
 * Usage: npx tsx scripts/seed-kb2-confluence.ts
 */
import { readFileSync } from "fs";
import { MongoClient } from "mongodb";

async function main() {
  const filePath = process.argv[2] || "scripts/kb2-input-confluence.json";
  const raw = readFileSync(filePath, "utf-8");
  const data = JSON.parse(raw);

  const client = new MongoClient(process.env.MONGODB_CONNECTION_STRING || "mongodb://localhost:27017");
  await client.connect();
  const db = client.db("pidrax");

  const companySlug = "brewandgo2";
  const source = "confluence";
  const docCount = data.results?.length ?? 0;

  await db.collection("kb2_raw_inputs").updateOne(
    { company_slug: companySlug, source },
    {
      $set: {
        company_slug: companySlug,
        source,
        data,
        doc_count: docCount,
        updated_at: new Date().toISOString(),
      },
      $setOnInsert: { created_at: new Date().toISOString() },
    },
    { upsert: true },
  );

  console.log(`Stored ${docCount} confluence pages for ${companySlug}`);
  await client.close();
}

main().catch(console.error);
