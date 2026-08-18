export function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

export function requireEnv(name: string): string {
  const value = readEnv(name)
  if (!value) throw new Error(`${name} must be set`)
  return value
}

export function hasEnv(...names: string[]): boolean {
  return names.every((name) => Boolean(readEnv(name)))
}
