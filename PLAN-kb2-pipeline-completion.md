# KB2 Pipeline Completion Plan

## Context & Goal

The KB2 pipeline is a 15-step knowledge base construction system that processes company data (Confluence, Jira, Slack, GitHub PRs, customer feedback) into a structured knowledge graph with entity pages, human pages, how-to guides, and verification cards.

**The pipeline currently works end-to-end (steps 1–15) and produces good results.** However, a completeness audit revealed gaps in entity attributes, missing graph connectivity for discovery nodes, and fragmented decisions that should be consolidated into company-wide conventions.

**The goal is to insert 3 new steps (9, 10, 11) and fix 2 existing steps (4, 8) so that by the time the generation steps begin (Page Plan onward), every entity has uniform, complete attributes and full graph connectivity.**

The ground truth data lives in `ground-truth/` and describes PawFinder, a pet adoption website built by a 6-person team (Matt, Sarah, Tim, Kim, Jack, Jill). There are 21 projects, 16 decisions (3 hidden cross-cutting patterns), 9 processes, 6 team members, 34 Jira tickets, 16 PRs, 6 Confluence docs, and 6 customer feedback submissions.

---

## Current Pipeline Architecture

### Registration

Steps are registered in `src/application/workers/kb2/register-steps.ts`:

```
P1.1   Input Snapshot              → inputSnapshotStep
P1.2   Embed Documents             → embedDocumentsStep
P1.3   Entity Extraction           → entityExtractionStep
P1.4   Extraction Validation       → extractionValidationStep
P1.5   Entity Resolution           → entityResolutionStep
P1.6   Graph Build                 → graphBuildStep
P1.7   Graph Enrichment            → graphEnrichmentStep
P1.8   Project & Ticket Discovery  → discoveryStep
P1.9   Page Plan                   → pagePlanStep
P1.10  GraphRAG Retrieval          → graphragRetrievalStep
P1.11  Generate Entity Pages       → generateEntityPagesStep
P1.12  Generate Human Pages        → generateHumanPagesStep
P1.13  Generate How-To Guides      → generateHowtoStep
P1.14  Extract Claims              → extractClaimsStep
P1.15  Create Verify Cards         → createVerifyCardsStep
```

### Pipeline Runner

File: `src/application/workers/kb2/pipeline-runner.ts` (352 lines)

Key interfaces:
- `StepContext` — passed to every step function, contains `runId`, `executionId`, `companySlug`, `onProgress`, `logLLMCall`, `getStepArtifact`, `getStepExecutionId`, `signal`
- `execution_id` — a `randomUUID()` generated per step execution (not per pipeline run)
- `getStepArtifact(pass, stepNumber)` — returns the `artifact` from the latest completed execution of that step
- `getStepExecutionId(pass, stepNumber)` — returns the `execution_id` of the latest completed execution of that step

Steps read upstream data via `ctx.getStepExecutionId("pass1", N)` and filter by `execution_id` (falling back to `run_id` for backward compatibility).

### Data Model

File: `src/entities/models/kb2-types.ts` (378 lines)

Graph node schema (`KB2GraphNode`):
```typescript
{
  node_id: string,
  run_id: string,
  execution_id: string (optional),
  type: KB2NodeTypeEnum,       // team_member, project, decision, process, ticket, pull_request, library, repository, etc.
  display_name: string,
  aliases: string[],
  attributes: Record<string, any>,  // freeform — this is where status, documentation_level, etc. live
  source_refs: KB2EvidenceRef[],
  truth_status: "direct" | "inferred" | "human_asserted",
  confidence: "high" | "medium" | "low"
}
```

Graph edge schema (`KB2GraphEdge`):
```typescript
{
  edge_id: string,
  run_id: string,
  execution_id: string (optional),
  source_node_id: string,
  target_node_id: string,
  type: KB2EdgeTypeEnum,       // OWNED_BY, DEPENDS_ON, MENTIONED_IN, RELATED_TO, USES, CONTAINS, etc.
  weight: number,
  evidence: string (optional)
}
```

