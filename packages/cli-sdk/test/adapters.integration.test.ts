import { fileURLToPath } from 'node:url';

import { run as runOclif } from '@oclif/core';
import { Command } from 'commander';
import yargs from 'yargs';
import yargs17 from 'yargs-17';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CliSdk } from '../src/index.js';

import {
  instrument,
  plainEnvironment,
  startApi,
  temporaryFolder,
  type Api,
} from './support/api.js';

/**
 * Each CLI has `deploy create <name>`, also typed as an alias, and calls its
 * API from the command. People type the name of a private project; the
 * header must name the command and nothing they typed.
 */
const TYPED = ['deploy', 'c', 'secret-project', 'extra-word', '--json'];

async function setUp(): Promise<{ api: Api; sdk: CliSdk }> {
  const api = await startApi();
  const sdk = instrument({
    name: 'acme',
    origins: [api.origin],
    env: plainEnvironment(temporaryFolder()),
  });
  return { api, sdk };
}

function expectDeployCreate(api: Api): void {
  expect(api.headers().map((header) => header?.command)).toEqual([
    'deploy create',
  ]);
  expect(JSON.stringify(api.requests)).not.toMatch(
    /secret-project|extra-word/u,
  );
}

declare global {
  var agentrailFixture: { oclif: CliSdk['oclif']; api: string } | undefined;
}

afterEach(() => {
  globalThis.agentrailFixture = undefined;
});

describe('the framework adapters', () => {
  // Fails if someone names the command from argv, or from the command an
  // alias found rather than its declared name: what people type would be
  // sent, and one command would show under two names.
  it('name commander’s command by its declared words', async () => {
    const { api, sdk } = await setUp();
    const program = sdk.commander(new Command('acme').exitOverride());
    program
      .command('deploy')
      .command('create')
      .alias('c')
      .argument('<name>')
      .argument('[more...]')
      .option('--json')
      .action(async () => {
        await fetch(`${api.origin}/v1/deployments`);
      });
    await program.parseAsync(TYPED, { from: 'user' });
    expectDeployCreate(api);
  });

  // Fails if someone reads yargs' argv._ (it holds the extra words) or
  // yargs moves the context the adapter reads, in either major version.
  it.each([
    ['yargs 18', yargs],
    ['yargs 17', yargs17],
  ])('name %s’s command by its declared words', async (_label, make) => {
    const { api, sdk } = await setUp();
    await make(TYPED)
      .middleware(sdk.yargs)
      .command('deploy', 'Deploys.', (deploy) =>
        deploy.command(
          ['create <name>', 'c'],
          'Creates a deployment.',
          (create) => create.positional('name', { type: 'string' }),
          async () => {
            await fetch(`${api.origin}/v1/deployments`);
          },
        ),
      )
      .strict(false)
      .parseAsync();
    expectDeployCreate(api);
  });

  // Fails if someone takes oclif's command from what was typed (`dc`) or
  // from the topic separator the CLI chose, rather than the command's id.
  it('name oclif’s command by its id', async () => {
    const { api, sdk } = await setUp();
    globalThis.agentrailFixture = { oclif: sdk.oclif, api: api.origin };
    await runOclif(
      ['dc', 'secret-project', '--json'],
      fileURLToPath(new URL('fixtures/oclif/', import.meta.url)),
    );
    expectDeployCreate(api);
  });

  // Fails if someone works the header out once for the run: a request made
  // before the CLI parsed its arguments would fix it with no command.
  it('name no command before one runs', async () => {
    const { api, sdk } = await setUp();
    await fetch(`${api.origin}/v1/version`);
    sdk.command('deploy create');
    await fetch(`${api.origin}/v1/deployments`);
    expect(api.headers().map((header) => header?.command)).toEqual([
      undefined,
      'deploy create',
    ]);
  });

  // Fails if someone lets a yargs that moved its internals go unnoticed:
  // every request would lose its command, and no one would be told.
  it('tell onError once when yargs no longer says which command ran', () => {
    const report = vi.fn<(error: Error) => void>();
    const sdk = instrument({
      name: 'acme',
      origins: ['https://api.acme.com'],
      env: {},
      onError: report,
    });
    const moved = { getInternalMethods: () => ({}) };
    sdk.yargs({}, moved);
    sdk.yargs({}, moved);
    expect(report).toHaveBeenCalledTimes(1);
  });
});
