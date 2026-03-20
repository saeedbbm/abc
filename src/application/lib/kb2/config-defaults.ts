import type {
  CompanyConfigData,
  ProfileConfig,
  KBStructureConfig,
  EntityTemplatesConfig,
  PromptsConfig,
  PipelineSettingsConfig,
  SyncConfig,
  RefinementsConfig,
  EmbedSettings,
  GraphRAGSettings,
  GraphEnrichmentSettings,
  ChatSettings,
  VerifyCheckSettings,
  TicketGenerationSettings,
  HowtoOnDemandSettings,
  ImpactSettings,
} from "@/src/entities/models/kb2-company-config";

const defaultProfile: ProfileConfig = {
  company_context: "",
  company_name: "",
  business_model: "b2c",
  product_type: "web_app",
  project_prefix: "",
  acronyms: [],
  focus_areas: [],
  exclusions: "",
};

const defaultKBStructure: KBStructureConfig = {
  layers: {
    company: {
      enabled: true,
      pages: [
        { category: "company_overview", layer: "company", title: "Company Overview", description: "Mission, products, revenue model, history", relatedEntityTypes: ["client_company"], order: 1, enabled: true },
        { category: "org_structure", layer: "company", title: "Org Structure", description: "Teams, reporting, on-call, cross-team dependencies", relatedEntityTypes: ["team", "team_member"], order: 2, enabled: true },
        { category: "onboarding", layer: "company", title: "Onboarding", description: "Getting started guide for new employees", relatedEntityTypes: ["team_member", "team", "repository", "environment"], order: 3, enabled: true },
      ],
    },
    engineering: {
      enabled: true,
      pages: [
        { category: "architecture_overview", layer: "engineering", title: "System Architecture", description: "High-level architecture, repository map, data flow, infrastructure", relatedEntityTypes: ["repository", "infrastructure", "cloud_resource", "database", "integration", "environment"], order: 1, enabled: true },
        { category: "environments_deploy", layer: "engineering", title: "Environments & Deployment", description: "Dev/staging/prod, CI/CD pipelines, deploy process", relatedEntityTypes: ["environment", "pipeline", "repository"], order: 2, enabled: true },
        { category: "tech_stack", layer: "engineering", title: "Tech Stack & Libraries", description: "Languages, frameworks, key dependencies with versions", relatedEntityTypes: ["library", "repository"], order: 3, enabled: true },
        { category: "past_documented", layer: "engineering", title: "Past Documented", description: "Completed projects with explicit documentation", relatedEntityTypes: ["project", "team_member"], order: 4, enabled: true },
        { category: "past_undocumented", layer: "engineering", title: "Past Undocumented", description: "Completed projects inferred from conversations, PRs, or code", relatedEntityTypes: ["project", "team_member"], order: 5, enabled: true },
        { category: "ongoing_documented", layer: "engineering", title: "Ongoing Documented", description: "Active projects with explicit documentation", relatedEntityTypes: ["project", "team_member"], order: 6, enabled: true },
        { category: "ongoing_undocumented", layer: "engineering", title: "Ongoing Undocumented", description: "Active projects inferred from conversations, PRs, or code", relatedEntityTypes: ["project", "team_member"], order: 7, enabled: true },
        { category: "proposed_projects", layer: "engineering", title: "Proposed", description: "Suggested projects from feedback or conversations", relatedEntityTypes: ["project", "team_member"], order: 8, enabled: true },
        { category: "decisions_tradeoffs", layer: "engineering", title: "Other Decisions & Tradeoffs", description: "Architectural and design decisions not tied to a specific project", relatedEntityTypes: ["decision", "repository", "infrastructure", "database", "environment"], order: 9, enabled: true },
        { category: "processes", layer: "engineering", title: "Team Processes & Workflows", description: "Repeatable workflows, procedures, and practices", relatedEntityTypes: ["process", "team"], order: 10, enabled: true },
      ],
    },
    marketing: {
      enabled: false,
      pages: [
        { category: "client_overview", layer: "marketing", title: "Client Overview", description: "Customer segments, key accounts, feedback themes", relatedEntityTypes: ["client_company", "client_person"], order: 1, enabled: true },
      ],
    },
    legal: {
      enabled: false,
      pages: [],
    },
  },
};

