import type { KB2ParsedDocument, KB2ParsedSection } from "./confluence-parser";
import { htmlToText, splitIntoSections } from "./confluence-parser";
import {
  buildStructuredDataFromHumanText,
  compareHumanTextAndStructuredData,
  getStructuredItemCount,
  parseStructuredDataToParsedDocuments as parseLegacyStructuredDataToParsedDocuments,
} from "./human-text-structured-input";
import type { KB2SourceUnit } from "./pass1-v2-artifacts";

type InputSource =
  | "confluence"
  | "jira"
  | "slack"
  | "github"
  | "customerFeedback";

interface StructuredSlackMessage {
  message_id: string;
  speaker: string;
  timestamp_label: string;
  timestamp: string;
  text: string;
}

interface StructuredSlackConversation {
  conversation_id: string;
  channel_id?: string;
  channel_name: string;
  occurred_at: string;
  messages: StructuredSlackMessage[];
}

interface StructuredGithubComment {
  comment_id: string;
  author: string;
  created: string;
  body: string;
}

interface StructuredGithubPullRequest {
  pr_id: string;
  number: number;
  title: string;
  repository: string;
  branch: string;
  author: string;
  created: string;
  merged: string;
  status: string;
  reviewers: string[];
  description: string;
  files_changed: string[];
  review_comments: StructuredGithubComment[];
  commits?: { commit_id: string; sha: string; message: string }[];
}

interface StructuredJiraComment {
  comment_id: string;
  author: string;
  created: string;
  body: string;
}

interface StructuredJiraIssue {
  issue_id: string;
  key: string;
  title: string;
  issue_type: string;
  status: string;
  priority: string;
  assignee: string | null;
  reporter: string;
  created: string;
  resolved: string;
  sprint: string;
  description: string;
  comments: StructuredJiraComment[];
}

interface StructuredConfluenceDoc {
  document_id: string;
  title: string;
  space: string;
  author: string;
  created: string;
  last_updated: string;
  labels: string[];
  content: string;
  sections: Array<KB2ParsedSection & { section_id?: string }>;
}

interface StructuredFeedbackSubmission {
  submission_id: number;
  name: string;
  email: string;
  date: string;
  subject: string;
  message: string;
  status?: string;
  priority?: string;
  channel?: string;
}

interface StructuredEnvelope {
  format: string;
  source: InputSource;
  generated_from: "human_text" | "native_json";
  raw_char_count?: number;
  items: unknown[];
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function toDateLabel(ts: string | undefined): string {
  if (!ts) return "";
  const ms = Number.parseFloat(ts) * 1000;
  if (Number.isNaN(ms)) return "";
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16);
}

function toIsoDate(ts: string | undefined): string {
  if (!ts) return "";
  const ms = Number.parseFloat(ts) * 1000;
  if (Number.isNaN(ms)) return "";
  return new Date(ms).toISOString();
}

function normalizeSlackSpeaker(name: string, userMap: Record<string, { real_name?: string; name?: string }> = {}): string {
  const hit = userMap[name];
  return hit?.real_name ?? hit?.name ?? name;
}

function normalizeStructuredSections(content: string, title: string): StructuredConfluenceDoc["sections"] {
  return splitIntoSections(content).map((section, index) => ({
    ...section,
    section_id: `${slugify(title)}:section:${index + 1}`,
  }));
}

function buildConfluenceStructuredDataFromJson(json: unknown): StructuredEnvelope | null {
  if (!json || typeof json !== "object") return null;
  const data = json as Record<string, unknown>;
  const pages = Array.isArray(data.results)
    ? data.results as Array<Record<string, any>>
    : Array.isArray(json)
      ? json as Array<Record<string, any>>
      : ("id" in data && "title" in data ? [data as Record<string, any>] : []);

  const items: StructuredConfluenceDoc[] = pages
    .filter((page) => page.title && page.body?.storage?.value)
    .map((page) => {
      const content = htmlToText(page.body.storage.value);
      const author =
        page.version?.by?.displayName ??
        page.history?.createdBy?.displayName ??
        "";
      return {
        document_id: `confluence-${page.id ?? slugify(page.title)}`,
        title: page.title,
        space: page.space?.name ?? page.space?.key ?? "",
        author,
        created: page.history?.createdDate ?? "",
        last_updated: page.version?.when ?? "",
        labels: Array.isArray(page.metadata?.labels?.results)
          ? page.metadata.labels.results.map((label: any) => String(label.name ?? "")).filter(Boolean)
          : [],
        content,
        sections: normalizeStructuredSections(content, page.title),
      };
    });

  return {
    format: "kb2_source_structured_v2",
    source: "confluence",
    generated_from: "native_json",
    items,
  };
}

