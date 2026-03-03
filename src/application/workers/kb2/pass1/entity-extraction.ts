import { randomUUID } from "crypto";
import { z } from "zod";
import { kb2InputSnapshotsCollection, kb2GraphNodesCollection } from "@/lib/mongodb";
import { getFastModel, calculateCostUsd } from "@/lib/ai-model";
import { structuredGenerate } from "@/src/application/lib/llm/structured-generate";
import { CLASSIFICATION_RULES } from "@/src/entities/models/kb2-templates";
import type { KB2GraphNodeType } from "@/src/entities/models/kb2-types";
import type { KB2ParsedDocument } from "@/src/application/lib/kb2/confluence-parser";
import { PrefixLogger } from "@/lib/utils";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";

const DEFAULT_BATCH_SIZE = 3;
const DENSE_BATCH_SIZE = 2;

const VALID_NODE_TYPES = new Set([
  "person", "team", "client", "repository", "integration", "infrastructure",
  "cloud_resource", "library", "database", "environment", "project",
  "ticket", "pull_request", "pipeline", "customer_feedback",
]);

const TYPE_ALIASES: Record<string, string> = {
  service: "repository", app: "repository", application: "repository",
  repo: "repository", codebase: "repository", module: "repository",
  system: "infrastructure", component: "infrastructure",
  framework: "library", package: "library", dependency: "library",
  tool: "integration", platform: "integration", saas: "integration",
  aws: "cloud_resource", gcp: "cloud_resource", azure: "cloud_resource",
  user: "person", member: "person", employee: "person",
  customer: "client", company: "client", organization: "client",
  segment: "client", user_segment: "client", external_contact: "client",
  bug: "ticket", issue: "ticket", task: "ticket", story: "ticket",
  feedback: "customer_feedback", support_ticket: "customer_feedback", zendesk: "customer_feedback",
  cfb: "customer_feedback", customer_ticket: "customer_feedback",
  pr: "pull_request", merge_request: "pull_request",
  ci: "pipeline", cd: "pipeline", workflow: "pipeline",
  deploy: "environment", staging: "environment",
  decision_record: "repository", pending_decision: "repository",
  process: "team",
};

function normalizeEntityType(raw: string): string {
  const lower = raw.toLowerCase().replace(/\s+/g, "_");
  if (VALID_NODE_TYPES.has(lower)) return lower;
  return TYPE_ALIASES[lower] ?? "infrastructure";
}

const ExtractedEntitySchema = z.object({
  entities: z.array(z.object({
    display_name: z.string(),
    type: z.string().describe("One of: person, team, client, repository, integration, infrastructure, cloud_resource, library, database, environment, project, ticket, pull_request, pipeline, customer_feedback"),
    source_document: z.string().describe("Title of the document this entity was found in — must match one of the Document titles provided"),
    aliases: z.array(z.string()),
    attributes: z.object({}).passthrough().describe("Key-value attributes like role, owner, tech_stack, version, _relationships"),
    confidence: z.enum(["high", "medium", "low"]),
    evidence_excerpt: z.string(),
  })),
});

