# KB2 Pipeline — Page Generation & Downstream Fixes

## Prerequisites

This plan assumes `PLAN-kb2-pipeline-completion.md` (Items 1–11) has been fully implemented. Specifically:

- Steps 1–8 are fixed (Step 4 status normalization, Step 8 dedup/prompt fixes)
- Steps 9 (Attribute Completion), 10 (Pattern Synthesis), 11 (Graph Re-enrichment) are created and registered
- `register-steps.ts` now has 18 Pass 1 steps
- The full pipeline has been run at least once with the new steps

After the first plan, the step numbering is:

```
P1.1   Input Snapshot
P1.2   Embed Documents
P1.3   Entity Extraction
P1.4   Extraction Validation
P1.5   Entity Resolution
P1.6   Graph Build
P1.7   Graph Enrichment
P1.8   Project & Ticket Discovery
P1.9   Attribute Completion          ← NEW
P1.10  Pattern Synthesis             ← NEW
P1.11  Graph Re-enrichment           ← NEW
P1.12  Page Plan                     ← was 9
P1.13  GraphRAG Retrieval            ← was 10
P1.14  Generate Entity Pages         ← was 11
P1.15  Generate Human Pages          ← was 12
P1.16  Generate How-To Guides        ← was 13
P1.17  Extract Claims                ← was 14
P1.18  Create Verify Cards           ← was 15
```

---

## Item 1: Add `APPLIES_TO` and `PROPOSED_BY` to edge type enum

**File:** `src/entities/models/kb2-types.ts`
**Line:** 25–43

**Current:**
```typescript
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
```

**Change:** Add two entries:
```typescript
  "APPLIES_TO",
  "PROPOSED_BY",
```

**Why:** Step 11 (Graph Re-enrichment) from the first plan creates `APPLIES_TO` edges (convention → proposed feature) and `PROPOSED_BY` edges (convention → team member). Without these in the Zod enum, edge creation will fail validation. Also, Step 7 (Graph Enrichment) uses the enum in its prompt to list valid edge types — adding these means it can also create these edge types if appropriate.

**IMPORTANT:** This item should actually be done as part of the first plan (before Step 11 is implemented). It is listed here as a reminder in case it was missed.

---

## Item 2: Add "Hidden Conventions" human page category

**File:** `src/entities/models/kb2-templates.ts`
**Line:** ~278 (inside `STANDARD_HUMAN_PAGES` array)

**Add this entry** after the `decisions_tradeoffs` entry:
```typescript
{ category: "hidden_conventions", layer: "engineering", title: "Hidden Conventions & Patterns", description: "Cross-cutting conventions discovered from repeated behavior — design patterns, architecture patterns, and team conventions that were never formally documented", relatedEntityTypes: ["decision", "team_member"] },
```

**Why:** Convention entities (type `decision`, `attributes.is_convention === true`) are created by Step 10 (Pattern Synthesis). Without this human page category, conventions only appear on "Other Decisions & Tradeoffs" alongside 30+ regular decisions, burying the most demo-valuable content. This dedicated page:
- Pulls in `decision` entities (conventions are type `decision`) AND `team_member` entities
- The human page generation LLM will have both conventions and the people who established them, letting it write narrative like: "Kim consistently uses pink/blue for gender and green for money CTAs across all pet-facing pages..."
- This is the highest-demo-value page in the entire KB

**Also needed:** The `generate-human-pages.ts` step filters decisions for the decisions_tradeoffs page. It does NOT currently filter by `is_convention`. For the new `hidden_conventions` page, it will include ALL decision entities. The LLM will need prompt guidance to focus on convention entities. Two options:

**(A) Simple — No code change:** The LLM receives all decision entity pages and all team_member entity pages for this human page. Convention entity pages will have `pattern_rule`, `constituent_decisions`, and `established_by` in their content (from the entity page generation step). Regular decision entity pages won't. The LLM should naturally emphasize conventions because their content is about patterns, not individual choices. This will likely work.

