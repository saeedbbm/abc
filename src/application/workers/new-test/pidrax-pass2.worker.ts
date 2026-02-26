import { getFastModel } from "@/lib/ai-model";
import { PrefixLogger } from "@/lib/utils";
import { db } from "@/lib/mongodb";
import { searchKnowledgeEmbeddings } from "@/src/application/lib/knowledge/embedding-service";
import { structuredGenerate, type LLMUsage } from "@/src/application/workers/test/structured-generate";
import { embedMany } from "ai";
import { embeddingModel } from "@/lib/embedding";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
  LAYER_A_CATEGORIES,
  type ScoreFormatOutputType,
  type ScoreFormatPageType,
  type AtomicItemType,
} from "@/src/entities/models/score-format";
import type { PidraxProgressEvent } from "./pidrax-pipeline.worker";

const logger = new PrefixLogger("pidrax-pass2");
const PASS2_COLLECTION = "new_test_pidrax_pass2_results";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VerificationGroup = {
  group_id: string;
  canonical_item_id: string;
  canonical_page_id: string;
  canonical_text: string;
  item_ids: string[];
  page_ids: string[];
  severity: string;
  verifier: string;
  instance_count: number;
  reason: string;
  item_type: string;
};

type FlatItem = {
  item: AtomicItemType;
  page_id: string;
  page_title: string;
  section_name: string;
  category: string;
  page_source: "kb_pages" | "howto_pages";
  page_index: number;
  section_index: number;
  bullet_index: number;
  temporal_flag?: boolean;
  embedding?: number[];
};

type ClusterDecision = {
  cluster_id: string;
  items: FlatItem[];
  verdict: "same" | "related" | "different";
  merge_within_section: boolean;
  canonical_index: number;
  group_id: string | null;
};

export type Pass2Metrics = {
  durationMs: number;
  itemsBefore: number;
  itemsAfter: number;
  mergedCount: number;
  citationsRepaired: number;
  verificationGroupCount: number;
  estimatedCostUsd: number;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
};

