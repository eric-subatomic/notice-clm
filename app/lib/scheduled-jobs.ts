import { isValidCronSchedule } from "./cron";

export type ScheduledJobBindings = Readonly<{
  NOTICE_JOB_RUNNER_SECRET?: unknown;
  NOTICE_OUTBOX_CRON?: unknown;
  NOTICE_RETENTION_CRON?: unknown;
}>;

export type ApplicationFetcher = Readonly<{
  fetch(request: Request, env: unknown, context: ExecutionContext): Promise<Response>;
}>;

export class ScheduledJobConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduledJobConfigurationError";
  }
}

export function scheduledJobRequest(bindings: ScheduledJobBindings, cron: string): Request {
  const secret = stringBinding(bindings.NOTICE_JOB_RUNNER_SECRET);
  if (!secret || secret.length < 32) {
    throw new ScheduledJobConfigurationError("NOTICE_JOB_RUNNER_SECRET must contain at least 32 characters.");
  }
  const outboxCron = stringBinding(bindings.NOTICE_OUTBOX_CRON);
  const retentionCron = stringBinding(bindings.NOTICE_RETENTION_CRON);
  if (!outboxCron || !retentionCron || !isValidCronSchedule(outboxCron) || !isValidCronSchedule(retentionCron) || outboxCron === retentionCron) {
    throw new ScheduledJobConfigurationError("Distinct valid NOTICE_OUTBOX_CRON and NOTICE_RETENTION_CRON values are required.");
  }
  const pathname = cron === outboxCron
    ? "/api/jobs/outbox"
    : cron === retentionCron
      ? "/api/jobs/retention"
      : null;
  if (!pathname) throw new ScheduledJobConfigurationError("The received Cron Trigger does not match a configured Notice job.");
  return new Request(`https://notice-scheduled.internal${pathname}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "user-agent": "notice-native-scheduler/1.0",
    },
  });
}

/**
 * The frequent delivery trigger first materializes obligation occurrences and
 * queues due reminders, then drains the outbox. Retention remains isolated on
 * its own trigger.
 */
export function scheduledJobRequests(bindings: ScheduledJobBindings, cron: string): readonly Request[] {
  const primary = scheduledJobRequest(bindings, cron);
  if (new URL(primary.url).pathname !== "/api/jobs/outbox") return [primary];
  return [
    new Request("https://notice-scheduled.internal/api/jobs/obligations", {
      method: "POST",
      headers: primary.headers,
    }),
    primary,
  ];
}

export async function dispatchScheduledJob(
  application: ApplicationFetcher,
  bindings: ScheduledJobBindings,
  context: ExecutionContext,
  cron: string,
): Promise<void> {
  const failures: string[] = [];
  for (const request of scheduledJobRequests(bindings, cron)) {
    const pathname = new URL(request.url).pathname;
    try {
      const response = await application.fetch(request, bindings, context);
      try {
        await response.body?.cancel();
      } catch {
        // Bodies can contain request identifiers and are deliberately not
        // logged; cancellation failure does not hide the HTTP outcome.
      }
      if (!response.ok) failures.push(`${pathname}: HTTP ${response.status}`);
    } catch (error) {
      failures.push(`${pathname}: ${error instanceof Error ? error.message : "request failed"}`);
    }
  }
  if (failures.length > 0) throw new Error(`Notice scheduled jobs failed (${failures.join("; ")}).`);
}

function stringBinding(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
