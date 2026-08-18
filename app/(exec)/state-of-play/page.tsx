import { loadLatestExecSnapshot } from "@/lib/recruiting-ops/exec-snapshot-store";
import type { ExecHireRow, ExecReqRow } from "@/lib/recruiting-ops/modules/exec-state-of-play";

export const dynamic = "force-dynamic";

/**
 * Exec state of play — EXEC_SURFACE_CONTENT_SPEC.md rendered. The module owns
 * every judgment (tiers, attention rules, reasons, emit order); this page
 * groups, formats, and discloses. Sections: lede → Needs a push → Moving →
 * Gone quiet → Open on paper → Hired → Pools & campaigns. Every req row is a
 * native disclosure carrying the full pipeline, 14-day movement, finalists
 * with time-in-stage, blockers, and housekeeping. No client JS; the only
 * interactivity is native <details>.
 */

const STALE_AFTER_MS = 26 * 3_600_000;

// Row pipeline strip: awaiting review + the six engaged stages, fixed slots.
const STRIP_STAGES = [
  { full: "Recruiter Phone Screen", label: "Screen" },
  { full: "Hiring Manager Review", label: "HM" },
  { full: "Manager / Tech Screen", label: "Tech" },
  { full: "Skills Assessment", label: "Assess" },
  { full: "Onsite Interview", label: "Onsite" },
  { full: "Offer", label: "Offer" },
] as const;

const DETAIL_STAGE_ORDER = [
  "Sourced",
  "Application Review",
  "Recruiter Phone Screen",
  "Hiring Manager Review",
  "Manager / Tech Screen",
  "Skills Assessment",
  "Onsite Interview",
  "Offer",
  "Other in-process",
] as const;

function splitTitle(title: string): { name: string; tag: string | null } {
  const match = title.match(/\s*\|\s*([A-Za-z]+)\s*$/);
  return {
    name: title
      .replace(/^\[[^\]]+\]\s*/, "")
      .replace(/\s*\|\s*[A-Za-z]*\s*$/, "")
      .replace(/\s+/g, " ")
      .trim(),
    tag: match ? match[1] : null,
  };
}

function deptShort(department: string): string {
  return department
    .replace("Production Engineering - Frontier AI", "Frontier AI")
    .replace("Production Engineering - Enterprise AI", "Enterprise AI")
    .replace("Production Engineering", "Prod Eng")
    .replace("R&D / Engineering", "R&D")
    .replace("Field Engineering", "Field Eng");
}

function nameCase(name: string): string {
  return name === name.toUpperCase() && name.length > 3
    ? name.toLowerCase().replace(/(^|[\s-])\w/g, (c) => c.toUpperCase())
    : name;
}

function fmtDay(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function fmtStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Los_Angeles",
  });
}

const funnelCell = (row: ExecReqRow, stage: string) => row.funnel.find((cell) => cell.stage === stage);
const reviewCount = (row: ExecReqRow) =>
  (funnelCell(row, "Sourced")?.count ?? 0) + (funnelCell(row, "Application Review")?.count ?? 0);
const conducted14 = (row: ExecReqRow) => row.conducted_last7 + row.conducted_prior7;
const advanced14 = (row: ExecReqRow) => row.advanced_last7 + row.advanced_prior7;

function Chips({ row }: { row: ExecReqRow }) {
  const { tag } = splitTitle(row.role);
  return (
    <>
      {tag ? <span className="chip">{tag}</span> : null}
      {row.confidential ? <span className="chip">confidential</span> : null}
      {row.seats > 1 ? <span className="chip">hiring {row.seats}</span> : null}
      <span className="dept">{deptShort(row.department)}</span>
    </>
  );
}

function TrendCell({ row }: { row: ExecReqRow }) {
  if (conducted14(row) + advanced14(row) > 0) {
    return (
      <>
        {conducted14(row)} interview{conducted14(row) === 1 ? "" : "s"} · {advanced14(row)} moved
      </>
    );
  }
  if (row.added_last7 > 0) return <>+{row.added_last7.toLocaleString()} applicants</>;
  return <span className="rt">—</span>;
}

