import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { readEnv } from "./env.ts"

let _client: SupabaseClient | null = null

export function getSupabase(): SupabaseClient {
  if (!_client) {
    const url = readEnv("SUPABASE_URL")
    const key = readEnv("SUPABASE_SERVICE_ROLE_KEY")
    if (!url || !key) {
      throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set")
    }
    _client = createClient(url, key)
  }
  return _client
}

/** Convenience alias — call at runtime only, not at module init. */
export const supabase = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    return (getSupabase() as unknown as Record<string | symbol, unknown>)[prop]
  },
})
