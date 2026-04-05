import { readFileSync } from "fs";
import path from "path";
import { MongoClient } from "mongodb";
import { getOptionalServerEnv } from "../lib/server-env";

type GTProject = {
  canonicalName: string;
  category: string;
};

type EntityPageLike = {
  page_id: string;
  node_id?: string;
  title: string;
  node_type: string;
};

type HumanPageLike = {
  page_id: string;
  title: string;
  category: string;
  paragraphs?: Array<{ body?: string }>;
  linked_entity_page_ids?: string[];
};

const PROJECT_CATEGORIES = [
  "past_documented",
  "past_undocumented",
  "ongoing_documented",
  "ongoing_undocumented",
  "proposed_projects",
] as const;

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value: string): Set<string> {
  return new Set(
    normalizeText(value)
      .split(" ")
      .filter((token) => token.length > 2),
  );
}

function similarity(a: string, b: string): number {
  const normA = normalizeText(a);
  const normB = normalizeText(b);
  if (!normA || !normB) return 0;
  if (normA === normB) return 1;
  if (normA.includes(normB) || normB.includes(normA)) return 0.92;

  const wordsA = tokenize(a);
  const wordsB = tokenize(b);
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let overlap = 0;
  for (const token of wordsA) {
    if (wordsB.has(token)) overlap += 1;
  }
  return overlap / Math.max(wordsA.size, wordsB.size);
}

function parseGTProjects(fileText: string): GTProject[] {
  const projects: GTProject[] = [];
  const lines = fileText.split(/\r?\n/);
  let inProject = false;
  let canonicalName: string | null = null;
  let category: string | null = null;

  const flush = () => {
    if (!inProject || !canonicalName || !category) return;
    projects.push({
      canonicalName,
      category,
    });
  };

  for (const line of lines) {
    const projectMatch = line.match(/^PROJECT\s+\d+:\s+/);
    if (projectMatch) {
      flush();
      inProject = true;
      canonicalName = null;
      category = null;
      continue;
    }
    if (!inProject) continue;

    const canonicalMatch = line.match(/^Canonical name:\s+(.+)$/);
    if (canonicalMatch) {
      canonicalName = canonicalMatch[1].trim();
      continue;
    }

    const categoryMatch = line.match(/^Category:\s+(.+)$/);
    if (categoryMatch) {
      category = categoryMatch[1].trim();
    }
  }

  flush();
  return projects;
}

function parseGTRepositories(fileText: string): string[] {
  const sectionMatch = fileText.match(/Repositories:\s+\d+\s*([\s\S]*?)\n\s*PR list:/);
  if (!sectionMatch) return [];
  return [...sectionMatch[1].matchAll(/^\s*\d+\.\s+([^\n]+)/gm)].map((match) => match[1].trim());
}

function normalizeProjectCategory(category: string): string {
  const normalized = category.toLowerCase().trim();
  if (normalized === "proposed") return "proposed_projects";
  if (normalized.startsWith("past_documented")) return "past_documented";
  if (normalized.startsWith("past_undocumented")) return "past_undocumented";
  if (normalized.startsWith("ongoing_documented")) return "ongoing_documented";
  if (normalized.startsWith("ongoing_undocumented")) return "ongoing_undocumented";
  return normalized;
}

function isPlaceholderHumanPage(page: HumanPageLike | null | undefined): boolean {
  if (!page) return true;
  if ((page.linked_entity_page_ids ?? []).length > 0) return false;
  const paragraphs = page.paragraphs ?? [];
  if (paragraphs.length === 0) return true;
  return paragraphs.every((paragraph) => {
    const body = paragraph.body?.trim() ?? "";
    return /^No .* data has been discovered yet\./i.test(body);
  });
}

function resolveDbName(companySlug: string): string {
  return getOptionalServerEnv("PIDRAX_MULTI_TENANT") === "true"
    ? `pidrax_${companySlug}`
    : "pidrax";
}

