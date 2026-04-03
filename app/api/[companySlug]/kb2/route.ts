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

  function normalizeSourceProvider(value?: string | null): string {
    const normalized = (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (normalized === "feedback" || normalized === "customerfeedback") {
      return "customerfeedback";
    }
    return normalized;
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

  async function getLatestStepExecutionIds(
    targetRunId: string,
    stepIds: string[],
  ): Promise<string[]> {
    const executionIds = await Promise.all(
      stepIds.map((stepId) => getLatestCompletedStepExecutionId(tc, targetRunId, stepId)),
    );
    return executionIds.filter(
      (executionId): executionId is string =>
        typeof executionId === "string" && executionId.trim().length > 0,
    );
  }

  function buildExecutionScopedFilter(
    scopeFilter: Record<string, any>,
    executionIds: string[],
    includeDocsWithoutExecution = false,
  ): Record<string, any> {
    if (executionIds.length === 0) return { ...scopeFilter };

    const executionFilter =
      executionIds.length === 1
        ? { execution_id: executionIds[0] }
        : { execution_id: { $in: executionIds } };

    if (!includeDocsWithoutExecution) {
      return { ...scopeFilter, ...executionFilter };
    }

    return {
      $or: [
        { ...scopeFilter, ...executionFilter },
        { ...scopeFilter, execution_id: { $exists: false } },
        { ...scopeFilter, execution_id: null },
      ],
    };
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
        const stateFilter = buildStateFilter(activeDemoState.state_id) as Record<string, any>;
        const latestNodeExecIds = baseRunIdFromState
          ? await getLatestStepExecutionIds(baseRunIdFromState, [
              "pass1-step-9",
              "pass1-step-10",
              "pass1-step-11",
            ])
          : [];
        const nodes = await tc.graph_nodes.find(
          latestNodeExecIds.length > 0
            ? buildExecutionScopedFilter(stateFilter, latestNodeExecIds)
            : stateFilter,
        ).toArray();
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
        const latestNodeExecIds = await getLatestStepExecutionIds(effectiveRunId, [
          "pass1-step-9",
          "pass1-step-10",
          "pass1-step-11",
        ]);
        if (latestNodeExecIds.length > 0) {
          const nodes = await tc.graph_nodes.find(
            buildExecutionScopedFilter(
              baselineFilterForRun(effectiveRunId),
              latestNodeExecIds,
            ),
          ).toArray();
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
      if (!runId && !executionId && isWorkspaceLikeState(activeDemoState)) {
        const stateFilter = buildStateFilter(activeDemoState.state_id) as Record<string, any>;
        const latestVCExecIds = baseRunIdFromState
          ? await getLatestStepExecutionIds(baseRunIdFromState, ["pass1-step-18"])
          : [];
        const cards = await tc.verification_cards.find(
          latestVCExecIds.length > 0
            ? buildExecutionScopedFilter(stateFilter, latestVCExecIds, true)
            : stateFilter,
        ).toArray();
        return Response.json({ cards });
      }
      let effectiveVCRunId = runId ?? baseRunIdFromState ?? undefined;
      if (!effectiveVCRunId) {
        const runIdsWithVC = await tc.verification_cards.distinct("run_id", { demo_state_id: { $exists: false } });
        effectiveVCRunId = runIdsWithVC.length > 0
          ? (await getLatestCompletedRunId(tc, companySlug, runIdsWithVC)) ?? undefined
          : undefined;
      }
      const latestVCExecId = effectiveVCRunId
        ? await getLatestCompletedStepExecutionId(tc, effectiveVCRunId, "pass1-step-18")
        : null;
      const vcFilter: Record<string, any> = {};
      if (latestVCExecId) {
        Object.assign(
          vcFilter,
          buildExecutionScopedFilter(
            baselineFilterForRun(effectiveVCRunId!),
            [latestVCExecId],
            true,
          ),
        );
      } else if (effectiveVCRunId) {
        Object.assign(vcFilter, demoFilterForCollection(effectiveVCRunId ?? undefined));
      } else {
        vcFilter.demo_state_id = { $exists: false };
      }
      const cards = await tc.verification_cards.find(vcFilter).toArray();
      return Response.json({ cards });
    }
    case "entity_pages": {
      if (executionId) {
        const pages = await tc.entity_pages.find({ execution_id: executionId, demo_state_id: { $exists: false } }).toArray();
        if (pages.length > 0) return Response.json({ pages });
      }
      if (!runId && !executionId && isWorkspaceLikeState(activeDemoState)) {
        const stateFilter = buildStateFilter(activeDemoState.state_id) as Record<string, any>;
        const latestEntityPagesExecIds = baseRunIdFromState
          ? await getLatestStepExecutionIds(baseRunIdFromState, ["pass1-step-14"])
          : [];
        const pages = await tc.entity_pages.find(
          latestEntityPagesExecIds.length > 0
            ? buildExecutionScopedFilter(stateFilter, latestEntityPagesExecIds)
            : stateFilter,
        ).toArray();
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
        Object.assign(
          epFilter,
          buildExecutionScopedFilter(
            baselineFilterForRun(effectiveRunId!),
            [latestEntityPagesExecId],
          ),
        );
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
      if (!runId && !executionId && isWorkspaceLikeState(activeDemoState)) {
        const stateFilter = buildStateFilter(activeDemoState.state_id) as Record<string, any>;
        const latestHowtoExecIds = baseRunIdFromState
          ? await getLatestStepExecutionIds(baseRunIdFromState, ["pass1-step-16"])
          : [];
        const howtos = await tc.howto.find(
          latestHowtoExecIds.length > 0
            ? buildExecutionScopedFilter(stateFilter, latestHowtoExecIds, true)
            : stateFilter,
        ).sort({ created_at: -1 }).toArray();
        return Response.json({ howtos });
      }
      let effectiveHowtoRunId = runId ?? baseRunIdFromState ?? undefined;
      if (!effectiveHowtoRunId) {
        const runIdsWithHowto = await tc.howto.distinct("run_id", { demo_state_id: { $exists: false } });
        effectiveHowtoRunId = runIdsWithHowto.length > 0
          ? (await getLatestCompletedRunId(tc, companySlug, runIdsWithHowto)) ?? undefined
          : undefined;
      }
      const latestHowtoExecId = effectiveHowtoRunId
        ? await getLatestCompletedStepExecutionId(tc, effectiveHowtoRunId, "pass1-step-16")
        : null;
      const htFilter: Record<string, any> = {};
      if (latestHowtoExecId) {
        Object.assign(
          htFilter,
          buildExecutionScopedFilter(
            baselineFilterForRun(effectiveHowtoRunId!),
            [latestHowtoExecId],
            true,
          ),
        );
      } else if (effectiveHowtoRunId) {
        Object.assign(htFilter, buildBaselineRunFilter(effectiveHowtoRunId));
      } else {
        htFilter.demo_state_id = { $exists: false };
      }
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
        const normalizedSourceType = normalizeSourceProvider(sourceType);

        const exactMatch = docs.find((d: any) => {
          const sid = (d.sourceId ?? "").toLowerCase();
          const did = (d.doc_id ?? d.id ?? "").toLowerCase();
          const idMatch = sid === docIdLower || did === docIdLower;
          if (!idMatch) return false;
          if (normalizedSourceType) {
            return normalizeSourceProvider(d.provider ?? "") === normalizedSourceType;
          }
          return true;
        });
        if (exactMatch) return Response.json({ document: exactMatch });

        const titleMatch = docs.find((d: any) => {
          const title = (d.title ?? "").toLowerCase();
          const titleMatch = title === docIdLower;
          if (!titleMatch) return false;
          if (normalizedSourceType) {
            return normalizeSourceProvider(d.provider ?? "") === normalizedSourceType;
          }
          return true;
        });
        if (titleMatch) return Response.json({ document: titleMatch });

        const partialMatch = docs.find((d: any) => {
          const title = (d.title ?? "").toLowerCase();
          if (docIdLower.startsWith(title) || title.startsWith(docIdLower)) {
            if (normalizedSourceType) {
              return normalizeSourceProvider(d.provider ?? "") === normalizedSourceType;
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
  const type = body.type ?? request.nextUrl.searchParams.get("type");

  switch (type) {
    case "howto": {
      const { howto_id, section_name, content } = body;
      if (!howto_id || !section_name || typeof content !== "string") {
        return Response.json({ error: "howto_id, section_name, and content are required" }, { status: 400 });
      }
      const updated_at = new Date().toISOString();
      await tc.howto.updateOne(
        { howto_id },
        {
          $set: {
            "sections.$[section].content": content,
            "sections.$[section].steps": [],
            "sections.$[section].source_refs": [],
            "sections.$[section].entity_refs": [],
            updated_at,
          },
        },
        {
          arrayFilters: [{ "section.section_name": section_name }],
        },
      );
      return Response.json({ ok: true });
    }
    case "howto_comment": {
      const howto_id = typeof body.howto_id === "string" ? body.howto_id : "";
      const comment = typeof body.comment === "string" ? body.comment.trim() : "";
      if (!howto_id || !comment) {
        return Response.json({ error: "howto_id and comment are required" }, { status: 400 });
      }
      const updated_at = new Date().toISOString();
      const author =
        typeof body.author === "string" && body.author.trim().length > 0
          ? body.author.trim()
          : "Teammate";
      await tc.howto.updateOne(
        { howto_id },
        {
          $push: {
            discussion: {
              author,
              text: comment,
              timestamp: updated_at,
            },
          },
          $set: { updated_at },
        } as any,
      );
      return Response.json({ ok: true });
    }
    case "howto_meta": {
      const howto_id = typeof body.howto_id === "string" ? body.howto_id : "";
      if (!howto_id) {
        return Response.json({ error: "howto_id is required" }, { status: 400 });
      }
      const allowedStatuses = new Set(["draft", "in_review", "approved", "archived"]);
      const plan_status =
        typeof body.plan_status === "string" && allowedStatuses.has(body.plan_status)
          ? body.plan_status
          : "draft";
      const owner_name = typeof body.owner_name === "string" ? body.owner_name.trim() : "";
      const reviewers = Array.isArray(body.reviewers)
        ? body.reviewers
            .filter((reviewer: unknown): reviewer is string => typeof reviewer === "string")
            .map((reviewer: string) => reviewer.trim())
            .filter(Boolean)
        : [];
      await tc.howto.updateOne(
        { howto_id },
        {
          $set: {
            plan_status,
            owner_name,
            reviewers,
            updated_at: new Date().toISOString(),
          },
        },
      );
      return Response.json({ ok: true });
    }
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
      return Response.json({ error: `Unknown POST type: ${type}` }, { status: 400 });
  }
}
