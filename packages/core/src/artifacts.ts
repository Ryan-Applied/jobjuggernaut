/** B2: derive artifact events from a tool call and its result. Shared by every adapter. */
export interface ArtifactHit { kind: "file" | "pr" | "page" | "doc" | "message" | "other"; uri: string; title: string }

export function artifactsFor(tool: string, args: Record<string, unknown>, resultText: string, workdir?: string): ArtifactHit[] {
  const out: ArtifactHit[] = [];
  const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : undefined;
  if ((/^(Write|Edit|MultiEdit)$/.test(tool)) && path) out.push({ kind: "file", uri: path, title: path.split("/").pop() ?? path });
  if (tool === "Bash" || tool === "git.push" || tool === "github.pr") {
    for (const m of resultText.matchAll(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g)) out.push({ kind: "pr", uri: m[0], title: `PR ${m[0].split("/").pop()}` });
    for (const m of resultText.matchAll(/https?:\/\/[\w.-]+\/[\w./-]*(?:pull|merge_requests)\/\d+/g)) if (!out.some((a) => a.uri === m[0])) out.push({ kind: "pr", uri: m[0], title: `PR ${m[0].split("/").pop()}` });
  }
  if (tool === "notion.createPages" || tool === "confluence.createPage") for (const m of resultText.matchAll(/https?:\/\/[^\s"']+/g)) out.push({ kind: "page", uri: m[0], title: String(args.title ?? "page") });
  if (tool === "slack.post") out.push({ kind: "message", uri: String(args.channel ?? "slack"), title: `Slack: ${String(args.channel ?? "")}` });
  if (tool === "gmail.send") out.push({ kind: "message", uri: `mailto:${String(args.to ?? "")}`, title: `Email: ${String(args.subject ?? "")}` });
  return out.map((a) => ({ ...a, uri: workdir && a.kind === "file" && !a.uri.startsWith("/") ? `${workdir}/${a.uri}` : a.uri }));
}
