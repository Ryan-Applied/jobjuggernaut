export function resolveRunnerId(
  requestedRunnerId?: string,
  workflowRunnerId?: string,
  defaultRunnerId = process.env.DEFAULT_RUNNER_ID,
): string {
  return requestedRunnerId ?? workflowRunnerId ?? defaultRunnerId ?? "laptop";
}
