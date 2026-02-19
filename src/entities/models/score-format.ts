import { z } from "zod";

// ---------------------------------------------------------------------------
// KB Categories (9 fixed categories)
// ---------------------------------------------------------------------------

export const KBCategoryEnum = z.enum([
  "company_overview",
  "setup_onboarding",
  "people",
  "clients",
  "past_documented",
  "past_undocumented",
  "ongoing_projects",
  "new_projects",
  "processes",
]);
export type KBCategory = z.infer<typeof KBCategoryEnum>;

export const KB_CATEGORY_LABELS: Record<KBCategory, string> = {
  company_overview: "Company Overview",
  setup_onboarding: "Setup & Onboarding",
  people: "People",
  clients: "Clients",
  past_documented: "Past Documented Projects",
  past_undocumented: "Past Undocumented Projects",
  ongoing_projects: "Ongoing Projects",
  new_projects: "New Projects",
  processes: "Processes",
};

// ---------------------------------------------------------------------------
// Atomic Item — the universal scoring unit
// ---------------------------------------------------------------------------

export const ItemTypeEnum = z.enum([
  "fact",
  "step",
  "decision",
  "owner",
  "dependency",
  "risk",
  "question",
  "ticket",
  "conflict",
  "gap",
  "outdated",
]);
export type ItemType = z.infer<typeof ItemTypeEnum>;

export const VerificationStatusEnum = z.enum([
  "verified_human",
  "verified_authoritative",
  "supported_multi_source",
  "weak_support",
  "needs_verification",
]);
export type VerificationStatus = z.infer<typeof VerificationStatusEnum>;

export const ActionRoutingEnum = z.enum([
  "none",
  "verify_task",
  "update_kb",
  "create_jira_ticket",
]);
export type ActionRouting = z.infer<typeof ActionRoutingEnum>;

export const SeverityEnum = z.enum(["S1", "S2", "S3", "S4"]);
export type Severity = z.infer<typeof SeverityEnum>;

export const ConfidenceBucketEnum = z.enum(["high", "medium", "low"]);
export type ConfidenceBucket = z.infer<typeof ConfidenceBucketEnum>;

export const SourceRef = z.object({
  source_type: z.enum(["confluence", "slack", "jira", "github", "customer_feedback"]),
  doc_id: z.string(),
  title: z.string(),
  excerpt: z.string(),
  timestamp: z.string().optional(),
});
export type SourceRefType = z.infer<typeof SourceRef>;

export const AtomicItem = z.object({
  item_id: z.string(),
  item_text: z.string(),
  item_type: ItemTypeEnum,
  source_refs: z.array(SourceRef).default([]),
  verification: z.object({
    status: VerificationStatusEnum,
    verifier: z.string().nullable().default(null),
  }),
  action_routing: z.object({
    action: ActionRoutingEnum,
    reason: z.string(),
    severity: SeverityEnum,
  }),
  confidence_bucket: ConfidenceBucketEnum,
});
export type AtomicItemType = z.infer<typeof AtomicItem>;

// ---------------------------------------------------------------------------
// Page Section & Score-Format Page
// ---------------------------------------------------------------------------

export const PageSection = z.object({
  section_name: z.string(),
  bullets: z.array(AtomicItem).default([]),
});
export type PageSectionType = z.infer<typeof PageSection>;

export const ScoreFormatPage = z.object({
  page_id: z.string(),
  category: KBCategoryEnum,
  title: z.string(),
  sections: z.array(PageSection).default([]),
});
export type ScoreFormatPageType = z.infer<typeof ScoreFormatPage>;

// ---------------------------------------------------------------------------
// PM Ticket Format
// ---------------------------------------------------------------------------

export const TicketTypeEnum = z.enum(["bug", "feature", "task", "improvement"]);
export type TicketType = z.infer<typeof TicketTypeEnum>;

export const TicketPriorityEnum = z.enum(["P0", "P1", "P2", "P3"]);
export type TicketPriority = z.infer<typeof TicketPriorityEnum>;

