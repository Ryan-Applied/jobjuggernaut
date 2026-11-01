/** Cloud worker: runs workflow code + cloud activities on the "cloud" queue. */
import { Worker, NativeConnection } from "@temporalio/worker";
import { CLOUD_QUEUE } from "./shared.js";
import { createCloudActivities } from "./activities.cloud.js";
import { fileURLToPath } from "node:url";

const connection = await NativeConnection.connect({ address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233" });
const worker = await Worker.create({
  connection,
  namespace: process.env.TEMPORAL_NAMESPACE ?? "default",
  taskQueue: CLOUD_QUEUE,
  workflowsPath: fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./workflows.ts" : "./workflows.js", import.meta.url)),
  activities: createCloudActivities(),
});
console.log(`[cloud worker] listening on ${CLOUD_QUEUE}`);
await worker.run();
