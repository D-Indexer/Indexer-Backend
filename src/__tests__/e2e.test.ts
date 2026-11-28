import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * End-to-end test against a local Stellar quickstart network.
 *
 * This suite is skipped unless the e2e environment is enabled. It is intended
 * to be run via `npm run test:e2e` (or the CI e2e job), which boots the
 * quickstart container, deploys the pinned Folder contract wasm and runs the
 * scripted scenario in `scripts/e2e/`.
 *
 * Enable locally with:
 *   E2E=1 npm run test:e2e
 */

const E2E_ENABLED = process.env.E2E === '1' || process.env.E2E === 'true';

const ROOT = path.resolve(__dirname, '..', '..');
const SCENARIO_SCRIPT = path.join(ROOT, 'scripts', 'e2e', 'run-scenario.ts');

interface FolderState {
  id: string;
  owner: string;
  template: string | null;
  minted: number;
  updatedAt: number | null;
}

interface ApiSnapshot {
  admins: string[];
  templates: string[];
  folders: FolderState[];
  pageSize: number;
  totalFolders: number;
}

interface ScenarioResult {
  snapshot: ApiSnapshot;
  pagedSnapshot: ApiSnapshot;
  expected: ApiSnapshot;
}

const describeE2E = E2E_ENABLED ? describe : describe.skip;

describeE2E('e2e: indexer read model against local quickstart network', () => {
  let result: ScenarioResult;

  beforeAll(() => {
    if (!existsSync(SCENARIO_SCRIPT)) {
      throw new Error(
        `e2e scenario script not found at ${SCENARIO_SCRIPT}. ` +
          'Run `npm run e2e:setup` to prepare the local network.',
      );
    }

    // The scenario script boots quickstart (if needed), deploys the pinned
    // contract wasm, drives the scripted scenario, runs the indexer against
    // the local RPC and prints the resulting API snapshot as JSON.
    const stdout = execFileSync(
      process.execPath,
      ['-r', 'ts-node/register', SCENARIO_SCRIPT],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          E2E: '1',
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
        timeout: 9 * 60 * 1000,
      },
    );

    result = JSON.parse(stdout) as ScenarioResult;
  }, 10 * 60 * 1000);

  it('reflects admin add/remove in the read model', () => {
    expect(result.snapshot.admins).toEqual(result.expected.admins);
  });

  it('reflects registered templates in the read model', () => {
    expect(result.snapshot.templates).toEqual(result.expected.templates);
  });

  it('reflects claimed folders, mint, update and set template', () => {
    expect(result.snapshot.folders).toEqual(result.expected.folders);
  });

  it('reports the expected total folder count', () => {
    expect(result.snapshot.totalFolders).toBe(result.expected.totalFolders);
  });

  it('returns the same state when paging across more than one page', () => {
    // The scenario creates more folders than a single page holds, forcing the
    // indexer to page through RPC results. The paged snapshot must match the
    // full snapshot exactly.
    expect(result.snapshot.totalFolders).toBeGreaterThan(result.snapshot.pageSize);
    expect(result.pagedSnapshot.folders).toEqual(result.snapshot.folders);
    expect(result.pagedSnapshot.totalFolders).toBe(result.snapshot.totalFolders);
  });
});