function stateSentenceOf(row: ExecReqRow): React.ReactNode | null {
  // Gone-quiet rows lead with the stall itself; the sharpest flag rides along.
  if (row.tier === "gone_quiet") {
    return (
      <>
        <span className="sub-label">{row.tier_reason}.</span>
        {row.attention[0] ? <> {row.attention[0].reason}.</> : null}
      </>
    );
  }
  if (row.attention.length > 0) {
    return (
      <>
        <span className="sub-label">{row.attention[0].reason}.</span>
        {row.attention[1] ? <> {row.attention[1].reason}.</> : null}
      </>
    );
  }
  if (row.engaged_depth === 0 && reviewCount(row) === 0 && row.offers_accepted_12wk > 0) {
    return <>Hired {row.offers_accepted_12wk} in recent waves; pipeline now empty — restock or close.</>;
  }
  if (conducted14(row) + advanced14(row) > 0) {
    // The trend cell already carries the 14-day numbers — the sentence only
    // speaks when there is a story beyond them.
    return row.added_last7 >= 50 ? (
      <>{row.added_last7.toLocaleString()} new applicants this week on top of the interviewing above.</>
    ) : null;
  }
  if (row.added_last7 > 0) {
    return (
      <>
        No interviews yet — {row.added_last7} applicant{row.added_last7 === 1 ? "" : "s"} added this week.
      </>
    );
  }
  if (row.tier_rule === "ramping_grace") return <>{row.tier_reason}.</>;
  return <>{row.health_reason}.</>;
}

function Closest({ row }: { row: ExecReqRow }) {
  if (row.confidential || row.finalists.length === 0) return null;
  const shown = row.finalists.slice(0, 3);
  const more = row.finalists.length - shown.length;
  return (
    <>
      <span className="sub-label">Closest</span>{" "}
      {shown.map((finalist, index) => (
        <span key={`${finalist.url}-${index}`}>
          {index > 0 ? ", " : ""}
          <a href={finalist.url || undefined} target="_blank" rel="noreferrer">
            {nameCase(finalist.name)}
          </a>{" "}
          <span className="rt">
            ({finalist.stage}
            {finalist.in_stage_days !== null && finalist.in_stage_days > 14 ? `, waiting ${finalist.in_stage_days}d` : ""})
          </span>
        </span>
      ))}
      {more > 0 ? <span className="rt">, +{more} more</span> : null}
    </>
  );
}

