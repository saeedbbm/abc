/**
 * Parses the Pidrax GitHub sync format into structured documents.
 * Produces one document per: file with content, PR, and standalone commit.
 */

import { splitIntoSections } from "./confluence-parser";
import type { KB2ParsedDocument } from "./confluence-parser";

interface GHFile {
  path: string;
  language?: string;
  content?: string;
  inferred?: boolean;
}

interface GHCommit {
  sha: string;
  author?: { name?: string; email?: string };
  date?: string;
  branch?: string;
  message?: string;
}

interface GHPRComment {
  author?: string;
  created_at?: string;
  body?: string;
}

interface GHPR {
  number: number;
  title: string;
  state?: string;
  base?: string;
  head?: string;
  author?: string;
  created_at?: string;
  updated_at?: string;
  merged_at?: string;
  body?: string;
  files_changed?: number;
  commits?: { sha: string; message: string }[];
  comments?: GHPRComment[];
}

interface GHRepo {
  repo: { name: string; default_branch?: string; visibility?: string };
  directory_tree?: { path?: string; entries?: { type: string; path: string }[] };
  files?: GHFile[];
  pull_requests?: GHPR[];
  commits?: GHCommit[];
}

function buildTreeText(entries: { type: string; path: string }[]): string {
  return entries.map((e) => `${e.type === "dir" ? "📁" : "📄"} ${e.path}`).join("\n");
}

export function parseGithubApiResponse(json: unknown): KB2ParsedDocument[] {
  if (!json || typeof json !== "object") return [];

  const data = json as Record<string, unknown>;
  const repos = (data.repos ?? []) as GHRepo[];
  if (repos.length === 0) return [];

  const docs: KB2ParsedDocument[] = [];

  for (const repo of repos) {
    const repoName = repo.repo.name;

    // Repo overview doc (directory tree)
    if (repo.directory_tree?.entries?.length) {
      const treeContent = `# ${repoName} — Directory Structure\n\n${buildTreeText(repo.directory_tree.entries)}`;
      docs.push({
        id: `github-${repoName}-tree`,
        provider: "github",
        sourceType: "repo_tree",
        sourceId: `${repoName}/tree`,
        title: `${repoName} — Directory Structure`,
        content: treeContent,
        sections: splitIntoSections(treeContent),
        metadata: { repo: repoName, type: "tree", fileCount: repo.directory_tree.entries.filter((e) => e.type === "file").length },
      });
    }

    // Files with content
    for (const file of repo.files ?? []) {
      if (!file.content) continue;
      const lang = file.language ?? file.path.split(".").pop() ?? "";
      const fileContent = `# ${repoName}/${file.path}\n\n\`\`\`${lang}\n${file.content}\`\`\``;
      docs.push({
        id: `github-${repoName}-${file.path.replace(/\//g, "-")}`,
        provider: "github",
        sourceType: "file",
        sourceId: `${repoName}/${file.path}`,
        title: `${repoName}/${file.path}`,
        content: fileContent,
        sections: splitIntoSections(fileContent),
        metadata: { repo: repoName, path: file.path, language: lang },
      });
    }

    // Pull requests
    for (const pr of repo.pull_requests ?? []) {
      const parts: string[] = [];
      parts.push(`# PR #${pr.number}: ${pr.title}`);
      parts.push("");
      const meta = [`State: ${pr.state ?? "unknown"}`, `Author: ${pr.author ?? "unknown"}`];
      if (pr.base) meta.push(`Base: ${pr.base}`);
      if (pr.head) meta.push(`Head: ${pr.head}`);
      parts.push(meta.join(" | "));
      parts.push("");
      if (pr.body) { parts.push(pr.body); parts.push(""); }
      if (pr.commits?.length) {
        parts.push("## Commits");
        for (const c of pr.commits) parts.push(`- \`${c.sha.slice(0, 7)}\` ${c.message}`);
        parts.push("");
      }
      if (pr.comments?.length) {
        parts.push("## Review Comments");
        for (const c of pr.comments) {
          parts.push(`**${c.author ?? "unknown"}** (${c.created_at?.split("T")[0] ?? ""}):`);
          parts.push(c.body ?? "");
          parts.push("");
        }
      }

      const prContent = parts.join("\n").trim();
      docs.push({
        id: `github-${repoName}-pr-${pr.number}`,
        provider: "github",
        sourceType: "pull_request",
        sourceId: `${repoName}/pull/${pr.number}`,
        title: `${repoName} PR #${pr.number}: ${pr.title}`,
        content: prContent,
        sections: splitIntoSections(prContent),
        metadata: {
          repo: repoName, prNumber: pr.number, state: pr.state,
          author: pr.author, base: pr.base, head: pr.head,
          created: pr.created_at, merged: pr.merged_at,
        },
      });
    }
  }

  return docs;
}
