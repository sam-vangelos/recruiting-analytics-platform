import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"

import {
  BROAD_CANDIDATE_SURFACE_BASIC_CHALLENGE,
  authorizeBroadCandidateSurfaceRequest,
} from "@/lib/broad-candidate-surface-auth"

export function proxy(request: NextRequest) {
  const authorized = authorizeBroadCandidateSurfaceRequest({
    pathname: request.nextUrl.pathname,
    authorizationHeader: request.headers.get("authorization"),
  })

  if (authorized.authorized) return NextResponse.next()

  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "Cache-Control": "no-store",
      "WWW-Authenticate": BROAD_CANDIDATE_SURFACE_BASIC_CHALLENGE,
    },
  })
}

// The matcher decides which requests reach `proxy`; `isProtectedBroadCandidateSurfacePath`
// decides which of those need a credential. Matching all of /api/ytd is safe because the
// scheduler-authenticated ingestion routes resolve to `not_protected` and pass straight
// through — keeping the exemption in one place instead of splitting it across two files.
export const config = {
  matcher: [
    "/agency/:path*",
    "/referrals/:path*",
    "/state-of-play/:path*",
    "/api/ytd/:path*",
  ],
}
