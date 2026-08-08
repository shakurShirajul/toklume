/** Serialize a payload as pretty JSON for `--json` output. */
function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

/** Print a payload as JSON on stdout. */
export function printJson(value: unknown): void {
  process.stdout.write(`${toJson(value)}\n`)
}
