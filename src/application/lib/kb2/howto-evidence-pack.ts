import type { KB2GraphNodeType, KB2GraphEdgeType, KB2EntityPageType, KB2EvidenceRefType } from "@/src/entities/models/kb2-types";
import type { KB2ParsedDocument } from "@/src/application/lib/kb2/confluence-parser";
import { hasGuideTokenOverlap, collectPageText, normalizeNodeLookupKey, dedupeHowtoEvidenceRefs, formatHowtoSourceTypeLabel } from "@/src/application/lib/kb2/howto-context";
import { getPrimaryOwnerName } from "@/src/application/lib/kb2/owner-resolution";
import { findBestMatchingUnit } from "@/src/application/lib/kb2/pass1-v2-artifacts";

const MAX_CONVENTIONS = 6;
const MAX_PRECEDENTS = 8;
const MAX_FEEDBACK = 4;
const MAX_SOURCE_UNITS_PER_ITEM = 6;
const MAX_UNIT_CHARS = 4000;

export interface ConventionConstraint {
  title: string;
  owner: string | null;
  pattern_rule: string;
  entity_page_summary: string;
  raw_source_units: string[];
  evidence_refs: KB2EvidenceRefType[];
  provenance: "direct" | "one_hop" | "global_fallback";
}

export interface ImplementationPrecedent {
  title: string;
  node_type: string;
  owner: string | null;
  relevant_items: string[];
  raw_source_units: string[];
  evidence_refs: KB2EvidenceRefType[];
}

export interface CustomerFeedbackItem {
  title: string;
  text: string;
  ref: KB2EvidenceRefType;
}

export interface HowtoEvidencePack {
  target_project: {
    display_name: string;
    description: string;
    status: string;
    is_proposed: boolean;
  };
  convention_constraints: ConventionConstraint[];
  implementation_precedents: ImplementationPrecedent[];
  customer_feedback: CustomerFeedbackItem[];
  gaps: string[];
  diagnostics: {
    convention_source_count: number;
    precedent_source_count: number;
    source_type_mix: Record<string, number>;
    fallback_count: number;
    total_evidence_items: number;
    fallback_ratio_pct: number;
    distinct_convention_family_count: number;
    distinct_convention_owner_count: number;
    distinct_convention_family_reference_coverage_pct: number;
    convention_provenance_counts: Record<string, number>;
  };
}

export interface ExtractedPattern {
  category: string;
  text: string;
  source_titles: string[];
}