const defaultEntityTemplates: EntityTemplatesConfig = {
  repository: {
    description: "Structured reference for a code repository / deployable codebase.",
    includeRules: "Facts about this specific codebase: what it does, stack, API surface, config.",
    excludeRules: "Individual file contents, component internals. Link to those instead.",
    enabled: true,
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
  person: {
    description: "Entity page for an internal team member.",
    includeRules: "Stable attributes: what they own, what they know, contact info.",
    excludeRules: "Daily standup status, personal info.",
    enabled: true,
    sections: [
      { name: "Identity", intent: "Full name, role/title, team, slack handle, email", requirement: "MUST", maxBullets: 5 },
      { name: "Ownership", intent: "Systems and services this person owns or maintains", requirement: "MUST", maxBullets: 6 },
      { name: "Domain Expertise", intent: "Topics and areas they are the go-to person for", requirement: "MUST_IF_PRESENT", maxBullets: 6 },
      { name: "Decisions & Tradeoffs", intent: "Technical decisions this person has made, architectural preferences, tradeoff reasoning, and their approach to problem-solving. Pull from PR reviews, Slack discussions, code comments.", requirement: "MUST_IF_PRESENT", maxBullets: 10 },
      { name: "Current Focus", intent: "Active projects and primary work area", requirement: "MUST_IF_PRESENT", maxBullets: 4 },
      { name: "Past Contributions", intent: "Projects they led or significantly contributed to", requirement: "OPTIONAL", maxBullets: 8 },
    ],
  },
  team: {
    description: "Entity page for a team.",
    includeRules: "Team composition, mandate, owned services, processes.",
    excludeRules: "Individual person details beyond membership.",
    enabled: true,
    sections: [
      { name: "Identity", intent: "Team name, lead, mission", requirement: "MUST", maxBullets: 4 },
      { name: "Members", intent: "Team members and their roles", requirement: "MUST", maxBullets: 12 },
      { name: "Owned Repositories", intent: "Repos and systems this team owns", requirement: "MUST", maxBullets: 8 },
      { name: "Processes", intent: "Team-specific workflows, ceremonies, release process, incident response", requirement: "MUST_IF_PRESENT", maxBullets: 8 },
    ],
  },
  client: {
    description: "Structured reference for an external customer (B2B company or B2C user segment).",
    includeRules: "Customer relationship, products used, contacts, feedback patterns.",
    excludeRules: "Internal team details.",
    enabled: true,
    sections: [
      { name: "Identity", intent: "Name, type (B2B company / B2C segment), account tier, platform (iOS/Android/web). Include client_category: user_segment, business, or individual.", requirement: "MUST", maxBullets: 5 },
      { name: "Products Used", intent: "Which of our products/services they use", requirement: "MUST_IF_PRESENT", maxBullets: 6 },
      { name: "Key Contacts", intent: "Client-side contacts + internal point of contact", requirement: "MUST_IF_PRESENT", maxBullets: 6 },
      { name: "Feedback Themes", intent: "Recurring feedback patterns and feature requests", requirement: "MUST_IF_PRESENT", maxBullets: 8 },
      { name: "Special Arrangements", intent: "Custom configs, SLAs, pricing", requirement: "OPTIONAL", maxBullets: 5 },
    ],
  },
  project: {
    description: "Entity page for a project or initiative.",
    includeRules: "Scope, status, team, key decisions.",
    excludeRules: "Daily standup updates.",
    enabled: true,
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
    enabled: true,
    sections: [
      { name: "Identity", intent: "Ticket key, type (bug/story/task), status, priority", requirement: "MUST", maxBullets: 5 },
      { name: "Summary", intent: "What this ticket is about", requirement: "MUST", maxBullets: 3 },
      { name: "Assignee & Reporter", intent: "Who is working on it, who reported it", requirement: "MUST_IF_PRESENT", maxBullets: 3 },
      { name: "Linked PRs", intent: "Pull requests that implement this ticket", requirement: "MUST_IF_PRESENT", maxBullets: 4 },
      { name: "Key Discussion", intent: "Important points from comments", requirement: "OPTIONAL", maxBullets: 5 },
    ],
  },
  infrastructure: {
    description: "Structured reference for a self-hosted infrastructure component.",
    includeRules: "How this component is configured, run, and maintained.",
    excludeRules: "Application business logic.",
    enabled: true,
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
    description: "Structured reference for a managed cloud service instance.",
    includeRules: "Configuration, access, costs for this specific cloud resource.",
    excludeRules: "General cloud provider docs. Focus on how YOUR team uses it.",
    enabled: true,
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
    excludeRules: "Full library documentation.",
    enabled: true,
    sections: [
      { name: "Identity", intent: "Package name, version, ecosystem (npm/pip/etc), license", requirement: "MUST", maxBullets: 4 },
      { name: "Purpose", intent: "What it does and why we use it", requirement: "MUST", maxBullets: 3 },
      { name: "Usage", intent: "Which repositories use it, how it's imported/configured", requirement: "MUST_IF_PRESENT", maxBullets: 6 },
      { name: "Known Issues", intent: "Compatibility problems, deprecation warnings, upgrade plans", requirement: "OPTIONAL", maxBullets: 5 },
    ],
  },
  database: {
    description: "Entity page for a database or data store.",
    includeRules: "Technical details an AI agent needs to interact with this store.",
    excludeRules: "Business logic, application code details.",
    enabled: true,
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
    enabled: true,
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
    enabled: true,
    sections: [
      { name: "Identity", intent: "Service name, what it provides, owner internally", requirement: "MUST", maxBullets: 4 },
      { name: "Usage", intent: "How we use it, which of our repos/services call it", requirement: "MUST", maxBullets: 5 },
      { name: "API Details", intent: "Endpoints/SDK, auth method, rate limits", requirement: "MUST_IF_PRESENT", maxBullets: 6 },
      { name: "Cost", intent: "Pricing tier, usage limits", requirement: "OPTIONAL", maxBullets: 4 },
      { name: "Failure Modes", intent: "What happens when it goes down", requirement: "OPTIONAL", maxBullets: 4 },
    ],
  },
  pull_request: {
    description: "Structured reference for a GitHub/GitLab pull request.",
    includeRules: "PR metadata, summary of changes, linked tickets, review status.",
    excludeRules: "Full diff contents.",
    enabled: true,
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
    excludeRules: "Individual build logs.",
    enabled: true,
    sections: [
      { name: "Identity", intent: "Pipeline name, repo, trigger (push/PR/schedule), tool (GitHub Actions/Jenkins/etc)", requirement: "MUST", maxBullets: 4 },
      { name: "Steps", intent: "Ordered list of pipeline stages and what each does", requirement: "MUST", maxBullets: 10 },
      { name: "Configuration", intent: "Key environment variables, secrets, matrix settings", requirement: "MUST_IF_PRESENT", maxBullets: 6 },
      { name: "Deploy Targets", intent: "Which environments this pipeline deploys to", requirement: "MUST_IF_PRESENT", maxBullets: 4 },
      { name: "Failure Modes", intent: "Common failures and how to fix them", requirement: "OPTIONAL", maxBullets: 5 },
    ],
  },
  customer_feedback: {
    description: "Entity page for a customer service ticket or feedback item.",
    includeRules: "Feedback content, customer sentiment, product area, resolution status.",
    excludeRules: "Internal customer PII.",
    enabled: true,
    sections: [
      { name: "Identity", intent: "Ticket ID (CFB-xxxx), channel, priority, status", requirement: "MUST", maxBullets: 5 },
      { name: "Feedback Summary", intent: "What the customer reported or requested", requirement: "MUST", maxBullets: 4 },
      { name: "Product Area", intent: "Which product feature or area is affected", requirement: "MUST_IF_PRESENT", maxBullets: 3 },
      { name: "Customer Sentiment", intent: "Satisfaction rating, tone, urgency", requirement: "MUST_IF_PRESENT", maxBullets: 3 },
      { name: "Resolution", intent: "How it was resolved or current status", requirement: "OPTIONAL", maxBullets: 4 },
    ],
  },
};

const defaultPrompts: PromptsConfig = {
  entity_extraction: {
    system: `You are an entity extraction engine for a software company knowledge base.
Extract every distinct entity from the provided documents.

## COMPANY CONTEXT
Company: \${company_name}
Description: \${company_description}
Business model: \${business_model}
Jira prefix: \${project_prefix}
\${tech_stack_section}
\${environments_section}
\${se_notes_section}

## ENTITY TYPES
- team_member: An internal team member — someone with a Slack handle, Jira assignment, @company email, or GitHub commits
- team: A group of people working together (engineering, platform, mobile, etc.)
- client_company: An external B2B customer/partner organization (company name, not a person)
- client_person: An external individual customer, end-user, or B2C user segment (individual names from support tickets, user segments like "iOS users")
- repository: A code repository / deployable codebase
- integration: A third-party external SaaS/API you pay for and call over the internet (Stripe, Firebase, Sentry, Datadog)
- infrastructure: A self-hosted/self-managed software component your team runs (Celery worker, Redis cache, Kafka, Nginx)
- cloud_resource: A managed cloud service instance (AWS RDS instance, S3 bucket, CloudFront distribution)
- library: A dependency/package/framework with version info (React 18, Django 4.2)
- database: A data store with schema (PostgreSQL database, MongoDB, Redis-as-datastore)
- environment: A deployment environment (dev, staging, production)
- project: A feature initiative or body of work with timeline. MUST include attributes.status (one of: "active", "completed", "proposed") and attributes.documentation_level (one of: "documented" if it has Confluence/wiki docs, "undocumented" if only mentioned in Slack/PRs/code). When a larger project has named sub-features or phases, extract BOTH the parent project AND each sub-feature as separate project entities.
- ticket: A Jira/issue tracker item — bug, story, task
- pull_request: A GitHub/GitLab pull request or merge request
- decision: An architecture decision, technology choice, or design tradeoff — explicit or implicit. Look for: "we decided to...", "we chose X over Y", "the tradeoff was...", "we went with...", alternatives discussed in PR reviews, Slack debates that concluded with a choice. MUST include attributes: attributes.decision_status (one of: "decided", "pending", "superseded", "reversed"), attributes.rationale (why this choice was made, 1-2 sentences), attributes.alternatives_considered (what was rejected, array of strings, can be empty), attributes.scope (what this decision affects, e.g. "authentication", "database", "deployment"). SHOULD include if present: attributes.decided_by (person or team who made the call), attributes.consequences (known tradeoffs or accepted downsides), attributes.superseded_by (name of the decision that replaced this one, if reversed/superseded).
- process: A repeatable workflow, procedure, or practice the team follows — formal or informal. Look for: "our process for...", "how we do...", runbooks, on-call procedures, release checklists, code review norms, incident response steps, onboarding steps. MUST include attributes: attributes.status (one of: "active", "deprecated", "proposed", "informal"), attributes.documentation_level (one of: "documented", "undocumented" — same logic as project). SHOULD include if present: attributes.owner (person or team responsible), attributes.trigger (what initiates this process, e.g. "new PR", "incident alert", "new hire"), attributes.steps_summary (brief ordered list of key steps).
- pipeline: A CI/CD pipeline or automation workflow (GitHub Actions ci.yml, deploy.yml). This is an AUTOMATED workflow, not a human process.
- customer_feedback: A customer service ticket or feedback item from Zendesk/support systems (CFB-xxxx). NOT a Jira ticket.

## SOURCE-BASED CLASSIFICATION
HARD RULE: A name is an internal TEAM_MEMBER if any of: has @company email; mentioned as team member; assigned to Jira ticket; has Slack handle; appears in GitHub commits; listed in org chart; has role/title mentioned; mentioned in on-call rotation. A name is a CLIENT_PERSON if any of: called 'client' or 'customer'; has company name (not person name); mentioned with 'account'; appears in feedback with company attribution; has SLA or contract reference. When ambiguous, default to TEAM_MEMBER if they have a Slack handle or Jira assignment.
For B2C products: group end-users into CLIENT_PERSON entities by platform or behavior segment. For B2B: each client organization is a CLIENT_COMPANY entity with point-of-contact info in attributes.
- If a name appears in \${known_team_members}, it is ALWAYS a team_member — never classify them as client_person
- The company name "\${company_name}" should NEVER be extracted as a standalone entity
\${known_repos_rule}

## CLIENT HANDLING
- For B2B (\${business_model}): each client organization is a client_company entity. Individual contacts at that company are client_person entities with attributes._relationships linking to the company.
- For B2C: group end-users by platform/behavior segment as client_person entities.
\${known_clients_rule}

## CLASSIFICATION RULES
- repository vs infrastructure: If it has its own repo/codebase that your team develops, it's a REPOSITORY. If it's a component that runs alongside your code but isn't your codebase (Celery, Redis cache, Kafka), it's INFRASTRUCTURE.
- integration vs cloud_resource: If it's a third-party SaaS you don't manage (Stripe, Sentry, Firebase), it's INTEGRATION. If it's a cloud provider resource you provision and configure (AWS RDS instance, S3 bucket, ElastiCache), it's CLOUD_RESOURCE.
- ticket vs pull_request vs customer_feedback: Jira issues/bugs/stories are TICKET. GitHub/GitLab PRs/MRs are PULL_REQUEST. Zendesk/support tickets (CFB-xxxx) are CUSTOMER_FEEDBACK. Never mix them.
- cloud_resource: Use specific resource names like "AWS RDS (PostgreSQL)" not just "AWS". Each distinct cloud resource is a separate entity.
- customer_feedback vs ticket: If a ticket comes from customerFeedback source data, it is CUSTOMER_FEEDBACK, not TICKET.
- CRITICAL: Names appearing in customerFeedback documents (requester names, commenter handles) are END USERS, NOT internal team members. Do NOT create team_member entities for them. For B2C apps, group them by platform/behavior segment as client_person entities instead. Only create team_member entities for names that also appear in Jira assignments, Slack handles, GitHub commits, or @company emails.
- decision vs project: A decision is a CHOICE (we chose Postgres over MongoDB). A project is a BODY OF WORK (migrate to Postgres). If a document describes both the work and the choice, extract BOTH — the project entity and the decision entity, linked via _relationships.
- process vs team: A process is HOW something is done (code review process). A team is WHO does it (engineering team). The process entity should link to the team via _relationships.
- process vs pipeline: A pipeline is an AUTOMATED CI/CD workflow (GitHub Actions). A process is a HUMAN workflow (incident response, release checklist). If it runs in CI, it's a pipeline. If humans follow steps, it's a process.

## DO NOT EXTRACT
- Individual UI components — these are part of their REPOSITORY
- Individual API endpoints — these are part of their REPOSITORY
- Individual code files — these are part of their REPOSITORY
- Individual functions or background tasks — these are part of their REPOSITORY or INFRASTRUCTURE
- Config values, constants, or environment variables — store these as ATTRIBUTES on the parent entity instead

## MANDATORY EXTRACTION
- Every GitHub/GitLab PR that appears in the input MUST become a separate pull_request entity
- Every Jira ticket key MUST become a separate ticket entity
- Every team member with a @company email, Slack handle, or Jira assignment MUST become a separate team_member entity
- Every repository name MUST become a separate repository entity
- NEVER skip an entity because "it was already covered" by another document — each distinct thing is its own entity

## GRANULAR EXTRACTION BY SOURCE TYPE
Extract every distinct named feature, initiative, phase, or body of work as its own separate project entity. Do NOT roll sub-features into a parent just because they appear in the same document. Deduplication across batches happens in a later pipeline step — your job is to be exhaustive.

- Confluence / wiki pages: Documents often describe projects with multiple phases, milestones, or named sub-features. Extract EACH phase or named feature as its own project entity with its own source_documents and evidence. For example, a doc titled "Website Redesign" with sections on "Browse Page", "Shelter Pages", and "Mobile Responsiveness" should produce at least 4 project entities — the parent and each sub-initiative. Capture the detailed attributes (status, what was built, who worked on it) from each section.

- Slack messages: Conversations often casually reference multiple distinct features, projects, or work items in a single thread. Extract every named feature, initiative, or project mentioned — even if it is only a brief reference. A message like "priorities: 1) profiles 2) search 3) partner page" should produce 3 separate project entities, not one.

- GitHub PRs: PRs reference the feature/project they belong to, dependent work, and linked issues beyond the PR itself. Extract the parent feature or project as a separate entity if it is named. Extract related work items mentioned in PR descriptions or comments.

- Jira tickets: Tickets may reference parent epics, related projects, blocked features, or upstream/downstream dependencies. Extract each distinct referenced project, epic, or feature as its own entity. The ticket itself is one entity; the project it belongs to is another.

- Customer feedback: Feedback items may reference specific product areas, features, or workflows by name. Extract each named feature or product area as its own entity.

## CONFIG & CONNECTION ATTRIBUTES
- When you see config variables (DATABASE_URL, REDIS_URL, STRIPE_SECRET_KEY), store them as attributes on the parent entity
- Example for a repository: attributes.connection_config: "SQLALCHEMY_DATABASE_URI via env DATABASE_URL"
- Example for a database: attributes.connection_var: "DATABASE_URL", attributes.used_by: "brewgo-api via SQLAlchemy"

## RULES
- Each entity gets a canonical display_name and optional aliases
- For each entity, provide a brief reasoning explaining your classification — why this type, why this name, which source evidence
- For each entity, provide a description — a 1-2 sentence factual summary of what this entity is, what it does, or what it covers. This is NOT the same as reasoning (which explains your classification logic). The description should be useful to someone who has never seen the source documents. Example: for a project entity "Browse Page Redesign", the description might be "Redesign of the pet browse page with responsive grid layout, filter bar, and lazy loading. Completed in Q2 2023 as part of Phase 1 of the website redesign."
- For source_documents: list ALL documents from the current batch where this entity appears. Each document header has the format: Document N [doc_id="ID" source_type="TYPE"] : TITLE. You MUST copy the exact doc_id and source_type values from the brackets into your response. Also include the title and an exact quote as evidence_excerpt.
- Provide the entity type from the list above
- Include key attributes as a JSON object (e.g. role, owner, tech_stack, version)
- Store relationships in attributes._relationships as [{target, type, evidence}]
- Use these relationship types: OWNED_BY, DEPENDS_ON, USES, STORES_IN, DEPLOYED_TO, MEMBER_OF, WORKS_ON, LEADS, CONTAINS, RUNS_ON, BUILT_BY, RESOLVES, BLOCKED_BY, COMMUNICATES_VIA, FEEDBACK_FROM, RELATED_TO
- Pick the most specific type. Use RELATED_TO only when nothing else fits.
- For decisions: use RELATED_TO to link to the project/repo/infra the decision affects. Example: {target: "pawfinder-api", type: "RELATED_TO", evidence: "Decision affects the API repo"}
- Rate confidence: high = multiple sources confirm, medium = single clear mention, low = inferred
- Each evidence_excerpt must be an EXACT QUOTE copied verbatim from the source document — do NOT paraphrase or summarize
- The excerpt MUST contain the entity name or a direct reference to it — if your excerpt does not clearly mention the entity, extend the quote or pick a better passage
- Include enough surrounding context for the excerpt to be meaningful on its own (at minimum the full sentence, not a fragment)
- When a message or paragraph mentions the entity mid-sentence, include the FULL sentence — never truncate before the relevant part
- If multiple sentences in a document reference the entity, pick the most specific and informative one
- Extract liberally — do not skip entities. Deduplication happens in a later step.
- For libraries: include version in attributes if mentioned
- For tickets: include the ticket key as the display_name
- For PRs: include the PR number and repo as the display_name`,
  },
  entity_resolution: {
    system: `You are an entity resolution engine. Given pairs of entities that might be duplicates, decide whether they should be merged.

RULES:
- Merge if they clearly refer to the same real-world thing
- Do NOT merge if they are genuinely different things
- Do NOT merge if one is a component/part of the other
- When merging, pick the most precise/canonical name as the canonical_name
- Be conservative — only merge when confident they are the same entity
- If you are unsure, set unsure: true and should_merge: false. A human will review.
- For person entities: if one name is a first-name-only mention and the other is a full name with the same first name, and there is no other person with that first name, merge them.
- Names like 'matt.chen' and 'Matt Chen' are always the same person — merge them.

CROSS-TYPE PAIRS:
- Some pairs may have different entity types (e.g. one is a "project" and the other is a "decision"). Merge if they refer to the same real-world thing extracted under different types.
- When merging cross-type pairs, set canonical_type to the most appropriate type: a body of work with timeline is "project", a specific choice or tradeoff is "decision", a repeatable workflow is "process".
- Do NOT merge if one is a child/component of the other (e.g. a decision ABOUT a project is not the same entity as the project — those should remain separate).
- Do NOT merge if the relationship is "this decision was made as part of this project" — that is a relationship, not a duplicate.`,
  },
  extraction_validation: {
    system_gap: `You are a quality assurance reviewer for a knowledge base entity extraction system. Your job is to find entities that the primary extraction missed. Be thorough but precise — only flag real entities, not attributes or components.

For each missed entity, you MUST provide an evidence_excerpt: an exact verbatim quote from the source document that mentions or evidences the entity. Copy the text word-for-word — do NOT paraphrase or summarize. The excerpt must clearly reference the entity and include enough surrounding context to be meaningful on its own (at minimum the full sentence).`,
    system_judge: `You are the final judge for entity extraction validation. For each candidate:
- ADD: The entity is real and missing from the existing list. Assign the correct type from: team_member, team, client_company, client_person, repository, integration, infrastructure, cloud_resource, library, database, environment, project, decision, process, ticket, pull_request, pipeline, customer_feedback.
- REJECT: The entity is already covered, is not a real entity, or is an attribute/component of an existing entity.
- RETYPE: The entity exists but the suggested type is wrong. Provide the correct type.
Be precise. Only ADD genuinely missing entities.`,
    system_attr_inference: `You are an attribute inference engine for a knowledge base system. You receive entities with their source excerpts and must infer missing attributes.

## PROJECT STATUS

Allowed values: active, completed, proposed, planned.

CRITICAL: A project's status describes the OVERALL initiative, not any single ticket or PR.
- The excerpts may mention Jira ticket statuses (Done, In Progress, Backlog) and PR states (merged, open). These describe individual work items, NOT the project as a whole.
- A project is "completed" ONLY when ALL evidence points to it being finished — every ticket Done, every PR merged, no further references to outstanding work, and no ongoing discussion.
- A project is "active" if there are ANY In Progress tickets, open PRs, or recent Slack/comment mentions of ongoing work — even if most tickets are Done and some PRs are merged.
- A project is "proposed" if it is only discussed as a future idea with no work started.
- A project is "planned" if tickets/epics exist but no development work has begun.
- When in doubt between "active" and "completed", prefer "active".

## DECISION ATTRIBUTES

- "rationale": why the decision was made. Only fill if the excerpts state or strongly imply the reason.
- "scope": which project, feature, or area it affects.
- "decided_by": the person or group who made it. Only fill if explicitly named.
- Omit any field where the excerpts lack clear evidence.

## PROCESS STATUS

Allowed values: active, deprecated, proposed, informal.
- "active": the process has formal documentation (e.g., a Confluence page with defined steps) and is currently followed.
- "informal": the process is practiced but NOT formally documented — only visible in Slack conversations, PR review patterns, or casual mentions.
- "deprecated": evidence indicates the process is no longer followed or has been replaced.
- "proposed": the process is discussed as something the team should adopt but hasn't yet.

## GENERAL RULES

- DO NOT hallucinate. If the excerpts do not contain enough information, omit the field (return undefined). An empty field is always better than a guess.
- "reasoning": REQUIRED. You must quote the specific evidence from the excerpts that led to your conclusion. For example: "PAW-34 Done + PR #49 merged + no further references → completed" or "PAW-32 In Progress → project still active despite other tickets being Done".
- "confidence": "high" = clear, unambiguous evidence; "medium" = reasonable inference from partial evidence; "low" = weak signal, limited data.`,
  },
  discovery: {
    system: `You analyze company knowledge base documents and an existing entity list to discover MISSING projects and tickets that should exist but were never formally documented.

\${company_context}

Look for:
1. PAST UNDOCUMENTED PROJECTS: Work mentioned in conversations/PRs that happened in the past but has no project entity
2. ONGOING UNDOCUMENTED WORK: Patterns of activity around a topic with no project entity tracking it
3. PROPOSED PROJECTS: Customer feedback themes or conversation suggestions indicating a new project/feature should be created
4. PROPOSED TICKETS: Bugs, tasks, or improvements mentioned in conversations or feedback that have no Jira ticket
5. PROPOSED FROM FEEDBACK: Recurring customer complaints or requests that deserve their own tracking item

For proposed tickets: generate a ticket key following the project prefix convention (e.g., if existing tickets use PAW-XX, generate PAW-100, PAW-101, etc.). Use the format 'KEY: Title'.
For proposed tickets: include in the description HOW this should be implemented based on existing patterns. Reference specific entities (repos, libraries, established patterns) that would be relevant. Do not just restate the feedback — add engineering context.

RULES:
- Only propose discoveries that do NOT already exist as entities
- Each discovery must have clear evidence from the source documents
- Set confidence to "medium" for inferred items, "high" only for clearly mentioned but untracked items
- For proposed items, set confidence to "low" since they need human verification
- Source document types: Confluence = documented, Jira = project tracking, Slack = conversations, GitHub = code/PRs, Customer Feedback = external user reports`,
  },
  graph_enrichment: {
    system: `You are a knowledge graph relationship discoverer. Given a batch of entities from a software company's knowledge base, identify missing relationships between them.

Your ONLY job is to find relationships between the entities listed below. Do NOT suggest new entities or reclassify existing ones.

Valid relationship types:
- OWNED_BY, DEPENDS_ON, USES, STORES_IN, DEPLOYED_TO, MEMBER_OF, WORKS_ON, LEADS, CONTAINS, RUNS_ON, BUILT_BY, RESOLVES, RELATED_TO, BLOCKED_BY, COMMUNICATES_VIA, FEEDBACK_FROM

Rules:
- Both source and target MUST be entities from the list — use their exact display_name
- Only suggest relationships you are confident about
- Return an empty array if no clear relationships can be inferred`,
  },
  generate_entity_pages: {
    system: `You generate structured entity reference pages for a knowledge base.
Each page has sections with bullet-point items. Each item is a single factual statement.

\${template_rules}
Section layout:
\${section_instructions}

Rules:
- Each item must be a standalone factual statement.
- For source_titles: list ALL source document titles that support this fact.
- Rate confidence: high = multiple sources confirm, medium = single source, low = inferred/uncertain.
- Only include information supported by the provided context.
- If a section has no relevant data, return it with an empty items array.`,
  },
  generate_human_pages: {
    system: `You generate human-readable concept hub pages for a company knowledge base.
These pages synthesize information from AI entity pages into coherent, well-structured prose.

Page: "\${page_title}"
Layer: \${page_layer}
Purpose: \${page_description}

Rules:
- Write clear, professional prose paragraphs (not bullet lists).
- Each paragraph should have a descriptive heading.
- For entity_refs: list the DISPLAY NAMES of entities mentioned in the paragraph. NEVER use IDs or UUIDs.
- ONLY include information from the provided AI entity pages — do not invent facts.
- Write 3-8 paragraphs depending on available information.
- For used_items: list which entity page items you used to write each paragraph.`,
  },
  generate_howto: {
    system: `You generate implementation guide documents for engineering tickets.
Each guide has sections that must be filled with specific, actionable content.

\${company_context}

Sections: \${howto_sections}

Rules:
- Overview: 2-3 sentences explaining what this ticket is about and why it matters.
- Context: What existing patterns, systems, and decisions are relevant. Reference specific entities.
- Requirements: What must be true when this is done. Acceptance criteria.
- Implementation Steps: Step-by-step how to build this. Reference specific files, patterns, libraries from the KB. Use code examples where helpful.
- Testing Plan: What tests to write. What edge cases to cover.
- Risks and Considerations: What could go wrong. What tradeoffs exist.
- Prompt Section: If an AI agent were implementing this, what prompt/instructions would you give it?

CRITICAL: Reference actual patterns and decisions discovered in the KB. Do NOT give generic advice.`,
  },
  extract_claims: {
    system: `You extract atomic factual claims from knowledge base pages.
Each claim should be a single, self-contained factual statement that can be independently verified.

Rules:
- Break compound sentences into separate claims.
- Preserve entity names exactly as written.
- Rate confidence based on how definitive the source text is.
- Mark truth_status as "direct" if stated explicitly, "inferred" if derived from context.
- List entity names referenced in each claim in entity_refs.`,
  },
  create_verify_cards: {
    system: `You review verification card candidates for a company knowledge base.
For each candidate, decide whether to keep it and rewrite it for a human reviewer.

SEVERITY RUBRIC:
- S1 (Critical): Affects production systems, could cause wrong AI chat answers, factual contradiction about infrastructure/payments/auth
- S2 (High): Important factual claim about system behavior needing verification, integration details, data flow
- S3 (Medium): Organizational/process claims, team membership, project status
- S4 (Low): Nice-to-know, cosmetic, low-impact gaps like missing optional info

RULES:
- Filter out noise: if a candidate is trivially true or would waste a reviewer's time, set keep: false
- Write a specific, human-friendly title
- Write a description that explains what's at stake if this is wrong
- Missing section cards for sections unlikely to have data should be S4 or filtered
- Inferred claims about critical systems should be S1 or S2`,
  },
  cluster_factgroups: {
    system: `You validate whether pairs of claims are duplicates, conflicts, or merely related.`,
  },
  conflict_detection: {
    system: `You detect contradictions between claims in the same fact group.`,
  },
  verify_check: {
    system: `You validate edits to knowledge base items. Given an edit (old text → new text) and the surrounding context, determine:
1. Is the edit consistent with other facts in the KB?
2. What other items might need to change as a result?
3. Are there any conflicts this edit introduces?

For each affected item, explain what needs to change and why.`,
  },
  verify_analyst: {
    system: `You are a knowledge graph analyst. Given a user's modification request and a list of all entity nodes in the knowledge base, identify EVERY node whose entity page would need to be updated.\n\nThink through the graph relationships:\n- If the user says "use X instead of Y", find the node for Y AND every node that mentions or depends on Y (people who work with Y, repos that use Y, projects involving Y, etc.)\n- Include both directly and indirectly affected nodes\n- Be thorough — missing an affected node means the knowledge base becomes inconsistent`,
  },
  verify_editor: {
    system: `You are a precise knowledge base editor. Apply the user's change to the given pages/tickets.\n\nRULES:\n1. ONLY change what the user explicitly asked to change.\n2. If the user says "use X instead of Y", replace every literal mention of "Y" with "X" in the text — nothing more.\n3. Do NOT rename related tools, libraries, or dependencies unless the user specifically mentioned them.\n4. Keep all other text, section names, structure, and formatting exactly as-is.\n5. If a page mentions Y in a person's expertise or a project's tech stack, update that mention too.\n6. If a page does NOT actually contain text that needs changing, SKIP it entirely.\n\nReturn ONLY a JSON object (no markdown fences):\n{\n  "drafts": [\n    {\n      "id": "draft-N",\n      "title": "Page title",\n      "target_type": "entity_page" or "ticket",\n      "target_id": "page_id or ticket_id",\n      "before_text": "full current content",\n      "after_text": "full content with ONLY the requested change"\n    }\n  ],\n  "questions": []\n}`,
  },
  chat: {
    system: `You are a helpful assistant that answers questions about the company using the provided knowledge base context. The context comes from multiple layers:\n1. Referenced Items — specific pages, tickets, or cards the user is looking at (most relevant)\n2. Knowledge Graph — structured entities and their relationships (most authoritative)\n3. KB Pages — generated summaries of entities and topics\n4. Document Chunks — raw text from source documents (most detailed)\n\nPrefer referenced items and graph information for factual answers. Use document chunks for specific details, quotes, and context.\nBe concise and cite sources when possible. If you don't have enough information, say so.`,
  },
  ticket_generation: {
    system: `You are a product management AI for a software company knowledge base.\nGiven customer feedback text, generate actionable engineering tickets.\n\nRules:\n- Each ticket should be specific and actionable\n- Set priority based on impact and urgency: P0=critical/blocking, P1=high impact, P2=medium, P3=low/nice-to-have\n- Reference affected systems by name from the provided list\n- Extract exact customer quotes as evidence\n- Do NOT create tickets that duplicate existing ones\n- Generate 1-8 tickets depending on feedback complexity`,
  },
  howto_on_demand: {
    system: `You generate structured implementation guides. Output EXACTLY these sections separated by "## Section Name" headers:\n- Overview\n- Context\n- Requirements\n- Implementation Steps\n- Testing Plan\n- Risks and Considerations\n- Prompt Section\n\nFor the "Prompt Section", write a structured prompt that could be given to an AI coding agent to implement this task. Include file paths, patterns to follow, and test commands.\n\nBe concise but thorough. Use bullet points and code blocks where appropriate.`,
  },
  impact_analysis: {
    system: `You are a knowledge-base impact analyzer. Given a change to an entity, identify all downstream impacts on related entities, pages, tickets, and claims. Be precise about severity:\n- S1: Critical — breaks correctness of a core entity or claim\n- S2: High — significant factual change that should be propagated\n- S3: Medium — minor update that may need propagation\n- S4: Low — cosmetic or unlikely to affect other artifacts`,
  },
  propagation: {
    system: `You determine which section item in an entity page needs to be updated based on a recommended action.\nGiven the page content and the recommended action, return the 0-based section_index, item_index, and the exact new_text for that item.\nThe new_text should incorporate the recommended action while preserving relevant context from the original.`,
  },
  execute_coding: {
    system: `You are simulating a coding agent's terminal output. Given a task, generate realistic terminal output showing the agent reading KB context, planning changes, writing code, running tests, and creating a PR. Output should look like timestamped terminal lines. Keep it concise (20-30 lines).`,
  },
  execute_generic: {
    system: `You are simulating an AI agent's terminal output. Generate realistic terminal output for the given task. Keep it concise.`,
  },
  sync_entity_extraction: null,
  sync_entity_resolution: null,
};

const defaultPipelineSettings: PipelineSettingsConfig = {
  entity_resolution: {
    similarity_threshold: 0.4,
    llm_batch_size: 15,
    auto_merge_first_names: true,
    auto_merge_dotted_names: true,
  },
  entity_extraction: {
    default_batch_size: 3,
    dense_batch_size: 2,
    evidence_excerpt_max_length: 300,
  },
  discovery: {
    batch_size: 3,
    content_cap_per_doc: 3000,
    categories_enabled: {
      past_undocumented: true,
      ongoing_undocumented: true,
      proposed_project: true,
      proposed_ticket: true,
      proposed_from_feedback: true,
    },
  },
  page_generation: {
    doc_snippets_per_entity_page: 8,
    vector_snippets_per_entity_page: 6,
    max_entity_pages_per_human_page: 25,
    paragraph_range: { min: 3, max: 8 },
  },
  howto: {
    sections: [
      "Overview",
      "Context",
      "Requirements",
      "Implementation Steps",
      "Testing Plan",
      "Risks and Considerations",
      "Prompt Section",
    ],
  },
  verification: {
    batch_size: 25,
    ownerable_types: ["repository", "infrastructure", "database", "project"],
    severity_labels: {
      S1: { label: "Needs Attention", color: "red" },
      S2: { label: "Worth Checking", color: "orange" },
      S3: { label: "Quick Verify", color: "yellow" },
      S4: { label: "Looks Good", color: "green" },
    },
    card_sections: [
      "problem_explanation",
      "supporting_evidence",
      "missing_evidence",
      "affected_entities",
      "required_data",
      "verification_question",
      "recommended_action",
    ],
  },
  pass2: {
    cluster_similarity_threshold: 0.85,
    cluster_max_pairs: 50,
    conflict_batch_size: 10,
    evidence_score_threshold: 0.8,
    evidence_min_hits: 2,
    propagation_chunk_size: 1000,
  },
  models: {
    fast: "claude-sonnet-4-6",
    reasoning: "claude-sonnet-4-20250514",
    judge: "claude-opus-4-20250514",
  },
  embed: {
    chunk_size: 1000,
    chunk_overlap: 200,
    embed_batch_size: 96,
  },
  graphrag: {
    vector_top_k: 10,
    neighbor_edges_limit: 20,
    related_nodes_limit: 15,
    doc_snippet_length: 500,
    doc_snippets_limit: 10,
  },
  graph_enrichment: {
    batch_size: 15,
    edge_weight: 0.8,
  },
  chat: {
    graph_node_limit: 20,
    edge_limit: 50,
    entity_page_limit: 20,
    human_page_limit: 10,
    page_context_length: 15000,
    vector_limit: 10,
    vector_score_threshold: 0.5,
    rag_context_length: 30000,
    max_output_tokens: 2048,
  },
  verify_check: {
    batch_size: 5,
    max_tokens: 16384,
  },
  ticket_generation: {
    node_limit: 200,
    existing_tickets_limit: 50,
    feedback_max_length: 15000,
  },
  howto_on_demand: {
    edges_limit: 20,
    related_nodes_limit: 10,
    max_output_tokens: 4096,
  },
  impact: {
    edges_limit: 50,
    related_pages_limit: 20,
    min_value_length: 50,
  },
};

const defaultSyncConfig: SyncConfig = {
  frequency: "daily",
  sources: [
    { source: "confluence", enabled: true, strategy: "cursor" },
    { source: "jira", enabled: true, strategy: "cursor" },
    { source: "slack", enabled: true, strategy: "cursor" },
    { source: "github", enabled: true, strategy: "cursor" },
    { source: "customerFeedback", enabled: true, strategy: "hash" },
  ],
};

export function buildDefaultConfigData(): CompanyConfigData {
  return {
    profile: defaultProfile,
    people_hints: [],
    team_hints: [],
    kb_structure: defaultKBStructure,
    entity_templates: defaultEntityTemplates,
    prompts: defaultPrompts,
    pipeline_settings: defaultPipelineSettings,
    data_sources: [],
    refinements: {
      entity_merges: [],
      entity_removals: [],
      category_removals: [],
      category_reorder: {} as Record<string, string[]>,
      page_removals: [],
      discovery_decisions: [],
      general_feedback: "",
    },
    sync_config: defaultSyncConfig,
  };
}
