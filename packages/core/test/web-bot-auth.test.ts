import { describe, expect, it } from 'vitest';

import { createSignatureVerifier, keyThumbprint } from '../src/index.js';

/**
 * Web Bot Auth signatures, made here as a signer makes them: a key pair,
 * the signature base written out by hand from RFC 9421 (never by the code
 * under test), signed, and the directory the agent URL would serve.
 */

const AGENT = 'https://signer.example.test';
const DIRECTORY = `${AGENT}/.well-known/http-message-signatures-directory`;
const NOW = 1_762_000_000_000;
const CREATED = Math.floor(NOW / 1_000) - 10;
const EXPIRES = CREATED + 600;

const encoder = new TextEncoder();

function base64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

async function signer() {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ]);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  // RFC 8037, A.3: the thumbprint members of an Ed25519 key, in order.
  const thumbprint = base64urlOf(
    await crypto.subtle.digest(
      'SHA-256',
      encoder.encode(JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x: jwk.x })),
    ),
  );
  return { pair, jwk, thumbprint };
}

function base64urlOf(bytes: ArrayBuffer): string {
  return base64(bytes)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

type Signer = Awaited<ReturnType<typeof signer>>;

/**
 * A signed GET as an agent sends it, with the signature base of RFC 9421
 * written out: one line per covered component, then the parameters.
 */
async function signedRequest(
  by: Signer,
  input: {
    url?: string;
    agentHeader?: string;
    components?: string;
    componentLines?: (url: URL) => string[];
    created?: number;
    expires?: number;
    keyId?: string;
    tag?: string;
  } = {},
) {
  const url = new URL(
    input.url ?? `${AGENT.replace('signer', 'docs')}/guide.md`,
  );
  const agentHeader = input.agentHeader ?? `sig="${AGENT}"`;
  const components =
    input.components ?? '("@authority" "signature-agent";key="sig")';
  const params = `${components};created=${String(input.created ?? CREATED)};expires=${String(input.expires ?? EXPIRES)};keyid="${input.keyId ?? by.thumbprint}";tag="${input.tag ?? 'web-bot-auth'}"`;
  const lines = input.componentLines?.(url) ?? [
    `"@authority": ${url.host}`,
    `"signature-agent";key="sig": "${AGENT}"`,
  ];
  const base = [...lines, `"@signature-params": ${params}`].join('\n');
  const signature = await crypto.subtle.sign(
    'Ed25519',
    by.pair.privateKey,
    encoder.encode(base),
  );
  return {
    method: 'GET',
    url: url.href,
    headers: new Headers({
      'signature-agent': agentHeader,
      'signature-input': `sig=${params}`,
      signature: `sig=:${base64(signature)}:`,
    }),
  };
}

/** A verifier whose directory reads go to a stub, counted. */
function verifier(
  answer: () => Response | Promise<Response>,
  now: () => number = () => NOW,
) {
  const reads: string[] = [];
  const verify = createSignatureVerifier({
    now,
    fetch: (input, init) => {
      if (!(input instanceof URL) && typeof input !== 'string')
        throw new TypeError('the verifier fetches by address');
      reads.push(input instanceof URL ? input.href : input);
      expect(init?.redirect).toBe('manual');
      return Promise.resolve(answer());
    },
  });
  return { verify, reads };
}

function directoryOf(...keys: JsonWebKey[]): Response {
  return new Response(JSON.stringify({ keys }), {
    headers: {
      'content-type': 'application/http-message-signatures-directory+json',
      'cache-control': 'max-age=3600',
    },
  });
}

describe('Web Bot Auth', () => {
  // Fails if someone verifies the signature over something other than the
  // RFC 9421 base of the request as received (a request replayed against
  // another host would verify), takes a signature past its expiry, trusts
  // a key id the directory does not publish, or reads the directory again
  // for every request.
  it('verifies a signed request against the agent’s directory, once per directory, and refuses what does not check', async () => {
    const by = await signer();
    const { verify, reads } = verifier(() => directoryOf(by.jwk));

    const good = await signedRequest(by);
    expect(await verify(good)).toEqual({
      agent: AGENT,
      keyId: by.thumbprint,
      outcome: 'verified',
    });
    // The bare string signers sent before the dictionary form.
    const bare = await signedRequest(by, {
      agentHeader: `"${AGENT}"`,
      components: '("@authority" "signature-agent")',
      componentLines: (url) => [
        `"@authority": ${url.host}`,
        `"signature-agent": "${AGENT}"`,
      ],
    });
    expect(await verify(bare)).toMatchObject({ outcome: 'verified' });

    // The same signature, sent to another host.
    const replayed = {
      ...good,
      url: good.url.replace('docs.example.test', 'app.example.test'),
    };
    expect(await verify(replayed)).toMatchObject({
      agent: AGENT,
      outcome: 'invalid',
    });
    expect(
      await verify(await signedRequest(by, { expires: CREATED + 5 })),
    ).toMatchObject({ outcome: 'invalid' });
    expect(
      await verify(await signedRequest(by, { keyId: 'not-published' })),
    ).toMatchObject({ keyId: 'not-published', outcome: 'invalid' });
    expect(
      await verify(await signedRequest(by, { tag: 'something-else' })),
    ).toMatchObject({ outcome: 'invalid' });
    // A claim with nothing signed, and no claim at all.
    expect(
      await verify({
        method: 'GET',
        url: good.url,
        headers: new Headers({ 'signature-agent': `sig="${AGENT}"` }),
      }),
    ).toEqual({ agent: AGENT, keyId: null, outcome: 'invalid' });
    expect(
      await verify({ method: 'GET', url: good.url, headers: new Headers() }),
    ).toBeNull();

    expect(reads).toEqual([DIRECTORY]);
  });

  // Fails if someone reads a directory that is down as a forged signature
  // (every request of a signer whose directory is down would be reported
  // as invalid, and a journey attributed to a forger), or asks a down
  // directory again on every request.
  it('tells a directory it could not read from a signature that does not check', async () => {
    const by = await signer();
    let down = true;
    const { verify, reads } = verifier(() =>
      down ? new Response('', { status: 503 }) : directoryOf(by.jwk),
    );
    const request = await signedRequest(by);
    expect(await verify(request)).toMatchObject({
      outcome: 'directory_unreachable',
    });
    expect(await verify(request)).toMatchObject({
      outcome: 'directory_unreachable',
    });
    expect(reads).toHaveLength(1);

    // Read once it answers, and kept through a later outage.
    down = false;
    const later = verifier(
      () => (down ? new Response('', { status: 503 }) : directoryOf(by.jwk)),
      () => NOW,
    );
    expect(await later.verify(request)).toMatchObject({ outcome: 'verified' });
    down = true;
    expect(await later.verify(request)).toMatchObject({ outcome: 'verified' });
    expect(later.reads).toHaveLength(1);
  });

  // Fails if someone guesses the value of a component this verifier does
  // not derive (a signature over a query parameter would be judged on a
  // wrong base and read as forged).
  it('reports a component it does not derive as unsupported, not as forged', async () => {
    const by = await signer();
    const { verify } = verifier(() => directoryOf(by.jwk));
    const request = await signedRequest(by, {
      url: 'https://docs.example.test/search?q=agents',
      components:
        '("@authority" "@query-param";name="q" "signature-agent";key="sig")',
      componentLines: (url) => [
        `"@authority": ${url.host}`,
        `"@query-param";name="q": agents`,
        `"signature-agent";key="sig": "${AGENT}"`,
      ],
    });
    expect(await verify(request)).toMatchObject({ outcome: 'unsupported' });
    expect(await keyThumbprint(by.jwk as { kty: string })).toBe(by.thumbprint);
    expect(await keyThumbprint({ kty: 'oct' })).toBeNull();
  });
});
