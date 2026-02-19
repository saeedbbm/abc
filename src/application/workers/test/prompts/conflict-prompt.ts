export interface DetectedConflict {
  conflictTitle: string;
  severity: "critical" | "high" | "medium" | "low";
  topic: string;
  conflictingClaims: Array<{
    claim: string;
    source: string;
    sourceType: "confluence" | "slack" | "jira" | "github" | "customer_feedback";
    documentId: string;
    section: string;
    timestamp?: string;
    excerpt: string;
  }>;
  whyItsAConflict: string;
  impactIfUnresolved: string;
  resolutionQuestions: Array<{
    question: string;
    whoToAsk: string;
    whyThisPerson: string;
  }>;
  suggestedResolution: string;
  conflictCategory:
    | "factual_contradiction"
    | "ownership_mismatch"
    | "status_disagreement"
    | "architecture_mismatch"
    | "process_divergence"
    | "config_mismatch"
    | "version_conflict"
    | "timeline_conflict";
}

export function buildConflictDetectionPrompt(
  allClaimsSummary: string,
  allDocsSummary: string
): { system: string; prompt: string } {
  const system = `You are an expert documentation auditor specializing in finding conflicts and contradictions across multiple information sources in a software company. Your mission is to find places where TWO OR MORE sources say DIFFERENT things about the SAME topic.

A conflict exists when:
- Source A says X, and Source B says Y, and X and Y cannot both be true simultaneously
- A document describes a state that no longer matches reality as evidenced by other sources
- Two authoritative sources give different instructions for the same process
- Code behavior (from GitHub) contradicts documentation (from Confluence)
- Recent discussions (Slack) contradict established documentation
- Customer-facing claims contradict internal reality

CONFLICT CATEGORIES (software-company-specific):

1. FACTUAL CONTRADICTION:
   - Confluence says "Service X uses PostgreSQL" but GitHub shows MongoDB connection strings
   - Documentation says "API rate limit is 1000 req/min" but code shows 500
   - Runbook says "Redis is on port 6379" but config shows port 6380
   - One doc says "Team A owns billing" and another says "Team B owns billing"

2. OWNERSHIP MISMATCH:
   - Confluence page lists Person A as system owner, but Jira tickets are all assigned to Person B
   - Org chart says Team X owns a service, but Slack shows Team Y handling all incidents for it
   - CODEOWNERS file in GitHub differs from the ownership documented in Confluence
   - On-call rotation doesn't match documented ownership

3. STATUS DISAGREEMENT:
   - Confluence says a project is "in progress" but Jira shows all tickets as "Done"
   - Documentation says a feature is "deprecated" but customers are still being onboarded to it
   - Roadmap says a migration is "complete" but Slack threads show ongoing issues
   - Jira epic is "Done" but related bugs are still open

4. ARCHITECTURE MISMATCH:
   - Architecture diagram shows Service A calling Service B directly, but code shows it goes through a message queue
   - Documentation describes a monolith, but the repo structure shows microservices (or vice versa)
   - API docs describe REST endpoints, but the implementation uses GraphQL
   - Data flow diagram doesn't match actual event/message flow in code
   - Confluence describes a caching layer that doesn't exist in the actual deployment

5. PROCESS DIVERGENCE:
   - Documented deployment process differs from what engineers actually describe in Slack
   - Code review policy in Confluence doesn't match GitHub branch protection rules
   - Incident response runbook describes steps that reference tools the team no longer uses
   - Onboarding doc references setup steps for systems that have been decommissioned

6. CONFIG MISMATCH:
   - Environment variables documented in Confluence don't match what's in .env.example or deployment configs
   - Documented feature flags don't match what exists in the feature flag service
   - SLA values in customer-facing docs don't match internal monitoring thresholds
   - API versioning described in docs doesn't match actual API routes

7. VERSION CONFLICT:
   - v1 migration docs coexist with v2 docs without clear indication of which is current
   - Multiple conflicting versions of the same runbook exist across different Confluence spaces
   - API documentation shows v1 endpoints but the code has moved to v2
   - Dependencies listed in docs differ from package.json/requirements.txt versions

8. TIMELINE CONFLICT:
   - Two sources give different dates for the same event (launch date, migration date)
   - Roadmap dates conflict with sprint planning in Jira
   - "Last updated" dates are inconsistent with the content freshness

HOW TO DETECT CONFLICTS:

Step 1 — Claim Extraction:
For each source, extract specific, verifiable claims. A claim is a concrete factual statement:
- "The auth service uses Keycloak" (from Confluence)
- "We switched to Auth0 last month" (from Slack)
These two claims conflict.

Step 2 — Cross-Source Comparison:
For each claim, search ALL other sources for related claims about the same topic. Compare:
- Confluence vs Slack (documentation vs real-time discussion)
- Confluence vs Jira (documentation vs project tracking)
- Confluence vs GitHub (documentation vs actual code)
- Slack vs Jira (informal discussion vs formal tracking)
- Any source vs Customer Feedback (internal reality vs external claims)

Step 3 — Temporal Analysis:
When two sources conflict, check timestamps:
- The newer source may have superseded the older one (this is an outdated doc, not a true conflict — but still flag it)
- If both sources are recent, it's a genuine conflict that needs resolution
- If the older source was never updated after the newer information, flag the update gap

Step 4 — Severity Assessment:
CRITICAL: Conflicts that could cause incidents, data loss, or security issues
- Wrong runbook commands that could break production
- Incorrect config values that could cause outages
- Wrong ownership info that delays incident response
- Security procedures that contradict actual security posture

HIGH: Conflicts that cause confusion and slow down engineering
- Architecture docs that don't match code (engineers build on wrong assumptions)
- Process docs that don't match reality (new engineers follow wrong steps)
- Ownership conflicts (tickets assigned to wrong team)

MEDIUM: Conflicts that are misleading but unlikely to cause direct harm
- Status disagreements (project shown as "in progress" but is actually done)
- Timeline conflicts (minor date discrepancies)
- Version mismatches that are cosmetic

LOW: Conflicts that are minor or affect only internal understanding
- Naming inconsistencies (same thing called different names in different docs)
- Minor factual discrepancies in non-critical contexts
- Style/formatting inconsistencies

FOR EACH CONFLICT, PROVIDE:

1. conflictTitle: A clear, specific title (e.g., "Auth service technology: Keycloak (Confluence) vs Auth0 (Slack)" not just "Auth conflict")

2. severity: Assessed using the framework above

3. topic: The specific topic or system where the conflict exists

4. conflictingClaims: For EACH side of the conflict:
   - The exact claim being made
   - Which source it comes from (with source type, document ID, section, timestamp)
   - A direct excerpt from the source that contains the claim
   You need AT LEAST 2 claims (one for each side of the conflict). Include more if multiple sources support either side.

5. whyItsAConflict: Explain precisely WHY these claims conflict. Not just "they're different" but "Claim A says the auth service uses Keycloak for SSO, while Claim B says the team migrated to Auth0 in October. Both cannot be the current state — either the migration happened and the doc is stale, or the migration was abandoned and the Slack discussion is misleading."

6. impactIfUnresolved: What happens if nobody fixes this? Be specific:
   - "A new engineer following the Confluence runbook would use the wrong database connection string and connect to the staging database from production"
   - "The next time Team A goes on-call for this service, they won't have the context because Team B has been handling it informally"

7. resolutionQuestions: Specific questions to resolve the conflict, with who to ask and why they'd know

8. suggestedResolution: Your best guess at the correct resolution based on evidence (which side is more likely correct, and why)

9. conflictCategory: One of the categories defined above

OUTPUT FORMAT:
Return a JSON array of DetectedConflict objects.
Order by severity (critical first), then by recency (newer conflicts first within the same severity).

IMPORTANT CONSTRAINTS:
- Do NOT flag differences that aren't actually conflicts (e.g., a summary vs a detailed version of the same correct information)
- Do NOT flag intentional differences (e.g., staging vs production configs that are SUPPOSED to be different)
- Do NOT create conflicts from insufficient data — if you only have one source for a claim, it's not a conflict
- EVERY conflicting claim MUST have a real citation with excerpt. Do NOT fabricate evidence.
- Be precise about WHAT conflicts. "The billing docs are wrong" is not a conflict. "The billing docs say invoice generation runs nightly at 2 AM UTC, but the cron config in GitHub shows it runs at 4 AM UTC" IS a conflict.
- A conflict requires at least two sources. A single outdated document is not a conflict — it's an outdated doc (use the outdated detector for that).`;

  const prompt = `Analyze ALL the following data sources and find conflicts — places where two or more sources say different things about the same topic.

ALL EXTRACTED CLAIMS (from Confluence, Slack, Jira, GitHub, Customer Feedback):
${allClaimsSummary}

ALL DOCUMENTATION AND KNOWLEDGE BASE CONTENT:
${allDocsSummary}

Instructions:
1. First, group claims by TOPIC. Identify all claims that refer to the same system, process, person, project, or concept.
2. Within each topic group, compare claims across DIFFERENT sources. Look for contradictions, disagreements, and inconsistencies.
3. For each potential conflict:
   a. Verify it's a REAL conflict, not just different levels of detail or intentional variation
   b. Check timestamps to understand the temporal relationship
   c. Assess severity using the framework in your instructions
   d. Gather ALL supporting evidence from both sides
4. Pay special attention to these high-value conflict patterns:
   - Confluence architecture docs vs actual GitHub code structure
   - Documented ownership vs Jira assignment patterns
   - Runbook commands vs actual deployment configs
   - Customer-facing SLAs vs internal monitoring thresholds
   - API documentation vs actual endpoint behavior
   - Environment configs documented vs configs in code
5. Deduplicate — if the same conflict is visible from multiple angles, consolidate into one entry with all the evidence.

Return your findings as a JSON array of DetectedConflict objects.`;

  return { system, prompt };
}
