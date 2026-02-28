import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-opus-4-6": { input: 15, output: 75 },
  "gpt-4o": { input: 2.5, output: 10 },
};

export function calculateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = MODEL_PRICING[model] ?? MODEL_PRICING["claude-sonnet-4-6"];
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

function getAnthropicProvider() {
    const apiKey = process.env.ANTHROPIC_API_KEY || '';
    if (!apiKey) {
        throw new Error('ANTHROPIC_API_KEY not configured.');
    }
    return createAnthropic({ apiKey });
}

function getOpenAIProvider() {
    const apiKey = process.env.OPENAI_API_KEY || '';
    if (!apiKey) {
        throw new Error('OPENAI_API_KEY not configured.');
    }
    return createOpenAI({ apiKey });
}

/**
 * Reasoning model for high-stakes decisions: planning, classification,
 * ticket extraction. Claude Opus 4.6.
 */
export function getReasoningModel() {
    return getAnthropicProvider()('claude-opus-4-6');
}

/**
 * Fast model for page generation (template filling), entity extraction,
 * and other high-volume tasks. Claude Sonnet 4.6.
 */
export function getFastModel() {
    return getAnthropicProvider()('claude-sonnet-4-6');
}

/** @deprecated Use getReasoningModel() or getFastModel() explicitly. */
export function getPrimaryModel() {
    return getReasoningModel();
}

/**
 * Cross-check model for extraction validation — uses a different provider
 * (OpenAI GPT-4o) to catch blindspots the primary model misses.
 */
export function getCrossCheckModel() {
    return getOpenAIProvider()(process.env.CROSS_CHECK_MODEL || 'gpt-4o');
}

/**
 * Embedding model — stays on OpenAI text-embedding-3-small (1536-dim).
 * Anthropic doesn't offer embeddings, so we keep OpenAI for this.
 */
export function getEmbeddingModel() {
    return getOpenAIProvider().embedding(
        process.env.EMBEDDING_MODEL || 'text-embedding-3-small'
    );
}
