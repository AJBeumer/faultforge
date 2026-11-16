# tickets

Work tickets on GitHub Issues, in either repo.

- `ticket-ready.ts`: whether a ticket has the sections and checklist `factory.json` asks for.
- `ticket-premises.ts`: whether the paths, scripts and functions a ticket names exist on `origin/main`.
- `ticket-write.ts`: the factory runner's comments and labels on a ticket; a reviewed repo's go through the door.

Entry points: `npm run ticket:ready` (`cli/ticket-ready-cli.ts`).

Uses: `shared`, `door`.
