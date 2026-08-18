import { PII_FINGERPRINT_SALT_ENV } from "../../lib/recruiting-ops/checksums"
import { replayReportingSourceCut } from "../../lib/recruiting-ops/delivery-source/reporting-source-cut"
import { readCompletedSourceExecution } from "../../lib/recruiting-ops/source-execution-store"
import { createSupabaseSourceExecutionStoreClient } from "../../lib/recruiting-ops/supabase-source-execution-store-client"

const sourceExecutionId = process.argv[2]?.trim()
if (!sourceExecutionId) throw new Error("Source execution id is required.")
const fingerprintKey = process.env[PII_FINGERPRINT_SALT_ENV]?.trim()
if (!fingerprintKey) throw new Error("Source replay fingerprint key is unavailable.")

const stored = await readCompletedSourceExecution(
  sourceExecutionId,
  createSupabaseSourceExecutionStoreClient()
)
if (!stored?.sourceFingerprint) throw new Error("Completed replayable source cut is unavailable.")
const replayed = replayReportingSourceCut({
  payload: stored.sourcePayload,
  payloadFingerprint: stored.sourceFingerprint,
  fingerprintKey,
})

console.log(JSON.stringify({
  sourceExecutionId,
  storedFingerprint: stored.sourceFingerprint,
  replayFingerprint: replayed.payloadFingerprint,
  sourcePayloadChecksum: stored.sourcePayloadChecksum,
  sourceCounts: stored.sourceCounts,
}))