### MongoDB Collections

All use tenant-scoped collections via `getTenantCollections(companySlug)`:
- `kb2_runs` — pipeline run metadata
- `kb2_run_steps` — per-step execution metadata, progress_log, artifact
- `kb2_raw_inputs` — raw company data
- `input_snapshots` — parsed documents (step 1 output)
- `graph_nodes` — entities (steps 3, 4, 5, 8 write here)
- `graph_edges` — relationships (steps 6, 7 write here)
- `kb2_embeddings` — Qdrant vector store (step 2)
- `entity_pages`, `human_pages`, `howto`, `claims`, `verification_cards` — downstream generation outputs
- `kb2_tickets` — synced tickets from page plan

---

## Completeness Audit Results

A full audit of the latest pipeline run revealed these issues:

### Entity Attribute Gaps

| Entity Type | Issue | Details |
|---|---|---|
| `project` (57 nodes) | Missing `status` | 8 nodes have no status at all |
| `project` | Missing `documentation_level` | 8 nodes |
| `project` | No public `description` | 46 nodes use internal `_description` only |
| `ticket` (35 nodes) | No public `description` | 34 use `_description` only |
| `decision` (33 nodes) | Missing `decided_by` | 9 nodes |
| `decision` | Missing `rationale` | 6 nodes |
| `decision` | Missing `scope` | 1 node |
| `process` (10 nodes) | Uses `process_status` instead of `status` | All 10 have `process_status`, NOT `status` |
| `library`, `repository`, `team_member`, `integration`, etc. | Zero public attributes | Only internal `_description`, `_reasoning` |

### Step 8 Discovery Nodes (32 nodes)

Step 8 creates new nodes but they are **completely bare**:
- 0 edges (Steps 6-7 ran before Step 8)
- No `status` field
- No `documentation_level` field
- No `_status_reasoning` or `_source_coverage`
- Only attributes set: `discovery_category`, `description`, `related_entities`

### Edge Issues

- **490 dangling MENTIONED_IN edges** from Step 6 — `target_node_id` contains document index strings instead of actual node IDs. These are broken and redundant (entities already have `source_refs`).
- Step 7 edges are all valid (entity-to-entity with evidence).

### Fragmented Decisions

The ground truth has 3 "hidden patterns" that are cross-cutting conventions:
1. **Kim's Color Convention** — pink/blue for gender, green for money CTAs (spans 10 sources over 2 years)
2. **Tim's Layout Convention** — vertical sidebar for selection, horizontal columns for comparison (spans 7 sources)
3. **Matt's Client-Side Browse Pattern** — load-all for <20 items, client-side navigation (spans 6 PRs)

Currently, these exist as **individual decision entities per page** ("Use pink/blue on pet cards", "Use green for donate button", etc.). There is no consolidated convention entity that ties them together. This is the biggest gap for demo value.

---

## Target Pipeline (After Changes)

```
P1.1   Input Snapshot              → inputSnapshotStep
P1.2   Embed Documents             → embedDocumentsStep
P1.3   Entity Extraction           → entityExtractionStep
P1.4   Extraction Validation       → extractionValidationStep        ← FIX
P1.5   Entity Resolution           → entityResolutionStep
P1.6   Graph Build                 → graphBuildStep
P1.7   Graph Enrichment            → graphEnrichmentStep
P1.8   Project & Ticket Discovery  → discoveryStep                   ← FIX
P1.9   Attribute Completion        → attributeCompletionStep         ← NEW
P1.10  Pattern Synthesis           → patternSynthesisStep            ← NEW
P1.11  Graph Re-enrichment         → graphReEnrichmentStep           ← NEW
P1.12  Page Plan                   → pagePlanStep                    (was 9)
P1.13  GraphRAG Retrieval          → graphragRetrievalStep           (was 10)
P1.14  Generate Entity Pages       → generateEntityPagesStep         (was 11)
P1.15  Generate Human Pages        → generateHumanPagesStep          (was 12)
P1.16  Generate How-To Guides      → generateHowtoStep               (was 13)
P1.17  Extract Claims              → extractClaimsStep                (was 14)
P1.18  Create Verify Cards         → createVerifyCardsStep            (was 15)
```

