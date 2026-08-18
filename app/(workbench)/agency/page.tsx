import { getAgencyTrackerData } from "@/lib/sweep-dashboard";
import { hasEnv } from "@/lib/env";
import { AgencyTrackerClient } from "./client";

export const dynamic = "force-dynamic";

async function loadAgencyData() {
  if (!hasEnv("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY")) {
    return null;
  }

  try {
    return await getAgencyTrackerData();
  } catch (error) {
    console.error("[agency] Failed to load tracker data:", error);
    return null;
  }
}

export default async function AgencyTrackerPage() {
  const data = await loadAgencyData();

  return <AgencyTrackerClient data={data} />;
}
