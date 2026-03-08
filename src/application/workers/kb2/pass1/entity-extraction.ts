import { randomUUID } from "crypto";
import { z } from "zod";
import { getTenantCollections } from "@/lib/mongodb";
import { getFastModel, getFastModelName, calculateCostUsd } from "@/lib/ai-model";
import { structuredGenerate } from "@/src/application/lib/llm/structured-generate";
import { CLASSIFICATION_RULES } from "@/src/entities/models/kb2-templates";
import type { KB2GraphNodeType } from "@/src/entities/models/kb2-types";
import type { KB2ParsedDocument } from "@/src/application/lib/kb2/confluence-parser";
import { PrefixLogger, normalizeForMatch } from "@/lib/utils";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";

const FALLBACK_DEFAULT_BATCH_SIZE = 3;
const FALLBACK_DENSE_BATCH_SIZE = 2;

const VALID_NODE_TYPES = new Set([
  "team_member", "team", "client_company", "client_person", "repository", "integration", "infrastructure",
  "cloud_resource", "library", "database", "environment", "project", "decision", "process",
  "ticket", "pull_request", "pipeline", "customer_feedback",
]);

const TYPE_ALIASES: Record<string, string> = {
  service: "repository", app: "repository", application: "repository",
  repo: "repository", codebase: "repository", module: "repository",
  system: "infrastructure", component: "infrastructure",
  framework: "library", package: "library", dependency: "library",
  tool: "integration", platform: "integration", saas: "integration",
  aws: "cloud_resource", gcp: "cloud_resource", azure: "cloud_resource",
  user: "team_member", member: "team_member", employee: "team_member",
  person: "team_member", staff: "team_member", engineer: "team_member",
  customer: "client_person", external_contact: "client_person",
  segment: "client_person", user_segment: "client_person",
  company: "client_company", organization: "client_company", partner: "client_company",
  client: "client_company",
  bug: "ticket", issue: "ticket", task: "ticket", story: "ticket",
  feedback: "customer_feedback", support_ticket: "customer_feedback", zendesk: "customer_feedback",
  cfb: "customer_feedback", customer_ticket: "customer_feedback",
  pr: "pull_request", merge_request: "pull_request",
  ci: "pipeline", cd: "pipeline",
  deploy: "environment", staging: "environment",
  decision_record: "decision", pending_decision: "decision",
  adr: "decision", tradeoff: "decision", architecture_decision: "decision",
  workflow: "process", procedure: "process", runbook: "process",
};

function normalizeEntityType(raw: string): string {
  const lower = raw.toLowerCase().replace(/\s+/g, "_");
  if (VALID_NODE_TYPES.has(lower)) return lower;
  return TYPE_ALIASES[lower] ?? "infrastructure";
}

const ExtractedEntitySchema = z.object({
  entities: z.array(z.object({
    display_name: z.string(),
    type: z.string().describe("One of: team_member, team, client_company, client_person, repository, integration, infrastructure, cloud_resource, library, database, environment, project, decision, process, ticket, pull_request, pipeline, customer_feedback"),
    reasoning: z.string().describe("1-2 sentence explanation: why this type, why this name, which source evidence led to this classification"),
    description: z.string().describe("1-2 sentence factual summary of what this entity is or does, written for someone unfamiliar with the source documents"),
    source_documents: z.array(z.object({
      doc_id: z.string().describe("The exact doc_id value from the Document header brackets, e.g. 'general' or 'PAW-8'"),
      source_type: z.string().describe("The exact source_type value from the Document header brackets, e.g. 'slack' or 'jira'"),
      title: z.string().describe("The document title after the brackets in the Document header"),
      evidence_excerpt: z.string().describe("Exact quote from this specific document that mentions this entity"),
    })).describe("ALL documents from the current batch that mention this entity — include every document, not just the first one"),
    aliases: z.array(z.string()),
    attributes: z.object({}).passthrough().describe("Key-value attributes like role, owner, tech_stack, version, _relationships"),
    confidence: z.enum(["high", "medium", "low"]),
  })),
});

