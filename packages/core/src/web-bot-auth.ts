import type { SignatureOutcome } from './event.js';
import {
  StructuredFieldError,
  parseDictionary,
  parseItem,
  serializeInnerList,
  serializeItem,
  type InnerList,
  type Item,
  type Member,
} from './structured-fields.js';

/**
 * Web Bot Auth (draft-ietf-webbotauth-httpsig-protocol): an agent signs its
 * requests with HTTP Message Signatures (RFC 9421) and names, in
 * `Signature-Agent`, the HTTPS URL it publishes its keys at. A verified
 * signature says who operates the agent; an unverified one is a claim. This
 * checks a request's signature against that directory and reports the
 * outcome with its reason, so a directory that is down is never read as a
 * forged signature (docs/research/agent-journey-correlation.md, 12.3).
 *
 * What it reads: the dictionary form of `Signature-Agent` (`sig="https://…"`)
 * and the bare string signers sent before it; a signature tagged
 * `web-bot-auth` covering `@authority` or `@target-uri` and the agent header;
 * Ed25519, RSA-PSS-SHA512 and ECDSA-P256 keys, matched by the JWK thumbprint
 * the draft makes the key id. Anything else it does not read is reported as
 * unsupported, never as invalid.
 */

/** What a check here ends as: every outcome but `unchecked`, which is a component that did not check. */
export const SIGNATURE_CHECK_OUTCOMES = [
  /** The signature checks against a key the agent's directory publishes. */
  'verified',
  /** It does not: a forged or stale signature, or a key the directory does not hold. */
  'invalid',
  /** The directory could not be read, so nothing is known either way. */
  'directory_unreachable',
  /** The signature uses a component, algorithm or key this verifier does not read. */
  'unsupported',
] as const satisfies readonly Exclude<SignatureOutcome, 'unchecked'>[];
export type SignatureCheckOutcome = (typeof SIGNATURE_CHECK_OUTCOMES)[number];

/** A request's signed agent: who it says it is, and whether that checked. */
export interface SignedAgent {
  /** The URL the agent names itself by, where its keys are published. */
  readonly agent: string;
  /** The key id the signature names; null when the headers did not parse that far. */
  readonly keyId: string | null;
  readonly outcome: SignatureCheckOutcome;
}

/** What of a request the signature covers: its method, URL and headers. */
export interface SignedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
}

export interface SignatureVerifierOptions {
  /** The fetch directories are read with; the platform's own by default. */
  readonly fetch?: typeof fetch;
  /** The clock, milliseconds since the epoch; `Date.now` by default. */
  readonly now?: () => number;
}

export type SignatureVerifier = (
  request: SignedRequest,
) => Promise<SignedAgent | null>;

/** Where an agent publishes its keys, under the URL it names. */
const DIRECTORY_PATH = '/.well-known/http-message-signatures-directory';
const DIRECTORY_MEDIA_TYPE =
  'application/http-message-signatures-directory+json';
/** How long a directory read may take: a signed request's answer is already sent. */
const DIRECTORY_TIMEOUT_MS = 5_000;
/** How long a directory is kept when it names no `max-age`, and the most it is kept. */
const DIRECTORY_DEFAULT_TTL_MS = 60 * 60 * 1_000;
const DIRECTORY_MAX_TTL_MS = 24 * 60 * 60 * 1_000;
/** How long a directory that could not be read is not asked again, so a down signer is not fetched on every request. */
const DIRECTORY_RETRY_MS = 60 * 1_000;
/** How far in the future a signature's `created` may be, for clocks that disagree. */
const CREATED_SKEW_MS = 5 * 60 * 1_000;
/** The tag the draft gives these signatures. */
const TAG = 'web-bot-auth';
/** The longest agent URL and key id the collector takes; a claim is cut to them. */
const AGENT_LENGTH = 256;
const KEY_ID_LENGTH = 256;
/** The most directories kept at once, and the most failures remembered: a caller names the hosts, so neither may grow without bound. */
const MAX_DIRECTORIES = 256;
const MAX_FAILURES = 1_024;

interface Jwk {
  readonly kty: string;
  readonly crv?: string;
  readonly x?: string;
  readonly y?: string;
  readonly n?: string;
  readonly e?: string;
  readonly kid?: string;
}

type Algorithm = 'ed25519' | 'rsa-pss-sha512' | 'ecdsa-p256-sha256';

const encoder = new TextEncoder();

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...view))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

/** A public key this verifier reads: its algorithm, and its required members alone, in thumbprint order. */
interface PublicKey {
  readonly algorithm: Algorithm;
  readonly jwk: JsonWebKey;
}