const SYSTEM_PROMPT = `You are an entity extraction engine for a software company knowledge base.
Extract every distinct entity from the provided documents.

ENTITY TYPES AND DEFINITIONS:
- person: An internal team member (has Slack handle, Jira assignment, or @company email)
- team: A group of people working together (engineering, platform, mobile, etc.)
- client: An external customer — B2B company name or B2C user segment (iOS users, premium subscribers)
- repository: A code repository / deployable codebase (e.g. brewgo-api, brewgo-app, brewgo-infra)
- integration: A third-party external SaaS/API you pay for and call over the internet (Stripe, Firebase, Sentry, Datadog)
- infrastructure: A self-hosted/self-managed software component your team runs (Celery worker, Redis cache, Kafka, Nginx)
- cloud_resource: A managed cloud service instance (AWS RDS instance, S3 bucket, CloudFront distribution, ElastiCache cluster)
- library: A dependency/package/framework with version info (React 18, Django 4.2, gunicorn, pytest)
- database: A data store with schema (PostgreSQL database, MongoDB, Redis-as-datastore)
- environment: A deployment environment (dev, staging, production)
- project: A feature initiative or body of work with timeline (Loyalty Rewards v1, Scheduled Orders)
- ticket: A Jira/issue tracker item — bug, story, task (BRW-44, BRW-55)
- pull_request: A GitHub/GitLab pull request or merge request (PR #18, PR #22)
- pipeline: A CI/CD pipeline or automation workflow (GitHub Actions ci.yml, deploy.yml)
- customer_feedback: A customer service ticket or feedback item from Zendesk/support systems (CFB-xxxx). NOT a Jira ticket.

CLASSIFICATION RULES:
${CLASSIFICATION_RULES.person_vs_customer}
${CLASSIFICATION_RULES.b2c_vs_b2b}
- repository vs infrastructure: If it has its own repo/codebase that your team develops, it's a REPOSITORY. If it's a component that runs alongside your code but isn't your codebase (Celery, Redis cache, Kafka), it's INFRASTRUCTURE.
- integration vs cloud_resource: If it's a third-party SaaS you don't manage (Stripe, Sentry, Firebase), it's INTEGRATION. If it's a cloud provider resource you provision and configure (AWS RDS instance, S3 bucket, ElastiCache), it's CLOUD_RESOURCE.
- ticket vs pull_request vs customer_feedback: Jira issues/bugs/stories are TICKET. GitHub/GitLab PRs/MRs are PULL_REQUEST. Zendesk/support tickets (CFB-xxxx) are CUSTOMER_FEEDBACK. Never mix them.
- cloud_resource: Use specific resource names like "AWS RDS (PostgreSQL)" not just "AWS". Each distinct cloud resource is a separate entity.
- customer_feedback vs ticket: If a ticket comes from customerFeedback source data, it is CUSTOMER_FEEDBACK, not TICKET.
- CRITICAL: Names appearing in customerFeedback documents (requester names, commenter handles like "JavaJunkie_Renee", "Trevor Malloy") are END USERS, NOT internal team members. Do NOT create person entities for them. For B2C apps, group them by platform/behavior segment as CLIENT entities instead. Only create PERSON entities for names that also appear in Jira assignments, Slack handles, GitHub commits, or @company emails.

DO NOT EXTRACT as standalone entities:
- Individual UI components (RewardsBadge, OrderStatus, CartItem) — these are part of their REPOSITORY
- Individual API endpoints (/users/me/rewards, GET /products/{id}) — these are part of their REPOSITORY
- Individual code files (app/models/user.py, src/screens/RewardsScreen.jsx) — these are part of their REPOSITORY
- Individual functions or background tasks (apply_rewards_points, notify_order_ready) — these are part of their REPOSITORY or INFRASTRUCTURE
- Config values, constants, or environment variables — store these as ATTRIBUTES on the parent entity instead

MANDATORY EXTRACTION — you MUST extract every instance of these, even if their content overlaps with other documents:
- Every GitHub/GitLab PR that appears in the input MUST become a separate pull_request entity
- Every Jira ticket key (e.g. BRW-44, BRW-55) MUST become a separate ticket entity
- Every person with a @company email, Slack handle, or Jira assignment MUST become a separate person entity
- Every repository name MUST become a separate repository entity
- NEVER skip an entity because "it was already covered" by another document — each distinct thing is its own entity

CONFIG & CONNECTION ATTRIBUTES:
- When you see config variables (DATABASE_URL, REDIS_URL, STRIPE_SECRET_KEY, SQLALCHEMY_DATABASE_URI), store them as attributes on the parent entity
- Example for a repository: attributes.connection_config: "SQLALCHEMY_DATABASE_URI via env DATABASE_URL"
- Example for a database: attributes.connection_var: "DATABASE_URL", attributes.used_by: "brewgo-api via SQLAlchemy"

RULES:
- Each entity gets a canonical display_name and optional aliases
- For source_document: write the EXACT title of the Document where you found this entity (from the "Document N: TITLE" headers)
- Provide the entity type from the list above
- Include key attributes as a JSON object (e.g. role, owner, tech_stack, version)
- Store relationships in attributes._relationships as [{target, type, evidence}]
- Rate confidence: high = multiple sources confirm, medium = single clear mention, low = inferred
- Provide a short evidence_excerpt from the source text
- Extract liberally — do not skip entities. Deduplication happens in a later step.
- For libraries: include version in attributes if mentioned
- For tickets: include the ticket key (e.g. BRW-44) as the display_name
- For PRs: include the PR number and repo (e.g. "brewgo-api PR #18") as the display_name`;

