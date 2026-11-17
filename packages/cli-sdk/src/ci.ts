import type { Environment } from './agents.js';

/**
 * Which CI service, if any, is running the CLI, and the run it is part of:
 * every command one CI run starts is one session. A bare `CI` is not
 * enough: Cursor has set `CI=1` in its agent's shells, and people set it by
 * hand to quiet a tool.
 */

export interface Ci {
  readonly id: string;
  /** The variable that named the service. */
  readonly evidence: string;
  /** The run, from the variables that name it uniquely; undefined when one is missing. */
  readonly run?: string | undefined;
}

interface Service {
  readonly id: string;
  /** The variable that names the service, and the value it holds there (any, when absent). */
  readonly marker: string;
  readonly value?: string;
  /** Together, they name one run of one pipeline on one server. */
  readonly run: readonly string[];
}

const SERVICES: readonly Service[] = [
  {
    id: 'github-actions',
    marker: 'GITHUB_ACTIONS',
    value: 'true',
    run: [
      'GITHUB_SERVER_URL',
      'GITHUB_REPOSITORY',
      'GITHUB_RUN_ID',
      'GITHUB_RUN_ATTEMPT',
    ],
  },
  {
    id: 'gitlab',
    marker: 'GITLAB_CI',
    value: 'true',
    run: ['CI_SERVER_HOST', 'CI_PIPELINE_ID'],
  },
  {
    id: 'circleci',
    marker: 'CIRCLECI',
    value: 'true',
    run: ['CIRCLE_WORKFLOW_ID'],
  },
  {
    id: 'buildkite',
    marker: 'BUILDKITE',
    value: 'true',
    run: ['BUILDKITE_BUILD_ID'],
  },
  {
    id: 'azure-pipelines',
    marker: 'TF_BUILD',
    value: 'true',
    run: ['SYSTEM_COLLECTIONID', 'BUILD_BUILDID'],
  },
  {
    id: 'bitbucket',
    marker: 'BITBUCKET_BUILD_NUMBER',
    run: ['BITBUCKET_PIPELINE_UUID'],
  },
  { id: 'jenkins', marker: 'JENKINS_URL', run: ['JENKINS_URL', 'BUILD_TAG'] },
  {
    id: 'codebuild',
    marker: 'CODEBUILD_BUILD_ID',
    run: ['CODEBUILD_BUILD_ID'],
  },
  { id: 'travis', marker: 'TRAVIS', value: 'true', run: ['TRAVIS_BUILD_ID'] },
];

function valueOf(env: Environment, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/** The CI service running this process, or null when none is named. */
export function detectCi(env: Environment): Ci | null {
  for (const service of SERVICES) {
    const marker = valueOf(env, service.marker);
    if (
      marker === undefined ||
      (service.value !== undefined && marker.toLowerCase() !== service.value)
    )
      continue;
    const parts = service.run.map((name) => valueOf(env, name));
    return {
      id: service.id,
      evidence: service.marker,
      run: parts.every((part) => part !== undefined)
        ? `${service.id}:${parts.join('/')}`
        : undefined,
    };
  }
  return null;
}
