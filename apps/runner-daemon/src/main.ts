import { Worker, NativeConnection } from "@temporalio/worker";
import { Context, ApplicationFailure } from "@temporalio/activity";
import type { LocalActivities } from "@jj/workflows";
import { localQueue } from "@jj/workflows";
import { SessionManager } from "./sessions.js";
import { WorktreeManager } from "./worktrees.js";
import { ApiClient } from "./api.js";

const runnerId = process.env.RUNNER_ID ?? "laptop";
const manager = new SessionManager(new ApiClient(), new WorktreeManager(), runnerId);

const activities: LocalActivities = {
  describeRunner: () => manager.describe(),
  startSession: async (spec) => { const h = await manager.start(spec); return { vendorSessionRef: h.vendorSessionRef }; },
  pumpEvents: ({ sessionId, fromSeq }) => manager.pump(sessionId, fromSeq, (seq) => Context.current().heartbeat(seq), Context.current().cancellationSignal).catch((e) => {
    if (e?.code === "SESSION_NOT_LIVE") throw ApplicationFailure.nonRetryable(e.message, "SESSION_NOT_LIVE");
    throw e;
  }),
  resumeSession: ({ sessionId, callId, approved, grantIds }) => manager.resume(sessionId, callId, approved, grantIds),
  inspectWorkdir: ({ workdir }) => manager.inspect(workdir),
  cancelSession: ({ sessionId, reason }) => manager.cancel(sessionId, reason),
};

const connection = await NativeConnection.connect({ address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233" });
const worker = await Worker.create({
  connection,
  namespace: process.env.TEMPORAL_NAMESPACE ?? "default",
  taskQueue: localQueue(runnerId),
  activities,
  // Workflow code runs on the cloud worker; this host only runs activities.
});
console.log(`[runner-daemon] ${runnerId} on ${localQueue(runnerId)}; credentials never leave this host`);
await worker.run();
