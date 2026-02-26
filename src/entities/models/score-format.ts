import { z } from "zod";

// ---------------------------------------------------------------------------
// KB Categories
// ---------------------------------------------------------------------------

export const KBCategoryEnum = z.enum([
  // Layer A — Canonical Knowledge (stable reference)
  "company_overview",
  "glossary",
  "org_map",
  "person",
  "client",
  "system_architecture",
  "service",
  "integration",
  "setup_onboarding",
  "environments_cicd",
  "observability",
  "process",
  "decision_record",
  // Layer B — Work & Change (temporal)
  "past_documented",
  "past_undocumented",
  "ongoing_documented",
  "ongoing_undocumented",
  "proposed_project",
  "howto_implementation",
  "ticket",
  // Backward-compat aliases (old pipeline stored these values in DB)
  "people",
  "clients",
  "processes",
  "new_projects",
]);
export type KBCategory = z.infer<typeof KBCategoryEnum>;

export const LAYER_A_CATEGORIES: KBCategory[] = [
  "company_overview", "glossary", "org_map", "person", "client",
  "system_architecture", "service", "integration",
  "setup_onboarding", "environments_cicd", "observability",
  "process", "decision_record",
];

export const LAYER_B_CATEGORIES: KBCategory[] = [
  "past_documented", "past_undocumented",
  "ongoing_documented", "ongoing_undocumented",
  "proposed_project", "howto_implementation", "ticket",
];

export const SINGLETON_CATEGORIES: KBCategory[] = [
  "company_overview", "glossary", "org_map",
  "system_architecture", "setup_onboarding",
  "environments_cicd", "observability",
];

// Backward compat aliases used by existing GT/test pipelines
export const KB_BASIC_CATEGORIES: KBCategory[] = [
  "company_overview", "setup_onboarding", "person", "client",
];

export const KB_PROJECT_CATEGORIES: KBCategory[] = [
  "past_documented", "past_undocumented", "ongoing_documented", "ongoing_undocumented",
];

export const KB_CATEGORY_LABELS: Record<KBCategory, string> = {
  company_overview: "Company Overview",
  glossary: "Glossary",
  org_map: "Org Map",
  person: "People",
  client: "Clients",
  system_architecture: "System Architecture",
  service: "Services",
  integration: "Integrations",
  setup_onboarding: "Setup & Onboarding",
  environments_cicd: "Environments & CI/CD",
  observability: "Observability",
  process: "Processes",
  decision_record: "Decision Log",
  past_documented: "Past Documented Projects",
  past_undocumented: "Past Undocumented Projects",
  ongoing_documented: "Ongoing Documented Projects",
  ongoing_undocumented: "Ongoing Undocumented Projects",
  proposed_project: "Proposed Projects",
  howto_implementation: "How-to Implementation",
  ticket: "Tickets",
  // Backward-compat aliases
  people: "People",
  clients: "Clients",
  processes: "Processes",
  new_projects: "New Projects",
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
  location: z.string().optional(),
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
  group_id: z.string().optional(),
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
  linked_ticket_id: z.string().optional(),
  source_doc_ids: z.array(z.string()).default([]),
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

export const JiraMatch = z.object({
  exists: z.boolean(),
  matching_jira_key: z.string().nullable().default(null),
  reason: z.string(),
});
export type JiraMatchType = z.infer<typeof JiraMatch>;

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
  source_group: z.enum(["conversation", "customer_feedback"]).optional(),
  jira_match: JiraMatch.optional(),
});
export type PMTicketType = z.infer<typeof PMTicket>;

// ---------------------------------------------------------------------------
// Ticket Audit Item (for auditing existing Jira tickets)
// ---------------------------------------------------------------------------

export const TicketAuditItem = z.object({
  ticket_key: z.string(),
  title: z.string(),
  current_status: z.string(),
  issues: z.array(z.object({
    field: z.string(),
    current_value: z.string(),
    suggested_value: z.string(),
    evidence: z.string(),
    source_ref: SourceRef,
    severity: SeverityEnum,
  })).default([]),
  overall_assessment: z.enum(["ok", "needs_update", "stale", "duplicate"]),
});
export type TicketAuditItemType = z.infer<typeof TicketAuditItem>;

// ---------------------------------------------------------------------------
// Full Score-Format Output (used for both Generated and Ground Truth)
// ---------------------------------------------------------------------------

