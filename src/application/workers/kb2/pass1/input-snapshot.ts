import { getTenantCollections } from "@/lib/mongodb";
import { parseConfluenceApiResponse, type KB2ParsedDocument } from "@/src/application/lib/kb2/confluence-parser";
import { parseJiraApiResponse } from "@/src/application/lib/kb2/jira-parser";
import { parseSlackApiResponse } from "@/src/application/lib/kb2/slack-parser";
import { parseGithubApiResponse } from "@/src/application/lib/kb2/github-parser";
import { parseFeedbackApiResponse } from "@/src/application/lib/kb2/feedback-parser";
import {
  parseConfluenceHumanText,
  parseJiraHumanText,
  parseSlackHumanText,
  parseGithubHumanText,
  parseFeedbackHumanText,
} from "@/src/application/lib/kb2/human-text-parsers";
import {
  buildStructuredDataFromInput,
  parseStructuredDataToParsedDocuments,
} from "@/src/application/lib/kb2/structured-source-input";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";

/**
 * Step 1: Input Snapshot
 *
 * Reads raw inputs from kb2_raw_inputs (stored via POST /api/.../kb2/input).
 * Detects whether each source is JSON (API response) or human-readable text,
 * routes to the appropriate parser, and stores the snapshot.
 */

const JSON_PARSERS: Record<string, (data: unknown) => KB2ParsedDocument[]> = {
  confluence: parseConfluenceApiResponse,
  jira: parseJiraApiResponse,
  slack: parseSlackApiResponse,
  github: parseGithubApiResponse,
  customerFeedback: parseFeedbackApiResponse,
};

const HUMAN_TEXT_PARSERS: Record<string, (text: string) => KB2ParsedDocument[]> = {
  confluence: parseConfluenceHumanText,
  jira: parseJiraHumanText,
  slack: parseSlackHumanText,
  github: parseGithubHumanText,
  customerFeedback: parseFeedbackHumanText,
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
      sections: [{ heading: `${source} (raw)`, content: text, start_offset: 0, end_offset: text.length }],
      metadata: {},
    },
  ];
}

function isHumanText(data: unknown): data is string {
  return typeof data === "string";
}

export const inputSnapshotStep: StepFunction = async (ctx) => {
  const companySlug = ctx.companySlug;
  const tc = getTenantCollections(companySlug);

  const rawInputs = await tc.raw_inputs
    .find({ company_slug: companySlug })
    .toArray();

  if (rawInputs.length === 0) {
    throw new Error(
      `No raw inputs found for company_slug=${companySlug}. ` +
      `Upload data via POST /api/${companySlug}/kb2/input first.`,
    );
  }

  await ctx.onProgress(`Found ${rawInputs.length} source(s). Parsing...`, 10);

  const allDocs: KB2ParsedDocument[] = [];
  const stats: Record<string, number> = {};
  const sourceUnitsBySource: Record<string, number> = {};
  const rawStats: Record<string, {
    chars: number;
    format: "human_text" | "json";
    structured_json?: boolean;
  }> = {};

  for (const input of rawInputs) {
    const source = input.source as string;
    let docs: KB2ParsedDocument[];
    let structuredData = input.structured_data;

    if (!structuredData) {
      structuredData = buildStructuredDataFromInput(source, input.data);
      if (structuredData && input._id) {
        await tc.raw_inputs.updateOne(
          { _id: input._id },
          {
            $set: {
              structured_data: structuredData,
              structured_at: new Date().toISOString(),
              input_format: isHumanText(input.data) ? "human_text" : "json",
              ...(isHumanText(input.data) ? { raw_text: input.data } : {}),
            },
          },
        );
      }
    }

    if (isHumanText(input.data)) {
      rawStats[source] = {
        chars: input.data.length,
        format: "human_text",
        structured_json: Boolean(structuredData),
      };

      if (structuredData) {
        docs = parseStructuredDataToParsedDocuments(source, structuredData);
        if (docs.length === 0) {
          const humanParser = HUMAN_TEXT_PARSERS[source];
          docs = humanParser ? humanParser(input.data) : parseGenericSource(source, input.data);
        }
      } else {
        const humanParser = HUMAN_TEXT_PARSERS[source];
        docs = humanParser ? humanParser(input.data) : parseGenericSource(source, input.data);
      }
    } else {
      rawStats[source] = {
        chars: JSON.stringify(input.data).length,
        format: "json",
        structured_json: Boolean(structuredData),
      };
      if (structuredData) {
        docs = parseStructuredDataToParsedDocuments(source, structuredData);
        if (docs.length === 0) {
          const jsonParser = JSON_PARSERS[source];
          docs = jsonParser ? jsonParser(input.data) : parseGenericSource(source, input.data);
        }
      } else {
        const jsonParser = JSON_PARSERS[source];
        docs = jsonParser ? jsonParser(input.data) : parseGenericSource(source, input.data);
      }
    }

    allDocs.push(...docs);
    stats[source] = docs.length;
    sourceUnitsBySource[source] = docs.reduce((sum, doc) => {
      const units = Array.isArray(doc.metadata?.source_units) ? doc.metadata.source_units.length : 0;
      return sum + Math.max(units, 1);
    }, 0);
  }

  await ctx.onProgress(`Parsed ${allDocs.length} documents. Saving snapshot...`, 70);

  await tc.input_snapshots.insertOne({
    run_id: ctx.runId,
    execution_id: ctx.executionId,
    company_slug: companySlug,
    parsed_documents: allDocs,
    artifact_version: "pass1_v2",
    stats: { ...stats, total: allDocs.length },
    source_units_by_source: sourceUnitsBySource,
    raw_stats: rawStats,
    created_at: new Date().toISOString(),
  });

  await ctx.onProgress(`Snapshot saved: ${allDocs.length} documents`, 100);

  const sampledDocuments = allDocs.slice(0, 12).map((doc) => {
    const sourceUnits = Array.isArray(doc.metadata?.source_units)
      ? doc.metadata.source_units as Array<Record<string, unknown>>
      : [];
    return {
      doc_id: doc.id,
      source_id: doc.sourceId,
      provider: doc.provider,
      source_type: doc.sourceType,
      title: doc.title,
      metadata_keys: Object.keys((doc.metadata ?? {}) as Record<string, unknown>).slice(0, 8),
      source_unit_count: sourceUnits.length,
      source_units: sourceUnits.slice(0, 3).map((unit) => ({
        unit_id: unit.unit_id,
        kind: unit.kind,
        anchor: unit.anchor,
        title: unit.title,
      })),
    };
  });

  return {
    total_documents: allDocs.length,
    by_source: stats,
    source_units_by_source: sourceUnitsBySource,
    raw_stats: rawStats,
    sampled_documents: sampledDocuments,
    artifact_version: "pass1_v2",
  };
};