const SYSTEM_PROMPT = `You are an entity extraction engine for a software company knowledge base.
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
- project: A feature initiative or body of work with timeline. MUST include attributes.status (one of: "active", "completed", "proposed", "planned") and attributes.documentation_level (one of: "documented" if it has Confluence/wiki docs, "undocumented" if only mentioned in Slack/PRs/code). When a larger project has named sub-features or phases, extract BOTH the parent project AND each sub-feature as separate project entities.
- ticket: A Jira/issue tracker item — bug, story, task
- pull_request: A GitHub/GitLab pull request or merge request
- decision: An architecture decision, technology choice, or design tradeoff — explicit or implicit. Look for: "we decided to...", "we chose X over Y", "the tradeoff was...", "we went with...", alternatives discussed in PR reviews, Slack debates that concluded with a choice. MUST include attributes: attributes.decision_status (one of: "decided", "pending", "superseded", "reversed"), attributes.rationale (why this choice was made, 1-2 sentences), attributes.alternatives_considered (what was rejected, array of strings, can be empty), attributes.scope (what this decision affects, e.g. "authentication", "database", "deployment"). SHOULD include if present: attributes.decided_by (person or team who made the call), attributes.consequences (known tradeoffs or accepted downsides), attributes.superseded_by (name of the decision that replaced this one, if reversed/superseded).
- process: A repeatable workflow, procedure, or practice the team follows — formal or informal. Look for: "our process for...", "how we do...", runbooks, on-call procedures, release checklists, code review norms, incident response steps, onboarding steps. MUST include attributes: attributes.process_status (one of: "active", "deprecated", "proposed", "informal"), attributes.documentation_level (one of: "documented", "undocumented" — same logic as project). SHOULD include if present: attributes.owner (person or team responsible), attributes.trigger (what initiates this process, e.g. "new PR", "incident alert", "new hire"), attributes.steps_summary (brief ordered list of key steps).
- pipeline: A CI/CD pipeline or automation workflow (GitHub Actions ci.yml, deploy.yml). This is an AUTOMATED workflow, not a human process.
- customer_feedback: A customer service ticket or feedback item from Zendesk/support systems (CFB-xxxx). NOT a Jira ticket.

## SOURCE-BASED CLASSIFICATION
${CLASSIFICATION_RULES.person_vs_customer}
${CLASSIFICATION_RULES.b2c_vs_b2b}
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
- For PRs: include the PR number and repo as the display_name`;

