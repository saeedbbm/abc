import { MongoClient } from "mongodb";

async function main() {
  const prefix = process.argv[2] || "06f7af19";
  const c = new MongoClient("mongodb://localhost:27017");
  await c.connect();

  const db = c.db("pidrax_pawfinder2");
  const run = await db.collection("kb2_runs").findOne({
    run_id: { $regex: new RegExp(`^${prefix}`) },
  });
  if (!run) { console.log("Run not found for prefix:", prefix); await c.close(); return; }

  console.log("=== RUN INFO ===");
  console.log("run_id:", run.run_id);
  console.log("status:", run.status);
  console.log("started:", run.started_at);
  console.log("completed:", run.completed_at);

  console.log("\n=== ALL STEP RECORDS (including reruns) ===");
  const steps = await db.collection("kb2_run_steps")
    .find({ run_id: run.run_id })
    .sort({ pass: 1, step_number: 1, execution_number: 1 })
    .toArray();

  for (const s of steps) {
    const dur = s.duration_ms ? (s.duration_ms / 1000).toFixed(1) + "s" : "";
    const m = s.metrics || {};
    const cost = m.cost_usd ? "$" + m.cost_usd.toFixed(4) : "";
    const llm = m.llm_calls ? m.llm_calls + " LLM" : "";
    console.log(
      `P${s.pass === "pass1" ? "1" : "2"}.${String(s.step_number).padStart(2)}` +
      ` exec#${String(s.execution_number || 1).padStart(2)}` +
      ` [${(s.execution_id || "").slice(0, 8)}]` +
      ` ${(s.name || "").padEnd(30)}` +
      ` [${(s.status || "").padEnd(9)}]` +
      ` ${dur.padStart(8)}` +
      ` ${llm.padStart(10)}` +
      ` ${cost.padStart(8)}` +
      `  ${(s.summary || "").slice(0, 150)}`
    );
  }

  // Now dump the LATEST execution of each step
  console.log("\n=== LATEST EXECUTION PER STEP — KEY ARTIFACTS ===\n");
  const seen = new Set<string>();
  const latestSteps = steps.reverse().filter((s) => {
    const key = `${s.pass}-${s.step_number}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.step_number - b.step_number);

  // Step 1
  const s1 = latestSteps.find((s) => s.step_number === 1);
  if (s1?.artifact) {
    const a = s1.artifact;
    console.log("STEP 1 — Input Snapshot:");
    console.log("  total_documents:", a.total_documents);
    console.log("  by_provider:", JSON.stringify(a.by_provider));
    console.log("  exec_id:", s1.execution_id);
  }

  // Step 3
  const s3 = latestSteps.find((s) => s.step_number === 3);
  if (s3?.artifact) {
    const a = s3.artifact;
    const byType: Record<string, number> = {};
    if (a.entities_by_type) {
      for (const [type, list] of Object.entries(a.entities_by_type as Record<string, any[]>)) {
        byType[type] = Array.isArray(list) ? list.length : 0;
      }
    }
    console.log("\nSTEP 3 — Entity Extraction (latest exec):");
    console.log("  exec#:", s3.execution_number, "exec_id:", s3.execution_id?.slice(0, 8));
    console.log("  total entities:", Object.values(byType).reduce((a, b) => a + b, 0));
    console.log("  by_type:", JSON.stringify(byType));
  }

  // Step 4
  const s4 = latestSteps.find((s) => s.step_number === 4);
  if (s4?.artifact) {
    console.log("\nSTEP 4 — Extraction Validation:");
    console.log("  exec#:", s4.execution_number, "exec_id:", s4.execution_id?.slice(0, 8));
    console.log("  summary:", s4.summary?.slice(0, 200));
    console.log("  artifact keys:", Object.keys(s4.artifact));
    const a = s4.artifact;
    if (a.before_count !== undefined) console.log("  before:", a.before_count, "after:", a.after_count);
    if (a.recovered !== undefined) console.log("  recovered:", a.recovered, "rejected:", a.rejected);
  }

  // Step 5
  const s5 = latestSteps.find((s) => s.step_number === 5);
  if (s5?.artifact) {
    console.log("\nSTEP 5 — Entity Resolution:");
    console.log("  exec#:", s5.execution_number, "exec_id:", s5.execution_id?.slice(0, 8));
    console.log("  artifact:", JSON.stringify(s5.artifact, null, 2).slice(0, 1000));
  }

  // Step 6
  const s6 = latestSteps.find((s) => s.step_number === 6);
  if (s6?.artifact) {
    console.log("\nSTEP 6 — Graph Build:");
    console.log("  exec#:", s6.execution_number, "exec_id:", s6.execution_id?.slice(0, 8));
    console.log("  artifact:", JSON.stringify(s6.artifact, null, 2).slice(0, 1000));
  }

  // Step 7
  const s7 = latestSteps.find((s) => s.step_number === 7);
  if (s7?.artifact) {
    console.log("\nSTEP 7 — Graph Enrichment:");
    console.log("  exec#:", s7.execution_number, "exec_id:", s7.execution_id?.slice(0, 8));
    console.log("  artifact:", JSON.stringify(s7.artifact, null, 2).slice(0, 500));
  }

  // Step 8
  const s8 = latestSteps.find((s) => s.step_number === 8);
  if (s8?.artifact) {
    console.log("\nSTEP 8 — Discovery:");
    console.log("  exec#:", s8.execution_number, "exec_id:", s8.execution_id?.slice(0, 8));
    const a = s8.artifact;
    console.log("  total:", a.total_discoveries || a.total);
    console.log("  by_category:", JSON.stringify(a.by_category));
    if (a.discoveries) {
      for (const d of a.discoveries) {
        console.log(`    - ${d.display_name} [${d.type}] cat=${d.category} conf=${d.confidence} srefs=${d.source_refs?.length || '?'}`);
      }
    }
  }

  // Step 9
  const s9 = latestSteps.find((s) => s.step_number === 9);
  if (s9?.artifact) {
    console.log("\nSTEP 9 — Attribute Completion:");
    console.log("  exec#:", s9.execution_number, "exec_id:", s9.execution_id?.slice(0, 8));
    console.log("  artifact:", JSON.stringify(s9.artifact, null, 2));
  }

  // Step 10
  const s10 = latestSteps.find((s) => s.step_number === 10);
  if (s10?.artifact) {
    console.log("\nSTEP 10 — Pattern Synthesis:");
    console.log("  exec#:", s10.execution_number, "exec_id:", s10.execution_id?.slice(0, 8));
    console.log("  artifact:", JSON.stringify(s10.artifact, null, 2).slice(0, 3000));
  }

  // Step 11
  const s11 = latestSteps.find((s) => s.step_number === 11);
  if (s11?.artifact) {
    console.log("\nSTEP 11 — Graph Re-enrichment:");
    console.log("  exec#:", s11.execution_number, "exec_id:", s11.execution_id?.slice(0, 8));
    console.log("  artifact:", JSON.stringify(s11.artifact, null, 2));
  }

  // Now check ACTUAL DB state for this run
  console.log("\n=== ACTUAL DB STATE ===\n");

  // Entity counts by type from kb2_graph_nodes
  const nodeCountPipeline = [
    { $match: { run_id: run.run_id } },
    { $group: { _id: "$type", count: { $sum: 1 } } },
    { $sort: { count: -1 as const } },
  ];
  const nodeCounts = await db.collection("kb2_graph_nodes").aggregate(nodeCountPipeline).toArray();
  console.log("kb2_graph_nodes by type (all execution_ids for this run):");
  let totalNodes = 0;
  for (const c2 of nodeCounts) { console.log(`  ${c2._id}: ${c2.count}`); totalNodes += c2.count; }
  console.log("  TOTAL:", totalNodes);

  // Convention entities
  const conventions = await db.collection("kb2_graph_nodes").find({
    run_id: run.run_id,
    "attributes.is_convention": true,
  }).toArray();
  console.log(`\nConvention entities (is_convention=true): ${conventions.length}`);
  for (const conv of conventions) {
    console.log(`  - "${conv.display_name}" [${conv.type}]`);
    console.log(`    exec_id: ${conv.execution_id}`);
    console.log(`    established_by: ${conv.attributes?.established_by}`);
    console.log(`    pattern_rule: ${(conv.attributes?.pattern_rule || "").slice(0, 200)}`);
    console.log(`    constituent_decisions: ${JSON.stringify(conv.attributes?.constituent_decisions)}`);
    console.log(`    source_refs: ${conv.source_refs?.length} refs`);
    console.log(`    documentation_level: ${conv.attributes?.documentation_level}`);
  }

  // Edge counts by type from kb2_graph_edges
  const edgeCountPipeline = [
    { $match: { run_id: run.run_id } },
    { $group: { _id: "$type", count: { $sum: 1 } } },
    { $sort: { count: -1 as const } },
  ];
  const edgeCounts = await db.collection("kb2_graph_edges").aggregate(edgeCountPipeline).toArray();
  console.log("\nkb2_graph_edges by type:");
  let totalEdges = 0;
  for (const c2 of edgeCounts) { console.log(`  ${c2._id}: ${c2.count}`); totalEdges += c2.count; }
  console.log("  TOTAL:", totalEdges);

  // Check specific convention edge types
  for (const edgeType of ["APPLIES_TO", "PROPOSED_BY", "CONTAINS"]) {
    const edges = await db.collection("kb2_graph_edges").find({
      run_id: run.run_id,
      type: edgeType,
    }).toArray();
    console.log(`\n${edgeType} edges: ${edges.length}`);
    for (const e of edges.slice(0, 10)) {
      const src = await db.collection("kb2_graph_nodes").findOne({ node_id: e.source_node_id, run_id: run.run_id });
      const tgt = await db.collection("kb2_graph_nodes").findOne({ node_id: e.target_node_id, run_id: run.run_id });
      console.log(`  "${src?.display_name || e.source_node_id}" → "${tgt?.display_name || e.target_node_id}" [exec:${e.execution_id?.slice(0, 8)}]`);
    }
  }

  // Check dangling edges
  const allEdges = await db.collection("kb2_graph_edges").find({ run_id: run.run_id }).toArray();
  const allNodeIds = new Set((await db.collection("kb2_graph_nodes").find({ run_id: run.run_id }).project({ node_id: 1 }).toArray()).map((n: any) => n.node_id));
  let dangling = 0;
  for (const e of allEdges) {
    if (!allNodeIds.has(e.source_node_id) || !allNodeIds.has(e.target_node_id)) dangling++;
  }
  console.log(`\nDangling edges: ${dangling} / ${allEdges.length}`);

  // Check entity counts for latest Step 5 execution
  if (s5?.execution_id) {
    const s5Nodes = await db.collection("kb2_graph_nodes").find({ execution_id: s5.execution_id }).toArray();
    const s5ByType: Record<string, number> = {};
    for (const n of s5Nodes) { s5ByType[n.type] = (s5ByType[n.type] || 0) + 1; }
    console.log(`\nStep 5 entities (exec_id ${s5.execution_id.slice(0, 8)}):`);
    console.log("  by_type:", JSON.stringify(s5ByType));
    console.log("  total:", s5Nodes.length);
  }

  // Check Step 9 entities
  if (s9?.execution_id) {
    const s9Nodes = await db.collection("kb2_graph_nodes").find({ execution_id: s9.execution_id }).toArray();
    const statusDist: Record<string, number> = {};
    const decidedByFilled = { filled: 0, empty: 0 };
    for (const n of s9Nodes) {
      const st = n.attributes?.status;
      if (st) statusDist[st] = (statusDist[st] || 0) + 1;
      if (n.type === "decision") {
        if (n.attributes?.decided_by) decidedByFilled.filled++;
        else decidedByFilled.empty++;
      }
    }
    console.log(`\nStep 9 entities (exec_id ${s9.execution_id.slice(0, 8)}):`);
    console.log("  total:", s9Nodes.length);
    console.log("  status distribution:", JSON.stringify(statusDist));
    console.log("  decided_by on decisions:", JSON.stringify(decidedByFilled));
  }

  // Sample 10 decisions with their decided_by
  if (s9?.execution_id) {
    const decisions = await db.collection("kb2_graph_nodes")
      .find({ execution_id: s9.execution_id, type: "decision" })
      .limit(50)
      .toArray();
    console.log(`\nAll ${decisions.length} decisions (Step 9):`);
    for (const d of decisions) {
      console.log(`  "${d.display_name}" decided_by="${d.attributes?.decided_by || 'NULL'}" status="${d.attributes?.status || 'NULL'}"`);
    }
  }

  // Projects with status
  if (s9?.execution_id) {
    const projects = await db.collection("kb2_graph_nodes")
      .find({ execution_id: s9.execution_id, type: "project" })
      .toArray();
    console.log(`\nAll ${projects.length} projects (Step 9) with status:`);
    for (const p of projects) {
      console.log(`  "${p.display_name}" status="${p.attributes?.status || 'NULL'}" doc_level="${p.attributes?.documentation_level || 'NULL'}"`);
    }
  }

  await c.close();
}

main().catch(console.error);
