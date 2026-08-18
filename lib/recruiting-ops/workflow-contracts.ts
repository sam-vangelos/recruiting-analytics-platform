import { workflowRegistry, type WorkflowRegistryRow } from "./registries"
import {
  assertBlockersAndGate,
  assertKnownOutputContractIds,
  assertKnownQueryIds,
  assertKnownSourceIds,
  assertKnownWorkflowIds,
  assertProvenance,
  validateId,
  type ValidationSummary,
} from "./substrate"

export type WorkflowModuleReadiness = "not_started" | "substrate_ready" | "local_runner_ready" | "shadow_ready"

export interface CommandCenterWorkflowContract {
  id: string
  title: string
  capability: string
  category: WorkflowRegistryRow["category"]
  cadence: WorkflowRegistryRow["cadence"]
  priority: WorkflowRegistryRow["priority"]
  status: WorkflowRegistryRow["status"]
  sourceIds: readonly string[]
  queryIds: readonly string[]
  outputContractIds: readonly string[]
  moduleReadiness: WorkflowModuleReadiness
  owner: string
  provenance: WorkflowRegistryRow["provenance"]
  blockers: readonly string[]
  nextGate: string
}

export const commandCenterWorkflowContracts = workflowRegistry.map((row) =>
  buildWorkflowContract(row, "not_started")
) satisfies readonly CommandCenterWorkflowContract[]

export function buildWorkflowContract(
  row: WorkflowRegistryRow,
  moduleReadiness: WorkflowModuleReadiness
): CommandCenterWorkflowContract {
  return {
    id: row.id,
    title: row.title,
    capability: row.capability,
    category: row.category,
    cadence: row.cadence,
    priority: row.priority,
    status: row.status,
    sourceIds: row.sourceIds,
    queryIds: row.queryIds,
    outputContractIds: row.outputContractIds,
    moduleReadiness,
    owner: row.owner,
    provenance: row.provenance,
    blockers: row.blockers,
    nextGate: row.nextGate,
  }
}

export function validateWorkflowContract(contract: CommandCenterWorkflowContract): ValidationSummary {
  validateId(contract.id, "workflow.id")
  assertKnownWorkflowIds([contract.id])
  assertKnownSourceIds(contract.sourceIds, `${contract.id}.sourceIds`)
  assertKnownQueryIds(contract.queryIds, `${contract.id}.queryIds`)
  assertKnownOutputContractIds(contract.outputContractIds, `${contract.id}.outputContractIds`)
  assertProvenance(contract.provenance, `${contract.id}.provenance`)
  assertBlockersAndGate(contract)
  return {
    ok: true,
    id: contract.id,
    checked: ["id", "sources", "queries", "outputs", "provenance", "blockers", "nextGate"],
  }
}
