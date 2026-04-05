import "dotenv/config";
import { MongoClient } from "mongodb";
import { buildDefaultConfigData } from "../src/application/lib/kb2/config-defaults";
import type { CompanyConfig, ConfigVersion } from "../src/entities/models/kb2-company-config";

const companySlug = process.argv[2];
const forceFlag = process.argv.includes("--force");
if (!companySlug) {
  console.error("Usage: npx tsx scripts/seed-company-config-defaults.ts <company_slug> [--force]");
  process.exit(1);
}

async function main() {
  const uri = process.env.MONGODB_CONNECTION_STRING || "mongodb://localhost:27017";
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db("pidrax");
  const collection = db.collection("kb2_company_config");

  const configData = buildDefaultConfigData();
  const now = new Date().toISOString();
  const v1: ConfigVersion = { version: 1, type: "default", locked: true, created_at: now, data: configData };
  const v2: ConfigVersion = { version: 2, type: "custom", locked: false, created_at: now, changed_by: "seed-script", change_summary: "Seeded from defaults", data: { ...configData } };

  const existing = await collection.findOne({ company_slug: companySlug });
  if (existing && !forceFlag) {
    console.log(`Config already exists for "${companySlug}". Use --force to replace it.`);
  } else {
    if (existing) {
      await collection.deleteOne({ company_slug: companySlug });
      console.log(`Deleted existing config for "${companySlug}".`);
    }
    const doc: CompanyConfig = { company_slug: companySlug, active_version: 2, versions: [v1, v2] };
    await collection.insertOne(doc as any);
    console.log(`Seeded config for "${companySlug}" (version 1 = default locked, version 2 = editable copy)`);
  }

  await client.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
