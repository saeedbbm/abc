/**
 * Atlassian API Rate Limiter
 * 
 * Atlassian Cloud APIs have rate limits that vary by endpoint.
 * General limits:
 * - REST API: ~100 requests per minute (varies)
 * - Search endpoints: May be more restrictive
 * 
 * We implement a simple rate limiter with retry-after handling.
 */

interface RateLimitState {
    tokens: number;
    lastRefill: number;
    retryAfter: number | null;
}

const DEFAULT_RATE_LIMIT = 60; // requests per minute

export class AtlassianRateLimiter {
    private state: Map<string, RateLimitState> = new Map();
    private rateLimit: number;

    constructor(rateLimit: number = DEFAULT_RATE_LIMIT) {
        this.rateLimit = rateLimit;
    }

    private getState(key: string): RateLimitState {
        if (!this.state.has(key)) {
            this.state.set(key, {
                tokens: this.rateLimit,
                lastRefill: Date.now(),
                retryAfter: null,
            });
        }
        return this.state.get(key)!;
    }

    private refillTokens(state: RateLimitState): void {
        const now = Date.now();
        const elapsed = now - state.lastRefill;
        const refillRate = this.rateLimit / 60000; // tokens per ms
        const tokensToAdd = elapsed * refillRate;
        
        state.tokens = Math.min(this.rateLimit, state.tokens + tokensToAdd);
        state.lastRefill = now;
    }

    async waitForToken(cloudId: string): Promise<void> {
        const state = this.getState(cloudId);
        
        // Check if we're in a retry-after period
        if (state.retryAfter !== null && Date.now() < state.retryAfter) {
            const waitTime = state.retryAfter - Date.now();
            console.log(`[AtlassianRateLimiter] Waiting ${waitTime}ms for retry-after on ${cloudId}`);
            await this.sleep(waitTime);
            state.retryAfter = null;
        }

        // Refill tokens based on elapsed time
        this.refillTokens(state);

        // Wait for a token if none available
        if (state.tokens < 1) {
            const waitTime = Math.ceil((1 - state.tokens) / (this.rateLimit / 60000));
            console.log(`[AtlassianRateLimiter] Waiting ${waitTime}ms for token on ${cloudId}`);
            await this.sleep(waitTime);
            this.refillTokens(state);
        }

        // Consume a token
        state.tokens -= 1;
    }

    setRetryAfter(cloudId: string, seconds: number): void {
        const state = this.getState(cloudId);
        state.retryAfter = Date.now() + (seconds * 1000);
        state.tokens = 0;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Singleton instance
export const atlassianRateLimiter = new AtlassianRateLimiter();
