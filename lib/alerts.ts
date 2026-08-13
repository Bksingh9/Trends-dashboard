/**
 * §8.5 — Slack digest and immediate connector-failure alerts.
 *
 * Keep the message short; link to the module rather than dumping tables.
 * Without a bot token this logs instead of posting, so nothing blocks.
 */
import { config } from '@/lib/config';
import type { AssertionVerdict } from '@/lib/connectors/types';

export interface SlackPostResult {
  posted: boolean;
  reason?: string;
}

async function postToSlack(channel: string, text: string): Promise<SlackPostResult> {
  if (!config.slackBotToken) return { posted: false, reason: 'SLACK_BOT_TOKEN not set' };
  if (!channel) return { posted: false, reason: 'channel not configured' };
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.slackBotToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel, text, unfurl_links: false }),
    });
    const body = (await res.json()) as { ok: boolean; error?: string };
    return body.ok ? { posted: true } : { posted: false, reason: body.error };
  } catch (e) {
    return { posted: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export async function alertConnectorDown(
  connectorId: string,
  displayName: string,
  verdicts: AssertionVerdict[],
): Promise<SlackPostResult> {
  const failures = verdicts.filter((v) => v.level === 'fail');
  const text = [
    `:red_circle: *${displayName}* (\`${connectorId}\`) failed its assertion gate — mart not updated, serving last good snapshot.`,
    ...failures.map((f) => `• ${f.id}: ${f.message}`),
    `<${config.nextAuthUrl || ''}/connectors|Open /connectors>`,
  ].join('\n');

  const result = await postToSlack(config.slackAlertsChannel, text);
  if (!result.posted) {
    console.error(`[alert] ${connectorId} down (Slack not posted: ${result.reason})`, failures);
  }
  return result;
}

export async function postDailyDigest(brief: string, actItems: string[]): Promise<SlackPostResult> {
  const text = [
    `*Companion daily brief*`,
    brief,
    ...(actItems.length ? ['', '*Needs action today*', ...actItems.map((a) => `• ${a}`)] : []),
    `<${config.nextAuthUrl || ''}/|Open the hub>`,
  ].join('\n');
  const result = await postToSlack(config.slackDigestChannel || config.slackAlertsChannel, text);
  if (!result.posted) console.warn(`[digest] not posted: ${result.reason}`);
  return result;
}
