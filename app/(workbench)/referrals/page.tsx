import { getReferralTrackerData } from "@/lib/sweep-dashboard";
import { hasEnv } from "@/lib/env";
import { ReferralTrackerClient } from "./client";

export const dynamic = "force-dynamic";

async function loadReferralData() {
  if (!hasEnv("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY")) {
    return null;
  }

  try {
    return await getReferralTrackerData();
  } catch (error) {
    console.error("[referrals] Failed to load tracker data:", error);
    return null;
  }
}

export default async function ReferralTrackerPage() {
  const data = await loadReferralData();

  return <ReferralTrackerClient data={data} />;
}
