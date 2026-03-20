import type { KB2NodeType, KB2HumanPageLayer } from "./kb2-types";

export type SectionRequirement = "MUST" | "MUST_IF_PRESENT" | "OPTIONAL";

export interface KB2SectionSpec {
  name: string;
  intent: string;
  requirement: SectionRequirement;
  maxBullets: number;
}

export interface KB2PageTemplate {
  description: string;
  includeRules: string;
  excludeRules: string;
  sections: KB2SectionSpec[];
}

export const ENTITY_PAGE_TEMPLATES: Partial<Record<KB2NodeType, KB2PageTemplate>> = {
  repository: {
    description: "Structured reference for a code repository / deployable codebase.",
    includeRules: "Facts about this specific codebase: what it does, stack, API surface, config.",
    excludeRules: "Individual file contents, component internals. Link to those instead.",
    sections: [
      { name: "Identity", intent: "Name, repo URL, owner (person/team), language, tier/criticality", requirement: "MUST", maxBullets: 5 },
      { name: "Purpose", intent: "What this codebase does and why it exists", requirement: "MUST", maxBullets: 3 },
      { name: "Tech Stack", intent: "Language, framework, key libraries with versions", requirement: "MUST", maxBullets: 8 },
      { name: "API Surface", intent: "Key endpoints, events produced/consumed", requirement: "MUST_IF_PRESENT", maxBullets: 10 },
      { name: "Data Model", intent: "Key entities, schemas, database tables used", requirement: "MUST_IF_PRESENT", maxBullets: 8 },
      { name: "Dependencies", intent: "Other repos, infrastructure, integrations, databases it depends on", requirement: "MUST_IF_PRESENT", maxBullets: 8 },
      { name: "CI/CD", intent: "Build pipeline, deploy process, test strategy", requirement: "MUST_IF_PRESENT", maxBullets: 6 },
      { name: "Decisions & Tradeoffs", intent: "Key architectural decisions with rationale and accepted tradeoffs", requirement: "MUST_IF_PRESENT", maxBullets: 8 },
      { name: "Known Limitations", intent: "Tech debt, scaling limits, gotchas", requirement: "OPTIONAL", maxBullets: 5 },
    ],
  },

  infrastructure: {
    description: "Structured reference for a self-hosted infrastructure component (Celery, Redis cache, Kafka, Nginx, etc.).",
    includeRules: "How this component is configured, run, and maintained.",
    excludeRules: "Application business logic. Link to repository pages instead.",
    sections: [
      { name: "Identity", intent: "Name, type, version, owner (person/team)", requirement: "MUST", maxBullets: 4 },
      { name: "Purpose", intent: "What this component does in the system", requirement: "MUST", maxBullets: 3 },
      { name: "Configuration", intent: "Key config settings, tuning parameters, environment variables", requirement: "MUST", maxBullets: 8 },
      { name: "How It Runs", intent: "Where it runs, how it's started, scaling approach", requirement: "MUST_IF_PRESENT", maxBullets: 6 },
      { name: "Dependencies", intent: "What it depends on, what depends on it", requirement: "MUST_IF_PRESENT", maxBullets: 6 },
      { name: "Monitoring", intent: "Health checks, dashboards, alerts", requirement: "OPTIONAL", maxBullets: 5 },
      { name: "Decisions & Tradeoffs", intent: "Why this component was chosen, alternatives considered", requirement: "MUST_IF_PRESENT", maxBullets: 5 },
    ],
  },

  cloud_resource: {
    description: "Structured reference for a managed cloud service instance (AWS RDS, S3 bucket, CloudFront, ElastiCache, etc.).",
    includeRules: "Configuration, access, costs for this specific cloud resource.",
    excludeRules: "General cloud provider docs. Focus on how YOUR team uses it.",
    sections: [
      { name: "Identity", intent: "Resource name, provider, type, region, owner", requirement: "MUST", maxBullets: 5 },
      { name: "Purpose", intent: "What data/traffic it handles and why", requirement: "MUST", maxBullets: 3 },
      { name: "Configuration", intent: "Instance size, key settings, encryption, backups", requirement: "MUST_IF_PRESENT", maxBullets: 8 },
      { name: "Access", intent: "How to access, IAM roles, credentials location", requirement: "MUST_IF_PRESENT", maxBullets: 5 },
      { name: "Consumers", intent: "Which repos/services read/write this resource", requirement: "MUST_IF_PRESENT", maxBullets: 6 },
      { name: "Cost Tier", intent: "Pricing tier, monthly cost estimate, usage limits", requirement: "OPTIONAL", maxBullets: 4 },
    ],
  },

  library: {
    description: "Structured reference for a dependency, package, or framework.",
    includeRules: "Name, version, where it's used, why it was chosen.",
    excludeRules: "Full library documentation. Link to official docs.",
    sections: [
      { name: "Identity", intent: "Package name, version, ecosystem (npm/pip/etc), license", requirement: "MUST", maxBullets: 4 },
      { name: "Purpose", intent: "What it does and why we use it", requirement: "MUST", maxBullets: 3 },
      { name: "Usage", intent: "Which repositories use it, how it's imported/configured", requirement: "MUST_IF_PRESENT", maxBullets: 6 },
      { name: "Known Issues", intent: "Compatibility problems, deprecation warnings, upgrade plans", requirement: "OPTIONAL", maxBullets: 5 },
    ],
  },

  pull_request: {
    description: "Structured reference for a GitHub/GitLab pull request.",
    includeRules: "PR metadata, summary of changes, linked tickets, review status.",
    excludeRules: "Full diff contents. Link to the PR URL.",
    sections: [
      { name: "Identity", intent: "PR number, repo, author, branch, status (open/merged/closed)", requirement: "MUST", maxBullets: 5 },
      { name: "Summary", intent: "What this PR changes and why", requirement: "MUST", maxBullets: 4 },
      { name: "Linked Tickets", intent: "Jira tickets or issues this PR addresses", requirement: "MUST_IF_PRESENT", maxBullets: 4 },
      { name: "Review Status", intent: "Approvals, requested changes, reviewers", requirement: "MUST_IF_PRESENT", maxBullets: 4 },
      { name: "Files Changed", intent: "Key files/areas modified", requirement: "OPTIONAL", maxBullets: 8 },
    ],
  },

  pipeline: {
    description: "Structured reference for a CI/CD pipeline or automation workflow.",
    includeRules: "Pipeline configuration, triggers, steps, deploy targets.",
    excludeRules: "Individual build logs. Describe the pipeline definition.",
    sections: [
      { name: "Identity", intent: "Pipeline name, repo, trigger (push/PR/schedule), tool (GitHub Actions/Jenkins/etc)", requirement: "MUST", maxBullets: 4 },
      { name: "Steps", intent: "Ordered list of pipeline stages and what each does", requirement: "MUST", maxBullets: 10 },
      { name: "Configuration", intent: "Key environment variables, secrets, matrix settings", requirement: "MUST_IF_PRESENT", maxBullets: 6 },
      { name: "Deploy Targets", intent: "Which environments this pipeline deploys to", requirement: "MUST_IF_PRESENT", maxBullets: 4 },
      { name: "Failure Modes", intent: "Common failures and how to fix them", requirement: "OPTIONAL", maxBullets: 5 },
    ],
  },

  client_company: {
    description: "Structured reference for an external B2B customer or partner organization.",
    includeRules: "Customer relationship, products used, contacts, feedback patterns.",
    excludeRules: "Internal team details.",
    sections: [
      { name: "Identity", intent: "Company name, account tier, industry, relationship type (customer/partner)", requirement: "MUST", maxBullets: 5 },
      { name: "Products Used", intent: "Which of our products/services they use", requirement: "MUST_IF_PRESENT", maxBullets: 6 },
      { name: "Key Contacts", intent: "Client-side contacts + internal point of contact", requirement: "MUST_IF_PRESENT", maxBullets: 6 },
      { name: "Feedback Themes", intent: "Recurring feedback patterns and feature requests", requirement: "MUST_IF_PRESENT", maxBullets: 8 },
      { name: "Special Arrangements", intent: "Custom configs, SLAs, pricing", requirement: "OPTIONAL", maxBullets: 5 },
    ],
  },

  client_person: {
    description: "Structured reference for an individual external customer or end-user segment.",
    includeRules: "Customer identity, platform, feedback, behavior patterns.",
    excludeRules: "Internal team details, PII.",
    sections: [
      { name: "Identity", intent: "Name or segment label, platform (iOS/Android/web), type (individual/segment)", requirement: "MUST", maxBullets: 5 },
      { name: "Feedback Themes", intent: "Recurring feedback patterns and feature requests", requirement: "MUST_IF_PRESENT", maxBullets: 8 },
      { name: "Associated Company", intent: "Client company they belong to (for B2B)", requirement: "OPTIONAL", maxBullets: 3 },
    ],
  },

  team_member: {
    description: "Entity page for an internal team member.",
    includeRules: "Stable attributes: what they own, what they know, contact info.",
    excludeRules: "Daily standup status, personal info.",
    sections: [
      { name: "Identity", intent: "Full name, role/title, team, slack handle, email", requirement: "MUST", maxBullets: 5 },
      { name: "Ownership", intent: "Systems and services this person owns or maintains", requirement: "MUST", maxBullets: 6 },
      { name: "Domain Expertise", intent: "Topics and areas they are the go-to person for", requirement: "MUST_IF_PRESENT", maxBullets: 6 },
      { name: "Current Focus", intent: "Active projects and primary work area", requirement: "MUST_IF_PRESENT", maxBullets: 4 },
      { name: "Past Contributions", intent: "Projects they led or significantly contributed to", requirement: "OPTIONAL", maxBullets: 8 },
      { name: "Established Conventions", intent: "Recurring patterns, design conventions, or architectural rules this person consistently applies across projects", requirement: "MUST_IF_PRESENT", maxBullets: 6 },
    ],
  },

  team: {
    description: "Entity page for a team.",
    includeRules: "Team composition, mandate, owned services, processes.",
    excludeRules: "Individual person details beyond membership.",
    sections: [
      { name: "Identity", intent: "Team name, lead, mission", requirement: "MUST", maxBullets: 4 },
      { name: "Members", intent: "Team members and their roles", requirement: "MUST", maxBullets: 12 },
      { name: "Owned Repositories", intent: "Repos and systems this team owns", requirement: "MUST", maxBullets: 8 },
      { name: "Processes", intent: "Team-specific workflows, ceremonies, release process, incident response", requirement: "MUST_IF_PRESENT", maxBullets: 8 },
    ],
  },

  database: {
    description: "Entity page for a database or data store.",
    includeRules: "Technical details an AI agent needs to interact with this store.",
    excludeRules: "Business logic, application code details.",
    sections: [
      { name: "Identity", intent: "Name, type (Postgres/Mongo/Redis/etc), owner", requirement: "MUST", maxBullets: 4 },
      { name: "Purpose", intent: "What data it stores and why", requirement: "MUST", maxBullets: 3 },
      { name: "Schema", intent: "Key tables/collections, important fields", requirement: "MUST_IF_PRESENT", maxBullets: 10 },
      { name: "Access", intent: "Connection details, credentials location, permissions", requirement: "MUST_IF_PRESENT", maxBullets: 5 },
      { name: "Consumers", intent: "Services that read/write this database", requirement: "MUST_IF_PRESENT", maxBullets: 6 },
      { name: "Decisions & Tradeoffs", intent: "Why this DB was chosen, indexing strategy, scaling approach", requirement: "MUST_IF_PRESENT", maxBullets: 5 },
    ],
  },

  environment: {
    description: "Entity page for a deployment environment.",
    includeRules: "Infrastructure facts: URLs, access, deploy process.",
    excludeRules: "Application logic, feature details.",
    sections: [
      { name: "Identity", intent: "Name (dev/staging/prod), URL, cloud provider", requirement: "MUST", maxBullets: 4 },
      { name: "Access", intent: "How to access, VPN, credentials", requirement: "MUST_IF_PRESENT", maxBullets: 5 },
      { name: "Deploy Process", intent: "How code reaches this environment", requirement: "MUST_IF_PRESENT", maxBullets: 6 },
      { name: "Monitoring", intent: "Dashboards, alerts, logs for this env", requirement: "OPTIONAL", maxBullets: 5 },
      { name: "Decisions & Tradeoffs", intent: "Why this setup, scaling decisions, cost tradeoffs", requirement: "MUST_IF_PRESENT", maxBullets: 5 },
    ],
  },

  integration: {
    description: "Entity page for an external third-party service.",
    includeRules: "How we use this external service, API details, costs.",
    excludeRules: "Internal service details.",
    sections: [
      { name: "Identity", intent: "Service name, what it provides, owner internally", requirement: "MUST", maxBullets: 4 },
      { name: "Usage", intent: "How we use it, which of our repos/services call it", requirement: "MUST", maxBullets: 5 },
      { name: "API Details", intent: "Endpoints/SDK, auth method, rate limits", requirement: "MUST_IF_PRESENT", maxBullets: 6 },
      { name: "Cost", intent: "Pricing tier, usage limits", requirement: "OPTIONAL", maxBullets: 4 },
      { name: "Failure Modes", intent: "What happens when it goes down", requirement: "OPTIONAL", maxBullets: 4 },
    ],
  },

  project: {
    description: "Entity page for a project or initiative.",
    includeRules: "Scope, status, team, key decisions.",
    excludeRules: "Daily standup updates.",
    sections: [
      { name: "Identity", intent: "Project name, status (active/completed/proposed), owner", requirement: "MUST", maxBullets: 4 },
      { name: "Purpose", intent: "What problem it solves, business motivation", requirement: "MUST", maxBullets: 3 },
      { name: "Scope", intent: "What's included and excluded", requirement: "MUST_IF_PRESENT", maxBullets: 6 },
      { name: "Key Decisions", intent: "Architectural and design decisions with rationale", requirement: "MUST_IF_PRESENT", maxBullets: 8 },
      { name: "People", intent: "Team members and their roles in this project", requirement: "MUST_IF_PRESENT", maxBullets: 6 },
      { name: "Systems Affected", intent: "Repos, databases, infra modified or created", requirement: "MUST_IF_PRESENT", maxBullets: 6 },
      { name: "Timeline", intent: "Start date, milestones, end date", requirement: "OPTIONAL", maxBullets: 5 },
      { name: "Decisions & Tradeoffs", intent: "Key decisions and rationale specific to this project", requirement: "MUST_IF_PRESENT", maxBullets: 8 },
    ],
  },

  ticket: {
    description: "Entity page for a Jira/issue tracker item.",
    includeRules: "Ticket metadata, description, status, linked work.",
    excludeRules: "Full comment threads. Summarize key discussion points.",
    sections: [
      { name: "Identity", intent: "Ticket key, type (bug/story/task), status, priority", requirement: "MUST", maxBullets: 5 },
      { name: "Summary", intent: "What this ticket is about", requirement: "MUST", maxBullets: 3 },
      { name: "Assignee & Reporter", intent: "Who is working on it, who reported it", requirement: "MUST_IF_PRESENT", maxBullets: 3 },
      { name: "Linked PRs", intent: "Pull requests that implement this ticket", requirement: "MUST_IF_PRESENT", maxBullets: 4 },
      { name: "Key Discussion", intent: "Important points from comments", requirement: "OPTIONAL", maxBullets: 5 },
    ],
  },

  customer_feedback: {
    description: "Entity page for a customer service ticket or feedback item from Zendesk/support systems.",
    includeRules: "Feedback content, customer sentiment, product area, resolution status.",
    excludeRules: "Internal customer PII. Focus on the feedback themes and product impact.",
    sections: [
      { name: "Identity", intent: "Ticket ID (CFB-xxxx), channel, priority, status", requirement: "MUST", maxBullets: 5 },
      { name: "Feedback Summary", intent: "What the customer reported or requested", requirement: "MUST", maxBullets: 4 },
      { name: "Product Area", intent: "Which product feature or area is affected", requirement: "MUST_IF_PRESENT", maxBullets: 3 },
      { name: "Customer Sentiment", intent: "Satisfaction rating, tone, urgency", requirement: "MUST_IF_PRESENT", maxBullets: 3 },
      { name: "Resolution", intent: "How it was resolved or current status", requirement: "OPTIONAL", maxBullets: 4 },
    ],
  },

  decision: {
    description: "Entity page for an architecture decision, technology choice, or design tradeoff.",
    includeRules: "The choice made, why, what was rejected, and the consequences.",
    excludeRules: "Implementation details of the chosen option. Link to project/repo pages.",
    sections: [
      { name: "Identity", intent: "Decision title, status (decided/pending/superseded), date, scope", requirement: "MUST", maxBullets: 5 },
      { name: "Context", intent: "What problem or constraint led to this decision", requirement: "MUST", maxBullets: 4 },
      { name: "Decision", intent: "What was chosen and why", requirement: "MUST", maxBullets: 4 },
      { name: "Alternatives Considered", intent: "Options that were rejected and why", requirement: "MUST_IF_PRESENT", maxBullets: 6 },
      { name: "Consequences", intent: "Accepted tradeoffs, downsides, and tech debt from this choice", requirement: "MUST_IF_PRESENT", maxBullets: 6 },
      { name: "Affected Systems", intent: "Repos, databases, infra impacted by this decision", requirement: "MUST_IF_PRESENT", maxBullets: 6 },
      { name: "Decision Makers", intent: "Who made the call, who was consulted", requirement: "OPTIONAL", maxBullets: 4 },
    ],
  },

  process: {
    description: "Entity page for a repeatable team workflow, procedure, or practice.",
    includeRules: "Steps, triggers, ownership, tools involved.",
    excludeRules: "One-time incidents or project-specific tasks.",
    sections: [
      { name: "Identity", intent: "Process name, owner (person/team), status (active/deprecated/informal)", requirement: "MUST", maxBullets: 4 },
      { name: "Purpose", intent: "What this process achieves and when it's used", requirement: "MUST", maxBullets: 3 },
      { name: "Trigger", intent: "What initiates this process", requirement: "MUST_IF_PRESENT", maxBullets: 3 },
      { name: "Steps", intent: "Key steps in order", requirement: "MUST_IF_PRESENT", maxBullets: 10 },
      { name: "Tools & Systems", intent: "Repos, integrations, dashboards used during this process", requirement: "MUST_IF_PRESENT", maxBullets: 6 },
      { name: "Known Issues", intent: "Pain points, bottlenecks, proposed improvements", requirement: "OPTIONAL", maxBullets: 5 },
    ],
  },
};

