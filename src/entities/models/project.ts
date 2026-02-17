import { z } from "zod";

export const Project = z.object({
    id: z.string().uuid(),
    name: z.string(),
    createdAt: z.string().datetime(),
    lastUpdatedAt: z.string().datetime().optional(),
    createdByUserId: z.string(),
    secret: z.string(),
    webhookUrl: z.string().optional(),
    // Company slug for multi-company routing (e.g., "bix")
    companySlug: z.string().optional(),
});

export type ProjectType = z.infer<typeof Project>;
