import type { LoggerOptions } from 'pino';
import type { AgentrailNode } from './client.js';

type Hooks = NonNullable<LoggerOptions['hooks']>;
/** Compose into pino({ hooks: pino(client, existingHooks) }). Captures synchronously in the caller's context. */
export function pino(client: AgentrailNode, existing: Hooks = {}): Hooks {
  return {
    ...existing,
    logMethod(args, method, level) {
      if (existing.logMethod === undefined) method.apply(this, args);
      else existing.logMethod.call(this, args, method, level);
      const first: unknown = args[0];
      const fields: Record<string, unknown> =
        typeof first === 'object' && first !== null ? { ...first } : {};
      if (typeof first === 'string') fields.msg = first;
      else if (typeof args[1] === 'string') fields.msg = args[1];
      const error: unknown = first instanceof Error ? first : fields.err;
      const severityNumber =
        level >= 60
          ? 21
          : level >= 50
            ? 17
            : level >= 40
              ? 13
              : level >= 30
                ? 9
                : level >= 20
                  ? 5
                  : 1;
      client.log({
        severityNumber,
        fields,
        ...(error instanceof Error ? { errorType: error.name } : {}),
      });
    },
  };
}
