import { randomUUID } from "crypto";
import { z } from "zod";
import { getTenantCollections } from "@/lib/mongodb";
import { getFastModel, getFastModelName, getReasoningModel, getReasoningModelName, calculateCostUsd } from "@/lib/ai-model";
import { structuredGenerate } from "@/src/application/lib/llm/structured-generate";
import { appendUniqueSourceRefs } from "@/src/application/lib/kb2/pass1-v2-artifacts";
import type { KB2GraphNodeType, KB2VerificationCardType } from "@/src/entities/models/kb2-types";
import type { KB2ParsedDocument } from "@/src/application/lib/kb2/confluence-parser";
import { PrefixLogger } from "@/lib/utils";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";
import { tokenSimilarity } from "@/src/application/workers/kb2/utils/text-similarity";

const FALLBACK_SIMILARITY_THRESHOLD = 0.4;
const FALLBACK_LLM_BATCH_SIZE = 15;
const RAW_JIRA_KEY_ONLY_RE = /^[A-Z]+-\d+$/;
const RAW_JIRA_TITLE_RE = /^[A-Z]+-\d+:\s*/i;
const RAW_PR_TITLE_RE = /^[\w.-]+\s+PR\s+#\d+:\s*/i;

function aliasOverlap(a: KB2GraphNodeType, b: KB2GraphNodeType): boolean {
  const allA = new Set([a.display_name.toLowerCase(), ...a.aliases.map((s) => s.toLowerCase())]);
  const allB = new Set([b.display_name.toLowerCase(), ...b.aliases.map((s) => s.toLowerCase())]);
  for (const name of allA) {
    if (allB.has(name)) return true;
  }
  return false;
}

function substringMatch(a: string, b: string): boolean {
  const la = a.toLowerCase().trim();
  const lb = b.toLowerCase().trim();
  if (la === lb) return false;
  return (la.length >= 3 && lb.includes(la)) || (lb.length >= 3 && la.includes(lb));
}

const ENV_SUFFIXES = /-(?:dev|staging|prod|test|qa)$/i;
function stripEnvSuffix(name: string): string {
  return name.replace(ENV_SUFFIXES, "").trim();
}

function normalizeLoose(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function singularizeToken(token: string): string {
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith("s") && !token.endsWith("ss") && token.length > 3) return token.slice(0, -1);
  return token;
}

const PROJECT_CANONICAL_DROP_TOKENS = new Set([
  "and",
  "project",
  "projects",
  "page",
  "pages",
  "build",
  "add",
  "create",
  "implement",
  "improvement",
  "improvements",
  "design",
  "layout",
  "card",
  "cards",
  "responsiveness",
  "frontend",
  "backend",
  "phase",
  "work",
  "works",
  "ui",
  "refresh",
  "rollout",
]);

const PROJECT_SINGLE_TOKEN_STOP_TOKENS = new Set([
  "site",
  "website",
  "shelter",
  "system",
  "platform",
  "team",
]);

const PROJECT_GENERIC_MODIFIER_TOKENS = new Set([
  "improvement",
  "improvements",
  "design",
  "layout",
  "card",
  "cards",
  "responsiveness",
  "phase",
  "refresh",
  "rollout",
  "refactor",
]);

const PROJECT_IMPLEMENTATION_SCOPE_TOKENS = new Set([
  "api",
  "backend",
  "card",
  "cards",
  "component",
  "components",
  "frontend",
  "integration",
  "search",
]);

function tokenizeProjectText(node: KB2GraphNodeType): string[] {
  return [node.display_name, ...node.aliases]
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && !RAW_JIRA_KEY_ONLY_RE.test(value))
    .map((value) =>
      value
        .replace(RAW_JIRA_TITLE_RE, "")
        .replace(RAW_PR_TITLE_RE, "")
        .trim(),
    )
    .flatMap((value) => normalizeLoose(value).split(" "))
    .filter(Boolean)
    .map(singularizeToken);
}

function getProjectCanonicalTokens(node: KB2GraphNodeType): string[] {
  const tokens = tokenizeProjectText(node).filter((token) =>
    token.length >= 3 && !PROJECT_CANONICAL_DROP_TOKENS.has(token)
  );
  return [...new Set(tokens)];
}

function getProjectCanonicalKey(node: KB2GraphNodeType): string | null {
  const tokens = getProjectCanonicalTokens(node).sort();
  return tokens.length > 0 ? tokens.join(" ") : null;
}

function getProjectSharedTokens(a: KB2GraphNodeType, b: KB2GraphNodeType): string[] {
  const bTokens = new Set(getProjectCanonicalTokens(b));
  return getProjectCanonicalTokens(a).filter((token) => bTokens.has(token));
}

function hasProjectGenericModifier(node: KB2GraphNodeType): boolean {
  return tokenizeProjectText(node).some((token) => PROJECT_GENERIC_MODIFIER_TOKENS.has(token));
}

function getProjectEvidenceAnchorKeys(node: KB2GraphNodeType): string[] {
  const keys = new Set<string>();
  for (const ref of node.source_refs ?? []) {
    if (ref.doc_id) keys.add(`doc:${normalizeLoose(String(ref.doc_id))}`);
    if (ref.title) keys.add(`title:${normalizeLoose(String(ref.title))}`);
    if (ref.section_heading) keys.add(`section:${normalizeLoose(`${String(ref.doc_id ?? "")} ${String(ref.section_heading)}`)}`);
  }
  return [...keys].filter((key) => key.length > 0);
}

function countOverlap(a: string[], b: string[]): number {
  const bSet = new Set(b);
  return a.filter((value) => bSet.has(value)).length;
}

function isUmbrellaProjectPair(
  a: KB2GraphNodeType,
  b: KB2GraphNodeType,
  sharedTokens: string[],
): boolean {
  if (sharedTokens.length === 0) return false;
  const tokensA = getProjectCanonicalTokens(a);
  const tokensB = getProjectCanonicalTokens(b);
  const uniqueA = tokensA.filter((token) => !sharedTokens.includes(token));
  const uniqueB = tokensB.filter((token) => !sharedTokens.includes(token));
  return (
    (hasProjectGenericModifier(a) || hasProjectGenericModifier(b)) &&
    (uniqueA.length > 0 || uniqueB.length > 0)
  );
}

function scoreProjectFamilyPair(
  a: KB2GraphNodeType,
  b: KB2GraphNodeType,
): { score: number; reason: string; relationshipOnly?: boolean } | null {
  const sharedTokens = getProjectSharedTokens(a, b);
  const anchorOverlap = countOverlap(getProjectEvidenceAnchorKeys(a), getProjectEvidenceAnchorKeys(b));
  if (sharedTokens.length === 0 && anchorOverlap === 0) return null;

  const umbrellaRisk = isUmbrellaProjectPair(a, b, sharedTokens);
  if (umbrellaRisk && (sharedTokens.length >= 1 || anchorOverlap > 0)) {
    return {
      score: 0.84,
      reason: `shared project family signals via tokens [${sharedTokens.join(", ") || "none"}] and ${anchorOverlap} shared source anchors, but scope looks umbrella/subproject-like`,
      relationshipOnly: true,
    };
  }

  if (sharedTokens.length >= 2 && anchorOverlap > 0) {
    return {
      score: 0.96,
      reason: `shared significant tokens [${sharedTokens.join(", ")}] plus ${anchorOverlap} shared source anchors`,
    };
  }

  if (sharedTokens.length >= 3) {
    return {
      score: 0.9,
      reason: `overlap-based project family match via significant tokens [${sharedTokens.join(", ")}]`,
    };
  }

  if (sharedTokens.length >= 2 && (hasProjectGenericModifier(a) || hasProjectGenericModifier(b))) {
    return {
      score: 0.82,
      reason: `shared significant tokens [${sharedTokens.join(", ")}] with one generic modifier`,
    };
  }

  if (anchorOverlap >= 2 && sharedTokens.length >= 1) {
    return {
      score: 0.8,
      reason: `shared source anchors (${anchorOverlap}) and project token overlap [${sharedTokens.join(", ")}]`,
    };
  }

  return null;
}

