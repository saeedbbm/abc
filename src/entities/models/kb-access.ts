/**
 * KB Access Control Models
 * 
 * Defines roles, memberships, and per-page permission overrides
 * for the Knowledge Base.
 */

import { z } from "zod";

export const KBRole = z.enum(['admin', 'editor', 'viewer']);
export type KBRoleType = z.infer<typeof KBRole>;

/**
 * Company-level membership: maps a user to a company KB with a role.
 */
export const KBMembership = z.object({
    id: z.string(),
    userId: z.string(),
    userEmail: z.string(),
    userName: z.string().optional(),
    projectId: z.string(),
    companySlug: z.string(),
    role: KBRole,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});
export type KBMembershipType = z.infer<typeof KBMembership>;

export const CreateKBMembership = KBMembership.omit({
    id: true,
    createdAt: true,
    updatedAt: true,
});
export type CreateKBMembershipType = z.infer<typeof CreateKBMembership>;

/**
 * Per-page permission override.
 * Overrides the company-level role for a specific page + user.
 */
export const KBPagePermission = z.object({
    id: z.string(),
    pageId: z.string(),
    userId: z.string(),
    userEmail: z.string(),
    access: z.enum(['view', 'edit', 'none']),
    grantedBy: z.string(),
    createdAt: z.string().datetime(),
});
export type KBPagePermissionType = z.infer<typeof KBPagePermission>;

export const CreateKBPagePermission = KBPagePermission.omit({
    id: true,
    createdAt: true,
});
export type CreateKBPagePermissionType = z.infer<typeof CreateKBPagePermission>;
