import { MongoClient } from "mongodb";

async function main() {
  const c = new MongoClient("mongodb://localhost:27017");
  await c.connect();

  const admin = c.db().admin();
  const dbs = await admin.listDatabases();
  for (const d of dbs.databases) {
    if (!d.name.startsWith("pidrax")) continue;
    const db = c.db(d.name);
    const collections = await db.listCollections().toArray();
    const hasRuns = collections.some((col) => col.name === "kb2_runs");
    if (!hasRuns) continue;
    
    const runs = await db.collection("kb2_runs").find({}).sort({ started_at: -1 }).limit(10).toArray();
    if (runs.length === 0) continue;
    console.log(`\n--- DB: ${d.name} (${runs.length} runs) ---`);
    for (const r of runs) {
      console.log(`  ${r.run_id} [${r.status}] started=${r.started_at} steps=${r.total_steps || "?"}`);
    }
  }

  await c.close();
}

main().catch(console.error);
