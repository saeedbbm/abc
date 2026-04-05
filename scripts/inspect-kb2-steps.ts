import "dotenv/config";
import { MongoClient } from "mongodb";

async function main() {
  const [, , runId, ...stepArgs] = process.argv;
  if (!runId || stepArgs.length === 0) {
    throw new Error("Usage: npx tsx scripts/inspect-kb2-steps.ts <runId> <step> [step...]");
  }

  const stepNumbers = stepArgs.map((value) => Number(value)).filter((value) => Number.isFinite(value));
  process.env.PIDRAX_MULTI_TENANT ??= "true";

  const client = new MongoClient(process.env.MONGODB_CONNECTION_STRING || "mongodb://localhost:27017");
  await client.connect();
  try {
    const db = client.db("pidrax_pawfinder2");
    const docs = await db.collection("kb2_run_steps")
      .find({
        run_id: runId,
        step_number: { $in: stepNumbers },
      })
      .project({
        step_number: 1,
        step_name: 1,
        execution_id: 1,
        status: 1,
        created_at: 1,
        updated_at: 1,
        artifact: 1,
        judge_result: 1,
      })
      .sort({ step_number: 1, created_at: -1 })
      .toArray();

    console.log(JSON.stringify(docs, null, 2));
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
