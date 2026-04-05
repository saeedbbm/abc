import { randomUUID } from "crypto";
import {
  kb2RunsCollection,
  kb2RunStepsCollection,
  kb2LLMCallsCollection,
  kb2GraphNodesCollection,
  kb2GraphEdgesCollection,
  kb2InputSnapshotsCollection,
} from "../lib/mongodb";

const OLD_RUN_ID = "a2811d8c-102d-45e6-baa0-68120cc02790";
const COPY_STEPS = 5;

const PASS1_STEPS = [
  "Input Snapshot",
  "Embed Documents",
  "Entity Extraction",
  "Extraction Validation",
  "Entity Resolution",
  "Graph Build",
  "Graph Enrichment",
  "Page Plan",
  "GraphRAG Retrieval",
  "Generate Entity Pages",
  "Generate Human Pages",
  "Extract Claims",
  "Create Verify Cards",
];

async function main() {
  const oldRun = await kb2RunsCollection.findOne({ run_id: OLD_RUN_ID });
  if (!oldRun) {
    console.error("Old run not found:", OLD_RUN_ID);
    process.exit(1);
  }

  const newRunId = randomUUID();
  console.log("New run ID:", newRunId);

  await kb2RunsCollection.insertOne({
    run_id: newRunId,
    company_slug: oldRun.company_slug,
    status: "completed",
    title: `Cloned from ${OLD_RUN_ID.slice(0, 8)} — Steps 1-${COPY_STEPS} preserved`,
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    current_pass: "pass1",
    total_steps: PASS1_STEPS.length,
    current_step: COPY_STEPS,
    stats: {},
  });

  // Copy step records for steps 1-5
  const oldSteps = await kb2RunStepsCollection
    .find({ run_id: OLD_RUN_ID, pass: "pass1", step_number: { $lte: COPY_STEPS } })
    .sort({ step_number: 1 })
    .toArray();

  console.log(`Found ${oldSteps.length} old steps to copy`);

  for (const oldStep of oldSteps) {
    const stepNum = oldStep.step_number as number;
    const newStepId = `pass1-step-${stepNum}`;
    const { _id, ...stepData } = oldStep;
    await kb2RunStepsCollection.insertOne({
      ...stepData,
      run_id: newRunId,
      step_id: newStepId,
      name: PASS1_STEPS[stepNum - 1],
    });
    console.log(`  Copied step ${stepNum}: ${PASS1_STEPS[stepNum - 1]}`);
  }

  // Copy LLM calls for steps 1-5
  const copiedStepIds = oldSteps.map((s) => s.step_id);
  const llmCalls = await kb2LLMCallsCollection
    .find({ run_id: OLD_RUN_ID, step_id: { $in: copiedStepIds } })
    .toArray();

  if (llmCalls.length > 0) {
    const newCalls = llmCalls.map((c) => {
      const { _id, ...data } = c;
      return { ...data, run_id: newRunId, call_id: randomUUID() };
    });
    await kb2LLMCallsCollection.insertMany(newCalls);
    console.log(`  Copied ${newCalls.length} LLM call records`);
  }

  // Copy graph nodes (these are from entity extraction/validation/resolution)
  const nodes = await kb2GraphNodesCollection.find({ run_id: OLD_RUN_ID }).toArray();
  if (nodes.length > 0) {
    const newNodes = nodes.map((n) => {
      const { _id, ...data } = n;
      return { ...data, run_id: newRunId };
    });
    await kb2GraphNodesCollection.insertMany(newNodes);
    console.log(`  Copied ${newNodes.length} graph nodes`);
  }

  // Copy graph edges (from graph build step — may exist from the old run)
  const edges = await kb2GraphEdgesCollection.find({ run_id: OLD_RUN_ID }).toArray();
  if (edges.length > 0) {
    const newEdges = edges.map((e) => {
      const { _id, ...data } = e;
      return { ...data, run_id: newRunId };
    });
    await kb2GraphEdgesCollection.insertMany(newEdges);
    console.log(`  Copied ${edges.length} graph edges`);
  }

  // Copy input snapshot
  const snapshot = await kb2InputSnapshotsCollection.findOne({ run_id: OLD_RUN_ID });
  if (snapshot) {
    const { _id, ...snapData } = snapshot;
    await kb2InputSnapshotsCollection.insertOne({ ...snapData, run_id: newRunId });
    console.log("  Copied input snapshot");
  }

  // Update run status to paused so user knows to continue from step 6
  await kb2RunsCollection.updateOne(
    { run_id: newRunId },
    { $set: { status: "completed", current_step: COPY_STEPS } },
  );

  console.log("\nDone! New run created:", newRunId);
  console.log(`Steps 1-${COPY_STEPS} copied. Select this run and use "Run From Here" at step 6 (Graph Build).`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
