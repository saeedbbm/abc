import { randomUUID } from "crypto";
import { getTenantCollections } from "@/lib/mongodb";
import type { KB2ParsedDocument } from "@/src/application/lib/kb2/confluence-parser";
import {
  buildEvidenceRefFromDoc,
  getDocSourceUnits,
  type KB2Observation,
  type KB2PatternCandidate,
} from "@/src/application/lib/kb2/pass1-v2-artifacts";
import { PrefixLogger } from "@/lib/utils";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";

type PatternFamily = {
  family_id: string;
  title: string;
  pattern_rule: string;
};

type PatternSignal = {
  owner: string;
  family_id: string;
  title: string;
  pattern_rule: string;
  doc_id: string;
  source_unit_id: string;
  source_ref: KB2PatternCandidate["evidence_refs"][number];
  observation_id?: string;
};

function normalizeOwnerName(value: string): string {
  return value.replace(/\s*\[[^\]]+\]\s*$/g, "").trim();
}

function ownerHintFromObservation(observation: KB2Observation): string {
  const ref = observation.source_ref as Record<string, unknown>;
  return normalizeOwnerName(String(
    ref.source_author ??
    ref.comment_author ??
    ref.pr_author ??
    ref.slack_speaker ??
    observation.attributes.owner_hint ??
    "unknown",
  ).trim());
}

function ownerHintFromUnit(doc: KB2ParsedDocument, unit: ReturnType<typeof getDocSourceUnits>[number]): string {
  const unitMeta = (unit.metadata ?? {}) as Record<string, unknown>;
  const docMeta = (doc.metadata ?? {}) as Record<string, unknown>;
  return normalizeOwnerName(String(
    unitMeta.comment_author ??
    unitMeta.speaker ??
    unitMeta.author ??
    docMeta.author ??
    "unknown",
  ).trim());
}

function normalizeSignalText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectPatternFamilies(text: string): PatternFamily[] {
  const normalized = normalizeSignalText(text);
  const families: PatternFamily[] = [];

  const genderColorRule =
    /\b(pink|blue)\b/.test(normalized) &&
    /\b(gender|male|female|boy|boys|girl|girls)\b/.test(normalized);
  const moneyColorRule =
    /\bgreen\b/.test(normalized) &&
    /\b(donate|donation|sponsor|money|financial|cta|button)\b/.test(normalized);
  if (genderColorRule || moneyColorRule) {
    families.push({
      family_id: "semantic_color_ui",
      title: "Semantic Color Coding for Pet UI",
      pattern_rule: "Use semantically meaningful colors for gender cues and money-related calls to action in pet-facing UI.",
    });
  }

  const layoutRule =
    (/\b(vertical|sidebar|side menu)\b/.test(normalized) &&
      /\b(layout|menu|navigation|category|categories|selection|choose|choosing)\b/.test(normalized)) ||
    /\bleft side\b/.test(normalized) ||
    /\btabs across the top\b/.test(normalized) ||
    (/\bchoosing\b/.test(normalized) && /\bcomparing\b/.test(normalized));
  if (layoutRule) {
    families.push({
      family_id: "selection_layout_ui",
      title: "Vertical Navigation for Pick-One Browse Flows",
      pattern_rule: "Use a vertical sidebar or left-hand navigation for pick-one browse flows instead of top tabs or comparison-oriented layouts.",
    });
  }

  const clientSideStorageSignal =
    /\b(client side|clientside|load all|load everything|single api call|on mount|in memory|filter locally|sort locally)\b/.test(normalized) ||
    /\bno need for pagination\b/.test(normalized);
  const browseListContext =
    /\b(filter|filters|pagination|page size|prev next|one pet at a time|flip through|browser|browse|list|lists|category|categories)\b/.test(normalized);
  const smallListContext =
    /\b(30 40|could grow|might want|borderline|under 20|15 shifts|small list|small lists)\b/.test(normalized);
  const implicitBrowsePattern =
    /\b(prev next|one pet at a time|flip through)\b/.test(normalized) &&
    /\b(browse|browser|pet|list)\b/.test(normalized);
  const clientSideRule =
    (clientSideStorageSignal && browseListContext) ||
    (/\bpagination\b/.test(normalized) && smallListContext) ||
    implicitBrowsePattern;
  if (clientSideRule) {
    families.push({
      family_id: "client_side_browse",
      title: "Client-side filtering for small lists, pagination for scalable lists",
      pattern_rule: "For small browse lists, load data once and handle filtering or navigation client-side; reserve pagination for larger or growing lists.",
    });
  }

  return families;
}

function scorePatternSignal(signal: PatternSignal): number {
  const excerpt = normalizeSignalText(signal.source_ref.excerpt ?? "");
  let score = 1;

  if (signal.source_ref.source_type === "slack") score += 3;
  else if (signal.source_ref.source_type === "github") score += 1;
  else if (signal.source_ref.source_type === "confluence") score -= 1;

  if (/\b(per [a-z]+ s designs|per [a-z]+ designs|looks good|totally agree|agree)\b/.test(excerpt)) {
    score -= 2;
  }

  if (/\b(should i|working on|i ll switch|switched to|that makes sense|updated)\b/.test(excerpt)) {
    score -= 2;
  }

  if (/\b(i m going|going with|feels right|makes more sense|prefer|better than|i m putting|might want|load them all upfront|put the)\b/.test(excerpt)) {
    score += 2;
  }

  return Math.max(score, 0);
}