/** The key's algorithm and members, from what kind of key it is; null for a kind this verifier does not read, or a key missing a member. */
function publicKeyOf(key: Jwk): PublicKey | null {
  if (key.kty === 'OKP' && key.crv === 'Ed25519' && key.x !== undefined)
    return {
      algorithm: 'ed25519',
      jwk: { crv: 'Ed25519', kty: 'OKP', x: key.x },
    };
  if (key.kty === 'RSA' && key.e !== undefined && key.n !== undefined)
    return {
      algorithm: 'rsa-pss-sha512',
      jwk: { e: key.e, kty: 'RSA', n: key.n },
    };
  if (
    key.kty === 'EC' &&
    key.crv === 'P-256' &&
    key.x !== undefined &&
    key.y !== undefined
  )
    return {
      algorithm: 'ecdsa-p256-sha256',
      jwk: { crv: 'P-256', kty: 'EC', x: key.x, y: key.y },
    };
  return null;
}

/**
 * The JWK thumbprint (RFC 7638; RFC 8037 for Ed25519) the draft makes a
 * signature's `keyid`: the SHA-256 of the key's required members in
 * lexicographic order, base64url. Null for a key this verifier does not read.
 */
export async function keyThumbprint(key: Jwk): Promise<string | null> {
  const read = publicKeyOf(key);
  if (read === null) return null;
  return base64url(
    await crypto.subtle.digest(
      'SHA-256',
      encoder.encode(JSON.stringify(read.jwk)),
    ),
  );
}

function importKey(key: PublicKey): Promise<CryptoKey> {
  switch (key.algorithm) {
    case 'ed25519':
      return crypto.subtle.importKey(
        'jwk',
        key.jwk,
        { name: 'Ed25519' },
        false,
        ['verify'],
      );
    case 'rsa-pss-sha512':
      return crypto.subtle.importKey(
        'jwk',
        key.jwk,
        { name: 'RSA-PSS', hash: 'SHA-512' },
        false,
        ['verify'],
      );
    case 'ecdsa-p256-sha256':
      return crypto.subtle.importKey(
        'jwk',
        key.jwk,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      );
  }
}

function verifyParameters(
  algorithm: Algorithm,
): AlgorithmIdentifier | RsaPssParams | EcdsaParams {
  switch (algorithm) {
    case 'ed25519':
      return { name: 'Ed25519' };
    case 'rsa-pss-sha512':
      return { name: 'RSA-PSS', saltLength: 64 };
    case 'ecdsa-p256-sha256':
      return { name: 'ECDSA', hash: 'SHA-256' };
  }
}

/** An agent URL a header names, and whether this verifier will read a directory from it. */
interface NamedAgent {
  readonly url: string;
  readonly readable: boolean;
}

/**
 * The agent URLs a `Signature-Agent` header names, by dictionary label (the
 * bare form has none): every HTTPS URL it names, each marked whether its
 * directory may be read, so a claim is always recorded against the agent
 * the signature named, readable or not.
 */
function agentsOf(header: string): Map<string | null, NamedAgent> {
  const agents = new Map<string | null, NamedAgent>();
  let members: Map<string, Member>;
  try {
    members = parseDictionary(header);
  } catch (error) {
    if (!(error instanceof StructuredFieldError)) throw error;
    members = new Map();
  }
  for (const [label, member] of members) {
    if (member.kind !== 'item' || member.value.kind !== 'string') continue;
    const type = member.parameters.get('type');
    // A directory is the one type this reads; the draft says to ignore others.
    if (
      type !== undefined &&
      !(type.kind === 'token' && type.value === 'directory')
    )
      continue;
    if (isHttpsUrl(member.value.value))
      agents.set(label, {
        url: member.value.value,
        readable: isAgentUrl(member.value.value),
      });
  }
  if (agents.size === 0) {
    // The bare string signers sent before the dictionary form.
    try {
      const item = parseItem(header);
      if (item.value.kind === 'string' && isHttpsUrl(item.value.value))
        agents.set(null, {
          url: item.value.value,
          readable: isAgentUrl(item.value.value),
        });
    } catch (error) {
      if (!(error instanceof StructuredFieldError)) throw error;
    }
  }
  return agents;
}

function isHttpsUrl(value: string): boolean {
  const url = URL.parse(value);
  return url !== null && url.protocol === 'https:';
}

/** A hostname that is an address rather than a name, or a name that is never public. */
const ADDRESS_OR_PRIVATE_HOST =
  /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[.*\]|localhost|.*\.(?:localhost|local|internal|arpa))$/iu;