---

## Implementation Items

### Item 1: Fix Step 4 — Rename `process_status` to `status`

**File:** `src/application/workers/kb2/pass1/extraction-validation.ts`

**What to change:**

1. In `validateAndBackfillAttributes()` (around line 377-381): Change `attrs.process_status` → `attrs.status` and `patch.process_status` → `patch.status`. Change the field name in the `issues.push()` call from `"process_status"` to `"status"`.

2. In `collectLLMInferenceTargets()` (around line 297): Change the check for `issue.field === "process_status"` to `issue.field === "status"`.

3. In the LLM inference results application (around line 689+): Where it applies `process_status` from LLM results back to the node, store it as `attributes.status` instead of `attributes.process_status`.

4. In `ATTRIBUTE_INFERENCE_PROMPT` (lines 245-278): Update "PROCESS STATUS" section to tell the LLM to return `status` instead of `process_status`. The allowed values (`active`, `deprecated`, `proposed`, `informal`) stay the same.

5. In `AttributeInferenceSchema` (around line 230): Change the field name from `process_status` to `status` (or keep accepting both and normalizing — simpler to just rename).

6. The `VALID_PROCESS_STATUS` set (line ~227) stays the same values, but make sure the prompt and schema both say `status`.

**Why:** Having two different field names (`status` for projects, `process_status` for processes) makes downstream code fragile. A single `status` field with type-specific allowed values is cleaner.

### Item 2: Fix Step 4 — Normalize status vocabulary

**File:** `src/application/workers/kb2/pass1/extraction-validation.ts`

**What to change:**

1. In `VALID_PROJECT_STATUS` set: Remove `"planned"`, keep `active`, `completed`, `proposed`. Map any existing `"planned"` → `"proposed"` during validation.

2. In `ATTRIBUTE_INFERENCE_PROMPT`: Update "PROJECT STATUS" section to say allowed values are `active`, `completed`, `proposed` (drop `planned`). Explain: "`proposed` = discussed but not started, `active` = work in progress, `completed` = all work done."

3. Add a normalization pass in `validateAndBackfillAttributes()`: If `attrs.status === "planned"`, set it to `"proposed"` and log an issue.

**Why:** Ground truth uses `proposed` for future work and `active` for in-progress. Having both `planned` and `proposed` creates ambiguity. The status vocabulary becomes: `proposed` → `active` → `completed` (for projects) and `proposed` → `active` → `deprecated` / `informal` (for processes).

### Item 3: Fix Step 4 UI — Source highlight check

**File:** `components/pidrax/kb2/KB2AdminPage.tsx`

**What to change:**

In the `ExtractionValidationViewer` component, add a check similar to the "no highlight" check but for sources: iterate over all entity cards, check if each entity has at least one `source_ref` that successfully maps to a document in the input snapshot. Show a count like "N entities with broken sources" and add a "Recheck Sources" button.

Currently some entities show crossed-out sources in the UI because the `source_ref.title` doesn't match any document title exactly. The check should verify whether the reference actually resolves.

**Why:** User reported "all sources crossed out" for some entities, indicating a mismatch in source reference titles vs. actual document titles. Having a visible check helps the user verify data quality before proceeding.

### Item 4: Fix Step 8 — Add cross-batch deduplication

**File:** `src/application/workers/kb2/pass1/discovery.ts`

**Current problem:** Step 8 processes documents in batches. Each batch independently calls the LLM. If the "Toy Donation Feature" appears in 3 customer feedback submissions across 2 different batches, the LLM discovers it twice. The only dedup is against *existing* entities (from Step 5), not against discoveries from *earlier batches in the same run*.

