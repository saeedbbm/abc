import { z } from "zod";

export const KB2NodeTypeEnum = z.enum([
  "person",
  "team",
  "client",
  "repository",
  "integration",
  "infrastructure",
  "cloud_resource",
  "library",
  "database",
  "environment",
  "project",
  "ticket",
  "pull_request",
  "pipeline",
  "customer_feedback",
]);
export type KB2NodeType = z.infer<typeof KB2NodeTypeEnum>;

export const KB2EdgeTypeEnum = z.enum([
  "OWNED_BY",
  "DEPENDS_ON",
  "MENTIONED_IN",
  "RELATED_TO",
  "MEMBER_OF",
  "WORKS_ON",
  "LEADS",
  "USES",
  "STORES_IN",
  "DEPLOYED_TO",
  "BLOCKED_BY",
  "COMMUNICATES_VIA",
  "FEEDBACK_FROM",
  "CONTAINS",
  "RUNS_ON",
  "BUILT_BY",
  "RESOLVES",
]);
export type KB2EdgeType = z.infer<typeof KB2EdgeTypeEnum>;

export const KB2TruthStatusEnum = z.enum(["direct", "inferred", "human_asserted"]);
export type KB2TruthStatus = z.infer<typeof KB2TruthStatusEnum>;

export const KB2ConfidenceEnum = z.enum(["high", "medium", "low"]);
export type KB2Confidence = z.infer<typeof KB2ConfidenceEnum>;

export const KB2SeverityEnum = z.enum(["S1", "S2", "S3", "S4"]);
export type KB2Severity = z.infer<typeof KB2SeverityEnum>;

export const KB2VerifyCardTypeEnum = z.enum([
  "inferred_claim",
  "low_confidence",
  "missing_must",
  "unknown_owner",
  "duplicate_cluster",
  "conflict",
  "edit_proposal",
]);
export type KB2VerifyCardType = z.infer<typeof KB2VerifyCardTypeEnum>;

export const KB2VerifyCardStatusEnum = z.enum([
  "open",
  "validated",
  "edited",
  "rejected",
]);
export type KB2VerifyCardStatus = z.infer<typeof KB2VerifyCardStatusEnum>;

export const KB2TicketSourceEnum = z.enum(["jira", "conversation", "feedback", "manual"]);
export type KB2TicketSource = z.infer<typeof KB2TicketSourceEnum>;

export const KB2WorkflowStateEnum = z.enum([
  "backlog",
  "todo",
  "in_progress",
  "review",
  "done",
]);
export type KB2WorkflowState = z.infer<typeof KB2WorkflowStateEnum>;

export const KB2HumanPageLayerEnum = z.enum([
  "company",
  "engineering",
  "marketing",
  "legal",
]);
export type KB2HumanPageLayer = z.infer<typeof KB2HumanPageLayerEnum>;

export const KB2EvidenceRef = z.object({
  source_type: z.enum(["confluence", "slack", "jira", "github", "customer_feedback", "human_verification"]),
  doc_id: z.string(),
  title: z.string(),
  excerpt: z.string(),
  section_heading: z.string().optional(),
});
export type KB2EvidenceRefType = z.infer<typeof KB2EvidenceRef>;

export const KB2GraphNode = z.object({
  node_id: z.string(),
  run_id: z.string(),
  type: KB2NodeTypeEnum,
  display_name: z.string(),
  aliases: z.array(z.string()).default([]),
  attributes: z.record(z.string(), z.any()).default({}),
  source_refs: z.array(KB2EvidenceRef).default([]),
  truth_status: KB2TruthStatusEnum.default("direct"),
  confidence: KB2ConfidenceEnum.default("medium"),
});
export type KB2GraphNodeType = z.infer<typeof KB2GraphNode>;

export const KB2GraphEdge = z.object({
  edge_id: z.string(),
  run_id: z.string(),
  source_node_id: z.string(),
  target_node_id: z.string(),
  type: KB2EdgeTypeEnum,
  weight: z.number().default(1),
  evidence: z.string().optional(),
});
export type KB2GraphEdgeType = z.infer<typeof KB2GraphEdge>;

export const KB2Claim = z.object({
  claim_id: z.string(),
  run_id: z.string(),
  text: z.string(),
  entity_ids: z.array(z.string()).default([]),
  source_page_id: z.string().optional(),
  source_page_type: z.enum(["entity", "human"]).optional(),
  source_section_index: z.number().optional(),
  source_item_index: z.number().optional(),
  fact_group_id: z.string().optional(),
  truth_status: KB2TruthStatusEnum.default("direct"),
  confidence: KB2ConfidenceEnum.default("medium"),
  source_refs: z.array(KB2EvidenceRef).default([]),
});
export type KB2ClaimType = z.infer<typeof KB2Claim>;

export const KB2FactGroup = z.object({
  group_id: z.string(),
  run_id: z.string(),
  canonical_claim_id: z.string(),
  member_claim_ids: z.array(z.string()),
  group_type: z.enum(["duplicate", "related", "conflict"]).default("duplicate"),
});
export type KB2FactGroupType = z.infer<typeof KB2FactGroup>;

export const KB2VerificationCard = z.object({
  card_id: z.string(),
  run_id: z.string(),
  card_type: KB2VerifyCardTypeEnum,
  severity: KB2SeverityEnum,
  title: z.string(),
  explanation: z.string(),
  canonical_text: z.string().optional(),
  proposed_text: z.string().optional(),
  recommended_action: z.string().optional(),
  page_occurrences: z.array(z.object({
    page_id: z.string(),
    page_type: z.enum(["entity", "human"]),
    page_title: z.string().optional(),
    section: z.string().optional(),
  })).default([]),
  source_refs: z.array(KB2EvidenceRef).default([]),
  assigned_to: z.array(z.string()).default([]),
  claim_ids: z.array(z.string()).default([]),
  status: KB2VerifyCardStatusEnum.default("open"),
  discussion: z.array(z.object({
    author: z.string(),
    text: z.string(),
    timestamp: z.string(),
  })).default([]),
});
export type KB2VerificationCardType = z.infer<typeof KB2VerificationCard>;

