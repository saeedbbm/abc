import { NextRequest } from "next/server";
import {
  kb2RawInputsCollection,
  kb2InputSnapshotsCollection,
  kb2GraphNodesCollection,
  kb2GraphEdgesCollection,
  kb2ClaimsCollection,
  kb2FactGroupsCollection,
  kb2VerificationCardsCollection,
  kb2EntityPagesCollection,
  kb2HumanPagesCollection,
  kb2RunsCollection,
  kb2RunStepsCollection,
  kb2LLMCallsCollection,
  kb2TicketsCollection,
  kb2HowtoCollection,
  kb2PeopleCollection,
  getTenantCollections,
} from "@/lib/mongodb";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ companySlug: string }> },
) {
  const { companySlug } = await params;
  const type = request.nextUrl.searchParams.get("type");
  const runId = request.nextUrl.searchParams.get("run_id");
  const tc = getTenantCollections(companySlug);

  const filter: Record<string, any> = {};
  if (runId) filter.run_id = runId;

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
      const doc = await tc.input_snapshots.findOne(filter, { sort: { created_at: -1 } });
      return Response.json({ snapshot: doc });
    }
    case "people": {
      const people = await tc.people.find({ company_slug: companySlug }).toArray();
      if (people.length > 0) {
        return Response.json({ people });
      }

      const peopleFilter: Record<string, any> = { node_type: "team_member" };
      if (!filter.run_id) {
        const runIdsWithEP = await tc.entity_pages.distinct("run_id");
        if (runIdsWithEP.length > 0) {
          const latestRun = await tc.runs.findOne(
            { run_id: { $in: runIdsWithEP }, company_slug: companySlug, status: "completed" },
            { sort: { completed_at: -1 }, projection: { run_id: 1 } },
          );
          if (latestRun) peopleFilter.run_id = latestRun.run_id;
        }
      } else {
        peopleFilter.run_id = filter.run_id;
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
      const gnFilter = { ...filter };
      if (!gnFilter.run_id) {
        const runIdsWithNodes = await kb2GraphNodesCollection.distinct("run_id");
        if (runIdsWithNodes.length > 0) {
          const latestRun = await kb2RunsCollection.findOne(
            { run_id: { $in: runIdsWithNodes }, company_slug: companySlug, status: "completed" },
            { sort: { completed_at: -1 }, projection: { run_id: 1 } },
          );
          if (latestRun) gnFilter.run_id = latestRun.run_id;
        }
      }
      const nodes = await kb2GraphNodesCollection.find(gnFilter).toArray();
      return Response.json({ nodes });
    }
    case "graph_edges": {
      const edges = await kb2GraphEdgesCollection.find(filter).toArray();
      return Response.json({ edges });
    }
    case "claims": {
      const claims = await kb2ClaimsCollection.find(filter).toArray();
      return Response.json({ claims });
    }
    case "fact_groups": {
      const groups = await kb2FactGroupsCollection.find(filter).toArray();
      return Response.json({ groups });
    }
    case "verify_cards": {
      const vcFilter = { ...filter };
      if (!vcFilter.run_id) {
        const runIdsWithCards = await kb2VerificationCardsCollection.distinct("run_id");
        if (runIdsWithCards.length > 0) {
          const latestRun = await kb2RunsCollection.findOne(
            { run_id: { $in: runIdsWithCards }, company_slug: companySlug, status: "completed" },
            { sort: { completed_at: -1 }, projection: { run_id: 1 } },
          );
          if (latestRun) vcFilter.run_id = latestRun.run_id;
        }
      }
      const cards = await kb2VerificationCardsCollection.find(vcFilter).toArray();
      return Response.json({ cards });
    }
    case "entity_pages": {
      const epFilter = { ...filter };
      if (!epFilter.run_id) {
        const runIdsWithEP = await kb2EntityPagesCollection.distinct("run_id");
        if (runIdsWithEP.length > 0) {
          const latestRun = await kb2RunsCollection.findOne(
            { run_id: { $in: runIdsWithEP }, company_slug: companySlug, status: "completed" },
            { sort: { completed_at: -1 }, projection: { run_id: 1 } },
          );
          if (latestRun) epFilter.run_id = latestRun.run_id;
        }
      }
      const pages = await kb2EntityPagesCollection.find(epFilter).toArray();
      return Response.json({ pages });
    }
    case "human_pages": {
      const hpFilter = { ...filter };
      if (!hpFilter.run_id) {
        const runIdsWithHP = await kb2HumanPagesCollection.distinct("run_id");
        if (runIdsWithHP.length > 0) {
          const latestRun = await kb2RunsCollection.findOne(
            { run_id: { $in: runIdsWithHP }, company_slug: companySlug, status: "completed" },
            { sort: { completed_at: -1 }, projection: { run_id: 1 } },
          );
          if (latestRun) hpFilter.run_id = latestRun.run_id;
        }
      }
      const pages = await kb2HumanPagesCollection.find(hpFilter).toArray();
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
      const tFilter = { ...filter };
      if (!tFilter.run_id) {
        const runIdsWithTickets = await kb2TicketsCollection.distinct("run_id");
        if (runIdsWithTickets.length > 0) {
          const latestRun = await kb2RunsCollection.findOne(
            { run_id: { $in: runIdsWithTickets }, company_slug: companySlug, status: "completed" },
            { sort: { completed_at: -1 }, projection: { run_id: 1 } },
          );
          if (latestRun) tFilter.run_id = latestRun.run_id;
        }
      }
      const tickets = await kb2TicketsCollection.find(tFilter).sort({ created_at: -1 }).toArray();
      return Response.json({ tickets });
    }
    case "howto": {
      const htFilter = { ...filter };
      if (!htFilter.run_id) {
        const runIdsWithHowto = await kb2HowtoCollection.distinct("run_id");
        if (runIdsWithHowto.length > 0) {
          const latestRun = await kb2RunsCollection.findOne(
            { run_id: { $in: runIdsWithHowto }, company_slug: companySlug, status: "completed" },
            { sort: { completed_at: -1 }, projection: { run_id: 1 } },
          );
          if (latestRun) htFilter.run_id = latestRun.run_id;
        }
      }
      const howtos = await kb2HowtoCollection.find(htFilter).sort({ created_at: -1 }).toArray();
      return Response.json({ howtos });
    }
    case "graph_nodes": {
      if (!runId) return Response.json({ error: "run_id required" }, { status: 400 });
      const nodes = await tc.graph_nodes.find({ run_id: runId }).toArray();
      return Response.json({ nodes });
    }
    case "parsed_doc": {
      const docId = request.nextUrl.searchParams.get("doc_id");
      if (!docId) return Response.json({ error: "Missing doc_id" }, { status: 400 });
      const sourceType = request.nextUrl.searchParams.get("source_type");
      const runId = request.nextUrl.searchParams.get("run_id");

      const snapshotFilter: Record<string, any> = { company_slug: companySlug };
      if (runId) {
        snapshotFilter.run_id = runId;
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
      }

      return Response.json({ error: "Document not found" }, { status: 404 });
    }
    default:
      return Response.json({ error: `Unknown type: ${type}` }, { status: 400 });
  }
}
