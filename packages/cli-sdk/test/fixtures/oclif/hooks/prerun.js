// The CLI's prerun hook: `export default agentrail.oclif` in a real CLI. The
// test hands this one the SDK it made, as a real CLI imports its own.
export default function prerun(options) {
  return globalThis.agentrailFixture.oclif(options);
}
