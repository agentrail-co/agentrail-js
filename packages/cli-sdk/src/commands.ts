/**
 * The command a run is running, as the CLI framework declared its words:
 * `deploy create`, never `deploy c` (an alias) or what followed it on the
 * command line. Arguments, flag values and paths are what people type, so
 * they are never read: only the names the CLI's own code gave its commands.
 */

/** The most of a command the header carries. */
const MAX_COMMAND = 128;
/** A word the header can carry: printable ASCII, no spaces. */
const WORD = /^[\x21-\x7e]+$/u;

/** The command's words as one value, or undefined when there are none to send. */
export function commandOf(words: readonly string[]): string | undefined {
  let command = '';
  for (const word of words) {
    const kept = WORD.test(word) ? word : '?';
    const next = command === '' ? kept : `${command} ${kept}`;
    if (next.length > MAX_COMMAND) break;
    command = next;
  }
  return command === '' ? undefined : command;
}

/** A command in commander: the root program is the CLI itself, and has no parent. */
export interface CommanderCommand {
  name(): string;
  readonly parent: CommanderCommand | null;
}

export interface CommanderProgram {
  hook(
    event: 'preAction',
    listener: (
      thisCommand: CommanderCommand,
      actionCommand: CommanderCommand,
    ) => void,
  ): unknown;
}

/** `deploy create` for `acme deploy create`, by each command's declared name. */
export function commanderWords(command: CommanderCommand): string[] {
  const words: string[] = [];
  for (let current = command; current.parent !== null; current = current.parent)
    words.unshift(current.name());
  return words;
}

/**
 * yargs keeps the commands it matched, as they were declared
 * (`create <name>`), in its context. The context is internal to yargs (17
 * and 18 have it): null for a yargs without it, which names no command
 * rather than failing.
 */
export function yargsWords(instance: unknown): string[] | null {
  if (
    typeof instance !== 'object' ||
    instance === null ||
    !('getInternalMethods' in instance) ||
    typeof instance.getInternalMethods !== 'function'
  )
    return null;
  const internal = (instance.getInternalMethods as () => unknown)();
  if (
    typeof internal !== 'object' ||
    internal === null ||
    !('getContext' in internal) ||
    typeof internal.getContext !== 'function'
  )
    return null;
  const context = (internal.getContext as () => unknown)();
  if (
    typeof context !== 'object' ||
    context === null ||
    !('fullCommands' in context) ||
    !Array.isArray(context.fullCommands)
  )
    return null;
  return context.fullCommands
    .map((declared: unknown) =>
      typeof declared === 'string'
        ? (declared.trim().split(/\s+/u)[0] ?? '')
        : '',
    )
    .filter((word) => word !== '' && word !== '$0');
}

/** What oclif passes its `prerun` hook: the command's id, `deploy:create`, whatever the alias typed. */
export interface OclifPrerun {
  readonly Command: { readonly id: string };
}

export function oclifWords(options: OclifPrerun): string[] {
  return options.Command.id.split(':').filter((word) => word !== '');
}
