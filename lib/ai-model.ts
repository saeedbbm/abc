import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";

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
 * Primary model for all generation, analysis, and reasoning tasks.
 * Claude Opus 4.6 — the most advanced model available.
 */
export function getPrimaryModel() {
    return getAnthropicProvider()('claude-opus-4-6');
}

/**
 * Fast model for high-volume tasks like entity extraction batches
 * where Opus would be too slow/expensive.
 * Still Claude — Sonnet 4 for quality.
 */
export function getFastModel() {
    return getAnthropicProvider()('claude-sonnet-4-6');
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
