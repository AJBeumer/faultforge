/** An error's message, or the thrown value as text: what every script prints when something fails. */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
