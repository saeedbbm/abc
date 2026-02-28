import { kb2RawInputsCollection, kb2InputSnapshotsCollection } from "@/lib/mongodb";
import { parseConfluenceApiResponse, type KB2ParsedDocument } from "@/src/application/lib/kb2/confluence-parser";
import { parseJiraApiResponse } from "@/src/application/lib/kb2/jira-parser";
import { parseSlackApiResponse } from "@/src/application/lib/kb2/slack-parser";
import { parseGithubApiResponse } from "@/src/application/lib/kb2/github-parser";
import { parseFeedbackApiResponse } from "@/src/application/lib/kb2/feedback-parser";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";

/**
 * Step 1: Input Snapshot
 *
 * Reads raw API responses from kb2_raw_inputs (stored via POST /api/.../kb2/input),
 * parses each source into KB2ParsedDocuments, and stores the snapshot.
 */

const SOURCE_PARSERS: Record<string, (data: unknown) => KB2ParsedDocument[]> = {
  confluence: parseConfluenceApiResponse,
  jira: parseJiraApiResponse,
  slack: parseSlackApiResponse,
  github: parseGithubApiResponse,
  customerFeedback: parseFeedbackApiResponse,
};

function parseGenericSource(source: string, data: unknown): KB2ParsedDocument[] {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return [
    {
      id: `${source}-raw`,
      provider: source,
      sourceType: `${source}_raw`,
      sourceId: `${source}-0`,
      title: `${source} (raw)`,
      content: text,
      metadata: {},
    },
  ];
}

export const inputSnapshotStep: StepFunction = async (ctx) => {
  const companySlug = "brewandgo2";

  const rawInputs = await kb2RawInputsCollection
    .find({ company_slug: companySlug })
    .toArray();

  if (rawInputs.length === 0) {
    throw new Error(
      `No raw inputs found for company_slug=${companySlug}. ` +
      `Upload data via POST /api/${companySlug}/kb2/input first.`,
    );
  }

  ctx.onProgress(`Found ${rawInputs.length} source(s). Parsing...`, 10);

  const allDocs: KB2ParsedDocument[] = [];
  const stats: Record<string, number> = {};

  for (const input of rawInputs) {
    const source = input.source as string;
    const parser = SOURCE_PARSERS[source];
    const docs = parser
      ? parser(input.data)
      : parseGenericSource(source, input.data);

    allDocs.push(...docs);
    stats[source] = docs.length;
  }

  ctx.onProgress(`Parsed ${allDocs.length} documents. Saving snapshot...`, 70);

  await kb2InputSnapshotsCollection.updateOne(
    { run_id: ctx.runId },
    {
      $set: {
        run_id: ctx.runId,
        company_slug: companySlug,
        parsed_documents: allDocs,
        stats: { ...stats, total: allDocs.length },
        created_at: new Date().toISOString(),
      },
    },
    { upsert: true },
  );

  ctx.onProgress(`Snapshot saved: ${allDocs.length} documents`, 100);

  return {
    total_documents: allDocs.length,
    by_source: stats,
  };
};
