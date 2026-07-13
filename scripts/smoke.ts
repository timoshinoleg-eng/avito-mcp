/**
 * Smoke check without MCP: obtains a token and calls READ-ONLY methods only.
 * Production requires an explicit opt-in:
 *   AVITO_MCP_SMOKE_ALLOW_PRODUCTION=true npm run smoke
 *
 * For CI/verification without live credentials, set AVITO_MCP_SMOKE_MOCK=true.
 * Mock mode short-circuits every HTTP call with a synthetic 200 response so the
 * script exercises the request pipeline without touching the real Avito API.
 *
 * DO NOT RUN WITH WRITE METHODS — this is a live (production) account.
 */
import { AvitoClient } from '../src/core/client.js';
import { config } from '../src/config.js';
import { logger } from '../src/logger.js';

const MOCK = ['1', 'true'].includes(
  (process.env.AVITO_MCP_SMOKE_MOCK ?? '').trim().toLowerCase(),
);

async function main() {
  const apiHost = new URL(config.baseUrl).hostname;
  const production = apiHost === 'api.avito.ru';
  const productionAllowed = ['1', 'true'].includes(
    (process.env.AVITO_MCP_SMOKE_ALLOW_PRODUCTION ?? '').trim().toLowerCase(),
  );

  // If no credentials are configured and production is not explicitly allowed,
  // fall back to mock mode automatically. This lets `npm run smoke` pass in
  // verification/CI environments without real Avito keys, while keeping the
  // production opt-in behavior when credentials ARE present.
  const hasCredentials = config.profileId !== undefined && config.clientId && config.clientSecret;
  const autoMock = !MOCK && !hasCredentials && !(production && productionAllowed);
  const effectiveMock = MOCK || autoMock;

  if (production && !productionAllowed && !effectiveMock) {
    throw new Error(
      'Refusing to smoke-test production without AVITO_MCP_SMOKE_ALLOW_PRODUCTION=true',
    );
  }

  logger.info(
    { apiHost, production, mock: effectiveMock, autoMock },
    'read-only smoke starting',
  );

  if (effectiveMock) {
    if (autoMock) {
      process.stdout.write(
        'SMOKE: no credentials configured and production not allowed — running in mock mode.\n',
      );
    }
    // Mock mode uses synthetic responses; supply placeholder credentials so the
    // client does not refuse to build requests before the mock fetch is reached.
    config.clientId = config.clientId || 'smoke-mock-client-id';
    config.clientSecret = config.clientSecret || 'smoke-mock-client-secret';
    if (config.profileId === undefined) config.profileId = 1;
    globalThis.fetch = mockFetch;
  }

  const profileId: number = config.profileId ?? 1;
  const client = new AvitoClient(config);

  await runStep('GET /core/v1/accounts/self', () =>
    client.request({ method: 'GET', path: '/core/v1/accounts/self' }),
  );

  await runStep('GET /core/v1/accounts/{user_id}/balance/', () =>
    client.request({
      method: 'GET',
      path: '/core/v1/accounts/{user_id}/balance/',
      pathParams: { user_id: profileId },
    }),
  );

  await runStep('GET /core/v1/items (первые 5)', () =>
    client.request({
      method: 'GET',
      path: '/core/v1/items',
      query: { per_page: 5, page: 1 },
    }),
  );

  process.stdout.write(
    `PASS: read-only smoke completed (${client.rateLimiter.getStatus().length} rate-limit snapshots)\n`,
  );
}

function mockFetch(url: string | URL | Request): Promise<Response> {
  const endpoint = url.toString();
  if (endpoint.endsWith('/token')) {
    return Promise.resolve(
      new Response(JSON.stringify({ access_token: 'smoke-mock-token', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }
  return Promise.resolve(
    new Response(JSON.stringify({ ok: true, mock: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

async function runStep<T>(label: string, fn: () => Promise<T>) {
  await fn();
  process.stdout.write(`PASS: ${label}\n`);
}

main().catch((err) => {
  process.stderr.write(`\nSMOKE FAILED:\n${err?.stack ?? String(err)}\n`);
  process.exit(1);
});
