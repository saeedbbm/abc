import { z } from "zod";

export const OAuthToken = z.object({
    id: z.string(),
    projectId: z.string(),
    provider: z.enum(['slack', 'atlassian']),
    accessToken: z.string(),  // Should be encrypted in production
    refreshToken: z.string().optional(), // Slack doesn't always have refresh tokens
    expiresAt: z.string().datetime().optional(), // Slack tokens don't expire by default
    scopes: z.array(z.string()),
    metadata: z.record(z.any()).default({}), // e.g., cloudId for Atlassian, team_id for Slack
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});

export type OAuthTokenType = z.infer<typeof OAuthToken>;

export const CreateOAuthTokenSchema = OAuthToken.omit({
    id: true,
    createdAt: true,
    updatedAt: true,
});

export type CreateOAuthTokenType = z.infer<typeof CreateOAuthTokenSchema>;