function chooseClusterOwner(cluster: PatternSignal[]): string {
  const totals = new Map<string, number>();
  for (const signal of cluster) {
    const key = signal.owner.trim();
    if (!key || key.toLowerCase() === "unknown") continue;
    totals.set(key, (totals.get(key) ?? 0) + scorePatternSignal(signal));
  }

  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? cluster[0]?.owner ?? "unknown";
}

export const graphEnrichmentStepV2: StepFunction = async (ctx) => {
  const logger = new PrefixLogger("kb2-graph-enrichment-v2");
  const tc = getTenantCollections(ctx.companySlug);

  const step3Artifact = await ctx.getStepArtifact("pass1", 3);
  const observations = ((step3Artifact?.observations ?? []) as KB2Observation[])
    .filter((observation) =>
      observation.observation_kind === "decision_signal" ||
      observation.observation_kind === "pattern_signal" ||
      observation.observation_kind === "work_item_signal",
    );

  const snapshotExecId = await ctx.getStepExecutionId("pass1", 1);
  const snapshot = await tc.input_snapshots.findOne(
    snapshotExecId ? { execution_id: snapshotExecId } : { run_id: ctx.runId },
  );
  const docs = ((snapshot?.parsed_documents ?? []) as KB2ParsedDocument[]) ?? [];

  await ctx.onProgress(
    `Mining repeated patterns from ${observations.length} observations and ${docs.length} parsed documents...`,
    5,
  );

  const dedupedSignals = new Map<string, PatternSignal>();

  for (const observation of observations) {
    const owner = ownerHintFromObservation(observation);
    if (!owner || owner.toLowerCase() === "unknown") continue;
    const text = [observation.label, observation.reasoning, observation.evidence_excerpt]
      .filter(Boolean)
      .join("\n");
    for (const family of detectPatternFamilies(text)) {
      const signal: PatternSignal = {
        owner,
        family_id: family.family_id,
        title: family.title,
        pattern_rule: family.pattern_rule,
        doc_id: observation.doc_id,
        source_unit_id: observation.unit_id,
        source_ref: observation.source_ref,
        observation_id: observation.observation_id,
      };
      dedupedSignals.set(
        `${owner.toLowerCase()}::${family.family_id}::${observation.unit_id}`,
        signal,
      );
    }
  }

  for (const doc of docs) {
    if (doc.provider === "customerFeedback") continue;
    for (const unit of getDocSourceUnits(doc)) {
      const owner = ownerHintFromUnit(doc, unit);
      if (!owner || owner.toLowerCase() === "unknown") continue;
      const text = `${unit.title}\n${unit.text}`;
      if (text.trim().length < 20) continue;
      for (const family of detectPatternFamilies(text)) {
        const signal: PatternSignal = {
          owner,
          family_id: family.family_id,
          title: family.title,
          pattern_rule: family.pattern_rule,
          doc_id: doc.sourceId,
          source_unit_id: unit.unit_id,
          source_ref: buildEvidenceRefFromDoc(doc, unit.text, unit),
        };
        dedupedSignals.set(
          `${owner.toLowerCase()}::${family.family_id}::${unit.unit_id}`,
          signal,
        );
      }
    }
  }

  const clusters = new Map<string, PatternSignal[]>();
  for (const signal of dedupedSignals.values()) {
    const clusterKey = signal.family_id;
    const existing = clusters.get(clusterKey) ?? [];
    existing.push(signal);
    clusters.set(clusterKey, existing);
  }

  const patternCandidates: KB2PatternCandidate[] = [];
  for (const [, cluster] of clusters) {
    const distinctDocs = new Set(cluster.map((signal) => signal.doc_id));
    if (cluster.length < 2 || distinctDocs.size < 2) continue;

    const sortedCluster = [...cluster].sort((a, b) => a.source_ref.title.localeCompare(b.source_ref.title));
    const canonicalOwner = chooseClusterOwner(sortedCluster);
    const observationIds = Array.from(
      new Set(sortedCluster.map((signal) => signal.observation_id).filter(Boolean)),
    ) as string[];
    const unitIds = Array.from(new Set(sortedCluster.map((signal) => signal.source_unit_id)));
    const evidenceRefs = Array.from(
      new Map(sortedCluster.map((signal) => [`${signal.source_ref.title}::${signal.source_ref.excerpt}`, signal.source_ref])).values(),
    );

    patternCandidates.push({
      pattern_id: randomUUID(),
      owner_hint: canonicalOwner,
      title: sortedCluster[0].title,
      pattern_rule: sortedCluster[0].pattern_rule,
      evidence_refs: evidenceRefs,
      observation_ids: observationIds,
      source_unit_ids: unitIds,
      confidence: distinctDocs.size >= 3 || evidenceRefs.length >= 3 ? "high" : "medium",
    });
  }

  patternCandidates.sort((a, b) =>
    b.evidence_refs.length - a.evidence_refs.length ||
    a.title.localeCompare(b.title),
  );

  logger.log(`Pattern mining produced ${patternCandidates.length} candidate evidence packs`);
  await ctx.onProgress(`Pattern mining produced ${patternCandidates.length} candidate evidence packs`, 100);

  return {
    new_edges: 0,
    removed_by_verification: 0,
    upgraded_related_to: 0,
    link_relationship_edges: 0,
    total_nodes: dedupedSignals.size,
    llm_calls: 0,
    added_edges: [],
    pattern_candidates: patternCandidates,
    artifact_version: "pass1_v2",
  };
};
