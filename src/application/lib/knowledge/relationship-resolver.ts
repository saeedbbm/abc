/**
 * Relationship Resolver
 * 
 * Given a topic, entity, document, or finding, traverses the knowledge graph
 * to find ALL relevant people -- not by substring matching, but by actual
 * relationships: ownership, assignment, participation, conversation involvement.
 * 
 * Returns a ranked list of people with their relevance reason.
 */

import { PrefixLogger } from "@/lib/utils";
import { MongoDBKnowledgeEntitiesRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-entities.repository";
import { MongoDBKnowledgeDocumentsRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-documents.repository";
import { KnowledgeEntityType } from "@/src/entities/models/knowledge-entity";
import { AuditEvidenceType } from "@/src/entities/models/doc-audit";

export interface RelevantPerson {
    entityId: string;
    name: string;
    slackUserId: string;
    reasons: string[];            // Why this person is relevant
    relevanceScore: number;       // 0-1, higher = more relevant
}

export class RelationshipResolver {
    private entitiesRepo: MongoDBKnowledgeEntitiesRepository;
    private docsRepo: MongoDBKnowledgeDocumentsRepository;
    private logger: PrefixLogger;

    constructor(
        entitiesRepo: MongoDBKnowledgeEntitiesRepository,
        docsRepo: MongoDBKnowledgeDocumentsRepository,
        logger?: PrefixLogger
    ) {
        this.entitiesRepo = entitiesRepo;
        this.docsRepo = docsRepo;
        this.logger = logger || new PrefixLogger('relationship-resolver');
    }

    /**
     * Find relevant people for a given entity (system, project, customer, etc.)
     */
    async resolveForEntity(
        projectId: string,
        entityId: string
    ): Promise<RelevantPerson[]> {
        const entity = await this.entitiesRepo.fetch(entityId);
        if (!entity) return [];

        const people = await this.getAllPeople(projectId);
        const results: Map<string, RelevantPerson> = new Map();

        const metadata = entity.metadata as Record<string, any>;

        // 1. Direct ownership/assignment
        if (metadata.owner) {
            await this.addPersonByRef(results, people, metadata.owner, `owns ${entity.name}`, 1.0);
        }
        if (metadata.lead) {
            await this.addPersonByRef(results, people, metadata.lead, `leads ${entity.name}`, 0.95);
        }
        if (metadata.accountOwner) {
            await this.addPersonByRef(results, people, metadata.accountOwner, `account owner for ${entity.name}`, 1.0);
        }

        // 2. Team members
        if (metadata.members) {
            for (const memberId of metadata.members) {
                await this.addPersonByRef(results, people, memberId, `member of ${entity.name}`, 0.7);
            }
        }
        if (metadata.participants) {
            for (const participantId of metadata.participants) {
                await this.addPersonByRef(results, people, participantId, `participates in ${entity.name}`, 0.6);
            }
        }

        // 3. Team ownership (if entity has a team, find team lead and members)
        if (metadata.team) {
            const team = await this.findEntityByRef(projectId, metadata.team, 'team');
            if (team) {
                const teamMeta = team.metadata as Record<string, any>;
                if (teamMeta.lead) {
                    await this.addPersonByRef(results, people, teamMeta.lead, `leads team that owns ${entity.name}`, 0.85);
                }
                for (const memberId of (teamMeta.members || [])) {
                    await this.addPersonByRef(results, people, memberId, `on team responsible for ${entity.name}`, 0.5);
                }
            }
        }

        // 4. Check entity sources to find who contributed information
        for (const source of entity.sources) {
            if (source.provider === 'jira') {
                // Find the Jira issue and get assignee/reporter
                const doc = await this.docsRepo.findBySourceId(projectId, 'jira', source.sourceId);
                if (doc) {
                    const docMeta = doc.metadata as Record<string, any>;
                    if (docMeta.assigneeName) {
                        this.addPersonByName(results, people, docMeta.assigneeName, `assigned to ${docMeta.issueKey || 'related Jira issue'}`, 0.8);
                    }
                    if (docMeta.reporterName) {
                        this.addPersonByName(results, people, docMeta.reporterName, `reported ${docMeta.issueKey || 'related Jira issue'}`, 0.6);
                    }
                }
            }
        }

        // 5. Key contacts for customers
        if (metadata.keyContacts) {
            for (const contact of metadata.keyContacts) {
                this.addPersonByName(results, people, contact.name, `key contact for ${entity.name}`, 0.7);
            }
        }

        return this.rankResults(results);
    }

    /**
     * Find relevant people for a set of evidence items
     */
    async resolveForEvidence(
        projectId: string,
        evidence: AuditEvidenceType[],
        relatedEntityNames: string[] = []
    ): Promise<RelevantPerson[]> {
        const people = await this.getAllPeople(projectId);
        const results: Map<string, RelevantPerson> = new Map();

        // 1. Check Jira evidence for assignees/reporters
        for (const e of evidence) {
            if (e.provider === 'jira') {
                try {
                    const doc = await this.docsRepo.findBySourceId(projectId, 'jira', e.documentId);
                    if (!doc) {
                        // Try by title match
                        const { items } = await this.docsRepo.findByProjectId(projectId, {
                            provider: 'jira',
                            sourceType: 'jira_issue',
                            limit: 1,
                        });
                        // Just use what we have
                    }
                    if (doc) {
                        const docMeta = doc.metadata as Record<string, any>;
                        if (docMeta.assigneeName) {
                            this.addPersonByName(results, people, docMeta.assigneeName,
                                `assigned to ${docMeta.issueKey || e.title}`, 0.9);
                        }
                        if (docMeta.reporterName) {
                            this.addPersonByName(results, people, docMeta.reporterName,
                                `reported ${docMeta.issueKey || e.title}`, 0.7);
                        }
                    }
                } catch (error) {
                    // Skip
                }
            }

            // 2. Check Slack evidence for message authors
            if (e.provider === 'slack') {
                try {
                    const doc = await this.docsRepo.findBySourceId(projectId, 'slack', e.documentId);
                    if (!doc) continue;
                    const docMeta = doc.metadata as Record<string, any>;
                    if (docMeta.userName) {
                        this.addPersonByName(results, people, docMeta.userName,
                            `discussed this in Slack`, 0.6);
                    }
                } catch (error) {
                    // Skip
                }
            }

            // 3. Check Confluence evidence for page authors
            if (e.provider === 'confluence') {
                try {
                    const doc = await this.docsRepo.findBySourceId(projectId, 'confluence', e.documentId);
                    if (!doc) continue;
                    const docMeta = doc.metadata as Record<string, any>;
                    if (docMeta.authorName) {
                        this.addPersonByName(results, people, docMeta.authorName,
                            `authored the Confluence page "${e.title}"`, 0.8);
                    }
                } catch (error) {
                    // Skip
                }
            }
        }

        // 4. Find owners of related entities (systems, projects)
        for (const entityName of relatedEntityNames) {
            const entity = await this.entitiesRepo.findByName(projectId, entityName)
                || await this.entitiesRepo.findByAlias(projectId, entityName);
            if (entity) {
                const meta = entity.metadata as Record<string, any>;
                if (meta.owner) {
                    await this.addPersonByRef(results, people, meta.owner,
                        `owns ${entity.name}`, 0.9);
                }
                if (meta.lead) {
                    await this.addPersonByRef(results, people, meta.lead,
                        `leads ${entity.name}`, 0.85);
                }
            }
        }

        // 5. Check for people mentioned in evidence text (as a fallback, but with lower score)
        for (const person of people) {
            if (results.has(person.id)) continue; // Already found by relationship
            
            const metadata = person.metadata as Record<string, any>;
            const nameVariants = [person.name.toLowerCase(), ...(person.aliases || []).map(a => a.toLowerCase())];
            
            for (const e of evidence) {
                const excerptLower = e.excerpt.toLowerCase();
                const mentioned = nameVariants.some(n => excerptLower.includes(n));
                if (mentioned && metadata.slackUserId) {
                    this.addPersonDirectly(results, person, `mentioned in ${e.provider} evidence`, 0.4);
                    break;
                }
            }
        }

        return this.rankResults(results);
    }

    /**
     * Find relevant people for a specific Confluence page
     */
    async resolveForConfluencePage(
        projectId: string,
        confluencePageId: string
    ): Promise<RelevantPerson[]> {
        const people = await this.getAllPeople(projectId);
        const results: Map<string, RelevantPerson> = new Map();

        // Find the page document
        const { items: pages } = await this.docsRepo.findByProjectId(projectId, {
            provider: 'confluence',
            sourceType: 'confluence_page',
            limit: 500,
        });

        const page = pages.find(p => {
            const m = p.metadata as Record<string, any>;
            return m.pageId === confluencePageId;
        });

        if (page) {
            const pageMeta = page.metadata as Record<string, any>;
            
            // Page author
            if (pageMeta.authorName) {
                this.addPersonByName(results, people, pageMeta.authorName,
                    `authored "${page.title}"`, 0.9);
            }

            // Check if any system entity references this page
            const allEntities = await this.loadAllEntities(projectId);
            for (const entity of allEntities) {
                const meta = entity.metadata as Record<string, any>;
                if (meta.documentation && meta.documentation.includes(confluencePageId)) {
                    if (meta.owner) {
                        await this.addPersonByRef(results, people, meta.owner,
                            `owns ${entity.name} which this page documents`, 0.85);
                    }
                }
            }
        }

        return this.rankResults(results);
    }

    // -----------------------------------------------------------------------
    // Helper methods
    // -----------------------------------------------------------------------

    private async getAllPeople(projectId: string): Promise<KnowledgeEntityType[]> {
        const result = await this.entitiesRepo.findByProjectId(projectId, {
            type: 'person',
            limit: 500,
        });
        return result.items;
    }

    private async loadAllEntities(projectId: string): Promise<KnowledgeEntityType[]> {
        const result = await this.entitiesRepo.findByProjectId(projectId, { limit: 500 });
        return result.items;
    }

    private async findEntityByRef(
        projectId: string,
        ref: string,
        type?: string
    ): Promise<KnowledgeEntityType | null> {
        // ref could be an entity ID or a name
        const byId = await this.entitiesRepo.fetch(ref);
        if (byId) return byId;
        
        const byName = await this.entitiesRepo.findByName(projectId, ref, type);
        if (byName) return byName;

        const byAlias = await this.entitiesRepo.findByAlias(projectId, ref, type);
        return byAlias;
    }

    private async addPersonByRef(
        results: Map<string, RelevantPerson>,
        people: KnowledgeEntityType[],
        ref: string,
        reason: string,
        score: number
    ): Promise<void> {
        // ref could be an entity ID, a name, or a slackUserId
        let person = people.find(p => p.id === ref);
        if (!person) {
            person = people.find(p => 
                p.name.toLowerCase() === ref.toLowerCase() ||
                p.aliases.some(a => a.toLowerCase() === ref.toLowerCase())
            );
        }
        if (!person) {
            person = people.find(p => {
                const m = p.metadata as Record<string, any>;
                return m.slackUserId === ref || m.jiraAccountId === ref;
            });
        }

        if (person) {
            this.addPersonDirectly(results, person, reason, score);
        }
    }

    private addPersonByName(
        results: Map<string, RelevantPerson>,
        people: KnowledgeEntityType[],
        name: string,
        reason: string,
        score: number
    ): void {
        const nameLower = name.toLowerCase();
        const person = people.find(p =>
            p.name.toLowerCase() === nameLower ||
            p.name.toLowerCase().includes(nameLower) ||
            nameLower.includes(p.name.toLowerCase()) ||
            p.aliases.some(a => a.toLowerCase() === nameLower)
        );

        if (person) {
            this.addPersonDirectly(results, person, reason, score);
        }
    }

    private addPersonDirectly(
        results: Map<string, RelevantPerson>,
        person: KnowledgeEntityType,
        reason: string,
        score: number
    ): void {
        const metadata = person.metadata as Record<string, any>;
        if (!metadata.slackUserId) return; // Can't notify without Slack ID

        const existing = results.get(person.id);
        if (existing) {
            if (!existing.reasons.includes(reason)) {
                existing.reasons.push(reason);
            }
            existing.relevanceScore = Math.max(existing.relevanceScore, score);
        } else {
            results.set(person.id, {
                entityId: person.id,
                name: person.name,
                slackUserId: metadata.slackUserId,
                reasons: [reason],
                relevanceScore: score,
            });
        }
    }

    private rankResults(results: Map<string, RelevantPerson>): RelevantPerson[] {
        return Array.from(results.values())
            .sort((a, b) => {
                // Sort by score descending, then by number of reasons
                if (b.relevanceScore !== a.relevanceScore) {
                    return b.relevanceScore - a.relevanceScore;
                }
                return b.reasons.length - a.reasons.length;
            });
    }
}
