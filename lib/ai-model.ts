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
 * Embedding model — stays on OpenAI text-embedding-3-small (1536-dim).
 * Anthropic doesn't offer embeddings, so we keep OpenAI for this.
 */
export function getEmbeddingModel() {
    return getOpenAIProvider().embedding(
        process.env.EMBEDDING_MODEL || 'text-embedding-3-small'
    );
}
