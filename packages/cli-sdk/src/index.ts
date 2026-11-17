/**
 * Agentrail for a CLI. It tells your own API which command an agent ran,
 * in which run and in which of the agent's sessions, in one header on the
 * CLI's requests, so a server SDK or the edge in front of your API can join
 * the agent's CLI calls into its journey. Nothing is sent anywhere else.
 */
export {
  ConfigurationError,
  instrumentCli,
  type CliAgent,
  type CliSdk,
  type CliSdkOptions,
} from './instrument.js';
export type { Environment } from './agents.js';
export type {
  CommanderCommand,
  CommanderProgram,
  OclifPrerun,
} from './commands.js';
export { LocalSessionError } from './session.js';
export { CLI_HEADER, type CliMode } from 'agentrail-core';
