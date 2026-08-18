import { supabase } from "./supabase"
import { greenhouseGetAll } from "./greenhouse-client"
import {
  listCandidatesByIds,
  listJobOwners,
  listJobsByIds,
  listReferrers,
  listUsers,
} from "./greenhouse-evidence"
import { resolveOwnership } from "./identity-resolver"
import type { OwnerRow } from "./identity-resolver"
import { SWEEP_CONFIG } from "./sweep-config"
import {
  gateSweepRow,
  isSweepOwnershipWritebackEnabled,
  SWEEP_ITEMS_005_COLUMNS,
} from "./sweep-writeback"
import type {
  ResolutionConfidence,
  ResolutionStatus,
} from "./resolution-types"
import type { YtdGHReferrer, YtdGHUser } from "./ytd-types"
import {
  ghStageName,
  ghStageEnteredAt,
  urgencyTier,
  type GHApplication,
  type GHJob,
  type GHCandidate,
  type ReferralSweepItem,
  type SweepRunSummary,
} from "./sweep-types"

// Resolve a referral's referrer name. `app.referrer_id` is a GH `/referrers.id` — NOT a user id
// (a live `/v3/users/{referrer_id}` 404s), and Harvest v3 dropped `credited_to` entirely. The old
// implementation read `credited_to` and then fell back to a `/users` lookup, so BOTH branches
// missed and referrer_name was null on 12,002 of 12,002 sweep_items rows. The `/referrers` join is
// the only source that names a referrer. Mirrors ytd-normalize.referrerName (ytd-normalize.ts:199).
// `credited_to` is retained as a fallback for parity with GH configs that populate it; this org
// does not. Returns null when the referrer can't be named — never a sentinel.
function deriveReferrerName(
  app: GHApplication,
  referrersById: Map<number, YtdGHReferrer>
): string | null {
  const referrerId = app.referrer_id ?? app.credited_to?.id ?? null
  if (referrerId != null) {
    const name = referrersById.get(referrerId)?.name?.trim()
    if (name) return name
  }
  if (app.credited_to) {
    const name = `${app.credited_to.first_name ?? ""} ${app.credited_to.last_name ?? ""}`.trim()
    if (name) return name
  }
  return null
}

// A referral sweep item carrying the W2 identity writeback (005 columns). Assignable
// to ReferralSweepItem, so the returned `items` keep the public result shape while the
// four extra fields ride along to the sweep_items insert. Mirrors ytd-normalize's
// YtdApplicationFactWithOwnership intersection (ytd-normalize.ts:54-61): the canonical
// ReferralSweepItem lives in sweep-types.ts (outside this file's edit boundary), so the
// resolution-derived fields are carried locally rather than widening that shared type.
//
// Canon (resolution-types.ts:9-11, frozen-spec:280): unresolved ownership is a defect
// carried as { status + null identity }, NEVER the literal "Unknown"/"UNASSIGNED".
// recruiter_id/recruiter_name are NULL whenever ownership_resolution_status !== 'resolved'.
type ReferralSweepItemWithIdentity = ReferralSweepItem & {
  /** credited_to.id off the application — the referrer's Greenhouse user id (005 column). */
  referrer_id: number | null
  /** primary_recruiter_id from the ownership resolution; NULL on any non-resolved status. */
  recruiter_id: number | null
  ownership_confidence: ResolutionConfidence
  ownership_resolution_status: ResolutionStatus
}

interface ReferralSweepResult {
  run: SweepRunSummary
  items: ReferralSweepItem[]
  newAlerts: number
  slaViolations: number
}