export const KB2EntityPage = z.object({
  page_id: z.string(),
  run_id: z.string(),
  node_id: z.string(),
  node_type: KB2NodeTypeEnum,
  title: z.string(),
  sections: z.array(z.object({
    section_name: z.string(),
    requirement: z.enum(["MUST", "MUST_IF_PRESENT", "OPTIONAL"]),
    items: z.array(z.object({
      text: z.string(),
      claim_id: z.string().optional(),
      confidence: KB2ConfidenceEnum.default("medium"),
      source_refs: z.array(z.object({
        source_type: z.string(),
        doc_id: z.string(),
        title: z.string(),
        section_heading: z.string().optional(),
        excerpt: z.string().optional(),
      })).default([]),
    })),
  })),
  linked_human_page_ids: z.array(z.string()).default([]),
  manual_overrides: z.record(z.string(), z.object({
    edited_by: z.string(),
    edited_at: z.string(),
    original_text: z.string(),
  })).default({}),
});
export type KB2EntityPageType = z.infer<typeof KB2EntityPage>;

export const KB2HumanPage = z.object({
  page_id: z.string(),
  run_id: z.string(),
  title: z.string(),
  layer: KB2HumanPageLayerEnum,
  category: z.string(),
  paragraphs: z.array(z.object({
    heading: z.string(),
    body: z.string(),
    entity_refs: z.array(z.string()).default([]),
    source_items: z.array(z.object({
      entity_page_id: z.string(),
      section_name: z.string(),
      item_index: z.number(),
    })).default([]),
  })),
  linked_entity_page_ids: z.array(z.string()).default([]),
});
export type KB2HumanPageType = z.infer<typeof KB2HumanPage>;

export const KB2Run = z.object({
  run_id: z.string(),
  company_slug: z.string(),
  status: z.enum(["running", "completed", "failed"]),
  started_at: z.string(),
  completed_at: z.string().optional(),
  current_pass: z.enum(["pass1", "pass2"]).optional(),
  current_step: z.number().optional(),
  total_steps: z.number().optional(),
  stats: z.record(z.string(), z.number()).default({}),
  error: z.string().optional(),
});
export type KB2RunType = z.infer<typeof KB2Run>;

export const KB2RunStep = z.object({
  step_id: z.string(),
  run_id: z.string(),
  pass: z.enum(["pass1", "pass2"]),
  step_number: z.number(),
  name: z.string(),
  status: z.enum(["pending", "running", "completed", "failed"]),
  started_at: z.string().optional(),
  completed_at: z.string().optional(),
  duration_ms: z.number().optional(),
  summary: z.string().optional(),
  artifact: z.any().optional(),
  metrics: z.object({
    llm_calls: z.number().default(0),
    input_tokens: z.number().default(0),
    output_tokens: z.number().default(0),
    cost_usd: z.number().default(0),
  }).optional(),
});
export type KB2RunStepType = z.infer<typeof KB2RunStep>;

export const KB2LLMCall = z.object({
  call_id: z.string(),
  run_id: z.string(),
  step_id: z.string(),
  model: z.string(),
  prompt: z.string(),
  response: z.string(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  cost_usd: z.number(),
  duration_ms: z.number(),
  timestamp: z.string(),
});
export type KB2LLMCallType = z.infer<typeof KB2LLMCall>;

export const KB2TicketComment = z.object({
  id: z.string(),
  author: z.string(),
  text: z.string(),
  source: z.enum(["manual", "ai_summary"]).default("manual"),
  timestamp: z.string(),
});

export const KB2Ticket = z.object({
  ticket_id: z.string(),
  run_id: z.string().optional(),
  source: KB2TicketSourceEnum,
  title: z.string(),
  description: z.string(),
  assignees: z.array(z.string()).default([]),
  status: z.string().default("open"),
  priority: z.enum(["P0", "P1", "P2", "P3"]).default("P2"),
  workflow_state: KB2WorkflowStateEnum.default("backlog"),
  linked_entity_ids: z.array(z.string()).default([]),
  linked_entity_names: z.array(z.string()).default([]),
  parent_ticket_id: z.string().optional(),
  subtask_ids: z.array(z.string()).default([]),
  labels: z.array(z.string()).default([]),
  comments: z.array(KB2TicketComment).default([]),
  created_at: z.string(),
});
export type KB2TicketType = z.infer<typeof KB2Ticket>;

export const KB2ImpactCard = z.object({
  id: z.string(),
  summary: z.string(),
  reason: z.string(),
  recommended_action: z.string(),
  target_type: z.enum(["entity_page", "human_page", "ticket", "entity", "claim"]),
  target_id: z.string(),
  severity: KB2SeverityEnum,
  accepted: z.boolean().optional(),
});
export type KB2ImpactCardType = z.infer<typeof KB2ImpactCard>;

export const KB2Howto = z.object({
  howto_id: z.string(),
  run_id: z.string().optional(),
  ticket_id: z.string(),
  title: z.string(),
  sections: z.array(z.object({
    section_name: z.string(),
    content: z.string(),
  })),
  linked_entity_ids: z.array(z.string()).default([]),
  created_at: z.string(),
});
export type KB2HowtoType = z.infer<typeof KB2Howto>;
