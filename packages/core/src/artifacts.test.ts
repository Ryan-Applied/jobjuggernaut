import { describe, expect, it } from "vitest";
import { artifactsFor } from "./index.js";

describe("artifactsFor", () => {
  it("reports written files with a workdir-qualified URI", () => {
    expect(artifactsFor("Write", { path: "src/app.ts" }, "saved", "/repo")).toEqual([
      { kind: "file", uri: "/repo/src/app.ts", title: "app.ts" },
    ]);
  });

  it("extracts pull and merge request links from shell output without duplicates", () => {
    const result = "Created https://github.com/acme/app/pull/12 and https://gitlab.com/acme/app/merge_requests/7";

    expect(artifactsFor("Bash", {}, result)).toEqual([
      { kind: "pr", uri: "https://github.com/acme/app/pull/12", title: "PR 12" },
      { kind: "pr", uri: "https://gitlab.com/acme/app/merge_requests/7", title: "PR 7" },
    ]);
  });

  it("maps messaging and page tools to the right artifact kinds", () => {
    expect(artifactsFor("slack.post", { channel: "#builds" }, "")).toEqual([
      { kind: "message", uri: "#builds", title: "Slack: #builds" },
    ]);
    expect(artifactsFor("notion.createPages", { title: "Plan" }, "https://notion.so/plan/123")).toEqual([
      { kind: "page", uri: "https://notion.so/plan/123", title: "Plan" },
    ]);
  });
});
