/**
 * The Agentrail edge adapter, for a customer's site on Cloudflare Workers,
 * Vercel or anything else on the Fetch API: one event per request, sent to
 * the collector, with markers, a session and a trace of its own.
 */
export {
  IdentifyError,
  cloudflare,
  createEdge,
  vercel,
  type Edge,
  type EdgeAdapter,
  type EdgeOptions,
  type PlatformSignals,
  type Principal,
  type RequestHead,
} from './edge.js';
export { MARKER_PARAMETER, markLinks, type MarkedHosts } from './links.js';