export type Pass2Result = {
  data: ScoreFormatOutputType;
  verificationGroups: VerificationGroup[];
  factClusters: Array<{
    cluster_id: string;
    items: Array<{ item_id: string; page_id: string; page_title: string; section_name: string; item_text: string }>;
    action: "merged" | "kept_all" | "removed_duplicate";
  }>;
  metrics: Pass2Metrics;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEMPORAL_PATTERNS = [
  /\b[A-Z]{2,6}-\d{1,5}\b/,
  /\b(currently|right now|this sprint|is on hold|in progress|blocked by|is blocking|waiting on)\b/i,
  /\b(this week|this month|yesterday|today|tomorrow)\b/i,
];

function isTemporalItem(text: string): boolean {
  return TEMPORAL_PATTERNS.some(p => p.test(text));
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

function flattenItems(data: ScoreFormatOutputType): FlatItem[] {
  const flat: FlatItem[] = [];
  const addPages = (pages: ScoreFormatPageType[], source: "kb_pages" | "howto_pages") => {
    for (let pi = 0; pi < pages.length; pi++) {
      const page = pages[pi];
      for (let si = 0; si < page.sections.length; si++) {
        const section = page.sections[si];
        for (let bi = 0; bi < section.bullets.length; bi++) {
          flat.push({
            item: section.bullets[bi],
            page_id: page.page_id,
            page_title: page.title,
            section_name: section.section_name,
            category: page.category,
            page_source: source,
            page_index: pi,
            section_index: si,
            bullet_index: bi,
          });
        }
      }
    }
  };
  addPages(data.kb_pages || [], "kb_pages");
  addPages(data.howto_pages || [], "howto_pages");
  return flat;
}

function deepCloneOutput(data: ScoreFormatOutputType): ScoreFormatOutputType {
  return JSON.parse(JSON.stringify(data));
}

const SEVERITY_RANK: Record<string, number> = { S1: 0, S2: 1, S3: 2, S4: 3, none: 4 };
function highestSeverity(items: AtomicItemType[]): string {
  let best = "S4";
  for (const it of items) {
    const s = it.action_routing?.severity || "S4";
    if ((SEVERITY_RANK[s] ?? 4) < (SEVERITY_RANK[best] ?? 4)) best = s;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Stage 1: Temporal Tagging
// ---------------------------------------------------------------------------

function stage1_TemporalTag(flat: FlatItem[]): void {
  const layerACats = new Set(LAYER_A_CATEGORIES as readonly string[]);
  for (const fi of flat) {
    fi.temporal_flag = layerACats.has(fi.category) && isTemporalItem(fi.item.item_text);
  }
  const tagged = flat.filter(f => f.temporal_flag).length;
  logger.log(`Stage 1: ${tagged}/${flat.length} items flagged as temporal in Layer A`);
}

// ---------------------------------------------------------------------------
// Stage 2: Embed & Cluster
// ---------------------------------------------------------------------------

const WITHIN_PAGE_THRESHOLD = 0.90;
const CROSS_PAGE_THRESHOLD = 0.85;
const EMBED_BATCH_SIZE = 100;

async function stage2_EmbedAndCluster(
  flat: FlatItem[],
  onProgress?: (detail: string, percent: number) => void,
): Promise<number[][]> {
  onProgress?.("[Pass2 Stage 2] Embedding items...", 15);

  const texts = flat.map(fi => fi.item.item_text);
  const allEmbeddings: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    const { embeddings } = await embedMany({ model: embeddingModel, values: batch });
    allEmbeddings.push(...embeddings);
  }
  for (let i = 0; i < flat.length; i++) flat[i].embedding = allEmbeddings[i];

  onProgress?.("[Pass2 Stage 2] Clustering...", 20);

  const assigned = new Set<number>();
  const clusters: number[][] = [];

  for (let i = 0; i < flat.length; i++) {
    if (assigned.has(i)) continue;
    const cluster = [i];
    assigned.add(i);

    for (let j = i + 1; j < flat.length; j++) {
      if (assigned.has(j)) continue;
      const samePage = flat[i].page_id === flat[j].page_id;
      const sameType = flat[i].item.item_type === flat[j].item.item_type;
      if (!sameType) continue;

      const threshold = samePage ? WITHIN_PAGE_THRESHOLD : CROSS_PAGE_THRESHOLD;
      const sim = cosineSimilarity(flat[i].embedding!, flat[j].embedding!);
      if (sim >= threshold) {
        cluster.push(j);
        assigned.add(j);
      }
    }
    if (cluster.length > 1) clusters.push(cluster);
  }

  logger.log(`Stage 2: ${clusters.length} candidate clusters from ${flat.length} items`);
  onProgress?.(`[Pass2 Stage 2] ${clusters.length} candidate clusters`, 25);
  return clusters;
}

// ---------------------------------------------------------------------------
// Stage 3: LLM Pairwise Validation
// ---------------------------------------------------------------------------

const ClusterVerdict = z.object({
  decisions: z.array(z.object({
    cluster_index: z.number(),
    verdict: z.enum(["same", "related", "different"]),
    canonical_index: z.number().describe("Index within the cluster of the richest/most authoritative item"),
    merge_within_section: z.boolean().describe("True if same-section duplicates should be merged"),
  })),
});

async function stage3_LLMValidation(
  flat: FlatItem[],
  clusters: number[][],
  usage: { inputTokens: number; outputTokens: number; calls: number },
  onProgress?: (detail: string, percent: number) => void,
): Promise<ClusterDecision[]> {
  onProgress?.(`[Pass2 Stage 3] Validating ${clusters.length} clusters...`, 30);

  if (clusters.length === 0) return [];

  const decisions: ClusterDecision[] = [];
  const BATCH_SIZE = 15;

  for (let b = 0; b < clusters.length; b += BATCH_SIZE) {
    const batch = clusters.slice(b, b + BATCH_SIZE);
    const batchNum = Math.floor(b / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(clusters.length / BATCH_SIZE);
    onProgress?.(`[Pass2 Stage 3] Batch ${batchNum}/${totalBatches}...`, 30 + Math.round(((b + BATCH_SIZE) / clusters.length) * 15));

    const clusterDescriptions = batch.map((cluster, ci) => {
      const items = cluster.map((idx, ii) => {
        const fi = flat[idx];
        return `  [${ii}] "${fi.item.item_text}" (type: ${fi.item.item_type}, page: "${fi.page_title}", section: "${fi.section_name}")`;
      }).join("\n");
      return `Cluster ${ci}:\n${items}`;
    }).join("\n\n");

    try {
      const result = await structuredGenerate({
        model: getFastModel(),
        schema: ClusterVerdict,
        system: `You compare groups of KB items to determine if they represent the same underlying fact.
Rules:
- SAME: Items state the same fact, even if worded differently. These can share a verification group.
- RELATED: Items are about the same topic but convey distinct information. Do NOT merge.
- DIFFERENT: Items are unrelated despite surface similarity. Do NOT group.
- canonical_index: pick the item with the most complete, detailed, or authoritative wording.
- merge_within_section: true ONLY if items are in the same page AND same section AND say the same thing.`,
        prompt: `Evaluate these ${batch.length} clusters. For each, decide: SAME, RELATED, or DIFFERENT.\n\n${clusterDescriptions}`,
        logger,
        onUsage: (u) => { usage.inputTokens += u.promptTokens; usage.outputTokens += u.completionTokens; usage.calls++; },
      });

      for (let ci = 0; ci < batch.length; ci++) {
        const cluster = batch[ci];
        const d = result.decisions[ci];
        if (!d) continue;
        const groupId = d.verdict === "same" ? nanoid(12) : null;
        decisions.push({
          cluster_id: nanoid(8),
          items: cluster.map(idx => flat[idx]),
          verdict: d.verdict,
          merge_within_section: d.merge_within_section,
          canonical_index: Math.min(d.canonical_index, cluster.length - 1),
          group_id: groupId,
        });
      }
    } catch (err) {
      logger.log(`Stage 3 batch ${batchNum} failed: ${err}`);
      for (const cluster of batch) {
        decisions.push({
          cluster_id: nanoid(8),
          items: cluster.map(idx => flat[idx]),
          verdict: "related",
          merge_within_section: false,
          canonical_index: 0,
          group_id: null,
        });
      }
    }
  }

  const sameCount = decisions.filter(d => d.verdict === "same").length;
  logger.log(`Stage 3: ${sameCount}/${decisions.length} clusters confirmed as SAME`);
  onProgress?.(`[Pass2 Stage 3] ${sameCount} confirmed duplicate groups`, 45);
  return decisions;
}

// ---------------------------------------------------------------------------
// Stage 4: Citation Repair
// ---------------------------------------------------------------------------

const CitationCheck = z.object({
  checks: z.array(z.object({
    item_index: z.number(),
    supported: z.boolean(),
    best_source_index: z.number().describe("Index of the best matching source from candidates, or -1 if none"),
  })),
});

async function stage4_CitationRepair(
  flat: FlatItem[],
  projectId: string,
  usage: { inputTokens: number; outputTokens: number; calls: number },
  onProgress?: (detail: string, percent: number) => void,
): Promise<number> {
  const weak = flat.filter(fi =>
    fi.item.confidence_bucket === "low" || (fi.item.source_refs?.length || 0) === 0
  );

  onProgress?.(`[Pass2 Stage 4] Repairing citations for ${weak.length} weak items...`, 50);
  if (weak.length === 0) return 0;

  let repaired = 0;
  const BATCH = 10;

  for (let b = 0; b < weak.length; b += BATCH) {
    const batch = weak.slice(b, b + BATCH);
    const batchPct = 50 + Math.round(((b + BATCH) / weak.length) * 15);
    onProgress?.(`[Pass2 Stage 4] Batch ${Math.floor(b / BATCH) + 1}/${Math.ceil(weak.length / BATCH)}...`, batchPct);

    const candidatesByItem: Array<{ fi: FlatItem; candidates: Array<{ title: string; content: string; provider: string; score: number; docId: string }> }> = [];

    for (const fi of batch) {
      const results = await searchKnowledgeEmbeddings(projectId, fi.item.item_text, { limit: 5 }, logger);
      const top = results.filter(r => r.score >= 0.5).slice(0, 3);
      candidatesByItem.push({
        fi,
        candidates: top.map(r => ({
          title: r.title,
          content: r.content.slice(0, 300),
          provider: r.provider,
          score: r.score,
          docId: r.documentId,
        })),
      });
    }

    const itemsWithCandidates = candidatesByItem.filter(c => c.candidates.length > 0);
    if (itemsWithCandidates.length === 0) continue;

    const prompt = itemsWithCandidates.map((c, i) => {
      const sources = c.candidates.map((s, si) => `  [${si}] ${s.provider}: "${s.title}" — "${s.content}"`).join("\n");
      return `Item ${i}: "${c.fi.item.item_text}"\nCandidate sources:\n${sources}`;
    }).join("\n\n");

    try {
      const result = await structuredGenerate({
        model: getFastModel(),
        schema: CitationCheck,
        system: `You verify whether source documents actually support specific claims.
For each item, check if ANY of the candidate sources contains evidence that directly supports the claim.
- supported: true if at least one candidate provides real evidence for this specific claim
- best_source_index: the index of the best supporting source, or -1 if none truly support it`,
        prompt: `Check these ${itemsWithCandidates.length} items against their candidate sources:\n\n${prompt}`,
        logger,
        onUsage: (u) => { usage.inputTokens += u.promptTokens; usage.outputTokens += u.completionTokens; usage.calls++; },
      });

      for (const check of result.checks) {
        const entry = itemsWithCandidates[check.item_index];
        if (!entry || !check.supported || check.best_source_index < 0) continue;
        const src = entry.candidates[check.best_source_index];
        if (!src) continue;

        entry.fi.item.source_refs = [{
          source_type: src.provider as any,
          doc_id: src.docId,
          title: src.title,
          excerpt: src.content.slice(0, 150),
        }];
        if (entry.fi.item.confidence_bucket === "low") {
          entry.fi.item.confidence_bucket = "medium";
        }
        repaired++;
      }
    } catch (err) {
      logger.log(`Stage 4 citation batch failed: ${err}`);
    }
  }

  logger.log(`Stage 4: ${repaired} citations repaired`);
  onProgress?.(`[Pass2 Stage 4] ${repaired} citations repaired`, 65);
  return repaired;
}

// ---------------------------------------------------------------------------
// Stage 5: Apply Patches
// ---------------------------------------------------------------------------

function stage5_ApplyPatches(
  data: ScoreFormatOutputType,
  flat: FlatItem[],
  decisions: ClusterDecision[],
  onProgress?: (detail: string, percent: number) => void,
): { output: ScoreFormatOutputType; mergedCount: number } {
  onProgress?.("[Pass2 Stage 5] Applying patches...", 70);

  const output = deepCloneOutput(data);
  const removals = new Set<string>();
  let mergedCount = 0;

  for (const dec of decisions) {
    if (dec.verdict !== "same") continue;
    const canonical = dec.items[dec.canonical_index];

    if (dec.merge_within_section) {
      const allRefs = dec.items.flatMap(fi => fi.item.source_refs || []);
      const uniqueRefs = allRefs.filter((r, i, arr) =>
        arr.findIndex(x => x.doc_id === r.doc_id && x.excerpt === r.excerpt) === i
      );

      for (let i = 0; i < dec.items.length; i++) {
        if (i === dec.canonical_index) continue;
        removals.add(dec.items[i].item.item_id);
        mergedCount++;
      }

      const pages = output[canonical.page_source] || [];
      const page = pages[canonical.page_index];
      if (page) {
        const section = page.sections[canonical.section_index];
        if (section) {
          const bullet = section.bullets.find(b => b.item_id === canonical.item.item_id);
          if (bullet) {
            bullet.source_refs = uniqueRefs;
            bullet.group_id = dec.group_id || undefined;
          }
        }
      }
    }

    if (dec.group_id) {
      for (const fi of dec.items) {
        if (removals.has(fi.item.item_id)) continue;
        const pages = output[fi.page_source] || [];
        const page = pages[fi.page_index];
        if (page) {
          const section = page.sections[fi.section_index];
          if (section) {
            const bullet = section.bullets.find(b => b.item_id === fi.item.item_id);
            if (bullet) bullet.group_id = dec.group_id;
          }
        }
      }
    }
  }

  for (const fi of flat) {
    if (!fi.temporal_flag) continue;
    if (removals.has(fi.item.item_id)) continue;

    const existsOnLayerB = flat.some(other =>
      other.item.item_id !== fi.item.item_id &&
      !removals.has(other.item.item_id) &&
      !(LAYER_A_CATEGORIES as readonly string[]).includes(other.category) &&
      cosineSimilarity(fi.embedding || [], other.embedding || []) > 0.88
    );
    if (existsOnLayerB) {
      removals.add(fi.item.item_id);
      mergedCount++;
    }
  }

  for (const fi of flat) {
    if (!removals.has(fi.item.item_id)) continue;
    if (fi.item.confidence_bucket !== "low" && fi.item.source_refs.length > 0) {
      const pages = output[fi.page_source] || [];
      const page = pages[fi.page_index];
      if (page) {
        const section = page.sections[fi.section_index];
        if (section) {
          const bullet = section.bullets.find(b => b.item_id === fi.item.item_id);
          if (bullet) {
            bullet.source_refs = fi.item.source_refs;
            bullet.group_id = fi.item.group_id;
          }
        }
      }
    }
  }

  for (const source of ["kb_pages", "howto_pages"] as const) {
    const pages = output[source] || [];
    for (const page of pages) {
      for (const section of page.sections) {
        section.bullets = section.bullets.filter(b => !removals.has(b.item_id));
      }
    }
  }

  logger.log(`Stage 5: ${mergedCount} items removed/merged, ${removals.size} total removals`);
  onProgress?.(`[Pass2 Stage 5] ${mergedCount} items merged/removed`, 75);
  return { output, mergedCount };
}

// ---------------------------------------------------------------------------
// Stage 6: Build Verification Groups
// ---------------------------------------------------------------------------

function stage6_BuildVerificationGroups(
  data: ScoreFormatOutputType,
  decisions: ClusterDecision[],
  onProgress?: (detail: string, percent: number) => void,
): VerificationGroup[] {
  onProgress?.("[Pass2 Stage 6] Building verification groups...", 80);

  const groupMap = new Map<string, {
    items: AtomicItemType[];
    pageIds: Set<string>;
    itemIds: string[];
    canonicalItemId: string;
    canonicalPageId: string;
    canonicalText: string;
  }>();

  for (const dec of decisions) {
    if (dec.verdict !== "same" || !dec.group_id) continue;
    const canonical = dec.items[dec.canonical_index];
    groupMap.set(dec.group_id, {
      items: dec.items.map(fi => fi.item),
      pageIds: new Set(dec.items.map(fi => fi.page_id)),
      itemIds: dec.items.map(fi => fi.item.item_id),
      canonicalItemId: canonical.item.item_id,
      canonicalPageId: canonical.page_id,
      canonicalText: canonical.item.item_text,
    });
  }

  for (const source of ["kb_pages", "howto_pages"] as const) {
    for (const page of data[source] || []) {
      for (const section of page.sections) {
        for (const bullet of section.bullets) {
          if (!bullet.group_id) continue;
          const group = groupMap.get(bullet.group_id);
          if (!group) continue;
          if (!group.itemIds.includes(bullet.item_id)) {
            group.itemIds.push(bullet.item_id);
            group.items.push(bullet);
            group.pageIds.add(page.page_id);
          }
        }
      }
    }
  }

  const resolveVerifier = (items: AtomicItemType[], pageIds: Set<string>, data: ScoreFormatOutputType): string => {
    const explicit = items.find(it => it.verification?.verifier)?.verification?.verifier;
    if (explicit) return explicit;

    const atMention = items.find(it => it.action_routing?.reason?.match(/@([\w][\w\s]*\w)/))
      ?.action_routing?.reason?.match(/@([\w][\w\s]*\w)/)?.[1]?.trim();
    if (atMention) return atMention;

    for (const source of ["kb_pages", "howto_pages"] as const) {
      for (const page of data[source] || []) {
        if (!pageIds.has(page.page_id)) continue;
        for (const section of page.sections) {
          const owner = section.bullets.find(b => b.item_type === "owner" && b.verification?.verifier);
          if (owner?.verification?.verifier) return owner.verification.verifier;
        }
      }
    }

    return "Unassigned";
  };

  const groups: VerificationGroup[] = [];
  for (const [groupId, g] of groupMap) {
    const needsVerify = g.items.some(it =>
      it.action_routing?.action === "verify_task" ||
      it.verification?.status === "needs_verification"
    );
    if (!needsVerify && g.pageIds.size < 2) continue;

    const canonical = g.items.find(it => it.item_id === g.canonicalItemId) || g.items[0];
    const reason = canonical?.action_routing?.reason
      || g.items.find(it => it.action_routing?.reason)?.action_routing?.reason
      || "";
    const itemType = canonical?.item_type || "fact";

    groups.push({
      group_id: groupId,
      canonical_item_id: g.canonicalItemId,
      canonical_page_id: g.canonicalPageId,
      canonical_text: g.canonicalText,
      item_ids: g.itemIds,
      page_ids: [...g.pageIds],
      severity: highestSeverity(g.items),
      verifier: resolveVerifier(g.items, g.pageIds, data),
      instance_count: g.itemIds.length,
      reason,
      item_type: itemType,
    });
  }

  groups.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 4) - (SEVERITY_RANK[b.severity] ?? 4));
  logger.log(`Stage 6: ${groups.length} verification groups`);
  onProgress?.(`[Pass2 Stage 6] ${groups.length} verification groups`, 85);
  return groups;
}

// ---------------------------------------------------------------------------
// Main: Run Pass 2
// ---------------------------------------------------------------------------

export async function runPidraxPass2(
  projectId: string,
  onProgress?: (event: PidraxProgressEvent) => void,
): Promise<Pass2Result> {
  const startTime = Date.now();

  const emit = (detail: string, percent: number, extra?: Partial<PidraxProgressEvent>) => {
    try { onProgress?.({ phase: "pass2", detail, percent, ...extra }); } catch { /* stream closed */ }
  };

  emit("Loading first-pass results...", 5);
  const firstPass = await db.collection("new_test_pidrax_results").findOne(
    { projectId },
    { sort: { createdAt: -1 } },
  );
  if (!firstPass?.data) throw new Error("No first-pass results found. Run the Pidrax pipeline first.");

  const sourceRunId = firstPass.runId || "unknown";
  const originalData = firstPass.data as ScoreFormatOutputType;

  emit("Flattening items...", 8);
  const flat = flattenItems(originalData);
  logger.log(`Pass2 start: ${flat.length} items from first pass`);
  emit(`${flat.length} items from first pass`, 10);

  const usage = { inputTokens: 0, outputTokens: 0, calls: 0 };

  // Stage 1
  emit("[Pass2 Stage 1] Temporal tagging...", 12);
  stage1_TemporalTag(flat);

  // Stage 2
  const clusters = await stage2_EmbedAndCluster(flat, (d, p) => emit(d, p));

  // Stage 3
  const decisions = await stage3_LLMValidation(flat, clusters, usage, (d, p) => emit(d, p));

  // Stage 4
  const citationsRepaired = await stage4_CitationRepair(flat, projectId, usage, (d, p) => emit(d, p));

  // Stage 5
  const { output, mergedCount } = stage5_ApplyPatches(originalData, flat, decisions, (d, p) => emit(d, p));

  // Stage 6
  const verificationGroups = stage6_BuildVerificationGroups(output, decisions, (d, p) => emit(d, p));

  const itemsAfter = [...(output.kb_pages || []), ...(output.howto_pages || [])].reduce(
    (s, p) => s + (p.sections || []).reduce((ss, sec) => ss + (sec.bullets?.length || 0), 0), 0,
  );

  const durationMs = Date.now() - startTime;
  const estimatedCostUsd = (usage.inputTokens * 0.003 + usage.outputTokens * 0.015) / 1000;

  const factClusters = decisions.map(d => ({
    cluster_id: d.cluster_id,
    items: d.items.map(fi => ({
      item_id: fi.item.item_id,
      page_id: fi.page_id,
      page_title: fi.page_title,
      section_name: fi.section_name,
      item_text: fi.item.item_text,
    })),
    action: d.merge_within_section ? "merged" as const :
            d.verdict === "same" ? "kept_all" as const : "removed_duplicate" as const,
  }));

  const metrics: Pass2Metrics = {
    durationMs,
    itemsBefore: flat.length,
    itemsAfter,
    mergedCount,
    citationsRepaired,
    verificationGroupCount: verificationGroups.length,
    estimatedCostUsd,
    llmCalls: usage.calls,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };

  const result: Pass2Result = { data: output, verificationGroups, factClusters, metrics };

  const runId = nanoid();
  await db.collection(PASS2_COLLECTION).updateOne(
    { projectId },
    { $set: { projectId, runId, sourceRunId, ...result, createdAt: new Date().toISOString() } },
    { upsert: true },
  );

  logger.log(`Pass2 complete in ${(durationMs / 1000).toFixed(1)}s: ${flat.length}→${itemsAfter} items, ${mergedCount} merged, ${citationsRepaired} citations fixed, ${verificationGroups.length} groups, $${estimatedCostUsd.toFixed(3)}`);

  emit(
    `Pass 2 complete — ${flat.length}→${itemsAfter} items, ${mergedCount} merged, ${citationsRepaired} citations fixed, ${verificationGroups.length} verification groups (${(durationMs / 1000).toFixed(1)}s, $${estimatedCostUsd.toFixed(2)})`,
    100,
    { done: true, success: true },
  );

  return result;
}

// ---------------------------------------------------------------------------
// Verification Cascade
// ---------------------------------------------------------------------------

export async function cascadeVerification(
  projectId: string,
  groupId: string,
  action: "verify" | "edit" | "reject",
  newText?: string,
  rewrites?: { item_id: string; new_text: string }[],
): Promise<{ updated_count: number; pages_affected: string[] }> {
  const doc = await db.collection(PASS2_COLLECTION).findOne(
    { projectId },
    { sort: { createdAt: -1 } },
  );
  if (!doc?.data) throw new Error("No pass2 results found");

  const data = doc.data as ScoreFormatOutputType;
  let updatedCount = 0;
  const pagesAffected = new Set<string>();

  const rewriteMap = new Map<string, string>();
  if (rewrites) {
    for (const r of rewrites) rewriteMap.set(r.item_id, r.new_text);
  }

  const markVerified = (bullet: AtomicItemType) => {
    bullet.verification = { status: "verified_human", verifier: bullet.verification?.verifier || null };
    bullet.action_routing = { ...bullet.action_routing, action: "none", severity: "S4" };
    bullet.confidence_bucket = "high";
    if (bullet.item_type === "conflict") bullet.item_type = "fact";
  };

  const updateItem = (bullet: AtomicItemType, pageId: string) => {
    if (bullet.group_id !== groupId) return;
    switch (action) {
      case "verify":
        markVerified(bullet);
        break;
      case "edit": {
        const perItemText = rewriteMap.get(bullet.item_id);
        if (perItemText) {
          bullet.item_text = perItemText;
        } else if (newText) {
          bullet.item_text = newText;
        }
        markVerified(bullet);
        break;
      }
      case "reject":
        bullet.verification = { status: "needs_verification", verifier: bullet.verification?.verifier || null };
        bullet.action_routing = { ...bullet.action_routing, action: "none", reason: "Rejected by human reviewer" };
        break;
    }
    updatedCount++;
    pagesAffected.add(pageId);
  };

  for (const source of ["kb_pages", "howto_pages"] as const) {
    for (const page of data[source] || []) {
      for (const section of page.sections) {
        for (const bullet of section.bullets) {
          updateItem(bullet, page.page_id);
        }
      }
    }
  }

  const groups = (doc.verificationGroups || []) as VerificationGroup[];
  const group = groups.find(g => g.group_id === groupId);
  if (group && (action === "verify" || action === "edit")) {
    group.severity = "none" as any;
  }

  await db.collection(PASS2_COLLECTION).updateOne(
    { _id: doc._id },
    { $set: { data, verificationGroups: groups, updatedAt: new Date().toISOString() } },
  );

  logger.log(`Cascade verification: group=${groupId}, action=${action}, updated=${updatedCount}, pages=${pagesAffected.size}`);
  return { updated_count: updatedCount, pages_affected: [...pagesAffected] };
}

/**
 * Load all item instances for a verification group, with page context.
 * Used by the edit preview endpoint to give the LLM context for each instance.
 */
export async function loadGroupInstances(
  projectId: string,
  groupId: string,
): Promise<{ instances: { item_id: string; page_id: string; page_title: string; section: string; current_text: string }[] }> {
  const doc = await db.collection(PASS2_COLLECTION).findOne(
    { projectId },
    { sort: { createdAt: -1 } },
  );
  if (!doc?.data) throw new Error("No pass2 results found");

  const data = doc.data as ScoreFormatOutputType;
  const instances: { item_id: string; page_id: string; page_title: string; section: string; current_text: string }[] = [];

  for (const source of ["kb_pages", "howto_pages"] as const) {
    for (const page of data[source] || []) {
      for (const section of page.sections) {
        for (const bullet of section.bullets) {
          if (bullet.group_id === groupId) {
            instances.push({
              item_id: bullet.item_id,
              page_id: page.page_id,
              page_title: page.title,
              section: section.section_name,
              current_text: bullet.item_text,
            });
          }
        }
      }
    }
  }

  return { instances };
}
