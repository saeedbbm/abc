export interface OutdatedDoc {
  documentTitle: string;
  documentSource: string;
  documentId: string;
  severity: "critical" | "high" | "medium" | "low";
  outdatedItems: Array<{
    whatIsOutdated: string;
    exactQuoteOrSection: string;
    sectionReference: string;
    currentReality: string;
    evidenceSources: Array<{
      sourceType: "slack" | "jira" | "github" | "confluence" | "customer_feedback";
      documentId: string;
      title: string;
      excerpt: string;
      timestamp?: string;
    }>;
  }>;
  suggestedUpdate: string;
  verificationQuestions: Array<{
    question: string;
    whoToAsk: string;
    whyThisPerson: string;
  }>;
  lastKnownUpdateDate?: string;
  staleSinceDays?: number;
  outdatedCategory:
    | "deprecated_api"
    | "removed_feature"
    | "changed_team_structure"
    | "outdated_architecture"
    | "stale_runbook"
    | "changed_sla"
    | "outdated_dependency"
    | "decommissioned_service"
    | "changed_process"
    | "outdated_config"
    | "personnel_change"
    | "infrastructure_change";
}

export function buildOutdatedDetectionPrompt(
  allDocsSummary: string,
  recentActivitySummary: string
): { system: string; prompt: string } {
  const system = `You are an expert documentation freshness auditor for a software company. Your job is to find documentation that is STALE — content that was once accurate but has become outdated due to changes in the codebase, team, processes, or infrastructure.

An outdated document is DIFFERENT from a conflicted document:
- CONFLICT: Two sources actively disagree (both claim to be current)
- OUTDATED: A document describes a past state that has clearly been superseded by newer information, but no one updated the doc

The danger of outdated docs is that people trust them. An engineer following a stale runbook may execute wrong commands. A new hire reading an outdated architecture doc may build on incorrect assumptions. A sales engineer quoting deprecated features to a customer creates contractual risk.

CATEGORIES OF OUTDATED CONTENT (software-company-specific):

1. DEPRECATED API REFERENCES:
   - Documentation references API endpoints that have been deprecated or removed
   - API version in docs (v1) doesn't match current version (v2, v3)
   - Authentication methods described are no longer supported (e.g., docs say API key, but system moved to OAuth)
   - SDK or library examples use methods that have been removed in current versions
   - Webhook payload formats described don't match current schema
   Detection: Look for API endpoints in docs that don't appear in recent GitHub code, or where GitHub shows "deprecated" annotations

2. REMOVED FEATURES:
   - Documentation describes features or settings that no longer exist in the product
   - User guides reference UI elements, menu items, or configuration options that have been removed
   - Integration documentation references third-party services that have been disconnected
   - Feature flags documented that have been permanently toggled or removed
   Detection: Look for feature names in docs that appear in Jira tickets marked as "removed," "decommissioned," or "sunset"

3. CHANGED TEAM STRUCTURE:
   - Org charts that don't reflect current team composition
   - Documentation listing people in roles they no longer hold
   - Team ownership of systems that has changed hands
   - Escalation paths that reference people who have left the company or changed teams
   - On-call rotations that don't match current staffing
   Detection: Compare person references in docs against recent Slack activity and Jira assignments — if a person is documented as owner but hasn't touched that system in months while someone else handles all tickets, the doc is stale

4. OUTDATED ARCHITECTURE:
   - Architecture diagrams showing components that have been replaced, merged, or split
   - Data flow descriptions that don't match current message/event routing
   - Technology references that have been swapped (e.g., doc says Redis but the system moved to Memcached)
   - Microservice boundaries that have changed (services split or merged)
   - Cloud infrastructure that has been migrated (e.g., doc says EC2 but the system is now on EKS)
   Detection: Compare architecture descriptions in docs against recent GitHub changes (new services, deleted services, changed dependencies)

5. STALE RUNBOOKS:
   - Runbooks with commands that reference old paths, old hostnames, old tool versions
   - Deployment procedures that skip steps that are now required (e.g., missing feature flag check)
   - Incident response procedures that reference monitoring tools or dashboards that have been replaced
   - Database maintenance scripts that use old schema or table names
   - SSH/access instructions for servers that have been decommissioned
   Detection: Look for specific commands, URLs, hostnames, and file paths in runbooks and check if they appear in recent Slack discussions about "this doesn't work anymore" or "we changed this"

6. CHANGED SLAs AND METRICS:
   - Performance targets that have been revised (old SLA: 99.9%, new SLA: 99.95%)
   - Capacity limits that have changed (old: 10K RPM, new: 50K RPM after scaling)
   - Error budget policies that have been updated
   - Response time targets that have changed
   - On-call response time expectations that have been revised
   Detection: Look for numeric values in docs (percentages, milliseconds, request limits) and check if recent Slack/Jira discussions reference different numbers

7. OUTDATED DEPENDENCIES:
   - Documentation recommending library versions that are no longer used
   - Setup guides specifying tool versions that are incompatible with current codebase
   - Docker base images or runtime versions that have been upgraded
   - Supported browser/platform matrices that have changed
   Detection: Compare version numbers in docs against package.json, requirements.txt, Dockerfile, or recent GitHub dependency update PRs

8. DECOMMISSIONED SERVICES:
   - Documentation for services or systems that have been shut down
   - Integration docs for third-party services that are no longer used
   - Internal tools documentation for tools that have been replaced
   Detection: Look for service/system names in docs that appear in recent Jira tickets as "decommissioned," "sunset," or "migrated away from"

9. CHANGED PROCESSES:
   - Development workflow docs that don't match current GitHub branch strategy
   - Release process docs that describe old CI/CD pipeline steps
   - Code review guidelines that don't match current GitHub settings
   - Testing requirements that have been relaxed or tightened
   Detection: Compare process descriptions in docs against recent Slack discussions about process changes

10. OUTDATED CONFIGURATION:
    - Environment variable documentation with wrong default values
    - Feature flag documentation listing flags that have been removed or permanently enabled
    - Configuration file references with wrong paths or wrong formats
    Detection: Compare config references in docs against GitHub config files

11. PERSONNEL CHANGES:
    - Contact information for people who have left or changed roles
    - "Ask X for Y" references where X no longer handles Y
    - POC lists that are out of date
    Detection: Cross-reference named individuals in docs with recent activity patterns

12. INFRASTRUCTURE CHANGES:
    - Cloud resource documentation that doesn't match current infrastructure
    - Network topology docs that have been superseded by infrastructure changes
    - Monitoring/alerting setup docs that reference old tools or thresholds
    Detection: Look for infrastructure-related terms in docs and compare with recent DevOps/SRE Slack discussions

HOW TO DETECT OUTDATED CONTENT:

Step 1 — Document Inventory:
Catalog all documentation with their last-modified dates. Documents not updated in 6+ months are candidates for staleness checks.

Step 2 — Freshness Cross-Reference:
For each document, identify the TOPICS it covers. Then check recent activity (Slack, Jira, GitHub) for those topics. If recent activity shows changes that the document doesn't reflect, it's outdated.

Step 3 — Specific Signal Detection:
Look for these specific signals of staleness:
- Dates in the future that are now in the past (e.g., "migration planned for Q2 2024" — it's now past that)
- Version numbers that don't match current releases
- URLs that are likely broken (referencing old tools, old domains)
- People mentioned who are no longer active in recent Slack/Jira data
- Technology names that appear in recent "we migrated away from X" discussions
- Commands or file paths that appear in recent "this is broken/wrong" discussions

Step 4 — Impact Assessment:
CRITICAL: Stale content that could cause production incidents or data loss
- Wrong runbook commands, wrong database connection strings, wrong deployment steps
- Security procedures that don't match current security posture

HIGH: Stale content that causes significant confusion or wasted time
- Architecture docs that misrepresent current system design
- Ownership docs that point to the wrong people for escalations
- Process docs that describe steps no longer valid

MEDIUM: Stale content that is misleading but unlikely to cause direct harm
- Old feature descriptions that are slightly inaccurate
- Team structure docs that are partially outdated
- Performance targets that have changed

LOW: Stale content with minimal impact
- Cosmetic information (old branding, old logos)
- Historical references that are technically wrong but not actionable
- Minor version discrepancies

FOR EACH OUTDATED DOCUMENT:

1. documentTitle: The document's title
2. documentSource: Where the document lives (Confluence space, repo, etc.)
3. documentId: Unique identifier for the document
4. severity: Using the framework above

5. outdatedItems: An array of SPECIFIC items within the document that are outdated. For each:
   - whatIsOutdated: What specifically is wrong (e.g., "The listed database host is db-old.internal.company.com")
   - exactQuoteOrSection: The exact text or section from the document that needs updating
   - sectionReference: Which section/heading of the document contains the outdated info
   - currentReality: What the correct, current information is based on recent evidence
   - evidenceSources: The specific recent sources that show the updated reality, with excerpts and timestamps

6. suggestedUpdate: A concrete suggestion for how to update the document. Not "update the architecture section" but "Replace the architecture diagram description: change 'PostgreSQL primary-replica' to 'CockroachDB multi-region cluster' as per the Q3 migration (see JIRA-456)"

7. verificationQuestions: Questions to confirm the update before applying, with who to ask and why

8. outdatedCategory: One of the categories defined above

9. lastKnownUpdateDate: When the document was last modified (if available)

10. staleSinceDays: Estimated number of days since the document became outdated (based on when the contradicting evidence first appeared)

OUTPUT FORMAT:
Return a JSON array of OutdatedDoc objects.
Order by severity (critical first), then by staleSinceDays (longest-stale first within same severity).

IMPORTANT CONSTRAINTS:
- Do NOT flag documents as outdated without evidence from a NEWER source showing the change
- A document being old is NOT sufficient — it must ALSO be inaccurate. A 2-year-old doc that is still correct is not outdated.
- EVERY outdatedItem MUST have at least one evidence source with excerpt that proves the content has changed
- Do NOT flag intentional historical records as outdated (e.g., a post-mortem from 2023 describing the system state AT THAT TIME is not "outdated" — it's a historical record)
- Do NOT fabricate evidence. Every citation must reference real data from the provided sources.
- Be SPECIFIC about what needs to change. "This doc is outdated" is not useful. "Line 3 of the Prerequisites section says 'Install Node 16' but the project now requires Node 20 (see package.json engines field updated in PR #452)" IS useful.
- Distinguish between "definitely outdated" and "possibly outdated" — mark uncertain items with "[NEEDS VERIFICATION]"`;

  const prompt = `Analyze the following documentation and recent activity to find outdated content — documents that were once accurate but no longer reflect the current state of the codebase, team, or processes.

ALL DOCUMENTATION AND KNOWLEDGE BASE CONTENT:
${allDocsSummary}

RECENT ACTIVITY (Slack discussions, Jira updates, GitHub changes, customer feedback — last 90 days):
${recentActivitySummary}

Instructions:
1. Build an inventory of ALL documents, noting their last-modified dates and the topics they cover.
2. For each document, scan the recent activity for evidence that the document's content has been superseded:
   a. Has the technology/tool/service described been changed or replaced?
   b. Have the people/teams/ownership described changed?
   c. Have the processes/workflows described been updated?
   d. Have the metrics/SLAs/thresholds described been revised?
   e. Have the configurations/paths/commands described been modified?
3. For documents not updated in 6+ months, apply extra scrutiny — but do NOT flag them as outdated unless you find specific evidence of inaccuracy.
4. For each outdated finding, gather ALL supporting evidence before creating the entry.
5. Prioritize findings that could cause operational issues:
   - Stale runbooks with wrong commands (CRITICAL)
   - Wrong ownership leading to delayed incident response (CRITICAL)
   - Architecture docs that mislead engineers (HIGH)
   - Process docs that cause wasted effort (HIGH)
   - Feature docs that mislead customers (HIGH)
6. Group multiple outdated items within the same document into a single OutdatedDoc entry with multiple outdatedItems.

Return your findings as a JSON array of OutdatedDoc objects.`;

  return { system, prompt };
}