export interface HumanPageCategory {
  category: string;
  layer: KB2HumanPageLayer;
  title: string;
  description: string;
  relatedEntityTypes: KB2NodeType[];
}

export const STANDARD_HUMAN_PAGES: HumanPageCategory[] = [
  { category: "company_overview", layer: "company", title: "Company Overview", description: "Mission, products, revenue model, history", relatedEntityTypes: ["client_company"] },
  { category: "org_structure", layer: "company", title: "Org Structure", description: "Teams, reporting, on-call, cross-team dependencies", relatedEntityTypes: ["team", "team_member"] },
  { category: "onboarding", layer: "company", title: "Onboarding", description: "Getting started guide for new employees", relatedEntityTypes: ["team_member", "team", "repository", "environment"] },
  { category: "architecture_overview", layer: "engineering", title: "System Architecture", description: "High-level architecture, repository map, data flow, infrastructure", relatedEntityTypes: ["repository", "infrastructure", "cloud_resource", "database", "integration", "environment"] },
  { category: "decisions_tradeoffs", layer: "engineering", title: "Other Decisions & Tradeoffs", description: "Architectural and design decisions not tied to a specific project", relatedEntityTypes: ["decision", "repository", "infrastructure", "database", "environment"] },
  { category: "hidden_conventions", layer: "engineering", title: "Hidden Conventions & Patterns", description: "Cross-cutting conventions discovered from repeated behavior — design patterns, architecture patterns, and team conventions that were never formally documented", relatedEntityTypes: ["decision", "team_member"] },
  { category: "processes", layer: "engineering", title: "Team Processes & Workflows", description: "Repeatable workflows, procedures, and practices", relatedEntityTypes: ["process", "team"] },
  { category: "environments_deploy", layer: "engineering", title: "Environments & Deployment", description: "Dev/staging/prod, CI/CD pipelines, deploy process", relatedEntityTypes: ["environment", "pipeline", "repository"] },
  { category: "past_documented", layer: "engineering", title: "Past Projects (Documented)", description: "Completed projects with explicit documentation", relatedEntityTypes: ["project", "team_member"] },
  { category: "past_undocumented", layer: "engineering", title: "Past Projects (Discovered)", description: "Completed projects inferred from conversations, PRs, or code", relatedEntityTypes: ["project", "team_member"] },
  { category: "ongoing_documented", layer: "engineering", title: "Ongoing Projects (Documented)", description: "Active projects with explicit documentation", relatedEntityTypes: ["project", "team_member"] },
  { category: "ongoing_undocumented", layer: "engineering", title: "Ongoing Projects (Discovered)", description: "Active projects inferred from conversations, PRs, or code", relatedEntityTypes: ["project", "team_member"] },
  { category: "proposed_projects", layer: "engineering", title: "Proposed Projects", description: "Suggested projects from feedback or conversations", relatedEntityTypes: ["project", "team_member"] },
  { category: "tech_stack", layer: "engineering", title: "Tech Stack & Libraries", description: "Languages, frameworks, key dependencies with versions", relatedEntityTypes: ["library", "repository"] },
  { category: "client_overview", layer: "marketing", title: "Client Overview", description: "Customer segments, key accounts, feedback themes", relatedEntityTypes: ["client_company", "client_person"] },
];

