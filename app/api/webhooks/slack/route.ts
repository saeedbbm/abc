import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { getPrimaryModel } from "@/lib/ai-model";
import { MongoDBOAuthTokensRepository } from "@/src/infrastructure/repositories/mongodb.oauth-tokens.repository";
import { MongoDBKnowledgeDocumentsRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-documents.repository";
import { SlackClient } from "@/src/application/lib/integrations/slack";
import { JiraClient, ConfluenceClient, getValidAtlassianToken } from "@/src/application/lib/integrations/atlassian";
import { verifySlackSignature } from "@/src/application/lib/integrations/slack/oauth";
import { embedKnowledgeDocument, ensureKnowledgeCollection, searchKnowledgeWithContext } from "@/src/application/lib/knowledge";
import { processMessageForTopics } from "@/src/application/lib/knowledge/topic-knowledge-service";
import { matchAndVerifyClaims } from "@/src/application/lib/knowledge/claim-matcher";
import { PrefixLogger } from "@/lib/utils";

const oauthTokensRepository = new MongoDBOAuthTokensRepository();
const knowledgeDocumentsRepository = new MongoDBKnowledgeDocumentsRepository();
const logger = new PrefixLogger('slack-webhook');

// Simple in-memory cache for processed events (to prevent duplicate processing)
// In production, use Redis or database
const processedEvents = new Map<string, number>();
const EVENT_CACHE_TTL = 60 * 1000; // 1 minute

function isEventProcessed(eventId: string): boolean {
    const timestamp = processedEvents.get(eventId);
    if (timestamp && Date.now() - timestamp < EVENT_CACHE_TTL) {
        return true;
    }
    return false;
}

function markEventProcessed(eventId: string): void {
    processedEvents.set(eventId, Date.now());
    
    // Clean up old entries periodically
    if (processedEvents.size > 1000) {
        const now = Date.now();
        for (const [key, time] of processedEvents.entries()) {
            if (now - time > EVENT_CACHE_TTL) {
                processedEvents.delete(key);
            }
        }
    }
}

// We need to find the project ID based on the Slack team ID
async function findProjectBySlackTeamId(teamId: string): Promise<string | null> {
    const tokens = await oauthTokensRepository.findByProviderMetadata('slack', 'teamId', teamId);
    if (tokens && tokens.length > 0) {
        return tokens[0].projectId;
    }
    return null;
}

export async function POST(req: NextRequest): Promise<Response> {
    const body = await req.text();
    
    // Get Slack signature headers
    const signature = req.headers.get("x-slack-signature") || "";
    const timestamp = req.headers.get("x-slack-request-timestamp") || "";
    
    // Parse the body
    let payload;
    try {
        payload = JSON.parse(body);
    } catch (e) {
        console.error("[Slack Webhook] Failed to parse body:", e);
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    console.log("[Slack Webhook] Received event type:", payload.type);

    // Handle URL verification challenge
    if (payload.type === "url_verification") {
        console.log("[Slack Webhook] URL verification challenge received");
        return NextResponse.json({ challenge: payload.challenge });
    }

    // Verify the request signature (skip in development if no signing secret)
    const signingSecret = process.env.SLACK_SIGNING_SECRET;
    if (signingSecret) {
        const isValid = verifySlackSignature(signature, timestamp, body, signingSecret);
        if (!isValid) {
            console.error("[Slack Webhook] Invalid signature");
            return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
        }
    } else {
        console.warn("[Slack Webhook] No SLACK_SIGNING_SECRET set, skipping signature verification");
    }

    // Handle event callbacks
    if (payload.type === "event_callback") {
        const event = payload.event;
        const teamId = payload.team_id;
        
        console.log("[Slack Webhook] Event:", event.type, "from team:", teamId);

        // Handle app_mention events (respond to questions)
        if (event.type === "app_mention") {
            const eventId = `mention:${event.channel}:${event.ts}`;
            
            if (isEventProcessed(eventId)) {
                console.log("[Slack Webhook] Duplicate event, skipping:", eventId);
                return NextResponse.json({ ok: true });
            }
            
            markEventProcessed(eventId);
            
            processAppMention(event, teamId).catch(err => {
                console.error("[Slack Webhook] Error processing mention:", err);
            });
            
            return NextResponse.json({ ok: true });
        }

        // Handle new message events (ingest into knowledge base)
        if (event.type === "message" && !event.subtype && event.user) {
            const eventId = `message:${event.channel}:${event.ts}`;
            
            if (isEventProcessed(eventId)) {
                console.log("[Slack Webhook] Duplicate message event, skipping:", eventId);
                return NextResponse.json({ ok: true });
            }
            
            markEventProcessed(eventId);
            
            ingestSlackMessage(event, teamId).catch(err => {
                console.error("[Slack Webhook] Error ingesting message:", err);
            });
            
            return NextResponse.json({ ok: true });
        }

        // Handle message edits (message_changed subtype)
        if (event.type === "message" && event.subtype === "message_changed" && event.message) {
            const editedMsg = event.message;
            const eventId = `edit:${event.channel}:${editedMsg.ts}`;

            if (isEventProcessed(eventId)) return NextResponse.json({ ok: true });
            markEventProcessed(eventId);

            // Re-ingest with updated content
            ingestSlackMessage(
                { ...editedMsg, channel: event.channel },
                teamId
            ).catch(err => {
                console.error("[Slack Webhook] Error ingesting edited message:", err);
            });

            return NextResponse.json({ ok: true });
        }

        // Handle message deletes (message_deleted subtype)
        if (event.type === "message" && event.subtype === "message_deleted" && event.previous_message) {
            const deletedTs = event.previous_message.ts;
            const eventId = `delete:${event.channel}:${deletedTs}`;

            if (isEventProcessed(eventId)) return NextResponse.json({ ok: true });
            markEventProcessed(eventId);

            deleteSlackMessage(event.channel, deletedTs, teamId).catch(err => {
                console.error("[Slack Webhook] Error deleting message:", err);
            });

            return NextResponse.json({ ok: true });
        }

        // Handle channel events (channel_created, channel_rename, channel_deleted)
        if (['channel_created', 'channel_rename'].includes(event.type)) {
            logger.log(`Channel event: ${event.type} — ${event.channel?.name || event.channel?.id}`);
            return NextResponse.json({ ok: true });
        }
        if (event.type === 'channel_deleted') {
            logger.log(`Channel deleted: ${event.channel}`);
            return NextResponse.json({ ok: true });
        }
    }

    return NextResponse.json({ ok: true });
}

async function processAppMention(event: any, teamId: string) {
    console.log("[Slack Webhook] Processing app_mention:", {
        user: event.user,
        channel: event.channel,
        text: event.text,
        ts: event.ts,
    });

    // Find the project ID based on team ID
    const projectId = await findProjectBySlackTeamId(teamId);
    if (!projectId) {
        console.error("[Slack Webhook] No project found for team:", teamId);
        return;
    }

    console.log("[Slack Webhook] Found project:", projectId);

    // Get OAuth tokens
    const slackToken = await oauthTokensRepository.fetchByProjectAndProvider(projectId, 'slack');
    
    // Get Atlassian token with auto-refresh
    const atlassianToken = await getValidAtlassianToken(projectId);

    if (!slackToken) {
        console.error("[Slack Webhook] No Slack token found for project:", projectId);
        return;
    }

    // Initialize clients
    const slackClient = new SlackClient(slackToken.accessToken);
    const jiraClient = atlassianToken && atlassianToken.metadata?.cloudId 
        ? new JiraClient(atlassianToken.accessToken, atlassianToken.metadata.cloudId as string) : null;
    const confluenceClient = atlassianToken && atlassianToken.metadata?.cloudId 
        ? new ConfluenceClient(atlassianToken.accessToken, atlassianToken.metadata.cloudId as string) : null;
    
    console.log("[Slack Webhook] Initialized clients - Jira:", !!jiraClient, "Confluence:", !!confluenceClient);

    // Extract the question (remove the bot mention)
    const botMentionRegex = /<@[A-Z0-9]+>/g;
    const question = event.text.replace(botMentionRegex, "").trim();

    if (!question) {
        await slackClient.postMessage(event.channel, "Hi! How can I help you? Ask me a question about your team, projects, or documentation.", {
            threadTs: event.ts,
        });
        return;
    }

    console.log("[Slack Webhook] Question:", question);

    // Search knowledge embeddings for relevant information
    let knowledgeContext = "";
    let sourceLinks: string[] = [];
    try {
        const searchResults = await searchKnowledgeWithContext(projectId, question, {
            limit: 20,
            expandContext: true,
        });
        
        if (searchResults.length > 0) {
            const filteredResults = searchResults.slice(0, 25);

            console.log(`[Slack Webhook] Found ${searchResults.length} results, ${filteredResults.length} after filtering`);
            const sourceBreakdown = filteredResults.reduce((acc, r) => {
                acc[r.provider] = (acc[r.provider] || 0) + 1;
                return acc;
            }, {} as Record<string, number>);
            console.log(`[Slack Webhook] Source breakdown:`, sourceBreakdown);
            console.log(`[Slack Webhook] Top results:`, filteredResults.slice(0, 5).map(r => 
                `${r.provider}/${r.sourceType}: "${r.title?.substring(0, 40)}..." (score: ${r.score?.toFixed(3)})`
            ));
            const withContext = filteredResults.filter(r => r.conversationContext).length;
            console.log(`[Slack Webhook] Results with conversation context: ${withContext}`);
            
            const has350 = filteredResults.some(r => r.content.includes('350') || r.conversationContext?.includes('350'));
            const has400 = filteredResults.some(r => r.content.includes('400') || r.conversationContext?.includes('400'));
            console.log(`[Slack Webhook] Contains 350: ${has350}, Contains 400: ${has400}`);
            
            knowledgeContext = "=== RELEVANT INFORMATION FROM TEAM CONVERSATIONS AND DOCUMENTS ===\n\n";
            knowledgeContext += filteredResults.map((r, i) => {
                const url = r.metadata?.url || r.metadata?.webUrl;
                const refLabel = `[S${i + 1}]`;
                let sourceRef = `${refLabel} ${r.provider}/${r.sourceType} - ${r.title}${url ? ` | URL: ${url}` : ''}`;
                
                const messageUrls: string[] = r.metadata?.messageUrls || [];
                if (messageUrls.length > 0) {
                    sourceRef += `\n  Individual message URLs: ${messageUrls.join(', ')}`;
                }
                
                if (url && !sourceLinks.includes(url)) {
                    sourceLinks.push(url);
                }
                for (const mUrl of messageUrls) {
                    if (mUrl && !sourceLinks.includes(mUrl)) {
                        sourceLinks.push(mUrl);
                    }
                }
                
                let content = r.content;
                
                if (r.conversationContext && r.sourceType !== 'slack_conversation') {
                    content = `[Individual message:]\n${r.content}\n\n[Full conversation context:]\n${r.conversationContext}`;
                }
                
                return `${sourceRef}\n${content}`;
            }).join("\n\n---\n\n");
            knowledgeContext += "\n\n=== END OF KNOWLEDGE BASE RESULTS ===\n\n";
        } else {
            console.log("[Slack Webhook] No relevant knowledge found in embeddings");
        }
    } catch (e) {
        console.error("[Slack Webhook] Error searching knowledge:", e);
    }

    // Check if user wants no references
    const questionLower = question.toLowerCase();
    const noReferences = questionLower.includes('no reference') || 
                         questionLower.includes('no sources') || 
                         questionLower.includes('without reference') ||
                         questionLower.includes('without sources');
    
    // Check if user wants just a number/value
    const justNumber = questionLower.includes('just give me') && 
                       (questionLower.includes('number') || questionLower.includes('one'));

    // Build context from integrations
    let context = "You are a helpful knowledge assistant for a company. ";
    context += "Answer questions based on the information provided from Slack messages, Jira tickets, and Confluence pages.\n\n";
    
    context += "=== CRITICAL: FOLLOW USER INSTRUCTIONS PRECISELY ===\n";
    if (justNumber) {
        context += "THE USER ASKED FOR JUST A NUMBER. Respond with ONLY the number/value (e.g., '100ms' or '350ms'). NO other text.\n\n";
    } else if (noReferences) {
        context += "THE USER ASKED FOR NO REFERENCES. Do NOT include any source links. Just answer the question.\n\n";
    } else {
        context += "- If user says 'just give me a number', respond with ONLY the number.\n";
        context += "- If user says 'no reference' or 'no sources', do NOT include source links.\n\n";
    }
    
    if (!justNumber) {
        context += "=== RESPONSE FORMAT: INLINE CITATIONS ===\n\n";
        
        context += "Write informative sentences. After EACH factual claim, add an inline citation linking to the source.\n";
        context += "Use Slack's link format: (<https://URL|View>)\n\n";
        
        context += "EXAMPLE of the format you MUST follow:\n";
        context += "Matt mentioned the postgres latency is around 400ms (<https://slack.com/archives/C123/p456|View>). ";
        context += "Later, Sarah corrected this to 350ms (<https://slack.com/archives/C123/p789|View>). ";
        context += "The plan is to reduce it from 400 to 100ms, tracked in Jira ticket KAN-5 assigned to Alex Rivera (<https://jira.atlassian.net/browse/KAN-5|View>). ";
        context += "The Q1 roadmap confirms the 100ms target (<https://confluence.atlassian.net/wiki/pages/123|View>).\n\n";
        
        context += "RULES for inline citations:\n";
        context += "- EVERY factual sentence MUST end with a source link in parentheses: (<URL|View>)\n";
        context += "- If multiple sources support the same fact, list them: (<URL1|View>, <URL2|View>)\n";
        context += "- Use the EXACT URLs provided in the [S1], [S2], etc. source references below\n";
        context += "- Attribute information to the person who said/wrote it when available\n";
        context += "- When values changed over time (e.g., latency numbers), describe them chronologically\n";
        context += "- Do NOT put all sources at the end — they must be INLINE after each sentence\n";
        context += "- Do NOT use a separate 'Sources:' section at the bottom\n\n";
    }
    
    context += "=== OTHER RULES ===\n";
    context += "- Keep answers focused - only include directly relevant information.\n";
    context += "- Do NOT use bullet points in the main answer. Use flowing sentences.\n";
    context += "- Track ALL numeric values mentioned over time for topics like latency, costs, etc.\n";
    context += "- ALWAYS mention relevant Jira tickets (e.g., KAN-5) with inline links when they appear in the sources.\n";
    context += "- Include ALL relevant numeric values from the sources (e.g., if latency values 400ms, 350ms, 240ms appear, mention ALL of them chronologically).\n\n";

    // Gather some context from integrations
    let integrationContext = "";

    try {
        // Get Slack users for context
        if (slackClient) {
            const users: any[] = [];
            for await (const user of slackClient.listAllUsers()) {
                if (!user.is_bot && !user.deleted) {
                    users.push({
                        name: user.real_name || user.name,
                        title: user.profile?.title,
                        email: user.profile?.email,
                    });
                }
                if (users.length >= 20) break;
            }
            integrationContext += "Team members on Slack:\n" + users.map(u => 
                `- ${u.name}${u.title ? ` (${u.title})` : ''}${u.email ? ` - ${u.email}` : ''}`
            ).join("\n") + "\n\n";
        }

        // Get Jira projects and recent issues for context
        if (jiraClient) {
            try {
                const projects = await jiraClient.listProjects();
                integrationContext += "Jira Projects:\n" + projects.slice(0, 5).map(p => 
                    `- ${p.key}: ${p.name} (Lead: ${p.lead?.displayName || 'Unknown'})`
                ).join("\n") + "\n\n";
            } catch (e) {
                console.error("[Slack Webhook] Error fetching Jira projects:", e);
            }
        }

        // Get Confluence spaces for context
        if (confluenceClient) {
            try {
                const { spaces } = await confluenceClient.listSpaces();
                integrationContext += "Confluence Spaces:\n" + spaces.slice(0, 5).map(s => 
                    `- ${s.key}: ${s.name}`
                ).join("\n") + "\n\n";
            } catch (e) {
                console.error("[Slack Webhook] Error fetching Confluence spaces:", e);
            }
        }
    } catch (e) {
        console.error("[Slack Webhook] Error gathering context:", e);
    }

    // Generate response using AI
    try {
        const systemPrompt = context + knowledgeContext + integrationContext + "\nAnswer the following question from a team member:";
        
        const { text: answer } = await generateText({
            model: getPrimaryModel(),
            system: systemPrompt,
            prompt: question,
            maxOutputTokens: 500,
        });

        console.log("[Slack Webhook] Generated answer:", answer.substring(0, 100) + "...");

        // Filter and validate source links
        const validSourceLinks = sourceLinks.filter(link => 
            link && link.startsWith('https://') && !link.includes('your-site.atlassian.net')
        );

        let finalAnswer = answer;
        const answerHasSources = answer.toLowerCase().includes('source') || answer.includes('http');
        
        if (validSourceLinks.length > 0 && !answerHasSources) {
            const slackLinks = validSourceLinks.filter(l => l.includes('slack.com'));
            const jiraLinks = validSourceLinks.filter(l => l.includes('atlassian.net/browse'));
            const confluenceLinks = validSourceLinks.filter(l => l.includes('atlassian.net/wiki'));
            
            finalAnswer += "\n\n*Sources:*\n";
            if (slackLinks.length > 0) {
                finalAnswer += `Slack: ${slackLinks.map(l => `<${l}|View>`).join(', ')}\n`;
            }
            if (jiraLinks.length > 0) {
                finalAnswer += `Jira: ${jiraLinks.map(l => `<${l}|View>`).join(', ')}\n`;
            }
            if (confluenceLinks.length > 0) {
                finalAnswer += `Confluence: ${confluenceLinks.map(l => `<${l}|View>`).join(', ')}\n`;
            }
        }

        // Reply in thread
        await slackClient.postMessage(event.channel, finalAnswer, {
            threadTs: event.ts,
        });

        console.log("[Slack Webhook] Posted reply to thread");
    } catch (e) {
        console.error("[Slack Webhook] Error generating/posting response:", e);
        
        await slackClient.postMessage(event.channel, "Sorry, I encountered an error while processing your question. Please try again.", {
            threadTs: event.ts,
        });
    }
}

/**
 * Ingest a Slack message into the knowledge base and create embeddings.
 * This enables real-time learning from Slack conversations.
 */
async function ingestSlackMessage(event: any, teamId: string) {
    logger.log(`Ingesting message from channel ${event.channel}`);

    // Find the project ID for this Slack team
    const projectId = await findProjectBySlackTeamId(teamId);
    if (!projectId) {
        logger.log(`No project found for team ${teamId}, skipping ingestion`);
        return;
    }

    // Skip empty messages
    if (!event.text || event.text.trim().length === 0) {
        return;
    }

    // Skip messages authored by PidraxBot
    if (event.bot_id) {
        logger.log(`Skipping bot message (bot_id: ${event.bot_id})`);
        return;
    }
    if (event.user === 'U0ADKQNTY7P') {
        logger.log(`Skipping message from PidraxBot user ${event.user}`);
        return;
    }
    if (event.subtype === 'bot_message') {
        logger.log(`Skipping bot_message subtype`);
        return;
    }
    
    // Skip messages that mention/tag PidraxBot (questions to the bot)
    const msgText = event.text || '';
    const msgLower = msgText.toLowerCase();
    if (msgText.includes('<@U0ADKQNTY7P>') || msgLower.includes('pidraxbot') || msgLower.includes('pidrax knowledge bot')) {
        logger.log(`Skipping message that mentions PidraxBot`);
        return;
    }

    const sourceId = `${event.channel}:${event.ts}`;
    const timestamp = new Date(parseFloat(event.ts) * 1000);

    try {
        // Get channel info for context (if we have a token)
        const slackToken = await oauthTokensRepository.fetchByProjectAndProvider(projectId, 'slack');
        let channelName = event.channel;
        
        if (slackToken) {
            const slackClient = new SlackClient(slackToken.accessToken);
            try {
                const channelInfo = await slackClient.getChannelInfo(event.channel);
                channelName = channelInfo.name || event.channel;
            } catch (e) {
                // Ignore error, use channel ID
            }
        }

        // Check if document already exists
        const existing = await knowledgeDocumentsRepository.findBySourceId(projectId, 'slack', sourceId);

        const metadata = {
            channelId: event.channel,
            channelName,
            userId: event.user,
            threadTs: event.thread_ts,
            isThreadReply: !!event.thread_ts && event.thread_ts !== event.ts,
            mentions: extractMentions(event.text),
        };

        let doc;
        if (existing) {
            // Update existing document if content changed
            if (existing.content !== event.text) {
                doc = await knowledgeDocumentsRepository.update(existing.id, {
                    content: event.text,
                    metadata,
                    sourceUpdatedAt: timestamp.toISOString(),
                });
                logger.log(`Updated existing message document: ${existing.id}`);
            } else {
                logger.log(`Message unchanged, skipping: ${existing.id}`);
                return;
            }
        } else {
            // Create new document
            doc = await knowledgeDocumentsRepository.create({
                projectId,
                provider: 'slack',
                sourceType: event.thread_ts ? 'slack_thread' : 'slack_message',
                sourceId,
                title: `Message in #${channelName}`,
                content: event.text,
                metadata,
                entityRefs: [],
                syncedAt: new Date().toISOString(),
                sourceCreatedAt: timestamp.toISOString(),
            });
            logger.log(`Created new message document: ${doc.id}`);
        }

        // Ensure collection exists and embed the document
        await ensureKnowledgeCollection(logger);
        const result = await embedKnowledgeDocument(doc, logger);

        // Event-driven claim verification
        matchAndVerifyClaims(projectId, doc).catch(err => {
            logger.log(`Claim matching failed: ${err}`);
        });
        
        if (result.success) {
            logger.log(`Embedded message with ${result.chunksCreated} chunks`);
        } else {
            logger.log(`Failed to embed message: ${result.error}`);
        }
        
        // Process for topics (entity-centric knowledge)
        if (!event.text.includes('<@') || event.text.replace(/<@[A-Z0-9]+>/g, '').trim().length > 20) {
            try {
                const topics = await processMessageForTopics(
                    projectId,
                    doc.id,
                    event.text,
                    'slack',
                    {
                        author: event.user,
                        timestamp,
                        url: `https://slack.com/archives/${event.channel}/p${event.ts.replace('.', '')}`,
                        context: event.text.substring(0, 200),
                    },
                    logger
                );
                if (topics.length > 0) {
                    logger.log(`Message linked to topics: ${topics.join(', ')}`);
                }
            } catch (e) {
                logger.log(`Error processing topics: ${e}`);
            }
        }

    } catch (error) {
        logger.log(`Error ingesting message: ${error}`);
    }
}

/**
 * Delete a Slack message from the knowledge base when it's deleted in Slack.
 */
async function deleteSlackMessage(channelId: string, messageTs: string, teamId: string) {
    const projectId = await findProjectBySlackTeamId(teamId);
    if (!projectId) {
        logger.log(`No project found for team ${teamId}, skipping delete`);
        return;
    }

    const sourceId = `${channelId}:${messageTs}`;
    const existing = await knowledgeDocumentsRepository.findBySourceId(projectId, 'slack', sourceId);

    if (existing) {
        await knowledgeDocumentsRepository.delete(existing.id);
        logger.log(`Deleted message document: ${existing.id} (source: ${sourceId})`);
    } else {
        logger.log(`No document found for deleted message: ${sourceId}`);
    }
}

/**
 * Extract user mentions from message text
 */
function extractMentions(text: string): string[] {
    const mentionRegex = /<@([A-Z0-9]+)>/g;
    const mentions: string[] = [];
    let match;
    while ((match = mentionRegex.exec(text)) !== null) {
        mentions.push(match[1]);
    }
    return mentions;
}
