import type { PolicyCheck } from "@jj/core";

/**
 * Standing forbid rules. No grant can override these.
 * Mirrors the Cedar policy set in docs; kept in TS so the local cache
 * evaluates them with zero dependencies. The Cedar file is the source of
 * truth once cedar-wasm is wired (Phase 3).
 */
export interface ForbidRule {
  id: string;
  reason: string;
  matches: (c: PolicyCheck) => boolean;
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

export const FORBID_RULES: ForbidRule[] = [
  {
    id: "no-external-email",
    reason: "Outbound email to external recipients is never pre-authorised",
    matches: (c) => c.tool === "gmail.send" && c.resource.external === true,
  },
  {
    id: "no-slack-connect-post",
    reason: "Posting to Slack Connect (external) channels is never pre-authorised",
    matches: (c) => c.tool === "slack.post" && c.resource.slackConnect === true,
  },
  {
    id: "no-close-transition",
    reason: "Transitioning a Jira issue to Closed always needs a human",
    matches: (c) => c.tool === "jira.transition" && str(c.args.toStatus) === "Closed",
  },
  {
    id: "reviewer-vendor-differs",
    reason: "A reviewer must not share the author's vendor",
    matches: (c) =>
      c.tool === "review.approve" &&
      str(c.resource.reviewerVendor) !== undefined &&
      c.resource.reviewerVendor === c.resource.authorVendor,
  },
];

export function findForbid(c: PolicyCheck): ForbidRule | undefined {
  return FORBID_RULES.find((r) => r.matches(c));
}