/**
 * A URL this verifier will read a directory from: HTTPS, on its default
 * port, with no credentials, at a public name. The caller chooses the
 * URL, so an address, a private name or an odd port is never contacted
 * from the edge that runs this.
 */
function isAgentUrl(value: string): boolean {
  const url = URL.parse(value);
  return (
    url !== null &&
    url.protocol === 'https:' &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    url.hostname.includes('.') &&
    !ADDRESS_OR_PRIVATE_HOST.test(url.hostname)
  );
}

interface SignatureParameters {
  readonly keyId: string;
  readonly created: number;
  readonly expires: number;
  readonly alg: string | null;
}

/** The parameters the draft requires on the signature, or null where one is missing or mistyped. */
function parametersOf(list: InnerList): SignatureParameters | null {
  const keyId = list.parameters.get('keyid');
  const created = list.parameters.get('created');
  const expires = list.parameters.get('expires');
  const alg = list.parameters.get('alg');
  if (
    keyId?.kind !== 'string' ||
    created?.kind !== 'integer' ||
    expires?.kind !== 'integer' ||
    (alg !== undefined && alg.kind !== 'string')
  )
    return null;
  return {
    keyId: keyId.value,
    created: created.value,
    expires: expires.value,
    alg: alg === undefined ? null : alg.value,
  };
}

type ComponentValue =
  | { readonly kind: 'value'; readonly value: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unsupported' };

/**
 * A covered component's value, as RFC 9421 derives it from the request: the
 * derived components an agent signs, and a header, whole or one member of
 * it. A component this does not derive is unsupported, never guessed.
 */
function componentValue(
  component: Item,
  request: SignedRequest,
  url: URL,
): ComponentValue {
  if (component.value.kind !== 'string') return { kind: 'unsupported' };
  const name = component.value.value;
  const parameters = component.parameters;
  if (name.startsWith('@')) {
    if (parameters.size > 0) return { kind: 'unsupported' };
    switch (name) {
      case '@method':
        // As sent: a method's name is case-sensitive.
        return { kind: 'value', value: request.method };
      case '@target-uri':
        return { kind: 'value', value: url.href };
      case '@authority':
        return { kind: 'value', value: url.host.toLowerCase() };
      case '@scheme':
        return { kind: 'value', value: url.protocol.slice(0, -1) };
      case '@path':
        return { kind: 'value', value: url.pathname };
      case '@query':
        return { kind: 'value', value: url.search === '' ? '?' : url.search };
      default:
        return { kind: 'unsupported' };
    }
  }
  const held = request.headers.get(name.toLowerCase());
  if (held === null) return { kind: 'missing' };
  const key = parameters.get('key');
  for (const flag of parameters.keys())
    if (flag !== 'key') return { kind: 'unsupported' };
  if (key === undefined) return { kind: 'value', value: held.trim() };
  if (key.kind !== 'string') return { kind: 'unsupported' };
  let members: Map<string, Member>;
  try {
    members = parseDictionary(held);
  } catch (error) {
    if (!(error instanceof StructuredFieldError)) throw error;
    return { kind: 'missing' };
  }
  const member = members.get(key.value);
  if (member === undefined) return { kind: 'missing' };
  return {
    kind: 'value',
    value:
      member.kind === 'item'
        ? serializeItem(member)
        : serializeInnerList(member),
  };
}

/** The signature base (RFC 9421, 2.5): each covered component's line, then the parameters. */
function signatureBase(
  list: InnerList,
  request: SignedRequest,
  url: URL,
):
  | { readonly kind: 'base'; readonly text: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unsupported' } {
  const lines: string[] = [];
  for (const component of list.items) {
    const value = componentValue(component, request, url);
    if (value.kind !== 'value') return { kind: value.kind };
    lines.push(`${serializeItem(component)}: ${value.value}`);
  }
  lines.push(`"@signature-params": ${serializeInnerList(list)}`);
  return { kind: 'base', text: lines.join('\n') };
}

interface Directory {
  readonly keys: readonly Jwk[];
}

type DirectoryRead =
  | { readonly kind: 'read'; readonly directory: Directory }
  | { readonly kind: 'unreachable' };

function isJwk(value: unknown): value is Jwk {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kty' in value &&
    typeof value.kty === 'string'
  );
}

/** The seconds a `Cache-Control` lets a directory be kept, or null when it says none. */
function maxAgeOf(cacheControl: string | null): number | null {
  const match = /(?:^|,)\s*max-age=(\d+)/iu.exec(cacheControl ?? '');
  return match?.[1] === undefined ? null : Number(match[1]);
}

