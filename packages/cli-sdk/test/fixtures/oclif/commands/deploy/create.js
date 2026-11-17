import { Args, Command, Flags } from '@oclif/core';

export default class Create extends Command {
  static aliases = ['dc'];
  static args = { name: Args.string() };
  static flags = { json: Flags.boolean() };

  async run() {
    await this.parse(Create);
    await fetch(`${globalThis.agentrailFixture.api}/v1/deployments`);
  }
}
