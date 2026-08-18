export function latestScopedSourceObservedAt<T>(
  rows: readonly T[],
  timestampFor: (row: T) => string | null | undefined
): string | null {
  let latest = 0
  for (const row of rows) {
    const value = timestampFor(row)
    if (!value?.trim()) continue
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed) && parsed > latest) latest = parsed
  }
  return latest > 0 ? new Date(latest).toISOString() : null
}
