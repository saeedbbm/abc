import { NextRequest } from "next/server";
import { getTenantCollections } from "@/lib/mongodb";
import {
  getLatestCompletedRunId,
  getLatestCompletedStepExecutionId,
  getLatestRunIdFromCollection,
} from "@/src/application/lib/kb2/run-scope";
import {
  buildBaselineRunFilter,
  buildStateFilter,
  isWorkspaceLikeState,
  resolveActiveDemoState,
} from "@/src/application/lib/kb2/demo-state";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ companySlug: string }> },
) {
  const { companySlug } = await params;
  const type = request.nextUrl.searchParams.get("type");
  const runId = request.nextUrl.searchParams.get("run_id");
  const executionId = request.nextUrl.searchParams.get("execution_id");
  const stateId = request.nextUrl.searchParams.get("state_id");
  const tc = getTenantCollections(companySlug);
  const activeDemoState =
    !runId && !executionId
      ? await resolveActiveDemoState(tc, companySlug, stateId)
      : stateId
        ? await resolveActiveDemoState(tc, companySlug, stateId)
        : null;
  const baseRunIdFromState = activeDemoState?.base_run_id ?? null;

  function baselineFilterForRun(targetRunId: string): Record<string, any> {
    return buildBaselineRunFilter(targetRunId) as Record<string, any>;
  }

  function demoFilterForCollection(targetRunId?: string): Record<string, any> {
    if (isWorkspaceLikeState(activeDemoState)) {
      return buildStateFilter(activeDemoState.state_id) as Record<string, any>;
    }
    if (targetRunId) {
      return baselineFilterForRun(targetRunId);
    }
    return { demo_state_id: { $exists: false } };
  }

  function dedupeGraphNodes(nodes: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    const seen = new Set<string>();
    return nodes.filter((node) => {
      const nodeId = typeof node.node_id === "string" && node.node_id.trim().length > 0
        ? node.node_id
        : `${String(node.type ?? "")}:${String(node.display_name ?? "")}`;
      if (seen.has(nodeId)) return false;
      seen.add(nodeId);
      return true;
    });
  }

  const filter: Record<string, any> = {};
  if (executionId) {
    filter.execution_id = executionId;
  } else if (runId) {
    filter.run_id = runId;
  }

  switch (type) {
    case "raw_input": {
      const rawInputs = await tc.raw_inputs
        .find({ company_slug: companySlug })
        .toArray();

      if (rawInputs.length === 0) return Response.json({ exists: false });

      const sources: Record<string, {
        doc_count: number;
        updated_at: string;
        raw_json: string;
      }> = {};

      for (const input of rawInputs) {
        const source = input.source as string;
        sources[source] = {
          doc_count: input.doc_count ?? 0,
          updated_at: input.updated_at,
          raw_json: typeof input.data === "string"
            ? input.data
            : JSON.stringify(input.data, null, 2),
        };
      }

      return Response.json({
        exists: true,
        company_slug: companySlug,
        sources,
      });
    }
    case "inputs": {
      if (executionId) {
        const doc = await tc.input_snapshots.findOne({ execution_id: executionId });
        if (doc) return Response.json({ snapshot: doc });
      }
      const inputFilter: Record<string, any> = {};
      if (runId) inputFilter.run_id = runId;
      else if (baseRunIdFromState) inputFilter.run_id = baseRunIdFromState;
      const doc = await tc.input_snapshots.findOne(inputFilter, { sort: { created_at: -1 } });
      return Response.json({ snapshot: doc });
    }
    case "people": {
      const people = await tc.people.find({ company_slug: companySlug }).toArray();
      if (people.length > 0) {
        return Response.json({ people });
      }

      const peopleFilter: Record<string, any> = { node_type: "team_member" };
      let effectiveRunId = filter.run_id as string | undefined;
      if (!effectiveRunId) {
        const runIdsWithEP = await tc.entity_pages.distinct("run_id");
        effectiveRunId = runIdsWithEP.length > 0
          ? (await getLatestCompletedRunId(tc, companySlug, runIdsWithEP)) ?? undefined
          : undefined;
      }

      const latestEntityPagesExecId = effectiveRunId
        ? await getLatestCompletedStepExecutionId(tc, effectiveRunId, "pass1-step-14")
        : null;
      if (latestEntityPagesExecId) {
        peopleFilter.execution_id = latestEntityPagesExecId;
      } else if (effectiveRunId) {
        peopleFilter.run_id = effectiveRunId;
      }

      const personPages = await tc.entity_pages.find(peopleFilter).toArray();

      const seen = new Set<string>();
      const derived = personPages
        .filter((p: any) => {
          const key = (p.title ?? "").toLowerCase().trim();
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .map((p: any) => ({
          person_id: p.page_id,
          display_name: p.title,
          aliases: [],
          email: "",
          slack_handle: "",
          github_handle: "",
          source_node_id: p.node_id,
          company_slug: companySlug,
        }));
      return Response.json({ people: derived });
    }
    case "graph_nodes": {
      if (executionId) {
        const nodes = await tc.graph_nodes.find({ execution_id: executionId, demo_state_id: { $exists: false } }).toArray();
        if (nodes.length > 0) return Response.json({ nodes });
      }
      if (!runId && !executionId && isWorkspaceLikeState(activeDemoState)) {
        const nodes = await tc.graph_nodes.find(buildStateFilter(activeDemoState.state_id)).toArray();
        return Response.json({ nodes: dedupeGraphNodes(nodes) });
      }
      let effectiveRunId = runId ?? baseRunIdFromState ?? undefined;
      if (!effectiveRunId) {
        const runIdsWithNodes = await tc.graph_nodes.distinct("run_id", { demo_state_id: { $exists: false } });
        effectiveRunId = runIdsWithNodes.length > 0
          ? (await getLatestCompletedRunId(tc, companySlug, runIdsWithNodes)) ?? undefined
          : undefined;
      }
      if (effectiveRunId) {
        const latestStep9ExecId = await getLatestCompletedStepExecutionId(tc, effectiveRunId, "pass1-step-9");
        const latestStep10ExecId = await getLatestCompletedStepExecutionId(tc, effectiveRunId, "pass1-step-10");
        const latestStep11ExecId = await getLatestCompletedStepExecutionId(tc, effectiveRunId, "pass1-step-11");
        const latestNodeExecIds = [latestStep9ExecId, latestStep10ExecId, latestStep11ExecId].filter(Boolean);
        if (latestNodeExecIds.length > 0) {
          const nodes = await tc.graph_nodes.find({
            execution_id: { $in: latestNodeExecIds },
            demo_state_id: { $exists: false },
          }).toArray();
          return Response.json({ nodes: dedupeGraphNodes(nodes) });
        }
      }
      const nodes = await tc.graph_nodes.find(
        effectiveRunId ? baselineFilterForRun(effectiveRunId) : { demo_state_id: { $exists: false } },
      ).toArray();
      return Response.json({ nodes: dedupeGraphNodes(nodes) });
    }
    case "graph_edges": {
      if (executionId) {
        const edges = await tc.graph_edges.find({ execution_id: executionId }).toArray();
        if (edges.length > 0) return Response.json({ edges });
      }
      const edgeFilter: Record<string, any> = {};
      const effectiveRunId =
        runId
        ?? baseRunIdFromState
        ?? await getLatestRunIdFromCollection(tc, companySlug, tc.graph_edges);
      if (effectiveRunId) edgeFilter.run_id = effectiveRunId;
      const edges = await tc.graph_edges.find(edgeFilter).toArray();
      return Response.json({ edges });
    }
    case "claims": {
      if (executionId) {
        const claims = await tc.claims.find({ execution_id: executionId, demo_state_id: { $exists: false } }).toArray();
        if (claims.length > 0) return Response.json({ claims });
      }
      const claimsFilter: Record<string, any> = {};
      const effectiveRunId =
        runId
        ?? baseRunIdFromState
        ?? await getLatestRunIdFromCollection(tc, companySlug, {
          distinct: (field: string) => tc.claims.distinct(field, { demo_state_id: { $exists: false } }),
        });
      Object.assign(claimsFilter, demoFilterForCollection(effectiveRunId ?? undefined));
      const claims = await tc.claims.find(claimsFilter).toArray();
      return Response.json({ claims });
    }
    case "fact_groups": {
      if (executionId) {
        const groups = await tc.fact_groups.find({ execution_id: executionId }).toArray();
        if (groups.length > 0) return Response.json({ groups });
      }
      const fgFilter: Record<string, any> = {};
      const effectiveRunId = runId ?? await getLatestRunIdFromCollection(tc, companySlug, tc.fact_groups);
      if (effectiveRunId) fgFilter.run_id = effectiveRunId;
      const groups = await tc.fact_groups.find(fgFilter).toArray();
      return Response.json({ groups });
    }
    case "verify_cards": {
      if (executionId) {
        const cards = await tc.verification_cards.find({ execution_id: executionId, demo_state_id: { $exists: false } }).toArray();
        if (cards.length > 0) return Response.json({ cards });
      }
      const vcFilter: Record<string, any> = {};
      const effectiveRunId =
        runId
        ?? baseRunIdFromState
        ?? await getLatestRunIdFromCollection(tc, companySlug, {
          distinct: (field: string) => tc.verification_cards.distinct(field, { demo_state_id: { $exists: false } }),
        })
        ?? await getLatestCompletedRunId(tc, companySlug);
      Object.assign(vcFilter, demoFilterForCollection(effectiveRunId ?? undefined));
      const cards = await tc.verification_cards.find(vcFilter).toArray();
      return Response.json({ cards });
    }
    case "entity_pages": {
      if (executionId) {
        const pages = await tc.entity_pages.find({ execution_id: executionId, demo_state_id: { $exists: false } }).toArray();
        if (pages.length > 0) return Response.json({ pages });
      }
      if (!runId && !executionId && isWorkspaceLikeState(activeDemoState)) {
        const pages = await tc.entity_pages.find(buildStateFilter(activeDemoState.state_id)).toArray();
        return Response.json({ pages });
      }
      const epFilter: Record<string, any> = {};
      let effectiveRunId = runId ?? baseRunIdFromState ?? undefined;
      if (!effectiveRunId) {
        const runIdsWithEP = await tc.entity_pages.distinct("run_id", { demo_state_id: { $exists: false } });
        effectiveRunId = runIdsWithEP.length > 0
          ? (await getLatestCompletedRunId(tc, companySlug, runIdsWithEP)) ?? undefined
          : undefined;
      }
      const latestEntityPagesExecId = effectiveRunId
        ? await getLatestCompletedStepExecutionId(tc, effectiveRunId, "pass1-step-14")
        : null;
      if (latestEntityPagesExecId) {
        epFilter.execution_id = latestEntityPagesExecId;
      } else if (effectiveRunId) {
        Object.assign(epFilter, baselineFilterForRun(effectiveRunId));
      } else {
        epFilter.demo_state_id = { $exists: false };
      }
      const pages = await tc.entity_pages.find(epFilter).toArray();
      return Response.json({ pages });
    }
    case "human_pages": {
      if (executionId) {
        const pages = await tc.human_pages.find({ execution_id: executionId }).toArray();
        if (pages.length > 0) return Response.json({ pages });
      }
      const hpFilter: Record<string, any> = {};
      let effectiveRunId = runId ?? baseRunIdFromState ?? undefined;
      if (!effectiveRunId) {
        const runIdsWithHP = await tc.human_pages.distinct("run_id");
        effectiveRunId = runIdsWithHP.length > 0
          ? (await getLatestCompletedRunId(tc, companySlug, runIdsWithHP)) ?? undefined
          : undefined;
      }
      const latestHumanPagesExecId = effectiveRunId
        ? await getLatestCompletedStepExecutionId(tc, effectiveRunId, "pass1-step-15")
        : null;
      if (latestHumanPagesExecId) {
        hpFilter.execution_id = latestHumanPagesExecId;
      } else if (effectiveRunId) {
        hpFilter.run_id = effectiveRunId;
      }
      const pages = await tc.human_pages.find(hpFilter).toArray();
      return Response.json({ pages });
    }
    case "runs": {
      const runs = await tc.runs.find({ company_slug: companySlug }).sort({ started_at: -1 }).toArray();
      return Response.json({ runs });
    }
    case "steps": {
      if (!runId) return Response.json({ error: "run_id required" }, { status: 400 });
      const steps = await tc.run_steps.find({ run_id: runId }).sort({ pass: 1, step_number: 1, execution_number: 1 }).toArray();
      return Response.json({ steps });
    }
    case "llm_calls": {
      const stepId = request.nextUrl.searchParams.get("step_id");
      const callId = request.nextUrl.searchParams.get("call_id");
      const executionId = request.nextUrl.searchParams.get("execution_id");
      const llmFilter: Record<string, any> = { ...filter };
      if (stepId) llmFilter.step_id = stepId;
      if (executionId) llmFilter.execution_id = executionId;
      if (callId) {
        llmFilter.call_id = callId;
        const call = await tc.llm_calls.findOne(llmFilter);
        return Response.json({ call });
      }
      const calls = await tc.llm_calls.find(llmFilter).sort({ timestamp: 1 }).toArray();
      return Response.json({ calls });
    }
    case "tickets": {
      if (executionId) {
        const tickets = await tc.tickets.find({ execution_id: executionId, demo_state_id: { $exists: false } }).sort({ created_at: -1 }).toArray();
        if (tickets.length > 0) return Response.json({ tickets });
      }
      const tFilter: Record<string, any> = {};
      const effectiveRunId =
        runId
        ?? baseRunIdFromState
        ?? await getLatestRunIdFromCollection(tc, companySlug, {
          distinct: (field: string) => tc.tickets.distinct(field, { demo_state_id: { $exists: false } }),
        })
        ?? await getLatestCompletedRunId(tc, companySlug);
      Object.assign(tFilter, demoFilterForCollection(effectiveRunId ?? undefined));
      const tickets = await tc.tickets.find(tFilter).sort({ created_at: -1 }).toArray();
      return Response.json({ tickets });
    }
    case "howto": {
      if (executionId) {
        const howtos = await tc.howto.find({ execution_id: executionId, demo_state_id: { $exists: false } }).sort({ created_at: -1 }).toArray();
        if (howtos.length > 0) return Response.json({ howtos });
      }
      const htFilter: Record<string, any> = {};
      const effectiveRunId =
        runId
        ?? baseRunIdFromState
        ?? await getLatestRunIdFromCollection(tc, companySlug, {
          distinct: (field: string) => tc.howto.distinct(field, { demo_state_id: { $exists: false } }),
        })
        ?? await getLatestCompletedRunId(tc, companySlug);
      Object.assign(htFilter, demoFilterForCollection(effectiveRunId ?? undefined));
      const howtos = await tc.howto.find(htFilter).sort({ created_at: -1 }).toArray();
      return Response.json({ howtos });
    }
    case "highlight_check": {
      const hcExecId = request.nextUrl.searchParams.get("execution_id");
      if (hcExecId) {
        const hcStep = await tc.run_steps.findOne({ execution_id: hcExecId });
        return Response.json({ highlight_failures: (hcStep as any)?.highlight_failures ?? null });
      }
      if (!runId) return Response.json({ error: "run_id or execution_id required" }, { status: 400 });
      const hcStepId = request.nextUrl.searchParams.get("step_id");
      if (!hcStepId) return Response.json({ error: "step_id required" }, { status: 400 });
      const hcStep = await tc.run_steps.findOne({ run_id: runId, step_id: hcStepId }, { sort: { execution_number: -1 } });
      return Response.json({ highlight_failures: (hcStep as any)?.highlight_failures ?? null });
    }
    case "parsed_doc": {
      const docId = request.nextUrl.searchParams.get("doc_id");
      if (!docId) return Response.json({ error: "Missing doc_id" }, { status: 400 });
      const sourceType = request.nextUrl.searchParams.get("source_type");
      const requestedParsedRunId = request.nextUrl.searchParams.get("run_id");

      const snapshotFilter: Record<string, any> = { company_slug: companySlug };
      if (requestedParsedRunId) {
        snapshotFilter.run_id = requestedParsedRunId;
      } else if (baseRunIdFromState) {
        snapshotFilter.run_id = baseRunIdFromState;
      } else {
        const latestRun = await tc.runs.findOne(
          { company_slug: companySlug, status: "completed" },
          { sort: { completed_at: -1 }, projection: { run_id: 1 } },
        );
        if (latestRun) snapshotFilter.run_id = latestRun.run_id;
      }

      let snapshot = await tc.input_snapshots.findOne(snapshotFilter, { sort: { created_at: -1 } });
      if (!snapshot) {
        snapshot = await tc.input_snapshots.findOne(
          { company_slug: companySlug },
          { sort: { created_at: -1 } },
        );
      }

      if (snapshot?.parsed_documents) {
        const docs = snapshot.parsed_documents as any[];
        const docIdLower = docId.toLowerCase();
        const sourceTypeLower = sourceType?.toLowerCase();

        const exactMatch = docs.find((d: any) => {
          const sid = (d.sourceId ?? "").toLowerCase();
          const did = (d.doc_id ?? d.id ?? "").toLowerCase();
          const idMatch = sid === docIdLower || did === docIdLower;
          if (!idMatch) return false;
          if (sourceTypeLower) {
            const provider = (d.provider ?? "").toLowerCase();
            return provider === sourceTypeLower;
          }
          return true;
        });
        if (exactMatch) return Response.json({ document: exactMatch });

        const titleMatch = docs.find((d: any) => {
          const title = (d.title ?? "").toLowerCase();
          const titleMatch = title === docIdLower;
          if (!titleMatch) return false;
          if (sourceTypeLower) {
            const provider = (d.provider ?? "").toLowerCase();
            return provider === sourceTypeLower;
          }
          return true;
        });
        if (titleMatch) return Response.json({ document: titleMatch });

        const partialMatch = docs.find((d: any) => {
          const title = (d.title ?? "").toLowerCase();
          if (docIdLower.startsWith(title) || title.startsWith(docIdLower)) {
            if (sourceTypeLower) {
              return (d.provider ?? "").toLowerCase() === sourceTypeLower;
            }
            return true;
          }
          return false;
        });
        if (partialMatch) return Response.json({ document: partialMatch });
      }

      return Response.json({ error: "Document not found" }, { status: 404 });
    }
    default:
      return Response.json({ error: `Unknown type: ${type}` }, { status: 400 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ companySlug: string }> },
) {
  const { companySlug } = await params;
  const body = await request.json();
  const tc = getTenantCollections(companySlug);

  switch (body.type) {
    case "save_highlight_check": {
      const { run_id, step_id, execution_id: saveExecId, highlight_failures } = body;
      if (!highlight_failures) {
        return Response.json({ error: "highlight_failures required" }, { status: 400 });
      }
      if (saveExecId) {
        await tc.run_steps.updateOne(
          { execution_id: saveExecId },
          { $set: { highlight_failures } },
        );
      } else if (run_id && step_id) {
        await tc.run_steps.updateOne(
          { run_id, step_id },
          { $set: { highlight_failures } },
        );
      } else {
        return Response.json({ error: "execution_id or (run_id + step_id) required" }, { status: 400 });
      }
      return Response.json({ ok: true });
    }
    default:
      return Response.json({ error: `Unknown POST type: ${body.type}` }, { status: 400 });
  }
}
