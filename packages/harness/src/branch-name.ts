/**
 * Derives a free branch name for a case run: the template's base name if nothing uses it yet,
 * otherwise the base name with the smallest free numeric suffix (`<base>-2`, then `-3`, ...). A name
 * counts as taken when it exists locally or on `origin`, so a branch pushed from another checkout
 * (and never fetched here) is never reused.
 */

export interface BranchExistence {
  existsLocally(name: string): boolean;
  existsOnOrigin(name: string): boolean;
}

export function deriveBranchName(base: string, git: BranchExistence): string {
  const taken = (name: string) => git.existsLocally(name) || git.existsOnOrigin(name);
  if (!taken(base)) return base;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!taken(candidate)) return candidate;
  }
}
