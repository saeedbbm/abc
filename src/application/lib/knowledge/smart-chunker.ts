/**
 * Smart Chunker — per-source-type chunking strategies
 * 
 * Instead of uniformly splitting all documents at 512 characters,
 * this module selects a chunking strategy based on the document's sourceType.
 * 
 * Strategies:
 * - confluence_page: Split by headers (h1/h2/h3), keep sections whole
 * - jira_issue: Split by field (summary+description, each comment)
 * - slack_message/thread: Keep whole (already atomic)
 * - slack_conversation: Keep whole (AI-generated summaries)
 * - Metadata docs (users, channels, spaces, projects): Keep whole
 * - Fallback: RecursiveCharacterTextSplitter at 1500 chars
 */

import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';

export interface SmartChunk {
    text: string;
    metadata?: {
        sectionTitle?: string;
        fieldType?: string;
        messageType?: string;
        chunkReason?: string;
    };
}

const KEEP_WHOLE_TYPES = new Set([
    'slack_message', 'slack_thread', 'slack_conversation',
    'slack_user', 'slack_channel',
    'jira_user', 'jira_project', 'jira_comment',
    'confluence_space', 'confluence_user',
    'topic_document', 'company_profile',
    'customer_feedback',
    'github_commit',
]);

const MAX_SECTION_LENGTH = 2000;

const fallbackSplitter = new RecursiveCharacterTextSplitter({
    separators: ['\n\n', '\n', '. ', '.', ''],
    chunkSize: 1500,
    chunkOverlap: 200,
});

/**
 * Smart chunk a document based on its sourceType.
 */
export async function smartChunk(
    content: string,
    sourceType: string,
    metadata?: Record<string, any>
): Promise<SmartChunk[]> {
    if (!content || content.trim().length === 0) {
        return [];
    }

    // Keep-whole types: return as single chunk
    if (KEEP_WHOLE_TYPES.has(sourceType)) {
        return [{ text: content, metadata: { chunkReason: 'keep-whole' } }];
    }

    // Confluence pages: split by headers
    if (sourceType === 'confluence_page') {
        return chunkConfluencePage(content, metadata);
    }

    // Jira issues: split by fields
    if (sourceType === 'jira_issue') {
        return chunkJiraIssue(content, metadata);
    }

    // GitHub files: split by function/class boundaries or by sections
    if (sourceType === 'github_file') {
        return chunkGitHubFile(content, metadata);
    }

    // GitHub PRs: split description from review comments
    if (sourceType === 'github_pr') {
        return chunkGitHubPR(content, metadata);
    }

    // Check provider registry for custom strategy (future providers)
    try {
        const { providerRegistry } = await import("@/src/application/lib/integrations/provider-interface");
        const strategy = providerRegistry.getChunkStrategy(sourceType);
        if (strategy) {
            return strategy.chunk(content, metadata);
        }
    } catch {
        // Registry not available
    }

    // Fallback for unknown types
    return chunkFallback(content);
}

/**
 * Confluence page: split by header boundaries.
 * Each h1/h2/h3 section becomes its own chunk.
 * Very long sections get sub-split.
 */
