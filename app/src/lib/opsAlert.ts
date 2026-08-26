// /app/src/lib/opsAlert.ts
//
// One place to raise an operational alert when something the owner needs to
// know about goes wrong unattended (a cron failed, a Stripe payment couldn't be
// posted to the ledger). It ALWAYS logs via `logger` so the signal is in the
// container logs; if an out-of-band channel is configured it also pushes there.
//
// Channels are env-gated so a pilot can run with neither set (logs only) and a
// production deployment opts in by setting OPS_ALERT_WEBHOOK (Slack/Discord/any
// JSON endpoint) and/or OPS_ALERT_EMAIL (drained by the email queue cron). With
// neither set this is a no-op beyond the log line, never a crash.

import { logger } from "@/lib/logger";

export interface OpsAlert {
  title: string;
  detail: string;
  context?: Record<string, unknown>;
}

export interface OpsAlertChannels {
  webhook?: string;
  email?: string;
}

// Pure: which channels are configured. Trimmed so an empty-string env var
// (common in shells) counts as unset.
export function resolveOpsAlertChannels(env: NodeJS.ProcessEnv): OpsAlertChannels {
  const webhook = env.OPS_ALERT_WEBHOOK?.trim();
  const email = env.OPS_ALERT_EMAIL?.trim();
  return {
    ...(webhook ? { webhook } : {}),
    ...(email ? { email } : {}),
  };
}

// Pure: the JSON body posted to a webhook. `text` is the Slack/Discord-friendly
// flat field; the structured fields ride alongside for richer consumers.
export function buildWebhookPayload(alert: OpsAlert): Record<string, unknown> {
  const lines = [`[Holt ops] ${alert.title}`, alert.detail];
  return {
    text: lines.join("\n"),
    title: alert.title,
    detail: alert.detail,
    ...(alert.context ? { context: alert.context } : {}),
  };
}

// Pure: the email an OPS_ALERT_EMAIL recipient receives. Plain, no template
// dependency — this path exists for deployments without a chat webhook.
export function buildAlertEmail(alert: OpsAlert): { subject: string; html: string } {
  const safe = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const ctx = alert.context ? `<pre>${safe(JSON.stringify(alert.context, null, 2))}</pre>` : "";
  return {
    subject: `[Holt ops] ${alert.title}`,
    html: `<p>${safe(alert.detail)}</p>${ctx}`,
  };
}

// Fire an operational alert. Always logs. Then best-effort pushes to whatever
// channels are configured — a channel failure is logged and swallowed so the
// alert path can never become the thing that takes down the caller.
//
// NOTHING IN HERE MAY CALL logError().
//
// logError() records an ErrorEvent, and recordError() calls back into this
// function the first time it sees a fingerprint. Logging the alert through
// logError therefore produced a new message ("ops-alert: " + the previous
// title), which is a new fingerprint, which is a first sighting, which alerts
// again -- prepending "ops-alert: New error: " once per pass, forever.
//
// One unconfigured integration was enough to set it going: a missing API key
// logged once, and the loop turned that into 1,154 ErrorEvent rows and a server
// too busy to answer a login. Every one of those rows was the loop's own
// output, so the error log -- the thing you reach for when something is wrong --
// was the least usable artifact in the system.
//
// `logger.error` writes to stdout and stops there. Use it, and only it.
export async function reportOpsAlert(alert: OpsAlert): Promise<void> {
  logger.error(`ops-alert: ${alert.title}`, {
    ...alert.context,
    detail: alert.detail,
  });

  const channels = resolveOpsAlertChannels(process.env);

  if (channels.webhook) {
    try {
      await fetch(channels.webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildWebhookPayload(alert)),
      });
    } catch (err) {
      // logger, not logError -- see the header. A webhook failure inside the
      // alert path must not create another alert.
      logger.error("ops-alert webhook delivery failed", {
        title: alert.title,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (channels.email) {
    try {
      // Imported lazily so this server-only module isn't pulled into any
      // client bundle that references the pure helpers above.
      const { enqueueEmail } = await import("@/lib/email/queue");
      const { subject, html } = buildAlertEmail(alert);
      await enqueueEmail({ to: channels.email, subject, html, templateKey: "ops-alert" });
    } catch (err) {
      logger.error("ops-alert email enqueue failed", {
        title: alert.title,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
