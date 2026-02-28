/**
 * Parses real Jira REST API responses into structured documents.
 */

import type { KB2ParsedDocument } from "./confluence-parser";

interface JiraComment {
  author?: { displayName?: string };
  created?: string;
  body?: string;
}

interface JiraIssue {
  id?: string;
  key: string;
  fields: {
    summary: string;
    issuetype?: { name?: string };
    status?: { name?: string };
    priority?: { name?: string };
    assignee?: { displayName?: string } | null;
    reporter?: { displayName?: string };
    created?: string;
    updated?: string;
    labels?: string[];
    description?: string;
    comment?: { comments?: JiraComment[] };
    [key: string]: unknown;
  };
}

export function parseJiraApiResponse(json: unknown): KB2ParsedDocument[] {
  if (!json || typeof json !== "object") return [];

  let issues: JiraIssue[] = [];
  if (Array.isArray(json)) {
    issues = json;
  } else if ("issues" in (json as any) && Array.isArray((json as any).issues)) {
    issues = (json as any).issues;
  } else if ("key" in (json as any) && "fields" in (json as any)) {
    issues = [json as JiraIssue];
  }

  return issues
    .filter((issue) => issue.key && issue.fields?.summary)
    .map((issue) => {
      const f = issue.fields;
      const parts: string[] = [];

      parts.push(`# ${issue.key}: ${f.summary}`);
      parts.push("");

      const meta: string[] = [];
      if (f.issuetype?.name) meta.push(`Type: ${f.issuetype.name}`);
      if (f.status?.name) meta.push(`Status: ${f.status.name}`);
      if (f.priority?.name) meta.push(`Priority: ${f.priority.name}`);
      if (f.assignee?.displayName) meta.push(`Assignee: ${f.assignee.displayName}`);
      if (f.reporter?.displayName) meta.push(`Reporter: ${f.reporter.displayName}`);
      if (meta.length > 0) {
        parts.push(meta.join(" | "));
        parts.push("");
      }

      if (f.description) {
        parts.push("## Description");
        parts.push(f.description);
        parts.push("");
      }

      const comments = f.comment?.comments ?? [];
      if (comments.length > 0) {
        parts.push("## Comments");
        for (const c of comments) {
          const who = c.author?.displayName ?? "Unknown";
          const when = c.created ? c.created.split("T")[0] : "";
          parts.push(`**${who}** ${when ? `(${when})` : ""}:`);
          parts.push(c.body ?? "");
          parts.push("");
        }
      }

      return {
        id: `jira-${issue.key}`,
        provider: "jira",
        sourceType: f.issuetype?.name?.toLowerCase() ?? "issue",
        sourceId: issue.key,
        title: `${issue.key}: ${f.summary}`,
        content: parts.join("\n").trim(),
        metadata: {
          key: issue.key,
          issueType: f.issuetype?.name,
          status: f.status?.name,
          priority: f.priority?.name,
          assignee: f.assignee?.displayName ?? null,
          reporter: f.reporter?.displayName,
          created: f.created,
          updated: f.updated,
          labels: f.labels,
          commentCount: comments.length,
        },
      };
    });
}