function DetailPanel({ row }: { row: ExecReqRow }) {
  const pipeline = DETAIL_STAGE_ORDER.map((stage) => funnelCell(row, stage)).filter(
    (cell): cell is NonNullable<typeof cell> => Boolean(cell && cell.count > 0)
  );
  const movement = row.movement_14d.filter((cell) => cell.conducted > 0 || cell.advanced_in > 0);
  const offerCell = funnelCell(row, "Offer");
  const blockers: string[] = [];
  if (offerCell && offerCell.count > 0 && (offerCell.oldest_days ?? 0) >= 14) {
    blockers.push(`Offer outstanding ${offerCell.oldest_days} days.`);
  }
  if (row.pending_writeups > 0) {
    blockers.push(
      `${row.pending_writeups} interview${row.pending_writeups === 1 ? "" : "s"} conducted but feedback not yet filed.`
    );
  }
  if (!row.owner) blockers.push("No recruiter assigned.");

  return (
    <div className="detail">
      <div className="d-block">
        <p className="d-head">Pipeline right now</p>
        {pipeline.length === 0 ? <div className="d-line rt">No candidates.</div> : null}
        {pipeline.map((cell) => (
          <div className="d-row" key={cell.stage}>
            <span>{cell.stage === "Other in-process" ? "Other in-process (unmapped stages)" : cell.stage}</span>
            <span className="num">{cell.count.toLocaleString()}</span>
            <span className="rt">
              {cell.oldest_days !== null && cell.oldest_days > 14 ? `longest waiting ${cell.oldest_days}d` : ""}
            </span>
          </div>
        ))}
      </div>
      <div className="d-block">
        <p className="d-head">Movement, last 14 days</p>
        <div className="d-line">
          Interviews held: <span className="sub-label">{row.conducted_last7}</span> last week ·{" "}
          <span className="sub-label">{row.conducted_prior7}</span> the week before
        </div>
        <div className="d-line">
          Moved forward: <span className="sub-label">{row.advanced_last7}</span> ·{" "}
          <span className="sub-label">{row.advanced_prior7}</span>
        </div>
        {row.added_last7 > 0 ? (
          <div className="d-line">
            New applicants this week: <span className="sub-label">{row.added_last7.toLocaleString()}</span>
          </div>
        ) : null}
        {movement.length > 0 ? (
          <div className="d-line rt">
            By stage:{" "}
            {movement
              .map(
                (cell) =>
                  `${cell.stage} ${[
                    cell.conducted ? `${cell.conducted} held` : "",
                    cell.advanced_in ? `${cell.advanced_in} advanced in` : "",
                  ]
                    .filter(Boolean)
                    .join(", ")}`
              )
              .join(" · ")}
          </div>
        ) : null}
      </div>
      {row.finalists.length > 0 ? (
        <div className="d-block">
          <p className="d-head">In the final stretch</p>
          {row.confidential ? (
            <div className="d-line rt">Finalist names withheld on confidential searches — open the req in Greenhouse.</div>
          ) : (
            row.finalists.map((finalist, index) => (
              <div className="d-line" key={`${finalist.url}-${index}`}>
                <a href={finalist.url || undefined} target="_blank" rel="noreferrer">
                  {nameCase(finalist.name)}
                </a>{" "}
                <span className="rt">
                  — {finalist.stage}
                  {finalist.in_stage_days !== null ? `, waiting ${finalist.in_stage_days}d` : ""}
                </span>
              </div>
            ))
          )}
        </div>
      ) : null}
      {blockers.length > 0 ? (
        <div className="d-block">
          <p className="d-head">What&rsquo;s blocking</p>
          {blockers.map((line) => (
            <div className="d-line" key={line}>
              {line}
            </div>
          ))}
        </div>
      ) : null}
      <div className="d-block">
        <p className="d-head">Housekeeping</p>
        <div className="d-line rt">
          Opened {fmtDay(row.opened_on)} · <a href={`https://app.greenhouse.io/sdash/${row.req_id}`}>req {row.req_id}</a> ·{" "}
          {row.department} · {row.owner ? `Recruiter ${row.owner}` : "No recruiter"} · {row.seats} position
          {row.seats === 1 ? "" : "s"}
          {row.offers_accepted_12wk > 0
            ? ` · ${row.offers_accepted_12wk} hire${row.offers_accepted_12wk === 1 ? "" : "s"} from this req in 12 wks`
            : ""}
        </div>
      </div>
    </div>
  );
}

function HeaderRow() {
  return (
    <div className="req-head" aria-hidden>
      <span>Role</span>
      <span>Recruiter</span>
      <span className="num">Review</span>
      <span className="slots">
        {STRIP_STAGES.map((stage) => (
          <span className="num" key={stage.full}>
            {stage.label}
          </span>
        ))}
      </span>
      <span>Last 14 days</span>
    </div>
  );
}

function ReqRow({ row }: { row: ExecReqRow }) {
  const { name } = splitTitle(row.role);
  const review = reviewCount(row);
  const sentence = stateSentenceOf(row);
  const closest = <Closest row={row} />;
  const showClosest = row.finalists.length > 0 && !row.confidential;
  return (
    <details className="req">
      <summary>
        <div className="req-line">
          <span className="role">
            <span className="role-name">{name}</span>
            <Chips row={row} />
          </span>
          <span className="cell" data-l="Recruiter">
            {row.owner ?? <span className="strong">No recruiter</span>}
          </span>
          <span className="cell num" data-l="Review">
            {review > 0 ? review.toLocaleString() : ""}
          </span>
          <span className="slots cell" data-l="Pipeline">
            {STRIP_STAGES.map((stage) => {
              const count = funnelCell(row, stage.full)?.count ?? 0;
              return (
                <span className="num" key={stage.full}>
                  {count > 0 ? count : ""}
                </span>
              );
            })}
          </span>
          <span className="cell" data-l="Last 14 days">
            <TrendCell row={row} />
          </span>
        </div>
        {sentence || showClosest ? (
          <div className="req-sub">
            {sentence}
            {showClosest ? (
              <>
                {sentence ? <span className="rt"> — </span> : null}
                {closest}
              </>
            ) : null}
          </div>
        ) : null}
      </summary>
      <DetailPanel row={row} />
    </details>
  );
}