export const ScoreFormatOutput = z.object({
  kb_pages: z.array(ScoreFormatPage).default([]),
  conversation_tickets: z.array(PMTicket).default([]),
  customer_tickets: z.array(PMTicket).default([]),
  howto_pages: z.array(ScoreFormatPage).default([]),
  ticket_audit: z.array(TicketAuditItem).default([]),
});
export type ScoreFormatOutputType = z.infer<typeof ScoreFormatOutput>;

// ---------------------------------------------------------------------------
// Template Registry — single source of truth for page structure
// ---------------------------------------------------------------------------

export type SectionSpec = {
  name: string;
  intent: string;
  minBullets: number;
  maxBullets: number;
};

export type PageTemplate = {
  appliesTo: "kb_page" | "howto_page";
  includeRules: string;
  excludeRules: string;
  sections: SectionSpec[];
};

export const TEMPLATE_REGISTRY: Record<string, PageTemplate> = {

  // ── Layer A: Canonical Knowledge ──────────────────────────────────────

  company_overview: {
    appliesTo: "kb_page",
    includeRules: "Only stable, rarely-changing company-level facts.",
    excludeRules: "Tech stack (-> system_architecture), individual clients (-> client pages), individual people (-> person pages), environments (-> environments_cicd), processes (-> process pages).",
    sections: [
      { name: "What We Do", intent: "Mission, core business, what problem we solve", minBullets: 0, maxBullets: 5 },
      { name: "Products and Services", intent: "Name + 1-line description of each product", minBullets: 0, maxBullets: 10 },
      { name: "Revenue Model", intent: "How the company makes money, pricing tiers, business model", minBullets: 0, maxBullets: 4 },
      { name: "Customer Base", intent: "Customer segments (not individual clients)", minBullets: 0, maxBullets: 4 },
      { name: "Company History", intent: "Founded when, key milestones, funding", minBullets: 0, maxBullets: 5 },
    ],
  },

  glossary: {
    appliesTo: "kb_page",
    includeRules: "Only term definitions. Format each item as 'TERM — definition' (max 2 sentences). Include terms a new employee would not understand.",
    excludeRules: "Full process descriptions (-> process pages). System details (-> service pages). Definitions longer than 2 sentences.",
    sections: [
      { name: "Product Terms", intent: "Domain-specific terminology", minBullets: 0, maxBullets: 20 },
      { name: "Technical Terms", intent: "Internal names for systems, services, tools", minBullets: 0, maxBullets: 20 },
      { name: "Acronyms", intent: "Abbreviations used in docs and conversation", minBullets: 0, maxBullets: 15 },
      { name: "Process Terms", intent: "Names for internal workflows or ceremonies", minBullets: 0, maxBullets: 10 },
    ],
  },

  org_map: {
    appliesTo: "kb_page",
    includeRules: "Team-level structure only.",
    excludeRules: "Individual person details (-> person pages). Project assignments (-> project pages). Process details (-> process pages).",
    sections: [
      { name: "Teams", intent: "Team names, mandates, and who leads each", minBullets: 0, maxBullets: 10 },
      { name: "Reporting Structure", intent: "Who reports to whom, org hierarchy", minBullets: 0, maxBullets: 8 },
      { name: "On-Call and Escalation", intent: "Who is on-call for what, escalation chain", minBullets: 0, maxBullets: 6 },
      { name: "Cross-Team Dependencies", intent: "Which teams depend on each other for what", minBullets: 0, maxBullets: 6 },
    ],
  },

  person: {
    appliesTo: "kb_page",
    includeRules: "Stable attributes: what they own, what they know, what they built. Help others know who to ask.",
    excludeRules: "What they are currently working on day-to-day (-> project pages). Personal info. Daily standup status.",
    sections: [
      { name: "Role and Responsibilities", intent: "Job title, primary responsibilities, scope of work", minBullets: 0, maxBullets: 5 },
      { name: "Systems Ownership", intent: "Systems and services this person owns or maintains", minBullets: 0, maxBullets: 6 },
      { name: "Domain Expertise", intent: "Topics and areas they are the go-to person for", minBullets: 0, maxBullets: 6 },
      { name: "Past Project Ownership", intent: "Projects they led or significantly contributed to", minBullets: 0, maxBullets: 8 },
      { name: "Ask Them About", intent: "Quick reference: go to this person for X", minBullets: 0, maxBullets: 6 },
    ],
  },

  client: {
    appliesTo: "kb_page",
    includeRules: "Client-specific relationship and configuration info.",
    excludeRules: "General product features (-> company_overview). Individual feedback items (-> tickets). Technical system details (-> service pages).",
    sections: [
      { name: "Overview", intent: "Client background, relationship start, account tier", minBullets: 0, maxBullets: 5 },
      { name: "Products Used", intent: "Which of our products and services they use", minBullets: 0, maxBullets: 6 },
      { name: "Key Contacts", intent: "Client-side contacts and internal account owners", minBullets: 0, maxBullets: 6 },
      { name: "Feedback Themes", intent: "Recurring feedback patterns (positive and negative)", minBullets: 0, maxBullets: 8 },
      { name: "Special Arrangements", intent: "Custom configs, SLAs, pricing, special agreements", minBullets: 0, maxBullets: 5 },
      { name: "Open Issues", intent: "Known unresolved issues specific to this client", minBullets: 0, maxBullets: 5 },
    ],
  },

  system_architecture: {
    appliesTo: "kb_page",
    includeRules: "The big picture: what exists and how it connects. Service names, not implementation details.",
    excludeRules: "Per-service API details (-> service pages). Per-integration details (-> integration pages). Setup instructions (-> setup_onboarding). Deployment details (-> environments_cicd).",
    sections: [
      { name: "Architecture Overview", intent: "High-level description of how the system is structured", minBullets: 0, maxBullets: 5 },
      { name: "Service Inventory", intent: "List of all services and apps with one-line descriptions", minBullets: 0, maxBullets: 15 },
      { name: "Data Flow", intent: "How data moves between services (request flow, event flow)", minBullets: 0, maxBullets: 6 },
      { name: "Data Stores", intent: "Databases, caches, queues with what they store", minBullets: 0, maxBullets: 8 },
      { name: "External Dependencies", intent: "Third-party services the system depends on", minBullets: 0, maxBullets: 8 },
      { name: "Security Model", intent: "Auth approach, secrets management, access control", minBullets: 0, maxBullets: 6 },
      { name: "Tech Stack", intent: "Languages, frameworks, key libraries", minBullets: 0, maxBullets: 10 },
    ],
  },

  service: {
    appliesTo: "kb_page",
    includeRules: "Technical reference for this specific service.",
    excludeRules: "Business context (-> company_overview). Person details (-> person pages). How it was built (-> project pages). Deployment (-> environments_cicd).",
    sections: [
      { name: "Purpose", intent: "What this service does, why it exists", minBullets: 0, maxBullets: 3 },
      { name: "Owner", intent: "Who owns and maintains this service", minBullets: 0, maxBullets: 3 },
      { name: "API Surface", intent: "Key endpoints, events produced/consumed, interfaces", minBullets: 0, maxBullets: 10 },
      { name: "Data Model", intent: "Key entities, schemas, database tables", minBullets: 0, maxBullets: 8 },
      { name: "Dependencies", intent: "Other services and external systems it depends on", minBullets: 0, maxBullets: 6 },
      { name: "Configuration", intent: "Key config knobs, feature flags, env vars", minBullets: 0, maxBullets: 6 },
      { name: "Known Limitations", intent: "Known tech debt, scaling limits, gotchas", minBullets: 0, maxBullets: 5 },
    ],
  },

  integration: {
    appliesTo: "kb_page",
    includeRules: "External third-party service details as they relate to our system.",
    excludeRules: "Internal system details (-> service pages). Project history (-> project pages).",
    sections: [
      { name: "What It Does", intent: "What this integration provides to our system", minBullets: 0, maxBullets: 3 },
      { name: "How We Use It", intent: "Our specific usage patterns and configuration", minBullets: 0, maxBullets: 5 },
      { name: "API Details", intent: "Endpoints or SDKs we call, auth method, rate limits", minBullets: 0, maxBullets: 6 },
      { name: "Owner", intent: "Internal team or person responsible for this integration", minBullets: 0, maxBullets: 3 },
      { name: "Cost and Limits", intent: "Pricing tier, usage limits, billing details", minBullets: 0, maxBullets: 4 },
      { name: "Failure Modes", intent: "What happens when this integration is down", minBullets: 0, maxBullets: 4 },
    ],
  },

  setup_onboarding: {
    appliesTo: "kb_page",
    includeRules: "Everything a new engineer needs to get started.",
    excludeRules: "Ongoing processes (-> process pages). Architecture details (-> system_architecture). Production environment details (-> environments_cicd).",
    sections: [
      { name: "Prerequisites", intent: "Required software, accounts, and permissions before starting", minBullets: 0, maxBullets: 8 },
      { name: "Environment Setup", intent: "Step-by-step local development environment setup", minBullets: 0, maxBullets: 10 },
      { name: "Key Repositories", intent: "Important repos with descriptions and clone instructions", minBullets: 0, maxBullets: 8 },
      { name: "Configuration", intent: "Config files, environment variables, and secrets needed", minBullets: 0, maxBullets: 8 },
      { name: "First Tasks", intent: "Recommended starter tasks for new engineers", minBullets: 0, maxBullets: 6 },
      { name: "Common Gotchas", intent: "Frequent setup issues and their solutions", minBullets: 0, maxBullets: 8 },
      { name: "Who To Ask", intent: "Key people to contact for different topics and systems", minBullets: 0, maxBullets: 6 },
    ],
  },

  environments_cicd: {
    appliesTo: "kb_page",
    includeRules: "Environment and deployment infrastructure facts.",
    excludeRules: "Architecture details (-> system_architecture). Per-service config (-> service pages). Process steps (-> process pages).",
    sections: [
      { name: "Environments", intent: "Dev, staging, and production environments with URLs and access", minBullets: 0, maxBullets: 6 },
      { name: "CI CD Pipeline", intent: "How code gets from PR to production", minBullets: 0, maxBullets: 8 },
      { name: "Deployment Process", intent: "Step-by-step deployment, rollback procedure", minBullets: 0, maxBullets: 8 },
      { name: "Release Cadence", intent: "How often we release, branch strategy", minBullets: 0, maxBullets: 4 },
      { name: "Feature Flags", intent: "Feature flag system and how to use it", minBullets: 0, maxBullets: 5 },
      { name: "Access and Permissions", intent: "How to get access to each environment", minBullets: 0, maxBullets: 5 },
    ],
  },

  observability: {
    appliesTo: "kb_page",
    includeRules: "Monitoring, alerting, and observability infrastructure.",
    excludeRules: "Per-service details (-> service pages). Architecture (-> system_architecture).",
    sections: [
      { name: "Dashboards", intent: "Key dashboards, what they show, where to find them", minBullets: 0, maxBullets: 8 },
      { name: "Alerting", intent: "Alert channels, severity levels, who gets paged", minBullets: 0, maxBullets: 6 },
      { name: "SLOs and SLAs", intent: "Service level objectives and what we promise customers", minBullets: 0, maxBullets: 6 },
      { name: "Logging", intent: "Where logs live, how to query them, log levels", minBullets: 0, maxBullets: 5 },
      { name: "Tracing", intent: "Distributed tracing setup, how to trace a request", minBullets: 0, maxBullets: 4 },
    ],
  },

  process: {
    appliesTo: "kb_page",
    includeRules: "Recurring workflow details. Steps, triggers, owners.",
    excludeRules: "One-time projects (-> project pages). Architecture details (-> system_architecture).",
    sections: [
      { name: "Purpose", intent: "Why this process exists and what problem it solves", minBullets: 0, maxBullets: 4 },
      { name: "Owner", intent: "Who owns and maintains this process", minBullets: 0, maxBullets: 3 },
      { name: "Trigger and Frequency", intent: "What initiates this process and how often it runs", minBullets: 0, maxBullets: 4 },
      { name: "Steps", intent: "Ordered steps in the process workflow", minBullets: 0, maxBullets: 12 },
      { name: "Inputs and Outputs", intent: "What goes into the process and what comes out", minBullets: 0, maxBullets: 6 },
      { name: "Dependencies", intent: "Systems, tools, and people required for this process", minBullets: 0, maxBullets: 6 },
      { name: "Known Issues and Workarounds", intent: "Common problems encountered and their solutions", minBullets: 0, maxBullets: 8 },
      { name: "Related Runbooks", intent: "Links to runbooks, playbooks, and related documentation", minBullets: 0, maxBullets: 5 },
    ],
  },

  decision_record: {
    appliesTo: "kb_page",
    includeRules: "One significant architectural or process decision per page. Must have clear evidence.",
    excludeRules: "Trivial implementation choices. Feature requirements (-> project pages). Process steps (-> process pages).",
    sections: [
      { name: "Context", intent: "What situation prompted this decision", minBullets: 0, maxBullets: 4 },
      { name: "Decision", intent: "What was decided", minBullets: 0, maxBullets: 3 },
      { name: "Alternatives Considered", intent: "What other options were evaluated", minBullets: 0, maxBullets: 6 },
      { name: "Rationale", intent: "Why this option was chosen over alternatives", minBullets: 0, maxBullets: 4 },
      { name: "Consequences", intent: "What changed as a result, tradeoffs accepted", minBullets: 0, maxBullets: 5 },
      { name: "Status", intent: "Current status: proposed, accepted, deprecated, superseded", minBullets: 0, maxBullets: 2 },
    ],
  },

  // ── Layer B: Work & Change ────────────────────────────────────────────

  past_documented: {
    appliesTo: "kb_page",
    includeRules: "Completed project WITH existing Confluence documentation.",
    excludeRules: "Ongoing work (-> ongoing_* pages). System reference (-> service pages). Person details (-> person pages).",
    sections: [
      { name: "Summary", intent: "Brief overview of what the project was about", minBullets: 0, maxBullets: 4 },
      { name: "Motivation", intent: "Why the project was undertaken and the business need", minBullets: 0, maxBullets: 4 },
      { name: "People", intent: "Key contributors and their roles in the project", minBullets: 0, maxBullets: 6 },
      { name: "What Was Done", intent: "Deliverables and implementation details", minBullets: 0, maxBullets: 10 },
      { name: "Key Decisions", intent: "Important technical and business decisions made", minBullets: 0, maxBullets: 8 },
      { name: "Tradeoffs", intent: "Compromises made and their rationale", minBullets: 0, maxBullets: 6 },
      { name: "Systems Affected", intent: "Components that were modified or created", minBullets: 0, maxBullets: 6 },
      { name: "Outcome", intent: "Results, impact, and measurable metrics", minBullets: 0, maxBullets: 5 },
      { name: "Known Limitations", intent: "Acknowledged shortcomings or constraints", minBullets: 0, maxBullets: 5 },
      { name: "Related Tickets", intent: "Jira tickets, PRs, and issues associated with this project", minBullets: 0, maxBullets: 8 },
    ],
  },

  past_undocumented: {
    appliesTo: "kb_page",
    includeRules: "Completed project inferred from code/tickets/slack but NO existing Confluence documentation.",
    excludeRules: "Documented projects (-> past_documented). Ongoing work (-> ongoing_* pages).",
    sections: [
      { name: "Summary", intent: "Brief overview inferred from available evidence", minBullets: 0, maxBullets: 4 },
      { name: "Motivation", intent: "Inferred reason for the project based on evidence", minBullets: 0, maxBullets: 4 },
      { name: "People", intent: "Contributors identified from commits, messages, or tickets", minBullets: 0, maxBullets: 6 },
      { name: "What Was Done", intent: "Deliverables inferred from code, tickets, and discussions", minBullets: 0, maxBullets: 8 },
      { name: "Key Decisions", intent: "Decisions extracted from discussions and code changes", minBullets: 0, maxBullets: 6 },
      { name: "Systems Affected", intent: "Components touched based on code changes and tickets", minBullets: 0, maxBullets: 6 },
      { name: "Outcome", intent: "Results inferred from evidence", minBullets: 0, maxBullets: 4 },
      { name: "Discovery Evidence", intent: "Specific sources used to reconstruct this project", minBullets: 0, maxBullets: 6 },
      { name: "Confidence", intent: "Overall confidence level and what needs verification", minBullets: 0, maxBullets: 4 },
    ],
  },

  ongoing_documented: {
    appliesTo: "kb_page",
    includeRules: "Active project WITH existing Confluence docs and active Jira tickets.",
    excludeRules: "Completed projects (-> past_* pages). System reference (-> service pages).",
    sections: [
      { name: "Summary", intent: "Brief overview of the ongoing project", minBullets: 0, maxBullets: 4 },
      { name: "Motivation", intent: "Why the project was started and the business need", minBullets: 0, maxBullets: 4 },
      { name: "People", intent: "Key contributors and their current roles", minBullets: 0, maxBullets: 6 },
      { name: "What's Been Done", intent: "Work completed so far with details", minBullets: 0, maxBullets: 10 },
      { name: "What's Remaining", intent: "Outstanding work items and deliverables", minBullets: 0, maxBullets: 8 },
      { name: "Key Decisions", intent: "Important decisions made during the project", minBullets: 0, maxBullets: 8 },
      { name: "Decision Pending", intent: "Open questions and decisions awaiting resolution", minBullets: 0, maxBullets: 6 },
      { name: "Blockers", intent: "Current blockers preventing progress", minBullets: 0, maxBullets: 5 },
      { name: "Timeline", intent: "Target dates, milestones, and deadline information", minBullets: 0, maxBullets: 5 },
      { name: "Next Steps", intent: "Immediate next actions to move the project forward", minBullets: 0, maxBullets: 6 },
      { name: "Systems Affected", intent: "Components being modified or created", minBullets: 0, maxBullets: 6 },
      { name: "Existing Documentation", intent: "Links to existing Confluence docs, design docs, and specs", minBullets: 0, maxBullets: 5 },
    ],
  },

  ongoing_undocumented: {
    appliesTo: "kb_page",
    includeRules: "Active project inferred from Jira/Slack/GitHub but NO existing Confluence documentation.",
    excludeRules: "Documented projects (-> ongoing_documented). Completed projects (-> past_* pages).",
    sections: [
      { name: "Summary", intent: "Brief overview inferred from ongoing evidence", minBullets: 0, maxBullets: 4 },
      { name: "Motivation", intent: "Inferred reason for the ongoing work", minBullets: 0, maxBullets: 4 },
      { name: "People", intent: "Active contributors identified from recent activity", minBullets: 0, maxBullets: 6 },
      { name: "What's Been Done", intent: "Completed work inferred from code, tickets, and messages", minBullets: 0, maxBullets: 8 },
      { name: "Key Decisions", intent: "Decisions extracted from recent discussions", minBullets: 0, maxBullets: 6 },
      { name: "Next Steps", intent: "Upcoming work items based on tickets and discussions", minBullets: 0, maxBullets: 6 },
      { name: "Systems Affected", intent: "Components being touched based on recent changes", minBullets: 0, maxBullets: 6 },
      { name: "Discovery Evidence", intent: "Sources used to identify this undocumented project", minBullets: 0, maxBullets: 6 },
      { name: "Confidence", intent: "Confidence level and what needs verification", minBullets: 0, maxBullets: 4 },
    ],
  },

  proposed_project: {
    appliesTo: "kb_page",
    includeRules: "New project derived from an extracted ticket. Scope, estimate, risk.",
    excludeRules: "Existing project details (-> ongoing/past pages). Full system architecture (-> system_architecture).",
    sections: [
      { name: "Summary", intent: "Brief overview of the proposed new project", minBullets: 0, maxBullets: 4 },
      { name: "Motivation", intent: "Why this project should be undertaken", minBullets: 0, maxBullets: 4 },
      { name: "Proposed Scope", intent: "What the project should cover and deliver", minBullets: 0, maxBullets: 8 },
      { name: "People", intent: "Suggested team members and their roles", minBullets: 0, maxBullets: 6 },
      { name: "Estimated Effort", intent: "Time and resource estimates for completion", minBullets: 0, maxBullets: 4 },
      { name: "Systems Affected", intent: "Components that would need to be modified", minBullets: 0, maxBullets: 6 },
      { name: "Dependencies", intent: "Prerequisites and blocking dependencies", minBullets: 0, maxBullets: 6 },
      { name: "Risks", intent: "Potential risks and mitigation strategies", minBullets: 0, maxBullets: 6 },
      { name: "Customer Evidence", intent: "Customer feedback or data supporting this project", minBullets: 0, maxBullets: 6 },
      { name: "Implementation Instructions", intent: "High-level implementation approach and strategy", minBullets: 0, maxBullets: 8 },
      { name: "Context and Decision Guide", intent: "Background context and guidance for decision-making", minBullets: 0, maxBullets: 6 },
    ],
  },

  howto_implementation: {
    appliesTo: "howto_page",
    includeRules: "Step-by-step implementation guide linked to a proposed project.",
    excludeRules: "Business justification (-> proposed_project). Full architecture (-> system_architecture).",
    sections: [
      { name: "Context and Motivation", intent: "Why this implementation is needed and what problem it solves", minBullets: 0, maxBullets: 6 },
      { name: "Implementation Steps", intent: "Step-by-step guide a developer should follow to implement the change", minBullets: 0, maxBullets: 15 },
      { name: "Systems Affected", intent: "Components that will be modified and how they are impacted", minBullets: 0, maxBullets: 8 },
      { name: "Testing and Rollout", intent: "Testing strategy, test cases, and deployment plan", minBullets: 0, maxBullets: 8 },
      { name: "Risks and Dependencies", intent: "Potential risks, blockers, and prerequisite work", minBullets: 0, maxBullets: 6 },
    ],
  },

  ticket: {
    appliesTo: "kb_page",
    includeRules: "Active or recently-closed Jira ticket details.",
    excludeRules: "Full project scope (-> project pages). Architecture details (-> system_architecture/service pages).",
    sections: [
      { name: "Summary", intent: "Ticket title, type, priority, current status", minBullets: 0, maxBullets: 3 },
      { name: "Description", intent: "What needs to be done", minBullets: 0, maxBullets: 4 },
      { name: "Acceptance Criteria", intent: "Definition of done", minBullets: 0, maxBullets: 6 },
      { name: "Assignee and Owner", intent: "Who is working on it, who owns the decision", minBullets: 0, maxBullets: 3 },
      { name: "Linked Project", intent: "Which project this ticket belongs to", minBullets: 0, maxBullets: 2 },
      { name: "Systems Affected", intent: "Components that will be touched", minBullets: 0, maxBullets: 4 },
      { name: "Status Audit", intent: "Is the current Jira status accurate based on other evidence?", minBullets: 0, maxBullets: 3 },
      { name: "Discussion Context", intent: "Relevant Slack or comment context around this ticket", minBullets: 0, maxBullets: 4 },
    ],
  },

  // ── Backward-compat aliases ────────────────────────────────────────

  people: {
    appliesTo: "kb_page",
    includeRules: "Alias for 'person' template.",
    excludeRules: "",
    sections: [
      { name: "Role and Responsibilities", intent: "Job title, primary responsibilities, scope of work", minBullets: 0, maxBullets: 5 },
      { name: "Systems Ownership", intent: "Systems and services this person owns or maintains", minBullets: 0, maxBullets: 6 },
      { name: "Domain Expertise", intent: "Topics they are the go-to for", minBullets: 0, maxBullets: 6 },
      { name: "Past Project Ownership", intent: "Projects they led or contributed to", minBullets: 0, maxBullets: 8 },
      { name: "Ask Them About", intent: "Quick reference for who to ask about what", minBullets: 0, maxBullets: 6 },
    ],
  },

  clients: {
    appliesTo: "kb_page",
    includeRules: "Alias for 'client' template.",
    excludeRules: "",
    sections: [
      { name: "Overview", intent: "Client background, relationship start, account tier", minBullets: 0, maxBullets: 5 },
      { name: "Products Used", intent: "Which products and services they use", minBullets: 0, maxBullets: 6 },
      { name: "Key Contacts", intent: "Client-side + internal account owners", minBullets: 0, maxBullets: 6 },
      { name: "Feedback Themes", intent: "Recurring feedback patterns", minBullets: 0, maxBullets: 8 },
      { name: "Special Arrangements", intent: "Custom configs, SLAs, pricing", minBullets: 0, maxBullets: 5 },
      { name: "Open Issues", intent: "Known unresolved issues", minBullets: 0, maxBullets: 5 },
    ],
  },

  processes: {
    appliesTo: "kb_page",
    includeRules: "Alias for 'process' template.",
    excludeRules: "",
    sections: [
      { name: "Purpose", intent: "Why this process exists and what problem it solves", minBullets: 0, maxBullets: 4 },
      { name: "Owner", intent: "Who owns and maintains this process", minBullets: 0, maxBullets: 3 },
      { name: "Trigger and Frequency", intent: "What initiates this process and how often it runs", minBullets: 0, maxBullets: 4 },
      { name: "Steps", intent: "Ordered steps in the process workflow", minBullets: 0, maxBullets: 12 },
      { name: "Inputs and Outputs", intent: "What goes into the process and what comes out", minBullets: 0, maxBullets: 6 },
      { name: "Dependencies", intent: "Systems, tools, and people required", minBullets: 0, maxBullets: 6 },
      { name: "Known Issues and Workarounds", intent: "Common problems and solutions", minBullets: 0, maxBullets: 8 },
      { name: "Related Runbooks", intent: "Links to runbooks and related documentation", minBullets: 0, maxBullets: 5 },
    ],
  },

  new_projects: {
    appliesTo: "kb_page",
    includeRules: "Alias for 'proposed_project' template.",
    excludeRules: "",
    sections: [
      { name: "Summary", intent: "Brief overview of the proposed new project", minBullets: 0, maxBullets: 4 },
      { name: "Motivation", intent: "Why this project should be undertaken", minBullets: 0, maxBullets: 4 },
      { name: "Proposed Scope", intent: "What the project should cover and deliver", minBullets: 0, maxBullets: 8 },
      { name: "People", intent: "Suggested team members and their roles", minBullets: 0, maxBullets: 6 },
      { name: "Estimated Effort", intent: "Time and resource estimates", minBullets: 0, maxBullets: 4 },
      { name: "Systems Affected", intent: "Components that would need to be modified", minBullets: 0, maxBullets: 6 },
      { name: "Dependencies", intent: "Prerequisites and blocking dependencies", minBullets: 0, maxBullets: 6 },
      { name: "Risks", intent: "Potential risks and mitigation strategies", minBullets: 0, maxBullets: 6 },
      { name: "Customer Evidence", intent: "Customer feedback supporting this project", minBullets: 0, maxBullets: 6 },
      { name: "Implementation Instructions", intent: "High-level implementation approach", minBullets: 0, maxBullets: 8 },
      { name: "Context and Decision Guide", intent: "Background context for decision-making", minBullets: 0, maxBullets: 6 },
    ],
  },
};