async function resolveRunId(db: ReturnType<MongoClient["db"]>, requestedRunId?: string): Promise<string> {
  if (requestedRunId) {
    const exact = await db.collection("kb2_runs").findOne({
      run_id: requestedRunId,
      status: "completed",
    });
    if (exact) return exact.run_id as string;

    const prefixed = await db.collection("kb2_runs").findOne(
      {
        run_id: { $regex: `^${requestedRunId}` },
        status: "completed",
      },
      { sort: { completed_at: -1 } },
    );
    if (prefixed?.run_id) return prefixed.run_id as string;
    throw new Error(`Run ${requestedRunId} not found.`);
  }

  const latest = await db.collection("kb2_runs").findOne(
    { status: "completed" },
    { sort: { completed_at: -1 } },
  );
  if (!latest?.run_id) throw new Error("No completed run found.");
  return latest.run_id as string;
}

async function getLatestCompletedStepExecutionId(
  db: ReturnType<MongoClient["db"]>,
  runId: string,
  stepId: string,
): Promise<string | null> {
  const step = await db.collection("kb2_run_steps").findOne(
    { run_id: runId, step_id: stepId, status: "completed" },
    { sort: { execution_number: -1, completed_at: -1 }, projection: { execution_id: 1 } },
  );
  return (step?.execution_id as string | undefined) ?? null;
}

function pickBestMatch(name: string, pages: EntityPageLike[]): { page: EntityPageLike | null; score: number } {
  let bestPage: EntityPageLike | null = null;
  let bestScore = 0;

  for (const page of pages) {
    const score = similarity(name, page.title);
    if (score > bestScore) {
      bestScore = score;
      bestPage = page;
    }
  }

  return { page: bestPage, score: bestScore };
}

