/**
 * Slack API Rate Limiter
 * 
 * Slack uses tiered rate limiting:
 * - Tier 1: 1 request per minute
 * - Tier 2: 20 requests per minute
 * - Tier 3: 50 requests per minute (most common)
 * - Tier 4: 100 requests per minute
 * 
 * We implement a simple token bucket with exponential backoff for retries.
 */

export type SlackApiTier = 1 | 2 | 3 | 4;

interface RateLimitState {
    tokens: number;
    lastRefill: number;
    retryAfter: number | null;
}

const TIER_LIMITS: Record<SlackApiTier, number> = {
    1: 1,
    2: 20,
    3: 50,
    4: 100,
};

export class SlackRateLimiter {
    private state: Map<string, RateLimitState> = new Map();
    private defaultTier: SlackApiTier;

    constructor(defaultTier: SlackApiTier = 3) {
        this.defaultTier = defaultTier;
    }

    private getState(key: string, tier: SlackApiTier): RateLimitState {
        if (!this.state.has(key)) {
            this.state.set(key, {
                tokens: TIER_LIMITS[tier],
                lastRefill: Date.now(),
                retryAfter: null,
            });
        }
        return this.state.get(key)!;
    }

    private refillTokens(state: RateLimitState, tier: SlackApiTier): void {
        const now = Date.now();
        const elapsed = now - state.lastRefill;
        const refillRate = TIER_LIMITS[tier] / 60000; // tokens per ms
        const tokensToAdd = elapsed * refillRate;
        
        state.tokens = Math.min(TIER_LIMITS[tier], state.tokens + tokensToAdd);
        state.lastRefill = now;
    }

    async waitForToken(endpoint: string, tier: SlackApiTier = this.defaultTier): Promise<void> {
        const state = this.getState(endpoint, tier);
        
        // Check if we're in a retry-after period
        if (state.retryAfter !== null && Date.now() < state.retryAfter) {
            const waitTime = state.retryAfter - Date.now();
            console.log(`[SlackRateLimiter] Waiting ${waitTime}ms for retry-after on ${endpoint}`);
            await this.sleep(waitTime);
            state.retryAfter = null;
        }

        // Refill tokens based on elapsed time
        this.refillTokens(state, tier);

        // Wait for a token if none available
        if (state.tokens < 1) {
            const waitTime = Math.ceil((1 - state.tokens) / (TIER_LIMITS[tier] / 60000));
            console.log(`[SlackRateLimiter] Waiting ${waitTime}ms for token on ${endpoint}`);
            await this.sleep(waitTime);
            this.refillTokens(state, tier);
        }

        // Consume a token
        state.tokens -= 1;
    }

    setRetryAfter(endpoint: string, seconds: number): void {
        const state = this.getState(endpoint, this.defaultTier);
        state.retryAfter = Date.now() + (seconds * 1000);
        state.tokens = 0;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Singleton instance
export const slackRateLimiter = new SlackRateLimiter();
