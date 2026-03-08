/**
 * Parsers for human-readable text input (the format used in input-files/input-human-format/).
 * Each parser splits a multi-document text blob into KB2ParsedDocument[].
 */

import type { KB2ParsedDocument, KB2ParsedSection } from "./confluence-parser";

const BLOCK_SEP = /^={70,}$/m;

/**
 * Splits content into sections recognizing both `# heading` and underline-style headings:
 *   Title
 *   =====   (or -----)
 */
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
        if (text) sections.push({ heading: currentHeading, content: text, start_offset: sectionStart, end_offset: sectionStart + text.length });
      }
      currentHeading = line.replace(/^#{1,4}\s+/, "").trim();
      currentLines = [line];
      sectionStart = content.indexOf(line, sectionStart);
      continue;
    }

    if (nextLine && /^[=-]{3,}$/.test(nextLine) && line.trim().length > 0 && !/^[-=]{3,}$/.test(line)) {
      if (currentLines.length > 0) {
        const text = currentLines.join("\n").trim();
        if (text) sections.push({ heading: currentHeading, content: text, start_offset: sectionStart, end_offset: sectionStart + text.length });
      }
      currentHeading = line.trim();
      currentLines = [line, nextLine];
      sectionStart = content.indexOf(line, sectionStart);
      i++;
      continue;
    }

    currentLines.push(line);
  }

  if (currentLines.length > 0) {
    const text = currentLines.join("\n").trim();
    if (text) sections.push({ heading: currentHeading, content: text, start_offset: sectionStart, end_offset: sectionStart + text.length });
  }

  return sections.filter((s) => s.content.length > 0);
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function splitBlocks(text: string): string[] {
  const parts = normalizeLineEndings(text).split(BLOCK_SEP).map((p) => p.trim()).filter(Boolean);
  return parts;
}

function extractField(block: string, field: string): string {
  const re = new RegExp(`^${field}:\\s*(.+)$`, "mi");
  const m = block.match(re);
  return m ? m[1].trim() : "";
}

// ---------------------------------------------------------------------------
// Confluence
// ---------------------------------------------------------------------------

export function parseConfluenceHumanText(text: string): KB2ParsedDocument[] {
  const blocks = splitBlocks(text);
  const docs: KB2ParsedDocument[] = [];

  for (const block of blocks) {
    const docMatch = block.match(/^DOCUMENT:\s*(.+)$/m);
    if (!docMatch) continue;

    const title = docMatch[1].trim();
    const space = extractField(block, "Space");
    const author = extractField(block, "Author");
    const created = extractField(block, "Created");
    const lastUpdated = extractField(block, "Last Updated");
    const labels = extractField(block, "Labels");

    // Body starts after the second full-width dash line (end of metadata block).
    // Format: DOCUMENT: Title \n ----80---- \n metadata \n ----80---- \n body
    const dashRe = /^-{40,}$/gm;
    let firstDash = dashRe.exec(block);
    let secondDash = firstDash ? dashRe.exec(block) : null;
    let content: string;
    if (secondDash) {
      content = block.slice(secondDash.index + secondDash[0].length).trim();
    } else if (firstDash) {
      content = block.slice(firstDash.index + firstDash[0].length).trim();
    } else {
      content = block.slice(block.indexOf(title) + title.length).trim();
    }

    const id = `confluence-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60)}`;

    docs.push({
      id,
      provider: "confluence",
      sourceType: "confluence_page",
      sourceId: title,
      title,
      content,
      sections: splitHumanSections(content),
      metadata: {
        space,
        author,
        created,
        lastUpdated,
        labels: labels ? labels.split(",").map((l) => l.trim()) : [],
      },
    });
  }

  return docs;
}

// ---------------------------------------------------------------------------
// Jira
// ---------------------------------------------------------------------------

