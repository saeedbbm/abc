import { MongoClient } from "mongodb";

async function main() {
  const prefix = process.argv[2] || "05f08654";
  const c = new MongoClient("mongodb://localhost:27017");
  await c.connect();

  // Try pidrax_pawfinder first, then pidrax
  for (const dbName of ["pidrax_pawfinder2", "pidrax_pawfinder", "pidrax"]) {
    const db = c.db(dbName);
    const run = await db.collection("kb2_runs").findOne({
      run_id: { $regex: new RegExp(`^${prefix}`) },
    });
    if (!run) continue;

    console.log(`DB: ${dbName} | Run: ${run.run_id} | Status: ${run.status}`);
    console.log(`Started: ${run.started_at} | Completed: ${run.completed_at || "N/A"}`);
    console.log("---");

    const steps = await db.collection("kb2_run_steps")
      .find({ run_id: run.run_id })
      .sort({ pass: 1, step_number: 1, execution_number: -1 })
      .toArray();

    // Deduplicate by pass+step_number (keep latest execution)
    const seen = new Set<string>();
    const uniqueSteps = steps.filter((s) => {
      const key = `${s.pass}-${s.step_number}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    for (const s of uniqueSteps) {
      const dur = s.duration_ms ? `${(s.duration_ms / 1000).toFixed(1)}s` : "";
      const m = s.metrics || {};
      const cost = m.cost_usd ? `$${m.cost_usd.toFixed(4)}` : "";
      const llm = m.llm_calls ? `${m.llm_calls} LLM` : "";
      console.log(
        `${s.pass === "pass1" ? "P1" : "P2"}.${String(s.step_number).padStart(2)} ${(s.name || "").padEnd(30)} [${(s.status || "").padEnd(9)}] ${dur.padStart(7)} ${llm.padStart(8)} ${cost.padStart(8)}  ${(s.summary || "").slice(0, 120)}`
      );
    }

    console.log("\n=== Key Step Artifacts ===\n");

    // Step 3: Entity Extraction
    const step3 = uniqueSteps.find((s) => s.step_number === 3 && s.pass === "pass1");
    if (step3?.artifact) {
      console.log("STEP 3 - Entity Extraction:", JSON.stringify(step3.artifact.entities_by_type || {}, null, 2));
    }

    // Step 5: Entity Resolution
    const step5 = uniqueSteps.find((s) => s.step_number === 5 && s.pass === "pass1");
    if (step5?.artifact) {
      console.log("\nSTEP 5 - Entity Resolution:", JSON.stringify({ before: step5.artifact.before_count, after: step5.artifact.after_count, merges: step5.artifact.merges_performed }, null, 2));
    }

    // Step 8: Discovery
    const step8 = uniqueSteps.find((s) => s.step_number === 8 && s.pass === "pass1");
    if (step8?.artifact) {
      const a = step8.artifact;
      console.log("\nSTEP 8 - Discovery:", JSON.stringify({ total: a.total_discoveries, by_category: a.by_category }, null, 2));
      if (a.discoveries) {
        for (const d of a.discoveries) {
          console.log(`  - ${d.display_name} [${d.type}] cat=${d.category} conf=${d.confidence}`);
        }
      }
    }

    // Step 9: Attribute Completion
    const step9 = uniqueSteps.find((s) => s.step_number === 9 && s.pass === "pass1");
    if (step9?.artifact) {
      console.log("\nSTEP 9 - Attribute Completion:", JSON.stringify(step9.artifact, null, 2));
    }

    // Step 10: Pattern Synthesis
    const step10 = uniqueSteps.find((s) => s.step_number === 10 && s.pass === "pass1");
    if (step10?.artifact) {
      console.log("\nSTEP 10 - Pattern Synthesis:", JSON.stringify(step10.artifact, null, 2));
    }

    // Step 11: Graph Re-enrichment
    const step11 = uniqueSteps.find((s) => s.step_number === 11 && s.pass === "pass1");
    if (step11?.artifact) {
      console.log("\nSTEP 11 - Graph Re-enrichment:", JSON.stringify(step11.artifact, null, 2));
    }

    // Step 12: Page Plan
    const step12 = uniqueSteps.find((s) => s.step_number === 12 && s.pass === "pass1");
    if (step12?.artifact) {
      const a = step12.artifact;
      console.log("\nSTEP 12 - Page Plan:", JSON.stringify({ entity_pages: a.entity_pages?.length, human_pages: a.human_pages?.length, tickets_synced: a.tickets_synced }, null, 2));
    }

    // Steps 14, 15, 16 summary
    for (const sn of [14, 15, 16, 17, 18]) {
      const s = uniqueSteps.find((x) => x.step_number === sn && x.pass === "pass1");
      if (s?.artifact) {
        console.log(`\nSTEP ${sn} - ${s.name}:`, JSON.stringify(s.artifact, null, 2).slice(0, 500));
      }
    }

    // Check convention entities
    console.log("\n=== Convention Entities ===\n");
    const conventions = await db.collection("kb2_graph_nodes").find({
      run_id: run.run_id,
      "attributes.is_convention": true,
    }).toArray();
    console.log(`Found ${conventions.length} convention entities`);
    for (const conv of conventions) {
      console.log(`  - ${conv.display_name} [${conv.type}]`);
      console.log(`    pattern_rule: ${conv.attributes?.pattern_rule?.slice(0, 150)}`);
      console.log(`    established_by: ${JSON.stringify(conv.attributes?.established_by)}`);
      console.log(`    constituent_decisions: ${JSON.stringify(conv.attributes?.constituent_decisions)}`);
      console.log(`    source_refs: ${conv.source_refs?.length} refs`);
    }

    // Check APPLIES_TO, PROPOSED_BY edges
    console.log("\n=== Convention Edges ===\n");
    for (const edgeType of ["APPLIES_TO", "PROPOSED_BY", "CONTAINS"]) {
      const edges = await db.collection("kb2_graph_edges").find({
        run_id: run.run_id,
        type: edgeType,
      }).toArray();
      console.log(`${edgeType}: ${edges.length} edges`);
      for (const e of edges.slice(0, 5)) {
        const src = await db.collection("kb2_graph_nodes").findOne({ node_id: e.source_node_id, run_id: run.run_id });
        const tgt = await db.collection("kb2_graph_nodes").findOne({ node_id: e.target_node_id, run_id: run.run_id });
        console.log(`  ${src?.display_name || e.source_node_id} → ${tgt?.display_name || e.target_node_id}`);
      }
    }

    // Check entity counts
    console.log("\n=== Entity Counts by Type ===\n");
    const pipeline = [
      { $match: { run_id: run.run_id } },
      { $group: { _id: "$type", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ];
    const counts = await db.collection("kb2_graph_nodes").aggregate(pipeline).toArray();
    for (const c2 of counts) {
      console.log(`  ${c2._id}: ${c2.count}`);
    }

    await c.close();
    return;
  }

  console.log("Run not found");
  await c.close();
}

main().catch(console.error);
