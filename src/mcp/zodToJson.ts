// Minimal placeholder — we generate JSON Schema manually in tools.ts.
// Kept so the import in tools.ts doesn't break if left; not used.
export function zodToJsonSchema(_z: unknown): Record<string, unknown> {
  return { type: "object" };
}