// Backward compat: derived from TEMPLATE_REGISTRY
export const KB_PAGE_TEMPLATES: Partial<Record<KBCategory, string[]>> = Object.fromEntries(
  Object.entries(TEMPLATE_REGISTRY)
    .filter(([_, t]) => t.appliesTo === "kb_page")
    .map(([k, t]) => [k, t.sections.map(s => s.name)])
);

// ---------------------------------------------------------------------------
// Template helpers
// ---------------------------------------------------------------------------

export function getSectionInstructions(templateKey: string): string {
  const template = TEMPLATE_REGISTRY[templateKey];
  if (!template) return "";
  return template.sections
    .map(s => `- "${s.name}": ${s.intent}`)
    .join("\n");
}

export function getIncludeExcludeRules(templateKey: string): { include: string; exclude: string } {
  const template = TEMPLATE_REGISTRY[templateKey];
  if (!template) return { include: "", exclude: "" };
  return { include: template.includeRules, exclude: template.excludeRules };
}

export function getRequiredSectionNames(templateKey: string): string[] {
  const template = TEMPLATE_REGISTRY[templateKey];
  if (!template) return [];
  return template.sections.map(s => s.name);
}

export function buildPageSchema(_templateKey: string): z.ZodType<ScoreFormatPageType> {
  return ScoreFormatPage;
}