function buildJiraStructuredDataFromJson(json: unknown): StructuredEnvelope | null {
  if (!json || typeof json !== "object") return null;
  const data = json as Record<string, unknown>;
  const issues = Array.isArray(data.issues)
    ? data.issues as Array<Record<string, any>>
    : Array.isArray(json)
      ? json as Array<Record<string, any>>
      : ("key" in data && "fields" in data ? [data as Record<string, any>] : []);

  const items: StructuredJiraIssue[] = issues
    .filter((issue) => issue.key && issue.fields?.summary)
    .map((issue) => ({
      issue_id: `jira-${issue.key}`,
      key: issue.key,
      title: issue.fields.summary,
      issue_type: issue.fields.issuetype?.name ?? "",
      status: issue.fields.status?.name ?? "",
      priority: issue.fields.priority?.name ?? "",
      assignee: issue.fields.assignee?.displayName ?? null,
      reporter: issue.fields.reporter?.displayName ?? "",
      created: issue.fields.created ?? "",
      resolved: issue.fields.resolutiondate ?? "",
      sprint: issue.fields.customfield_sprint ?? issue.fields.sprint ?? "",
      description: issue.fields.description ?? "",
      comments: (issue.fields.comment?.comments ?? []).map((comment: any, index: number) => ({
        comment_id: `jira-${issue.key}-comment-${index + 1}`,
        author: comment.author?.displayName ?? "",
        created: comment.created ?? "",
        body: comment.body ?? "",
      })),
    }));

  return {
    format: "kb2_source_structured_v2",
    source: "jira",
    generated_from: "native_json",
    items,
  };
}

function groupSlackMessagesIntoConversations(
  channelId: string,
  channelName: string,
  messages: Array<Record<string, any>>,
  userMap: Record<string, { real_name?: string; name?: string }>,
): StructuredSlackConversation[] {
  const sorted = [...messages]
    .filter((message) => typeof message.text === "string" && message.text.trim().length > 0)
    .sort((a, b) => Number.parseFloat(a.ts ?? "0") - Number.parseFloat(b.ts ?? "0"));

  const groups: Array<Array<Record<string, any>>> = [];
  let current: Array<Record<string, any>> = [];

  for (const message of sorted) {
    if (current.length === 0) {
      current.push(message);
      continue;
    }
    const prevTs = Number.parseFloat(current[current.length - 1].ts ?? "0");
    const nextTs = Number.parseFloat(message.ts ?? "0");
    const prevDate = new Date(prevTs * 1000).toISOString().slice(0, 10);
    const nextDate = new Date(nextTs * 1000).toISOString().slice(0, 10);
    const sameThread = message.thread_ts && current[0].thread_ts && message.thread_ts === current[0].thread_ts;
    const gapHours = (nextTs - prevTs) / 3600;
    if (!sameThread && (prevDate !== nextDate || gapHours > 6)) {
      groups.push(current);
      current = [message];
      continue;
    }
    current.push(message);
  }
  if (current.length > 0) groups.push(current);

  return groups.map((group, index) => {
    const occurredAt = toDateLabel(group[0]?.thread_ts ?? group[0]?.ts);
    const conversationId = `slack-${channelName}-${slugify(occurredAt || `${index + 1}`)}`;
    return {
      conversation_id: conversationId,
      channel_id: channelId,
      channel_name: channelName,
      occurred_at: occurredAt,
      messages: group.map((message, messageIndex) => {
        const speakerKey = message.user_profile?.name ?? message.user ?? "unknown";
        const timestamp = toIsoDate(message.ts);
        return {
          message_id: `${conversationId}:message:${messageIndex + 1}`,
          speaker: normalizeSlackSpeaker(speakerKey, userMap),
          timestamp_label: toDateLabel(message.ts),
          timestamp,
          text: String(message.text ?? "").trim(),
        };
      }),
    };
  });
}

