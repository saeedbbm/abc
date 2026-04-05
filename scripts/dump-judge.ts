import { MongoClient } from "mongodb";

async function main() {
  const prefix = process.argv[2] || "9d624550";
  const c = new MongoClient("mongodb://localhost:27017");
  await c.connect();

  const db = c.db("pidrax_pawfinder2");
  const run = await db.collection("kb2_runs").findOne({
    run_id: { $regex: new RegExp(`^${prefix}`) },
  });
  if (!run) { console.log("Run not found"); await c.close(); return; }

  console.log(`Run: ${run.run_id} | Status: ${run.status}\n`);

  const steps = await db.collection("kb2_run_steps")
    .find({ run_id: run.run_id })
    .sort({ pass: 1, step_number: 1, execution_number: -1 })
    .toArray();

  const seen = new Set<string>();
  for (const s of steps) {
    const key = `${s.pass}-${s.step_number}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const j = s.judge_result as any;
    if (!j) {
      console.log(`P1.${String(s.step_number).padStart(2)} ${(s.name || "").padEnd(30)} NO JUDGE`);
      continue;
    }

    const score = j.score ?? j.final_score ?? "?";
    const verdict = j.verdict ?? "?";
    console.log(`P1.${String(s.step_number).padStart(2)} ${(s.name || "").padEnd(30)} Score: ${score}/100  Verdict: ${verdict}`);

    if (j.sub_scores) {
      for (const [k, v] of Object.entries(j.sub_scores)) {
        const sv = v as any;
        console.log(`  ${k}: ${sv.score ?? sv.value ?? JSON.stringify(sv)}`);
      }
    }

    if (j.issues && j.issues.length > 0) {
      for (const iss of j.issues.slice(0, 8)) {
        const desc = (iss.description || iss.message || JSON.stringify(iss)).slice(0, 200);
        console.log(`  ISSUE [${iss.severity || "?"}]: ${desc}`);
      }
      if (j.issues.length > 8) console.log(`  ... +${j.issues.length - 8} more issues`);
    }

    if (j.recommendations && j.recommendations.length > 0) {
      for (const r of j.recommendations.slice(0, 3)) {
        console.log(`  REC: ${String(r).slice(0, 150)}`);
      }
    }

    console.log("---");
  }

  await c.close();
}

main().catch(console.error);
