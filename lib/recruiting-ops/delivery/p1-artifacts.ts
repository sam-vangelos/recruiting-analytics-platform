export const P1_ELT_DOC_TARGET = {
  deliverableId: "elt_recruiting_doc",
  piiPolicy: "internal_review_identifiers",
  aclRule: "exact_owner_and_service_writer",
  upsertKeyField: "elt_facts.weekShort",
  // Per the operator's 2026-08-06 canonical-cutover directive, mutation authority
  // points at the canonical ELT doc directly (see
  // docs/recruiting-ops/delivery/p1/PREREQUISITES.md,
  // RECOPS-ELT-FACT-TABLE-BOUNDARY-v3).
  stagingDocumentId: "1ExampleDriveId00000000000000000000000000021",
  expectedTitle: "ELT Recruiting Updates",
  tabId: "t.0",
  liveFlag: "RECOPS_HYDRATE_ELT_DOC",
  // The retired the operator-owned copy is evidence-only now. It is an explicit deny
  // target even though this dry-run slice exposes no Google mutation method.
  deniedDocumentIds: ["1ExampleDriveId00000000000000000000000000007"],
} as const

export function eltDocTargetIdConflicts(documentId: string | undefined): string[] {
  const normalized = documentId?.trim() ?? ""
  if (!normalized) return ["Document id is missing."]
  if ((P1_ELT_DOC_TARGET.deniedDocumentIds as readonly string[]).includes(normalized)) {
    return ["Document id is a denied retired-copy target."]
  }
  if (normalized !== P1_ELT_DOC_TARGET.stagingDocumentId) {
    return ["Document id does not match the approved P1 staging copy."]
  }
  return []
}

export function eltDocTargetConflicts(input: {
  documentId?: string
  title?: string
  tabId?: string
}): string[] {
  const reasons = eltDocTargetIdConflicts(input.documentId)
  if ((input.title?.trim() ?? "") !== P1_ELT_DOC_TARGET.expectedTitle) {
    reasons.push("Document title does not match the approved P1 staging copy.")
  }
  if ((input.tabId?.trim() ?? "") !== P1_ELT_DOC_TARGET.tabId) {
    reasons.push("Document tab id does not match the approved P1 tab.")
  }
  return reasons
}
