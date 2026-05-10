import { IncomingWebhook } from "@slack/webhook";
import type { Block, KnownBlock } from "@slack/types";

const WEBHOOK = process.env.SLACK_WEBHOOK_URL ?? "";
const CHANNEL = process.env.SLACK_CHANNEL;

function buildBlocks(message: string, action?: string, actionUrl?: string): (KnownBlock | Block)[] {
  const blocks: (KnownBlock | Block)[] = [
    { type: "section", text: { type: "mrkdwn", text: message } },
  ];
  if (action && actionUrl) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", emoji: true, text: action },
          style: "primary",
          url: actionUrl,
        },
      ],
    });
  }
  return blocks;
}

export async function sendSlackNotification(
  message: string,
  opts: { action?: string; actionUrl?: string } = {},
): Promise<void> {
  if (!WEBHOOK) return;
  try {
    const webhook = new IncomingWebhook(WEBHOOK);
    const blocks = buildBlocks(message, opts.action, opts.actionUrl);
    await webhook.send({
      blocks,
      ...(CHANNEL ? { channel: CHANNEL } : {}),
    });
  } catch (err) {
    console.error("[slack] notification failed:", (err as Error).message);
  }
}
