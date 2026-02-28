/**
 * Parses real Slack API responses into structured documents.
 * One document per channel.
 */

import type { KB2ParsedDocument } from "./confluence-parser";

interface SlackMessage {
  ts?: string;
  text?: string;
  user_profile?: { name?: string };
  subtype?: string | null;
}

interface SlackChannel {
  id?: string;
  name: string;
}

interface SlackChannelMessages {
  channel: SlackChannel;
  messages: SlackMessage[];
}

interface SlackUserMap {
  [username: string]: { id?: string; name?: string; real_name?: string };
}

function tsToDate(ts: string | undefined): string {
  if (!ts) return "";
  try {
    const epoch = parseFloat(ts) * 1000;
    return new Date(epoch).toISOString().replace("T", " ").slice(0, 16);
  } catch {
    return "";
  }
}

function resolveUserMentions(text: string, userMap: SlackUserMap): string {
  return text.replace(/<@([^>]+)>/g, (_, userId) => {
    const entry = Object.values(userMap).find((u) => u.id === userId);
    return entry ? `@${entry.real_name ?? entry.name ?? userId}` : `@${userId}`;
  });
}

export function parseSlackApiResponse(json: unknown): KB2ParsedDocument[] {
  if (!json || typeof json !== "object") return [];

  const data = json as Record<string, unknown>;
  const channelMessages = (data.messages_by_channel ?? []) as SlackChannelMessages[];
  const userMap = (data.user_map ?? {}) as SlackUserMap;

  if (channelMessages.length === 0) return [];

  return channelMessages
    .filter((ch) => ch.channel?.name && ch.messages?.length > 0)
    .map((ch) => {
      const channelName = ch.channel.name;
      const lines: string[] = [];

      lines.push(`# #${channelName}`);
      lines.push("");

      for (const msg of ch.messages) {
        const who = msg.user_profile?.name ?? "unknown";
        const realName = userMap[who]?.real_name ?? who;
        const when = tsToDate(msg.ts);
        const text = resolveUserMentions(msg.text ?? "", userMap);
        lines.push(`[${when}] **${realName}**: ${text}`);
      }

      const participants = new Set(
        ch.messages
          .map((m) => m.user_profile?.name)
          .filter(Boolean) as string[],
      );

      return {
        id: `slack-${ch.channel.id ?? channelName}`,
        provider: "slack",
        sourceType: "slack_channel",
        sourceId: ch.channel.id ?? channelName,
        title: `#${channelName}`,
        content: lines.join("\n").trim(),
        metadata: {
          channelId: ch.channel.id,
          channelName,
          messageCount: ch.messages.length,
          participants: [...participants].map((p) => userMap[p]?.real_name ?? p),
        },
      };
    });
}