export const TicketComplexityEnum = z.enum(["trivial", "small", "medium", "large", "xlarge"]);
export type TicketComplexity = z.infer<typeof TicketComplexityEnum>;

export const PMTicket = z.object({
  ticket_id: z.string(),
  type: TicketTypeEnum,
  title: z.string(),
  priority: TicketPriorityEnum,
  priority_rationale: z.string(),
  description: z.string(),
  acceptance_criteria: z.array(z.string()).default([]),
  assigned_to: z.string(),
  assignment_rationale: z.string(),
  affected_systems: z.array(z.string()).default([]),
  customer_evidence: z.array(z.object({
    feedback_id: z.string(),
    customer_name: z.string(),
    excerpt: z.string(),
    sentiment: z.enum(["positive", "negative", "neutral"]),
  })).default([]),
  technical_constraints: z.array(z.object({
    constraint: z.string(),
    source: z.string(),
    impact: z.string(),
  })).default([]),
  complexity: TicketComplexityEnum,
  related_tickets: z.array(z.string()).default([]),
  source_refs: z.array(SourceRef).default([]),
});
export type PMTicketType = z.infer<typeof PMTicket>;

// ---------------------------------------------------------------------------
// Full Score-Format Output (used for both Generated and Ground Truth)
// ---------------------------------------------------------------------------

export const ScoreFormatOutput = z.object({
  kb_pages: z.array(ScoreFormatPage).default([]),
  conversation_tickets: z.array(PMTicket).default([]),
  feedback_tickets: z.array(PMTicket).default([]),
  howto_pages: z.array(ScoreFormatPage).default([]),
});
export type ScoreFormatOutputType = z.infer<typeof ScoreFormatOutput>;

// ---------------------------------------------------------------------------
// KB Page Templates — required sections per category
// ---------------------------------------------------------------------------

export const KB_PAGE_TEMPLATES: Record<KBCategory, string[]> = {
  company_overview: [
    "What We Do",
    "Products",
    "Tech Stack",
    "Architecture",
    "Environments",
    "External Integrations",
    "Key Metrics & SLAs",
  ],
  setup_onboarding: [
    "Prerequisites",
    "Environment Setup",
    "Key Repositories",
    "Configuration",
    "First Tasks",
    "Common Gotchas",
    "Who To Ask",
  ],
  people: [
    "Team Directory",
  ],
  clients: [
    "Overview",
    "Products Used",
    "Key Contacts",
    "Feedback Themes",
    "Special Arrangements",
  ],
  past_documented: [
    "Summary",
    "Motivation",
    "People",
    "What Was Done",
    "Key Decisions",
    "Tradeoffs",
    "Systems Affected",
    "Outcome",
    "Known Limitations",
    "Related Tickets",
  ],
  past_undocumented: [
    "Summary",
    "Motivation",
    "People",
    "What Was Done",
    "Key Decisions",
    "Tradeoffs",
    "Systems Affected",
    "Outcome",
    "Known Limitations",
    "Related Tickets",
    "Discovery Evidence",
    "Confidence",
    "Needs Verification",
  ],
  ongoing_projects: [
    "Summary",
    "Motivation",
    "People",
    "What's Been Done",
    "What's Remaining",
    "Key Decisions",
    "Blockers",
    "Timeline",
    "Next Steps",
    "Systems Affected",
  ],
  new_projects: [
    "Summary",
    "Motivation",
    "Proposed Scope",
    "People",
    "Estimated Effort",
    "Systems Affected",
    "Dependencies",
    "Risks",
    "Customer Evidence",
    "Implementation Instructions",
    "Context & Decision Guide",
    "AI Coding Prompt",
  ],
  processes: [
    "Purpose",
    "Owner",
    "Trigger & Frequency",
    "Steps",
    "Dependencies",
    "Known Issues & Workarounds",
    "Related Runbooks",
  ],
};
