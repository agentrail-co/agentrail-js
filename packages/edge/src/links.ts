import { MAX_LINK_INDEX, linkMarker, newMarker } from '@agentrail/core';

/**
 * Markers in an agent-facing answer: every link to the site's own hosts gets
 * its own lane of one response marker, so an agent that follows a link, or k
 * sub-agents that follow k links, carry back which link of which answer they
 * read (docs/research/agent-journey-correlation.md, 5.2 and 15.1).
 *
 * A host's links carry their lane in the `h` query parameter, or as a
 * `/h/<marker>` path prefix for an API whose calls an extra parameter would
 * break. The edge takes either off again before the origin sees the request.
 * Past the last lane a link goes unmarked.
 */

export const MARKER_PARAMETER = 'h';

/** How a host's links carry their lane. */
export type MarkedHosts = Readonly<Record<string, 'query' | 'path'>>;

/** An absolute link, or a Markdown link's target, in an answer's text. */
const LINK =
  /(?<absolute>https?:\/\/[^\s<>()"'`\]]+)|\]\((?<target>[^)\s]+)(?=[)\s])/gu;

/** Punctuation that ends a sentence, not a bare link. */
const TRAILING = /[.,;:!?]+$/u;

export interface Marked {
  readonly body: string;
  /** The response marker, when any link was marked. */
  readonly served: string | null;
  /** Each address named, marked, as a request for it is recorded. */
  readonly linksOut: string[];
}

/**
 * The answer with its links to the site's hosts marked. `recorded` gives a
 * marked link's address in the form a request for it is recorded in, so the
 * engine can match the two.
 */
export function markLinks(
  body: string,
  base: URL,
  hosts: MarkedHosts,
  recorded: (url: URL) => string,
): Marked {
  const marker = newMarker();
  const lanes = new Map<string, string | null>();
  const linksOut: string[] = [];

  function marked(link: URL): string | null {
    const mode = hosts[link.hostname.toLowerCase()];
    if (mode === undefined) return null;
    const address = `${link.host}${link.pathname}${link.search}`;
    const known = lanes.get(address);
    if (known !== undefined) return known;
    if (lanes.size > MAX_LINK_INDEX) {
      lanes.set(address, null);
      return null;
    }
    const lane = linkMarker(marker, lanes.size);
    const target = new URL(link);
    if (mode === 'query') target.searchParams.set(MARKER_PARAMETER, lane);
    else
      target.pathname = `/h/${lane}${target.pathname === '/' ? '' : target.pathname}`;
    const written = target.href;
    lanes.set(address, written);
    linksOut.push(recorded(target));
    return written;
  }

  const rewritten = body.replace(
    LINK,
    (match, absolute: string | undefined, target: string | undefined) => {
      // A sentence's full stop or comma after a bare link is not part of it.
      const trailing =
        absolute === undefined ? '' : (TRAILING.exec(absolute)?.[0] ?? '');
      const raw =
        absolute?.slice(0, absolute.length - trailing.length) ?? target;
      // A link within the page is not a step to another.
      if (raw === undefined || raw.startsWith('#')) return match;
      let link: URL;
      try {
        link = new URL(raw, base);
      } catch (error) {
        // Text that only looks like a link stays as it is.
        if (error instanceof TypeError) return match;
        throw error;
      }
      const written = marked(link);
      if (written === null) return match;
      return absolute === undefined ? `](${written}` : `${written}${trailing}`;
    },
  );
  return {
    body: rewritten,
    served: linksOut.length === 0 ? null : marker,
    linksOut,
  };
}
