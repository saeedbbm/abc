import { MongoClient } from "mongodb";

async function main() {
  const c = new MongoClient("mongodb://localhost:27017");
  await c.connect();
  const db = c.db("pidrax");

  const runId = process.argv[2] || "a2811d8c-102d-45e6-baa0-68120cc02790";
  const run = await db.collection("kb2_runs").findOne({ run_id: runId });
  console.log(`\n=== ${run?.title ?? "Run"} (${run?.status}) ===`);
  console.log(`ID: ${runId}`);
  if (run?.error) console.log(`Error: ${run.error}`);

  const steps = await db.collection("kb2_run_steps")
    .find({ run_id: runId })
    .sort({ pass: 1, step_number: 1 })
    .toArray();

  for (const s of steps) {
    const dur = s.duration_ms != null
      ? (s.duration_ms < 1000 ? `${s.duration_ms}ms` : `${(s.duration_ms / 1000).toFixed(1)}s`)
      : "?";
    const calls = s.metrics?.llm_calls ?? 0;
    const tokens = s.metrics ? s.metrics.input_tokens + s.metrics.output_tokens : 0;
    const icon = s.status === "completed" ? "✓" : s.status === "failed" ? "✗" : "…";
    console.log(
      `  ${icon} ${s.pass} Step ${s.step_number}: ${s.name.padEnd(24)} ${s.status.padEnd(10)} ${dur.padStart(8)} | ${calls} LLM calls | ${tokens.toLocaleString()} tokens`,
    );
    if (s.status === "failed") console.log(`    Error: ${s.summary}`);
  }

  await c.close();
}

main().catch(console.error);