export const INTERNAL_PERSON_SIGNALS = [
  "has @company email", "mentioned as team member", "assigned to Jira ticket",
  "has Slack handle", "appears in GitHub commits", "listed in org chart",
  "has role/title mentioned", "mentioned in on-call rotation",
] as const;

export const B2B_CUSTOMER_SIGNALS = [
  "called 'client' or 'customer'", "has company name (not person name)",
  "mentioned with 'account'", "appears in feedback with company attribution",
  "has SLA or contract reference",
] as const;

export const B2C_SEGMENT_SIGNALS = [
  "described as user group", "mentioned with platform (iOS/Android/web)",
  "described by behavior pattern", "referenced as segment or cohort",
] as const;

export const CLASSIFICATION_RULES = {
  person_vs_customer: `HARD RULE: A name is an internal TEAM_MEMBER if any of: ${INTERNAL_PERSON_SIGNALS.join("; ")}. A name is a CLIENT_PERSON if any of: ${B2B_CUSTOMER_SIGNALS.join("; ")}. When ambiguous, default to TEAM_MEMBER if they have a Slack handle or Jira assignment.`,
  b2c_vs_b2b: `For B2C products: group end-users into CLIENT_PERSON entities by platform or behavior segment. For B2B: each client organization is a CLIENT_COMPANY entity with point-of-contact info in attributes.`,
} as const;

export function getEntityTemplate(nodeType: KB2NodeType): KB2PageTemplate | undefined {
  return ENTITY_PAGE_TEMPLATES[nodeType];
}

export function getSectionInstructionsKB2(template: KB2PageTemplate): string {
  return template.sections
    .map((s) => `- "${s.name}" [${s.requirement}]: ${s.intent} (max ${s.maxBullets} items)`)
    .join("\n");
}