const PATTERN_CATEGORIES: Array<{ category: string; re: RegExp }> = [
  { category: "image_loading", re: /\b(lazy.?load|skeleton|fallback|placeholder|silhouette|onError|image.?load)\b/i },
  { category: "grid_layout", re: /\b(responsive|grid|column|breakpoint|tablet|desktop|mobile|touch.?target|bottom.?nav|hamburger|768px)\b/i },
  { category: "component", re: /\b(React\.memo|useCallback|useMemo|memo(?:ize)?|Promise\.all|toast|transition|200ms|fade|shared.?component)\b/i },
  { category: "navigation", re: /\b(vertical|sidebar|horizontal|left.?panel|overflow-y|max-height|scroll|1\/3|2\/3|single.?column)\b/i },
  { category: "api_design", re: /\b(envelope|{.?data.?.?meta|cursor.?(?:based|pagination)|ISO.?8601|idempotent|409|422|\/api\/v1|page.?size)\b/i },
  { category: "file_structure", re: /\b(css.?module|camelCase|\.module\.css|controller|routes\/|migrations?\/|shared.?folder)\b/i },
  { category: "testing", re: /\b(vitest|jest|playwright|react.?testing.?library|e2e|flak|integration.?test)\b/i },
  { category: "css", re: /\b(pink|blue|green|white|neutral|accent|color|#[0-9a-f]{3,6}|44px)\b/i },
];

export function extractPrecedentPatterns(
  items: string[],
  rawUnits: string[],
  sourceTitle: string,
): ExtractedPattern[] {
  const patterns: ExtractedPattern[] = [];
  const seen = new Set<string>();
  const allText = [...items, ...rawUnits];

  for (const line of allText) {
    for (const { category, re } of PATTERN_CATEGORIES) {
      const match = re.exec(line);
      if (!match) continue;
      const snippet = line.length > 200 ? line.slice(0, 200).trim() + "..." : line;
      const key = `${category}::${snippet.slice(0, 80).toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      patterns.push({
        category,
        text: snippet,
        source_titles: [sourceTitle],
      });
    }
  }

  return patterns;
}

function resolveRawSourceUnits(
  sourceRefs: KB2EvidenceRefType[],
  parsedDocLookup: Map<string, KB2ParsedDocument>,
): string[] {
  const units: string[] = [];
  const seen = new Set<string>();

  for (const ref of sourceRefs) {
    if (units.length >= MAX_SOURCE_UNITS_PER_ITEM) break;
    const doc = parsedDocLookup.get(ref.doc_id);
    if (!doc) continue;

    const matchHint = [ref.section_heading ?? "", ref.excerpt ?? ""].filter(Boolean).join("\n");
    const unit = findBestMatchingUnit(doc, matchHint);
    const text = (unit?.text || ref.excerpt || doc.content || "").trim();
    if (!text) continue;

    const key = `${ref.doc_id}::${text.slice(0, 120)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    units.push(text.length > MAX_UNIT_CHARS ? `${text.slice(0, MAX_UNIT_CHARS - 3).trim()}...` : text);
  }

  return units;
}

function getNodeDescription(node: KB2GraphNodeType): string {
  const attrs = (node.attributes ?? {}) as Record<string, unknown>;
  return String(attrs.description ?? attrs.summary ?? attrs.scope ?? "");
}

function getNodeStatus(node: KB2GraphNodeType): string {
  const attrs = (node.attributes ?? {}) as Record<string, unknown>;
  return String(attrs.status ?? attrs.workflow_state ?? "unknown");
}

function isProposed(node: KB2GraphNodeType): boolean {
  const status = getNodeStatus(node).toLowerCase();
  return status === "proposed" || status === "planned";
}

function computeKeywordScore(targetText: string, candidateText: string): number {
  const targetTokens = normalizeNodeLookupKey(targetText).split(" ").filter((t) => t.length > 3);
  if (targetTokens.length === 0) return 0;
  const candidateTokens = normalizeNodeLookupKey(candidateText).split(" ").filter((t) => t.length > 3);
  let overlap = 0;
  for (const ct of candidateTokens) {
    for (const tt of targetTokens) {
      if (ct === tt || ct.startsWith(tt) || tt.startsWith(ct)) {
        overlap++;
        break;
      }
    }
  }
  return overlap;
}

function findEntityPage(
  nodeId: string,
  entityPages: KB2EntityPageType[],
): KB2EntityPageType | undefined {
  return entityPages.find((p) => p.node_id === nodeId);
}

function summarizeEntityPage(page: KB2EntityPageType): string {
  const lines: string[] = [];
  for (const section of page.sections) {
    for (const item of section.items) {
      lines.push(item.text);
    }
  }
  return lines.join(" ").slice(0, 1200);
}

function collectEntityPageItems(page: KB2EntityPageType): string[] {
  return page.sections.flatMap((s) => s.items.map((i) => i.text));
}

function collectEntityPageSourceRefs(page: KB2EntityPageType): KB2EvidenceRefType[] {
  return page.sections.flatMap((s) =>
    s.items.flatMap((i) =>
      (i.source_refs ?? []).map((sr) => ({
        source_type: sr.source_type as KB2EvidenceRefType["source_type"],
        doc_id: sr.doc_id,
        title: sr.title,
        excerpt: sr.excerpt ?? "",
        ...(sr.section_heading ? { section_heading: sr.section_heading } : {}),
      })),
    ),
  );
}

function buildConventionResult(
  conventionNode: KB2GraphNodeType,
  entityPages: KB2EntityPageType[],
  parsedDocLookup: Map<string, KB2ParsedDocument>,
  ownershipMap: Map<string, string[]>,
  weight: number,
  provenance: ConventionConstraint["provenance"],
): { convention: ConventionConstraint; weight: number; refCount: number } | null {
  const attrs = (conventionNode.attributes ?? {}) as Record<string, unknown>;
  const patternRule = String(attrs.pattern_rule ?? attrs.rule ?? attrs.convention ?? "");
  const page = findEntityPage(conventionNode.node_id, entityPages);

  const owner = getPrimaryOwnerName(conventionNode, ownershipMap) ??
    (typeof attrs.established_by === "string" ? attrs.established_by : null);

  const ownerPrefix = owner ? `[${owner}] ` : "";
  const title = `${ownerPrefix}${conventionNode.display_name}`;

  const entityPageSummary = page ? summarizeEntityPage(page) : "";

  const allRefs = dedupeHowtoEvidenceRefs([
    ...(conventionNode.source_refs ?? []),
    ...(page ? collectEntityPageSourceRefs(page) : []),
  ]);
  const rawSourceUnits = resolveRawSourceUnits(allRefs, parsedDocLookup);

  return {
    convention: {
      title,
      owner,
      pattern_rule: patternRule,
      entity_page_summary: entityPageSummary,
      raw_source_units: rawSourceUnits,
      evidence_refs: allRefs,
      provenance,
    } satisfies ConventionConstraint,
    weight,
    refCount: allRefs.length,
  };
}

function findConventionConstraints(args: {
  targetNode: KB2GraphNodeType;
  graphNodes: KB2GraphNodeType[];
  graphEdges: KB2GraphEdgeType[];
  entityPages: KB2EntityPageType[];
  parsedDocLookup: Map<string, KB2ParsedDocument>;
  ownershipMap: Map<string, string[]>;
}): ConventionConstraint[] {
  const { targetNode, graphNodes, graphEdges, entityPages, parsedDocLookup, ownershipMap } = args;
  const nodeById = new Map(graphNodes.map((n) => [n.node_id, n]));
  const seenConventionIds = new Set<string>();

  // Direct APPLIES_TO edges where the target is our node
  const directEdges = graphEdges.filter(
    (e) => e.type === "APPLIES_TO" && e.target_node_id === targetNode.node_id,
  );

  const scored: Array<{ convention: ConventionConstraint; weight: number; refCount: number }> = [];

  for (const edge of directEdges) {
    const conventionNode = nodeById.get(edge.source_node_id);
    if (!conventionNode) continue;
    seenConventionIds.add(conventionNode.node_id);
    const result = buildConventionResult(conventionNode, entityPages, parsedDocLookup, ownershipMap, edge.weight, "direct");
    if (result) scored.push(result);
  }

  // Multi-hop: conventions that apply to features RELATED_TO our target
  const relatedNodeIds = new Set<string>();
  for (const edge of graphEdges) {
    if (edge.type === "RELATED_TO" || edge.type === "CONTAINS") {
      if (edge.source_node_id === targetNode.node_id) relatedNodeIds.add(edge.target_node_id);
      if (edge.target_node_id === targetNode.node_id) relatedNodeIds.add(edge.source_node_id);
    }
  }

  for (const relatedId of relatedNodeIds) {
    const relatedConventionEdges = graphEdges.filter(
      (e) => e.type === "APPLIES_TO" && e.target_node_id === relatedId && !seenConventionIds.has(e.source_node_id),
    );
    for (const edge of relatedConventionEdges) {
      const conventionNode = nodeById.get(edge.source_node_id);
      if (!conventionNode) continue;
      seenConventionIds.add(conventionNode.node_id);
      const result = buildConventionResult(conventionNode, entityPages, parsedDocLookup, ownershipMap, edge.weight * 0.7, "one_hop");
      if (result) scored.push(result);
    }
  }

  // Also include all convention nodes even without APPLIES_TO edges
  const allConventionNodes = graphNodes.filter(
    (n) => (n.attributes as Record<string, unknown>)?.is_convention === true && !seenConventionIds.has(n.node_id),
  );
  for (const conventionNode of allConventionNodes) {
    const result = buildConventionResult(conventionNode, entityPages, parsedDocLookup, ownershipMap, 0.3, "global_fallback");
    if (result) scored.push(result);
  }

  scored.sort((a, b) => b.weight - a.weight || b.refCount - a.refCount);
  return scored.slice(0, MAX_CONVENTIONS).map((s) => s.convention);
}

const UI_SURFACE_CONCEPTS: Record<string, string[]> = {
  browse: ["card", "grid", "list", "filter", "search", "catalog", "gallery", "profile", "lazy", "skeleton"],
  card: ["grid", "profile", "image", "photo", "browse", "responsive", "memo", "callback"],
  donation: ["payment", "checkout", "form", "financial", "purchase", "order", "donate", "sponsor"],
  payment: ["form", "checkout", "financial", "donation", "credit", "receipt"],
  form: ["input", "field", "submit", "validation", "column", "contact", "registration"],
  select: ["choose", "picker", "selector", "sidebar", "navigation", "chooser", "vertical", "category"],
  pet: ["animal", "profile", "species", "shelter", "adoption", "browse", "card"],
  adoption: ["pet", "chooser", "selection", "browse", "profile"],
  toy: ["donation", "browse", "card", "selection", "category", "purchase"],
};

function expandTargetText(targetText: string, targetDesc: string): string {
  const combined = `${targetText} ${targetDesc}`.toLowerCase();
  const expansions: string[] = [];
  for (const [trigger, related] of Object.entries(UI_SURFACE_CONCEPTS)) {
    if (combined.includes(trigger)) {
      expansions.push(...related);
    }
  }
  return `${targetText} ${targetDesc} ${expansions.join(" ")}`;
}

function findImplementationPrecedents(args: {
  targetNode: KB2GraphNodeType;
  graphNodes: KB2GraphNodeType[];
  graphEdges: KB2GraphEdgeType[];
  entityPages: KB2EntityPageType[];
  parsedDocLookup: Map<string, KB2ParsedDocument>;
  ownershipMap: Map<string, string[]>;
}): ImplementationPrecedent[] {
  const { targetNode, graphNodes, graphEdges, entityPages, parsedDocLookup, ownershipMap } = args;
  const targetDesc = getNodeDescription(targetNode);
  const targetText = [targetNode.display_name, targetDesc].join(" ");
  const expandedTargetText = expandTargetText(targetText, targetDesc);

  const connectedNodeIds = new Set<string>();
  const edgeWeightByNode = new Map<string, number>();

  for (const edge of graphEdges) {
    let neighborId: string | null = null;
    if (edge.source_node_id === targetNode.node_id) neighborId = edge.target_node_id;
    else if (edge.target_node_id === targetNode.node_id) neighborId = edge.source_node_id;
    if (!neighborId) continue;
    connectedNodeIds.add(neighborId);
    edgeWeightByNode.set(neighborId, Math.max(edgeWeightByNode.get(neighborId) ?? 0, edge.weight));
  }

  const precedentTypes = new Set(["project", "pull_request", "decision"]);
  const nodeById = new Map(graphNodes.map((n) => [n.node_id, n]));
  const seenNodeIds = new Set<string>();

  const candidates: Array<{
    node: KB2GraphNodeType;
    page: KB2EntityPageType;
    score: number;
  }> = [];

  // Pass 1: Edge-connected nodes (high priority)
  for (const nodeId of connectedNodeIds) {
    const node = nodeById.get(nodeId);
    if (!node || !precedentTypes.has(node.type)) continue;
    if (isProposed(node)) continue;
    if (node.node_id === targetNode.node_id) continue;
    if ((node.attributes as Record<string, unknown>)?.is_convention) continue;

    const page = findEntityPage(nodeId, entityPages);
    if (!page) continue;
    seenNodeIds.add(nodeId);

    const pageText = collectPageText(page);
    const keywordScore = computeKeywordScore(expandedTargetText, pageText);
    const edgeWeight = edgeWeightByNode.get(nodeId) ?? 1;
    const typeBonus = node.type === "project" ? 3 : node.type === "pull_request" ? 2 : 1;

    candidates.push({
      node,
      page,
      score: keywordScore * 2 + edgeWeight * 3 + typeBonus,
    });
  }

  // Pass 2: All completed project/pull_request pages with surface overlap
  for (const page of entityPages) {
    if (seenNodeIds.has(page.node_id)) continue;
    if (page.node_type !== "project" && page.node_type !== "pull_request") continue;

    const node = nodeById.get(page.node_id);
    if (!node || isProposed(node)) continue;
    if (node.node_id === targetNode.node_id) continue;

    const pageText = collectPageText(page);
    const keywordScore = computeKeywordScore(expandedTargetText, pageText);
    const surfaceOverlap = hasGuideTokenOverlap(expandedTargetText, pageText, 2);

    if (keywordScore < 2 && !surfaceOverlap) continue;

    const typeBonus = node.type === "project" ? 3 : 2;

    candidates.push({
      node,
      page,
      score: keywordScore * 2 + typeBonus,
    });
  }

  candidates.sort((a, b) => b.score - a.score);

  const prNodes = graphNodes.filter((n) => n.type === "pull_request");

  return candidates.slice(0, MAX_PRECEDENTS).map(({ node, page }) => {
    const pageRefs = collectEntityPageSourceRefs(page);

    const projectTokens = normalizeNodeLookupKey(node.display_name)
      .split(" ")
      .filter((t) => t.length > 3);
    const relatedPrRefs: KB2EvidenceRefType[] = [];
    const relatedPrItems: string[] = [];

    for (const prNode of prNodes) {
      const prTitle = normalizeNodeLookupKey(prNode.display_name);
      const prTokens = prTitle.split(" ").filter((t) => t.length > 3);
      const overlap = prTokens.filter(
        (pt) => projectTokens.some((projT) => pt.startsWith(projT) || projT.startsWith(pt)),
      ).length;
      if (overlap < 2 && !prTitle.includes(normalizeNodeLookupKey(node.display_name).replace(/\s+/g, " "))) continue;
      for (const ref of prNode.source_refs ?? []) {
        relatedPrRefs.push(ref as KB2EvidenceRefType);
      }
      const attrs = (prNode.attributes ?? {}) as Record<string, unknown>;
      const desc = String(attrs.description ?? "");
      if (desc) relatedPrItems.push(`[${prNode.display_name}] ${desc.slice(0, 300)}`);
    }

    const allRefs = dedupeHowtoEvidenceRefs([...pageRefs, ...relatedPrRefs]);
    const items = [...collectEntityPageItems(page), ...relatedPrItems];

    // Also scan parsedDocLookup for documents whose title matches the project or related PRs
    const directRawUnits = resolveRawSourceUnits(allRefs, parsedDocLookup);
    const supplementalUnits: string[] = [];
    const seenUnitKeys = new Set(directRawUnits.map((u) => u.slice(0, 120)));

    for (const [, doc] of parsedDocLookup) {
      if (directRawUnits.length + supplementalUnits.length >= MAX_SOURCE_UNITS_PER_ITEM * 2) break;
      const docTitle = normalizeNodeLookupKey(doc.title ?? "");
      const docTokens = docTitle.split(" ").filter((t) => t.length > 3);
      const titleOverlap = docTokens.filter(
        (dt) => projectTokens.some((pt) => dt.startsWith(pt) || pt.startsWith(dt)),
      ).length;
      if (titleOverlap < 2) continue;

      for (const unit of doc.units ?? []) {
        if (directRawUnits.length + supplementalUnits.length >= MAX_SOURCE_UNITS_PER_ITEM * 2) break;
        const text = (unit.text ?? "").trim();
        if (!text || text.length < 50) continue;
        const key = text.slice(0, 120);
        if (seenUnitKeys.has(key)) continue;
        seenUnitKeys.add(key);
        supplementalUnits.push(
          text.length > MAX_UNIT_CHARS ? `${text.slice(0, MAX_UNIT_CHARS - 3).trim()}...` : text,
        );
      }
    }

    return {
      title: node.display_name,
      node_type: node.type,
      owner: getPrimaryOwnerName(node, ownershipMap),
      relevant_items: items,
      raw_source_units: [...directRawUnits, ...supplementalUnits],
      evidence_refs: allRefs,
    };
  });
}

function findCustomerFeedback(args: {
  targetNode: KB2GraphNodeType;
  graphNodes: KB2GraphNodeType[];
  graphEdges: KB2GraphEdgeType[];
  parsedDocLookup: Map<string, KB2ParsedDocument>;
}): CustomerFeedbackItem[] {
  const { targetNode, graphNodes, graphEdges, parsedDocLookup } = args;
  const nodeById = new Map(graphNodes.map((n) => [n.node_id, n]));
  const targetText = [targetNode.display_name, getNodeDescription(targetNode)].join(" ");
  const items: CustomerFeedbackItem[] = [];
  const seen = new Set<string>();

  // Direct edges to/from feedback nodes
  for (const edge of graphEdges) {
    let feedbackNodeId: string | null = null;
    if (edge.source_node_id === targetNode.node_id) feedbackNodeId = edge.target_node_id;
    else if (edge.target_node_id === targetNode.node_id) feedbackNodeId = edge.source_node_id;
    if (!feedbackNodeId) continue;

    const node = nodeById.get(feedbackNodeId);
    if (!node || node.type !== "customer_feedback") continue;
    if (seen.has(node.node_id)) continue;
    seen.add(node.node_id);

    const attrs = (node.attributes ?? {}) as Record<string, unknown>;
    const text = String(attrs.feedback_text ?? attrs.text ?? attrs.description ?? "");
    if (!text) continue;

    const ref: KB2EvidenceRefType = node.source_refs?.[0] ?? {
      source_type: "customer_feedback",
      doc_id: node.node_id,
      title: node.display_name,
      excerpt: text.slice(0, 400),
    };
    items.push({ title: node.display_name, text, ref });
  }

  // Also find feedback nodes that match by keyword but aren't directly connected
  if (items.length < MAX_FEEDBACK) {
    for (const node of graphNodes) {
      if (node.type !== "customer_feedback") continue;
      if (seen.has(node.node_id)) continue;
      if (items.length >= MAX_FEEDBACK) break;

      const attrs = (node.attributes ?? {}) as Record<string, unknown>;
      const text = String(attrs.feedback_text ?? attrs.text ?? attrs.description ?? "");
      if (!text) continue;
      const feedbackText = `${node.display_name} ${text}`;
      if (!hasGuideTokenOverlap(targetText, feedbackText, 1) &&
          !computeKeywordScore(targetText, feedbackText)) continue;

      seen.add(node.node_id);
      const ref: KB2EvidenceRefType = node.source_refs?.[0] ?? {
        source_type: "customer_feedback",
        doc_id: node.node_id,
        title: node.display_name,
        excerpt: text.slice(0, 400),
      };
      items.push({ title: node.display_name, text, ref });
    }
  }

  return items.slice(0, MAX_FEEDBACK);
}

function identifyGaps(
  pack: Omit<HowtoEvidencePack, "gaps" | "diagnostics">,
): string[] {
  const gaps: string[] = [];

  if (pack.target_project.is_proposed) {
    gaps.push("Exact API contracts for this proposed feature (no existing implementation evidence)");
  }
  if (pack.convention_constraints.length === 0) {
    gaps.push("No convention constraints found — compliance requirements are undefined");
  }
  if (pack.implementation_precedents.length === 0) {
    gaps.push("No implementation precedents found — concrete implementation choices must be defined as new work");
  }
  if (pack.target_project.is_proposed && pack.implementation_precedents.length === 0) {
    gaps.push("New data models and schemas (no prior implementation to reference)");
  }
  if (pack.customer_feedback.length === 0 && pack.target_project.is_proposed) {
    gaps.push("No customer feedback tied to this proposal — user requirements are assumed");
  }

  const hasDbEvidence = pack.implementation_precedents.some((p) =>
    p.relevant_items.some((item) => /\b(database|schema|migration|model)\b/i.test(item)),
  );
  if (!hasDbEvidence && pack.target_project.is_proposed) {
    gaps.push("Database schema and migration details (no precedent covers this)");
  }

  return gaps;
}

function computeDiagnostics(
  conventions: ConventionConstraint[],
  precedents: ImplementationPrecedent[],
  feedback: CustomerFeedbackItem[],
  graphEdges: KB2GraphEdgeType[],
  targetNodeId: string,
): HowtoEvidencePack["diagnostics"] {
  const conventionSourceCount = conventions.reduce((sum, c) => sum + c.evidence_refs.length, 0);
  const precedentSourceCount = precedents.reduce((sum, p) => sum + p.evidence_refs.length, 0);

  const sourceTypeMix: Record<string, number> = {};
  const allRefs = [
    ...conventions.flatMap((c) => c.evidence_refs),
    ...precedents.flatMap((p) => p.evidence_refs),
    ...feedback.map((f) => f.ref),
  ];
  for (const ref of allRefs) {
    const label = formatHowtoSourceTypeLabel(ref.source_type);
    sourceTypeMix[label] = (sourceTypeMix[label] ?? 0) + 1;
  }

  const directEdgeNodeIds = new Set<string>();
  for (const edge of graphEdges) {
    if (edge.source_node_id === targetNodeId) directEdgeNodeIds.add(edge.target_node_id);
    if (edge.target_node_id === targetNodeId) directEdgeNodeIds.add(edge.source_node_id);
  }

  const edgeBackedDocIds = new Set<string>();
  for (const c of conventions) {
    for (const ref of c.evidence_refs) {
      if (ref.doc_id) edgeBackedDocIds.add(ref.doc_id);
    }
  }
  for (const p of precedents) {
    if (!directEdgeNodeIds.has("__fallback__")) {
      for (const ref of p.evidence_refs) {
        if (ref.doc_id) edgeBackedDocIds.add(ref.doc_id);
      }
    }
  }

  let fallbackCount = 0;
  for (const ref of allRefs) {
    if (!edgeBackedDocIds.has(ref.doc_id ?? "")) fallbackCount++;
  }

  const totalEvidenceItems = allRefs.length;
  const fallbackRatioPct = totalEvidenceItems > 0
    ? Math.round((fallbackCount / totalEvidenceItems) * 100)
    : 0;

  const distinctFamilies = new Set(conventions.map((c) => c.title.replace(/^\[[^\]]+\]\s*/, "")));
  const distinctOwners = new Set(conventions.map((c) => c.owner).filter(Boolean));
  const provenanceCounts: Record<string, number> = {};
  for (const c of conventions) {
    provenanceCounts[c.provenance] = (provenanceCounts[c.provenance] ?? 0) + 1;
  }

  return {
    convention_source_count: conventionSourceCount,
    precedent_source_count: precedentSourceCount,
    source_type_mix: sourceTypeMix,
    fallback_count: fallbackCount,
    total_evidence_items: totalEvidenceItems,
    fallback_ratio_pct: fallbackRatioPct,
    distinct_convention_family_count: distinctFamilies.size,
    distinct_convention_owner_count: distinctOwners.size,
    distinct_convention_family_reference_coverage_pct: distinctFamilies.size > 0 ? 100 : 0,
    convention_provenance_counts: provenanceCounts,
  };
}

export function buildHowtoEvidencePack(args: {
  targetNode: KB2GraphNodeType;
  graphNodes: KB2GraphNodeType[];
  graphEdges: KB2GraphEdgeType[];
  entityPages: KB2EntityPageType[];
  parsedDocLookup: Map<string, KB2ParsedDocument>;
  ownershipMap: Map<string, string[]>;
}): HowtoEvidencePack {
  const { targetNode, graphNodes, graphEdges, entityPages, parsedDocLookup, ownershipMap } = args;

  const targetProject = {
    display_name: targetNode.display_name,
    description: getNodeDescription(targetNode),
    status: getNodeStatus(targetNode),
    is_proposed: isProposed(targetNode),
  };

  const conventionConstraints = findConventionConstraints(args);
  const implementationPrecedents = findImplementationPrecedents(args);
  const customerFeedback = findCustomerFeedback({
    targetNode,
    graphNodes,
    graphEdges,
    parsedDocLookup,
  });

  const partial = {
    target_project: targetProject,
    convention_constraints: conventionConstraints,
    implementation_precedents: implementationPrecedents,
    customer_feedback: customerFeedback,
  };

  const gaps = identifyGaps(partial);

  const diagnostics = computeDiagnostics(
    conventionConstraints,
    implementationPrecedents,
    customerFeedback,
    graphEdges,
    targetNode.node_id,
  );

  return { ...partial, gaps, diagnostics };
}

export function renderEvidencePackPrompt(pack: HowtoEvidencePack): string {
  const sections: string[] = [];

  sections.push([
    "## Target Project",
    "",
    `- **Name:** ${pack.target_project.display_name}`,
    `- **Description:** ${pack.target_project.description || "(none)"}`,
    `- **Status:** ${pack.target_project.status}`,
    `- **Proposed:** ${pack.target_project.is_proposed ? "yes" : "no"}`,
  ].join("\n"));

  if (pack.convention_constraints.length > 0) {
    const conventionLines = [
      "## Convention Constraints (HARD — must comply)",
      "",
      "Each convention below is a hard constraint. Cite the owner and exact values in your plan.",
      "",
    ];
    for (const c of pack.convention_constraints) {
      conventionLines.push(`### ${c.title}`);
      if (c.owner) conventionLines.push(`- **Owner:** ${c.owner}`);
      if (c.pattern_rule) conventionLines.push(`- **Rule:** ${c.pattern_rule}`);
      if (c.entity_page_summary) {
        conventionLines.push(`- **Summary:** ${c.entity_page_summary}`);
      }
      if (c.raw_source_units.length > 0) {
        conventionLines.push("");
        conventionLines.push("Source evidence:");
        for (const unit of c.raw_source_units) {
          conventionLines.push("");
          conventionLines.push(`> ${unit.replace(/\n/g, "\n> ")}`);
        }
      }
      conventionLines.push("");
    }
    sections.push(conventionLines.join("\n"));
  }

  if (pack.implementation_precedents.length > 0) {
    const precLines = [
      "## Implementation Precedents",
      "",
      "Use these completed implementations for concrete choices (tech stack, patterns, API shapes).",
      "",
    ];
    for (const p of pack.implementation_precedents) {
      precLines.push(`### ${p.title} (${p.node_type})`);
      if (p.owner) precLines.push(`- **Owner:** ${p.owner}`);

      const patterns = extractPrecedentPatterns(p.relevant_items, p.raw_source_units, p.title);
      if (patterns.length > 0) {
        precLines.push("");
        precLines.push("**Extracted Implementation Patterns:**");
        for (const pat of patterns) {
          precLines.push(`  - [${pat.category}] ${pat.text}`);
        }
      }

      if (p.relevant_items.length > 0) {
        precLines.push("- **Relevant items:**");
        for (const item of p.relevant_items.slice(0, 20)) {
          precLines.push(`  - ${item}`);
        }
      }
      if (p.raw_source_units.length > 0) {
        precLines.push("");
        precLines.push("Source evidence:");
        for (const unit of p.raw_source_units) {
          precLines.push("");
          precLines.push(`> ${unit.replace(/\n/g, "\n> ")}`);
        }
      }
      precLines.push("");
    }
    sections.push(precLines.join("\n"));
  }

  if (pack.customer_feedback.length > 0) {
    const fbLines = [
      "## Customer Feedback",
      "",
    ];
    for (const fb of pack.customer_feedback) {
      fbLines.push(`### ${fb.title}`);
      fbLines.push("");
      fbLines.push(fb.text);
      fbLines.push("");
    }
    sections.push(fbLines.join("\n"));
  }

  if (pack.gaps.length > 0) {
    const gapLines = [
      "## Identified Gaps (new work to define)",
      "",
      "The following have no evidence in the knowledge base. Mark these as 'new work to define' in the plan.",
      "",
    ];
    for (const gap of pack.gaps) {
      gapLines.push(`- ${gap}`);
    }
    sections.push(gapLines.join("\n"));
  }

  return sections.join("\n\n");
}
