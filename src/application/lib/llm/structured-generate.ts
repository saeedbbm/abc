import { generateObject, generateText } from "ai";
import { z } from "zod";
import { PrefixLogger } from "@/lib/utils";

export type LLMUsage = {
  promptTokens: number;
  completionTokens: number;
};

type SDKUsage = { inputTokens?: number; outputTokens?: number };

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 2000;

function isRetryable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  return lower.includes("overloaded") || lower.includes("529") ||
    lower.includes("rate") || lower.includes("too many") ||
    lower.includes("timeout") || lower.includes("econnreset") ||
    lower.includes("503") || lower.includes("500");
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Tries generateObject first (structured output via tool calling).
 * If the model cannot satisfy the schema, falls back to generateText
 * with strong JSON-only instructions and robust extraction.
 * Retries with exponential backoff on transient errors (overloaded, rate limit, etc.).
 */
export async function structuredGenerate<T>(options: {
    model: Parameters<typeof generateObject>[0]["model"];
    system: string;
    prompt: string;
    schema: z.ZodType<T>;
    maxOutputTokens?: number;
    logger: PrefixLogger;
    onUsage?: (usage: LLMUsage) => void;
    signal?: AbortSignal;
}): Promise<T> {
    const { model, system, prompt, schema, maxOutputTokens = 16384, logger, onUsage, signal } = options;

    let lastError: unknown = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (signal?.aborted) throw new Error("Pipeline cancelled by user");

        if (attempt > 0) {
            const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1) + Math.random() * 1000;
            logger.log(`Retry ${attempt}/${MAX_RETRIES} in ${(delay / 1000).toFixed(1)}s...`);
            await sleep(delay);
        }

        try {
            try {
                const { object, usage } = await (generateObject as any)({
                    model,
                    system,
                    prompt,
                    schema,
                    maxOutputTokens,
                    abortSignal: signal,
                });
                if (usage && onUsage) onUsage({ promptTokens: (usage as SDKUsage).inputTokens ?? 0, completionTokens: (usage as SDKUsage).outputTokens ?? 0 });
                return object;
            } catch (err) {
                if (signal?.aborted) throw new Error("Pipeline cancelled by user");
                const msg = err instanceof Error ? err.message : String(err);
                if (isRetryable(err)) throw err;
                logger.log(`generateObject failed (${msg}), falling back to generateText`);
            }

            const jsonDirective =
                "\n\nCRITICAL: Respond with ONLY valid JSON. " +
                "No introductory text, no explanation, no markdown code fences. " +
                "Start your response with { or [ and end with } or ]. Nothing else.";

            const { text, usage } = await generateText({
                model,
                system: system + jsonDirective,
                prompt,
                maxOutputTokens,
                abortSignal: signal,
            });
            if (usage && onUsage) onUsage({ promptTokens: (usage as SDKUsage).inputTokens ?? 0, completionTokens: (usage as SDKUsage).outputTokens ?? 0 });

            const raw = extractJson<T>(text, logger);

            try {
                return schema.parse(raw) as T;
            } catch {
                logger.log("Fallback JSON did not pass schema validation, returning raw");
                return raw;
            }
        } catch (err) {
            if (signal?.aborted) throw new Error("Pipeline cancelled by user");
            lastError = err;
            if (!isRetryable(err) || attempt === MAX_RETRIES) {
                const msg = err instanceof Error ? err.message : String(err);
                throw new Error(`Failed after ${attempt + 1} attempts. Last error: ${msg}`);
            }
        }
    }

    throw lastError;
}

function extractJson<T>(raw: string, logger: PrefixLogger): T {
    let cleaned = raw.trim();

    if (cleaned.startsWith("```")) {
        cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    }

    try {
        return JSON.parse(cleaned) as T;
    } catch {
        // not direct-parseable
    }

    const firstBracket = findFirstJsonStart(cleaned);
    if (firstBracket >= 0) {
        const sub = cleaned.slice(firstBracket);
        const matched = extractBalancedJson(sub);
        if (matched) {
            try {
                return JSON.parse(matched) as T;
            } catch {
                logger.log("Balanced extraction found JSON-like block but parse failed");
            }
        }
    }

    const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
        try {
            return JSON.parse(arrayMatch[0]) as T;
        } catch {
            // fallthrough
        }
    }

    const objMatch = cleaned.match(/\{[\s\S]*\}/);
    if (objMatch) {
        try {
            return JSON.parse(objMatch[0]) as T;
        } catch {
            // fallthrough
        }
    }

    throw new Error(
        `Failed to extract valid JSON from LLM response (${cleaned.length} chars, starts with: "${cleaned.substring(0, 80)}")`
    );
}

function findFirstJsonStart(text: string): number {
    for (let i = 0; i < text.length; i++) {
        if (text[i] === "{" || text[i] === "[") return i;
    }
    return -1;
}

function extractBalancedJson(text: string): string | null {
    const opener = text[0];
    const closer = opener === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (escape) {
            escape = false;
            continue;
        }
        if (ch === "\\") {
            escape = true;
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            continue;
        }
        if (inString) continue;

        if (ch === opener) depth++;
        else if (ch === closer) {
            depth--;
            if (depth === 0) return text.slice(0, i + 1);
        }
    }
    return null;
}
