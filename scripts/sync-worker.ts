#!/usr/bin/env node
/**
 * Sync Worker Script
 * 
 * Runs background sync jobs for Slack, Jira, and Confluence.
 * 
 * Usage:
 *   npm run sync-worker -- --projectId <projectId>
 *   npm run sync-worker -- --projectId <projectId> --provider slack
 *   npm run sync-worker -- --all
 * 
 * Options:
 *   --projectId <id>    Sync a specific project
 *   --provider <name>   Only sync specific provider (slack, jira, confluence)
 *   --all               Sync all projects
 *   --interval <ms>     Run continuously with interval (default: one-shot)
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { parseArgs } from 'util';
import { MongoDBOAuthTokensRepository } from '@/src/infrastructure/repositories/mongodb.oauth-tokens.repository';
import { MongoDBKnowledgeDocumentsRepository } from '@/src/infrastructure/repositories/mongodb.knowledge-documents.repository';
import { MongoDBKnowledgeEntitiesRepository } from '@/src/infrastructure/repositories/mongodb.knowledge-entities.repository';
import { SlackSyncWorker } from '@/src/application/workers/sync/slack.sync';
import { JiraSyncWorker } from '@/src/application/workers/sync/jira.sync';
import { ConfluenceSyncWorker } from '@/src/application/workers/sync/confluence.sync';
import { db } from '@/lib/mongodb';
import { PrefixLogger } from '@/lib/utils';

const logger = new PrefixLogger('sync-worker');

// Initialize repositories
const oauthTokensRepository = new MongoDBOAuthTokensRepository();
const knowledgeDocumentsRepository = new MongoDBKnowledgeDocumentsRepository();
const knowledgeEntitiesRepository = new MongoDBKnowledgeEntitiesRepository();

// Initialize sync workers
const slackSyncWorker = new SlackSyncWorker(
    oauthTokensRepository,
    knowledgeDocumentsRepository,
    knowledgeEntitiesRepository,
    new PrefixLogger('slack-sync')
);

const jiraSyncWorker = new JiraSyncWorker(
    oauthTokensRepository,
    knowledgeDocumentsRepository,
    knowledgeEntitiesRepository,
    new PrefixLogger('jira-sync')
);

const confluenceSyncWorker = new ConfluenceSyncWorker(
    oauthTokensRepository,
    knowledgeDocumentsRepository,
    knowledgeEntitiesRepository,
    new PrefixLogger('confluence-sync')
);

interface SyncResult {
    provider: string;
    success: boolean;
    stats?: Record<string, number>;
    error?: string;
    duration: number;
}

interface SyncOptions {
    provider?: string;
    fullSync?: boolean;
    messageDays?: number;
}

async function syncProject(projectId: string, options: SyncOptions = {}): Promise<SyncResult[]> {
    const results: SyncResult[] = [];
    const { provider, fullSync = false, messageDays = 30 } = options;
    const providers = provider ? [provider] : ['slack', 'jira', 'confluence'];

    for (const p of providers) {
        const startTime = Date.now();
        try {
            let stats: Record<string, number>;
            
            switch (p) {
                case 'slack':
                    stats = await slackSyncWorker.sync({ 
                        projectId,
                        fullSync,
                        messageDays,
                    });
                    break;
                case 'jira':
                    stats = await jiraSyncWorker.sync({ projectId });
                    break;
                case 'confluence':
                    stats = await confluenceSyncWorker.sync({ projectId });
                    break;
                default:
                    throw new Error(`Unknown provider: ${p}`);
            }
            
            results.push({
                provider: p,
                success: true,
                stats,
                duration: Date.now() - startTime,
            });
        } catch (error) {
            results.push({
                provider: p,
                success: false,
                error: error instanceof Error ? error.message : String(error),
                duration: Date.now() - startTime,
            });
        }
    }

    return results;
}

async function syncAllProjects(options: SyncOptions = {}): Promise<void> {
    logger.log('Fetching all projects with connected integrations...');
    
    const tokens = await db.collection('oauth_tokens').find({}).toArray();
    const projectIds = [...new Set(tokens.map(t => t.projectId))];
    
    logger.log(`Found ${projectIds.length} projects to sync`);
    
    for (const projectId of projectIds) {
        logger.log(`\n--- Syncing project ${projectId} ---`);
        const results = await syncProject(projectId, options);
        
        for (const result of results) {
            if (result.success) {
                logger.log(`✓ ${result.provider}: ${JSON.stringify(result.stats)} (${result.duration}ms)`);
            } else {
                logger.log(`✗ ${result.provider}: ${result.error} (${result.duration}ms)`);
            }
        }
    }
}

async function main(): Promise<void> {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            projectId: { type: 'string' },
            provider: { type: 'string' },
            all: { type: 'boolean' },
            interval: { type: 'string' },
            fullSync: { type: 'boolean' },
            messageDays: { type: 'string' },
        },
    });

    const { projectId, provider, all, interval, fullSync, messageDays } = values;

    if (!projectId && !all) {
        console.error('Error: Either --projectId or --all is required');
        process.exit(1);
    }

    if (provider && !['slack', 'jira', 'confluence'].includes(provider)) {
        console.error('Error: --provider must be one of: slack, jira, confluence');
        process.exit(1);
    }

    const syncOpts: SyncOptions = {
        provider,
        fullSync: fullSync ?? false,
        messageDays: messageDays ? parseInt(messageDays, 10) : 30,
    };

    const runSync = async () => {
        if (all) {
            await syncAllProjects(syncOpts);
        } else if (projectId) {
            logger.log(`Syncing project ${projectId}${fullSync ? ' (full sync)' : ''}`);
            const results = await syncProject(projectId, syncOpts);
            
            for (const result of results) {
                if (result.success) {
                    logger.log(`✓ ${result.provider}: ${JSON.stringify(result.stats)} (${result.duration}ms)`);
                } else {
                    logger.log(`✗ ${result.provider}: ${result.error} (${result.duration}ms)`);
                }
            }
        }
    };

    if (interval) {
        const intervalMs = parseInt(interval, 10);
        logger.log(`Running continuously with ${intervalMs}ms interval`);
        
        while (true) {
            await runSync();
            logger.log(`\nNext sync in ${intervalMs}ms...`);
            await new Promise(resolve => setTimeout(resolve, intervalMs));
        }
    } else {
        await runSync();
        logger.log('\nSync completed');
        process.exit(0);
    }
}

main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