/**
 * The directories read so far, kept until their `max-age` passes; one read
 * at a time per directory, shared by the requests waiting on it; a
 * directory that could not be read is not asked again for a minute, and an
 * earlier copy of it stays, since an outage is not evidence.
 */
class Directories {
  private readonly held = new Map<
    string,
    { directory: Directory; until: number }
  >();
  private readonly reading = new Map<string, Promise<DirectoryRead>>();
  private readonly failedAt = new Map<string, number>();

  constructor(
    private readonly fetcher: typeof fetch,
    private readonly now: () => number,
  ) {}

  async read(agent: string): Promise<DirectoryRead> {
    const address = new URL(DIRECTORY_PATH, agent).href;
    const now = this.now();
    const kept = this.held.get(address);
    if (kept !== undefined && kept.until > now)
      return { kind: 'read', directory: kept.directory };
    const failed = this.failedAt.get(address);
    if (failed !== undefined && now - failed < DIRECTORY_RETRY_MS)
      return kept === undefined
        ? { kind: 'unreachable' }
        : { kind: 'read', directory: kept.directory };
    const underWay = this.reading.get(address);
    if (underWay !== undefined) return underWay;
    const reading = (async () => {
      try {
        const read = await this.fetchDirectory(address);
        if (read.kind === 'read') this.failedAt.delete(address);
        else {
          this.remember(this.failedAt, address, this.now(), MAX_FAILURES);
          if (kept !== undefined)
            return { kind: 'read' as const, directory: kept.directory };
        }
        return read;
      } finally {
        // Whatever became of it, the next check reads again.
        this.reading.delete(address);
      }
    })();
    this.reading.set(address, reading);
    return reading;
  }

  /** Keeps a value, and forgets the oldest once more than `most` are kept. */
  private remember<Value>(
    kept: Map<string, Value>,
    address: string,
    value: Value,
    most: number,
  ): void {
    kept.delete(address);
    kept.set(address, value);
    for (const oldest of kept.keys()) {
      if (kept.size <= most) break;
      kept.delete(oldest);
    }
  }

  private async fetchDirectory(address: string): Promise<DirectoryRead> {
    let body: unknown;
    let cacheControl: string | null;
    try {
      const response = await this.fetcher(address, {
        headers: { accept: DIRECTORY_MEDIA_TYPE },
        // The draft forbids following a redirect to a directory.
        redirect: 'manual',
        signal: AbortSignal.timeout(DIRECTORY_TIMEOUT_MS),
      });
      if (response.status !== 200) return { kind: 'unreachable' };
      cacheControl = response.headers.get('cache-control');
      body = await response.json();
    } catch (error) {
      // The network, TLS, the deadline (on the headers or the body) or a
      // body that is not JSON: the directory is unreachable, which is what
      // the caller is told; the reason is not evidence either.
      if (
        error instanceof DOMException ||
        error instanceof TypeError ||
        error instanceof SyntaxError
      )
        return { kind: 'unreachable' };
      throw error;
    }
    if (
      typeof body !== 'object' ||
      body === null ||
      !('keys' in body) ||
      !Array.isArray(body.keys)
    )
      return { kind: 'unreachable' };
    const directory: Directory = { keys: body.keys.filter(isJwk) };
    const maxAge = maxAgeOf(cacheControl);
    const ttl =
      maxAge === null
        ? DIRECTORY_DEFAULT_TTL_MS
        : Math.min(maxAge * 1_000, DIRECTORY_MAX_TTL_MS);
    this.remember(
      this.held,
      address,
      { directory, until: this.now() + ttl },
      MAX_DIRECTORIES,
    );
    return { kind: 'read', directory };
  }
}

/** The key in a directory a signature names, by the thumbprint the draft requires or the `kid` the key carries. */
async function keyNamed(
  directory: Directory,
  keyId: string,
): Promise<Jwk | null> {
  for (const key of directory.keys) {
    if (key.kid === keyId) return key;
    if ((await keyThumbprint(key)) === keyId) return key;
  }
  return null;
}

/**
 * A verifier of requests' Web Bot Auth signatures. One per runtime: it keeps
 * the directories it has read, so a signer's keys are fetched once per
 * `max-age`, not once per request.
 */
