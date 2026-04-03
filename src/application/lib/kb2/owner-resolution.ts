import type {
  KB2GraphEdgeType,
  KB2GraphNodeType,
} from "@/src/entities/models/kb2-types";

const UNKNOWN_OWNER_RE = /^(unknown|unassigned|none|null|n\/a|na|tbd|\(unknown\))$/i;
const SOURCE_REF_OWNER_KEYS = [
  "assignee",
  "pr_author",
  "comment_author",
  "source_author",
  "author",
  "slack_speaker",
] as const;

interface OwnerNameOptions {
  includeReporterFallback?: boolean;
  includeSourceRefFallback?: boolean;
  includeCustomerFeedbackAuthors?: boolean;
}

function uniqueOwners(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const normalizedKey = value.toLowerCase();
    if (seen.has(normalizedKey)) continue;
    seen.add(normalizedKey);
    out.push(value);
  }
  return out;
}

function splitOwnerValue(value: string): string[] {
  if (!/[;,/]|(?:\s+and\s+)/i.test(value)) return [value];
  return value
    .split(/\s*(?:,|;|\/|\band\b)\s*/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function normalizeOwnerName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/\s*\[[^\]]+\]\s*$/g, "")
    .replace(/^(owner|assignee|lead|decision maker|reporter)\s*:\s*/i, "")
    .trim();
  if (!cleaned || UNKNOWN_OWNER_RE.test(cleaned)) return null;
  return cleaned;
}

function listFromValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return uniqueOwners(value.flatMap((entry) => listFromValue(entry)));
  }
  if (typeof value !== "string") return [];
  return uniqueOwners(
    splitOwnerValue(value)
      .map((entry) => normalizeOwnerName(entry))
      .filter((entry): entry is string => Boolean(entry)),
  );
}

function getNodeAttributes(
  node: KB2GraphNodeType | Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!node) return {};
  if ("attributes" in node && node.attributes && typeof node.attributes === "object") {
    return node.attributes as Record<string, unknown>;
  }
  return node;
}

function getNodeSourceRefs(
  node: KB2GraphNodeType | Record<string, unknown> | undefined,
): Array<Record<string, unknown>> {
  if (!node) return [];
  if (
    "source_refs" in node &&
    Array.isArray(node.source_refs)
  ) {
    return node.source_refs.filter(
      (ref): ref is Record<string, unknown> => Boolean(ref && typeof ref === "object"),
    );
  }
  return [];
}

function getSourceRefOwnerNames(
  node: KB2GraphNodeType | Record<string, unknown> | undefined,
  options?: OwnerNameOptions,
): string[] {
  const owners: string[] = [];
  for (const ref of getNodeSourceRefs(node)) {
    const sourceType = typeof ref.source_type === "string" ? ref.source_type : "";
    if (sourceType === "customer_feedback" && !options?.includeCustomerFeedbackAuthors) {
      continue;
    }
    for (const key of SOURCE_REF_OWNER_KEYS) {
      owners.push(...listFromValue(ref[key]));
    }
    if (options?.includeReporterFallback) {
      owners.push(...listFromValue(ref.reporter));
    }
  }
  return uniqueOwners(owners);
}

export function getNodeAttributeOwnerNames(
  node: KB2GraphNodeType | Record<string, unknown> | undefined,
  options?: OwnerNameOptions,
): string[] {
  const attrs = getNodeAttributes(node);
  const primary = [
    ...listFromValue(attrs.owner_name),
    ...listFromValue(attrs.owner),
    ...listFromValue(attrs.assignee),
    ...listFromValue(attrs.assigned_to),
    ...listFromValue(attrs.decided_by),
    ...listFromValue(attrs.established_by),
    ...listFromValue(attrs.owner_hint),
  ];
  const secondary = options?.includeReporterFallback
    ? listFromValue(attrs.reporter)
    : [];
  const sourceRefOwners = options?.includeSourceRefFallback === false
    ? []
    : getSourceRefOwnerNames(node, options);
  return uniqueOwners([...primary, ...secondary, ...sourceRefOwners]);
}

function addOwner(map: Map<string, string[]>, nodeId: string, owner: string | null): void {
  if (!owner) return;
  const existing = map.get(nodeId) ?? [];
  if (existing.some((entry) => entry.toLowerCase() === owner.toLowerCase())) return;
  existing.push(owner);
  map.set(nodeId, existing);
}

export function buildNodeOwnerMap(
  nodes: KB2GraphNodeType[],
  edges: KB2GraphEdgeType[],
): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  const nodeById = new Map(nodes.map((node) => [node.node_id, node]));

  for (const node of nodes) {
    for (const owner of getNodeAttributeOwnerNames(node)) {
      addOwner(owners, node.node_id, owner);
    }
  }

  for (const edge of edges) {
    const source = nodeById.get(edge.source_node_id);
    const target = nodeById.get(edge.target_node_id);

    if (
      (edge.type === "OWNED_BY" || edge.type === "PROPOSED_BY" || edge.type === "BUILT_BY") &&
      target?.type === "team_member"
    ) {
      addOwner(owners, edge.source_node_id, target.display_name);
    }

    if (edge.type === "LEADS" && source?.type === "team_member" && target) {
      addOwner(owners, target.node_id, source.display_name);
    }
  }

  return owners;
}

export function getNodeOwnerNames(
  node: KB2GraphNodeType | undefined,
  ownershipMap?: Map<string, string[]>,
  options?: OwnerNameOptions,
): string[] {
  if (!node) return [];
  return uniqueOwners([
    ...(ownershipMap?.get(node.node_id) ?? []),
    ...getNodeAttributeOwnerNames(node, options),
  ]);
}

export function getPrimaryOwnerName(
  node: KB2GraphNodeType | undefined,
  ownershipMap?: Map<string, string[]>,
  options?: OwnerNameOptions,
): string | null {
  return getNodeOwnerNames(node, ownershipMap, options)[0] ?? null;
}
