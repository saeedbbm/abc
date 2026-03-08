import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { ModelSettings } from "@/src/entities/models/kb2-company-config";

const DEFAULT_FAST = "claude-sonnet-4-6";
const DEFAULT_REASONING = "claude-opus-4-6";
const DEFAULT_JUDGE = "gpt-4o";

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  [DEFAULT_FAST]: { input: 3, output: 15 },
  [DEFAULT_REASONING]: { input: 15, output: 75 },
  [DEFAULT_JUDGE]: { input: 2.5, output: 10 },
};

export function calculateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = MODEL_PRICING[model] ?? MODEL_PRICING[DEFAULT_FAST];
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

function resolveModel(name: string) {
    if (name.startsWith("claude")) return getAnthropicProvider()(name);
    return getOpenAIProvider()(name);
}

export function getReasoningModel(models?: ModelSettings) {
    const name = models?.reasoning ?? DEFAULT_REASONING;
    return resolveModel(name);
}

export function getReasoningModelName(models?: ModelSettings): string {
    return models?.reasoning ?? DEFAULT_REASONING;
}

export function getFastModel(models?: ModelSettings) {
    const name = models?.fast ?? DEFAULT_FAST;
    return resolveModel(name);
}

export function getFastModelName(models?: ModelSettings): string {
    return models?.fast ?? DEFAULT_FAST;
}

/** @deprecated Use getReasoningModel() or getFastModel() explicitly. */
export function getPrimaryModel(models?: ModelSettings) {
    return getReasoningModel(models);
}

export function getCrossCheckModel(models?: ModelSettings) {
    const name = models?.judge ?? process.env.CROSS_CHECK_MODEL ?? DEFAULT_JUDGE;
    return resolveModel(name);
}

export function getCrossCheckModelName(models?: ModelSettings): string {
    return models?.judge ?? process.env.CROSS_CHECK_MODEL ?? DEFAULT_JUDGE;
}

export function getEmbeddingModel() {
    return getOpenAIProvider().embedding(
        process.env.EMBEDDING_MODEL || 'text-embedding-3-small'
    );
}
