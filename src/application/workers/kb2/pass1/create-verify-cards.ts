import { randomUUID } from "crypto";
import {
  kb2ClaimsCollection,
  kb2GraphNodesCollection,
  kb2EntityPagesCollection,
  kb2VerificationCardsCollection,
} from "@/lib/mongodb";
import type {
  KB2ClaimType,
  KB2GraphNodeType,
  KB2EntityPageType,
  KB2VerificationCardType,
  KB2VerifyCardType,
  KB2Severity,
} from "@/src/entities/models/kb2-types";
import { ENTITY_PAGE_TEMPLATES } from "@/src/entities/models/kb2-templates";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";

export const createVerifyCardsStep: StepFunction = async (ctx) => {
  const claims = (await kb2ClaimsCollection.find({ run_id: ctx.runId }).toArray()) as unknown as KB2ClaimType[];
  const nodes = (await kb2GraphNodesCollection.find({ run_id: ctx.runId }).toArray()) as unknown as KB2GraphNodeType[];
  const entityPages = (await kb2EntityPagesCollection.find({ run_id: ctx.runId }).toArray()) as unknown as KB2EntityPageType[];

  const cards: KB2VerificationCardType[] = [];

  ctx.onProgress("Scanning for inferred/low-confidence claims...", 10);

  const inferredClaims = claims.filter((c) => c.truth_status === "inferred");
  for (const claim of inferredClaims) {
    cards.push(makeCard({
      runId: ctx.runId,
      cardType: "inferred_claim",
      severity: "S3",
      title: `Inferred claim needs verification`,
      explanation: `This claim was inferred rather than directly stated: "${claim.text.slice(0, 200)}"`,
      claimIds: [claim.claim_id],
      pageId: claim.source_page_id,
      pageType: claim.source_page_type,
    }));
  }

  const lowConfClaims = claims.filter((c) => c.confidence === "low" && c.truth_status !== "inferred");
  for (const claim of lowConfClaims) {
    cards.push(makeCard({
      runId: ctx.runId,
      cardType: "low_confidence",
      severity: "S3",
      title: `Low-confidence claim needs review`,
      explanation: `This claim has low confidence: "${claim.text.slice(0, 200)}"`,
      claimIds: [claim.claim_id],
      pageId: claim.source_page_id,
      pageType: claim.source_page_type,
    }));
  }

  ctx.onProgress("Scanning for missing MUST fields...", 40);

  for (const page of entityPages) {
    const template = ENTITY_PAGE_TEMPLATES[page.node_type];
    if (!template) continue;

    for (const spec of template.sections) {
      if (spec.requirement !== "MUST") continue;

      const section = page.sections.find((s) => s.section_name === spec.name);
      const hasContent = section && section.items.length > 0;

      if (!hasContent) {
        cards.push(makeCard({
          runId: ctx.runId,
          cardType: "missing_must",
          severity: "S2",
          title: `Missing required section "${spec.name}" on ${page.title}`,
          explanation: `The "${spec.name}" section is required for ${page.node_type} entities but is empty or missing. Intent: ${spec.intent}`,
          pageId: page.page_id,
          pageType: "entity",
        }));
      }
    }
  }

  ctx.onProgress("Scanning for unknown ownership...", 70);

  const ownershipEdgeTypes = new Set(["OWNED_BY", "LEADS", "MEMBER_OF"]);
  const nodesWithOwner = new Set<string>();

  for (const page of entityPages) {
    for (const section of page.sections) {
      if (section.section_name.toLowerCase().includes("identity") ||
          section.section_name.toLowerCase().includes("ownership")) {
        for (const item of section.items) {
          if (item.text.toLowerCase().includes("owner") || item.text.toLowerCase().includes("lead")) {
            nodesWithOwner.add(page.node_id);
          }
        }
      }
    }
  }

  const ownerableTypes = new Set(["service", "system", "database", "project", "process"]);
  for (const node of nodes) {
    if (!ownerableTypes.has(node.type)) continue;
    if (nodesWithOwner.has(node.node_id)) continue;

    cards.push(makeCard({
      runId: ctx.runId,
      cardType: "unknown_owner",
      severity: "S2",
      title: `No owner identified for ${node.display_name}`,
      explanation: `The ${node.type} "${node.display_name}" has no identified owner or responsible person/team. This is important for incident response and maintenance.`,
    }));
  }

  if (cards.length > 0) {
    await kb2VerificationCardsCollection.deleteMany({ run_id: ctx.runId });
    await kb2VerificationCardsCollection.insertMany(cards);
  }

  const byType = cards.reduce((acc, c) => {
    acc[c.card_type] = (acc[c.card_type] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  ctx.onProgress(`Created ${cards.length} verification cards`, 100);
  return {
    total_cards: cards.length,
    by_type: byType,
    by_severity: cards.reduce((acc, c) => {
      acc[c.severity] = (acc[c.severity] || 0) + 1;
      return acc;
    }, {} as Record<string, number>),
  };
};

function makeCard(opts: {
  runId: string;
  cardType: KB2VerifyCardType;
  severity: KB2Severity;
  title: string;
  explanation: string;
  claimIds?: string[];
  pageId?: string;
  pageType?: "entity" | "human";
}): KB2VerificationCardType {
  return {
    card_id: randomUUID(),
    run_id: opts.runId,
    card_type: opts.cardType,
    severity: opts.severity,
    title: opts.title,
    explanation: opts.explanation,
    page_occurrences: opts.pageId
      ? [{ page_id: opts.pageId, page_type: opts.pageType ?? "entity" }]
      : [],
    assigned_to: [],
    claim_ids: opts.claimIds ?? [],
    status: "open",
    discussion: [],
  };
}
