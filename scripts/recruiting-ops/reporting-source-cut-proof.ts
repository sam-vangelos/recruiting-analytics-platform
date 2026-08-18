import { runReportingSourceCutProof } from "../../lib/recruiting-ops/delivery/staging-hydration-orchestrator"

const result = await runReportingSourceCutProof()
console.log(JSON.stringify(result))
if (result.status !== "completed") process.exitCode = 1
