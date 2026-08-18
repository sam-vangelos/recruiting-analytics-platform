import { readEnv } from "@/lib/env"
import {
  noStoreJson,
  noStoreServerErrorJson,
  requireCronSecret,
} from "../../ytd/route-utils"

export const runtime = "nodejs"

// P3 hard prerequisite (CRON_SECRET-gated, read-only). users.lookupByEmail — the recruiter_id ->
// slack_id chain — requires the users:read.email scope. auth.test's BODY does not list granted
// scopes; Slack returns them in the x-oauth-scopes response HEADER on any authenticated call.
// The local SLACK_BOT_TOKEN is invalid (auth.test => invalid_auth), so this is only answerable
// from a deployment with the working prod token. If users:read.email is absent, recruiter routing
// (P3/P4) is inert until a workspace-admin reinstall adds the scope.
export async function GET(request: Request) {
  const unauthorized = requireCronSecret(request)
  if (unauthorized) return unauthorized

  const token = readEnv("SLACK_BOT_TOKEN")
  if (!token) return noStoreJson({ error: "SLACK_BOT_TOKEN not set" }, { status: 500 })

  let res: Response
  try {
    res = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
    })
  } catch (err) {
    return noStoreServerErrorJson("api/admin/slack-scope-check", err, 502)
  }

  const scopesHeader = res.headers.get("x-oauth-scopes")
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean
    team?: string
    url?: string
    user?: string
    bot_id?: string
    error?: string
  }
  const scopes = scopesHeader
    ? scopesHeader.split(",").map((s) => s.trim()).filter(Boolean)
    : []
  const required = ["users:read.email", "users:read"]

  // Identify the app so the operator can find it in api.slack.com/apps: bots.info(bot_id) returns
  // the app_id, which yields a direct manage link. Best-effort — a failure just omits app_id.
  let appId: string | null = null
  let botName: string | null = body.user ?? null
  if (body.ok && body.bot_id) {
    try {
      const bi = await fetch(`https://slack.com/api/bots.info?bot=${encodeURIComponent(body.bot_id)}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const biBody = (await bi.json().catch(() => ({}))) as {
        ok?: boolean
        bot?: { app_id?: string; name?: string }
      }
      if (biBody.ok && biBody.bot) {
        appId = biBody.bot.app_id ?? null
        botName = biBody.bot.name ?? botName
      }
    } catch {
      // ignore — app identification is a convenience, not the point of this endpoint
    }
  }

  return noStoreJson({
    auth_ok: body.ok === true,
    auth_error: body.ok === true ? null : body.error ?? "unknown",
    team: body.team ?? null,
    workspace_url: body.url ?? null,
    bot_name: botName,
    app_id: appId,
    manage_url: appId ? `https://api.slack.com/apps/${appId}/oauth` : null,
    scopes,
    has_users_read_email: scopes.includes("users:read.email"),
    missing_required: required.filter((s) => !scopes.includes(s)),
    recruiter_routing_viable:
      body.ok === true && scopes.includes("users:read.email"),
  })
}
