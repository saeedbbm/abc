import { randomUUID } from "crypto";
import {
  type KB2Observation,
  type KB2PatternCandidate,
} from "@/src/application/lib/kb2/pass1-v2-artifacts";
import { cleanEntityTitle } from "@/src/application/lib/kb2/title-cleanup";
import { PrefixLogger } from "@/lib/utils";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";

const PATTERN_DISCOVERY_RE = /\b(convention|pattern|standard(?:ize|ized)?|rule|default|prefer|preferred|better than|instead of|always|never|layout|navigation|sidebar|filter|pagination|load|loading|cache|button|ui|api|schema|responsive|mobile|memo(?:ize)?|useCallback|useMemo|React\.memo|css.?module|camelCase|skeleton|toast|transition|vertical.?(?:nav|sidebar|menu|panel)|single.?column|max-height|overflow-y|scroll(?:able)?|cursor.?(?:based|pagination)|Promise\.all|lazy.?load|fallback)\b/i;
const PATTERN_STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "along",
  "also",
  "around",
  "available",
  "because",
  "been",
  "before",
  "being",
  "build",
  "built",
  "canonicalization",
  "change",
  "choice",
  "contains",
  "convention",
  "decision",
  "default",
  "describes",
  "doing",
  "excerpt",
  "explicit",
  "from",
  "have",
  "implementation",
  "later",
  "like",
  "make",
  "more",
  "observation",
  "pattern",
  "remain",
  "reusable",
  "rule",
  "should",
  "signal",
  "standard",
  "survive",
  "synthesis",
  "team",
  "text",
  "that",
  "their",
  "there",
  "these",
  "this",
  "those",
  "tradeoff",
  "using",
  "with",
]);