async function chunkConfluencePage(content: string, metadata?: Record<string, any>): Promise<SmartChunk[]> {
    // Split on header patterns (markdown-style or plain text headers)
    const headerPattern = /^(#{1,3}\s+.+|[A-Z][A-Za-z\s&:/-]{3,80})$/gm;
    
    const sections: Array<{ title: string; text: string }> = [];
    let lastIndex = 0;
    let lastTitle = 'Introduction';
    let match;
    
    // Also try to detect "SECTION_NAME\n---" or "SECTION_NAME\n===" patterns
    const lines = content.split('\n');
    const sectionBreaks: Array<{ index: number; title: string }> = [];
    
    let charIndex = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        // Markdown headers
        if (/^#{1,3}\s+/.test(line)) {
            sectionBreaks.push({ index: charIndex, title: line.replace(/^#+\s*/, '') });
        }
        // Confluence-style "Title:" at start of line followed by content
        else if (/^[A-Z][A-Za-z\s&:/-]{3,60}:?\s*$/.test(line) && line.length > 5 && line.length < 80) {
            // Only treat as header if it's followed by substantial content
            if (i + 1 < lines.length && lines[i + 1].trim().length > 20) {
                sectionBreaks.push({ index: charIndex, title: line.replace(/:$/, '') });
            }
        }
        charIndex += lines[i].length + 1; // +1 for newline
    }
    
    if (sectionBreaks.length === 0) {
        // No headers found — treat entire page as one chunk, sub-split if long
        return chunkFallback(content);
    }
    
    // Build sections
    for (let i = 0; i < sectionBreaks.length; i++) {
        const start = sectionBreaks[i].index;
        const end = i + 1 < sectionBreaks.length ? sectionBreaks[i + 1].index : content.length;
        const sectionText = content.substring(start, end).trim();
        
        if (sectionText.length > 0) {
            sections.push({ title: sectionBreaks[i].title, text: sectionText });
        }
    }
    
    // Include any content before the first header
    if (sectionBreaks[0].index > 0) {
        const preContent = content.substring(0, sectionBreaks[0].index).trim();
        if (preContent.length > 20) {
            sections.unshift({ title: 'Introduction', text: preContent });
        }
    }
    
    // Convert sections to chunks, sub-splitting long ones
    const chunks: SmartChunk[] = [];
    for (const section of sections) {
        if (section.text.length <= MAX_SECTION_LENGTH) {
            chunks.push({
                text: section.text,
                metadata: { sectionTitle: section.title, chunkReason: 'confluence-section' },
            });
        } else {
            // Sub-split long sections
            const subChunks = await fallbackSplitter.splitText(section.text);
            for (const sub of subChunks) {
                chunks.push({
                    text: sub,
                    metadata: { sectionTitle: section.title, chunkReason: 'confluence-section-split' },
                });
            }
        }
    }
    
    return chunks.length > 0 ? chunks : [{ text: content, metadata: { chunkReason: 'confluence-whole' } }];
}

/**
 * Jira issue: split into summary+description chunk and individual comments.
 */
function chunkJiraIssue(content: string, metadata?: Record<string, any>): Promise<SmartChunk[]> {
    const chunks: SmartChunk[] = [];
    
    // The content is already formatted as:
    // Issue: KEY
    // Summary: ...
    // Type: ...
    // Status: ...
    // ...
    // Description:
    // ...
    //
    // Try to split at "Description:" boundary
    const descIndex = content.indexOf('\nDescription:');
    const commentsIndex = content.indexOf('\nComments:');
    const acceptanceIndex = content.indexOf('\nAcceptance Criteria:');
    
    // Main chunk: everything up to (and including) description + acceptance criteria
    let mainEnd = content.length;
    if (commentsIndex > 0) mainEnd = commentsIndex;
    
    const mainContent = content.substring(0, mainEnd).trim();
    if (mainContent.length > 0) {
        chunks.push({
            text: mainContent,
            metadata: { fieldType: 'description', chunkReason: 'jira-main' },
        });
    }
    
    // Comments as separate chunks
    if (commentsIndex > 0) {
        const commentsText = content.substring(commentsIndex).trim();
        // Split individual comments (separated by double newlines or "---")
        const commentBlocks = commentsText.split(/\n---\n|\n\n(?=[A-Z][\w\s]+\s+commented)/);
        for (const block of commentBlocks) {
            const trimmed = block.trim();
            if (trimmed.length > 20) {
                chunks.push({
                    text: trimmed,
                    metadata: { fieldType: 'comment', chunkReason: 'jira-comment' },
                });
            }
        }
    }
    
    return Promise.resolve(chunks.length > 0 ? chunks : [{ text: content, metadata: { chunkReason: 'jira-whole' } }]);
}

/**
 * GitHub file: split by sections/functions if possible, otherwise by size.
 */
async function chunkGitHubFile(content: string, metadata?: Record<string, any>): Promise<SmartChunk[]> {
    if (content.length <= MAX_SECTION_LENGTH) {
        return [{ text: content, metadata: { chunkReason: 'github-file-whole' } }];
    }
    const sections: SmartChunk[] = [];
    const lines = content.split('\n');
    let currentChunk = '';
    let currentSection = metadata?.path || 'file';

    for (const line of lines) {
        const isBoundary = /^(class |def |function |export |const |import |from |##|\/\/)/.test(line.trim());
        if (isBoundary && currentChunk.length > 200) {
            sections.push({ text: currentChunk.trim(), metadata: { sectionTitle: currentSection, chunkReason: 'github-file-section' } });
            currentChunk = '';
            currentSection = line.trim().substring(0, 80);
        }
        currentChunk += line + '\n';
        if (currentChunk.length > MAX_SECTION_LENGTH) {
            sections.push({ text: currentChunk.trim(), metadata: { sectionTitle: currentSection, chunkReason: 'github-file-split' } });
            currentChunk = '';
        }
    }
    if (currentChunk.trim().length > 0) {
        sections.push({ text: currentChunk.trim(), metadata: { sectionTitle: currentSection, chunkReason: 'github-file-section' } });
    }
    return sections.length > 0 ? sections : [{ text: content, metadata: { chunkReason: 'github-file-whole' } }];
}

/**
 * GitHub PR: split description from review comments.
 */
function chunkGitHubPR(content: string, metadata?: Record<string, any>): Promise<SmartChunk[]> {
    const chunks: SmartChunk[] = [];
    const reviewIndex = content.indexOf('\nReview Comments:');
    const discussionIndex = content.indexOf('\nDiscussion:');
    const splitAt = reviewIndex > 0 ? reviewIndex : discussionIndex > 0 ? discussionIndex : -1;

    if (splitAt > 0) {
        const desc = content.substring(0, splitAt).trim();
        const reviews = content.substring(splitAt).trim();
        if (desc.length > 20) chunks.push({ text: desc, metadata: { fieldType: 'description', chunkReason: 'github-pr-desc' } });
        if (reviews.length > 20) chunks.push({ text: reviews, metadata: { fieldType: 'review', chunkReason: 'github-pr-review' } });
    }
    return Promise.resolve(chunks.length > 0 ? chunks : [{ text: content, metadata: { chunkReason: 'github-pr-whole' } }]);
}

/**
 * Fallback chunker for unknown source types.
 * Uses RecursiveCharacterTextSplitter at 1500 chars (3x the old 512).
 */
async function chunkFallback(content: string): Promise<SmartChunk[]> {
    if (content.length <= 1500) {
        return [{ text: content, metadata: { chunkReason: 'fallback-whole' } }];
    }
    
    const texts = await fallbackSplitter.splitText(content);
    return texts.map(text => ({
        text,
        metadata: { chunkReason: 'fallback-split' },
    }));
}
