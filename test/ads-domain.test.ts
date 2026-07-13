/**
 * Invariants for the optional `ads` domain (Avito Ads / Авито Реклама).
 *
 * The domain is env-conditional: it only registers when AVITO_ADS_CLIENT_ID,
 * AVITO_ADS_CLIENT_SECRET and AVITO_ADS_ACCOUNT_ID are all set. All exposed
 * tools are read-only; write/money operations are deliberately excluded from
 * the MVP.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { AvitoClient } from '../src/core/client.js';
import { register as registerAds } from '../src/domains/ads.js';
import { domains } from '../src/meta/domain-registry.js';
import { domainOfToolName } from '../src/meta/tool-naming.js';
import { PendingActionStore } from '../src/core/pending-actions.js';
import type { ToolContext } from '../src/core/tool-factory.js';
import type { Config } from '../src/config.js';

const adsEnvKeys = [
  'AVITO_ADS_CLIENT_ID',
  'AVITO_ADS_CLIENT_SECRET',
  'AVITO_ADS_ACCOUNT_ID',
] as const;

function clearAdsEnv(): void {
  for (const key of adsEnvKeys) delete process.env[key];
}

function setAdsEnv(): void {
  process.env.AVITO_ADS_CLIENT_ID = 'test-client-id';
  process.env.AVITO_ADS_CLIENT_SECRET = 'test-client-secret';
  process.env.AVITO_ADS_ACCOUNT_ID = '12345';
}

function makeConfig(): Config {
  return {
    clientId: 'cid',
    clientSecret: 'sec',
    profileId: 12345,
    baseUrl: 'https://api.test.example',
    cpaSource: 'avito-mcp-test',
    tokenFile: join(tmpdir(), `avito-token-${randomBytes(6).toString('hex')}.json`),
    logLevel: 'fatal',
    mode: 'full_access',
    allowTools: [],
    denyTools: [],
    exposeAuthTools: true,
    allowedUploadDirs: [tmpdir()],
    maxUploadMb: 15,
    confirmationMode: 'off',
    confirmationTtlSec: 900,
    maxBinaryMb: 20,
    dryRunDefault: false,
    idempotencyTtlSec: 3600,
    tokenLockTimeoutMs: 30_000,
    http: {
      transport: 'stdio',
      host: '127.0.0.1',
      port: 3000,
      publicUrl: 'http://127.0.0.1:3000',
      auth: 'oauth',
      authTokens: [],
      allowNoAuth: false,
      allowedHosts: [],
      allowedOrigins: [],
      maxSessions: 100,
      sessionIdleSec: 1800,
      oauthTokenTtlSec: 3600,
    },
    webhook: {
      enabled: false,
      publicUrl: 'http://127.0.0.1:3000',
      path: '/avito/webhook',
      bufferSize: 100,
    },
  };
}

const expectedAdsTools = [
  'ads_account_get_balance',
  'ads_advertisers_list',
  'ads_contracts_list',
  'ads_campaigns_list',
  'ads_groups_list',
  'ads_creatives_list',
  'ads_statistics_campaign',
];

interface ToolWithMeta {
  name: string;
  inputSchema?: Record<string, unknown>;
  _meta?: { risk?: string; domain?: string; environment?: string };
}

async function buildAdsServer(): Promise<{
  server: McpServer;
  client: Client;
  close: () => Promise<void>;
}> {
  const server = new McpServer({ name: 'avito-mcp-ads-test', version: '0.0.0' });
  const cfg = makeConfig();
  const pendingStore = new PendingActionStore(cfg.confirmationTtlSec * 1000);
  const ctx: ToolContext = { client: new AvitoClient(cfg), config: cfg, pendingStore };
  for (const register of domains) register(server, ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'ads-test', version: '0.0.0' }, { capabilities: {} });
  await client.connect(b);
  return {
    server,
    client,
    close: async () => {
      await client.close();
    },
  };
}

async function listToolsWithAdsEnv(): Promise<ToolWithMeta[]> {
  const { client, close } = await buildAdsServer();
  try {
    const list = await client.listTools();
    return list.tools as ToolWithMeta[];
  } finally {
    await close();
  }
}

// Mock the avito-ads SDK so tests never touch real credentials or the network.
const mockAccountGetBalance = vi.fn().mockResolvedValue({ balance: 1000, bonus: 0 });
const mockAdvertisersList = vi.fn().mockResolvedValue({ items: [], total: 0 });
const mockContractsList = vi.fn().mockResolvedValue({ items: [], total: 0 });
const mockCampaignsList = vi.fn().mockResolvedValue({ items: [], total: 0 });
const mockGroupsList = vi.fn().mockResolvedValue({ items: [], total: 0 });
const mockCreativesList = vi.fn().mockResolvedValue({ items: [], total: 0 });
const mockStatisticsCampaign = vi.fn().mockResolvedValue({ campaignId: 1, stats: [] });

vi.mock('avito-ads', () => {
  class FakeAvitoAdsClient {
    account = { getBalance: mockAccountGetBalance };
    advertisers = { list: mockAdvertisersList };
    contracts = { list: mockContractsList };
    campaigns = { list: mockCampaignsList };
    groups = { list: mockGroupsList };
    creatives = { list: mockCreativesList };
    statistics = { campaign: mockStatisticsCampaign };
    accountId = 12345;
    baseUrl = 'https://api.avito.ru/ads/v1';
    static fromEnv() {
      return new FakeAvitoAdsClient();
    }
  }
  class ConfigurationError extends Error {
    name = 'ConfigurationError';
  }
  return {
    AvitoAdsClient: FakeAvitoAdsClient,
    ConfigurationError,
  };
});

describe('ads domain registration', () => {
  beforeEach(() => {
    clearAdsEnv();
    vi.clearAllMocks();
  });

  afterEach(() => {
    clearAdsEnv();
  });

  it('is not registered when AVITO_ADS_* variables are missing', () => {
    const names: string[] = [];
    const server = {
      registerTool(name: string): void {
        names.push(name);
      },
    } as unknown as McpServer;
    const cfg = makeConfig();
    const ctx: ToolContext = {
      client: new AvitoClient(cfg),
      config: cfg,
      pendingStore: new PendingActionStore(cfg.confirmationTtlSec * 1000),
    };
    registerAds(server, ctx);
    expect(names).toEqual([]);
  });

  it('registers exactly 7 read-only tools when all AVITO_ADS_* variables are set', async () => {
    setAdsEnv();
    const tools = await listToolsWithAdsEnv();
    const adsTools = tools.filter((t) => t.name.startsWith('ads_'));
    expect(adsTools.map((t) => t.name).sort()).toEqual([...expectedAdsTools].sort());
    expect(adsTools.every((t) => t._meta?.risk === 'read')).toBe(true);
  });

  it('assigns the ads domain and keeps read-only annotations on every ads tool', async () => {
    setAdsEnv();
    const tools = await listToolsWithAdsEnv();
    const adsTools = tools.filter((t) => t.name.startsWith('ads_'));
    for (const t of adsTools) {
      expect(domainOfToolName(t.name)).toBe('ads');
      expect(t._meta?.risk).toBe('read');
      expect(['write', 'money', 'public']).not.toContain(t._meta?.risk);
    }
  });

  it('rejects invalid page/limit values via input schema', async () => {
    setAdsEnv();
    const tools = await listToolsWithAdsEnv();
    const advertisers = tools.find((t) => t.name === 'ads_advertisers_list');
    expect(advertisers).toBeDefined();
    const properties = advertisers!.inputSchema!.properties as Record<string, Record<string, unknown>>;
    expect(properties).toHaveProperty('page');
    expect(properties).toHaveProperty('limit');
    expect(properties.page!.type).toBe('integer');
    expect(properties.page!.minimum).toBe(1);
    expect(properties.page!.maximum).toBe(1000);
    expect(properties.limit!.type).toBe('integer');
    expect(properties.limit!.minimum).toBe(1);
    expect(properties.limit!.maximum).toBe(200);
  });

  it('rejects invalid campaignId/dateFrom/dateTo via input schema', async () => {
    setAdsEnv();
    const tools = await listToolsWithAdsEnv();
    const stats = tools.find((t) => t.name === 'ads_statistics_campaign');
    expect(stats).toBeDefined();
    const properties = stats!.inputSchema!.properties as Record<string, Record<string, unknown>>;
    expect(properties).toHaveProperty('campaignId');
    expect(properties).toHaveProperty('dateFrom');
    expect(properties).toHaveProperty('dateTo');
    expect(properties.campaignId!.type).toBe('integer');
    expect(properties.dateFrom!.type).toBe('string');
    expect(properties.dateFrom!.pattern).toBe('^\\d{4}-\\d{2}-\\d{2}$');
    expect(properties.dateTo!.type).toBe('string');
    expect(properties.dateTo!.pattern).toBe('^\\d{4}-\\d{2}-\\d{2}$');
  });

  it('does not invoke the SDK during registration', async () => {
    setAdsEnv();
    await listToolsWithAdsEnv();
    expect(mockAccountGetBalance).not.toHaveBeenCalled();
    expect(mockAdvertisersList).not.toHaveBeenCalled();
  });

  it('rejects out-of-range page/limit at call time', async () => {
    setAdsEnv();
    const { client, close } = await buildAdsServer();
    try {
      const result = await client.callTool({
        name: 'ads_advertisers_list',
        arguments: { page: 0, limit: 500 },
      });
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]?.text).toContain('Input validation error');
    } finally {
      await close();
    }
  });

  it('rejects malformed campaignId and dates at call time', async () => {
    setAdsEnv();
    const { client, close } = await buildAdsServer();
    try {
      const result = await client.callTool({
        name: 'ads_statistics_campaign',
        arguments: { campaignId: -1, dateFrom: '01-01-2024', dateTo: 'tomorrow' },
      });
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]?.text).toContain('Input validation error');
    } finally {
      await close();
    }
  });
});