export function validateAndNormalizePage(
  page: ScoreFormatPageType,
  templateKey: string,
): { page: ScoreFormatPageType; violations: string[] } {
  const template = TEMPLATE_REGISTRY[templateKey];
  if (!template) return { page, violations: [] };

  const violations: string[] = [];
  const templateSections = template.sections;
  const templateNamesLower = templateSections.map(s => s.name.toLowerCase());

  const sectionMap = new Map<string, (typeof page.sections)[0]>();
  for (const section of page.sections) {
    const key = section.section_name.toLowerCase();
    const matchIdx = templateNamesLower.findIndex(
      tn => tn === key || key.includes(tn.split(" ")[0]),
    );
    if (matchIdx >= 0) {
      const canonicalName = templateSections[matchIdx].name;
      section.section_name = canonicalName;
      sectionMap.set(canonicalName.toLowerCase(), section);
    } else {
      sectionMap.set(key, section);
      violations.push(`unexpected section "${section.section_name}"`);
    }
  }

  const orderedSections: (typeof page.sections)[0][] = [];
  for (const spec of templateSections) {
    const existing = sectionMap.get(spec.name.toLowerCase());
    if (existing) {
      orderedSections.push(existing);
      sectionMap.delete(spec.name.toLowerCase());
      const bulletCount = existing.bullets?.length || 0;
      if (bulletCount > spec.maxBullets) {
        violations.push(`"${spec.name}" has ${bulletCount} bullets (max: ${spec.maxBullets})`);
      }
    } else {
      orderedSections.push({ section_name: spec.name, bullets: [] });
    }
  }

  for (const [, section] of sectionMap) {
    orderedSections.push(section);
  }

  return {
    page: { ...page, sections: orderedSections },
    violations,
  };
}
