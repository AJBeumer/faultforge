# fixtures

Test support only. No module outside a test imports it.

- `git-repo.ts`: a throwaway git checkout whose `origin/main` holds given files.
- `temp-dir.ts`: a fresh temp folder by its real spelling. New tests take their temp folders from here.

Uses: no other area.