export async function runReferralSweep(opts: {
  lookbackHours?: number
  dryRun?: boolean
}): Promise<ReferralSweepResult> {
  const lookbackHours =
    opts.lookbackHours ?? SWEEP_CONFIG.referral.lookbackHours
  const lookbackDate = new Date(
    Date.now() - lookbackHours * 60 * 60 * 1000
  )

  // Create sweep run record
  const { data: runRow, error: runError } = await supabase
    .from("sweep_runs")
    .insert({
      sweep_type: "referral",
      started_at: new Date().toISOString(),
      status: "running",
      lookback_hours: lookbackHours,
    })
    .select("id, started_at")
    .single()

  if (runError || !runRow) {
    throw new Error(`Failed to create sweep run: ${runError?.message}`)
  }

  const runId: string = runRow.id

  try {
    // Step 1: Fetch the alertable universe in two slices.
    //
    // (a) RECENT WINDOW — referrals CREATED in the last N hours, any stage, any job state.
    //     Kept so a fresh referral is observed through its whole first-touch lifecycle
    //     (actioned items still land in sweep_items) and nothing the old fetch saw goes unseen.
    //     C8 (W2 shared contract #4): referral has MULTIPLE source ids
    //     (sweep-config.referral.sourceIds: string[]); join all of them.
    //
    // (b) CENSUS — every ACTIVE referral currently sitting in "Application Review" on an OPEN
    //     job, regardless of age. This is everything a created_at window can never see: launch
    //     backlog, un-rejects, stage rollbacks, arrivals during an outage longer than the window.
    //     It is also what makes the breach tier reachable at all: slaBreachHours equals
    //     lookbackHours (both 48), and hours-in-stage ≈ hours-since-creation in Application
    //     Review, so under the window-only fetch an application aged out of view at the exact
    //     hour it crossed into breach — zero breach rows across the sweep's first 12,002 items.
    //     The stage_name literal must match urgencyTier's gate (sweep-types.ts:79) exactly;
    //     a req whose review stage is named differently is invisible to BOTH, so the server-side
    //     filter narrows nothing the classifier wouldn't. Closed/draft-job sitters are excluded
    //     deliberately: 1,681 of 1,728 sitting referrals (2026-08-12 census) were on closed reqs
    //     — non-actionable, and DMing them would be the backlog blast the recruiter-routing
    //     start line exists to prevent.
    const [recentApps, censusAppsAllJobs, openJobs] = await Promise.all([
      greenhouseGetAll<GHApplication>("/applications", {
        source_ids: SWEEP_CONFIG.referral.sourceIds.join(","),
        created_at: `gte|${lookbackDate.toISOString()}`,
        per_page: 500,
      }),
      greenhouseGetAll<GHApplication>("/applications", {
        source_ids: SWEEP_CONFIG.referral.sourceIds.join(","),
        status: "active",
        stage_name: "Application Review",
        per_page: 500,
      }),
      greenhouseGetAll<GHJob>("/jobs", { status: "open", per_page: 500 }),
    ])

    const openJobIds = new Set(openJobs.map((j) => j.id))
    // Union by application id, recent slice first (order-stable for downstream inserts).
    const seenAppIds = new Set<number>()
    const applications: GHApplication[] = []
    for (const app of [
      ...recentApps,
      ...censusAppsAllJobs.filter((a) => openJobIds.has(a.job_id)),
    ]) {
      if (seenAppIds.has(app.id)) continue
      seenAppIds.add(app.id)
      applications.push(app)
    }

    if (applications.length === 0) {
      const completedRun = await markRunCompleted(runId, runRow.started_at, {
        scanned: 0,
        found: 0,
        alerted: 0,
      })
      return { run: completedRun, items: [], newAlerts: 0, slaViolations: 0 }
    }

    // Step 2: Batch-enrich with job titles and candidate names. The open-jobs fetch already
    // holds every census job; only the recent slice's non-open jobs still need fetching. All
    // id-filtered fetches run through greenhouse-evidence's <=50-id batching — the census union
    // routinely carries more ids than one raw `ids` join legally can (50-id cap).
    const uniqueJobIds = [...new Set(applications.map((a) => a.job_id))]
    const uniqueCandidateIds = [
      ...new Set(applications.map((a) => a.candidate_id)),
    ]
    const missingJobIds = uniqueJobIds.filter((id) => !openJobIds.has(id))

    const [missingJobs, candidates, jobOwners, referrers] = await Promise.all([
      listJobsByIds(missingJobIds),
      listCandidatesByIds(uniqueCandidateIds),
      // R1-R3 evidence: every owner row for the jobs in this batch (greenhouse-evidence
      // batches <=50 ids/query and carries the `responsible` flag the R1 rung needs).
      listJobOwners(uniqueJobIds),
      // The ONLY join that names a referrer: app.referrer_id is a /referrers.id, not a user id.
      // Empty id list short-circuits without a network call (greenhouse-evidence fetchByIds).
      listReferrers(applications.map((a) => a.referrer_id ?? a.credited_to?.id)),
    ])

    const jobMap = new Map([...openJobs, ...missingJobs].map((j) => [j.id, j]))
    const candidateMap = new Map(candidates.map((c) => [c.id, c]))
    const referrersById = new Map<number, YtdGHReferrer>(
      referrers.map((r) => [r.id, r])
    )

    // Group owners by job for the per-application resolution. Keep every owner row
    // (the resolver itself filters to type==='recruiter' + active); preserve fetch order.
    const ownersByJobId = new Map<number, OwnerRow[]>()
    for (const owner of jobOwners) {
      const row: OwnerRow = {
        user_id: owner.user_id,
        type: owner.type,
        responsible: owner.responsible === true,
        active: owner.active,
      }
      const existing = ownersByJobId.get(owner.job_id)
      if (existing) existing.push(row)
      else ownersByJobId.set(owner.job_id, [row])
    }

    // Resolve owner user_ids -> names. The resolver derives recruiter_name from this
    // map (identity-resolver.nameOf); a missing user simply yields a null name, never a
    // sentinel. Fetch only the owner ids we actually saw.
    const ownerUserIds = [...new Set(jobOwners.map((o) => o.user_id))]
    const ownerUsers = ownerUserIds.length > 0 ? await listUsers(ownerUserIds) : []
    const usersById = new Map<number, YtdGHUser>(
      ownerUsers.map((u) => [u.id, u])
    )

    // Step 3: Build sweep items with SLA computation (all statuses, not just active).
    const now = Date.now()
    const items: ReferralSweepItemWithIdentity[] = applications.map((app) => {
      const job = jobMap.get(app.job_id)
      const candidate = candidateMap.get(app.candidate_id)
      const stageName = ghStageName(app)

      const rawStageTs = ghStageEnteredAt(app)
      const stageEnteredAt = rawStageTs
        ? new Date(rawStageTs).getTime()
        : now
      const hoursInStage = (now - stageEnteredAt) / (1000 * 60 * 60)

      const tier = urgencyTier(stageName, app.status, hoursInStage)

      // Recruiter ownership via the synchronous owner-level ladder (R1-R3). The sweep's
      // GHApplication carries no recruiter_id, so R2 (application.recruiter_id match) is
      // skipped — the resolver is null-safe on its absence (frozen-spec:287) and R1
      // (one responsible:true owner) / R3 (one active owner) decide. On any non-resolved
      // status the resolution guarantees primary_recruiter_id/name are NULL; that defect
      // is carried as ownership_resolution_status below, never as a sentinel name.
      const jobOwnerRows = ownersByJobId.get(app.job_id) ?? []
      const ownership = resolveOwnership({
        jobOwners: jobOwnerRows,
        usersById,
        applicationRecruiterId: null,
      })

      // 015: EVERY recruiter on the requisition's hiring team, not just the elected primary.
      // resolveOwnership deliberately narrows to one owner for the dashboard's ownership contract;
      // alert fan-out needs the whole list, and this sweep already holds it. Recording it here puts
      // owner resolution on the hourly cadence — ytd_application_facts.recruiter_ids is written once
      // a day, so before this a referral arriving after 06:30 UTC had no owners until the next
      // morning and its hour-1 alert fell back to the head-of-TA.
      //
      // type === 'recruiter' only: this must mirror the Greenhouse "Recruiters" row of the Hiring
      // Team panel, which is who a referral is news for. Coordinators, sourcers and hiring managers
      // are excluded. A user listed under two types (e.g. recruiter AND sourcer) is counted once.
      // An empty array is meaningful — it says the req genuinely has no recruiters — so it is NOT
      // collapsed to null.
      const recruiterIds = [
        ...new Set(
          jobOwnerRows.filter((o) => o.type === "recruiter").map((o) => o.user_id)
        ),
      ]

      return {
        application_id: app.id,
        candidate_id: app.candidate_id,
        job_id: app.job_id,
        candidate_name: candidate
          ? `${candidate.first_name} ${candidate.last_name}`
          : `Candidate #${app.candidate_id}`,
        job_title: job?.name ?? `Job #${app.job_id}`,
        source_name: app.source?.name ?? "Referral",
        current_stage: stageName,
        application_status: app.status,
        application_created_at:
          app.applied_at ?? app.created_at ?? app.last_activity_at ?? "",
        current_stage_entered_at: ghStageEnteredAt(app),
        last_activity_at: app.last_activity_at,
        hours_in_current_stage: Math.round(hoursInStage * 10) / 10,
        urgency_tier: tier,
        referrer_name: deriveReferrerName(app, referrersById),
        recruiter_ids: recruiterIds,
        referrer_id: app.credited_to?.id ?? app.referrer_id ?? null,
        // Resolved recruiter identity (NULL on any non-'resolved' status — the defect
        // lives in ownership_resolution_status, never as "UNASSIGNED").
        recruiter_id: ownership.primary_recruiter_id,
        recruiter_name: ownership.primary_recruiter_name,
        ownership_confidence: ownership.confidence,
        ownership_resolution_status: ownership.status,
      }
    })

    const slaViolations = items.filter(
      (i) => i.urgency_tier === "breach" || i.urgency_tier === "sla_risk"
    ).length

    // Step 5: Check alert ledger for already-alerted application_ids
    const appIds = items.map((i) => i.application_id)
    const { data: existingAlerts } = await supabase
      .from("alert_ledger")
      .select("application_id")
      .eq("sweep_type", "referral")
      .in("application_id", appIds)

    const alreadyAlerted = new Set(
      (existingAlerts ?? []).map(
        (a: { application_id: number }) => a.application_id
      )
    )
    const newItems = items.filter(
      (i) => !alreadyAlerted.has(i.application_id)
    )
    // ALERTABLE new items only: an item already actioned at first sight was
    // never alerted, so it gets no ledger row and does not count as alerted. sweep_items remains
    // the "everything seen" record; the ledger means what its column names say. Without this, a
    // polluted row created before the recruiter-routing start line would terminally suppress a
    // legitimate future alert if its candidate ever regressed into Application Review.
    const newAlertable = newItems.filter((i) => i.urgency_tier !== "actioned")

    // Step 6: Persist to Supabase (skip in dry-run mode)
    if (!opts.dryRun) {
      // Insert sweep items
      if (items.length > 0) {
        const sweepItemRows = items.map((item) => ({
          sweep_run_id: runId,
          sweep_type: "referral" as const,
          application_id: item.application_id,
          candidate_id: item.candidate_id,
          job_id: item.job_id,
          candidate_name: item.candidate_name,
          job_title: item.job_title,
          source_name: item.source_name,
          current_stage: item.current_stage,
          application_status: item.application_status,
          application_created_at: item.application_created_at,
          current_stage_entered_at: item.current_stage_entered_at,
          last_activity_at: item.last_activity_at,
          hours_in_current_stage: item.hours_in_current_stage,
          sla_violated:
            item.urgency_tier === "breach" ||
            item.urgency_tier === "sla_risk",
          urgency_tier: item.urgency_tier,
          referrer_name: item.referrer_name,
          // W2 identity writeback (005 columns). recruiter_* are NULL unless the
          // ownership resolution is 'resolved'; the status/confidence carry the defect.
          referrer_id: item.referrer_id,
          // 015 — the fan-out owner list. NOT in SWEEP_ITEMS_005_COLUMNS: 005's gate exists so the
          // insert stays legal before that migration was applied, and 015 is already applied.
          recruiter_ids: item.recruiter_ids,
          recruiter_id: item.recruiter_id,
          recruiter_name: item.recruiter_name,
          ownership_confidence: item.ownership_confidence,
          ownership_resolution_status: item.ownership_resolution_status,
        }))
        // 005 writeback gate: strip the 005 columns pre-005 (default) so this hourly cron insert
        // is legal against a pre-migration DB. See lib/sweep-writeback.ts.
        const ownershipWriteback = isSweepOwnershipWritebackEnabled()
        const { error: sweepItemsError } = await supabase
          .from("sweep_items")
          .insert(
            sweepItemRows.map((r) => gateSweepRow(r, SWEEP_ITEMS_005_COLUMNS, ownershipWriteback))
          )
        if (sweepItemsError) throw new Error(`sweep_items insert failed: ${sweepItemsError.message}`)
      }

      // Insert new alert ledger entries (alertable only — see newAlertable above).
      if (newAlertable.length > 0) {
        const now = new Date().toISOString()
        const alertRows = newAlertable.map((item) => ({
          application_id: item.application_id,
          sweep_type: "referral" as const,
          first_alerted_at: now,
          last_alerted_at: now,
          alert_count: 1,
          greenhouse_stage_at_alert: item.current_stage,
        }))
        const { error: alertUpsertError } = await supabase.from("alert_ledger").upsert(alertRows, {
          onConflict: "application_id,sweep_type",
        })
        if (alertUpsertError) throw new Error(`alert_ledger upsert failed: ${alertUpsertError.message}`)
      }

      // Update last_alerted_at for re-alerted items — alertable only, same class as the
      // newAlertable filter: an already-ledgered item that has since been actioned is being
      // resolved, not re-alerted, and bumping its timestamp would record an alert that never sent.
      const reAlertedIds = items
        .filter((i) => alreadyAlerted.has(i.application_id) && i.urgency_tier !== "actioned")
        .map((i) => i.application_id)
      if (reAlertedIds.length > 0) {
        const { error: reAlertError } = await supabase
          .from("alert_ledger")
          .update({ last_alerted_at: new Date().toISOString() })
          .eq("sweep_type", "referral")
          .in("application_id", reAlertedIds)
        if (reAlertError) throw new Error(`alert_ledger update failed: ${reAlertError.message}`)
      }
    }

    // Step 7: Mark run completed
    const completedRun = await markRunCompleted(runId, runRow.started_at, {
      scanned: applications.length,
      found: items.length,
      alerted: newAlertable.length,
    })

    return {
      run: completedRun,
      items,
      newAlerts: newAlertable.length,
      slaViolations,
    }
  } catch (err) {
    const { error: failUpdateError } = await supabase
      .from("sweep_runs")
      .update({
        completed_at: new Date().toISOString(),
        status: "failed",
        error_message: err instanceof Error ? err.message : String(err),
      })
      .eq("id", runId)
    if (failUpdateError) console.error(`sweep_runs failure-status update failed: ${failUpdateError.message}`)
    throw err
  }
}

async function markRunCompleted(
  runId: string,
  startedAt: string,
  counts: { scanned: number; found: number; alerted: number }
): Promise<SweepRunSummary> {
  const completedAt = new Date().toISOString()
  const { error: completeError } = await supabase
    .from("sweep_runs")
    .update({
      completed_at: completedAt,
      status: "completed",
      applications_scanned: counts.scanned,
      items_found: counts.found,
      items_alerted: counts.alerted,
    })
    .eq("id", runId)
  if (completeError) throw new Error(`sweep_runs completion update failed: ${completeError.message}`)

  return {
    id: runId,
    sweep_type: "referral",
    started_at: startedAt,
    completed_at: completedAt,
    status: "completed",
    applications_scanned: counts.scanned,
    items_found: counts.found,
    items_alerted: counts.alerted,
  }
}