**(B) Robust — Small code change in `generate-human-pages.ts`:** When building `relatedPages` for the `hidden_conventions` category, filter entity pages to only include those whose underlying node has `attributes.is_convention === true`, plus all `team_member` pages. This requires reading node attributes during human page generation — currently it only reads `discovery_category`. Add:
```typescript
if (hpDef.category === "hidden_conventions") {
  relatedPages = relatedPages.filter(ep => {
    const node = nodeById.get(ep.node_id);
    return node?.type === "team_member" || node?.attributes?.is_convention === true;
  });
}
```

**Recommendation:** Start with option A. If the generated page is noisy (mixing individual decisions with conventions), implement option B.

---

## Item 3: Update step number references in Page Plan

**File:** `src/application/workers/kb2/pass1/page-plan.ts`

**Changes:**

| Line | Current | New | Reason |
|------|---------|-----|--------|
| 228 | `getStepExecutionId("pass1", 5)` | `getStepExecutionId("pass1", 5)` | **No change** — Step 5 number is unchanged |

Page Plan reads nodes from Step 5. Step 5 (Entity Resolution) didn't move. **No step number changes needed in this file.**

However, Page Plan now runs as Step 12 (not 9). Other files that read Page Plan's artifact need to reference step 12. This is covered in Items 4–9 below.

**Additional consideration:** Page Plan reads from Step 5's execution_id for nodes. After the first plan, Step 9 (Attribute Completion) may have updated nodes in-place (same execution_id as Step 5). Step 10 (Pattern Synthesis) creates NEW convention nodes with its own execution_id. Step 11 (Graph Re-enrichment) creates new edges with its own execution_id.

