/**
 * Seed all Arch2 raw input files into MongoDB.
 * Usage: npx tsx scripts/seed-kb2-input.ts
 *
 * Looks for kb2-input-{source}.json files in scripts/ and upserts them
 * into the kb2_raw_inputs collection for brewandgo2.
 */
import { readFileSync, existsSync } from "fs";
import { MongoClient } from "mongodb";

const COMPANY_SLUG = "brewandgo2";

const SOURCES = [
  { source: "confluence", file: "scripts/kb2-input-confluence.json", countField: "results" },
  { source: "jira", file: "scripts/kb2-input-jira.json", countField: "issues" },
  { source: "slack", file: "scripts/kb2-input-slack.json", countField: "messages_by_channel" },
  { source: "github", file: "scripts/kb2-input-github.json", countField: "repos" },
  { source: "customerFeedback", file: "scripts/kb2-input-customer-feedback.json", countField: "tickets" },
];

async function main() {
  const client = new MongoClient(process.env.MONGODB_CONNECTION_STRING || "mongodb://localhost:27017");
  await client.connect();
  const db = client.db("pidrax");
  const col = db.collection("kb2_raw_inputs");

  for (const { source, file, countField } of SOURCES) {
    if (!existsSync(file)) {
      console.log(`  skip ${source} — ${file} not found`);
      continue;
    }
    const raw = readFileSync(file, "utf-8");
    const data = JSON.parse(raw);
    const docCount = Array.isArray(data)
      ? data.length
      : data[countField]?.length ?? 0;

    await col.updateOne(
      { company_slug: COMPANY_SLUG, source },
      {
        $set: {
          company_slug: COMPANY_SLUG,
          source,
          data,
          doc_count: docCount,
          updated_at: new Date().toISOString(),
        },
        $setOnInsert: { created_at: new Date().toISOString() },
      },
      { upsert: true },
    );
    console.log(`  ✓ ${source}: ${docCount} items`);
  }

  await client.close();
  console.log("Done.");
}

main().catch(console.error);
