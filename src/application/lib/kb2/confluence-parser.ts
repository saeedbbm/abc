/**
 * Parses real Confluence REST API responses into structured documents.
 * Handles the body.storage.value HTML → readable text conversion.
 */

export interface KB2ParsedSection {
  heading: string;
  content: string;
  start_offset: number;
  end_offset: number;
}

export interface KB2ParsedDocument {
  id: string;
  provider: string;
  sourceType: string;
  sourceId: string;
  title: string;
  content: string;
  sections: KB2ParsedSection[];
  metadata: Record<string, any>;
}

export function splitIntoSections(content: string): KB2ParsedSection[] {
  const headingRe = /^(#{1,4})\s+(.+)$/gm;
  const sections: KB2ParsedSection[] = [];
  let lastHeading = "(intro)";
  let lastStart = 0;
  let match: RegExpExecArray | null;

  while ((match = headingRe.exec(content)) !== null) {
    if (match.index > lastStart) {
      sections.push({
        heading: lastHeading,
        content: content.slice(lastStart, match.index).trim(),
        start_offset: lastStart,
        end_offset: match.index,
      });
    }
    lastHeading = match[2].trim();
    lastStart = match.index;
  }
  if (lastStart < content.length) {
    sections.push({
      heading: lastHeading,
      content: content.slice(lastStart).trim(),
      start_offset: lastStart,
      end_offset: content.length,
    });
  }
  return sections.filter((s) => s.content.length > 0);
}

// ---------------------------------------------------------------------------
// HTML → readable text
// ---------------------------------------------------------------------------

const BLOCK_TAGS = new Set([
  "p", "div", "h1", "h2", "h3", "h4", "h5", "h6",
  "li", "tr", "br", "hr", "blockquote", "pre",
]);

function decodeEntities(html: string): string {
  return html
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function htmlToText(html: string): string {
  let text = html;

  // Remove CDATA wrappers
  text = text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");

  // Confluence macros: extract code block content
  text = text.replace(
    /<ac:structured-macro[^>]*ac:name=['"]code['"][^>]*>[\s\S]*?<ac:plain-text-body>([\s\S]*?)<\/ac:plain-text-body>[\s\S]*?<\/ac:structured-macro>/gi,
    (_, code) => "\n```\n" + decodeEntities(code.trim()) + "\n```\n",
  );

  // Remove other Confluence macros and their content
  text = text.replace(/<ac:[^>]*>[\s\S]*?<\/ac:[^>]*>/gi, "");
  text = text.replace(/<ac:[^>]*\/>/gi, "");
  text = text.replace(/<ri:[^>]*\/>/gi, "");

  // Headings → markdown
  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n");
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n");
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n");
  text = text.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n");

  // Tables → markdown-ish
  text = text.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_, tableContent) => {
    const rows: string[][] = [];
    const rowMatches = tableContent.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) ?? [];
    for (const row of rowMatches) {
      const cells: string[] = [];
      const cellMatches = row.match(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi) ?? [];
      for (const cell of cellMatches) {
        const cellText = cell
          .replace(/<(?:td|th)[^>]*>/i, "")
          .replace(/<\/(?:td|th)>/i, "")
          .replace(/<[^>]+>/g, "")
          .trim();
        cells.push(decodeEntities(cellText));
      }
      rows.push(cells);
    }
    if (rows.length === 0) return "";
    const colCount = Math.max(...rows.map((r) => r.length));
    const lines: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      const padded = rows[i].concat(Array(colCount - rows[i].length).fill(""));
      lines.push("| " + padded.join(" | ") + " |");
      if (i === 0) {
        lines.push("| " + padded.map(() => "---").join(" | ") + " |");
      }
    }
    return "\n" + lines.join("\n") + "\n";
  });

  // Lists
  text = text.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_, listContent) => {
    const items = listContent.match(/<li[^>]*>([\s\S]*?)<\/li>/gi) ?? [];
    return "\n" + items.map((item: string) => {
      const itemText = item.replace(/<li[^>]*>/i, "").replace(/<\/li>/i, "").replace(/<[^>]+>/g, "").trim();
      return "- " + decodeEntities(itemText);
    }).join("\n") + "\n";
  });

  text = text.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, listContent) => {
    const items = listContent.match(/<li[^>]*>([\s\S]*?)<\/li>/gi) ?? [];
    return "\n" + items.map((item: string, idx: number) => {
      const itemText = item.replace(/<li[^>]*>/i, "").replace(/<\/li>/i, "").replace(/<[^>]+>/g, "").trim();
      return `${idx + 1}. ` + decodeEntities(itemText);
    }).join("\n") + "\n";
  });

  // Inline formatting
  text = text.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "**$1**");
  text = text.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, "**$1**");
  text = text.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, "*$1*");
  text = text.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, "*$1*");
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");

  // Block elements → newlines
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<hr\s*\/?>/gi, "\n---\n");
  text = text.replace(/<\/p>/gi, "\n");
  text = text.replace(/<p[^>]*>/gi, "\n");
  text = text.replace(/<\/div>/gi, "\n");
  text = text.replace(/<div[^>]*>/gi, "");
  text = text.replace(/<\/blockquote>/gi, "\n");
  text = text.replace(/<blockquote[^>]*>/gi, "\n> ");

  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode entities
  text = decodeEntities(text);

  // Clean up whitespace
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();

  return text;
}

// ---------------------------------------------------------------------------
// Confluence API response → KB2ParsedDocuments
// ---------------------------------------------------------------------------

interface ConfluencePage {
  id: string;
  type?: string;
  status?: string;
  title: string;
  space?: { id?: string; key?: string; name?: string };
  history?: {
    createdBy?: { displayName?: string; accountId?: string };
    createdDate?: string;
  };
  version?: {
    number?: number;
    when?: string;
    by?: { displayName?: string; accountId?: string };
  };
  body?: {
    storage?: { value?: string; representation?: string };
    view?: { value?: string };
  };
  _links?: { self?: string; webui?: string };
}

export function parseConfluenceApiResponse(json: unknown): KB2ParsedDocument[] {
  if (!json || typeof json !== "object") return [];

  let pages: ConfluencePage[] = [];
  if (Array.isArray(json)) {
    pages = json;
  } else if ("results" in (json as any) && Array.isArray((json as any).results)) {
    pages = (json as any).results;
  } else if ("id" in (json as any) && "title" in (json as any)) {
    pages = [json as ConfluencePage];
  }

  return pages
    .filter((p) => p.title && p.body?.storage?.value)
    .map((page) => {
      const rawHtml = page.body!.storage!.value!;
      const content = htmlToText(rawHtml);
      const author =
        page.version?.by?.displayName ??
        page.history?.createdBy?.displayName ??
        undefined;
      const date =
        page.version?.when ?? page.history?.createdDate ?? undefined;

      return {
        id: `confluence-${page.id}`,
        provider: "confluence",
        sourceType: "confluence_page",
        sourceId: page.id,
        title: page.title,
        content,
        sections: splitIntoSections(content),
        metadata: {
          pageId: page.id,
          author,
          date,
          space: page.space?.name,
          spaceKey: page.space?.key,
          url: page._links?.webui,
          status: page.status,
          versionNumber: page.version?.number,
        },
      };
    });
}
