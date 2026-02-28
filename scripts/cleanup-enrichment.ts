import {
  kb2GraphNodesCollection,
  kb2GraphEdgesCollection,
  kb2RunStepsCollection,
  kb2LLMCallsCollection,
} from "../lib/mongodb";

const RUN_ID = "babb2d3e-db13-44d7-9806-42e72edeef82";

async function main() {
  // Delete inferred entities created by Graph Enrichment
  const inferredResult = await kb2GraphNodesCollection.deleteMany({
    run_id: RUN_ID,
    truth_status: "inferred",
  });
  console.log(`Deleted ${inferredResult.deletedCount} inferred entities`);

  // Delete enrichment edges (evidence starts with [enrichment])
  const enrichmentEdges = await kb2GraphEdgesCollection.deleteMany({
    run_id: RUN_ID,
    evidence: { $regex: /^\[enrichment\]/ },
  });
  console.log(`Deleted ${enrichmentEdges.deletedCount} enrichment edges`);

  // Delete the old step record and LLM calls for step 7 so it's clean
  const stepResult = await kb2RunStepsCollection.deleteMany({
    run_id: RUN_ID,
    step_id: "pass1-step-7",
  });
  console.log(`Deleted ${stepResult.deletedCount} step record(s) for pass1-step-7`);

  const llmResult = await kb2LLMCallsCollection.deleteMany({
    run_id: RUN_ID,
    step_id: "pass1-step-7",
  });
  console.log(`Deleted ${llmResult.deletedCount} LLM call record(s) for pass1-step-7`);

  // Verify remaining nodes
  const remainingNodes = await kb2GraphNodesCollection.countDocuments({ run_id: RUN_ID });
  const remainingEdges = await kb2GraphEdgesCollection.countDocuments({ run_id: RUN_ID });
  console.log(`\nRemaining: ${remainingNodes} nodes, ${remainingEdges} edges`);

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