export const entityExtractionStep: StepFunction = async (ctx) => {
  const logger = new PrefixLogger("kb2-entity-extraction");
  const tc = getTenantCollections(ctx.companySlug);
  const snapshot = await tc.input_snapshots.findOne({ run_id: ctx.runId });
  if (!snapshot) throw new Error("No input snapshot found — run step 1 first");

  const docs = snapshot.parsed_documents as KB2ParsedDocument[];
  const model = getFastModel(ctx.config?.pipeline_settings?.models);
  const stepId = "pass1-step-3";

  const extractionSettings = ctx.config?.pipeline_settings?.entity_extraction;
  const DEFAULT_BATCH_SIZE = extractionSettings?.default_batch_size ?? FALLBACK_DEFAULT_BATCH_SIZE;
  const DENSE_BATCH_SIZE = extractionSettings?.dense_batch_size ?? FALLBACK_DENSE_BATCH_SIZE;
  const EXCERPT_MAX = extractionSettings?.evidence_excerpt_max_length ?? 300;

  let systemPrompt = ctx.config?.prompts?.entity_extraction?.system || SYSTEM_PROMPT;
  const p = ctx.config?.profile ?? {} as Record<string, any>;
  const fillVar = (tpl: string, key: string, val: string) =>
    val ? tpl.replace(new RegExp(`\\$\\{${key}\\}`, "g"), val) : tpl.replace(new RegExp(`\\$\\{${key}\\}\\n?`, "g"), "");
  systemPrompt = fillVar(systemPrompt, "company_name", p.company_name ?? "");
  systemPrompt = fillVar(systemPrompt, "company_description", p.company_context ?? "");
  systemPrompt = fillVar(systemPrompt, "company_context", p.company_context ?? "");
  systemPrompt = fillVar(systemPrompt, "business_model", p.business_model ?? "");
  systemPrompt = fillVar(systemPrompt, "project_prefix", p.project_prefix ?? "");
  const knownTeam: string[] = p.known_team_members ?? [];
  systemPrompt = fillVar(systemPrompt, "known_team_members", knownTeam.length ? knownTeam.join(", ") : "none specified");
  const knownRepos: string[] = p.known_repos ?? [];
  systemPrompt = fillVar(systemPrompt, "known_repos_rule",
    knownRepos.length ? `Known repos: ${knownRepos.join(", ")}. Prefer these canonical names over variants.` : "");
  const knownClients: string[] = p.known_client_companies ?? [];
  systemPrompt = fillVar(systemPrompt, "known_clients_rule",
    knownClients.length ? `Known client companies: ${knownClients.join(", ")}. Classify these as client_company.` : "");
  systemPrompt = fillVar(systemPrompt, "tech_stack_section",
    p.tech_stack_notes ? `Tech stack notes: ${p.tech_stack_notes}` : "");
  const envs: string[] = p.deployment_environments ?? [];
  systemPrompt = fillVar(systemPrompt, "environments_section",
    envs.length ? `Deployment environments: ${envs.join(", ")}` : "");
  systemPrompt = fillVar(systemPrompt, "se_notes_section",
    p.se_notes ? `Additional SE notes: ${p.se_notes}` : "");
  systemPrompt = systemPrompt.replace(/\$\{classification_rules\}/g,
    `${CLASSIFICATION_RULES.person_vs_customer}\n${CLASSIFICATION_RULES.b2c_vs_b2b}`);

  const denseDocs = docs.filter((d) => d.provider === "github" || d.provider === "jira");
  const normalDocs = docs.filter((d) => d.provider !== "github" && d.provider !== "jira");
  const orderedDocs = [...normalDocs, ...denseDocs];

  type EntityWithMeta = {
    entity: z.infer<typeof ExtractedEntitySchema>["entities"][number];
    batchDocs: KB2ParsedDocument[];
    batchIndex: number;
    llmCallId: string;
  };
  const allEntities: EntityWithMeta[] = [];
  let totalLLMCalls = 0;

  let totalBatches = 0;
  {
    let idx = 0;
    while (idx < orderedDocs.length) {
      const batchSize = orderedDocs[idx].provider === "github" || orderedDocs[idx].provider === "jira" ? DENSE_BATCH_SIZE : DEFAULT_BATCH_SIZE;
      idx += batchSize;
      totalBatches++;
    }
  }

  let batchCount = 0;
  for (let i = 0; i < orderedDocs.length; ) {
    const batchSize = orderedDocs[i].provider === "github" || orderedDocs[i].provider === "jira" ? DENSE_BATCH_SIZE : DEFAULT_BATCH_SIZE;
    const batch = orderedDocs.slice(i, i + batchSize);
    batchCount++;
    const batchNum = batchCount;
    const batchCallId = randomUUID();
    const batchText = batch.map((d, idx) =>
      `--- Document ${i + idx + 1} [doc_id="${d.sourceId}" source_type="${d.provider}"] : ${d.title} ---\n${d.content}`,
    ).join("\n\n");

    if (ctx.signal.aborted) throw new Error("Pipeline cancelled by user");

    const docNames = batch.map((d) => d.title).join(", ");
    await ctx.onProgress(`LLM call ${batchNum}/${totalBatches}: extracting from ${docNames}`, Math.round((i / orderedDocs.length) * 95));

    const startMs = Date.now();
    let usageData: { promptTokens: number; completionTokens: number } | null = null;
    const result = await structuredGenerate({
      model,
      system: systemPrompt,
      prompt: batchText,
      schema: ExtractedEntitySchema,
      logger,
      onUsage: (usage) => { usageData = usage; },
      signal: ctx.signal,
    });
    totalLLMCalls++;

    if (usageData) {
      const durationMs = Date.now() - startMs;
      const responsePreview = JSON.stringify(result, null, 2);
      const cost = calculateCostUsd(getFastModelName(ctx.config?.pipeline_settings?.models), usageData.promptTokens, usageData.completionTokens);
      ctx.logLLMCall(stepId, getFastModelName(ctx.config?.pipeline_settings?.models), systemPrompt + "\n\n" + batchText, responsePreview, usageData.promptTokens, usageData.completionTokens, cost, durationMs, batchCallId);
    }

    const entities = Array.isArray(result?.entities) ? result.entities : [];
    for (const entity of entities) {
      if (!entity.display_name) continue;
      allEntities.push({ entity, batchDocs: batch, batchIndex: batchNum, llmCallId: batchCallId });
    }

    const pct = Math.round(((i + batch.length) / orderedDocs.length) * 95);
    await ctx.onProgress(`Batch ${batchNum}/${totalBatches} done — ${entities.length} entities found (${allEntities.length} total so far) — ${Math.min(i + batchSize, orderedDocs.length)}/${orderedDocs.length} docs`, pct);
    i += batchSize;
  }

  const nodeMap = new Map<string, KB2GraphNodeType>();
  for (const { entity, batchDocs, batchIndex, llmCallId } of allEntities) {
    const key = entity.display_name.toLowerCase().trim();
    const normalizedType = normalizeEntityType(entity.type ?? "infrastructure") as any;
    const aliases = Array.isArray(entity.aliases) ? entity.aliases : [];
    const rawAttrs = entity.attributes && typeof entity.attributes === "object" ? entity.attributes : {};
    const reasoning = (entity as any).reasoning ?? "";
    const description = (entity as any).description ?? "";
    const attributes = {
      ...rawAttrs,
      ...(reasoning ? { _reasoning: reasoning } : {}),
      ...(description ? { _description: description } : {}),
      _batch_index: batchIndex,
      _llm_call_id: llmCallId,
    };
    const confidence = ["high", "medium", "low"].includes(entity.confidence) ? entity.confidence : "medium";

    const sourceDocs = (entity as any).source_documents ?? [];
    const refs: KB2GraphNodeType["source_refs"] = [];

    const batchDocIndex = new Map<string, KB2ParsedDocument>();
    for (const d of batchDocs) {
      batchDocIndex.set(d.sourceId, d);
      batchDocIndex.set(d.sourceId.toLowerCase(), d);
    }

    if (sourceDocs.length > 0) {
      for (const sd of sourceDocs) {
        const rawExcerpt = typeof sd.evidence_excerpt === "string" ? sd.evidence_excerpt.slice(0, EXCERPT_MAX) : "";
        const llmDocId = (sd.doc_id ?? "").trim();
        const llmSourceType = (sd.source_type ?? "").trim();
        const llmTitle = sd.title ?? "";

        const matchedDoc = batchDocIndex.get(llmDocId)
          ?? batchDocIndex.get(llmDocId.toLowerCase())
          ?? null;

        if (matchedDoc) {
          let section_heading: string | undefined;
          if (rawExcerpt && matchedDoc.sections?.length) {
            const el = normalizeForMatch(rawExcerpt);
            for (const sec of matchedDoc.sections) {
              if (normalizeForMatch(sec.content).includes(el)) { section_heading = sec.heading; break; }
            }
          }
          refs.push({ source_type: matchedDoc.provider as any, doc_id: matchedDoc.sourceId, title: matchedDoc.title, excerpt: rawExcerpt, section_heading });
        } else {
          refs.push({ source_type: (llmSourceType || "unknown") as any, doc_id: llmDocId || llmTitle, title: llmTitle, excerpt: rawExcerpt });
        }
      }
    }

    if (refs.length === 0) {
      const fallbackDoc = batchDocs[0];
      if (fallbackDoc) refs.push({ source_type: fallbackDoc.provider as any, doc_id: fallbackDoc.sourceId, title: fallbackDoc.title, excerpt: "" });
    }

    if (nodeMap.has(key)) {
      const existing = nodeMap.get(key)!;
      existing.aliases = [...new Set([...existing.aliases, ...aliases])];
      const existingDocIds = new Set(existing.source_refs.map((r) => `${r.doc_id}:${r.title}`));
      for (const r of refs) {
        if (!existingDocIds.has(`${r.doc_id}:${r.title}`)) existing.source_refs.push(r);
      }
      existing.attributes = { ...existing.attributes, ...attributes };
      if (confidence === "high") existing.confidence = "high";
    } else {
      nodeMap.set(key, {
        node_id: randomUUID(),
        run_id: ctx.runId,
        type: normalizedType,
        display_name: entity.display_name,
        aliases,
        attributes,
        source_refs: refs,
        truth_status: "direct",
        confidence,
      });
    }
  }

  const nodes = Array.from(nodeMap.values());
  if (nodes.length > 0) {
    await tc.graph_nodes.deleteMany({ run_id: ctx.runId });
    await tc.graph_nodes.insertMany(nodes);
  }

  await ctx.onProgress(`Extracted ${nodes.length} unique entities`, 100);

  const grouped: Record<string, { display_name: string; aliases: string[]; confidence: string; source_count: number; source_refs: typeof nodes[0]["source_refs"]; attributes: Record<string, unknown>; reasoning?: string; description?: string; batch_index?: number; llm_call_id?: string }[]> = {};
  for (const n of nodes) {
    if (!grouped[n.type]) grouped[n.type] = [];
    grouped[n.type].push({
      display_name: n.display_name,
      aliases: n.aliases,
      confidence: n.confidence,
      source_count: n.source_refs.length,
      source_refs: n.source_refs,
      attributes: n.attributes ?? {},
      reasoning: (n.attributes as any)?._reasoning ?? undefined,
      description: (n.attributes as any)?._description ?? undefined,
      batch_index: (n.attributes as any)?._batch_index ?? undefined,
      llm_call_id: (n.attributes as any)?._llm_call_id ?? undefined,
    });
  }
  for (const type of Object.keys(grouped)) {
    grouped[type].sort((a, b) => a.display_name.localeCompare(b.display_name));
  }

  return {
    total_entities: nodes.length,
    llm_calls: totalLLMCalls,
    entities_by_type: grouped,
  };
};