async function main(): Promise<void> {
  const companySlug = process.argv[2] || "pawfinder2";
  const requestedRunId = process.argv[3];
  const mongoUri = getOptionalServerEnv("MONGODB_CONNECTION_STRING") || "mongodb://localhost:27017";
  const client = new MongoClient(mongoUri);
  await client.connect();

  try {
    const db = client.db(resolveDbName(companySlug));
    const runId = await resolveRunId(db, requestedRunId);
    const step14ExecId = await getLatestCompletedStepExecutionId(db, runId, "pass1-step-14");
    const step15ExecId = await getLatestCompletedStepExecutionId(db, runId, "pass1-step-15");

    if (!step14ExecId || !step15ExecId) {
      throw new Error(`Run ${runId} is missing completed step 14 or 15 output.`);
    }

    const entityPages = await db.collection("kb2_entity_pages")
      .find({ execution_id: step14ExecId })
      .toArray() as unknown as EntityPageLike[];
    const humanPages = await db.collection("kb2_human_pages")
      .find({ execution_id: step15ExecId })
      .toArray() as unknown as HumanPageLike[];

    const gtProjectsText = readFileSync(path.join(process.cwd(), "ground-truth", "A-projects.txt"), "utf-8");
    const gtCountsText = readFileSync(path.join(process.cwd(), "ground-truth", "F-entity-counts.txt"), "utf-8");
    const gtProjects = parseGTProjects(gtProjectsText);
    const gtRepos = parseGTRepositories(gtCountsText);

    const repoPages = entityPages.filter((page) => page.node_type === "repository");
    const repoTitles = repoPages.map((page) => page.title).sort((a, b) => a.localeCompare(b));
    const repoShortNames = new Set(repoTitles.map((title) => title.split("/").pop()?.trim().toLowerCase() ?? ""));
    const missingRepos = gtRepos
      .map((repo) => repo.split("/").pop()?.trim().toLowerCase() ?? repo.toLowerCase())
      .filter((repo) => !repoShortNames.has(repo));

    const companyOverview =
      humanPages.find((page) => page.category === "company_overview")
      ?? humanPages.find((page) => page.title === "Company Overview")
      ?? null;

    const entityPageById = new Map(entityPages.map((page) => [page.page_id, page]));
    const entityPageByNodeId = new Map(
      entityPages
        .filter((page) => typeof page.node_id === "string" && page.node_id.length > 0)
        .map((page) => [page.node_id as string, page]),
    );
    const projectPages = entityPages.filter((page) => page.node_type === "project");
    const projectCategoryPages = humanPages.filter((page) =>
      PROJECT_CATEGORIES.includes(page.category as (typeof PROJECT_CATEGORIES)[number]),
    );

    const categoryLinkStats = projectCategoryPages.map((page) => {
      const linkedPages = (page.linked_entity_page_ids ?? [])
        .map((id) => entityPageById.get(id) ?? entityPageByNodeId.get(id) ?? null)
        .filter(Boolean) as EntityPageLike[];
      const byType = linkedPages.reduce<Record<string, number>>((acc, linkedPage) => {
        acc[linkedPage.node_type] = (acc[linkedPage.node_type] ?? 0) + 1;
        return acc;
      }, {});
      return {
        category: page.category,
        title: page.title,
        linked_total: linkedPages.length,
        linked_project_count: byType.project ?? 0,
        linked_team_member_count: byType.team_member ?? 0,
        linked_other_count: linkedPages.length - (byType.project ?? 0) - (byType.team_member ?? 0),
        linked_project_titles: linkedPages
          .filter((linkedPage) => linkedPage.node_type === "project")
          .map((linkedPage) => linkedPage.title)
          .sort((a, b) => a.localeCompare(b)),
      };
    });

    const missingProjects: Array<{ category: string; name: string }> = [];
    const wrongCategoryProjects: Array<{ name: string; expected_category: string; actual_categories: string[]; matched_page: string }> = [];

    for (const gtProject of gtProjects) {
      const { page, score } = pickBestMatch(gtProject.canonicalName, projectPages);
      if (!page || score < 0.62) {
        missingProjects.push({
          category: gtProject.category,
          name: gtProject.canonicalName,
        });
        continue;
      }

      const actualCategories = categoryLinkStats
        .filter((stat) =>
          stat.linked_project_titles.some((title) => normalizeText(title) === normalizeText(page.title)),
        )
        .map((stat) => stat.category);

      const expectedCategory = normalizeProjectCategory(gtProject.category);
      if (!actualCategories.includes(expectedCategory)) {
        wrongCategoryProjects.push({
          name: gtProject.canonicalName,
          expected_category: gtProject.category,
          actual_categories: actualCategories,
          matched_page: page.title,
        });
      }
    }

    const weakProjectHubs = categoryLinkStats.filter((stat) =>
      stat.linked_total > 0 && stat.linked_project_count <= stat.linked_team_member_count,
    );

    const failures: string[] = [];
    if (missingRepos.length > 0) {
      failures.push(`Missing repo pages: ${missingRepos.join(", ")}`);
    }
    if (!companyOverview) {
      failures.push("Company Overview page is missing.");
    } else if (isPlaceholderHumanPage(companyOverview)) {
      failures.push("Company Overview page is still placeholder text.");
    }
    if (missingProjects.length > 0) {
      failures.push(`Missing GT project pages: ${missingProjects.slice(0, 8).map((item) => item.name).join(", ")}`);
    }
    if (wrongCategoryProjects.length > 0) {
      failures.push(`Projects in wrong category hubs: ${wrongCategoryProjects.slice(0, 8).map((item) => item.name).join(", ")}`);
    }
    if (weakProjectHubs.length > 0) {
      failures.push(`Project hubs not project-led: ${weakProjectHubs.map((hub) => hub.category).join(", ")}`);
    }

    const result = {
      ok: failures.length === 0,
      company_slug: companySlug,
      run_id: runId,
      latest_slice: {
        entity_pages_execution_id: step14ExecId,
        human_pages_execution_id: step15ExecId,
      },
      repo_pages: {
        expected_from_gt: gtRepos,
        found_titles: repoTitles,
        missing_short_names: missingRepos,
      },
      company_overview: {
        exists: Boolean(companyOverview),
        placeholder: isPlaceholderHumanPage(companyOverview),
        title: companyOverview?.title ?? null,
      },
      project_buckets: {
        gt_total_projects: gtProjects.length,
        found_project_page_count: projectPages.length,
        missing_projects: missingProjects,
        wrong_category_projects: wrongCategoryProjects,
      },
      human_project_hubs: categoryLinkStats,
      failures,
      summary:
        failures.length === 0
          ? "Final KB audit passed."
          : "Final KB audit failed. See failures for missing repos, placeholder company overview, and project bucket mismatches.",
    };

    const output = JSON.stringify(result, null, 2);
    if (result.ok) {
      console.log(output);
    } else {
      console.error(output);
      process.exitCode = 1;
    }
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