function PaperLine({ row, sentence }: { row: ExecReqRow; sentence: React.ReactNode }) {
  const { name, tag } = splitTitle(row.role);
  return (
    <div className="req">
      <div className="paper-line">
        <span className="role">
          <span className="role-name">{name}</span>
          {tag ? <span className="chip">{tag}</span> : null}
          <span className="dept">{deptShort(row.department)}</span>
        </span>
        <span className="cell">{row.owner ?? <span className="strong">No recruiter</span>}</span>
        <span className="cell">{sentence}</span>
      </div>
    </div>
  );
}

function HireLine({ hire }: { hire: ExecHireRow }) {
  const { name, tag } = splitTitle(hire.role);
  return (
    <div className="hire">
      <span className="cell strong" data-l="Candidate">
        <a href={hire.url || undefined} target="_blank" rel="noreferrer">
          {nameCase(hire.candidate)}
        </a>
      </span>
      <span className="cell" data-l="Role">
        {name}
        {tag ? <span className="chip"> {tag}</span> : null}
      </span>
      <span className="cell" data-l="Department">
        {deptShort(hire.department)}
      </span>
      <span className="cell num" data-l="Priority">
        {hire.priority ?? "—"}
      </span>
      <span className="cell num" data-l="Accepted">
        {fmtDay(hire.accepted_on)}
      </span>
      <span className="cell num" data-l="Starts">
        {fmtDay(hire.starts_on)}
      </span>
    </div>
  );
}

function PoolLine({ row }: { row: ExecReqRow }) {
  const review = reviewCount(row);
  const bits: string[] = [];
  if (row.engaged_depth > 0) bits.push(`${row.engaged_depth} in interviews`);
  if (review > 0) bits.push(`${review.toLocaleString()} awaiting review`);
  const closest = row.finalists.slice(0, 2).map((finalist) => nameCase(finalist.name));
  return (
    <span className="pool">
      <span className="strong">{row.role}</span>
      {bits.length ? ` (${bits.join(", ")})` : ""}
      {closest.length ? ` — closest ${closest.join(", ")}` : ""}
    </span>
  );
}