**Problem:** Page Plan currently only reads nodes from Step 5's execution_id. It will NOT see:
- Convention entities created in Step 10 (they have Step 10's execution_id)
- Discovery nodes from Step 8 (they have Step 8's execution_id)

**Fix needed:** Page Plan must read nodes from ALL relevant steps. Change the node-reading logic:
```typescript
// Read nodes from Steps 5, 8, and 10
const step5ExecId = await ctx.getStepExecutionId("pass1", 5);
const step8ExecId = await ctx.getStepExecutionId("pass1", 8);
const step10ExecId = await ctx.getStepExecutionId("pass1", 10);

const execIds = [step5ExecId, step8ExecId, step10ExecId].filter(Boolean);
const nodesFilter = execIds.length > 0
  ? { execution_id: { $in: execIds } }
  : { run_id: ctx.runId };
const allNodes = await tc.graph_nodes.find(nodesFilter).toArray();
```

This is a **critical fix**. Without it, Page Plan won't create entity plans for conventions or discovery nodes, meaning they won't get entity pages, won't appear in human pages, and won't get claims or verify cards.

**Same fix needed for reading edges:** Page Plan doesn't read edges currently, so no change there.

---

## Item 4: Update step number references in GraphRAG Retrieval

**File:** `src/application/workers/kb2/pass1/graphrag-retrieval.ts`

**Changes:**

| Line | Current | New | Reason |
|------|---------|-----|--------|
| 24 | `getStepArtifact("pass1", 9)` | `getStepArtifact("pass1", 12)` | Page Plan moved from 9 → 12 |
| 27 | `getStepExecutionId("pass1", 5)` | No change | Step 5 didn't move |
| 30 | `getStepExecutionId("pass1", 6)` | No change | Step 6 didn't move |
| 33 | `getStepExecutionId("pass1", 1)` | No change | Step 1 didn't move |

**Additional fix:** Same as Page Plan — this step reads nodes from Step 5 only. It needs to also read nodes from Steps 8 and 10 to build graph context for discovery and convention entities.

Change the node-reading logic (around line 27):
```typescript
const step5ExecId = await ctx.getStepExecutionId("pass1", 5);
const step8ExecId = await ctx.getStepExecutionId("pass1", 8);
const step10ExecId = await ctx.getStepExecutionId("pass1", 10);
const nodeExecIds = [step5ExecId, step8ExecId, step10ExecId].filter(Boolean);
const nodesFilter = nodeExecIds.length > 0
  ? { execution_id: { $in: nodeExecIds } }
  : { run_id: ctx.runId };
```

**Also for edges:** This step reads edges from Step 6 only. It needs to also read edges from Steps 7 and 11:
```typescript
const step6ExecId = await ctx.getStepExecutionId("pass1", 6);
const step7ExecId = await ctx.getStepExecutionId("pass1", 7);
const step11ExecId = await ctx.getStepExecutionId("pass1", 11);
const edgeExecIds = [step6ExecId, step7ExecId, step11ExecId].filter(Boolean);
const edgesFilter = edgeExecIds.length > 0
  ? { execution_id: { $in: edgeExecIds } }
  : { run_id: ctx.runId };
```

Without this, GraphRAG Retrieval won't see `APPLIES_TO`, `PROPOSED_BY`, or `CONTAINS` edges from Step 11, and how-to generation won't find convention context for proposed features.

---

## Item 5: Update step number references in Generate Entity Pages

**File:** `src/application/workers/kb2/pass1/generate-entity-pages.ts`

**Changes:**

| Line | Current | New | Reason |
|------|---------|-----|--------|
| 35 | `"pass1-step-11"` | `"pass1-step-14"` | This step moved from 11 → 14 |
| 37 | `getStepArtifact("pass1", 10)` | `getStepArtifact("pass1", 13)` | GraphRAG Retrieval moved from 10 → 13 |
| 44 | `getStepExecutionId("pass1", 5)` | See fix below | Needs multi-step read |
| 49 | `getStepArtifact("pass1", 9)` | `getStepArtifact("pass1", 12)` | Page Plan moved from 9 → 12 |

**Node reading fix (line 44):** Same multi-execution-id pattern as Items 3 and 4. Must read nodes from Steps 5, 8, and 10.

---

## Item 6: Update step number references in Generate Human Pages

**File:** `src/application/workers/kb2/pass1/generate-human-pages.ts`

**Changes:**

| Line | Current | New | Reason |
|------|---------|-----|--------|
| 36 | `"pass1-step-12"` | `"pass1-step-15"` | This step moved from 12 → 15 |
| 38 | `getStepExecutionId("pass1", 11)` | `getStepExecutionId("pass1", 14)` | Entity Pages moved from 11 → 14 |
| 43 | `getStepExecutionId("pass1", 5)` | See fix below | Needs multi-step read |
| 58 | `getStepArtifact("pass1", 9)` | `getStepArtifact("pass1", 12)` | Page Plan moved from 9 → 12 |

**Node reading fix (line 43):** Same multi-execution-id pattern. Must read nodes from Steps 5, 8, and 10.

---

## Item 7: Update step number references in Generate How-To Guides

**File:** `src/application/workers/kb2/pass1/generate-howto.ts`

**Changes:**

| Line | Current | New | Reason |
|------|---------|-----|--------|
| 52 | `"pass1-step-13"` | `"pass1-step-16"` | This step moved from 13 → 16 |
| 54 | `getStepExecutionId("pass1", 11)` | `getStepExecutionId("pass1", 14)` | Entity Pages moved from 11 → 14 |
| 57 | `getStepExecutionId("pass1", 5)` | See fix below | Needs multi-step read |
| 60 | `getStepExecutionId("pass1", 6)` | See fix below | Needs multi-step read for edges |

**Node reading fix (line 57):** Must read nodes from Steps 5, 8, and 10. This is especially critical here because How-To only runs for proposed ticket nodes (from Step 8 — `discovery_category` in `proposed_ticket`/`proposed_from_feedback`). Without reading Step 8 nodes, it finds zero proposed tickets.

Currently this works because Step 8 nodes have `run_id` as fallback. But once Step 9 may update them in-place, it's better to be explicit.

**Edge reading fix (line 60):** Must read edges from Steps 6, 7, AND 11. This is the most critical change for How-To quality: `APPLIES_TO` edges from Step 11 connect conventions to proposed features. Without reading Step 11 edges, How-To won't find Kim's Color Convention when writing the Toy Donation Feature guide.

```typescript
const step6ExecId = await ctx.getStepExecutionId("pass1", 6);
const step7ExecId = await ctx.getStepExecutionId("pass1", 7);
const step11ExecId = await ctx.getStepExecutionId("pass1", 11);
const edgeExecIds = [step6ExecId, step7ExecId, step11ExecId].filter(Boolean);
const edgesFilter = edgeExecIds.length > 0
  ? { execution_id: { $in: edgeExecIds } }
  : { run_id: ctx.runId };
const graphEdges = await tc.graph_edges.find(edgesFilter).toArray();
```

---

## Item 8: Update step number references in Extract Claims

**File:** `src/application/workers/kb2/pass1/extract-claims.ts`

**Changes:**

| Line | Current | New | Reason |
|------|---------|-----|--------|
| 26 | `"pass1-step-14"` | `"pass1-step-17"` | This step moved from 14 → 17 |
| 36 | `getStepExecutionId("pass1", 11)` | `getStepExecutionId("pass1", 14)` | Entity Pages moved from 11 → 14 |
| 39 | `getStepExecutionId("pass1", 12)` | `getStepExecutionId("pass1", 15)` | Human Pages moved from 12 → 15 |

No node/edge reading changes needed — this step reads from `entity_pages` and `human_pages` collections, not directly from `graph_nodes`.

---

## Item 9: Update step number references in Create Verify Cards

**File:** `src/application/workers/kb2/pass1/create-verify-cards.ts`

**Changes:**

| Line | Current | New | Reason |
|------|---------|-----|--------|
| 52 | `"pass1-step-15"` | `"pass1-step-18"` | This step moved from 15 → 18 |
| 71 | `getStepExecutionId("pass1", 14)` | `getStepExecutionId("pass1", 17)` | Claims moved from 14 → 17 |
| 74 | `getStepExecutionId("pass1", 5)` | See fix below | Needs multi-step read |
| 77 | `getStepExecutionId("pass1", 6)` | See fix below | Needs multi-step read for edges |
| 81 | `getStepExecutionId("pass1", 11)` | `getStepExecutionId("pass1", 14)` | Entity Pages moved from 11 → 14 |
| 325 | `getStepExecutionId("pass1", 5)` | See fix below | Same multi-step read |

**Node reading fix:** Must read nodes from Steps 5, 8, and 10 (same pattern as all other downstream steps).

**Edge reading fix:** Must read edges from Steps 6, 7, and 11. The verify cards step uses `OWNED_BY` and `LEADS` edges for auto-assignment. Step 11's new edges might include ownership-related edges that should be considered.

---

## Item 10: Add verify card filtering for conventions and discoveries

**File:** `src/application/workers/kb2/pass1/create-verify-cards.ts`

**Problem:** Convention entities have `truth_status: "inferred"` and `confidence: "medium"`. All 32 Step 8 discovery nodes also have `truth_status: "inferred"`. This means every claim from their entity pages becomes an inferred-claim candidate. With ~3 conventions × ~5 claims each + ~32 discoveries × ~3 claims each ≈ 111 additional candidates. After LLM filtering some will be dropped, but the LLM is inconsistent about this.

**Changes needed in the candidate collection phase:**

1. **Skip convention entities from inferred-claim candidates (around lines 96–108):**
```typescript
// When collecting inferred claims as candidates:
for (const claim of claims) {
  if (claim.truth_status !== "inferred") continue;

  // Skip claims from convention entities — conventions are synthesized by design
  const sourcePage = entityPages.find(ep => ep.page_id === claim.source_page_id);
  if (sourcePage) {
    const sourceNode = nodeById.get(sourcePage.node_id);
    if (sourceNode?.attributes?.is_convention) continue;
  }

  candidates.push({ ... });
}
```

2. **Add stronger LLM prompt guidance for filtering (in the system prompt, around line 56):**
Add to the filtering rubric:
```
- Discovery items (truth_status=inferred, from conversation analysis) should only get S1/S2 cards
  if they represent critical factual claims. Most discovery items are S3 or should be filtered.
- Convention/pattern entities are inherently inferred — do NOT create cards questioning their
  existence. Only create cards if a specific factual claim within them is questionable.
```

3. **Optional hard cap:** After LLM filtering, if more than N cards survive (e.g., 30), keep only the top N by severity (S1 first, then S2, etc.):
```typescript
const MAX_CARDS = 30;
if (survivingCards.length > MAX_CARDS) {
  const severityOrder = { S1: 0, S2: 1, S3: 2, S4: 3 };
  survivingCards.sort((a, b) => (severityOrder[a.severity] ?? 4) - (severityOrder[b.severity] ?? 4));
  survivingCards = survivingCards.slice(0, MAX_CARDS);
}
```

---

## Item 11: Add team_member template section for conventions

**File:** `src/entities/models/kb2-templates.ts`

**Current `team_member` template sections:**
- Identity [MUST]
- Ownership [MUST]
- Domain Expertise [MUST_IF_PRESENT]
- Current Focus [MUST_IF_PRESENT]
- Past Contributions [OPTIONAL]

**Add a new section:**
```typescript
{ name: "Established Conventions", intent: "Recurring patterns, design conventions, or architectural rules this person consistently applies across projects", requirement: "MUST_IF_PRESENT", maxBullets: 6 },
```

**Why:** This gives the entity page generation LLM a structural slot to fill for team members. When GraphRAG Retrieval builds context for Kim's entity page, it will find `PROPOSED_BY` edges from Kim's Color Convention → Kim. The convention's entity page content will be in the neighbor context. The LLM will have a named section to place this information.

Without this section, the LLM might mention conventions in "Domain Expertise" or "Past Contributions" — but it might also not mention them at all if those sections are already full. Having an explicit section ensures conventions are captured.

---

## Item 12: Ensure `entity_refs` include node_ids for traceability

**File:** `src/application/workers/kb2/pass1/generate-human-pages.ts`

**Current state:** Human page paragraphs have `entity_refs: string[]` — an array of display names. If a display name changes or two entities share similar names, references break.

**Change:** Add `entity_node_ids: string[]` alongside `entity_refs` in the schema and output. After the LLM returns `entity_refs` (display names), resolve them to `node_id`s:

```typescript
// After LLM generates the paragraph:
const entityNodeIds = paragraph.entity_refs
  .map(name => {
    const node = allNodes.find(n =>
      n.display_name.toLowerCase() === name.toLowerCase() ||
      n.aliases.some(a => a.toLowerCase() === name.toLowerCase())
    );
    return node?.node_id;
  })
  .filter(Boolean);

// Store alongside entity_refs
paragraph.entity_node_ids = entityNodeIds;
```

**Also update the schema** in `kb2-types.ts` for the human page paragraph type to include `entity_node_ids: z.array(z.string()).default([])`.

**Why:** This creates a reliable link from human page content → entity nodes → entity pages → source documents. When a user clicks on an entity reference in a human page, the UI can use `node_id` to navigate to the correct entity page, regardless of name changes. It also enables the future "if entity X changes, find all human pages that reference it" propagation.

---

## Complete Step Number Reference Table

For quick reference, here is every `getStepArtifact`/`getStepExecutionId` call that needs updating:

| File | Line | Old Call | New Call |
|------|------|----------|----------|
| `graphrag-retrieval.ts` | 24 | `getStepArtifact("pass1", 9)` | `getStepArtifact("pass1", 12)` |
| `generate-entity-pages.ts` | 37 | `getStepArtifact("pass1", 10)` | `getStepArtifact("pass1", 13)` |
| `generate-entity-pages.ts` | 49 | `getStepArtifact("pass1", 9)` | `getStepArtifact("pass1", 12)` |
| `generate-human-pages.ts` | 38 | `getStepExecutionId("pass1", 11)` | `getStepExecutionId("pass1", 14)` |
| `generate-human-pages.ts` | 58 | `getStepArtifact("pass1", 9)` | `getStepArtifact("pass1", 12)` |
| `generate-howto.ts` | 54 | `getStepExecutionId("pass1", 11)` | `getStepExecutionId("pass1", 14)` |
| `extract-claims.ts` | 36 | `getStepExecutionId("pass1", 11)` | `getStepExecutionId("pass1", 14)` |
| `extract-claims.ts` | 39 | `getStepExecutionId("pass1", 12)` | `getStepExecutionId("pass1", 15)` |
| `create-verify-cards.ts` | 71 | `getStepExecutionId("pass1", 14)` | `getStepExecutionId("pass1", 17)` |
| `create-verify-cards.ts` | 81 | `getStepExecutionId("pass1", 11)` | `getStepExecutionId("pass1", 14)` |

**Calls that stay the same** (Steps 1–8 didn't move):

| File | Line | Call | No Change Reason |
|------|------|------|------------------|
| `page-plan.ts` | 228 | `getStepExecutionId("pass1", 5)` | Step 5 unchanged |
| `graphrag-retrieval.ts` | 27 | `getStepExecutionId("pass1", 5)` | Step 5 unchanged |
| `graphrag-retrieval.ts` | 30 | `getStepExecutionId("pass1", 6)` | Step 6 unchanged |
| `graphrag-retrieval.ts` | 33 | `getStepExecutionId("pass1", 1)` | Step 1 unchanged |
| `generate-entity-pages.ts` | 44 | `getStepExecutionId("pass1", 5)` | Step 5 unchanged |
| `generate-human-pages.ts` | 43 | `getStepExecutionId("pass1", 5)` | Step 5 unchanged |
| `generate-howto.ts` | 57 | `getStepExecutionId("pass1", 5)` | Step 5 unchanged |
| `generate-howto.ts` | 60 | `getStepExecutionId("pass1", 6)` | Step 6 unchanged |
| `create-verify-cards.ts` | 74 | `getStepExecutionId("pass1", 5)` | Step 5 unchanged |
| `create-verify-cards.ts` | 77 | `getStepExecutionId("pass1", 6)` | Step 6 unchanged |
| `create-verify-cards.ts` | 325 | `getStepExecutionId("pass1", 5)` | Step 5 unchanged |

**Hardcoded `stepId` strings to update:**

| File | Line | Old | New |
|------|------|-----|-----|
| `generate-entity-pages.ts` | 35 | `"pass1-step-11"` | `"pass1-step-14"` |
| `generate-human-pages.ts` | 36 | `"pass1-step-12"` | `"pass1-step-15"` |
| `generate-howto.ts` | 52 | `"pass1-step-13"` | `"pass1-step-16"` |
| `extract-claims.ts` | 26 | `"pass1-step-14"` | `"pass1-step-17"` |
| `create-verify-cards.ts` | 52 | `"pass1-step-15"` | `"pass1-step-18"` |

---

## Multi-Execution-ID Node/Edge Reading Pattern

This is the most important architectural fix in this plan. Currently, downstream steps read nodes from a single execution_id (Step 5). After the first plan, nodes exist across three execution_ids:

- **Step 5** execution_id: entities from extraction → validation → resolution (projects, decisions, processes, tickets, PRs, libraries, team_members, etc.)
- **Step 8** execution_id: discovery nodes (undocumented projects, proposed tickets)
- **Step 10** execution_id: convention entities (cross-cutting patterns)

Similarly, edges exist across three execution_ids:

- **Step 6** execution_id: relationship edges + MENTIONED_IN edges
- **Step 7** execution_id: LLM-enriched entity-to-entity edges
- **Step 11** execution_id: APPLIES_TO, PROPOSED_BY, CONTAINS, RELATED_TO edges for discovery/convention nodes

**Every downstream step that reads `graph_nodes` must use this pattern:**
```typescript
const step5ExecId = await ctx.getStepExecutionId("pass1", 5);
const step8ExecId = await ctx.getStepExecutionId("pass1", 8);
const step10ExecId = await ctx.getStepExecutionId("pass1", 10);
const nodeExecIds = [step5ExecId, step8ExecId, step10ExecId].filter(Boolean);
const nodesFilter = nodeExecIds.length > 0
  ? { execution_id: { $in: nodeExecIds } }
  : { run_id: ctx.runId };
```

**Every downstream step that reads `graph_edges` must use this pattern:**
```typescript
const step6ExecId = await ctx.getStepExecutionId("pass1", 6);
const step7ExecId = await ctx.getStepExecutionId("pass1", 7);
const step11ExecId = await ctx.getStepExecutionId("pass1", 11);
const edgeExecIds = [step6ExecId, step7ExecId, step11ExecId].filter(Boolean);
const edgesFilter = edgeExecIds.length > 0
  ? { execution_id: { $in: edgeExecIds } }
  : { run_id: ctx.runId };
```

**Files that need the node fix:**
- `page-plan.ts` (line 228)
- `graphrag-retrieval.ts` (line 27)
- `generate-entity-pages.ts` (line 44)
- `generate-human-pages.ts` (line 43)
- `generate-howto.ts` (line 57)
- `create-verify-cards.ts` (lines 74, 325)

**Files that need the edge fix:**
- `graphrag-retrieval.ts` (line 30)
- `generate-howto.ts` (line 60)
- `create-verify-cards.ts` (line 77)

**Files that DON'T need the fix** (they don't read graph_nodes/graph_edges directly):
- `extract-claims.ts` (reads entity_pages and human_pages only)

---

## Implementation Order

1. **Item 1** — Add edge types to enum (1 minute, blocking)
2. **Item 3** — Fix Page Plan node reading (multi-exec-id pattern)
3. **Item 4** — Fix GraphRAG Retrieval node AND edge reading + step number
4. **Item 5** — Fix Generate Entity Pages step numbers + node reading
5. **Item 11** — Add "Established Conventions" section to team_member template
6. **Item 2** — Add "Hidden Conventions" human page category
7. **Item 6** — Fix Generate Human Pages step numbers + node reading
8. **Item 7** — Fix Generate How-To step numbers + node AND edge reading
9. **Item 8** — Fix Extract Claims step numbers
10. **Item 10** — Add verify card filtering for conventions
11. **Item 9** — Fix Create Verify Cards step numbers + node/edge reading
12. **Item 12** — Add entity_node_ids to human pages

---

## Success Criteria

After all changes + a full pipeline run:

1. **Convention entity pages exist** with sections: Identity, Context, Decision, Alternatives Considered, Consequences, Affected Systems, Decision Makers — filled from combined source evidence
2. **"Hidden Conventions & Patterns" human page exists** with narrative about Kim's colors, Tim's layouts, Matt's browse pattern
3. **Kim's team_member entity page** has an "Established Conventions" section mentioning her color convention
4. **Toy Donation Feature how-to guide** references conventions in its Implementation Steps (e.g., "Use green for the donate CTA per Kim's color convention")
5. **Verify cards** number under 30 total; no cards questioning the existence of conventions
6. **Human page paragraphs** have `entity_node_ids` linking back to specific nodes
7. **All step number references** resolve correctly (no "step artifact not found" errors)
8. **All node/edge reads** include data from Steps 5+8+10 (nodes) and Steps 6+7+11 (edges)