**What to change:**

After the batch loop completes and before the `existingNames` filter (around line 135-136), add an internal deduplication pass:

```typescript
// Deduplicate discoveries from within this run
const seenDiscoveries = new Map<string, typeof allDiscoveries[0]>();
for (const d of allDiscoveries) {
  const key = d.display_name.toLowerCase().trim();
  if (!seenDiscoveries.has(key)) {
    seenDiscoveries.set(key, d);
  } else {
    // Merge evidence: keep the one with higher confidence, combine evidence text
    const existing = seenDiscoveries.get(key)!;
    existing.evidence = `${existing.evidence}\n\nAdditional evidence: ${d.evidence}`;
    if (d.confidence === "high" || (d.confidence === "medium" && existing.confidence === "low")) {
      existing.confidence = d.confidence;
    }
    existing.related_entities = [...new Set([...existing.related_entities, ...d.related_entities])];
  }
}
const dedupedDiscoveries = [...seenDiscoveries.values()];
```

Then use `dedupedDiscoveries` instead of `allDiscoveries` for the `existingNames` filter.

**Also update the existing entity list per batch:** Currently, each batch gets the same `existingEntityList`. After each batch, append the new discoveries to the entity list so later batches know not to re-discover them:

```typescript
let runningEntityList = existingEntityList;
for (let i = 0; i < conversationDocs.length; i += BATCH_SIZE) {
  // ... existing batch processing ...
  const discoveries = Array.isArray(result?.discoveries) ? result.discoveries : [];
  allDiscoveries.push(...discoveries);
  // Append to running list so next batch doesn't re-discover
  for (const d of discoveries) {
    runningEntityList += `\n- ${d.display_name} [${d.type}]`;
  }
}
```

### Item 5: Fix Step 8 — Better prompt and noise reduction

**File:** `src/application/workers/kb2/pass1/discovery.ts`

**What to change:**

1. Update `DISCOVERY_PROMPT` to add stronger guidance:
   - "A 'project' is a multi-ticket initiative or feature with a defined scope. One-off bug fixes, dependency updates, and maintenance tasks are NOT projects — they are tickets at most."
   - "Do NOT create a discovery for work that is just a single Jira ticket — that's already tracked."
   - "For customer feedback: only create a proposed project/ticket if the same theme appears in 2+ submissions OR if the request describes a feature with clear scope."

2. Set `status` and `documentation_level` on new nodes at creation time (lines 141-164). Currently only `discovery_category`, `description`, and `related_entities` are set. Add:
   ```typescript
   attributes: {
     discovery_category: disc.category,
     description: disc.description,
     related_entities: disc.related_entities,
     status: disc.category.startsWith("past_") ? "completed" :
             disc.category.startsWith("ongoing_") ? "active" : "proposed",
     documentation_level: "undocumented",
   }
   ```

**Why:** Maintenance tasks like "date-fns Vulnerability Patch" were being classified as projects. Also, Step 8 nodes were created without `status` or `documentation_level`, making them incomplete for downstream steps.

### Item 6: New Step 9 — Attribute Completion

**New file:** `src/application/workers/kb2/pass1/attribute-completion.ts`

**Purpose:** Fill all remaining attribute gaps across ALL entities (from Steps 5 and 8) so that every entity has a uniform, complete set of public attributes.

**What it does:**

1. **Read all nodes** from Step 5 (entity resolution output) and Step 8 (discovery output) by their respective `execution_id`s.

2. **Promote `_description` to `description`:** For every node that has `attributes._description` but no `attributes.description`, copy `_description` → `description`. This affects ~80+ entities (projects, tickets, libraries, repositories, team_members, etc.).

3. **Fill missing `status`:** For project nodes from Step 8 that still lack `status`, run LLM inference with source excerpts (same approach as Step 4 but for these specific nodes).

