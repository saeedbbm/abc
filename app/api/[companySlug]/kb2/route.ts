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
} from "@/lib/mongodb";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ companySlug: string }> },
) {
  const { companySlug } = await params;
  const type = request.nextUrl.searchParams.get("type");
  const runId = request.nextUrl.searchParams.get("run_id");

  const filter: Record<string, any> = {};
  if (runId) filter.run_id = runId;

  switch (type) {
    case "raw_input": {
      const rawInputs = await kb2RawInputsCollection
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
          raw_json: JSON.stringify(input.data, null, 2),
        };
      }

      return Response.json({
        exists: true,
        company_slug: companySlug,
        sources,
      });
    }
    case "inputs": {
      const doc = await kb2InputSnapshotsCollection.findOne(filter, { sort: { created_at: -1 } });
      return Response.json({ snapshot: doc });
    }
    case "parsed_doc": {
      const docId = request.nextUrl.searchParams.get("doc_id");
      if (!docId) return Response.json({ error: "doc_id required" }, { status: 400 });
      const latestSnapshot = await kb2InputSnapshotsCollection.findOne(
        filter.run_id ? filter : { company_slug: companySlug },
        { sort: { created_at: -1 } },
      );
      if (!latestSnapshot?.parsed_documents) return Response.json({ doc: null });
      const parsedDoc = (latestSnapshot.parsed_documents as any[]).find(
        (d: any) => d.sourceId === docId || d.id === docId || d.title === docId,
      );
      return Response.json({ doc: parsedDoc ?? null });
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
      const cards = await kb2VerificationCardsCollection.find(filter).toArray();
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
      const runs = await kb2RunsCollection.find({ company_slug: companySlug }).sort({ started_at: -1 }).toArray();
      return Response.json({ runs });
    }
    case "steps": {
      if (!runId) return Response.json({ error: "run_id required" }, { status: 400 });
      const steps = await kb2RunStepsCollection.find({ run_id: runId }).sort({ pass: 1, step_number: 1 }).toArray();
      return Response.json({ steps });
    }
    case "llm_calls": {
      const stepId = request.nextUrl.searchParams.get("step_id");
      const llmFilter: Record<string, any> = { ...filter };
      if (stepId) llmFilter.step_id = stepId;
      const calls = await kb2LLMCallsCollection.find(llmFilter).sort({ timestamp: 1 }).toArray();
      return Response.json({ calls });
    }
    case "tickets": {
      const tickets = await kb2TicketsCollection.find(filter).sort({ created_at: -1 }).toArray();
      return Response.json({ tickets });
    }
    case "howto": {
      const howtos = await kb2HowtoCollection.find(filter).sort({ created_at: -1 }).toArray();
      return Response.json({ howtos });
    }
    default:
      return Response.json({ error: `Unknown type: ${type}` }, { status: 400 });
  }
}