export function parseJiraHumanText(text: string): KB2ParsedDocument[] {
  const blocks = splitBlocks(text);
  const docs: KB2ParsedDocument[] = [];

  for (const block of blocks) {
    const keyMatch = block.match(/^(PAW-\d+)\s*$/m);
    if (!keyMatch) continue;

    const key = keyMatch[1];
    const title = extractField(block, "Title");
    const issueType = extractField(block, "Type");
    const status = extractField(block, "Status");
    const priority = extractField(block, "Priority");
    const assignee = extractField(block, "Assignee");
    const reporter = extractField(block, "Reporter");
    const created = extractField(block, "Created");
    const resolved = extractField(block, "Resolved");
    const sprint = extractField(block, "Sprint");

    const descMatch = block.match(/\nDescription:\n([\s\S]*?)$/);
    const description = descMatch ? descMatch[1].trim() : "";

    const commentMatch = block.match(/\nComments:\n([\s\S]*?)$/);
    const commentsText = commentMatch ? commentMatch[1].trim() : "";

    const parts: string[] = [];
    parts.push(`# ${key}: ${title}`);
    parts.push("");
    const meta = [
      issueType ? `Type: ${issueType}` : "",
      status ? `Status: ${status}` : "",
      priority ? `Priority: ${priority}` : "",
      assignee ? `Assignee: ${assignee}` : "",
      reporter ? `Reporter: ${reporter}` : "",
    ].filter(Boolean);
    if (meta.length) { parts.push(meta.join(" | ")); parts.push(""); }
    if (description) { parts.push("## Description"); parts.push(description); parts.push(""); }
    if (commentsText) { parts.push("## Comments"); parts.push(commentsText); }

    const content = parts.join("\n").trim();

    docs.push({
      id: `jira-${key}`,
      provider: "jira",
      sourceType: issueType?.toLowerCase() ?? "issue",
      sourceId: key,
      title: `${key}: ${title}`,
      content,
      sections: splitHumanSections(content),
      metadata: {
        key,
        issueType,
        status,
        priority,
        assignee: assignee || null,
        reporter,
        created,
        resolved: resolved || null,
        sprint: sprint || null,
      },
    });
  }

  return docs;
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export function parseGithubHumanText(text: string): KB2ParsedDocument[] {
  const blocks = splitBlocks(text);
  const docs: KB2ParsedDocument[] = [];

  for (const block of blocks) {
    const prMatch = block.match(/^PR\s*#(\d+)\s*[—–-]\s*(.+)$/m);
    if (!prMatch) continue;

    const prNumber = parseInt(prMatch[1], 10);
    const prTitle = prMatch[2].trim();
    const repo = extractField(block, "Repository");
    const branch = extractField(block, "Branch");
    const author = extractField(block, "Author");
    const created = extractField(block, "Created");
    const merged = extractField(block, "Merged");
    const prStatus = extractField(block, "Status");
    const reviewers = extractField(block, "Reviewers");

    const descMatch = block.match(/\nDescription:\n([\s\S]*?)(?:\nFiles changed:|\nReview Comments:|\s*$)/);
    const description = descMatch ? descMatch[1].trim() : "";

    const filesMatch = block.match(/\nFiles changed:\n([\s\S]*?)(?:\nReview Comments:|\s*$)/);
    const filesText = filesMatch ? filesMatch[1].trim() : "";

    const commentsMatch = block.match(/\nReview Comments:\n([\s\S]*?)$/);
    const commentsText = commentsMatch ? commentsMatch[1].trim() : "";

    const parts: string[] = [];
    parts.push(`# PR #${prNumber}: ${prTitle}`);
    parts.push("");
    const meta = [`State: ${prStatus || "unknown"}`, `Author: ${author || "unknown"}`];
    if (branch) meta.push(`Branch: ${branch}`);
    parts.push(meta.join(" | "));
    parts.push("");
    if (description) { parts.push(description); parts.push(""); }
    if (filesText) { parts.push("## Files Changed"); parts.push(filesText); parts.push(""); }
    if (commentsText) { parts.push("## Review Comments"); parts.push(commentsText); }

    const content = parts.join("\n").trim();
    const repoName = repo.split("/").pop() ?? repo;

    docs.push({
      id: `github-${repoName}-pr-${prNumber}`,
      provider: "github",
      sourceType: "pull_request",
      sourceId: `${repo}/pull/${prNumber}`,
      title: `${repoName} PR #${prNumber}: ${prTitle}`,
      content,
      sections: splitHumanSections(content),
      metadata: {
        repo,
        prNumber,
        state: prStatus?.toLowerCase(),
        author,
        branch,
        created,
        merged: merged || null,
        reviewers: reviewers ? reviewers.split(",").map((r) => r.trim()) : [],
      },
    });
  }

  return docs;
}

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

export function parseSlackHumanText(text: string): KB2ParsedDocument[] {
  const blocks = splitBlocks(text);

  const channelMap = new Map<string, { messages: string[]; participants: Set<string>; dates: string[] }>();

  for (const block of blocks) {
    const headerMatch = block.match(/^#(\S+)\s*\|\s*(\S+)/m);
    if (!headerMatch) continue;

    const channelName = headerMatch[1];
    const date = headerMatch[2];
    const sepIdx = block.indexOf("---");
    const body = sepIdx > -1 ? block.slice(sepIdx).replace(/^-+\n?/, "").trim() : block;

    if (!channelMap.has(channelName)) {
      channelMap.set(channelName, { messages: [], participants: new Set(), dates: [] });
    }
    const entry = channelMap.get(channelName)!;
    entry.dates.push(date);

    const lines = body.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const msgMatch = trimmed.match(/^(\w[\w\s.]*?)(?:\s*\[[\d:]+\s*[AP]?M?\])?:\s*(.+)/i);
      if (msgMatch) {
        entry.participants.add(msgMatch[1].trim());
        entry.messages.push(trimmed);
      } else {
        entry.messages.push(trimmed);
      }
    }
  }

  const docs: KB2ParsedDocument[] = [];

  for (const [channelName, data] of channelMap) {
    const lines = [`# #${channelName}`, "", ...data.messages];
    const content = lines.join("\n").trim();

    docs.push({
      id: `slack-${channelName}`,
      provider: "slack",
      sourceType: "slack_channel",
      sourceId: channelName,
      title: `#${channelName}`,
      content,
      sections: splitHumanSections(content),
      metadata: {
        channelName,
        messageCount: data.messages.length,
        participants: [...data.participants],
        dateRange: data.dates.length > 0
          ? `${data.dates[0]} to ${data.dates[data.dates.length - 1]}`
          : "",
      },
    });
  }

  return docs;
}

// ---------------------------------------------------------------------------
// Customer Feedback (webform)
// ---------------------------------------------------------------------------

export function parseFeedbackHumanText(text: string): KB2ParsedDocument[] {
  const blocks = splitBlocks(text);
  const docs: KB2ParsedDocument[] = [];

  for (const block of blocks) {
    const subMatch = block.match(/^Submission\s*#(\d+)/m);
    if (!subMatch) continue;

    const subId = parseInt(subMatch[1], 10);
    const name = extractField(block, "Name");
    const email = extractField(block, "Email");
    const date = extractField(block, "Date");
    const subject = extractField(block, "Subject");

    const msgMatch = block.match(/\nMessage:\n([\s\S]*?)$/);
    const message = msgMatch ? msgMatch[1].trim() : "";

    const parts: string[] = [];
    parts.push(`# ${subject}`);
    parts.push("");
    const meta = [];
    if (name) meta.push(`From: ${name}`);
    if (date) meta.push(`Date: ${date}`);
    if (meta.length) { parts.push(meta.join(" | ")); parts.push(""); }
    if (message) parts.push(message);

    const content = parts.join("\n").trim();

    docs.push({
      id: `feedback-${subId}`,
      provider: "customerFeedback",
      sourceType: "web_form",
      sourceId: String(subId),
      title: subject || `Feedback #${subId}`,
      content,
      sections: splitHumanSections(content),
      metadata: {
        submissionId: subId,
        name,
        email,
        date,
        subject,
      },
    });
  }

  return docs;
}