function shouldAllowFuzzyPairing(type: string): boolean {
  return type !== "ticket" && type !== "pull_request" && type !== "customer_feedback";
}

function rankProjectCanonicalName(node: KB2GraphNodeType): number {
  const lower = node.display_name.toLowerCase();
  let score = node.source_refs.length * 10 + (node.confidence === "high" ? 3 : node.confidence === "medium" ? 1 : 0);
  if (/\b(improvement|design|layout|card|responsiveness|phase|refresh|rollout)\b/.test(lower)) score -= 2;
  if (/\b(page|portal|integration|pipeline)\b/.test(lower)) score += 1;
  score += Math.min(node.display_name.length, 40) / 40;
  return score;
}

function stripProjectPhaseSuffix(value: string): string {
  return normalizeLoose(value)
    .replace(/\bphase\s+\d+\b/g, " ")
    .replace(/\bphase\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isSlackObservationProject(node: KB2GraphNodeType): boolean {
  const origin = String(node.attributes?._candidate_origin ?? "");
  const sourceTypes = new Set((node.source_refs ?? []).map((ref) => ref.source_type));
  return origin === "observation" && sourceTypes.size === 1 && sourceTypes.has("slack");
}

function hasConfluenceProjectSource(node: KB2GraphNodeType): boolean {
  return node.type === "project" && (node.source_refs ?? []).some((ref) => ref.source_type === "confluence");
}

function getProjectMergeCoreTokens(node: KB2GraphNodeType): string[] {
  return getProjectCanonicalTokens(node).filter((token) => !PROJECT_IMPLEMENTATION_SCOPE_TOKENS.has(token));
}

function includesAllTokens(haystack: string[], needles: string[]): boolean {
  if (needles.length === 0) return false;
  return needles.every((token) => haystack.includes(token));
}

function rankDeterministicProjectKeep(node: KB2GraphNodeType): number {
  let score = rankProjectCanonicalName(node);
  if (hasConfluenceProjectSource(node)) score += 8;
  if (/\bphase\s+\d+\b/i.test(node.display_name)) score -= 4;
  if (isSlackObservationProject(node)) score -= 4;
  return score;
}

function getDeterministicProjectAbsorption(
  a: KB2GraphNodeType,
  b: KB2GraphNodeType,
): {
  keep: KB2GraphNodeType;
  remove: KB2GraphNodeType;
  canonicalName: string;
  canonicalKey: string;
  reason: string;
} | null {
  const baseA = stripProjectPhaseSuffix(a.display_name);
  const baseB = stripProjectPhaseSuffix(b.display_name);
  if (baseA && baseA === baseB) {
    const keep = rankDeterministicProjectKeep(a) >= rankDeterministicProjectKeep(b) ? a : b;
    const remove = keep.node_id === a.node_id ? b : a;
    return {
      keep,
      remove,
      canonicalName: keep.display_name,
      canonicalKey: getProjectCanonicalKey(keep) ?? baseA,
      reason: "same project after stripping phase suffix and rollout labels",
    };
  }

  let keep = a;
  let remove = b;
  if (hasConfluenceProjectSource(a) !== hasConfluenceProjectSource(b)) {
    keep = hasConfluenceProjectSource(a) ? a : b;
    remove = keep.node_id === a.node_id ? b : a;
  } else if (rankDeterministicProjectKeep(b) > rankDeterministicProjectKeep(a)) {
    keep = b;
    remove = a;
  }

  if (!hasConfluenceProjectSource(keep)) return null;

  const keepTokens = getProjectCanonicalTokens(keep);
  const removeTokens = getProjectCanonicalTokens(remove);
  const sharedTokens = removeTokens.filter((token) => keepTokens.includes(token));
  if (sharedTokens.length === 0) return null;

  const keepCore = getProjectMergeCoreTokens(keep);
  const removeCore = getProjectMergeCoreTokens(remove);
  const removeCoreSubset = includesAllTokens(keepCore, removeCore);
  const shorthandObservation = isSlackObservationProject(remove) && removeCore.length > 0 && removeCore.length <= 2;
  const implementationFragment = removeTokens.some((token) => PROJECT_IMPLEMENTATION_SCOPE_TOKENS.has(token));
  const removeLooksAbsorbable =
    shorthandObservation ||
    implementationFragment ||
    !hasConfluenceProjectSource(remove);

  if (!removeCoreSubset && !shorthandObservation) return null;
  if (!removeLooksAbsorbable) return null;
  if (sharedTokens.length < 2 && !shorthandObservation) return null;

  return {
    keep,
    remove,
    canonicalName: keep.display_name,
    canonicalKey: getProjectCanonicalKey(keep) ?? normalizeLoose(keep.display_name),
    reason: shorthandObservation
      ? `documented project absorbs shorthand project signal via shared tokens [${sharedTokens.join(", ")}]`
      : `documented project absorbs implementation fragment via shared tokens [${sharedTokens.join(", ")}]`,
  };
}

function summarizeNodeEvidence(node: KB2GraphNodeType): string {
  return node.source_refs
    .slice(0, 2)
    .map((ref, index) => {
      const section = [ref.source_type, ref.title].filter(Boolean).join(" | ");
      const excerpt = String(ref.excerpt ?? "").replace(/\s+/g, " ").trim().slice(0, 220);
      return `     ${index + 1}. ${section}\n        ${excerpt}`;
    })
    .join("\n");
}

interface CandidatePair {
  nodeA: KB2GraphNodeType;
  nodeB: KB2GraphNodeType;
  reason: string;
  score: number;
  ambiguous?: boolean;
}

const CROSS_TYPE_PAIRS: [string, string][] = [
  ["project", "decision"],
  ["project", "process"],
];

const CROSS_TYPE_SIMILARITY_THRESHOLD = 0.5;

const MergeDecisionSchema = z.object({
  decisions: z.array(z.object({
    entity_a: z.string(),
    entity_b: z.string(),
    action: z.enum(["MERGE", "KEEP_SEPARATE", "LINK_RELATIONSHIP"]).describe("MERGE = same entity, KEEP_SEPARATE = distinct, LINK_RELATIONSHIP = related but distinct scopes"),
    should_merge: z.boolean().describe("True only when action is MERGE"),
    unsure: z.boolean().optional().describe("Set true if you cannot confidently decide"),
    canonical_name: z.string().optional(),
    canonical_type: z.string().optional().describe("For cross-type pairs: the correct entity type after merging"),
    relationship_type: z.string().optional().describe("When action is LINK_RELATIONSHIP: e.g. 'parent_project', 'subproject_of', 'implements'"),
    reason: z.string(),
  })),
});

export const entityResolutionStep: StepFunction = async (ctx) => {
  const tc = getTenantCollections(ctx.companySlug);
  const logger = new PrefixLogger("kb2-entity-resolution");

  // Read Step 4's output (latest execution) directly by execution_id
  const step4ExecId = await ctx.getStepExecutionId("pass1", 4);
  const step4Filter = step4ExecId ? { execution_id: step4ExecId } : { run_id: ctx.runId };
  const nodes = (await tc.graph_nodes.find(step4Filter).toArray()) as unknown as KB2GraphNodeType[];

  if (nodes.length === 0) throw new Error("No entities found — run entity extraction first");

  // Load parsed documents for structured Jira status
  const snapshotExecId = await ctx.getStepExecutionId("pass1", 1);
  const snapshot = await tc.input_snapshots.findOne(
    snapshotExecId ? { execution_id: snapshotExecId } : { run_id: ctx.runId },
  );
  const parsedDocs = (snapshot?.parsed_documents ?? []) as KB2ParsedDocument[];

  const model = getFastModel(ctx.config?.pipeline_settings?.models);
  const stepId = "pass1-step-5";

  const resSettings = ctx.config?.pipeline_settings?.entity_resolution;
  const SIMILARITY_THRESHOLD = resSettings?.similarity_threshold ?? FALLBACK_SIMILARITY_THRESHOLD;
  const LLM_BATCH_SIZE = resSettings?.llm_batch_size ?? FALLBACK_LLM_BATCH_SIZE;

  let resolutionPrompt = `You are an entity resolution engine. For each pair of entities, decide: MERGE, KEEP_SEPARATE, or LINK_RELATIONSHIP.

ACTIONS:
- MERGE: They refer to the same real-world thing (set should_merge: true, action: "MERGE").
- KEEP_SEPARATE: They are genuinely different things (set should_merge: false, action: "KEEP_SEPARATE").
- LINK_RELATIONSHIP: They are related but definitely distinct scopes (e.g. umbrella project and subproject, a project and a decision made within it). Set should_merge: false, action: "LINK_RELATIONSHIP", and provide relationship_type.

EVIDENCE-BASED MERGE SIGNALS:
- Shared Jira tickets → default MERGE unless there is clear evidence of distinct scopes.
- Overlapping source documents → default MERGE unless names/types clearly differ.
- Alias overlap or identical base names → strong MERGE signal.

RULES:
- Merge if they clearly refer to the same real-world thing (e.g. "brewgo-app" and "BrewGo App" are the same mobile app repo).
- Do NOT merge if they are genuinely different things (e.g. "brewgo-api" and "brewgo-app" are different repos).
- Do NOT merge if one is a component/part of the other (e.g. "Redis" the database vs "ElastiCache Redis" the cloud resource).
- When merging, pick the most precise/canonical name as the canonical_name.
- If you are unsure (e.g. "Priya" might or might not be "Priya Nair"), set unsure: true and should_merge: false. A human will review.

SCOPE GUARDS:
- Do NOT merge umbrella projects with subprojects. Use LINK_RELATIONSHIP instead.
- Do NOT merge a project with a ticket. A ticket is work WITHIN a project.
- Do NOT merge a project with a single decision made within it.

CROSS-TYPE PAIRS:
- When a pair has different entity types (e.g. one is a "project" and the other is a "decision"), do NOT merge them. Use LINK_RELATIONSHIP instead.
- A project and a decision about that project are distinct entities — link them, do not merge.
- A project and a process within that project are distinct entities — link them, do not merge.
- Only MERGE entities of the same type that refer to the same real-world thing.`;
  if (ctx.config?.prompts?.entity_resolution?.system) {
    resolutionPrompt = ctx.config.prompts.entity_resolution.system;
  }

  await ctx.onProgress(`Finding merge candidates among ${nodes.length} entities...`, 5);

  const nodeMap = new Map<string, KB2GraphNodeType>();
  for (const n of nodes) nodeMap.set(n.node_id, { ...n });

  const peopleHints = ctx.config?.people_hints ?? [];
  const autoMergeFirstNames = resSettings?.auto_merge_first_names !== false;
  const autoMergeDotted = resSettings?.auto_merge_dotted_names !== false;

  const merges: {
    from: string;
    into: string;
    canonicalName: string;
    reason: string;
    from_type?: string;
    into_type?: string;
    canonical_type?: string;
  }[] = [];
  const mergedNodeIds = new Set<string>();
  const keptSeparate: { pair: string; reason: string }[] = [];
  const linkRelationships: { nodeA: string; nodeB: string; relationship: string }[] = [];
  const linkRelationshipKeys = new Set<string>();

  const pushLinkRelationship = (nodeA: string, nodeB: string, relationship: string) => {
    if (!nodeA || !nodeB || nodeA === nodeB) return;
    const key = `${nodeA.toLowerCase()}|||${relationship}|||${nodeB.toLowerCase()}`;
    if (linkRelationshipKeys.has(key)) return;
    linkRelationshipKeys.add(key);
    linkRelationships.push({ nodeA, nodeB, relationship });
  };

  const applyMerge = (keep: KB2GraphNodeType, remove: KB2GraphNodeType, canonicalName: string, newType?: string) => {
    const keepOriginalName = keep.display_name;
    const removeOriginalName = remove.display_name;
    const keepAliases = [...keep.aliases];
    const removeAliases = [...remove.aliases];
    const k = nodeMap.get(keep.node_id)!;
    k.display_name = canonicalName;
    k.aliases = [...new Set([keepOriginalName, removeOriginalName, ...keepAliases, ...removeAliases])]
      .filter((a) => a.toLowerCase() !== canonicalName.toLowerCase());
    k.attributes = { ...remove.attributes, ...keep.attributes };
    k.confidence = keep.confidence === "high" || remove.confidence === "high" ? "high" : keep.confidence;
    const mergedSourceRefs = [...keep.source_refs];
    appendUniqueSourceRefs(mergedSourceRefs, remove.source_refs);
    k.source_refs = mergedSourceRefs;
    if (newType) k.type = newType as any;
    nodeMap.delete(remove.node_id);
    mergedNodeIds.add(remove.node_id);
    return { keepOriginalName, removeOriginalName };
  };

  // Pre-LLM heuristic: person entity auto-merges
  const personNodes = nodes.filter((n) => n.type === "team_member" && !mergedNodeIds.has(n.node_id));
  const firstNameToFullName = new Map<string, string>();
  if (autoMergeFirstNames && personNodes.length > 0) {
    const firstNameCount = new Map<string, KB2GraphNodeType[]>();
    for (const p of personNodes) {
      const firstToken = p.display_name.trim().split(/\s+/)[0]?.toLowerCase();
      if (!firstToken) continue;
      const list = firstNameCount.get(firstToken) ?? [];
      list.push(p);
      firstNameCount.set(firstToken, list);
    }
    for (const [first, list] of firstNameCount) {
      if (list.length === 1) firstNameToFullName.set(first, list[0].display_name);
    }
  }

  const normalizeForMatch = (s: string) =>
    s.toLowerCase().replace(/\./g, " ").replace(/\s+/g, " ").trim();

  for (const node of personNodes) {
    if (mergedNodeIds.has(node.node_id)) continue;
    const tokens = node.display_name.trim().split(/\s+/);
    const isSingleToken = tokens.length === 1;
    const hasDots = node.display_name.includes(".");

    let targetFullName: string | null = null;
    let reason = "";

    for (const hint of peopleHints) {
      const canonical = typeof hint === "string" ? hint : hint.name;
      if (!canonical) continue;
      const normNode = normalizeForMatch(node.display_name);
      const normCanonical = normalizeForMatch(canonical);
      if (normNode === normCanonical) {
        targetFullName = canonical;
        reason = "people hint exact match";
        break;
      }
      if (isSingleToken && normalizeForMatch(tokens[0]!) === normalizeForMatch(canonical.split(/\s+/)[0] ?? "")) {
        targetFullName = canonical;
        reason = "people hint first name";
        break;
      }
    }

    if (!targetFullName && isSingleToken && autoMergeFirstNames) {
      const first = tokens[0]!.toLowerCase();
      const full = firstNameToFullName.get(first);
      if (full) {
        targetFullName = full;
        reason = "first name unique match";
      }
    }

    if (!targetFullName && hasDots && autoMergeDotted) {
      const normNode = normalizeForMatch(node.display_name);
      const matches = personNodes.filter(
        (p) => p.node_id !== node.node_id && !mergedNodeIds.has(p.node_id) && normalizeForMatch(p.display_name) === normNode,
      );
      const canonicalMatch = matches.find((p) => !p.display_name.includes("."));
      if (canonicalMatch) {
        targetFullName = canonicalMatch.display_name;
        reason = "dotted name normalized match";
      } else if (matches[0]) {
        targetFullName = matches[0].display_name;
        reason = "dotted name normalized match";
      }
    }

    if (!targetFullName) continue;

    const matchingNodes = personNodes.filter(
      (p) => !mergedNodeIds.has(p.node_id) && normalizeForMatch(p.display_name) === normalizeForMatch(targetFullName!),
    );
    const candidateKeep = matchingNodes.find((p) => !p.display_name.includes(".")) ?? matchingNodes[0];
    const keepNode = candidateKeep ?? node;
    const removeNode = keepNode === node ? personNodes.find((p) => p !== node && normalizeForMatch(p.display_name) === normalizeForMatch(targetFullName!)) : node;

    if (!removeNode || removeNode === keepNode) {
      if (reason.startsWith("people hint") && normalizeForMatch(node.display_name) !== normalizeForMatch(targetFullName!)) {
        const k = nodeMap.get(node.node_id)!;
        k.aliases = [...new Set([node.display_name, ...node.aliases])].filter((a) => a.toLowerCase() !== targetFullName!.toLowerCase());
        k.display_name = targetFullName!;
        merges.push({
          from: node.display_name,
          into: targetFullName!,
          canonicalName: targetFullName!,
          reason: `pre-LLM heuristic: ${reason}`,
          from_type: node.type,
          into_type: node.type,
          canonical_type: node.type,
        });
      }
      continue;
    }

    const applied = applyMerge(keepNode, removeNode, targetFullName);
    merges.push({
      from: applied.removeOriginalName,
      into: targetFullName,
      canonicalName: targetFullName,
      reason: `pre-LLM heuristic: ${reason}`,
      from_type: removeNode.type,
      into_type: keepNode.type,
      canonical_type: keepNode.type,
    });
  }

  // --- Deterministic identity anchors ---
  const JIRA_KEY_RE = /[A-Z]+-\d+/g;
  const PR_KEY_RE = /(?:^|\s|\/)([\w.-]+\/[\w.-]+)#(\d+)/g;
  const identityMerges: { from: string; into: string; anchor: string }[] = [];

  function extractJiraKeys(node: KB2GraphNodeType): string[] {
    const texts = [node.display_name, ...node.aliases, ...(node.source_refs ?? []).map((r) => r.title)];
    const keys = new Set<string>();
    for (const t of texts) for (const m of t.matchAll(JIRA_KEY_RE)) keys.add(m[0]);
    return [...keys];
  }

  function extractPRKeys(node: KB2GraphNodeType): string[] {
    const texts = [node.display_name, ...node.aliases, ...(node.source_refs ?? []).map((r) => r.title)];
    const keys = new Set<string>();
    for (const t of texts) for (const m of t.matchAll(PR_KEY_RE)) keys.add(`${m[1]}#${m[2]}`);
    return [...keys];
  }

  function inferAnchorKind(anchor: string): "jira" | "pr" {
    return anchor.toLowerCase().startsWith("pr ") ? "pr" : "jira";
  }

  function rankIdentityCanonicalCandidate(node: KB2GraphNodeType, anchorKind: "jira" | "pr"): number {
    let score =
      node.source_refs.length * 5 +
      (node.confidence === "high" ? 5 : node.confidence === "medium" ? 2 : 0);
    const origin = String(node.attributes?._candidate_origin ?? "");
    if (origin.includes("project-surface")) score += 8;
    if (anchorKind === "jira") {
      if (!RAW_JIRA_KEY_ONLY_RE.test(node.display_name.trim())) score += 18;
    }
    if (anchorKind === "pr") {
      if (!/\bPR\s+#\d+\b/i.test(node.display_name)) score += 18;
      if (RAW_PR_TITLE_RE.test(node.display_name.trim())) score -= 8;
    }
    if (/\b(feature|page|portal|browser|calendar|tracking|comparison|donation|orders|responsiveness)\b/i.test(node.display_name)) {
      score += 2;
    }
    score += Math.min(node.display_name.length, 40) / 40;
    return score;
  }

  function pickIdentityCanonicalName(group: KB2GraphNodeType[], anchor: string): string {
    const anchorKind = inferAnchorKind(anchor);
    return [...group]
      .sort((a, b) => rankIdentityCanonicalCandidate(b, anchorKind) - rankIdentityCanonicalCandidate(a, anchorKind))[0]
      ?.display_name ?? group[0]?.display_name ?? anchor;
  }

  const ticketByKey = new Map<string, KB2GraphNodeType[]>();
  const prByKey = new Map<string, KB2GraphNodeType[]>();
  const crossTypeAnchors: { nodeA: string; nodeB: string; anchor: string; relationship_type: string }[] = [];

  for (const node of nodes) {
    if (mergedNodeIds.has(node.node_id)) continue;
    if (node.type === "ticket") {
      for (const k of extractJiraKeys(node)) {
        const list = ticketByKey.get(k) ?? [];
        list.push(node);
        ticketByKey.set(k, list);
      }
    }
    if (node.type === "pull_request") {
      for (const k of extractPRKeys(node)) {
        const list = prByKey.get(k) ?? [];
        list.push(node);
        prByKey.set(k, list);
      }
    }
  }

  // Collect cross-type anchor references (non-ticket/PR nodes referencing a Jira key or PR)
  for (const node of nodes) {
    if (mergedNodeIds.has(node.node_id)) continue;
    if (node.type === "ticket" || node.type === "pull_request") continue;
    for (const k of extractJiraKeys(node)) {
      const ticketGroup = ticketByKey.get(k);
      if (ticketGroup && ticketGroup.length > 0) {
        crossTypeAnchors.push({
          nodeA: node.display_name,
          nodeB: ticketGroup[0].display_name,
          anchor: `Jira key ${k}`,
          relationship_type: "references_ticket",
        });
      }
    }
    for (const k of extractPRKeys(node)) {
      const prGroup = prByKey.get(k);
      if (prGroup && prGroup.length > 0) {
        crossTypeAnchors.push({
          nodeA: node.display_name,
          nodeB: prGroup[0].display_name,
          anchor: `PR ${k}`,
          relationship_type: "references_pr",
        });
      }
    }
  }

  const mergeIdentityGroup = (group: KB2GraphNodeType[], anchor: string) => {
    if (group.length < 2) return;
    const sorted = [...group].sort((a, b) => b.source_refs.length - a.source_refs.length);
    const keep = sorted[0];
    const canonicalName = pickIdentityCanonicalName(sorted, anchor);
    for (let i = 1; i < sorted.length; i++) {
      const remove = sorted[i];
      if (mergedNodeIds.has(keep.node_id) || mergedNodeIds.has(remove.node_id)) continue;
      const applied = applyMerge(keep, remove, canonicalName);
      const loggedFrom =
        applied.removeOriginalName.toLowerCase() === canonicalName.toLowerCase() &&
        applied.keepOriginalName.toLowerCase() !== canonicalName.toLowerCase()
          ? applied.keepOriginalName
          : applied.removeOriginalName;
      merges.push({
        from: loggedFrom,
        into: canonicalName,
        canonicalName,
        reason: `identity anchor: ${anchor}`,
        from_type: remove.type,
        into_type: keep.type,
        canonical_type: keep.type,
      });
      identityMerges.push({ from: loggedFrom, into: canonicalName, anchor });
    }
  };

  for (const [key, group] of ticketByKey) {
    const live = group.filter((n) => !mergedNodeIds.has(n.node_id));
    mergeIdentityGroup(live, `Jira ticket ${key}`);
  }
  for (const [key, group] of prByKey) {
    const live = group.filter((n) => !mergedNodeIds.has(n.node_id));
    mergeIdentityGroup(live, `PR ${key}`);
  }

  const projectFamilyMerges: { from: string; into: string; canonical_key: string }[] = [];
  const projectFamilyReviews: { pair: string; reason: string; relationship_only?: boolean }[] = [];
  const seededProjectRelationships: { nodeA: string; nodeB: string; relationship: string }[] = [];

  let deterministicProjectMergeApplied = true;
  while (deterministicProjectMergeApplied) {
    deterministicProjectMergeApplied = false;
    const liveProjectNodes = [...nodeMap.values()].filter(
      (node) => node.type === "project" && !mergedNodeIds.has(node.node_id),
    );

    outer: for (let i = 0; i < liveProjectNodes.length; i++) {
      for (let j = i + 1; j < liveProjectNodes.length; j++) {
        const mergePlan = getDeterministicProjectAbsorption(liveProjectNodes[i], liveProjectNodes[j]);
        if (!mergePlan) continue;

        const applied = applyMerge(mergePlan.keep, mergePlan.remove, mergePlan.canonicalName);
        const loggedFrom =
          applied.removeOriginalName.toLowerCase() === mergePlan.canonicalName.toLowerCase() &&
          applied.keepOriginalName.toLowerCase() !== mergePlan.canonicalName.toLowerCase()
            ? applied.keepOriginalName
            : applied.removeOriginalName;

        merges.push({
          from: loggedFrom,
          into: mergePlan.canonicalName,
          canonicalName: mergePlan.canonicalName,
          reason: mergePlan.reason,
          from_type: mergePlan.remove.type,
          into_type: mergePlan.keep.type,
          canonical_type: mergePlan.keep.type,
        });
        projectFamilyMerges.push({
          from: loggedFrom,
          into: mergePlan.canonicalName,
          canonical_key: mergePlan.canonicalKey,
        });
        projectFamilyReviews.push({
          pair: `${mergePlan.keep.display_name} / ${mergePlan.remove.display_name}`,
          reason: mergePlan.reason,
        });
        deterministicProjectMergeApplied = true;
        break outer;
      }
    }
  }

  const byType = new Map<string, KB2GraphNodeType[]>();
  for (const node of [...nodeMap.values()]) {
    if (mergedNodeIds.has(node.node_id)) continue;
    const list = byType.get(node.type) ?? [];
    list.push(node);
    byType.set(node.type, list);
  }

  const candidates: CandidatePair[] = [];

  for (const [type, typeNodes] of byType) {
    for (let i = 0; i < typeNodes.length; i++) {
      for (let j = i + 1; j < typeNodes.length; j++) {
        const a = typeNodes[i];
        const b = typeNodes[j];

        if (type === "cloud_resource") {
          const baseA = stripEnvSuffix(a.display_name);
          const baseB = stripEnvSuffix(b.display_name);
          if (baseA && baseB && baseA === baseB) {
            candidates.push({ nodeA: a, nodeB: b, reason: "cloud_resource same base name (env suffix stripped)", score: 1.0 });
            continue;
          }
        }

        if (aliasOverlap(a, b)) {
          candidates.push({ nodeA: a, nodeB: b, reason: "alias overlap", score: 1.0 });
          continue;
        }

        if (!shouldAllowFuzzyPairing(type)) {
          continue;
        }

        if (type === "project") {
          const projectPair = scoreProjectFamilyPair(a, b);
          if (projectPair?.relationshipOnly) {
            seededProjectRelationships.push({
              nodeA: a.display_name,
              nodeB: b.display_name,
              relationship: "related_scope",
            });
            projectFamilyReviews.push({
              pair: `${a.display_name} / ${b.display_name}`,
              reason: projectPair.reason,
              relationship_only: true,
            });
            continue;
          }
          if (projectPair) {
            candidates.push({
              nodeA: a,
              nodeB: b,
              reason: projectPair.reason,
              score: projectPair.score,
              ambiguous: projectPair.score < 0.9,
            });
            projectFamilyReviews.push({
              pair: `${a.display_name} / ${b.display_name}`,
              reason: projectPair.reason,
            });
            continue;
          }
        }

        if (substringMatch(a.display_name, b.display_name)) {
          candidates.push({ nodeA: a, nodeB: b, reason: `substring match: "${a.display_name}" / "${b.display_name}"`, score: 0.8, ambiguous: true });
          continue;
        }

        const nameSim = tokenSimilarity(a.display_name, b.display_name);
        const projectNameThreshold = type === "project" ? Math.max(SIMILARITY_THRESHOLD, 0.68) : SIMILARITY_THRESHOLD;
        if (nameSim >= projectNameThreshold) {
          candidates.push({ nodeA: a, nodeB: b, reason: `name similarity ${nameSim.toFixed(2)}`, score: nameSim });
          continue;
        }

        if (type === "project") {
          continue;
        }

        for (const aliasA of a.aliases) {
          for (const aliasB of [...b.aliases, b.display_name]) {
            const aliasSim = tokenSimilarity(aliasA, aliasB);
            if (aliasSim >= SIMILARITY_THRESHOLD) {
              candidates.push({ nodeA: a, nodeB: b, reason: `alias similarity: "${aliasA}" ~ "${aliasB}" (${aliasSim.toFixed(2)})`, score: aliasSim });
              break;
            }
          }
          if (candidates.length > 0 && candidates[candidates.length - 1].nodeA === a && candidates[candidates.length - 1].nodeB === b) break;
        }

      }
    }
  }

  // --- Evidence-based blocking: shared Jira tickets / PRs ---
  const evidenceBasedMatches: { nodeA: string; nodeB: string; evidence: string }[] = [];
  const allLiveNodes = [...nodeMap.values()];
  const evidenceIndex = new Map<string, Set<string>>();

  for (const node of allLiveNodes) {
    for (const k of extractJiraKeys(node)) {
      const set = evidenceIndex.get(`jira:${k}`) ?? new Set();
      set.add(node.node_id);
      evidenceIndex.set(`jira:${k}`, set);
    }
    for (const k of extractPRKeys(node)) {
      const set = evidenceIndex.get(`pr:${k}`) ?? new Set();
      set.add(node.node_id);
      evidenceIndex.set(`pr:${k}`, set);
    }
  }

  const evidencePairKeys = new Set(candidates.map((c) => [c.nodeA.node_id, c.nodeB.node_id].sort().join("|||")));

  for (const [evidence, nodeIds] of evidenceIndex) {
    const ids = [...nodeIds];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const key = [ids[i], ids[j]].sort().join("|||");
        if (evidencePairKeys.has(key)) continue;
        evidencePairKeys.add(key);
        const nA = nodeMap.get(ids[i]);
        const nB = nodeMap.get(ids[j]);
        if (!nA || !nB) continue;
        const [kind, ref] = evidence.split(":");
        const relationship = kind === "jira" ? "references_ticket" : "references_pr";
        if (nA.type !== nB.type) {
          pushLinkRelationship(nA.display_name, nB.display_name, relationship);
          continue;
        }
        const reason = kind === "jira" ? `shared Jira ticket ${ref}` : `shared PR ${ref}`;
        candidates.push({ nodeA: nA, nodeB: nB, reason, score: 0.95 });
        evidenceBasedMatches.push({ nodeA: nA.display_name, nodeB: nB.display_name, evidence: reason });
      }
    }
  }

  // 5A: Pre-seed candidates from Step 4's _likely_duplicates annotations
  const nodeByName = new Map<string, KB2GraphNodeType>();
  for (const node of nodes) {
    if (mergedNodeIds.has(node.node_id)) continue;
    nodeByName.set(node.display_name.toLowerCase(), node);
  }

  const candidateKey = (a: KB2GraphNodeType, b: KB2GraphNodeType) =>
    [a.node_id, b.node_id].sort().join("|||");
  const existingPairKeys = new Set(candidates.map((c) => candidateKey(c.nodeA, c.nodeB)));

  for (const node of nodes) {
    if (mergedNodeIds.has(node.node_id)) continue;
    const likelyDupes = node.attributes?._likely_duplicates as string[] | undefined;
    if (!likelyDupes?.length) continue;
    for (const dupeName of likelyDupes) {
      const other = nodeByName.get(dupeName.toLowerCase());
      if (!other || other.node_id === node.node_id) continue;
      if (mergedNodeIds.has(other.node_id)) continue;
      const key = candidateKey(node, other);
      if (existingPairKeys.has(key)) continue;
      existingPairKeys.add(key);
      candidates.push({
        nodeA: node,
        nodeB: other,
        reason: `pre-seeded from step4 _likely_duplicates`,
        score: 0.7,
      });
    }
  }

  // 5B: Cross-type similarity should create link relationships, not merge candidates.
  for (const [typeA, typeB] of CROSS_TYPE_PAIRS) {
    const nodesA = byType.get(typeA) ?? [];
    const nodesB = byType.get(typeB) ?? [];
    for (const a of nodesA) {
      if (mergedNodeIds.has(a.node_id)) continue;
      for (const b of nodesB) {
        if (mergedNodeIds.has(b.node_id)) continue;
        const key = candidateKey(a, b);
        if (existingPairKeys.has(key)) continue;

        const relationship = typeB === "decision" ? "related_decision" : "related_process";
        if (aliasOverlap(a, b)) {
          existingPairKeys.add(key);
          pushLinkRelationship(a.display_name, b.display_name, relationship);
          continue;
        }
        if (substringMatch(a.display_name, b.display_name)) {
          existingPairKeys.add(key);
          pushLinkRelationship(a.display_name, b.display_name, relationship);
          continue;
        }
        const nameSim = tokenSimilarity(a.display_name, b.display_name);
        if (nameSim >= CROSS_TYPE_SIMILARITY_THRESHOLD) {
          existingPairKeys.add(key);
          pushLinkRelationship(a.display_name, b.display_name, relationship);
        }
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  await ctx.onProgress(`Found ${candidates.length} candidate pairs for LLM review`, 15);

  if (candidates.length === 0) {
    for (const n of nodeMap.values()) {
      if (n.attributes?._likely_duplicates) delete n.attributes._likely_duplicates;
    }
    const earlyResolved = [...nodeMap.values()].map((node) => {
      const { _id, ...rest } = node as typeof node & { _id?: unknown };
      void _id;
      return { ...rest, execution_id: ctx.executionId };
    });
    if (earlyResolved.length > 0) await tc.graph_nodes.insertMany(earlyResolved as any[]);
    const earlyBeforeByType: Record<string, number> = {};
    for (const n of nodes) earlyBeforeByType[n.type] = (earlyBeforeByType[n.type] ?? 0) + 1;
    const earlyAfterByType: Record<string, number> = {};
    for (const n of nodeMap.values()) earlyAfterByType[n.type] = (earlyAfterByType[n.type] ?? 0) + 1;
    const finalCount = nodes.length - mergedNodeIds.size;
    await ctx.onProgress(`Entity resolution complete: ${nodes.length} → ${finalCount} entities (${merges.length} pre-LLM merges)`, 100);
    return {
      total_entities_before: nodes.length,
      total_entities_after: finalCount,
      before_count_by_type: earlyBeforeByType,
      after_count_by_type: earlyAfterByType,
      candidates_found: 0,
      merges_performed: merges.length,
      identity_merges: { count: identityMerges.length, details: identityMerges },
      evidence_based_matches: { count: evidenceBasedMatches.length, details: evidenceBasedMatches },
      project_family_merges: { count: projectFamilyMerges.length, details: projectFamilyMerges },
      project_family_reviews: projectFamilyReviews,
      clusters_adjudicated: { count: 0, results: [] },
      kept_separate: [],
      link_relationships: [],
      type_reconciliations: [],
      status_corrections: [],
      llm_calls: 0,
      merges,
    };
  }

  let totalLLMCalls = 0;

  // Add cross-type identity anchor references
  for (const cta of crossTypeAnchors) {
    pushLinkRelationship(cta.nodeA, cta.nodeB, cta.relationship_type);
  }
  for (const seeded of seededProjectRelationships) {
    pushLinkRelationship(seeded.nodeA, seeded.nodeB, seeded.relationship);
  }

  const totalBatches = Math.ceil(candidates.length / LLM_BATCH_SIZE);
  for (let i = 0; i < candidates.length; i += LLM_BATCH_SIZE) {
    if (ctx.signal.aborted) throw new Error("Pipeline cancelled by user");
    const batch = candidates.slice(i, i + LLM_BATCH_SIZE);
    const batchNum = Math.floor(i / LLM_BATCH_SIZE) + 1;

    const pairsText = batch.map((pair, idx) => {
      const aAliases = pair.nodeA.aliases.length > 0 ? ` (aliases: ${pair.nodeA.aliases.join(", ")})` : "";
      const bAliases = pair.nodeB.aliases.length > 0 ? ` (aliases: ${pair.nodeB.aliases.join(", ")})` : "";
      return `${idx + 1}. Entity A: "${pair.nodeA.display_name}" [${pair.nodeA.type}]${aAliases} (${pair.nodeA.source_refs.length} sources, confidence: ${pair.nodeA.confidence})
   Entity B: "${pair.nodeB.display_name}" [${pair.nodeB.type}]${bAliases} (${pair.nodeB.source_refs.length} sources, confidence: ${pair.nodeB.confidence})
   Candidate reason: ${pair.reason}
   Evidence A:
${summarizeNodeEvidence(pair.nodeA)}
   Evidence B:
${summarizeNodeEvidence(pair.nodeB)}`;
    }).join("\n\n");

    await ctx.onProgress(`LLM call ${batchNum}/${totalBatches}: reviewing ${batch.length} candidate pairs`, Math.round(15 + (i / candidates.length) * 70));

    const startMs = Date.now();
    let usageData: { promptTokens: number; completionTokens: number } | null = null;

    const result = await structuredGenerate({
      model,
      system: resolutionPrompt,
      prompt: pairsText,
      schema: MergeDecisionSchema,
      logger,
      onUsage: (usage) => { usageData = usage; },
      signal: ctx.signal,
    });
    totalLLMCalls++;

    if (usageData) {
      const durationMs = Date.now() - startMs;
      const cost = calculateCostUsd(getFastModelName(ctx.config?.pipeline_settings?.models), usageData.promptTokens, usageData.completionTokens);
      ctx.logLLMCall(stepId, getFastModelName(ctx.config?.pipeline_settings?.models), pairsText, JSON.stringify(result, null, 2), usageData.promptTokens, usageData.completionTokens, cost, durationMs);
    }

    const ambiguousCards: Array<KB2VerificationCardType & { execution_id: string }> = [];
    for (const decision of result.decisions ?? []) {
      if (!decision.should_merge && decision.unsure) {
        const pair = batch.find((p) =>
          (p.nodeA.display_name === decision.entity_a && p.nodeB.display_name === decision.entity_b) ||
          (p.nodeA.display_name === decision.entity_b && p.nodeB.display_name === decision.entity_a),
        );
        if (pair && !mergedNodeIds.has(pair.nodeA.node_id) && !mergedNodeIds.has(pair.nodeB.node_id)) {
          ambiguousCards.push({
            card_id: randomUUID(),
            run_id: ctx.runId,
            execution_id: ctx.executionId,
            card_type: "duplicate_cluster",
            severity: "S3",
            title: `Possible duplicate: "${pair.nodeA.display_name}" and "${pair.nodeB.display_name}"`,
            explanation: `These two ${pair.nodeA.type} entities might be the same. ${decision.reason}`,
            supporting_evidence: [...pair.nodeA.source_refs.slice(0, 2), ...pair.nodeB.source_refs.slice(0, 2)].map((ref) => ({
              text: ref.excerpt,
              source_title: ref.title,
              confidence: "medium",
            })),
            missing_evidence: [],
            affected_entities: [
              { entity_name: pair.nodeA.display_name, entity_type: pair.nodeA.type, relationship: "possible_duplicate" },
              { entity_name: pair.nodeB.display_name, entity_type: pair.nodeB.type, relationship: "possible_duplicate" },
            ],
            required_data: [],
            canonical_text: JSON.stringify({
              entity_a: { node_id: pair.nodeA.node_id, display_name: pair.nodeA.display_name, aliases: pair.nodeA.aliases },
              entity_b: { node_id: pair.nodeB.node_id, display_name: pair.nodeB.display_name, aliases: pair.nodeB.aliases },
            }),
            page_occurrences: [],
            source_refs: [...pair.nodeA.source_refs.slice(0, 3), ...pair.nodeB.source_refs.slice(0, 3)],
            assigned_to: [],
            claim_ids: [],
            status: "open",
            discussion: [],
          });
        }
        continue;
      }

      if (decision.action === "LINK_RELATIONSHIP" && !decision.should_merge) {
        linkRelationships.push({
          nodeA: decision.entity_a,
          nodeB: decision.entity_b,
          relationship: decision.relationship_type ?? "related",
        });
        continue;
      }

      if (!decision.should_merge) {
        keptSeparate.push({ pair: `${decision.entity_a} / ${decision.entity_b}`, reason: decision.reason });
        continue;
      }

      const pair = batch.find((p) =>
        (p.nodeA.display_name === decision.entity_a && p.nodeB.display_name === decision.entity_b) ||
        (p.nodeA.display_name === decision.entity_b && p.nodeB.display_name === decision.entity_a),
      );
      if (!pair) continue;
      if (mergedNodeIds.has(pair.nodeA.node_id) || mergedNodeIds.has(pair.nodeB.node_id)) continue;

      // Safety guard: cross-type pairs must not merge — convert to LINK_RELATIONSHIP
      if (pair.nodeA.type !== pair.nodeB.type) {
        linkRelationships.push({
          nodeA: decision.entity_a,
          nodeB: decision.entity_b,
          relationship: decision.relationship_type ?? "related",
        });
        logger.log(`Cross-type merge blocked: "${decision.entity_a}" [${pair.nodeA.type}] / "${decision.entity_b}" [${pair.nodeB.type}] → LINK_RELATIONSHIP`);
        continue;
      }

      const keepNode = pair.nodeA.source_refs.length >= pair.nodeB.source_refs.length ? pair.nodeA : pair.nodeB;
      const removeNode = keepNode === pair.nodeA ? pair.nodeB : pair.nodeA;

      const canonicalName = decision.canonical_name || keepNode.display_name;
      const newType = (decision.canonical_type && keepNode.type !== removeNode.type) ? decision.canonical_type : undefined;
      const applied = applyMerge(keepNode, removeNode, canonicalName, newType);
      const loggedFrom =
        applied.removeOriginalName.toLowerCase() === canonicalName.toLowerCase() &&
        applied.keepOriginalName.toLowerCase() !== canonicalName.toLowerCase()
          ? applied.keepOriginalName
          : applied.removeOriginalName;

      merges.push({
        from: loggedFrom,
        into: canonicalName,
        canonicalName,
        reason: decision.reason,
        from_type: removeNode.type,
        into_type: keepNode.type,
        canonical_type: newType ?? keepNode.type,
      });
      if (pair.nodeA.type === "project" && pair.nodeB.type === "project") {
        projectFamilyMerges.push({
          from: loggedFrom,
          into: canonicalName,
          canonical_key: getProjectCanonicalKey(keepNode) ?? normalizeLoose(canonicalName),
        });
      }
    }

    if (ambiguousCards.length > 0) {
      await tc.verification_cards.insertMany(ambiguousCards);
    }
  }

  // --- Cluster adjudication: transitive closure of merges ---
  const clustersAdjudicated: { count: number; results: { cluster: string[]; decision: string }[] } = { count: 0, results: [] };
  {
    const mergeGraph = new Map<string, Set<string>>();
    for (const m of merges) {
      const fromNode = nodes.find((n) => n.display_name === m.from);
      const intoNode = nodes.find((n) => n.display_name === m.into || n.display_name === m.canonicalName);
      if (!fromNode || !intoNode) continue;
      if (!mergeGraph.has(fromNode.node_id)) mergeGraph.set(fromNode.node_id, new Set());
      if (!mergeGraph.has(intoNode.node_id)) mergeGraph.set(intoNode.node_id, new Set());
      mergeGraph.get(fromNode.node_id)!.add(intoNode.node_id);
      mergeGraph.get(intoNode.node_id)!.add(fromNode.node_id);
    }

    const visited = new Set<string>();
    const clusters: string[][] = [];
    for (const nodeId of mergeGraph.keys()) {
      if (visited.has(nodeId)) continue;
      const cluster: string[] = [];
      const queue = [nodeId];
      while (queue.length > 0) {
        const cur = queue.pop()!;
        if (visited.has(cur)) continue;
        visited.add(cur);
        cluster.push(cur);
        for (const neighbor of mergeGraph.get(cur) ?? []) {
          if (!visited.has(neighbor)) queue.push(neighbor);
        }
      }
      if (cluster.length >= 3) clusters.push(cluster);
    }

    if (clusters.length > 0) {
      const reasoningModel = getReasoningModel(ctx.config?.pipeline_settings?.models);
      const ClusterSchema = z.object({
        decisions: z.array(z.object({
          cluster_label: z.string(),
          action: z.enum(["CONFIRM_MERGE_ALL", "SPLIT"]).describe("CONFIRM_MERGE_ALL if all are the same entity, SPLIT if some should stay separate"),
          keep_merged: z.array(z.string()).describe("node_ids that should be merged together"),
          split_out: z.array(z.string()).optional().describe("node_ids that should NOT be in this cluster"),
          reason: z.string(),
        })),
      });

      for (const cluster of clusters) {
        if (ctx.signal.aborted) throw new Error("Pipeline cancelled by user");
        const clusterNodes = cluster.map((id) => nodeMap.get(id) ?? nodes.find((n) => n.node_id === id)).filter(Boolean) as KB2GraphNodeType[];
        if (clusterNodes.length < 3) continue;

        const clusterText = clusterNodes.map((n, idx) =>
          `${idx + 1}. "${n.display_name}" [${n.type}] (aliases: ${n.aliases.join(", ") || "none"}, ${n.source_refs.length} sources)`,
        ).join("\n");

        const adjPrompt = `These ${clusterNodes.length} entities were pairwise-determined to be duplicates, forming a transitive cluster. Review whether they should ALL be merged into one, or if some should be split out.\n\n${clusterText}`;

        const adjStart = Date.now();
        let adjUsage: { promptTokens: number; completionTokens: number } | null = null;

        const adjResult = await structuredGenerate({
          model: reasoningModel,
          system: "You are an expert entity resolution adjudicator. Given a cluster of entities that were pairwise-matched as duplicates, decide if the entire cluster is truly one entity or if some members should be split out.",
          prompt: adjPrompt,
          schema: ClusterSchema,
          logger,
          onUsage: (usage) => { adjUsage = usage; },
          signal: ctx.signal,
        });
        totalLLMCalls++;

        if (adjUsage) {
          const durationMs = Date.now() - adjStart;
          const cost = calculateCostUsd(getReasoningModelName(ctx.config?.pipeline_settings?.models), adjUsage.promptTokens, adjUsage.completionTokens);
          ctx.logLLMCall(stepId, getReasoningModelName(ctx.config?.pipeline_settings?.models), adjPrompt, JSON.stringify(adjResult, null, 2), adjUsage.promptTokens, adjUsage.completionTokens, cost, durationMs);
        }

        for (const d of adjResult.decisions ?? []) {
          clustersAdjudicated.count++;
          clustersAdjudicated.results.push({ cluster: cluster.map((id) => nodeMap.get(id)?.display_name ?? id), decision: d.action });

          if (d.action === "SPLIT" && d.split_out?.length) {
            for (const splitId of d.split_out) {
              const splitNode = nodes.find((n) => n.node_id === splitId);
              if (splitNode && mergedNodeIds.has(splitId)) {
                nodeMap.set(splitId, { ...splitNode, execution_id: ctx.executionId });
                mergedNodeIds.delete(splitId);
              }
            }
          }
        }
      }
    }
  }

  // Strip _likely_duplicates from surviving nodes
  for (const n of nodeMap.values()) {
    if (n.attributes?._likely_duplicates) {
      delete n.attributes._likely_duplicates;
    }
  }

  // Write resolved nodes with this execution's id
  await ctx.onProgress("Writing resolved entities...", 90);
  const resolvedNodes = [...nodeMap.values()].map((node) => {
    const { _id, ...rest } = node as typeof node & { _id?: unknown };
    void _id;
    return { ...rest, execution_id: ctx.executionId };
  });
  if (resolvedNodes.length > 0) {
    await tc.graph_nodes.insertMany(resolvedNodes as any[]);
  }

  // --- Post-resolution type reconciliation ---
  const typeReconciliations: { node: string; old_type: string; new_type: string }[] = [];
  for (const node of nodeMap.values()) {
    const jiraKeys = extractJiraKeys(node);
    const prKeys = extractPRKeys(node);
    const hasTimeline = node.attributes?.start_date || node.attributes?.end_date || node.attributes?.timeline;
    const projectLikeLabel =
      /\b(page|portal|browser|browse|tracking|calendar|chooser|navigation|comparison|feature|integration|pipeline|responsiveness|redesign|search|profile|profiles|setup|standardization)\b/i
        .test(`${node.display_name} ${node.attributes?.description ?? ""}`);
    const hasStructuredWorkRefs =
      jiraKeys.length > 0 ||
      prKeys.length > 0 ||
      (node.source_refs?.some((ref) => ref.source_type === "confluence") ?? false);

    let newType: string | null = null;

    if ((jiraKeys.length > 0 || prKeys.length > 0) && hasTimeline && node.type !== "project") {
      const evidenceCount = (node.source_refs?.length ?? 0) + jiraKeys.length + prKeys.length;
      if (projectLikeLabel && evidenceCount >= 2) {
        newType = "project";
      }
    } else if (
      node.type !== "decision" &&
      /\b(chose|chosen|decision|alternative|option|pick|select)\b/i.test(
        `${node.display_name} ${node.attributes?.description ?? ""}`,
      )
    ) {
      newType = "decision";
    } else if (
      node.type !== "process" &&
      /\b(workflow|pipeline|runbook|playbook|procedure|recurring|repeatable)\b/i.test(
        `${node.display_name} ${node.attributes?.description ?? ""}`,
      ) &&
      !(projectLikeLabel && hasStructuredWorkRefs)
    ) {
      newType = "process";
    }

    if (newType && newType !== node.type) {
      typeReconciliations.push({ node: node.display_name, old_type: node.type, new_type: newType });
      node.type = newType as any;
    }
  }

  if (typeReconciliations.length > 0) {
    const bulkOps = typeReconciliations.map((tr) => {
      const n = [...nodeMap.values()].find((nd) => nd.display_name === tr.node);
      return n ? { updateOne: { filter: { node_id: n.node_id, execution_id: ctx.executionId }, update: { $set: { type: tr.new_type } } } } : null;
    }).filter(Boolean);
    if (bulkOps.length > 0) await tc.graph_nodes.bulkWrite(bulkOps as any[]);
  }

  // --- Post-resolution status corrections (structured Jira status) ---
  const statusCorrections: { node: string; old_status: string; new_status: string; source: string }[] = [];

  // Build Jira status map from parsed documents
  const jiraStatusMap = new Map<string, { key: string; status: string; summary: string }[]>();
  for (const doc of parsedDocs) {
    if (doc.provider !== "jira") continue;
    const key = (doc as any).external_id || doc.title;
    const projectPrefix = key.match(/^([A-Z]+-)\d+$/)?.[1];
    if (!projectPrefix) continue;
    const statusMatch = doc.content?.match(/Status:\s*(\w[\w\s]*\w)/i);
    const ticketStatus = statusMatch?.[1]?.trim().toLowerCase() ?? "unknown";
    const existing = jiraStatusMap.get(key) ?? [];
    existing.push({ key, status: ticketStatus, summary: doc.title });
    jiraStatusMap.set(key, existing);
  }

  for (const node of nodeMap.values()) {
    if (node.type !== "project" && node.type !== "process") continue;
    const jiraRefs = (node.source_refs ?? []).filter((r) => r.source_type === "jira");
    if (jiraRefs.length === 0) continue;

    const currentStatus = (node.attributes?.status as string) ?? "";
    const linkedStatuses: string[] = [];

    for (const ref of jiraRefs) {
      const refKey = ref.doc_id || ref.title;
      const tickets = jiraStatusMap.get(refKey);
      if (tickets) {
        for (const t of tickets) linkedStatuses.push(t.status);
      }
    }

    if (linkedStatuses.length === 0) continue;

    let newStatus: string | null = null;
    const allDone = linkedStatuses.every((s) => ["done", "closed", "resolved", "complete"].includes(s));
    const anyInProgress = linkedStatuses.some((s) => ["in progress", "in review", "active", "in development"].includes(s));
    const allBacklog = linkedStatuses.every((s) => ["backlog", "to do", "open", "new"].includes(s));

    if (allDone) newStatus = "completed";
    else if (anyInProgress) newStatus = "active";
    else if (allBacklog) newStatus = "proposed";

    if (newStatus && newStatus !== currentStatus) {
      statusCorrections.push({ node: node.display_name, old_status: currentStatus || "(none)", new_status: newStatus, source: "jira-structured" });
      node.attributes = { ...node.attributes, status: newStatus };
    }
  }

  if (statusCorrections.length > 0) {
    const bulkOps = statusCorrections.map((sc) => {
      const n = [...nodeMap.values()].find((nd) => nd.display_name === sc.node);
      return n ? { updateOne: { filter: { node_id: n.node_id, execution_id: ctx.executionId }, update: { $set: { "attributes.status": sc.new_status } } } } : null;
    }).filter(Boolean);
    if (bulkOps.length > 0) await tc.graph_nodes.bulkWrite(bulkOps as any[]);
  }

  // --- Build artifact ---
  const beforeCountByType: Record<string, number> = {};
  for (const n of nodes) beforeCountByType[n.type] = (beforeCountByType[n.type] ?? 0) + 1;
  const afterCountByType: Record<string, number> = {};
  for (const n of nodeMap.values()) afterCountByType[n.type] = (afterCountByType[n.type] ?? 0) + 1;
  const resolvedTitlesByType = [...nodeMap.values()].reduce<Record<string, string[]>>((acc, node) => {
    (acc[node.type] ??= []).push(node.display_name);
    return acc;
  }, {});
  for (const titles of Object.values(resolvedTitlesByType)) {
    titles.sort((a, b) => a.localeCompare(b));
  }

  const finalCount = nodes.length - mergedNodeIds.size;
  await ctx.onProgress(`Entity resolution complete: ${nodes.length} → ${finalCount} entities (${merges.length} merges)`, 100);

  return {
    total_entities_before: nodes.length,
    total_entities_after: finalCount,
    before_count_by_type: beforeCountByType,
    after_count_by_type: afterCountByType,
    resolved_titles_by_type: resolvedTitlesByType,
    resolved_repository_titles: resolvedTitlesByType.repository ?? [],
    resolved_project_titles: resolvedTitlesByType.project ?? [],
    resolved_team_member_titles: resolvedTitlesByType.team_member ?? [],
    candidates_found: candidates.length,
    merges_performed: merges.length,
    identity_merges: { count: identityMerges.length, details: identityMerges },
    project_family_merges: { count: projectFamilyMerges.length, details: projectFamilyMerges },
    project_family_reviews: projectFamilyReviews,
    evidence_based_matches: { count: evidenceBasedMatches.length, details: evidenceBasedMatches },
    clusters_adjudicated: clustersAdjudicated,
    kept_separate: keptSeparate,
    link_relationships: linkRelationships,
    type_reconciliations: typeReconciliations,
    status_corrections: statusCorrections,
    llm_calls: totalLLMCalls,
    merges,
    artifact_version: "pass1_v2",
  };
};
