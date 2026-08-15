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
  /** How it went out. `webhook` cannot honour a channel — see below. */
  via?: 'chat.postMessage' | 'webhook';
}

/**
 * The webhook fallback, for while `chat:write` is pending.
 *
 * An incoming webhook posts to the single channel chosen when it was created.
 * It **cannot route**, so an alert addressed to the NOC channel will land
 * wherever the webhook points. That is a real hazard — an escalation nobody saw
 * because it went somewhere else is worse than one that failed loudly — so the
 * message carries the channel it was meant for, in its own text.
 */
async function postViaWebhook(intendedChannel: string, text: string): Promise<SlackPostResult> {
  if (!config.slackWebhookUrl) return { posted: false, reason: 'SLACK_WEBHOOK_URL not set' };
  try {
    const res = await fetch(config.slackWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `${text}\n_(sent via incoming webhook — addressed to ${intendedChannel}, delivered to this webhook's own channel. chat:write is pending.)_`,
      }),
    });
    // A webhook answers `ok` as plain text, not JSON.
    const body = (await res.text()).trim();
    return res.ok && body === 'ok'
      ? { posted: true, via: 'webhook' }
      : { posted: false, reason: `webhook returned ${res.status} ${body.slice(0, 80)}` };
  } catch (e) {
    return { posted: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** Errors that mean the token cannot post, as opposed to the post being wrong. */
const CANNOT_POST = /missing_scope|not_in_channel|invalid_auth|token_revoked|not_authed|account_inactive/;

async function postToSlack(channel: string, text: string): Promise<SlackPostResult> {
  if (!channel) return { posted: false, reason: 'channel not configured' };

  if (!config.slackBotToken) {
    // No token at all is exactly the case the webhook exists for.
    const viaHook = await postViaWebhook(channel, text);
    return viaHook.posted ? viaHook : { posted: false, reason: 'SLACK_BOT_TOKEN not set; ' + viaHook.reason };
  }

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
    if (body.ok) return { posted: true, via: 'chat.postMessage' };

    // A scope failure is worth falling back on; a bad channel id is not —
    // retrying that through a webhook would deliver it somewhere else and call
    // it a success.
    if (body.error && CANNOT_POST.test(body.error) && config.slackWebhookUrl) {
      const viaHook = await postViaWebhook(channel, text);
      if (viaHook.posted) return viaHook;
      return { posted: false, reason: `${body.error}; webhook also failed: ${viaHook.reason}` };
    }
    return { posted: false, reason: body.error };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    if (config.slackWebhookUrl) {
      const viaHook = await postViaWebhook(channel, text);
      if (viaHook.posted) return viaHook;
    }
    return { posted: false, reason: why };
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
