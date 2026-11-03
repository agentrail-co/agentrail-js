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
    signers: ['signer.example.test'],
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
  // as invalid, and a journey attributed to a forger), asks a down
  // directory again on every request, drops the copy it holds when a
  // refresh fails, never tries again after a failure, or lets a read whose
  // body stalled past the deadline stay under way for every later check.
  it('tells a directory it could not read from a signature that does not check', async () => {
    const by = await signer();
    let down = true;
    let clock = NOW;
    const answer = () =>
      down ? new Response('', { status: 503 }) : directoryOf(by.jwk);
    const { verify, reads } = verifier(answer, () => clock);
    const request = await signedRequest(by, {
      created: Math.floor(NOW / 1_000) - 10,
      expires: Math.floor(NOW / 1_000) + 8 * 3_600,
    });
    expect(await verify(request)).toMatchObject({
      outcome: 'directory_unreachable',
    });
    expect(await verify(request)).toMatchObject({
      outcome: 'directory_unreachable',
    });
    expect(reads).toHaveLength(1);

    // Tried again after a minute; read once it answers.
    clock += 61_000;
    down = false;
    expect(await verify(request)).toMatchObject({ outcome: 'verified' });
    expect(reads).toHaveLength(2);
    // Past its max-age the refresh fails: the copy held still answers, and
    // the failure is not retried for a minute.
    clock += 3_600_000 + 1;
    down = true;
    expect(await verify(request)).toMatchObject({ outcome: 'verified' });
    expect(await verify(request)).toMatchObject({ outcome: 'verified' });
    expect(reads).toHaveLength(3);
    clock += 61_000;
    down = false;
    expect(await verify(request)).toMatchObject({ outcome: 'verified' });
    expect(reads).toHaveLength(4);

    // A read the deadline ends: unreachable, and the next check reads anew
    // rather than waiting on it.
    let aborted = 0;
    const slow = createSignatureVerifier({
      now: () => clock,
      signers: ['signer.example.test'],
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted += 1;
            reject(
              new DOMException('The operation was aborted.', 'AbortError'),
            );
          });
        }),
    });
    expect(await slow(request)).toMatchObject({
      outcome: 'directory_unreachable',
    });
    clock += 61_000;
    expect(await slow(request)).toMatchObject({
      outcome: 'directory_unreachable',
    });
    expect(aborted).toBe(2);
  }, 20_000);

  // Fails if someone lets the edge read a directory from a host the caller
  // chose (an address, a private name, a port, or any name no one listed,
  // which may resolve inside the network the edge runs in), records a
  // claim longer than the collector takes (the whole call
  // carrying it would be refused), or lets a byte sequence that is not
  // whole base64 throw past the verifier (the request would go unrecorded).
  it('reads directories from public names only, bounds what it records, and reads broken bytes as no signature', async () => {
    const by = await signer();
    const { verify, reads } = verifier(() => directoryOf(by.jwk));
    for (const agent of [
      'https://10.0.0.5',
      'https://localhost',
      'https://metadata.internal',
      'https://signer.example.test:8443',
      'https://user:pw@signer.example.test',
      'https://[fd00::1]',
    ]) {
      const request = await signedRequest(by, {
        agentHeader: `sig="${agent}"`,
      });
      expect(await verify(request), agent).toMatchObject({
        agent,
        outcome: 'unsupported',
      });
    }
    // A public name no one listed: never contacted either.
    expect(
      await verify(
        await signedRequest(by, {
          agentHeader: 'sig="https://unlisted.example.test"',
        }),
      ),
    ).toMatchObject({
      agent: 'https://unlisted.example.test',
      outcome: 'unsupported',
    });
    // A blocked member beside a public one: the claim stays with the
    // member the signature named, unchecked, and nothing is read.
    const mixed = await signedRequest(by, {
      agentHeader: `sig="https://signer.example.test:8443", other="${AGENT}"`,
    });
    expect(await verify(mixed)).toMatchObject({
      agent: 'https://signer.example.test:8443',
      outcome: 'unsupported',
    });
    expect(reads).toEqual([]);

    const long = `https://${'a'.repeat(300)}.signer.example.test`;
    const claimed = await verify(
      await signedRequest(by, {
        agentHeader: `sig="${long}"`,
        keyId: 'k'.repeat(300),
      }),
    );
    // A public name, so it is read, and the key is not there: invalid, and
    // recorded no longer than the collector takes.
    expect(claimed).toMatchObject({ outcome: 'invalid' });
    expect(claimed?.agent).toHaveLength(256);
    expect(claimed?.keyId).toHaveLength(256);
    expect(
      await verify({
        method: 'GET',
        url: 'https://docs.example.test/',
        headers: new Headers({ 'signature-agent': '   ' }),
      }),
    ).toBeNull();

    const broken = await signedRequest(by);
    broken.headers.set('signature', 'sig=:a:');
    expect(await verify(broken)).toMatchObject({ outcome: 'invalid' });
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

    // What it does derive, it derives as sent: a method's case, and a
    // decimal member of a covered header written with its fraction.
    const custom = await signedRequest(by, {
      components:
        '("@method" "@authority" "x-rate";key="limit" "signature-agent";key="sig")',
      componentLines: (url) => [
        '"@method": custom',
        `"@authority": ${url.host}`,
        '"x-rate";key="limit": 1.0',
        `"signature-agent";key="sig": "${AGENT}"`,
      ],
    });
    custom.headers.set('x-rate', 'limit=1.0');
    expect(await verify({ ...custom, method: 'custom' })).toMatchObject({
      outcome: 'verified',
    });
  });
});
