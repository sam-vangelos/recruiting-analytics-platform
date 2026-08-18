import { readEnv } from "./env"

// P3 — resolve a Greenhouse user's email to a Slack user id via users.lookupByEmail. fetch to the
// Slack Web API with SLACK_BOT_TOKEN (consistent with postSlackDm; no SDK dep).
//
// REQUIRES the users:read.email bot scope. Deep-research confirmed a granular bot token (xoxb-)
// CAN hold it — no user-token flow — but it must be added to the app's scopes + the app
// reinstalled. Until then every call returns scope_blocked and the caller stops (no retry storm).

const SLACK_API = "https://slack.com/api"

export type SlackLookupResult =
  | { status: "resolved"; slack_user_id: string }
  | { status: "slack_not_found" }
  | { status: "scope_blocked" }
  | { status: "error"; message: string }

/** Look up a Slack user id by email. Never throws — every Slack outcome maps to a status so the
 *  directory records an honest verdict and the refresh loop can decide whether to stop. */
export async function lookupSlackUserByEmail(email: string): Promise<SlackLookupResult> {
  const token = readEnv("SLACK_BOT_TOKEN")
  if (!token) return { status: "error", message: "SLACK_BOT_TOKEN must be set" }

  let res: Response
  try {
    res = await fetch(`${SLACK_API}/users.lookupByEmail?email=${encodeURIComponent(email)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    })
  } catch (err) {
    return { status: "error", message: `Slack fetch failed: ${err instanceof Error ? err.message : String(err)}` }
  }

  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean
    error?: string
    user?: { id?: string }
  }
  if (data.ok && data.user?.id) return { status: "resolved", slack_user_id: data.user.id }
  if (data.error === "users_not_found") return { status: "slack_not_found" }
  if (data.error === "missing_scope") return { status: "scope_blocked" }
  return { status: "error", message: `Slack users.lookupByEmail error: ${data.error ?? "unknown"}` }
}