export function createSignatureVerifier(
  options: SignatureVerifierOptions = {},
): SignatureVerifier {
  const now = options.now ?? Date.now;
  const directories = new Directories(options.fetch ?? fetch, now);

  return async (request) => {
    const agentHeader = request.headers.get('signature-agent');
    if (agentHeader === null) return null;
    const agents = agentsOf(agentHeader);
    const first = agents.values().next();
    const named = first.done ? agentHeader.trim() : first.value.url;
    // An empty header names no one: no claim was made.
    if (named === '') return null;
    // Cut to what the collector takes, so a claim never refuses the call
    // that carries it; the check itself read the values whole.
    const claim = (
      outcome: SignatureCheckOutcome,
      keyId: string | null = null,
      agent = named,
    ): SignedAgent => ({
      agent: agent.slice(0, AGENT_LENGTH),
      keyId: keyId?.slice(0, KEY_ID_LENGTH) ?? null,
      outcome,
    });
    // A header naming no HTTPS URL at all is a claim of nothing checkable.
    if (first.done) return claim('invalid');

    const inputHeader = request.headers.get('signature-input');
    const signatureHeader = request.headers.get('signature');
    if (inputHeader === null || signatureHeader === null)
      return claim('invalid');
    let inputs: Map<string, Member>;
    let signatures: Map<string, Member>;
    try {
      inputs = parseDictionary(inputHeader);
      signatures = parseDictionary(signatureHeader);
    } catch (error) {
      if (!(error instanceof StructuredFieldError)) throw error;
      return claim('invalid');
    }
    const signed = [...inputs].flatMap(([name, member]) => {
      const tag = member.parameters.get('tag');
      return member.kind === 'inner-list' &&
        tag?.kind === 'string' &&
        tag.value === TAG
        ? [[name, member] as const]
        : [];
    })[0];
    if (signed === undefined) return claim('invalid');
    const [label, list] = signed;
    const parameters = parametersOf(list);
    if (parameters === null) return claim('invalid');
    const { keyId } = parameters;

    const agentComponent = list.items.find(
      (item) =>
        item.value.kind === 'string' && item.value.value === 'signature-agent',
    );
    const coversTarget = list.items.some(
      (item) =>
        item.value.kind === 'string' &&
        (item.value.value === '@authority' ||
          item.value.value === '@target-uri'),
    );
    if (agentComponent === undefined || !coversTarget)
      return claim('invalid', keyId);
    const memberKey = agentComponent.parameters.get('key');
    const signedAgent =
      memberKey === undefined
        ? first.value
        : memberKey.kind === 'string'
          ? agents.get(memberKey.value)
          : undefined;
    if (signedAgent === undefined) return claim('invalid', keyId);
    const agent = signedAgent.url;
    // A URL this verifier will not read a directory from (an address, a
    // private name, a port, credentials) is a claim it cannot check, never
    // one it found false, and never one it checks against another member.
    if (!signedAgent.readable) return claim('unsupported', keyId, agent);

    const moment = now();
    if (parameters.created * 1_000 > moment + CREATED_SKEW_MS)
      return claim('invalid', keyId, agent);
    if (parameters.expires * 1_000 <= moment)
      return claim('invalid', keyId, agent);

    const signature = signatures.get(label);
    if (signature?.kind !== 'item' || signature.value.kind !== 'bytes')
      return claim('invalid', keyId, agent);
    const url = URL.parse(request.url);
    if (url === null) return claim('invalid', keyId, agent);
    const base = signatureBase(list, request, url);
    if (base.kind === 'unsupported') return claim('unsupported', keyId, agent);
    if (base.kind === 'missing') return claim('invalid', keyId, agent);

    const read = await directories.read(agent);
    if (read.kind === 'unreachable')
      return claim('directory_unreachable', keyId, agent);
    const key = await keyNamed(read.directory, keyId);
    if (key === null) return claim('invalid', keyId, agent);
    const publicKey = publicKeyOf(key);
    if (publicKey === null) return claim('unsupported', keyId, agent);
    if (parameters.alg !== null && parameters.alg !== publicKey.algorithm)
      return claim('invalid', keyId, agent);
    let imported: CryptoKey;
    try {
      imported = await importKey(publicKey);
    } catch (error) {
      // A key the directory published that WebCrypto cannot read is the
      // signer's defect, not a forgery.
      if (error instanceof DOMException || error instanceof TypeError)
        return claim('unsupported', keyId, agent);
      throw error;
    }
    const checks = await crypto.subtle.verify(
      verifyParameters(publicKey.algorithm),
      imported,
      signature.value.value,
      encoder.encode(base.text),
    );
    return claim(checks ? 'verified' : 'invalid', keyId, agent);
  };
}
