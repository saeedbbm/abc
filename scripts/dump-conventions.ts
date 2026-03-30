import { MongoClient } from "mongodb";

async function main() {
  const prefix = process.argv[2] || "06f7af19";
  const c = new MongoClient("mongodb://localhost:27017");
  await c.connect();
  const db = c.db("pidrax_pawfinder2");

  const run = await db.collection("kb2_runs").findOne({
    run_id: { $regex: new RegExp(`^${prefix}`) },
  });
  if (!run) { console.log("Run not found"); await c.close(); return; }

  // Step 10 artifact (latest)
  const s10 = await db.collection("kb2_run_steps")
    .find({ run_id: run.run_id, step_number: 10 })
    .sort({ execution_number: -1 })
    .limit(1)
    .next();
  if (s10?.artifact) {
    console.log("=== STEP 10 LATEST ARTIFACT ===");
    console.log(JSON.stringify(s10.artifact, null, 2));
  }

  // Convention nodes
  console.log("\n=== CONVENTION NODES (kb2_graph_nodes, is_convention=true) ===");
  const convs = await db.collection("kb2_graph_nodes").find({
    run_id: run.run_id,
    "attributes.is_convention": true,
  }).toArray();
  console.log(`Found: ${convs.length}`);
  for (const conv of convs) {
    console.log(`\n--- ${conv.display_name} ---`);
    console.log(`  node_id: ${conv.node_id}`);
    console.log(`  execution_id: ${conv.execution_id}`);
    console.log(`  type: ${conv.type}`);
    console.log(`  established_by: ${conv.attributes?.established_by}`);
    console.log(`  pattern_rule: ${conv.attributes?.pattern_rule}`);
    console.log(`  constituent_decisions: ${JSON.stringify(conv.attributes?.constituent_decisions)}`);
    console.log(`  documentation_level: ${conv.attributes?.documentation_level}`);
    console.log(`  confidence: ${conv.confidence}`);
    console.log(`  source_refs count: ${conv.source_refs?.length}`);
    if (conv.source_refs) {
      for (const sr of conv.source_refs) {
        console.log(`    [${sr.source_type}] ${sr.doc_id}: ${sr.title?.slice(0, 80)}`);
      }
    }
  }

  // Convention edges specifically
  console.log("\n=== CONVENTION-RELATED EDGES ===");
  const convNodeIds = new Set(convs.map((c2: any) => c2.node_id));

  const convEdges = await db.collection("kb2_graph_edges").find({
    run_id: run.run_id,
    $or: [
      { source_node_id: { $in: [...convNodeIds] } },
      { target_node_id: { $in: [...convNodeIds] } },
    ],
  }).toArray();
  console.log(`Total edges touching convention nodes: ${convEdges.length}`);

  for (const e of convEdges) {
    const src = await db.collection("kb2_graph_nodes").findOne({ node_id: e.source_node_id, run_id: run.run_id });
    const tgt = await db.collection("kb2_graph_nodes").findOne({ node_id: e.target_node_id, run_id: run.run_id });
    console.log(`  [${e.type}] "${src?.display_name || '???'}" → "${tgt?.display_name || '???'}" (exec:${e.execution_id?.slice(0, 8)}, weight:${e.weight})`);
  }

  // Specifically APPLIES_TO edges
  console.log("\n=== ALL APPLIES_TO EDGES ===");
  const appEdges = await db.collection("kb2_graph_edges").find({
    run_id: run.run_id,
    type: "APPLIES_TO",
  }).toArray();
  console.log(`Total: ${appEdges.length}`);
  for (const e of appEdges) {
    const src = await db.collection("kb2_graph_nodes").findOne({ node_id: e.source_node_id, run_id: run.run_id });
    const tgt = await db.collection("kb2_graph_nodes").findOne({ node_id: e.target_node_id, run_id: run.run_id });
    console.log(`  "${src?.display_name || '???'}" → "${tgt?.display_name || '???'}" (exec:${e.execution_id?.slice(0, 8)})`);
  }

  // PROPOSED_BY edges
  console.log("\n=== ALL PROPOSED_BY EDGES ===");
  const propEdges = await db.collection("kb2_graph_edges").find({
    run_id: run.run_id,
    type: "PROPOSED_BY",
  }).toArray();
  console.log(`Total: ${propEdges.length}`);
  for (const e of propEdges) {
    const src = await db.collection("kb2_graph_nodes").findOne({ node_id: e.source_node_id, run_id: run.run_id });
    const tgt = await db.collection("kb2_graph_nodes").findOne({ node_id: e.target_node_id, run_id: run.run_id });
    console.log(`  "${src?.display_name || '???'}" → "${tgt?.display_name || '???'}" (exec:${e.execution_id?.slice(0, 8)})`);
  }

  // Toy Donation Feature specifically
  console.log("\n=== TOY DONATION FEATURE ===");
  const toyNodes = await db.collection("kb2_graph_nodes").find({
    run_id: run.run_id,
    display_name: { $regex: /toy.*donat/i },
  }).toArray();
  console.log(`Nodes matching "toy donat": ${toyNodes.length}`);
  for (const n of toyNodes) {
    console.log(`  "${n.display_name}" [${n.type}] exec:${n.execution_id?.slice(0, 8)}`);
    console.log(`    status: ${n.attributes?.status}`);
    console.log(`    source_refs: ${n.source_refs?.length}`);
    if (n.source_refs) {
      for (const sr of n.source_refs) {
        console.log(`      [${sr.source_type}] ${sr.doc_id}: ${sr.title?.slice(0, 80)}`);
      }
    }
    // Check edges
    const edges = await db.collection("kb2_graph_edges").find({
      run_id: run.run_id,
      $or: [{ source_node_id: n.node_id }, { target_node_id: n.node_id }],
    }).toArray();
    console.log(`    edges: ${edges.length}`);
    for (const e of edges.slice(0, 15)) {
      const other = e.source_node_id === n.node_id
        ? await db.collection("kb2_graph_nodes").findOne({ node_id: e.target_node_id, run_id: run.run_id })
        : await db.collection("kb2_graph_nodes").findOne({ node_id: e.source_node_id, run_id: run.run_id });
      const dir = e.source_node_id === n.node_id ? "→" : "←";
      console.log(`      [${e.type}] ${dir} "${other?.display_name || '???'}"`);
    }
  }

  // Process count
  const processes = await db.collection("kb2_graph_nodes").find({
    run_id: run.run_id,
    type: "process",
  }).toArray();
  console.log(`\n=== ALL ${processes.length} PROCESSES ===`);
  for (const p of processes) {
    console.log(`  "${p.display_name}" status="${p.attributes?.status || 'NULL'}"`);
  }

  await c.close();
}

main().catch(console.error);
