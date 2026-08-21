import assert from "node:assert/strict";
import test from "node:test";
import {
  dispatchScheduledJob,
  scheduledJobRequest,
  scheduledJobRequests,
  ScheduledJobConfigurationError,
} from "../app/lib/scheduled-jobs";

const bindings = {
  NOTICE_JOB_RUNNER_SECRET: "scheduled-job-secret-at-least-32-characters",
  NOTICE_OUTBOX_CRON: "*/5 * * * *",
  NOTICE_RETENTION_CRON: "15 2 * * *",
};

test("native Cron Triggers map only to their authenticated internal job route", () => {
  const outbox = scheduledJobRequest(bindings, bindings.NOTICE_OUTBOX_CRON);
  assert.equal(outbox.method, "POST");
  assert.equal(outbox.url, "https://notice-scheduled.internal/api/jobs/outbox");
  assert.equal(outbox.headers.get("authorization"), `Bearer ${bindings.NOTICE_JOB_RUNNER_SECRET}`);
  assert.deepEqual(
    scheduledJobRequests(bindings, bindings.NOTICE_OUTBOX_CRON).map((request) => new URL(request.url).pathname),
    ["/api/jobs/obligations", "/api/jobs/outbox"],
  );

  const retention = scheduledJobRequest(bindings, bindings.NOTICE_RETENTION_CRON);
  assert.equal(retention.url, "https://notice-scheduled.internal/api/jobs/retention");
  assert.throws(
    () => scheduledJobRequest(bindings, "0 0 * * *"),
    (error) => error instanceof ScheduledJobConfigurationError && /does not match/.test(error.message),
  );
});

test("scheduler configuration fails closed on weak secrets and ambiguous schedules", () => {
  assert.throws(
    () => scheduledJobRequest({ ...bindings, NOTICE_JOB_RUNNER_SECRET: "weak" }, bindings.NOTICE_OUTBOX_CRON),
    /at least 32 characters/,
  );
  assert.throws(
    () => scheduledJobRequest({ ...bindings, NOTICE_RETENTION_CRON: bindings.NOTICE_OUTBOX_CRON }, bindings.NOTICE_OUTBOX_CRON),
    /Distinct/,
  );
  for (const invalidCron of ["99 99 99 99 99", "*/0 * * * *", "0 0 * * 0"]) {
    assert.throws(
      () => scheduledJobRequest({ ...bindings, NOTICE_OUTBOX_CRON: invalidCron }, invalidCron),
      /Distinct valid/,
      invalidCron,
    );
  }
});

test("native scheduling delegates internally and treats non-2xx results as failures", async () => {
  const requests: Request[] = [];
  const context = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  const successfulApplication = {
    async fetch(request: Request) {
      requests.push(request);
      return new Response(null, { status: 200 });
    },
  };
  await dispatchScheduledJob(successfulApplication, bindings, context, bindings.NOTICE_OUTBOX_CRON);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((request) => new URL(request.url).pathname), ["/api/jobs/obligations", "/api/jobs/outbox"]);

  await assert.rejects(
    dispatchScheduledJob({ async fetch() { return new Response(null, { status: 503 }); } }, bindings, context, bindings.NOTICE_RETENTION_CRON),
    /HTTP 503/,
  );
});

test("a failed obligation run does not starve the outbox drain on the shared trigger", async () => {
  const paths: string[] = [];
  const context = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  await assert.rejects(
    dispatchScheduledJob({
      async fetch(request: Request) {
        const path = new URL(request.url).pathname;
        paths.push(path);
        return new Response(null, { status: path === "/api/jobs/obligations" ? 503 : 200 });
      },
    }, bindings, context, bindings.NOTICE_OUTBOX_CRON),
    /\/api\/jobs\/obligations: HTTP 503/,
  );
  assert.deepEqual(paths, ["/api/jobs/obligations", "/api/jobs/outbox"]);
});
