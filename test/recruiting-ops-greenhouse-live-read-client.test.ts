import { beforeEach, describe, expect, test, vi } from "vitest"

vi.mock("../lib/greenhouse-client", () => ({
  greenhouseGet: vi.fn(),
  greenhouseGetWithCursor: vi.fn(),
}))

import { greenhouseGet, greenhouseGetWithCursor } from "../lib/greenhouse-client"
import {
  createLiveGreenhouseHarvestReadClient,
  createLiveGreenhouseReadBoundary,
} from "../lib/recruiting-ops/extractors/greenhouse-live-read-client"

const mockGet = vi.mocked(greenhouseGet)
const mockCursor = vi.mocked(greenhouseGetWithCursor)

beforeEach(() => {
  mockGet.mockReset()
  mockCursor.mockReset()
})

describe("live Greenhouse Harvest read client (C1 bridge)", () => {
  test("follows cursors to exhaustion and concatenates pages", async () => {
    mockGet.mockResolvedValueOnce({ data: [{ id: 1 }, { id: 2 }], nextCursor: "c1" })
    mockCursor.mockResolvedValueOnce({ data: [{ id: 3 }], nextCursor: null })

    const client = createLiveGreenhouseHarvestReadClient()
    const records = await client.list<{ id: number }>("/offers", { per_page: 500, current_only: true })

    expect(records.map((record) => record.id)).toEqual([1, 2, 3])
    expect(mockGet).toHaveBeenCalledWith("/offers", { per_page: 500, current_only: true })
    expect(mockCursor).toHaveBeenCalledWith("/offers", "c1")
  })

  test("caps the pull at maxRecordsPerEndpoint and stops following cursors", async () => {
    mockGet.mockResolvedValueOnce({ data: [{ id: 1 }, { id: 2 }], nextCursor: "c1" })
    mockCursor.mockResolvedValueOnce({ data: [{ id: 3 }, { id: 4 }], nextCursor: "c2" })

    const client = createLiveGreenhouseHarvestReadClient({ maxRecordsPerEndpoint: 3 })
    const records = await client.list<{ id: number }>("/applications")

    expect(records).toHaveLength(3)
    // c2 must never be followed once the cap is reached.
    expect(mockCursor).toHaveBeenCalledTimes(1)
  })

  test("rejects a non-positive cap", () => {
    expect(() => createLiveGreenhouseHarvestReadClient({ maxRecordsPerEndpoint: 0 })).toThrow(
      /positive finite/
    )
  })

  test("the live boundary composes v3 join pulls through the adapter's field plans", async () => {
    mockGet.mockImplementation(async (endpoint: string) => {
      if (endpoint === "/jobs") {
        return {
          data: [{ id: "job_9", requisition_id: "890", updated_at: "2026-06-30T10:00:00.000Z" }],
          nextCursor: null,
        }
      }
      if (endpoint === "/job_owners") {
        return { data: [{ id: 1, user_id: 21, job_id: "job_9", type: "recruiter", responsible: true }], nextCursor: null }
      }
      if (endpoint === "/openings") {
        return {
          data: [
            { id: "o1", job_id: "job_9", open: true },
            { id: "o2", job_id: "job_9", open: true },
          ],
          nextCursor: null,
        }
      }
      if (endpoint === "/users") {
        return { data: [{ id: 21, name: "Recruiter One" }], nextCursor: null }
      }
      throw new Error(`unexpected endpoint ${endpoint}`)
    })

    const boundary = createLiveGreenhouseReadBoundary()
    const { facts, sourceGaps } = await boundary.fetchOwnershipFacts({ asOf: "2026-07-01T00:00:00.000Z" })

    expect(facts).toEqual([
      {
        jobId: "job_9",
        recruiterName: "Recruiter One",
        sourcerName: undefined,
        podName: undefined,
        openingsCount: 2,
        observedAt: "2026-06-30T10:00:00.000Z",
      },
    ])
    expect(sourceGaps).toEqual([])
    expect(mockGet).toHaveBeenCalledWith("/jobs", expect.objectContaining({ per_page: 500 }))
    expect(mockGet).toHaveBeenCalledWith("/openings", expect.objectContaining({ open: true }))
    expect(mockGet).toHaveBeenCalledWith("/users", expect.objectContaining({ ids: "21" }))
  })
})
