import { MongoClient } from "mongodb";

async function main() {
  const c = new MongoClient(process.env.MONGODB_CONNECTION_STRING || "mongodb://localhost:27017");
  await c.connect();
  const db = c.db("pidrax");
  const runs = await db.collection("kb2_runs").find({}).sort({ started_at: 1 }).toArray();

  for (const r of runs) {
    let title = r.title;
    if (!title) {
      if (r.status === "completed" && r.current_pass === "pass2") title = "Full Pipeline";
      else if (r.status === "failed" && r.error) title = `Failed: ${r.error.slice(0, 60)}`;
      else title = "Pipeline Run";
    }
    await db.collection("kb2_runs").updateOne({ run_id: r.run_id }, { $set: { title } });
    console.log(`${r.run_id.slice(0, 8)} ${r.status} → ${title}`);
  }

  await c.close();
  console.log("Done.");
}

main().catch(console.error);
