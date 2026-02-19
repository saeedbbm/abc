import { getFastModel } from "@/lib/ai-model";
import { PrefixLogger } from "@/lib/utils";
import { db } from "@/lib/mongodb";
import { streamText } from "ai";
import {
  KB_PAGE_TEMPLATES,
  type ScoreFormatOutputType,
} from "@/src/entities/models/score-format";

const logger = new PrefixLogger("mock-generator");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildScenarioSpec(messages: { role: string; content: string }[]): string {
  return messages
    .filter(m => m.content.trim().length > 0)
    .map(m => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n\n");
}

function buildInputSummary(inputs: Record<string, string>, maxPerSource = 0): string {
  return Object.entries(inputs)
    .filter(([, v]) => v.length > 0)
    .map(([k, v]) => {
      const text = maxPerSource > 0 && v.length > maxPerSource
        ? v.substring(0, maxPerSource) + `\n... (truncated, ${v.length} total chars)`
        : v;
      return `=== ${k.toUpperCase()} (${v.length} chars) ===\n${text}`;
    })
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Source bundle configs
// ---------------------------------------------------------------------------

const SOURCE_BUNDLES = [
  {
    key: "confluence" as const,
    label: "Confluence",
    format: `Use "--- PAGE ---" separators between pages. Each page has "Title:", "Author:", "Date:", "Space:", then content with markdown headers for sections.`,
    hint: "Confluence wiki pages documenting the company's projects, architecture, and processes.",
  },
  {
    key: "jira" as const,
    label: "Jira",
    format: `Use "--- TICKET ---" separators. Each ticket has "Key:", "Title:", "Type:", "Status:", "Priority:", "Assignee:", "Reporter:", "Created:", "Updated:", "Description:", "Acceptance Criteria:", "Comments:".`,
    hint: "Jira tickets showing ongoing work, bugs, and tasks.",
  },
  {
    key: "slack" as const,
    label: "Slack",
    format: `Use "--- CHANNEL: #channel-name ---" then messages as "[YYYY-MM-DD HH:MM] @username: message text". Threads indented with "  > [time] @user: reply".`,
    hint: "Slack conversations with corrections, tribal knowledge, and informal decisions.",
  },
  {
    key: "github" as const,
    label: "GitHub",
    format: `Use "--- REPO: repo-name ---" then "## Directory Tree", "## File: path/to/file", "## PR #N: title", "## Commit: hash".`,
    hint: "GitHub repos with PRs, commits, and config files.",
  },
  {
    key: "customerFeedback" as const,
    label: "Customer Feedback",
    format: `Use "--- FEEDBACK ---" separators. Each has "Source:", "Date:", "Customer:", "Severity:", "Product Area:", then the feedback text.`,
    hint: "Customer feedback from reviews, support chats, and emails.",
  },
] as const;

const NO_HINTS_RULE = `EXTREMELY IMPORTANT — NO HINTS OR ANNOTATIONS:
Write exactly as a real human would. Do NOT include meta-annotations like "(this is a conflict)", "(subtle confusion)", "(outdated info)", "[NOTE: ...]", "// intentionally ...". Let issues exist naturally.`;

// ---------------------------------------------------------------------------
// Generate mock inputs — streaming, one source at a time
// ---------------------------------------------------------------------------

export interface InputStreamCallback {
  (source: string, textSoFar: string): void;
}

export async function generateMockInputs(
  messages: { role: string; content: string }[],
  projectId: string,
  onProgress?: (detail: string, percent: number) => void,
  onInputChunk?: InputStreamCallback,
): Promise<{ confluence: string; jira: string; slack: string; github: string; customerFeedback: string }> {
  const scenarioSpec = buildScenarioSpec(messages);
  const t0 = Date.now();
  logger.log("Generating mock input data (streaming, one source at a time)...");

  const output: Record<string, string> = {
    confluence: "", jira: "", slack: "", github: "", customerFeedback: "",
  };

  let previousContext = "";

  for (let i = 0; i < SOURCE_BUNDLES.length; i++) {
    const bundle = SOURCE_BUNDLES[i];
    const pctBase = 3 + Math.round((i / SOURCE_BUNDLES.length) * 15);
    const pctDone = 3 + Math.round(((i + 1) / SOURCE_BUNDLES.length) * 15);

    onProgress?.(`[Mock ${i + 1}/5] Streaming ${bundle.label}...`, pctBase);
    const stepStart = Date.now();

    try {
      const result = streamText({
        model: getFastModel(),
        system: `You are generating realistic mock ${bundle.label} data for a company. The output must look EXACTLY like real data exported from ${bundle.label}.

FORMAT:
${bundle.format}

${NO_HINTS_RULE}

HARD WORD LIMIT: Your ENTIRE output for this source MUST be under 200 words total. This is a STRICT, NON-NEGOTIABLE limit. Count your words. Be extremely concise — use short sentences, abbreviations, and minimal detail. If the scenario asks for many items, keep each item to 1-3 sentences. DO NOT exceed 200 words under any circumstances.

The data must be internally consistent with any previously generated sources (same people names, project names, ticket IDs, dates, etc.).`,
        prompt: `SCENARIO:
${scenarioSpec}

${previousContext ? `PREVIOUSLY GENERATED SOURCES (use same names, IDs, dates):\n${previousContext}\n` : ""}
Generate the ${bundle.label} source bundle. ${bundle.hint}
REMEMBER: MAXIMUM 200 WORDS TOTAL. Be very brief.
Output ONLY the raw ${bundle.label} text, nothing else.`,
      });

      let accumulated = "";
      for await (const chunk of result.textStream) {
        accumulated += chunk;
        onInputChunk?.(bundle.key, accumulated);
      }

      output[bundle.key] = accumulated;
      const stepElapsed = ((Date.now() - stepStart) / 1000).toFixed(1);
      logger.log(`${bundle.label} streamed in ${stepElapsed}s — ${accumulated.length} chars`);
      onProgress?.(`[Mock ${i + 1}/5] ${bundle.label} done in ${stepElapsed}s — ${accumulated.length} chars`, pctDone);

      const truncated = accumulated.length > 600 ? accumulated.substring(0, 600) + "\n..." : accumulated;
      previousContext += `\n=== ${bundle.label.toUpperCase()} ===\n${truncated}\n`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.log(`${bundle.label} generation FAILED: ${msg}`);
      throw new Error(`Failed to generate ${bundle.label}: ${msg}`);
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const totalChars = Object.values(output).reduce((s, v) => s + v.length, 0);
  logger.log(`All 5 mock inputs streamed in ${elapsed}s — total ${totalChars} chars`);
  onProgress?.(`[Mock Generator] All done in ${elapsed}s — ${totalChars} total chars`, 19);

  onProgress?.("[Mock Generator] Saving to database...", 19);
  await db.collection("new_test_inputs").insertOne({
    projectId,
    inputs: output,
    createdAt: new Date().toISOString(),
  });
  onProgress?.("[Mock Generator] Saved.", 20);

  return output as { confluence: string; jira: string; slack: string; github: string; customerFeedback: string };
}

// ---------------------------------------------------------------------------
// Ground Truth types & constants
// ---------------------------------------------------------------------------

export interface GTPartCallback {
  (part: "kb_pages" | "conversation_tickets" | "feedback_tickets" | "howto_pages", data: any): void;
}

export interface PagePlanItem {
  category: string;
  title: string;
  description: string;
}

const GT_SYSTEM_BASE = `You are generating part of the GROUND TRUTH (answer key) for evaluating a knowledge base AI system.
You have access to the scenario spec AND the full generated source data. You know exactly what gaps, conflicts, outdated items, and features exist.
Your output must represent PERFECT results — what a flawless KB system should produce.

RULES FOR ATOMIC ITEMS:
- item_id: use "gt-" prefix + sequential number
- item_type: fact | step | decision | owner | dependency | risk | question | ticket | conflict | gap | outdated
- action_routing: none | verify_task | update_kb | create_jira_ticket
  - Internal issues → verify_task or update_kb. User-facing issues → create_jira_ticket
- source_refs: cite specific input documents with excerpts
- confidence_bucket: high (authoritative/multi-source), medium (single source), low (inferred)`;

const KB_CATEGORIES: { key: string; label: string; extra: string }[] = [
  { key: "company_overview", label: "Company Overview", extra: "" },
  { key: "setup_onboarding", label: "Setup & Onboarding", extra: "" },
  { key: "people", label: "People", extra: "" },
  { key: "clients", label: "Clients", extra: "" },
  { key: "past_documented", label: "Past Documented Projects", extra: "Items of type 'conflict' or 'outdated' that belong to these projects should appear here." },
  { key: "past_undocumented", label: "Past Undocumented Projects", extra: "Items of type 'gap' (things inferred but not explicitly documented) go here." },
  { key: "ongoing_projects", label: "Ongoing Projects", extra: "Items of type 'conflict' or 'outdated' that belong to these projects should appear here." },
  { key: "new_projects", label: "New Projects", extra: "" },
  { key: "processes", label: "Processes", extra: "" },
];

// ---------------------------------------------------------------------------
// Phase 1 ONLY: Generate page plan — ONE fast streamed call for all categories
// ---------------------------------------------------------------------------

export async function generatePagePlan(
  messages: { role: string; content: string }[],
  inputs: { confluence: string; jira: string; slack: string; github: string; customerFeedback: string },
  projectId: string,
  onProgress?: (detail: string, percent: number) => void,
): Promise<PagePlanItem[]> {
  const scenarioSpec = buildScenarioSpec(messages);
  const inputFull = buildInputSummary(inputs);
  const t0 = Date.now();
  logger.log("Generating page plan (single call, all 9 categories)...");
  onProgress?.("[Plan] Streaming page titles for all 9 categories...", 10);

  const categoriesList = KB_CATEGORIES.map(c => `- ${c.key} (${c.label}): ${c.extra || "—"}`).join("\n");

  let plan: PagePlanItem[] = [];

  try {
    const result = streamText({
      model: getFastModel(),
      system: `You are generating the GROUND TRUTH page plan (answer key) for evaluating a KB system.
You have the original scenario spec AND the FULL generated input data.
Output ONLY a valid JSON array — no markdown fences, no explanation, no text before or after.
Each element: {"category": "<category_key>", "title": "<descriptive page title>", "description": "<1 sentence>"}

ABSOLUTE RULE: The scenario spec is the SOURCE OF TRUTH for how many pages each category must have.
If the scenario says "3 past documented projects", you MUST create exactly 3 pages under past_documented.
If the scenario says "3 ongoing projects", you MUST create exactly 3 pages under ongoing_projects.
If the scenario says "3 new projects", you MUST create exactly 3 pages under new_projects.
If the scenario says "3 engineers", you MUST create exactly 3 pages under people.

Use the input data to find the actual project/person names for each page title.
If you can't find enough names in the input data, invent plausible ones that fit the domain.

NEVER return fewer pages than the scenario specifies. The scenario counts are non-negotiable.`,
      prompt: `SCENARIO SPEC (this is the absolute source of truth for counts):\n${scenarioSpec}\n\nFULL INPUT DATA (use for names/titles):\n${inputFull}\n\nCATEGORIES:\n${categoriesList}\n\nReturn the JSON array. The number of pages per category MUST match the scenario spec exactly. JSON only.`,
    });

    let accumulated = "";
    for await (const chunk of result.textStream) {
      accumulated += chunk;
      if (accumulated.length % 200 < 10) {
        onProgress?.(`[Plan] Streaming... ${accumulated.length} chars`, 30);
      }
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    logger.log(`Plan LLM done in ${elapsed}s — ${accumulated.length} chars`);
    onProgress?.(`[Plan] LLM done in ${elapsed}s — parsing JSON...`, 80);

    const jsonMatch = accumulated.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error("No JSON array in response");

    const parsed = JSON.parse(jsonMatch[0]) as { category: string; title: string; description: string }[];
    plan = parsed.filter(p => p.category && p.title).map(p => ({
      category: p.category,
      title: p.title,
      description: p.description || "",
    }));

    logger.log(`Plan parsed: ${plan.length} pages`);
    for (const cat of KB_CATEGORIES) {
      const catPages = plan.filter(p => p.category === cat.key);
      logger.log(`  ${cat.label}: ${catPages.length} — ${catPages.map(p => p.title).join(", ") || "(none)"}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.log(`Plan FAILED: ${msg} — using defaults`);
    onProgress?.(`[Plan] LLM failed: ${msg} — using defaults`, 80);
    plan = KB_CATEGORIES.map(c => ({ category: c.key, title: c.label, description: `Default page for ${c.label}` }));
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  onProgress?.(`[Plan] ${plan.length} pages in ${elapsed}s`, 95);

  await db.collection("new_test_page_plan").updateOne(
    { projectId },
    { $set: { projectId, plan, updatedAt: new Date().toISOString() }, $setOnInsert: { createdAt: new Date().toISOString() } },
    { upsert: true },
  );
  onProgress?.("[Plan] Saved.", 100);

  return plan;
}

// ---------------------------------------------------------------------------
// Phase 2: Generate GT pages using an existing plan
// ---------------------------------------------------------------------------

export async function generateGroundTruth(
  messages: { role: string; content: string }[],
  inputs: { confluence: string; jira: string; slack: string; github: string; customerFeedback: string },
  projectId: string,
  onProgress?: (detail: string, percent: number) => void,
  onGTPart?: GTPartCallback,
  existingPlan?: PagePlanItem[],
): Promise<ScoreFormatOutputType> {
  const inputFull = buildInputSummary(inputs);
  const t0 = Date.now();

  const output: ScoreFormatOutputType = {
    kb_pages: [],
    conversation_tickets: [],
    feedback_tickets: [],
    howto_pages: [],
  };

  // Load plan from DB if not provided
  let plan = existingPlan;
  if (!plan) {
    const planDoc = await db.collection("new_test_page_plan").findOne({ projectId }, { sort: { updatedAt: -1 } });
    plan = planDoc?.plan as PagePlanItem[] | undefined;
  }
  if (!plan || plan.length === 0) {
    onProgress?.("[GT] No page plan found — generating plan first...", 22);
    plan = await generatePagePlan(messages, inputs, projectId, (d, p) => onProgress?.(`  ${d}`, 22 + Math.round(p * 0.05)));
  }

  logger.log(`Generating GT pages from plan (${plan.length} KB pages + tickets + howto)...`);
  const totalKBPages = plan.length;

  // -----------------------------------------------------------------------
  // KB Pages: one streamText call per planned page (faster than streamObject)
  // -----------------------------------------------------------------------
  let pagesDone = 0;
  for (const pageSpec of plan) {
    pagesDone++;
    const cat = KB_CATEGORIES.find(c => c.key === pageSpec.category);
    const catLabel = cat?.label || pageSpec.category;
    const sections = KB_PAGE_TEMPLATES[pageSpec.category as keyof typeof KB_PAGE_TEMPLATES] || [];
    const pct = 22 + Math.round((pagesDone / totalKBPages) * 16);
    onProgress?.(`[GT Page ${pagesDone}/${totalKBPages}] ${catLabel} › ${pageSpec.title}...`, pct);
    const pageStart = Date.now();

    try {
      const pageResult = streamText({
        model: getFastModel(),
        maxTokens: 4096,
        system: `You generate a KB page as a JSON object. No markdown, no explanation, ONLY JSON.

RULES:
- 10-20 atomic items per page across multiple sections
- item_text: 1-3 sentences, informative and specific (30-60 words)
- source_refs excerpts: 1 short sentence
- action_routing reason: 1 short sentence
- Output ONLY the JSON object, nothing else before or after

JSON format:
{"page_id":"gt-page-${pagesDone}","category":"${pageSpec.category}","title":"${pageSpec.title}","sections":[{"section_name":"<name>","bullets":[{"item_id":"gt-${pagesDone}-1","item_text":"<detailed text>","item_type":"fact|step|decision|owner|dependency|risk|question|ticket|conflict|gap|outdated","source_refs":[{"source_type":"confluence|slack|jira|github|customer_feedback","doc_id":"<id>","title":"<title>","excerpt":"<short quote>"}],"verification":{"status":"needs_verification","verifier":null},"action_routing":{"action":"none|verify_task|update_kb|create_jira_ticket","reason":"<why>","severity":"S1|S2|S3|S4"},"confidence_bucket":"high|medium|low"}]}]}

Sections: ${sections.join(", ")}
${cat?.extra || ""}`,
        prompt: `Page: "${pageSpec.title}" (${catLabel}). Description: ${pageSpec.description}\n\nINPUT DATA:\n${inputFull}\n\nJSON only, 10-20 items across sections:`,
      });

      let accumulated = "";
      for await (const chunk of pageResult.textStream) {
        accumulated += chunk;
        if (accumulated.length % 300 < 15) {
          onProgress?.(`[GT Page ${pagesDone}/${totalKBPages}] ${catLabel} › ${pageSpec.title} (${accumulated.length} chars)...`, pct);
        }
      }

      const jsonMatch = accumulated.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No JSON object in response");
      const page = JSON.parse(jsonMatch[0]) as ScoreFormatOutputType["kb_pages"][number];
      if (!page.page_id) page.page_id = `gt-page-${pagesDone}`;
      if (!page.category) (page as any).category = pageSpec.category;
      if (!page.title) page.title = pageSpec.title;
      output.kb_pages.push(page);
      onGTPart?.("kb_pages", output.kb_pages);
      const items = (page.sections || []).reduce((s: number, sec: any) => s + (sec.bullets?.length || 0), 0);
      const pageElapsed = ((Date.now() - pageStart) / 1000).toFixed(1);
      logger.log(`GT Page "${pageSpec.title}": ${items} items in ${pageElapsed}s`);
      onProgress?.(`[GT Page ${pagesDone}/${totalKBPages}] ${catLabel} › ${pageSpec.title} ✓ ${items} items (${pageElapsed}s)`, pct);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.log(`GT Page "${pageSpec.title}" FAILED: ${msg}`);
      onProgress?.(`[GT Page ${pagesDone}/${totalKBPages}] ${catLabel} › ${pageSpec.title} FAILED: ${msg}`, pct);
    }
  }

  const kbElapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const totalItems = output.kb_pages.reduce((s, p) => s + p.sections.reduce((ss, sec) => ss + sec.bullets.length, 0), 0);
  onProgress?.(`[GT] KB done — ${output.kb_pages.length} pages, ${totalItems} items (${kbElapsed}s)`, 38);

  // -----------------------------------------------------------------------
  // Conversation Tickets
  // -----------------------------------------------------------------------
  onProgress?.("[GT] Generating conversation tickets...", 38);
  try {
    const convStream = streamText({
      model: getFastModel(),
      maxTokens: 3000,
      system: `Generate tickets detected from Slack/Jira conversations. Output ONLY JSON: {"conversation_tickets":[...]}
Keep each ticket compact. Each ticket: {"ticket_id":"gt-conv-N","type":"bug|feature|task|improvement","title":"...","priority":"P0|P1|P2|P3","priority_rationale":"short","description":"1-2 sentences","acceptance_criteria":["..."],"assigned_to":"...","assignment_rationale":"short","affected_systems":["..."],"customer_evidence":[],"technical_constraints":[],"complexity":"small|medium|large","related_tickets":[],"source_refs":[{"source_type":"slack|jira","doc_id":"...","title":"...","excerpt":"short"}]}`,
      prompt: `INPUT DATA:\n${inputFull}\n\nGenerate conversation tickets. JSON only, be concise.`,
    });
    let convText = "";
    for await (const chunk of convStream.textStream) {
      convText += chunk;
      if (convText.length % 300 < 15) onProgress?.(`[GT] Conv tickets streaming... ${convText.length} chars`, 38);
    }
    const convJson = convText.match(/\{[\s\S]*\}/);
    if (!convJson) throw new Error("No JSON in response");
    const convData = JSON.parse(convJson[0]);
    output.conversation_tickets = (convData.conversation_tickets || []) as ScoreFormatOutputType["conversation_tickets"];
    onGTPart?.("conversation_tickets", output.conversation_tickets);
    logger.log(`Conv tickets: ${output.conversation_tickets.length} in ${convText.length} chars`);
    onProgress?.(`[GT] Conv tickets done — ${output.conversation_tickets.length}`, 39);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.log(`GT conv tickets failed: ${msg}`);
    onProgress?.(`[GT] Conv tickets FAILED: ${msg}`, 39);
  }

  // -----------------------------------------------------------------------
  // Feedback Tickets
  // -----------------------------------------------------------------------
  onProgress?.("[GT] Generating feedback tickets...", 39);
  try {
    const fbStream = streamText({
      model: getFastModel(),
      maxTokens: 3000,
      system: `Generate tickets from customer feedback (bugs & feature requests). Output ONLY JSON: {"feedback_tickets":[...]}
Keep compact. Each ticket: {"ticket_id":"gt-fb-N","type":"bug|feature","title":"...","priority":"P0|P1|P2|P3","priority_rationale":"short","description":"1-2 sentences","acceptance_criteria":["..."],"assigned_to":"...","assignment_rationale":"short","affected_systems":["..."],"customer_evidence":[{"feedback_id":"...","customer_name":"...","excerpt":"short","sentiment":"positive|negative|neutral"}],"technical_constraints":[],"complexity":"small|medium|large","related_tickets":[],"source_refs":[{"source_type":"customer_feedback","doc_id":"...","title":"...","excerpt":"short"}]}`,
      prompt: `INPUT DATA:\n${inputFull}\n\nGenerate feedback tickets. JSON only, be concise.`,
    });
    let fbText = "";
    for await (const chunk of fbStream.textStream) {
      fbText += chunk;
      if (fbText.length % 300 < 15) onProgress?.(`[GT] Feedback tickets streaming... ${fbText.length} chars`, 39);
    }
    const fbJson = fbText.match(/\{[\s\S]*\}/);
    if (!fbJson) throw new Error("No JSON in response");
    const fbData = JSON.parse(fbJson[0]);
    output.feedback_tickets = (fbData.feedback_tickets || []) as ScoreFormatOutputType["feedback_tickets"];
    onGTPart?.("feedback_tickets", output.feedback_tickets);
    logger.log(`Feedback tickets: ${output.feedback_tickets.length} in ${fbText.length} chars`);
    onProgress?.(`[GT] Feedback tickets done — ${output.feedback_tickets.length}`, 39);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.log(`GT feedback tickets failed: ${msg}`);
    onProgress?.(`[GT] Feedback tickets FAILED: ${msg}`, 39);
  }

  // -----------------------------------------------------------------------
  // How-to-Implement Pages (one per feedback ticket)
  // -----------------------------------------------------------------------
  if (output.feedback_tickets.length > 0) {
    for (let hi = 0; hi < output.feedback_tickets.length; hi++) {
      const ticket = output.feedback_tickets[hi];
      onProgress?.(`[GT How-to ${hi + 1}/${output.feedback_tickets.length}] ${ticket.title}...`, 39);
      try {
        const howtoStream = streamText({
          model: getFastModel(),
          maxTokens: 2000,
          system: `Generate a how-to-implement page as a compact JSON object. No markdown, ONLY JSON.
3-6 atomic items max. Same structure as KB pages.
{"page_id":"gt-howto-${hi + 1}","category":"new_projects","title":"...","sections":[{"section_name":"...","bullets":[...atomic items...]}]}`,
          prompt: `TICKET: ${ticket.ticket_id} — ${ticket.title} (${ticket.type}): ${ticket.description}\n\nINPUT DATA:\n${inputFull}\n\nGenerate how-to page. JSON only, 3-6 items:`,
        });
        let howtoText = "";
        for await (const chunk of howtoStream.textStream) {
          howtoText += chunk;
          if (howtoText.length % 300 < 15) onProgress?.(`[GT How-to ${hi + 1}] ${ticket.title} (${howtoText.length} chars)...`, 40);
        }
        const howtoJson = howtoText.match(/\{[\s\S]*\}/);
        if (!howtoJson) throw new Error("No JSON in response");
        const page = JSON.parse(howtoJson[0]) as ScoreFormatOutputType["howto_pages"][number];
        output.howto_pages.push(page);
        onGTPart?.("howto_pages", output.howto_pages);
        logger.log(`How-to "${ticket.title}": done in ${howtoText.length} chars`);
        onProgress?.(`[GT How-to ${hi + 1}/${output.feedback_tickets.length}] ${ticket.title} ✓`, 40);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.log(`GT How-to "${ticket.title}" FAILED: ${msg}`);
        onProgress?.(`[GT How-to] ${ticket.title} FAILED: ${msg}`, 40);
      }
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  logger.log(`Ground truth complete in ${elapsed}s`);
  onProgress?.(`[Ground Truth] All done in ${elapsed}s`, 40);

  await db.collection("new_test_ground_truth").insertOne({
    projectId,
    data: output,
    createdAt: new Date().toISOString(),
  });
  onProgress?.("[Ground Truth] Saved.", 40);

  return output;
}
