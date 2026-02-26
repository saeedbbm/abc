import { createHash } from "crypto";

export interface ParsedDocument {
    provider: string;
    sourceType: string;
    sourceId: string;
    title: string;
    content: string;
    contentHash: string;
    metadata: Record<string, any>;
    entityRefs: string[];
}

function computeHash(content: string): string {
    return createHash("sha256").update(content).digest("hex");
}

export interface ParsedBundles {
    confluence: ParsedDocument[];
    jira: ParsedDocument[];
    slack: ParsedDocument[];
    github: ParsedDocument[];
    customerFeedback: ParsedDocument[];
    totalDocuments: number;
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function trimBlock(text: string): string {
    return text.replace(/^\n+/, '').replace(/\n+$/, '');
}

function extractHeaderMeta(header: string): Record<string, string> {
    const meta: Record<string, string> = {};

    const authorMatch = header.match(/(?:Author|By|Written by|Creator)[:\s]+(.+?)(?:\||$)/i);
    if (authorMatch) meta.author = authorMatch[1].trim();

    const dateMatch = header.match(/(?:Date|Created|Updated|Last modified|On)[:\s]+(\d{4}[-/]\d{2}[-/]\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?)/i);
    if (dateMatch) meta.date = dateMatch[1].trim();

    const statusMatch = header.match(/(?:Status)[:\s]+(.+?)(?:\||$)/i);
    if (statusMatch) meta.status = statusMatch[1].trim();

    const labelMatch = header.match(/(?:Labels?|Tags?)[:\s]+(.+?)(?:\||$)/i);
    if (labelMatch) meta.labels = labelMatch[1].trim();

    return meta;
}

/**
 * Try several split patterns against the raw text, returning the split that
 * produces the most sections (≥ 2). Falls back to a single-document result.
 */
function bestSplit(
    raw: string,
    patterns: RegExp[],
): { headers: string[]; bodies: string[] } {
    let bestHeaders: string[] = [];
    let bestBodies: string[] = [];

    for (const pattern of patterns) {
        const parts = raw.split(pattern);

        if (parts.length < 2) continue;

        const headers: string[] = [];
        const bodies: string[] = [];

        const headerMatches = [...raw.matchAll(new RegExp(pattern, 'g'))];

        const preamble = parts[0];
        if (preamble.trim()) {
            headers.push('');
            bodies.push(preamble);
        }

        for (let i = 0; i < headerMatches.length; i++) {
            headers.push(headerMatches[i][0]);
            bodies.push(parts[i + (preamble.trim() ? 1 : 1)]);
        }

        if (headers.length <= 1) continue;

        if (headers.length > bestHeaders.length) {
            bestHeaders = headers;
            bestBodies = bodies;
        }
    }

    return { headers: bestHeaders, bodies: bestBodies };
}

/**
 * A more reliable splitting strategy: find all header line positions, then
 * slice the text between them.
 */
function splitByHeaders(
    raw: string,
    headerPattern: RegExp,
): { header: string; body: string }[] {
    const lines = raw.split('\n');
    const sections: { header: string; body: string }[] = [];
    let currentHeader = '';
    let currentLines: string[] = [];

    for (const line of lines) {
        if (headerPattern.test(line)) {
            if (currentHeader || currentLines.length > 0) {
                sections.push({
                    header: currentHeader,
                    body: trimBlock(currentLines.join('\n')),
                });
            }
            currentHeader = line;
            currentLines = [];
        } else {
            currentLines.push(line);
        }
    }

    if (currentHeader || currentLines.length > 0) {
        sections.push({
            header: currentHeader,
            body: trimBlock(currentLines.join('\n')),
        });
    }

    return sections;
}

function trySplitMultiplePatterns(
    raw: string,
    patterns: RegExp[],
): { header: string; body: string }[] {
    for (const pattern of patterns) {
        const sections = splitByHeaders(raw, pattern);
        const meaningful = sections.filter(s => s.header || s.body.length > 20);
        if (meaningful.length >= 2) return meaningful;
    }

    return [{ header: '', body: raw.trim() }];
}

// ---------------------------------------------------------------------------
// Horizontal-rule splitter for when no markdown headers are found
// ---------------------------------------------------------------------------

function splitByHorizontalRules(raw: string): { header: string; body: string }[] {
    const blocks = raw.split(/^-{3,}$/m).map(b => b.trim()).filter(Boolean);
    if (blocks.length < 2) return [];
    return blocks.map(block => {
        const firstLine = block.split('\n')[0];
        const rest = block.split('\n').slice(1).join('\n');
        return { header: firstLine, body: trimBlock(rest || firstLine) };
    });
}

// ---------------------------------------------------------------------------
// Confluence parser
// ---------------------------------------------------------------------------

function parseConfluence(raw: string): ParsedDocument[] {
    if (!raw.trim()) return [];

    const patterns: RegExp[] = [
        /^## Page:\s*.+$/m,
        /^## .+$/m,
        /^### .+$/m,
        /^# .+$/m,
    ];

    let sections = trySplitMultiplePatterns(raw, patterns);

    if (sections.length < 2) {
        const hrSections = splitByHorizontalRules(raw);
        if (hrSections.length >= 2) sections = hrSections;
    }

    return sections
        .filter(s => s.header || s.body)
        .map((section, idx) => {
            const titleMatch = section.header.match(/^#+\s*(?:Page:\s*)?(.+)$/);
            const title = titleMatch
                ? titleMatch[1].trim()
                : section.body.split('\n')[0].slice(0, 120).trim() || `Confluence Page ${idx + 1}`;

            const meta = extractHeaderMeta(section.header + '\n' + section.body.split('\n').slice(0, 5).join('\n'));

            const spaceMatch = section.body.match(/(?:Space|Namespace)[:\s]+(.+)/i);
            if (spaceMatch) meta.space = spaceMatch[1].trim();

            const content = trimBlock(section.body);
            return {
                provider: 'confluence',
                sourceType: 'confluence_page',
                sourceId: `test:confluence:${idx}`,
                title,
                content,
                contentHash: computeHash(content),
                metadata: meta,
                entityRefs: [],
            };
        });
}

// ---------------------------------------------------------------------------
// Jira parser
// ---------------------------------------------------------------------------

function parseJira(raw: string): ParsedDocument[] {
    if (!raw.trim()) return [];

    const patterns: RegExp[] = [
        /^## [A-Z]+-\d+/m,
        /^## (?:TICKET|ISSUE|TASK|BUG|STORY|EPIC)-?\s*#?\d+/im,
        /^### [A-Z]+-\d+/m,
        /^# [A-Z]+-\d+/m,
        /^## .+$/m,
    ];

    const sections = trySplitMultiplePatterns(raw, patterns);

    return sections
        .filter(s => s.header || s.body)
        .map((section, idx) => {
            const keyMatch = section.header.match(/([A-Z]+-\d+)/);
            const ticketKey = keyMatch ? keyMatch[1] : undefined;

            const titleAfterKey = section.header.match(/^#+\s*(?:[A-Z]+-\d+[:\s-]*)?(.+)$/);
            const titleFromBody = section.body.split('\n')[0].slice(0, 120).trim();
            const title = ticketKey
                ? `${ticketKey}${titleAfterKey && titleAfterKey[1].trim() ? ': ' + titleAfterKey[1].trim() : ''}`
                : titleFromBody || `Jira Ticket ${idx + 1}`;

            const meta: Record<string, any> = extractHeaderMeta(
                section.header + '\n' + section.body.split('\n').slice(0, 8).join('\n'),
            );
            if (ticketKey) meta.ticketKey = ticketKey;

            const priorityMatch = section.body.match(/(?:Priority)[:\s]+(.+)/i);
            if (priorityMatch) meta.priority = priorityMatch[1].trim();

            const assigneeMatch = section.body.match(/(?:Assignee|Assigned to)[:\s]+(.+)/i);
            if (assigneeMatch) meta.assignee = assigneeMatch[1].trim();

            const typeMatch = section.body.match(/(?:Type|Issue Type)[:\s]+(.+)/i);
            if (typeMatch) meta.issueType = typeMatch[1].trim();

            const content = trimBlock(section.body);
            return {
                provider: 'jira',
                sourceType: 'jira_issue',
                sourceId: `test:jira:${idx}`,
                title,
                content,
                contentHash: computeHash(content),
                metadata: meta,
                entityRefs: [],
            };
        });
}

// ---------------------------------------------------------------------------
// Slack parser
// ---------------------------------------------------------------------------

function parseSlack(raw: string): ParsedDocument[] {
    if (!raw.trim()) return [];

    const patterns: RegExp[] = [
        /^## #[\w-]+/m,
        /^### Thread:/m,
        /^## (?:Channel|Thread|DM):\s*.+$/im,
        /^## .+$/m,
    ];

    const sections = trySplitMultiplePatterns(raw, patterns);

    return sections
        .filter(s => s.header || s.body)
        .map((section, idx) => {
            const channelMatch = section.header.match(/#([\w-]+)/);
            const channel = channelMatch ? channelMatch[1] : undefined;

            const threadMatch = section.header.match(/Thread:\s*(.+)/i);

            let sourceType = 'slack_message';
            if (threadMatch) sourceType = 'slack_thread';
            else if (channel) sourceType = 'slack_conversation';

            const title = channel
                ? `#${channel}`
                : threadMatch
                    ? `Thread: ${threadMatch[1].trim()}`
                    : section.body.split('\n')[0].slice(0, 120).trim() || `Slack Message ${idx + 1}`;

            const meta: Record<string, any> = extractHeaderMeta(
                section.header + '\n' + section.body.split('\n').slice(0, 5).join('\n'),
            );
            if (channel) meta.channel = channel;

            const userMatches = section.body.match(/@([\w.]+)/g);
            if (userMatches) {
                meta.mentionedUsers = [...new Set(userMatches.map(m => m.slice(1)))];
            }

            const timestampMatch = section.body.match(
                /\b(\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}(?::\d{2})?)\b/,
            );
            if (timestampMatch) meta.timestamp = timestampMatch[1];

            const content = trimBlock(section.body);
            return {
                provider: 'slack',
                sourceType,
                sourceId: `test:slack:${idx}`,
                title,
                content,
                contentHash: computeHash(content),
                metadata: meta,
                entityRefs: [],
            };
        });
}

// ---------------------------------------------------------------------------
// GitHub parser
// ---------------------------------------------------------------------------

function parseGitHub(raw: string): ParsedDocument[] {
    if (!raw.trim()) return [];

    const patterns: RegExp[] = [
        /^## (?:File|PR|Commit|Issue):\s*.+$/im,
        /^## PR #\d+/m,
        /^## Commit:\s*.+$/im,
        /^### [\w/.-]+\.\w+/m,
        /^## #\d+/m,
        /^## .+$/m,
    ];

    const sections = trySplitMultiplePatterns(raw, patterns);

    return sections
        .filter(s => s.header || s.body)
        .map((section, idx) => {
            const prMatch = section.header.match(/PR\s*#(\d+)/i);
            const commitMatch = section.header.match(/Commit:\s*(.+)/i);
            const fileMatch = section.header.match(/(?:File:\s*)?([^\s]+\.\w+)/i);
            const issueMatch = section.header.match(/#(\d+)/);

            let sourceType = 'github_file';
            let title = '';
            const meta: Record<string, any> = extractHeaderMeta(
                section.header + '\n' + section.body.split('\n').slice(0, 5).join('\n'),
            );

            if (prMatch) {
                sourceType = 'github_pr';
                const prNum = prMatch[1];
                meta.prNumber = parseInt(prNum, 10);
                const prTitle = section.header.replace(/^#+\s*PR\s*#\d+[:\s-]*/i, '').trim();
                title = `PR #${prNum}${prTitle ? ': ' + prTitle : ''}`;
            } else if (commitMatch) {
                sourceType = 'github_commit';
                const sha = commitMatch[1].trim().slice(0, 40);
                meta.commitSha = sha;
                title = `Commit: ${sha.slice(0, 8)}`;
            } else if (fileMatch) {
                sourceType = 'github_file';
                const filePath = fileMatch[1].trim();
                meta.filePath = filePath;
                title = filePath;
            } else if (issueMatch) {
                sourceType = 'github_issue';
                meta.issueNumber = parseInt(issueMatch[1], 10);
                title = `Issue #${issueMatch[1]}`;
            } else {
                const headerTitle = section.header.replace(/^#+\s*/, '').trim();
                title = headerTitle || section.body.split('\n')[0].slice(0, 120).trim() || `GitHub Item ${idx + 1}`;
            }

            const repoMatch = section.body.match(/(?:Repo|Repository)[:\s]+([\w/-]+)/i);
            if (repoMatch) meta.repository = repoMatch[1].trim();

            const branchMatch = section.body.match(/(?:Branch)[:\s]+([\w/.-]+)/i);
            if (branchMatch) meta.branch = branchMatch[1].trim();

            const content = trimBlock(section.body);
            return {
                provider: 'github',
                sourceType,
                sourceId: `test:github:${idx}`,
                title,
                content,
                contentHash: computeHash(content),
                metadata: meta,
                entityRefs: [],
            };
        });
}

// ---------------------------------------------------------------------------
// Customer Feedback parser
// ---------------------------------------------------------------------------

function parseCustomerFeedback(raw: string): ParsedDocument[] {
    if (!raw.trim()) return [];

    const patterns: RegExp[] = [
        /^## (?:Feedback|Customer|Review):\s*.+$/im,
        /^## (?:Feedback|Customer|Review)\s*#?\d+/im,
        /^\d+\.\s+/m,
        /^## .+$/m,
    ];

    let sections = trySplitMultiplePatterns(raw, patterns);

    if (sections.length < 2) {
        const numbered = splitByHeaders(raw, /^\d+[.)]\s+/m);
        if (numbered.filter(s => s.header || s.body.length > 10).length >= 2) {
            sections = numbered;
        }
    }

    return sections
        .filter(s => s.header || s.body)
        .map((section, idx) => {
            const customerMatch = section.header.match(/Customer:\s*(.+)/i);
            const feedbackLabelMatch = section.header.match(/Feedback:\s*(.+)/i);
            const reviewMatch = section.header.match(/Review:\s*(.+)/i);
            const numberedMatch = section.header.match(/^\d+[.)]\s+(.+)/);

            const titleSource =
                customerMatch?.[1] ??
                feedbackLabelMatch?.[1] ??
                reviewMatch?.[1] ??
                numberedMatch?.[1] ??
                section.header.replace(/^#+\s*/, '').trim();

            const title = titleSource || section.body.split('\n')[0].slice(0, 120).trim() || `Feedback ${idx + 1}`;

            const meta: Record<string, any> = extractHeaderMeta(
                section.header + '\n' + section.body.split('\n').slice(0, 5).join('\n'),
            );

            if (customerMatch) meta.customerName = customerMatch[1].trim();

            const ratingMatch = section.body.match(/(?:Rating|Score|Stars?)[:\s]+(\d(?:\.\d)?)\s*(?:\/\s*\d+)?/i);
            if (ratingMatch) meta.rating = parseFloat(ratingMatch[1]);

            const sentimentMatch = section.body.match(/(?:Sentiment)[:\s]+(positive|negative|neutral|mixed)/i);
            if (sentimentMatch) meta.sentiment = sentimentMatch[1].toLowerCase();

            const categoryMatch = section.body.match(/(?:Category|Topic|Area)[:\s]+(.+)/i);
            if (categoryMatch) meta.category = categoryMatch[1].trim();

            const companyMatch = section.body.match(/(?:Company|Org|Organization)[:\s]+(.+)/i);
            if (companyMatch) meta.company = companyMatch[1].trim();

            const content = trimBlock(section.body);
            return {
                provider: 'customer_feedback',
                sourceType: 'customer_feedback',
                sourceId: `test:customer_feedback:${idx}`,
                title,
                content,
                contentHash: computeHash(content),
                metadata: meta,
                entityRefs: [],
            };
        });
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function parseBundles(
    confluence: string,
    jira: string,
    slack: string,
    github: string,
    customerFeedback: string,
): ParsedBundles {
    const result: ParsedBundles = {
        confluence: parseConfluence(confluence),
        jira: parseJira(jira),
        slack: parseSlack(slack),
        github: parseGitHub(github),
        customerFeedback: parseCustomerFeedback(customerFeedback),
        totalDocuments: 0,
    };

    result.totalDocuments =
        result.confluence.length +
        result.jira.length +
        result.slack.length +
        result.github.length +
        result.customerFeedback.length;

    return result;
}