function buildSlackStructuredDataFromJson(json: unknown): StructuredEnvelope | null {
  if (!json || typeof json !== "object") return null;
  const data = json as Record<string, any>;
  const channels = Array.isArray(data.messages_by_channel) ? data.messages_by_channel : [];
  const userMap = (data.user_map ?? {}) as Record<string, { real_name?: string; name?: string }>;
  const items: StructuredSlackConversation[] = [];

  for (const channelEntry of channels) {
    const channelId = channelEntry.channel?.id ?? channelEntry.channel?.name ?? "channel";
    const channelName = channelEntry.channel?.name ?? channelId;
    const conversations = groupSlackMessagesIntoConversations(
      channelId,
      channelName,
      channelEntry.messages ?? [],
      userMap,
    );
    items.push(...conversations);
  }

  return {
    format: "kb2_source_structured_v2",
    source: "slack",
    generated_from: "native_json",
    items,
  };
}

function buildGithubStructuredDataFromJson(json: unknown): StructuredEnvelope | null {
  if (!json || typeof json !== "object") return null;
  const data = json as Record<string, any>;
  const repos = Array.isArray(data.repos) ? data.repos : [];
  const items: StructuredGithubPullRequest[] = [];

  for (const repo of repos) {
    const repoName = repo.repo?.name ? String(repo.repo.name) : "";
    for (const pr of repo.pull_requests ?? []) {
      items.push({
        pr_id: `github-${slugify(repoName || "repo")}-pr-${pr.number}`,
        number: Number(pr.number),
        title: String(pr.title ?? `PR #${pr.number}`),
        repository: repoName,
        branch: [pr.head, pr.base].filter(Boolean).join(" -> "),
        author: String(pr.author ?? ""),
        created: String(pr.created_at ?? ""),
        merged: String(pr.merged_at ?? ""),
        status: String(pr.state ?? ""),
        reviewers: Array.from(new Set((pr.comments ?? []).map((comment: any) => String(comment.author ?? "")).filter(Boolean))),
        description: String(pr.body ?? ""),
        files_changed: Array.isArray(pr.changed_files)
          ? pr.changed_files.map((file: any) => String(file.path ?? file.filename ?? "")).filter(Boolean)
          : [],
        review_comments: (pr.comments ?? []).map((comment: any, index: number) => ({
          comment_id: `github-${repoName}-pr-${pr.number}-comment-${index + 1}`,
          author: String(comment.author ?? ""),
          created: String(comment.created_at ?? ""),
          body: String(comment.body ?? ""),
        })),
        commits: (pr.commits ?? []).map((commit: any, index: number) => ({
          commit_id: `github-${repoName}-pr-${pr.number}-commit-${index + 1}`,
          sha: String(commit.sha ?? ""),
          message: String(commit.message ?? ""),
        })),
      });
    }
  }

  return {
    format: "kb2_source_structured_v2",
    source: "github",
    generated_from: "native_json",
    items,
  };
}

function buildFeedbackStructuredDataFromJson(json: unknown): StructuredEnvelope | null {
  if (!json || typeof json !== "object") return null;
  const data = json as Record<string, any>;
  const tickets = Array.isArray(data.tickets)
    ? data.tickets as Array<Record<string, any>>
    : Array.isArray(json)
      ? json as Array<Record<string, any>>
      : [];

  const items: StructuredFeedbackSubmission[] = tickets
    .filter((ticket) => ticket.subject)
    .map((ticket) => ({
      submission_id: Number(ticket.id),
      name: String(ticket.requester?.name ?? ""),
      email: String(ticket.requester?.email ?? ticket.requester?.external_id ?? ""),
      date: String(ticket.created_at ?? "").slice(0, 10),
      subject: String(ticket.subject ?? ""),
      message: String(ticket.description ?? ""),
      status: String(ticket.status ?? ""),
      priority: String(ticket.priority ?? ""),
      channel: String(ticket.via?.channel ?? ""),
    }));

  return {
    format: "kb2_source_structured_v2",
    source: "customerFeedback",
    generated_from: "native_json",
    items,
  };
}

