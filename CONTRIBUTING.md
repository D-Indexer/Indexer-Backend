# Contributing

Thanks for helping build Folder. This repo is the API and event indexer; the contract lives
in [Indexer-Contract](https://github.com/D-Indexer/Indexer-Contract) and the UI in
[Indexer-Frontend](https://github.com/D-Indexer/Indexer-Frontend).

## Find something to work on

Open issues are labelled by difficulty: `good first issue`, `difficulty: medium` and
`difficulty: hard`. Each one lists context, files, acceptance criteria and the tests expected.
Comment on an issue before starting so work isn't duplicated.

## Set up

Requirements: Node 20+, Docker.

```bash
git clone https://github.com/D-Indexer/Indexer-Backend.git && cd Indexer-Backend
npm install
cp .env.example .env            # preset for testnet
docker compose up -d postgres ipfs
npm run db:migrate
npm run dev:indexer             # terminal 1: indexes the testnet contract
npm run dev                     # terminal 2: API on http://localhost:3000
```

Or run everything in containers with `docker compose up --build` (see the README).

## Checks

CI runs these on every pull request. Run them before pushing:

```bash
npm run typecheck
npm run lint        # ESLint + Prettier check; `npm run format` fixes
npm test
```

`npm run check` runs all three.

## Tests

| Suite                                               | Runs                                          | Needs                                  |
| --------------------------------------------------- | --------------------------------------------- | -------------------------------------- |
| Unit tests (`src/__tests__/*.test.ts`)              | always                                        | nothing; DB and RPC are faked          |
| Postgres tests (`indexer.db.test.ts`)               | when `TEST_DATABASE_URL` is set; always in CI | a throwaway database (it is wiped)     |
| Testnet integration (`testnet.integration.test.ts`) | when `TESTNET_INTEGRATION=1`; nightly in CI   | `TEST_DATABASE_URL` and network access |

Run the Postgres tests locally against the compose database's server, using a separate
database:

```bash
docker compose exec postgres createdb -U folder folder_test
TEST_DATABASE_URL=postgresql://folder:folder@localhost:5432/folder_test npm test
```

Run the live testnet test:

```bash
TEST_DATABASE_URL=postgresql://folder:folder@localhost:5432/folder_test npm run test:integration
```

Without `SMOKE_*` variables it checks the smoke run recorded at deployment, which only works
while the RPC still retains those ledgers (about 7 days after a smoke run). The nightly
workflow ([`.github/workflows/nightly-testnet.yml`](.github/workflows/nightly-testnet.yml))
runs Indexer-Contract's `scripts/smoke-testnet.sh` first and passes `SMOKE_START_LEDGER`,
`SMOKE_OWNER` and `SMOKE_FOLDER`.

Event fixtures in `src/__tests__/fixtures/testnet-events.json` are real `getEvents` output
from the testnet contract. Prefer them, or `makeEvent()` in `eventFixtures.ts`, over
hand-written XDR.

What we expect from a change:

- Bug fixes come with a test that fails without the fix.
- Indexer changes that touch SQL get a case in `indexer.db.test.ts`.
- New endpoints validate their input with Zod (`src/validation/schemas.ts`) and are
  documented in [`docs/api.md`](docs/api.md) with request, response and error examples.
- New configuration goes in `src/config/env.ts`, `.env.example`,
  [`docs/configuration.md`](docs/configuration.md) and `env.test.ts`.

## Contract changes

The event format is owned by Indexer-Contract
([`docs/EVENTS.md`](https://github.com/D-Indexer/Indexer-Contract/blob/main/docs/EVENTS.md)).
When it changes, update `src/indexer/decode.ts`, `src/indexer/handlers.ts`,
`database/schema.sql`, the tests and the event table in
[`docs/architecture.md`](docs/architecture.md#events) in one PR.

## Pull requests

- Branch from `main`. Keep PRs focused; several small commits beat one large one.
- Use [Conventional Commit](https://www.conventionalcommits.org/) prefixes (`feat:`, `fix:`,
  `docs:`, `test:`, `chore:`, `ci:`).
- Describe what changed and how you tested it. Link the issue (`Closes #12`).
- Never commit `.env` or secrets.

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
