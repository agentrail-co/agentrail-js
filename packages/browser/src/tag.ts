import { start, type Agentrail, type BrowserOptions } from './index.js';

/**
 * The script tag a site pastes, served as one file (`agentrail.js`):
 *
 *     <script async src="https://<collector>/agentrail.js" data-key="ajp_…"></script>
 *
 * It reads its options from its own tag and starts once. The collector is
 * the origin the script came from unless `data-collector` names another;
 * `data-first-party` lists the other origins whose calls carry the trace,
 * comma-separated; `data-behaviour="off"` and `data-fingerprint="off"` turn
 * those parts off; `data-session-idle` (seconds) and `data-session-domain`
 * are the session's idle timeout and the domain it is shared across.
 */

/** The script's tag names no key: the snippet was pasted without it. */
export class BrowserTagKeyMissingError extends Error {
  override readonly name = 'BrowserTagKeyMissingError';
}

const listOf = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');

/** The options a script tag gives. */
export function optionsOf(
  tag: HTMLScriptElement,
): Omit<BrowserOptions, 'onError' | 'window'> {
  const { dataset } = tag;
  const key = dataset.key?.trim();
  if (key === undefined || key === '')
    throw new BrowserTagKeyMissingError(
      "Agentrail's script tag has no data-key. Copy the snippet again from Journeys, setup, with the browser source's key in it.",
    );
  const queryAllowlist = listOf(dataset.queryAllowlist);
  const { sessionIdle, sessionDomain } = dataset;
  return {
    key,
    collector:
      dataset.collector ?? new URL('/ingest/browser', tag.src).toString(),
    firstParty: listOf(dataset.firstParty),
    ...(queryAllowlist.length > 0 ? { queryAllowlist } : {}),
    // Read as written: `start` refuses one that is not whole seconds.
    ...(sessionIdle === undefined
      ? {}
      : { sessionIdleTimeout: Number(sessionIdle) }),
    ...(sessionDomain === undefined
      ? {}
      : { sessionCookieDomain: sessionDomain }),
    behaviour: dataset.behaviour !== 'off',
    fingerprint: dataset.fingerprint !== 'off',
  };
}

/** Starts the script from its tag; what fails is told on the page's console. */
export function startFromTag(tag: HTMLScriptElement): Agentrail {
  return start(optionsOf(tag));
}