export function buildStructuredDataFromNativeJson(
  source: string,
  data: unknown,
): StructuredEnvelope | null {
  switch (source as InputSource) {
    case "confluence":
      return buildConfluenceStructuredDataFromJson(data);
    case "jira":
      return buildJiraStructuredDataFromJson(data);
    case "slack":
      return buildSlackStructuredDataFromJson(data);
    case "github":
      return buildGithubStructuredDataFromJson(data);
    case "customerFeedback":
      return buildFeedbackStructuredDataFromJson(data);
    default:
      return null;
  }
}

export function buildStructuredDataFromInput(
  source: string,
  data: unknown,
): StructuredEnvelope | null {
  if (typeof data === "string") {
    const structured = buildStructuredDataFromHumanText(source, data) as StructuredEnvelope | null;
    if (!structured) return null;
    return {
      ...structured,
      format: structured.format ?? "kb2_source_structured_v2",
      generated_from: "human_text",
    };
  }
  return buildStructuredDataFromNativeJson(source, data);
}

function buildSourceUnitsForStructuredItem(
  source: string,
  item: any,
): KB2SourceUnit[] {
  switch (source as InputSource) {
    case "confluence":
      return (item.sections ?? []).map((section: any, index: number) => ({
        unit_id: String(section.section_id ?? `${item.document_id}:section:${index + 1}`),
        parent_doc_id: String(item.document_id),
        provider: "confluence",
        kind: "section",
        anchor: `${item.document_id}#section-${index + 1}`,
        title: String(section.heading ?? item.title),
        text: String(section.content ?? ""),
        order: index,
        metadata: {
          author: item.author,
          created: item.created,
          last_updated: item.last_updated,
        },
      }));
    case "jira": {
      const units: KB2SourceUnit[] = [];
      if (item.description) {
        units.push({
          unit_id: `${item.issue_id}:description`,
          parent_doc_id: String(item.issue_id),
          provider: "jira",
          kind: "issue_description",
          anchor: `${item.key}#description`,
          title: `${item.key} Description`,
          text: String(item.description),
          order: 0,
          metadata: {
            issue_key: item.key,
            status: item.status,
            assignee: item.assignee,
            reporter: item.reporter,
          },
        });
      }
      for (const [index, comment] of (item.comments ?? []).entries()) {
        units.push({
          unit_id: String(comment.comment_id ?? `${item.issue_id}:comment:${index + 1}`),
          parent_doc_id: String(item.issue_id),
          provider: "jira",
          kind: "comment",
          anchor: `${item.key}#comment-${index + 1}`,
          title: `${item.key} Comment ${index + 1}`,
          text: String(comment.body ?? ""),
          order: index + 1,
          metadata: {
            comment_author: comment.author,
            timestamp: comment.created,
            issue_key: item.key,
            status: item.status,
          },
        });
      }
      return units;
    }
    case "slack":
      return (item.messages ?? []).map((message: StructuredSlackMessage, index: number) => ({
        unit_id: String(message.message_id ?? `${item.conversation_id}:message:${index + 1}`),
        parent_doc_id: String(item.conversation_id),
        provider: "slack",
        kind: "message",
        anchor: `${item.conversation_id}#message-${index + 1}`,
        title: `#${item.channel_name} Message ${index + 1}`,
        text: String(message.text ?? ""),
        order: index,
        metadata: {
          speaker: message.speaker,
          timestamp: message.timestamp ?? message.timestamp_label,
          channel_name: item.channel_name,
          occurred_at: item.occurred_at,
        },
      }));
    case "github": {
      const units: KB2SourceUnit[] = [];
      if (item.description) {
        units.push({
          unit_id: `${item.pr_id}:description`,
          parent_doc_id: String(item.pr_id),
          provider: "github",
          kind: "pr_description",
          anchor: `${item.repository}/pull/${item.number}#description`,
          title: `${item.repository} PR #${item.number} Description`,
          text: String(item.description),
          order: 0,
          metadata: {
            author: item.author,
            reviewers: item.reviewers,
            status: item.status,
          },
        });
      }
      for (const [index, comment] of (item.review_comments ?? []).entries()) {
        units.push({
          unit_id: String(comment.comment_id ?? `${item.pr_id}:comment:${index + 1}`),
          parent_doc_id: String(item.pr_id),
          provider: "github",
          kind: "review_comment",
          anchor: `${item.repository}/pull/${item.number}#comment-${index + 1}`,
          title: `${item.repository} PR #${item.number} Review Comment ${index + 1}`,
          text: String(comment.body ?? ""),
          order: index + 1,
          metadata: {
            reviewer: comment.author,
            comment_author: comment.author,
            timestamp: comment.created,
            reviewers: item.reviewers,
          },
        });
      }
      for (const [index, commit] of (item.commits ?? []).entries()) {
        units.push({
          unit_id: String(commit.commit_id ?? `${item.pr_id}:commit:${index + 1}`),
          parent_doc_id: String(item.pr_id),
          provider: "github",
          kind: "commit",
          anchor: `${item.repository}/pull/${item.number}#commit-${index + 1}`,
          title: `${item.repository} PR #${item.number} Commit ${index + 1}`,
          text: String(commit.message ?? ""),
          order: (item.review_comments?.length ?? 0) + index + 1,
          metadata: {
            author: item.author,
            sha: commit.sha,
          },
        });
      }
      return units;
    }
    case "customerFeedback":
      return [{
        unit_id: `feedback-${item.submission_id}:submission`,
        parent_doc_id: `feedback-${item.submission_id}`,
        provider: "customerFeedback",
        kind: "submission",
        anchor: `feedback-${item.submission_id}`,
        title: item.subject || `Feedback #${item.submission_id}`,
        text: String(item.message ?? ""),
        order: 0,
        metadata: {
          author: item.name,
          timestamp: item.date,
          channel: item.channel,
          status: item.status,
          priority: item.priority,
        },
      }];
    default:
      return [];
  }
}