export default async function StateOfPlayPage() {
  const latest = await loadLatestExecSnapshot();

  if (latest.status === "unavailable") {
    return (
      <div className="page">
        <header>
          <div className="masthead">
            <div>
              <p className="kicker">Recruiting Operations</p>
              <h1>State of Play</h1>
            </div>
          </div>
        </header>
        <div className="unavailable">
          <p className="lede">
            The state-of-play feed hasn&rsquo;t produced a snapshot yet. When the next run completes, this page will show
            every open search with its pipeline, movement, and who&rsquo;s closest to a hire. <span className="rt">({latest.reason})</span>
          </p>
        </div>
      </div>
    );
  }

  const { snapshot } = latest;
  const rollup = snapshot.org_rollup;
  const rows = snapshot.req_rows;

  // The tier fields arrive with the content-contract module (E01 ≥ 2026-07-08).
  // An older snapshot renders an honest notice instead of a wrong grouping.
  if (rows.some((row) => typeof row.tier !== "string")) {
    return (
      <div className="page">
        <header>
          <div className="masthead">
            <div>
              <p className="kicker">Recruiting Operations</p>
              <h1>State of Play</h1>
            </div>
            <p className="stamp">Updated {fmtStamp(rollup.as_of)} PT</p>
          </div>
        </header>
        <div className="unavailable">
          <p className="lede">
            The latest snapshot predates the tier model this page renders. The next run will replace it; nothing is wrong
            with the underlying data.
          </p>
        </div>
      </div>
    );
  }

  const roles = rows.filter((row) => row.req_class === "role");
  const inPlay = roles.filter((row) => row.tier === "in_play");
  const push = inPlay.filter((row) => row.attention.length > 0);
  const moving = inPlay.filter((row) => row.attention.length === 0);
  const quiet = roles.filter((row) => row.tier === "gone_quiet");
  const filled = roles.filter((row) => row.tier === "filled_not_closed");
  const noSearch = roles.filter((row) => row.tier === "no_search");
  const pools = rows.filter((row) => row.req_class !== "role");
  const paperCount = filled.length + noSearch.length;
  const weekHires = snapshot.hires.filter((hire) => hire.week_friday === rollup.reporting_week_friday);
  const recentHires = snapshot.hires.slice(0, 8);
  const restHires = snapshot.hires.slice(8);
  const unclassifiedTotal = rows.reduce((sum, row) => sum + row.unclassified_count, 0);
  const stale = Date.now() - Date.parse(rollup.as_of) > STALE_AFTER_MS;

  return (
    <div className="page">
      <header>
        <div className="masthead">
          <div>
            <p className="kicker">Recruiting Operations</p>
            <h1>State of Play</h1>
          </div>
          <p className="stamp">Updated {fmtStamp(rollup.as_of)} PT</p>
        </div>
        {stale ? (
          <div className="stale">
            <span className="dot dot-amber" />
            This snapshot is from {fmtStamp(rollup.as_of)} PT — older than expected. The next refresh should have replaced
            it; numbers below may be behind.
          </div>
        ) : null}
        <div className="opening">
          <p className="lede">
            <strong>{rollup.tiers.in_play} searches</strong> are in play for <strong>{rollup.positions_in_play} positions</strong>.{" "}
            {rollup.attention_count > 0 ? (
              <>
                <span className="bad">{rollup.attention_count} need a push</span> — including {rollup.offers_out.count} offer
                {rollup.offers_out.count === 1 ? "" : "s"} out
                {rollup.offers_out.waiting_14d_plus > 0
                  ? `, ${rollup.offers_out.waiting_14d_plus} waiting two weeks or more`
                  : ""}
                .{" "}
              </>
            ) : (
              <>Nothing is waiting on leadership this week. </>
            )}
            {paperCount + quiet.length > 0 ? (
              <>{paperCount + quiet.length} more reqs are open on paper but not being worked. </>
            ) : null}
            <strong>{rollup.offers_accepted_12wk} offers</strong> were accepted in the last 12 weeks
            {weekHires.length > 0 ? `, ${weekHires.length} this week` : ""}.
          </p>
          <nav className="index">
            <a href="#push">
              <span className="dot dot-red" />
              Needs a push<span className="n">{push.length}</span>
            </a>
            <a href="#moving">
              <span className="dot dot-green" />
              Moving<span className="n">{moving.length}</span>
            </a>
            <a href="#quiet">
              <span className="dot dot-amber" />
              Gone quiet<span className="n">{quiet.length}</span>
            </a>
            <a href="#paper">
              Open on paper<span className="n">{paperCount}</span>
            </a>
            <a href="#hired">
              Hired · 12 wks<span className="n">{rollup.offers_accepted_12wk}</span>
            </a>
            <a href="#pools">
              Pools<span className="n">{pools.length}</span>
            </a>
          </nav>
        </div>
      </header>

      <section id="push">
        <div className="sec-head">
          <span className="dot dot-red" />
          <h2>Needs a push</h2>
          <span className="count">
            {push.length > 0
              ? `${push.length} of ${inPlay.length} searches in play — sorted by what's waiting longest`
              : "none this week"}
          </span>
        </div>
        {push.length > 0 ? (
          <div className="group">
            <HeaderRow />
            {push.map((row) => (
              <ReqRow row={row} key={row.job_id} />
            ))}
          </div>
        ) : (
          <p className="lede hires-week">
            Nothing stuck — every in-play search has moved, has its feedback filed, and has a recruiter on it.
          </p>
        )}
      </section>

      {moving.length > 0 ? (
        <section id="moving">
          <div className="sec-head">
            <span className="dot dot-green" />
            <h2>Moving</h2>
            <span className="count">{moving.length} searches — closest to a hire first</span>
          </div>
          <div className="group">
            <HeaderRow />
            {moving.map((row) => (
              <ReqRow row={row} key={row.job_id} />
            ))}
          </div>
        </section>
      ) : null}

      {quiet.length > 0 ? (
        <section id="quiet">
          <div className="sec-head">
            <span className="dot dot-amber" />
            <h2>Gone quiet</h2>
            <span className="count">{quiet.length} searches with candidates parked and no movement in 30+ days</span>
          </div>
          <div className="group">
            <HeaderRow />
            {quiet.map((row) => (
              <ReqRow row={row} key={row.job_id} />
            ))}
          </div>
        </section>
      ) : null}

      {paperCount > 0 ? (
        <section id="paper">
          <div className="sec-head">
            <h2>Open on paper</h2>
            <span className="count">
              {paperCount} reqs open in Greenhouse with no search running — a close-or-restart decision, not a recruiting
              task
            </span>
          </div>
          {filled.length > 0 ? (
            <div className="group">
              <p className="group-lead">
                Filled, not closed <span className="n">· {filled.length} reqs</span>
              </p>
              {filled.map((row) => (
                <PaperLine
                  row={row}
                  key={row.job_id}
                  sentence={
                    <>
                      Hired {row.offers_accepted_12wk}, last on {fmtDay(row.last_hire_accepted_on)} — req still open,
                      nothing in pipeline. <span className="rt">req {row.req_id}</span>
                    </>
                  }
                />
              ))}
            </div>
          ) : null}
          {noSearch.length > 0 ? (
            <div className="group">
              <p className="group-lead">
                No search running <span className="n">· {noSearch.length} reqs</span>
              </p>
              {noSearch.map((row) => (
                <PaperLine
                  row={row}
                  key={row.job_id}
                  sentence={
                    <>
                      No candidates, no activity. Opened {fmtDay(row.opened_on)}. <span className="rt">req {row.req_id}</span>
                    </>
                  }
                />
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      <section id="hired">
        <div className="sec-head">
          <h2>Hired</h2>
          <span className="count">{rollup.offers_accepted_12wk} accepted offers in 12 weeks</span>
        </div>
        {weekHires.length > 0 ? (
          <p className="lede hires-week">
            This week:{" "}
            {weekHires.map((hire, index) => (
              <span key={`${hire.url}-${hire.accepted_on}`}>
                {index > 0 ? (index === weekHires.length - 1 ? " and " : ", ") : ""}
                <strong>{nameCase(hire.candidate)}</strong> <span className="rt">({splitTitle(hire.role).name})</span>
              </span>
            ))}
            .
          </p>
        ) : null}
        <div className="group">
          {recentHires.map((hire) => (
            <HireLine hire={hire} key={`${hire.url}-${hire.accepted_on}`} />
          ))}
          {restHires.length > 0 ? (
            <details className="more">
              <summary>Show the other {restHires.length} accepted offers</summary>
              {restHires.map((hire) => (
                <HireLine hire={hire} key={`${hire.url}-${hire.accepted_on}`} />
              ))}
            </details>
          ) : null}
        </div>
      </section>

      {pools.length > 0 ? (
        <section id="pools">
          <div className="sec-head">
            <h2>Pools &amp; campaigns</h2>
            <span className="count">{pools.length} · tracked separately, not open searches</span>
          </div>
          <p className="pools-prose">
            {pools.map((row, index) => (
              <span key={row.job_id}>
                {index > 0 ? <> &nbsp;·&nbsp; </> : null}
                <PoolLine row={row} />
              </span>
            ))}
          </p>
        </section>
      ) : null}

      <footer>
        A search is <em>in play</em>{" "}
        when interviews, stage moves, or new applicants appeared in the last 30 days (new
        reqs get a two-week grace). &ldquo;Review&rdquo; counts applicants awaiting a first screen, separate from
        candidates interviewing. Interviews are truthed by submitted scorecards.
        {unclassifiedTotal > 0
          ? ` This run left ${unclassifiedTotal} candidate${unclassifiedTotal === 1 ? "" : "s"} on unmapped stages ("other in-process").`
          : ""}
      </footer>
    </div>
  );
}