export const entityExtractionStep: StepFunction = async (ctx) => {
  const logger = new PrefixLogger("kb2-entity-extraction");
  const snapshot = await kb2InputSnapshotsCollection.findOne({ run_id: ctx.runId });
  if (!snapshot) throw new Error("No input snapshot found — run step 1 first");

  const docs = snapshot.parsed_documents as KB2ParsedDocument[];
  const model = getFastModel();
  const stepId = "pass1-step-3";

  const denseDocs = docs.filter((d) => d.provider === "github" || d.provider === "jira");
  const normalDocs = docs.filter((d) => d.provider !== "github" && d.provider !== "jira");
  const orderedDocs = [...normalDocs, ...denseDocs];

  const allEntities: { entity: z.infer<typeof ExtractedEntitySchema>["entities"][number]; batchDocs: KB2ParsedDocument[] }[] = [];
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
    const batchText = batch.map((d, idx) =>
      `--- Document ${i + idx + 1}: ${d.title} (${d.provider}) ---\n${d.content}`,
    ).join("\n\n");

    const docNames = batch.map((d) => d.title).join(", ");
    ctx.onProgress(`LLM call ${batchNum}/${totalBatches}: extracting from ${docNames}`, Math.round((i / orderedDocs.length) * 95));

    const startMs = Date.now();
    let usageData: { promptTokens: number; completionTokens: number } | null = null;
    const result = await structuredGenerate({
      model,
      system: SYSTEM_PROMPT,
      prompt: batchText,
      schema: ExtractedEntitySchema,
      logger,
      onUsage: (usage) => { usageData = usage; },
    });
    totalLLMCalls++;

    if (usageData) {
      const durationMs = Date.now() - startMs;
      const responsePreview = JSON.stringify(result, null, 2);
      const cost = calculateCostUsd("claude-sonnet-4-6", usageData.promptTokens, usageData.completionTokens);
      ctx.logLLMCall(stepId, "claude-sonnet-4-6", SYSTEM_PROMPT + "\n\n" + batchText, responsePreview, usageData.promptTokens, usageData.completionTokens, cost, durationMs);
    }

    const entities = Array.isArray(result?.entities) ? result.entities : [];
    for (const entity of entities) {
      if (!entity.display_name) continue;
      allEntities.push({ entity, batchDocs: batch });
    }

    const pct = Math.round(((i + batch.length) / orderedDocs.length) * 95);
    ctx.onProgress(`Batch ${batchNum}/${totalBatches} done — ${entities.length} entities found (${allEntities.length} total so far) — ${Math.min(i + batchSize, orderedDocs.length)}/${orderedDocs.length} docs`, pct);
    i += batchSize;
  }

  const nodeMap = new Map<string, KB2GraphNodeType>();
  for (const { entity, batchDocs } of allEntities) {
    const key = entity.display_name.toLowerCase().trim();
    const normalizedType = normalizeEntityType(entity.type ?? "infrastructure") as any;
    const aliases = Array.isArray(entity.aliases) ? entity.aliases : [];
    const attributes = entity.attributes && typeof entity.attributes === "object" ? entity.attributes : {};
    const confidence = ["high", "medium", "low"].includes(entity.confidence) ? entity.confidence : "medium";
    const excerpt = typeof entity.evidence_excerpt === "string" ? entity.evidence_excerpt.slice(0, 300) : "";

    const matchedDoc = entity.source_document
      ? batchDocs.find((d) => d.title === entity.source_document) ?? batchDocs.find((d) => d.title.toLowerCase().includes(entity.source_document.toLowerCase())) ?? null
      : null;
    const sourceDocs = matchedDoc ? [matchedDoc] : batchDocs.slice(0, 1);

    const refs = sourceDocs.map((d) => {
      let section_heading: string | undefined;
      if (excerpt && d.sections?.length) {
        const excerptLower = excerpt.toLowerCase();
        for (const sec of d.sections) {
          if (sec.content.toLowerCase().includes(excerptLower)) {
            section_heading = sec.heading;
            break;
          }
        }
      }
      return {
        source_type: d.provider as any,
        doc_id: d.sourceId,
        title: d.title,
        excerpt,
        section_heading,
      };
    });

    if (nodeMap.has(key)) {
      const existing = nodeMap.get(key)!;
      existing.aliases = [...new Set([...existing.aliases, ...aliases])];
      existing.source_refs.push(...refs);
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
    await kb2GraphNodesCollection.deleteMany({ run_id: ctx.runId });
    await kb2GraphNodesCollection.insertMany(nodes);
  }

  ctx.onProgress(`Extracted ${nodes.length} unique entities`, 100);

  const grouped: Record<string, { display_name: string; aliases: string[]; confidence: string; source_count: number; source_refs: typeof nodes[0]["source_refs"] }[]> = {};
  for (const n of nodes) {
    if (!grouped[n.type]) grouped[n.type] = [];
    grouped[n.type].push({
      display_name: n.display_name,
      aliases: n.aliases,
      confidence: n.confidence,
      source_count: n.source_refs.length,
      source_refs: n.source_refs,
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