function attachStructuredUnitsToParsedDocs(
  source: string,
  structuredData: StructuredEnvelope,
  docs: KB2ParsedDocument[],
): KB2ParsedDocument[] {
  if (!structuredData || !Array.isArray(structuredData.items)) return docs;

  const unitsByDocId = new Map<string, KB2SourceUnit[]>();
  for (const item of structuredData.items as any[]) {
    const docId = (() => {
      switch (source as InputSource) {
        case "confluence":
          return item.document_id;
        case "jira":
          return item.issue_id;
        case "slack":
          return item.conversation_id;
        case "github":
          return item.pr_id;
        case "customerFeedback":
          return `feedback-${item.submission_id}`;
        default:
          return "";
      }
    })();
    unitsByDocId.set(String(docId), buildSourceUnitsForStructuredItem(source, item));
  }

  return docs.map((doc) => ({
    ...doc,
    metadata: {
      ...(doc.metadata ?? {}),
      structured_input: true,
      structured_origin: structuredData.generated_from,
      structured_format: structuredData.format,
      source_units: unitsByDocId.get(doc.id) ?? [],
    },
  }));
}

export function parseStructuredDataToParsedDocuments(
  source: string,
  structuredData: unknown,
): KB2ParsedDocument[] {
  const docs = parseLegacyStructuredDataToParsedDocuments(source, structuredData);
  if (!structuredData || typeof structuredData !== "object") return docs;
  return attachStructuredUnitsToParsedDocs(source, structuredData as StructuredEnvelope, docs);
}

export function getStructuredDataItemCount(data: unknown): number {
  return getStructuredItemCount(data);
}

export function compareTextToStructuredData(
  source: string,
  text: string,
  structuredData: unknown,
) {
  return compareHumanTextAndStructuredData(source, text, structuredData);
}
