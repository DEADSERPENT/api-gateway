import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { AUDIENCE, ISSUER, makeKeys, signToken, startHarness, type Harness } from '../helpers.js';

let h: Harness;
const logs: string[] = [];
const logStream = new Writable({
  write(chunk, _enc, cb) {
    logs.push(String(chunk));
    cb();
  },
});

beforeAll(async () => {
  h = await startHarness({}, logStream);
});
afterAll(async () => {
  await h.close();
});

const auth = async (sub?: string) => ({ authorization: `Bearer ${await h.token(sub)}` });

describe('health and metrics', () => {
  it('liveness and readiness are public', async () => {
    expect((await h.gateway.inject('/health/live')).statusCode).toBe(200);
    const ready = await h.gateway.inject('/health/ready');
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: 'ready' });
  });
});

describe('routing', () => {
  it('forwards method, path, query and body to the right service', async () => {
    const res = await h.gateway.inject({
      method: 'POST',
      url: '/api/v1/service-a/echo?x=1&y=two',
      headers: { ...(await auth()), 'content-type': 'application/json' },
      payload: { hello: 'world' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      service: 'service-a',
      method: 'POST',
      path: '/echo',
      query: { x: '1', y: 'two' },
      body: { hello: 'world' },
    });
  });

  it('routes service-b separately', async () => {
    const res = await h.gateway.inject({
      url: '/api/v1/service-b/ping',
      headers: await auth(),
    });
    expect(res.json()).toMatchObject({ service: 'service-b', path: '/ping' });
  });

  it('returns a safe JSON 404 for unknown routes', async () => {
    const res = await h.gateway.inject({ url: '/nope', headers: await auth() });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    expect(res.json().error.requestId).toBeTruthy();
  });

  it('passes upstream 4xx responses through unchanged', async () => {
    const res = await h.gateway.inject({
      url: '/api/v1/service-a/status/404',
      headers: await auth(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ service: 'service-a' });
  });

  it('enforces the request body size limit', async () => {
    const res = await h.gateway.inject({
      method: 'POST',
      url: '/api/v1/service-a/echo',
      headers: { ...(await auth()), 'content-type': 'application/json' },
      payload: JSON.stringify({ big: 'x'.repeat(5000) }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('request ids', () => {
  it('generates a unique id per request and propagates it downstream', async () => {
    const [r1, r2] = await Promise.all(
      [1, 2].map(async () =>
        h.gateway.inject({ url: '/api/v1/service-a/ping', headers: await auth() }),
      ),
    );
    const id1 = r1!.headers['x-request-id'];
    const id2 = r2!.headers['x-request-id'];
    expect(id1).toBeTruthy();
    expect(id1).not.toBe(id2);
    expect(r1!.json().requestId).toBe(id1);
  });

  it('ignores a client-supplied request id', async () => {
    const res = await h.gateway.inject({
      url: '/api/v1/service-a/ping',
      headers: { ...(await auth()), 'x-request-id': 'attacker-chosen' },
    });
    expect(res.headers['x-request-id']).not.toBe('attacker-chosen');
    expect(res.json().requestId).not.toBe('attacker-chosen');
  });
});

describe('authentication', () => {
  const protectedUrl = '/api/v1/service-a/ping';

  async function expect401(headers: Record<string, string>) {
    const before = h.a.calls;
    const res = await h.gateway.inject({ url: protectedUrl, headers });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
    expect(h.a.calls).toBe(before); // never reached the upstream
  }

  it('rejects a missing token', () => expect401({}));
  it('rejects a malformed token', () => expect401({ authorization: 'Bearer not-a-jwt' }));
  it('rejects a non-bearer scheme', () => expect401({ authorization: 'Basic abc' }));

  it('rejects an expired token', async () => {
    const t = await signToken(h.keys, { expiresIn: Math.floor(Date.now() / 1000) - 60 });
    await expect401({ authorization: `Bearer ${t}` });
  });

  it('rejects a token signed with a different key', async () => {
    const other = await makeKeys();
    const t = await signToken(other);
    await expect401({ authorization: `Bearer ${t}` });
  });

  it('rejects the wrong issuer and the wrong audience', async () => {
    await expect401({
      authorization: `Bearer ${await signToken(h.keys, { issuer: 'https://evil.test' })}`,
    });
    await expect401({
      authorization: `Bearer ${await signToken(h.keys, { audience: 'someone-else' })}`,
    });
  });

  it('rejects alg=none tokens', async () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const t = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'u', iss: ISSUER, aud: AUDIENCE })}.`;
    await expect401({ authorization: `Bearer ${t}` });
  });

  it('rejects HS256 tokens signed with the public key as secret (algorithm confusion)', async () => {
    const t = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u')
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(h.keys.publicKeyPem));
    await expect401({ authorization: `Bearer ${t}` });
  });

  it('accepts a valid token and injects only the verified identity', async () => {
    const res = await h.gateway.inject({
      url: protectedUrl,
      headers: await auth('alice'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().authenticatedUser).toBe('alice');
  });

  it('does not forward the bearer token upstream', async () => {
    const res = await h.gateway.inject({ url: protectedUrl, headers: await auth() });
    expect(res.json().receivedAuthorization).toBe(false);
  });

  it('overwrites a spoofed identity header with the verified one', async () => {
    const res = await h.gateway.inject({
      url: protectedUrl,
      headers: { ...(await auth('alice')), 'x-authenticated-user': 'admin' },
    });
    expect(res.json().authenticatedUser).toBe('alice');
  });

  it('error bodies carry the request id and no internals', async () => {
    const res = await h.gateway.inject({ url: protectedUrl });
    const body = res.json();
    expect(body.error.requestId).toBe(res.headers['x-request-id']);
    expect(JSON.stringify(body)).not.toMatch(/stack|jose|node_modules/i);
  });
});

describe('logging', () => {
  it('never writes tokens or authorization headers to logs', async () => {
    const token = await h.token('log-user');
    await h.gateway.inject({
      url: '/api/v1/service-a/ping?access_token=' + token,
      headers: { authorization: `Bearer ${token}` },
    });
    await h.gateway.inject({
      url: '/api/v1/service-a/ping',
      headers: { authorization: 'Bearer leaked.secret.value' },
    });
    const all = logs.join('');
    expect(all.length).toBeGreaterThan(0);
    expect(all).not.toContain(token);
    expect(all).not.toContain('leaked.secret.value');
  });
});