4. **Fill missing `documentation_level`:** For any entity (from Steps 5 or 8) missing `documentation_level`, compute it from `source_refs` using the same `computeSourceCoverage` heuristic from Step 4.

5. **Fix incorrect `decided_by` on decisions:** Read all decision entities. For each, check if the `decided_by` person is actually the one who *made* the decision (vs. just *mentioned* it). Run a targeted LLM call with the full source excerpts asking: "Who MADE this decision? Not who mentioned it or reviewed it." Update if LLM returns a different person with high confidence.

6. **Fill `rationale` and `scope` gaps** on remaining decisions.

7. **Ensure uniform public attributes per type:** After all fills, check that every entity of a given type has the same set of public (non-`_` prefixed) attributes. For any entity missing a field that its type-peers have, set it to `null` or a type-appropriate default.

**Output artifact:**
```typescript
{
  total_entities_processed: number,
  descriptions_promoted: number,
  statuses_filled: number,
  doc_levels_filled: number,
  decided_by_fixed: number,
  rationales_filled: number,
  llm_calls: number
}
```

**Data flow:** Reads from `graph_nodes` (Steps 5 and 8 execution_ids). Writes updates to existing nodes via `bulkWrite` (does NOT create new nodes). Uses its own `execution_id` for the `run_steps` record but updates nodes in-place.

**Important:** This step updates nodes from BOTH Step 5 and Step 8. It should update nodes in-place (using `updateOne` with `node_id` filter) rather than cloning them, since the nodes are already in their final `execution_id` from their respective steps. Alternatively, if you want immutability, clone all nodes under this step's `execution_id` — but then downstream steps must read from Step 9's `execution_id` instead of Step 5's. The simpler approach is in-place updates.

### Item 7: New Step 10 — Pattern Synthesis

**New file:** `src/application/workers/kb2/pass1/pattern-synthesis.ts`

**Purpose:** Identify cross-cutting conventions from individual decision entities. This is the most important step for demo value.

**What it does:**

