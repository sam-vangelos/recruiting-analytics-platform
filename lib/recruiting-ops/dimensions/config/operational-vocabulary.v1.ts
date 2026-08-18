/**
 * Operational word vocabulary, VERSIONED CONFIG (v1).
 *
 * Lower-cased single words that may appear as capitalized tokens in canonical
 * operational language (registry titles, stage names, console/catalog copy).
 * Consumed by dimensions/operational-vocabulary.ts, which combines this list
 * with exact canonical phrases from the plane's own registries to let
 * value-driven person-name detection (safe-public-output.ts) tell operational
 * labels apart from person names.
 *
 * Drift-lock: test/recruiting-ops-public-output.test.ts asserts every canonical
 * string passes strict inspection — a new canonical string whose words are not
 * covered here fails that lock and forces a reviewed addition. Grow this list
 * only through review; never weaken the detector instead.
 */

export const OPERATIONAL_VOCABULARY_CONFIG_VERSION = "v1-2026-07"

export const OPERATIONAL_WORDS_V1: readonly string[] = [
  // reporting/task language (registry titles + summaries)
  "weekly", "recruitment", "report", "reports", "reporting", "offer", "offers", "open",
  "position", "positions", "role", "roles", "specific", "pipeline", "pipelines", "progress",
  "sheet", "sheets", "graph", "tracking", "tracker", "recruiting", "update", "updates",
  "final", "all", "hires", "hire", "assignment", "pod", "pods", "daily", "monitoring",
  "dashboard", "dashboards", "duplicate", "candidate", "candidates", "check", "workflow",
  "workflows", "setup", "apps", "script", "scripts", "development", "recruiter", "recruiters",
  "lead", "leads", "validation", "coordination", "handoff", "preparation", "requisition",
  "requisitions", "clarification", "clarifications", "inbox", "response", "responses",
  "user", "users", "group", "groups", "task", "tasks", "automation", "master", "queries",
  "query", "data", "status", "transition",
  // systems and vendors
  "greenhouse", "linkedin", "google", "gmail", "looker", "power", "gem", "naukri", "skills",
  "mailgun", "docs", "drive", "harvest", "slack",
  // acronyms that title-case as capitalized tokens
  "elt", "rps", "rc", "bi", "rls", "fdl", "fde", "pe", "gh", "hod", "hods", "hm", "qtd",
  "ytd", "sql", "api", "csv", "json", "id", "ids", "ceo", "sla", "pii", "ui", "us", "ny",
  // stage vocabulary (taxonomy substages/core stages)
  "application", "review", "sourced", "reached", "out", "shortlisted", "preliminary",
  "screening", "call", "phone", "screen", "video", "no", "show", "hiring", "manager",
  "tech", "technical", "interview", "interviews", "live", "coding", "round", "assessment",
  "cultural", "add", "peer", "panel", "case", "study", "executive", "leadership", "onsite",
  "verbal", "signed", "extend", "select",
  // role/req vocabulary
  "frontier", "principal", "engineer", "engineers", "forward", "deployed", "code",
  "brazil", "colombia", "bench",
  // time vocabulary
  "january", "february", "march", "april", "may", "june", "july", "august", "september",
  "october", "november", "december", "jan", "feb", "mar", "apr", "jun", "jul", "aug",
  "sep", "sept", "oct", "nov", "dec", "monday", "tuesday", "wednesday", "thursday",
  "friday", "saturday", "sunday", "mon", "tue", "wed", "thu", "fri", "sat", "sun",
  "week", "weeks", "month", "months", "quarter", "day", "days",
  // control-plane vocabulary (console, catalogs, ledgers, gates)
  "fixture", "console", "command", "center", "legacy", "coverage", "local", "run", "runs",
  "catalog", "delivery", "ledger", "gate", "gates", "autonomy", "lane", "lanes", "shadow",
  "mode", "source", "gap", "gaps", "discrepancy", "discrepancies", "proposal", "proposals",
  "action", "actions", "queue", "queues", "owner", "job", "jobs", "scorecard", "scorecards",
  "accountability", "ownership", "capacity", "req", "reqs", "movement", "stalled", "missing",
  "match", "mismatch", "redacted", "unknown", "total", "count", "counts", "summary",
  "draft", "drafts", "custody", "packet", "registry", "registries", "contract", "contracts",
  "artifact", "artifacts", "snapshot", "snapshots", "admin", "ops", "control", "plane",
  "readiness", "health", "monitor", "external", "internal", "vendor", "matrix", "access",
  "approve", "approved", "pending", "blocked", "active", "dormant", "stop", "not",
  "applicable", "none", "new", "per", "team", "and", "for", "the", "of", "on", "with", "by",
  // column labels + registry nouns (drift-lock coverage)
  "acceptance", "agent", "alert", "approval", "area", "asset", "ats", "attestation",
  "billable", "blocker", "blocking", "captured", "category", "comments", "confidence",
  "core", "create", "dedupe", "defer", "dry", "entity", "event", "evidence", "exception",
  "export", "follow", "four", "human", "interviewer", "item", "last", "manual", "metric",
  "modify", "narrative", "next", "observed", "openings", "payload", "payment", "primary",
  "priority", "project", "reason", "recommendation", "refresh", "resume", "risk",
  "rotation", "row", "runner", "scope", "section", "sourcer", "stage", "submitter", "ta",
  "target", "template", "triage", "trigger", "up", "view", "workload", "workspace",
  // E01 exec state-of-play (workflow title + snapshot column labels)
  "added", "advances", "beyond", "department", "exec", "furthest", "momentum", "play",
  "state", "tier",
]
