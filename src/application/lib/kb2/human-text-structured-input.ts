import type { KB2ParsedDocument, KB2ParsedSection } from "./confluence-parser";
import { splitIntoSections } from "./confluence-parser";

const BLOCK_SEP = /^={70,}$/m;

type HumanTextSource =
  | "confluence"
  | "jira"
  | "slack"
  | "github"
  | "customerFeedback";

interface StructuredConfluenceDoc {
  document_id: string;
  title: string;
  space: string;
  author: string;
  created: string;
  last_updated: string;
  labels: string[];
  content: string;
  sections: KB2ParsedSection[];
}

interface StructuredJiraComment {
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

interface StructuredGithubComment {
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
}

interface StructuredSlackMessage {
  speaker: string;
  timestamp_label: string;
  text: string;
}

interface StructuredSlackConversation {
  conversation_id: string;
  channel_name: string;
  occurred_at: string;
  messages: StructuredSlackMessage[];
}

interface StructuredFeedbackSubmission {
  submission_id: number;
  name: string;
  email: string;
  date: string;
  subject: string;
  message: string;
}

interface StructuredHumanEnvelope {
  format: "kb2_human_text_structured_v1";
  source: HumanTextSource;
  generated_from: "human_text";
  raw_char_count: number;
  items:
    | StructuredConfluenceDoc[]
    | StructuredJiraIssue[]
    | StructuredGithubPullRequest[]
    | StructuredSlackConversation[]
    | StructuredFeedbackSubmission[];
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function splitBlocks(text: string): string[] {
  return normalizeLineEndings(text)
    .split(BLOCK_SEP)
    .map((part) => part.trim())
    .filter(Boolean);
}

function extractField(block: string, field: string): string {
  const re = new RegExp(`^${field}:\\s*(.+)$`, "mi");
  const match = block.match(re);
  return match ? match[1].trim() : "";
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function splitHumanSections(content: string): KB2ParsedSection[] {
  const lines = content.split("\n");
  const sections: KB2ParsedSection[] = [];
  let currentHeading = "(intro)";
  let currentLines: string[] = [];
  let sectionStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const nextLine = i + 1 < lines.length ? lines[i + 1] : "";

    if (/^#{1,4}\s+.+$/.test(line)) {
      if (currentLines.length > 0) {
        const text = currentLines.join("\n").trim();
        if (text) {
          sections.push({
            heading: currentHeading,
            content: text,
            start_offset: sectionStart,
            end_offset: sectionStart + text.length,
          });
        }
      }
      currentHeading = line.replace(/^#{1,4}\s+/, "").trim();
      currentLines = [line];
      sectionStart = content.indexOf(line, Math.max(0, sectionStart));
      continue;
    }

    if (
      nextLine &&
      /^[=-]{3,}$/.test(nextLine) &&
      line.trim().length > 0 &&
      !/^[-=]{3,}$/.test(line)
    ) {
      if (currentLines.length > 0) {
        const text = currentLines.join("\n").trim();
        if (text) {
          sections.push({
            heading: currentHeading,
            content: text,
            start_offset: sectionStart,
            end_offset: sectionStart + text.length,
          });
        }
      }
      currentHeading = line.trim();
      currentLines = [line, nextLine];
      sectionStart = content.indexOf(line, Math.max(0, sectionStart));
      i++;
      continue;
    }

    currentLines.push(line);
  }

  if (currentLines.length > 0) {
    const text = currentLines.join("\n").trim();
    if (text) {
      sections.push({
        heading: currentHeading,
        content: text,
        start_offset: sectionStart,
        end_offset: sectionStart + text.length,
      });
    }
  }

  return sections.filter((section) => section.content.length > 0);
}

function parseBodyAfterMetadata(block: string, marker: string): string {
  const dashRe = /^-{40,}$/gm;
  const firstDash = dashRe.exec(block);
  const secondDash = firstDash ? dashRe.exec(block) : null;

  if (secondDash) {
    return block.slice(secondDash.index + secondDash[0].length).trim();
  }
  if (firstDash) {
    return block.slice(firstDash.index + firstDash[0].length).trim();
  }

  const markerIndex = block.indexOf(marker);
  return markerIndex >= 0 ? block.slice(markerIndex + marker.length).trim() : block.trim();
}

function parseStructuredCommentBlocks(text: string): StructuredJiraComment[] {
  if (!text.trim()) return [];

  const blocks = text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  return blocks.map((block) => {
    const lines = block.split("\n");
    const firstLine = lines[0]?.trim() ?? "";
    const rest = lines.slice(1).join("\n").trim();
    const match =
      firstLine.match(/^\*\*([^*]+)\*\*\s*(?:\(([^)]+)\))?:\s*(.*)$/) ??
      firstLine.match(/^([^:(\n]+?)\s*(?:\(([^)]+)\))?:\s*(.*)$/);

    if (!match) {
      return {
        author: "",
        created: "",
        body: block,
      };
    }

    const inlineBody = match[3]?.trim() ?? "";
    const body = [inlineBody, rest].filter(Boolean).join("\n").trim();
    return {
      author: (match[1] ?? "").trim(),
      created: (match[2] ?? "").trim(),
      body,
    };
  });
}

function buildConfluenceStructuredInput(text: string): StructuredHumanEnvelope {
  const items: StructuredConfluenceDoc[] = [];

  for (const block of splitBlocks(text)) {
    const docMatch = block.match(/^DOCUMENT:\s*(.+)$/m);
    if (!docMatch) continue;

    const title = docMatch[1].trim();
    const content = parseBodyAfterMetadata(block, title);
    items.push({
      document_id: `confluence-${slugify(title)}`,
      title,
      space: extractField(block, "Space"),
      author: extractField(block, "Author"),
      created: extractField(block, "Created"),
      last_updated: extractField(block, "Last Updated"),
      labels: extractField(block, "Labels")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      content,
      sections: splitHumanSections(content),
    });
  }

  return {
    format: "kb2_human_text_structured_v1",
    source: "confluence",
    generated_from: "human_text",
    raw_char_count: text.length,
    items,
  };
}

function buildJiraStructuredInput(text: string): StructuredHumanEnvelope {
  const items: StructuredJiraIssue[] = [];

  for (const block of splitBlocks(text)) {
    const keyMatch = block.match(/^([A-Z]+-\d+)\s*$/m);
    if (!keyMatch) continue;

    const key = keyMatch[1];
    const title = extractField(block, "Title");
    const commentMatch = block.match(/\nComments:\n([\s\S]*?)$/);
    const commentsText = commentMatch ? commentMatch[1].trim() : "";
    const descMatch = block.match(/\nDescription:\n([\s\S]*?)(?:\nComments:\n[\s\S]*?)?$/);
    const description = descMatch ? descMatch[1].trim() : "";

    items.push({
      issue_id: `jira-${key}`,
      key,
      title,
      issue_type: extractField(block, "Type"),
      status: extractField(block, "Status"),
      priority: extractField(block, "Priority"),
      assignee: extractField(block, "Assignee") || null,
      reporter: extractField(block, "Reporter"),
      created: extractField(block, "Created"),
      resolved: extractField(block, "Resolved"),
      sprint: extractField(block, "Sprint"),
      description,
      comments: parseStructuredCommentBlocks(commentsText),
    });
  }

  return {
    format: "kb2_human_text_structured_v1",
    source: "jira",
    generated_from: "human_text",
    raw_char_count: text.length,
    items,
  };
}

function buildGithubStructuredInput(text: string): StructuredHumanEnvelope {
  const items: StructuredGithubPullRequest[] = [];

  for (const block of splitBlocks(text)) {
    const prMatch = block.match(/^PR\s*#(\d+)\s*[—–-]\s*(.+)$/m);
    if (!prMatch) continue;

    const prNumber = Number(prMatch[1]);
    const title = prMatch[2].trim();
    const repository = extractField(block, "Repository");
    const commentsMatch = block.match(/\nReview Comments:\n([\s\S]*?)$/);
    const commentsText = commentsMatch ? commentsMatch[1].trim() : "";
    const filesMatch = block.match(/\nFiles changed:\n([\s\S]*?)(?:\nReview Comments:\n[\s\S]*?)?$/);
    const filesChangedText = filesMatch ? filesMatch[1].trim() : "";
    const descriptionMatch = block.match(/\nDescription:\n([\s\S]*?)(?:\nFiles changed:\n[\s\S]*?|\nReview Comments:\n[\s\S]*?)?$/);
    const description = descriptionMatch ? descriptionMatch[1].trim() : "";

    items.push({
      pr_id: `github-${slugify(repository || "repo")}-pr-${prNumber}`,
      number: prNumber,
      title,
      repository,
      branch: extractField(block, "Branch"),
      author: extractField(block, "Author"),
      created: extractField(block, "Created"),
      merged: extractField(block, "Merged"),
      status: extractField(block, "Status"),
      reviewers: extractField(block, "Reviewers")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      description,
      files_changed: filesChangedText
        .split("\n")
        .map((line) => line.replace(/^-\s*/, "").trim())
        .filter(Boolean),
      review_comments: parseStructuredCommentBlocks(commentsText).map((comment) => ({
        author: comment.author,
        created: comment.created,
        body: comment.body,
      })),
    });
  }

  return {
    format: "kb2_human_text_structured_v1",
    source: "github",
    generated_from: "human_text",
    raw_char_count: text.length,
    items,
  };
}

function buildSlackStructuredInput(text: string): StructuredHumanEnvelope {
  const items: StructuredSlackConversation[] = [];

  for (const block of splitBlocks(text)) {
    const headerMatch = block.match(/^#([^\s|]+)\s*\|\s*(.+)$/m);
    if (!headerMatch) continue;

    const channelName = headerMatch[1].trim();
    const occurredAt = headerMatch[2].trim();
    const body = parseBodyAfterMetadata(block, headerMatch[0]);
    const lines = body.split("\n");
    const messages: StructuredSlackMessage[] = [];
    let currentMessage: StructuredSlackMessage | null = null;

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (!line.trim()) continue;

      const match = line.match(/^([^:\n]+?)(?:\s*\[([^\]]+)\])?:\s*(.+)$/);
      if (match) {
        if (currentMessage) messages.push(currentMessage);
        currentMessage = {
          speaker: match[1].trim(),
          timestamp_label: (match[2] ?? "").trim(),
          text: match[3].trim(),
        };
      } else if (currentMessage) {
        currentMessage.text = `${currentMessage.text}\n${line.trim()}`.trim();
      } else {
        currentMessage = {
          speaker: "",
          timestamp_label: "",
          text: line.trim(),
        };
      }
    }

    if (currentMessage) messages.push(currentMessage);

    items.push({
      conversation_id: `slack-${channelName}-${slugify(occurredAt)}`,
      channel_name: channelName,
      occurred_at: occurredAt,
      messages,
    });
  }

  return {
    format: "kb2_human_text_structured_v1",
    source: "slack",
    generated_from: "human_text",
    raw_char_count: text.length,
    items,
  };
}

function buildFeedbackStructuredInput(text: string): StructuredHumanEnvelope {
  const items: StructuredFeedbackSubmission[] = [];

  for (const block of splitBlocks(text)) {
    const submissionMatch = block.match(/^Submission\s*#(\d+)/m);
    if (!submissionMatch) continue;

    items.push({
      submission_id: Number(submissionMatch[1]),
      name: extractField(block, "Name"),
      email: extractField(block, "Email"),
      date: extractField(block, "Date"),
      subject: extractField(block, "Subject"),
      message: (block.match(/\nMessage:\n([\s\S]*?)$/)?.[1] ?? "").trim(),
    });
  }

  return {
    format: "kb2_human_text_structured_v1",
    source: "customerFeedback",
    generated_from: "human_text",
    raw_char_count: text.length,
    items,
  };
}

export function buildStructuredDataFromHumanText(
  source: string,
  text: string,
): StructuredHumanEnvelope | null {
  switch (source as HumanTextSource) {
    case "confluence":
      return buildConfluenceStructuredInput(text);
    case "jira":
      return buildJiraStructuredInput(text);
    case "github":
      return buildGithubStructuredInput(text);
    case "slack":
      return buildSlackStructuredInput(text);
    case "customerFeedback":
      return buildFeedbackStructuredInput(text);
    default:
      return null;
  }
}

export function getStructuredItemCount(data: unknown): number {
  if (!data || typeof data !== "object") return 0;
  const items = (data as StructuredHumanEnvelope).items;
  return Array.isArray(items) ? items.length : 0;
}

interface StructuredComparisonResult {
  matches: boolean;
  original_item_count: number;
  structured_item_count: number;
  mismatch_count: number;
  first_mismatch?: {
    index: number;
    original: string;
    structured: string;
  };
}

function getSourceHeader(source: HumanTextSource): string {
  switch (source) {
    case "confluence":
      return "CONFLUENCE WIKI EXPORT";
    case "jira":
      return "JIRA TICKET EXPORT";
    case "github":
      return "GITHUB PR EXPORT";
    case "slack":
      return "SLACK EXPORT";
    case "customerFeedback":
      return "CUSTOMER FEEDBACK — WEB FORM SUBMISSIONS";
  }
}

function padField(field: string, value: string): string {
  return `${field.padEnd(14, " ")}${value}`;
}

function normalizeBlockForComparison(block: string): string {
  return normalizeLineEndings(block)
    .split("\n")
    .map((line) =>
      line
        .replace(/\s+$/g, "")
        .replace(/^([A-Za-z][A-Za-z ]*:)\s+/g, "$1 ")
        .replace(/^\s*>\s?/g, "> "),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isRecognizedBlock(source: HumanTextSource, block: string): boolean {
  switch (source) {
    case "confluence":
      return /^DOCUMENT:\s*(.+)$/m.test(block);
    case "jira":
      return /^([A-Z]+-\d+)\s*$/m.test(block);
    case "github":
      return /^PR\s*#(\d+)\s*[—–-]\s*(.+)$/m.test(block);
    case "slack":
      return /^#([^\s|]+)\s*\|\s*(.+)$/m.test(block);
    case "customerFeedback":
      return /^Submission\s*#(\d+)/m.test(block);
  }
}

function getOriginalItemBlocks(source: HumanTextSource, text: string): string[] {
  return splitBlocks(text)
    .filter((block) => isRecognizedBlock(source, block))
    .map((block) => normalizeBlockForComparison(block));
}

function renderConfluenceBlock(doc: StructuredConfluenceDoc): string {
  const lines = [
    "================================================================================",
    `DOCUMENT: ${doc.title}`,
    "--------------------------------------------------------------------------------",
    padField("Space:", doc.space),
    padField("Author:", doc.author),
    padField("Created:", doc.created),
    padField("Last Updated:", doc.last_updated),
    padField("Labels:", doc.labels.join(", ")),
    "",
    "--------------------------------------------------------------------------------",
    "",
    doc.content.trim(),
  ];
  return lines.join("\n").trim();
}

function renderJiraBlock(issue: StructuredJiraIssue): string {
  const lines = [
    "================================================================================",
    issue.key,
    "--------------------------------------------------------------------------------",
    padField("Title:", issue.title),
    padField("Type:", issue.issue_type),
    padField("Status:", issue.status),
    padField("Priority:", issue.priority),
    padField("Assignee:", issue.assignee ?? ""),
    padField("Reporter:", issue.reporter),
    padField("Created:", issue.created),
    ...(issue.resolved ? [padField("Resolved:", issue.resolved)] : []),
    padField("Sprint:", issue.sprint),
    "",
    "Description:",
    issue.description.trim(),
  ];

  if (issue.comments.length > 0) {
    lines.push("", "Comments:");
    for (const comment of issue.comments) {
      const header = [comment.author, comment.created ? `(${comment.created})` : ""]
        .filter(Boolean)
        .join(" ");
      lines.push(`${header}: ${comment.body}`.trim(), "");
    }
  }

  return lines.join("\n").trim();
}

function renderGithubBlock(pr: StructuredGithubPullRequest): string {
  const lines = [
    "================================================================================",
    `PR #${pr.number} — ${pr.title}`,
    "--------------------------------------------------------------------------------",
    padField("Repository:", pr.repository),
    padField("Branch:", pr.branch),
    padField("Author:", pr.author),
    padField("Created:", pr.created),
    padField("Merged:", pr.merged),
    padField("Status:", pr.status),
    padField("Reviewers:", pr.reviewers.join(", ")),
    "",
    "Description:",
    pr.description.trim(),
  ];

  if (pr.files_changed.length > 0) {
    lines.push("", "Files changed:");
    for (const file of pr.files_changed) lines.push(`- ${file}`);
  }

  if (pr.review_comments.length > 0) {
    lines.push("", "Review Comments:");
    for (const comment of pr.review_comments) {
      const header = [comment.author, comment.created ? `(${comment.created})` : ""]
        .filter(Boolean)
        .join(" ");
      lines.push("", `  ${header}:`);
      for (const bodyLine of comment.body.split("\n")) {
        lines.push(`  ${bodyLine.replace(/^\s+/, "")}`);
      }
    }
  }

  return lines.join("\n").trim();
}

function renderSlackBlock(conversation: StructuredSlackConversation): string {
  const lines = [
    "================================================================================",
    `#${conversation.channel_name} | ${conversation.occurred_at}`,
    "--------------------------------------------------------------------------------",
  ];

  for (const message of conversation.messages) {
    const speaker = message.speaker || "Unknown";
    if (message.timestamp_label) {
      lines.push(`${speaker} [${message.timestamp_label}]: ${message.text}`);
    } else {
      lines.push(`${speaker}: ${message.text}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

function renderFeedbackBlock(submission: StructuredFeedbackSubmission): string {
  const lines = [
    "================================================================================",
    `Submission #${submission.submission_id}`,
    "--------------------------------------------------------------------------------",
    padField("Name:", submission.name),
    padField("Email:", submission.email),
    padField("Date:", submission.date),
    padField("Subject:", submission.subject),
    "",
    "Message:",
    submission.message.trim(),
  ];

  return lines.join("\n").trim();
}

export function renderStructuredDataAsHumanText(
  source: string,
  data: unknown,
): string {
  if (!data || typeof data !== "object") return "";

  const envelope = data as StructuredHumanEnvelope;
  const typedSource = source as HumanTextSource;
  const renderedBlocks = (() => {
    switch (typedSource) {
      case "confluence":
        return (envelope.items as StructuredConfluenceDoc[]).map(renderConfluenceBlock);
      case "jira":
        return (envelope.items as StructuredJiraIssue[]).map(renderJiraBlock);
      case "github":
        return (envelope.items as StructuredGithubPullRequest[]).map(renderGithubBlock);
      case "slack":
        return (envelope.items as StructuredSlackConversation[]).map(renderSlackBlock);
      case "customerFeedback":
        return (envelope.items as StructuredFeedbackSubmission[]).map(renderFeedbackBlock);
      default:
        return [];
    }
  })();

  if (renderedBlocks.length === 0) return "";

  return [
    "================================================================================",
    `${getSourceHeader(typedSource)}`,
    "================================================================================",
    "",
    ...renderedBlocks.flatMap((block) => [block, ""]),
  ]
    .join("\n")
    .trim();
}

export function compareHumanTextAndStructuredData(
  source: string,
  text: string,
  data: unknown,
): StructuredComparisonResult {
  const typedSource = source as HumanTextSource;
  const originalBlocks = getOriginalItemBlocks(typedSource, text);
  const renderedText = renderStructuredDataAsHumanText(source, data);
  const structuredBlocks = getOriginalItemBlocks(typedSource, renderedText);

  const len = Math.max(originalBlocks.length, structuredBlocks.length);
  let firstMismatch: StructuredComparisonResult["first_mismatch"];
  let mismatchCount = 0;

  for (let i = 0; i < len; i++) {
    const original = originalBlocks[i] ?? "";
    const structured = structuredBlocks[i] ?? "";
    if (original !== structured) {
      mismatchCount++;
      if (!firstMismatch) {
        firstMismatch = {
          index: i,
          original: original.slice(0, 1000),
          structured: structured.slice(0, 1000),
        };
      }
    }
  }

  return {
    matches: mismatchCount === 0,
    original_item_count: originalBlocks.length,
    structured_item_count: structuredBlocks.length,
    mismatch_count: mismatchCount,
    ...(firstMismatch ? { first_mismatch: firstMismatch } : {}),
  };
}

function parseConfluenceStructuredData(data: StructuredHumanEnvelope): KB2ParsedDocument[] {
  const items = data.items as StructuredConfluenceDoc[];
  return items.map((doc) => ({
    id: doc.document_id,
    provider: "confluence",
    sourceType: "confluence_page",
    sourceId: doc.document_id,
    title: doc.title,
    content: doc.content,
    sections: doc.sections,
    metadata: {
      pageId: doc.document_id,
      space: doc.space,
      author: doc.author,
      created: doc.created,
      lastUpdated: doc.last_updated,
      labels: doc.labels,
      structured_input: true,
    },
  }));
}

function parseJiraStructuredData(data: StructuredHumanEnvelope): KB2ParsedDocument[] {
  const items = data.items as StructuredJiraIssue[];
  return items.map((issue) => {
    const parts: string[] = [];
    parts.push(`# ${issue.key}: ${issue.title}`);
    parts.push("");

    const meta = [
      issue.issue_type ? `Type: ${issue.issue_type}` : "",
      issue.status ? `Status: ${issue.status}` : "",
      issue.priority ? `Priority: ${issue.priority}` : "",
      issue.assignee ? `Assignee: ${issue.assignee}` : "",
      issue.reporter ? `Reporter: ${issue.reporter}` : "",
    ].filter(Boolean);
    if (meta.length > 0) {
      parts.push(meta.join(" | "));
      parts.push("");
    }
    if (issue.description) {
      parts.push("## Description");
      parts.push(issue.description);
      parts.push("");
    }
    if (issue.comments.length > 0) {
      parts.push("## Comments");
      for (const comment of issue.comments) {
        const header = [comment.author, comment.created ? `(${comment.created})` : ""]
          .filter(Boolean)
          .join(" ");
        parts.push(`${header}:`);
        parts.push(comment.body);
        parts.push("");
      }
    }

    const content = parts.join("\n").trim();
    return {
      id: issue.issue_id,
      provider: "jira",
      sourceType: issue.issue_type?.toLowerCase() || "issue",
      sourceId: issue.key,
      title: `${issue.key}: ${issue.title}`,
      content,
      sections: splitIntoSections(content),
      metadata: {
        key: issue.key,
        issueType: issue.issue_type,
        status: issue.status,
        priority: issue.priority,
        assignee: issue.assignee,
        reporter: issue.reporter,
        created: issue.created,
        resolved: issue.resolved || null,
        sprint: issue.sprint || null,
        commentCount: issue.comments.length,
        structured_input: true,
      },
    };
  });
}

function parseGithubStructuredData(data: StructuredHumanEnvelope): KB2ParsedDocument[] {
  const items = data.items as StructuredGithubPullRequest[];
  return items.map((pr) => {
    const parts: string[] = [];
    parts.push(`# PR #${pr.number}: ${pr.title}`);
    parts.push("");
    const meta = [`State: ${pr.status || "unknown"}`, `Author: ${pr.author || "unknown"}`];
    if (pr.branch) meta.push(`Branch: ${pr.branch}`);
    parts.push(meta.join(" | "));
    parts.push("");
    if (pr.description) {
      parts.push(pr.description);
      parts.push("");
    }
    if (pr.files_changed.length > 0) {
      parts.push("## Files Changed");
      for (const file of pr.files_changed) parts.push(`- ${file}`);
      parts.push("");
    }
    if (pr.review_comments.length > 0) {
      parts.push("## Review Comments");
      for (const comment of pr.review_comments) {
        const header = [comment.author, comment.created ? `(${comment.created})` : ""]
          .filter(Boolean)
          .join(" ");
        parts.push(`${header}:`);
        parts.push(comment.body);
        parts.push("");
      }
    }

    const content = parts.join("\n").trim();
    const repoName = pr.repository.split("/").pop() || pr.repository;
    return {
      id: pr.pr_id,
      provider: "github",
      sourceType: "pull_request",
      sourceId: `${pr.repository}/pull/${pr.number}`,
      title: `${repoName} PR #${pr.number}: ${pr.title}`,
      content,
      sections: splitIntoSections(content),
      metadata: {
        repo: pr.repository,
        prNumber: pr.number,
        state: pr.status.toLowerCase(),
        author: pr.author,
        branch: pr.branch,
        created: pr.created,
        merged: pr.merged || null,
        reviewers: pr.reviewers,
        reviewCommentCount: pr.review_comments.length,
        structured_input: true,
      },
    };
  });
}

function parseSlackStructuredData(data: StructuredHumanEnvelope): KB2ParsedDocument[] {
  const items = data.items as StructuredSlackConversation[];
  return items.map((conversation) => {
    const lines = [`# #${conversation.channel_name} | ${conversation.occurred_at}`, ""];
    const participants = new Set<string>();

    for (const message of conversation.messages) {
      if (message.speaker) participants.add(message.speaker);
      const prefix = message.timestamp_label
        ? `[${message.timestamp_label}] `
        : "";
      const speaker = message.speaker || "Unknown";
      lines.push(`${prefix}**${speaker}**: ${message.text}`);
    }

    const content = lines.join("\n").trim();
    return {
      id: conversation.conversation_id,
      provider: "slack",
      sourceType: "slack_conversation",
      sourceId: conversation.conversation_id,
      title: `#${conversation.channel_name} | ${conversation.occurred_at}`,
      content,
      sections: [
        {
          heading: `#${conversation.channel_name}`,
          content,
          start_offset: 0,
          end_offset: content.length,
        },
      ],
      metadata: {
        channelName: conversation.channel_name,
        conversationId: conversation.conversation_id,
        occurredAt: conversation.occurred_at,
        messageCount: conversation.messages.length,
        participants: [...participants],
        structured_input: true,
      },
    };
  });
}

function parseFeedbackStructuredData(data: StructuredHumanEnvelope): KB2ParsedDocument[] {
  const items = data.items as StructuredFeedbackSubmission[];
  return items.map((submission) => {
    const parts: string[] = [];
    parts.push(`# ${submission.subject || `Feedback #${submission.submission_id}`}`);
    parts.push("");
    const meta = [];
    if (submission.name) meta.push(`From: ${submission.name}`);
    if (submission.date) meta.push(`Date: ${submission.date}`);
    if (meta.length > 0) {
      parts.push(meta.join(" | "));
      parts.push("");
    }
    if (submission.message) parts.push(submission.message);

    const content = parts.join("\n").trim();
    return {
      id: `feedback-${submission.submission_id}`,
      provider: "customerFeedback",
      sourceType: "web_form",
      sourceId: String(submission.submission_id),
      title: submission.subject || `Feedback #${submission.submission_id}`,
      content,
      sections: splitIntoSections(content),
      metadata: {
        submissionId: submission.submission_id,
        name: submission.name,
        email: submission.email,
        date: submission.date,
        subject: submission.subject,
        structured_input: true,
      },
    };
  });
}

export function parseStructuredDataToParsedDocuments(
  source: string,
  data: unknown,
): KB2ParsedDocument[] {
  if (!data || typeof data !== "object") return [];

  switch (source as HumanTextSource) {
    case "confluence":
      return parseConfluenceStructuredData(data as StructuredHumanEnvelope);
    case "jira":
      return parseJiraStructuredData(data as StructuredHumanEnvelope);
    case "github":
      return parseGithubStructuredData(data as StructuredHumanEnvelope);
    case "slack":
      return parseSlackStructuredData(data as StructuredHumanEnvelope);
    case "customerFeedback":
      return parseFeedbackStructuredData(data as StructuredHumanEnvelope);
    default:
      return [];
  }
}