1. **Read all decision entities** from `graph_nodes` (use Step 5's `execution_id` since Step 9 may have updated them in-place).

2. **Read all source documents** from `input_snapshots` (Step 1's `execution_id`).

3. **Call LLM with all decisions + source context.** Prompt:

   ```
   You are analyzing a set of company decisions to identify CROSS-CUTTING CONVENTIONS —
   recurring patterns where the same person or team makes the same TYPE of choice
   across multiple features over time.

   A convention is NOT a single decision. It is a PATTERN that appears when you look at
   3+ decisions together and realize they follow the same rule.

   Examples of what we're looking for:
   - A designer who always uses the same color scheme (green = money, blue = navigation)
     across 5+ different pages over 2 years
   - An architect who always recommends the same data-loading pattern (load-all for small
     lists) across 4+ PRs
   - A developer who always uses the same layout approach (vertical sidebar for selection)
     across 3+ features

   For each convention, provide:
   - convention_name: A descriptive name (e.g. "Gender-Color and Money-Color UI Convention")
   - summary: One paragraph describing the pattern
   - pattern_rule: The generalizable rule (e.g. "Green CTAs for financial actions,
     blue for non-financial, pink/blue for gender indicators")
   - established_by: Who consistently applies this pattern
   - constituent_decisions: List of decision entity names that are instances of this convention
   - combined_evidence: Key quotes from sources proving the pattern
   - source_documents: List of source document titles where evidence appears
   - confidence: high/medium/low
   ```

4. **Create convention entities** as new `graph_nodes`:
   ```typescript
   {
     node_id: randomUUID(),
     run_id: ctx.runId,
     execution_id: ctx.executionId,
     type: "decision",
     display_name: convention.convention_name,
     aliases: [],
     attributes: {
       is_convention: true,
       pattern_rule: convention.pattern_rule,
       summary: convention.summary,
       established_by: convention.established_by,
       constituent_decisions: convention.constituent_decisions,
       status: "decided",
       documentation_level: "undocumented", // or computed from source coverage
       description: convention.summary,
     },
     source_refs: [...], // Combined from all constituent decisions
     truth_status: "inferred",
     confidence: convention.confidence,
   }
   ```

5. **Do NOT delete or modify existing decision entities.** The individual decisions stay as-is. The convention entity is a new "meta-decision" that references them.

**Output artifact:**
```typescript
{
  conventions_found: number,
  total_decisions_analyzed: number,
  llm_calls: number,
  conventions: Array<{
    convention_name: string,
    established_by: string,
    constituent_decisions: string[],
    confidence: string,
  }>
}
```

**Expected output for PawFinder:** Should discover 3 conventions:
1. Kim's Color Convention (constituent: 4-6 individual color decisions)
2. Tim's Layout Convention (constituent: 3-5 individual layout decisions)
3. Matt's Client-Side Browse Pattern (constituent: 3-5 individual loading decisions)

### Item 8: New Step 11 — Graph Re-enrichment

**New file:** `src/application/workers/kb2/pass1/graph-re-enrichment.ts`

**Purpose:** Connect Step 8 discovery nodes and Step 10 convention entities into the existing graph.

**What it does:**

1. **Read all nodes** (from Steps 5, 8, and 10) and **all existing edges** (from Steps 6 and 7).

2. **Connect discovery nodes (Step 8) to existing entities:**
   - Each discovery node has `attributes.related_entities` (an array of entity names).
   - For each related entity name, find the matching node by `display_name` and create a `RELATED_TO` edge.
   - Also check for `MENTIONED_IN` relationships by scanning source documents.

3. **Connect convention entities (Step 10) to constituent decisions:**
   - Each convention has `attributes.constituent_decisions` (array of decision names).
   - Create `CONTAINS` edges from convention → each constituent decision.

4. **Connect conventions to team members:**
   - Each convention has `attributes.established_by` (person name).
   - Find matching `team_member` node, create `PROPOSED_BY` edge from convention → team member.

5. **Connect proposed features to relevant conventions:**
   - For proposed projects/tickets (from Step 8), use LLM to determine which conventions are relevant.
   - Create `APPLIES_TO` edges from convention → proposed feature.
   - This is critical for the How-To step: when generating "How to implement Toy Donation Feature," the system can follow `APPLIES_TO` edges to find Kim's color convention, Tim's layout convention, and Matt's browse pattern.

6. **All new edges** get `execution_id: ctx.executionId`, `run_id: ctx.runId`, and appropriate `evidence` strings.

**Output artifact:**
```typescript
{
  discovery_edges_added: number,
  convention_edges_added: number,
  applies_to_edges_added: number,
  total_new_edges: number,
  llm_calls: number
}
```

### Item 9: Update register-steps.ts

**File:** `src/application/workers/kb2/register-steps.ts`

**What to change:**

1. Import the 3 new step functions.
2. Insert them after Step 8:
   ```typescript
   registerPass1Step("Attribute Completion", attributeCompletionStep);   // P1.9
   registerPass1Step("Pattern Synthesis", patternSynthesisStep);         // P1.10
   registerPass1Step("Graph Re-enrichment", graphReEnrichmentStep);      // P1.11
   ```
3. The existing steps 9-15 automatically become 12-18 because `registerPass1Step` uses array index. No comment changes needed (but update comments if present).

### Item 10: Update downstream step references

All downstream steps that reference `getStepArtifact("pass1", N)` or `getStepExecutionId("pass1", N)` need their step numbers updated:

| Old Step # | New Step # | File |
|---|---|---|
| Step 5 nodes | Step 5 (unchanged) | `graph-build.ts`, `graph-enrichment.ts`, `discovery.ts`, `page-plan.ts`, etc. |
| Step 6 edges | Step 6 (unchanged) | `graph-enrichment.ts` |
| Step 9 page plan | Step 12 page plan | `graphrag-retrieval.ts` (reads step 9 artifact → now step 12) |
| Step 10 retrieval | Step 13 retrieval | `generate-entity-pages.ts` (reads step 10 → now step 13) |
| Step 11 entity pages | Step 14 entity pages | `generate-human-pages.ts`, `extract-claims.ts` (reads step 11 → now step 14) |
| Step 12 human pages | Step 15 human pages | `extract-claims.ts` (reads step 12 → now step 15) |

**Critical:** The `getStepArtifact` and `getStepExecutionId` calls use **step number** (position in the registered array). When you insert 3 steps after position 8, all subsequent step numbers shift by +3. You MUST update every hardcoded step number reference in steps 9+ (now 12+).

Search for patterns like:
- `getStepArtifact("pass1", 9)` → change to `getStepArtifact("pass1", 12)`
- `getStepExecutionId("pass1", 1)` → stays the same (step 1-8 don't move)
- `getStepExecutionId("pass1", 5)` → stays the same
- `getStepExecutionId("pass1", 9)` → change to `getStepExecutionId("pass1", 12)`

Also update any hardcoded `stepId` strings like `"pass1-step-9"` → `"pass1-step-12"`.

### Item 11: Update KB2AdminPage.tsx viewers

**File:** `components/pidrax/kb2/KB2AdminPage.tsx`

**What to change:**

1. Add viewers for the 3 new steps:
   - **Step 9 (Attribute Completion):** Summary cards showing counts (descriptions promoted, statuses filled, decided_by fixed). List of entities that were updated with before/after values.
   - **Step 10 (Pattern Synthesis):** Show discovered conventions as expandable cards. Each card shows: convention name, established_by, pattern_rule, constituent decisions list, combined evidence. This is the highest-demo-value viewer.
   - **Step 11 (Graph Re-enrichment):** Summary cards (discovery edges, convention edges, applies_to edges). List of new edges with expandable evidence.

2. The existing step viewers (Page Plan through Verify Cards) don't need changes beyond their step number references (which are handled by the pipeline runner, not hardcoded in the UI — the UI uses step names, not numbers).

---

## Implementation Order

**Phase 1 — Quick fixes to existing steps (Items 1-3):**
1. Item 1: Fix Step 4 `process_status` → `status`
2. Item 2: Fix Step 4 status vocabulary (`planned` → `proposed`)
3. Item 3: Fix Step 4 UI source highlight check

**Phase 2 — Fix Step 8 (Items 4-5):**
4. Item 4: Add cross-batch deduplication to Step 8
5. Item 5: Better prompt + set status/doc_level on Step 8 nodes

**Phase 3 — New steps (Items 6-8):**
6. Item 6: Create Step 9 (Attribute Completion)
7. Item 7: Create Step 10 (Pattern Synthesis)
8. Item 8: Create Step 11 (Graph Re-enrichment)

**Phase 4 — Wiring (Items 9-11):**
9.  Item 9: Update register-steps.ts
10. Item 10: Update downstream step number references
11. Item 11: Add UI viewers for new steps

**Phase 5 — Test:**
12. Run the full pipeline from Step 1
13. Verify entities have uniform attributes
14. Verify conventions are discovered
15. Verify graph connectivity for discovery and convention nodes
16. Compare results against ground truth

---

## Key Files Reference

| File | Lines | Role |
|---|---|---|
| `src/application/workers/kb2/pipeline-runner.ts` | 352 | Orchestrator, StepContext, execution_id generation |
| `src/application/workers/kb2/register-steps.ts` | ~55 | Step registration (determines step numbers) |
| `src/entities/models/kb2-types.ts` | 378 | Zod schemas for nodes, edges, runs |
| `src/application/workers/kb2/pass1/extraction-validation.ts` | 846 | Step 4 — attribute validation, LLM inference |
| `src/application/workers/kb2/pass1/entity-resolution.ts` | 383 | Step 5 — merge duplicate entities |
| `src/application/workers/kb2/pass1/graph-build.ts` | 107 | Step 6 — build edges from relationships + MENTIONED_IN |
| `src/application/workers/kb2/pass1/graph-enrichment.ts` | 166 | Step 7 — LLM-inferred entity-to-entity edges |
| `src/application/workers/kb2/pass1/discovery.ts` | 193 | Step 8 — discover undocumented projects/tickets |
| `src/application/workers/kb2/pass1/page-plan.ts` | 282 | Step 9 (→12) — plan entity and human pages |
| `src/application/workers/kb2/pass1/graphrag-retrieval.ts` | ~200 | Step 10 (→13) — retrieve context for page generation |
| `src/application/workers/kb2/pass1/generate-entity-pages.ts` | ~200 | Step 11 (→14) — generate entity page content |
| `src/application/workers/kb2/pass1/generate-human-pages.ts` | ~200 | Step 12 (→15) — generate human-readable topic pages |
| `src/application/workers/kb2/pass1/generate-howto.ts` | ~200 | Step 13 (→16) — generate how-to guides for proposed features |
| `src/application/workers/kb2/pass1/extract-claims.ts` | ~200 | Step 14 (→17) — extract verifiable claims from pages |
| `src/application/workers/kb2/pass1/create-verify-cards.ts` | ~200 | Step 15 (→18) — create human verification cards |
| `components/pidrax/kb2/KB2AdminPage.tsx` | ~6000 | Main admin UI — step workbench, result viewers |
| `app/api/[companySlug]/kb2/route.ts` | ~400 | API routes for KB2 data |
| `lib/mongodb.ts` | ~100 | MongoDB connection and tenant collections |
| `lib/utils.ts` | ~150 | PrefixLogger, normalizeForMatch |

---

## Conventions to Follow

1. **Every step** must accept `StepFunction` type and use `ctx.executionId` for all writes.
2. **Reading upstream data:** Use `ctx.getStepExecutionId("pass1", N)` to get the execution_id of the latest completed upstream step, then filter by it. Fallback to `run_id` if null.
3. **Progress reporting:** Use `ctx.onProgress(message, percent)` where percent is 0-100 for internal step progress. The pipeline runner wraps this into global progress.
4. **LLM calls:** Use `structuredGenerate()` with Zod schemas. Log via `ctx.logLLMCall(stepId, modelName, prompt, response, inTokens, outTokens, cost, durationMs)`.
5. **Artifacts:** Return an object from the step function. It gets stored as `artifact` in `kb2_run_steps`.
6. **Collections:** Use `getTenantCollections(ctx.companySlug)` — never hardcode collection names.
7. **Cancellation:** Check `ctx.signal.aborted` in loops.
8. **Models:** Use `getFastModel()` for fast tasks, `getCrossCheckModel()` for validation/inference, `getReasoningModel()` for complex reasoning.

---

## Success Criteria

After all changes, a full pipeline run should produce:

1. **Every entity** has `status`, `documentation_level`, and `description` as public attributes (no `_description` without `description`).
2. **Every process** uses `status` (not `process_status`).
3. **Every decision** has `decided_by`, `rationale`, and `scope` filled (or explicitly null with reasoning).
4. **3 convention entities** exist: Kim's colors, Tim's layouts, Matt's browse pattern.
5. **Convention entities** are connected to constituent decisions via `CONTAINS` edges.
6. **Convention entities** are connected to team members via `PROPOSED_BY` edges.
7. **Convention entities** are connected to proposed features (Toy Donation) via `APPLIES_TO` edges.
8. **Step 8 discovery nodes** have edges connecting them to related existing entities.
9. **No fragmented duplicate discoveries** (e.g., one "Toy Donation Feature" instead of three).
10. **The How-To step** (now Step 16) can follow graph edges from "Toy Donation Feature" → `APPLIES_TO` → Kim's Color Convention, Tim's Layout Convention, Matt's Browse Pattern, and use those conventions' `pattern_rule` to write implementation guidance.