type PatternSignal = {
  owner: string;
  title: string;
  pattern_rule: string;
  doc_id: string;
  source_unit_id: string;
  source_ref: KB2PatternCandidate["evidence_refs"][number];
  observation_id?: string;
  tokens: string[];
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

function normalizeSignalText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractSignalTokens(text: string): string[] {
  const normalized = normalizeSignalText(text);
  const seen = new Set<string>();
  return normalized
    .split(" ")
    .filter((token) => token.length >= 4 && !PATTERN_STOPWORDS.has(token))
    .filter((token) => {
      if (seen.has(token)) return false;
      seen.add(token);
      return true;
    });
}

function isPatternLikeObservation(observation: KB2Observation): boolean {
  if (observation.observation_kind === "pattern_signal") return true;
  if (observation.observation_kind !== "decision_signal") return false;
  const text = [observation.label, observation.reasoning, observation.evidence_excerpt]
    .filter(Boolean)
    .join("\n");
  return PATTERN_DISCOVERY_RE.test(text);
}

function buildPatternSignalFromObservation(observation: KB2Observation): PatternSignal | null {
  if (!isPatternLikeObservation(observation)) return null;
  const owner = ownerHintFromObservation(observation);
  if (!owner || owner.toLowerCase() === "unknown") return null;

  const tokenText = [observation.label, observation.evidence_excerpt]
    .filter(Boolean)
    .join("\n");
  const tokens = extractSignalTokens(tokenText);
  if (tokens.length < 2) return null;

  return {
    owner,
    title: cleanEntityTitle(
      observation.label || observation.evidence_excerpt || "Implementation pattern",
      "decision",
    ),
    pattern_rule: observation.evidence_excerpt?.trim() || observation.reasoning.trim(),
    doc_id: observation.doc_id,
    source_unit_id: observation.unit_id,
    source_ref: observation.source_ref,
    observation_id: observation.observation_id,
    tokens,
  };
}

function sharedTokenCount(left: string[], right: string[]): number {
  const rightSet = new Set(right);
  return left.filter((token) => rightSet.has(token)).length;
}

function clusterSimilarity(signal: PatternSignal, cluster: PatternSignal[]): number {
  const clusterTokens = Array.from(new Set(cluster.flatMap((entry) => entry.tokens)));
  if (clusterTokens.length === 0 || signal.tokens.length === 0) return 0;
  const shared = sharedTokenCount(signal.tokens, clusterTokens);
  const base = shared / Math.min(signal.tokens.length, clusterTokens.length);
  const ownerMatch = cluster.some((entry) => entry.owner.toLowerCase() === signal.owner.toLowerCase());
  return base + (ownerMatch ? 0.25 : 0);
}

function chooseRepresentativeSignal(cluster: PatternSignal[]): PatternSignal {
  return [...cluster].sort((a, b) =>
    scorePatternSignal(b) - scorePatternSignal(a) ||
    a.title.length - b.title.length ||
    a.title.localeCompare(b.title),
  )[0] ?? cluster[0];
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

  const step3Artifact = await ctx.getStepArtifact("pass1", 3);
  const observations = ((step3Artifact?.observations ?? []) as KB2Observation[])
    .filter((observation) =>
      observation.observation_kind === "decision_signal" ||
      observation.observation_kind === "pattern_signal",
    );

  await ctx.onProgress(
    `Mining repeated patterns from ${observations.length} observations...`,
    5,
  );

  const dedupedSignals = new Map<string, PatternSignal>();

  for (const observation of observations) {
    const signal = buildPatternSignalFromObservation(observation);
    if (!signal) continue;
    dedupedSignals.set(
      `${signal.owner.toLowerCase()}::${signal.source_unit_id}::${signal.tokens.slice(0, 4).join(":")}`,
      signal,
    );
  }

  const clusters: PatternSignal[][] = [];
  for (const signal of dedupedSignals.values()) {
    let bestClusterIndex = -1;
    let bestScore = 0;
    for (let index = 0; index < clusters.length; index++) {
      const cluster = clusters[index];
      const clusterTokens = Array.from(new Set(cluster.flatMap((entry) => entry.tokens)));
      const shared = sharedTokenCount(signal.tokens, clusterTokens);
      const similarity = clusterSimilarity(signal, cluster);
      const ownerMatch = cluster.some((entry) => entry.owner.toLowerCase() === signal.owner.toLowerCase());
      const eligible = (ownerMatch && shared >= 2) || shared >= 4 || similarity >= 0.75;
      if (!eligible) continue;
      if (similarity > bestScore) {
        bestScore = similarity;
        bestClusterIndex = index;
      }
    }
    if (bestClusterIndex === -1) {
      clusters.push([signal]);
    } else {
      clusters[bestClusterIndex].push(signal);
    }
  }

  const patternCandidates: KB2PatternCandidate[] = [];
  const promotedClusters: PatternSignal[][] = [];
  const unclusteredSignals: PatternSignal[] = [];

  for (const cluster of clusters) {
    const distinctOwners = new Set(cluster.map((s) => s.owner.toLowerCase()));
    if (distinctOwners.size >= 2) {
      for (const ownerKey of distinctOwners) {
        const ownerSubgroup = cluster.filter((s) => s.owner.toLowerCase() === ownerKey);
        const subDocs = new Set(ownerSubgroup.map((s) => s.doc_id));
        if (ownerSubgroup.length >= 2 && subDocs.size >= 2) {
          promotedClusters.push(ownerSubgroup);
        } else {
          unclusteredSignals.push(...ownerSubgroup);
        }
      }
    } else {
      const distinctDocs = new Set(cluster.map((signal) => signal.doc_id));
      if (cluster.length >= 2 && distinctDocs.size >= 2) {
        promotedClusters.push(cluster);
      } else {
        unclusteredSignals.push(...cluster);
      }
    }
  }

  const ownerGroups = new Map<string, PatternSignal[]>();
  for (const signal of unclusteredSignals) {
    const key = signal.owner.replace(/\s*\[[^\]]+\]\s*$/g, "").trim().toLowerCase();
    if (!ownerGroups.has(key)) ownerGroups.set(key, []);
    ownerGroups.get(key)!.push(signal);
  }
  for (const [, group] of ownerGroups) {
    const distinctDocs = new Set(group.map((s) => s.doc_id));
    if (group.length >= 2 && distinctDocs.size >= 2) {
      promotedClusters.push(group);
    } else {
      for (const signal of group) {
        if (signal.source_ref.confidence === "high") {
          const signalDocIds = new Set<string>();
          signalDocIds.add(signal.doc_id);
          const otherSameOwner = [...dedupedSignals.values()].filter(
            (s) => s.owner.toLowerCase() === signal.owner.toLowerCase() && s.doc_id !== signal.doc_id,
          );
          for (const other of otherSameOwner) signalDocIds.add(other.doc_id);
          if (signalDocIds.size >= 2) {
            promotedClusters.push([signal]);
          }
        }
      }
    }
  }

  for (const cluster of promotedClusters) {
    const sortedCluster = [...cluster].sort((a, b) => a.source_ref.title.localeCompare(b.source_ref.title));
    const representative = chooseRepresentativeSignal(sortedCluster);
    const canonicalOwner = chooseClusterOwner(sortedCluster);
    const observationIds = Array.from(
      new Set(sortedCluster.map((signal) => signal.observation_id).filter(Boolean)),
    ) as string[];
    const unitIds = Array.from(new Set(sortedCluster.map((signal) => signal.source_unit_id)));
    const evidenceRefs = Array.from(
      new Map(sortedCluster.map((signal) => [`${signal.source_ref.title}::${signal.source_ref.excerpt}`, signal.source_ref])).values(),
    );
    const distinctDocs = new Set(cluster.map((signal) => signal.doc_id));

    patternCandidates.push({
      pattern_id: randomUUID(),
      owner_hint: canonicalOwner,
      title: representative.title,
      pattern_rule: representative.pattern_rule,
      evidence_refs: evidenceRefs,
      observation_ids: observationIds,
      source_unit_ids: unitIds,
      confidence:
        distinctDocs.size >= 3 || evidenceRefs.length >= 4 || sortedCluster.length >= 4
          ? "high"
          : "medium",
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
