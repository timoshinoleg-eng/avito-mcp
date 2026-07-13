/**
 * Domain `ads` — corresponds to Авито Реклама API (https://api.avito.ru/ads/v1/).
 *
 * Bakugan fork v1.3.0: wraps the official avito-ads SDK (avito-tech org, MIT,
 * zero runtime deps, native fetch). 7 read-only tools for MVP:
 *   - ads_account_get_balance   (account.getBalance)
 *   - ads_advertisers_list      (advertisers.list)
 *   - ads_contracts_list        (contracts.list)
 *   - ads_campaigns_list        (campaigns.list)
 *   - ads_groups_list           (groups.list)
 *   - ads_creatives_list        (creatives.list)
 *   - ads_statistics_campaign   (statistics.campaign)
 *
 * Write/creative operations (account.create, advertisers.create, contracts.create,
 * groups.changeBudget/changePrice, statistics.groups/creatives, users.*) are NOT
 * included in MVP — they need confirmation flow with human-in-the-loop (planned
 * v0.2+).
 *
 * Graceful degradation: if AVITO_ADS_CLIENT_ID/CLIENT_SECRET/ACCOUNT_ID are not
 * set, this domain is not registered at all (matches webhook receiver pattern).
 *
 * Env vars (see .env.example, all with AVITO_ADS_ prefix):
 *   - AVITO_ADS_CLIENT_ID       — OAuth client ID for the Ads app (different from
 *                                 the main Avito app Client_id!)
 *   - AVITO_ADS_CLIENT_SECRET   — OAuth client secret
 *   - AVITO_ADS_ACCOUNT_ID      — numeric ID of the advertising account
 *   - AVITO_ADS_ENVIRONMENT     — "production" (default) or "sandbox"
 *
 * Get Ads OAuth credentials at https://www.avito.ru/professionals/api.
 */
import {
  AvitoAdsClient,
  ConfigurationError,
  type Balance,
  type PaginatedResult,
  type Advertiser,
  type Contract,
  type Campaign,
  type Group,
  type Creative,
  type CampaignStatisticResult,
} from 'avito-ads';
import { z } from 'zod';

import { defineTool, type DomainRegister } from '../core/tool-factory.js';
import { type RequestResponse } from '../core/client.js';
import { logger } from '../logger.js';

/**
 * Module-level singleton for the AvitoAdsClient. We use lazy init because:
 *  - The SDK throws on construction if AVITO_ADS_* env vars are missing
 *  - We want the rest of the MCP server (150+ tools) to keep working when
 *    AVITO_ADS_* is not configured (e.g. for non-Ads workflows)
 *
 * The token cache lives in-process in the SDK's MemoryTokenStorage, which is
 * sufficient for stdio mode. For HTTP mode, each MCP session could share this
 * singleton (it's a const reference) — cross-process safety is left to
 * upstream's token-lock.ts.
 */
let adsClientSingleton: AvitoAdsClient | null = null;

function isAdsConfigured(): boolean {
  return Boolean(
    process.env.AVITO_ADS_CLIENT_ID &&
      process.env.AVITO_ADS_CLIENT_SECRET &&
      process.env.AVITO_ADS_ACCOUNT_ID,
  );
}

function getAdsClient(): AvitoAdsClient {
  if (adsClientSingleton) return adsClientSingleton;
  if (!isAdsConfigured()) {
    throw new ConfigurationError(
      'AVITO_ADS_CLIENT_ID / AVITO_ADS_CLIENT_SECRET / AVITO_ADS_ACCOUNT_ID are not set. ' +
        'Either fill them in .env, or do not invoke ads_* tools.',
    );
  }
  adsClientSingleton = AvitoAdsClient.fromEnv();
  logger.info(
    {
      accountId: adsClientSingleton.accountId,
      baseUrl: adsClientSingleton.baseUrl,
    },
    'avito-ads client initialized',
  );
  return adsClientSingleton;
}

/** Helper to wrap a SDK call into a RequestResponse (what customExecute returns). */
function sdkResult<T>(data: T, status = 200): RequestResponse<T> {
  return { status, data, headers: new Headers() };
}

// ──────────────────────────────────────────────────────────────────────────────
// Zod input schemas (shared by all list methods).
// ──────────────────────────────────────────────────────────────────────────────
const PageInput = {
  page: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe('Номер страницы (1-based). Default: 1.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe('Элементов на странице. Default: 25, max: 200 (лимит SDK).'),
};

/**
 * Each customExecute tool gets a placeholder `method` and `path` because the
 * upstream ToolSpec type requires them even though the SDK call bypasses the
 * HTTP layer entirely. The `path` is intentionally descriptive (it shows up
 * in the live manifest and in dry-run previews) but the actual request goes
 * through avito-ads SDK and is not an HTTP call.
 */
const AD_SENTINEL_PATH = '/ads/v1/internal/sdk-call';

// ──────────────────────────────────────────────────────────────────────────────
// Domain registration
// ──────────────────────────────────────────────────────────────────────────────
export const register: DomainRegister = (server, _ctx) => {
  if (!isAdsConfigured()) {
    logger.info(
      'AVITO_ADS_* env vars not set — ads domain NOT registered (150+ tools still work). ' +
        'Fill AVITO_ADS_CLIENT_ID, AVITO_ADS_CLIENT_SECRET, AVITO_ADS_ACCOUNT_ID in .env to enable.',
    );
    return;
  }

  // ── 1. Account: balance ────────────────────────────────────────────────────
  defineTool(server, _ctx, {
    name: 'ads_account_get_balance',
    title: 'Авито Реклама: баланс аккаунта',
    risk: 'read',
    domain: 'ads',
    description:
      'Возвращает текущий баланс и резерв рекламного аккаунта ' +
      '(GET /ads/v1/account/{id}/balance). Read-only, без side-effects.',
    method: 'GET',
    path: AD_SENTINEL_PATH,
    customExecute: async (_args, _ctx): Promise<RequestResponse<Balance>> => {
      const data = await getAdsClient().account.getBalance();
      return sdkResult(data);
    },
  });

  // ── 2. Advertisers: list ───────────────────────────────────────────────────
  defineTool(server, _ctx, {
    name: 'ads_advertisers_list',
    title: 'Авито Реклама: список рекламодателей',
    risk: 'read',
    domain: 'ads',
    description:
      'Возвращает постраничный список рекламодателей аккаунта ' +
      '(POST /ads/v1/account/{id}/advertisers). Параметры page/limit опциональны.',
    method: 'POST',
    path: AD_SENTINEL_PATH,
    input: PageInput,
    customExecute: async (args, _ctx): Promise<RequestResponse<PaginatedResult<Advertiser>>> => {
      const data = await getAdsClient().advertisers.list({
        page: args.page as number | undefined,
        limit: args.limit as number | undefined,
      });
      return sdkResult(data);
    },
  });

  // ── 3. Contracts: list ─────────────────────────────────────────────────────
  defineTool(server, _ctx, {
    name: 'ads_contracts_list',
    title: 'Авито Реклама: список договоров',
    risk: 'read',
    domain: 'ads',
    description:
      'Возвращает постраничный список договоров аккаунта ' +
      '(POST /ads/v1/account/{id}/contracts).',
    method: 'POST',
    path: AD_SENTINEL_PATH,
    input: PageInput,
    customExecute: async (args, _ctx): Promise<RequestResponse<PaginatedResult<Contract>>> => {
      const data = await getAdsClient().contracts.list({
        page: args.page as number | undefined,
        limit: args.limit as number | undefined,
      });
      return sdkResult(data);
    },
  });

  // ── 4. Campaigns: list ─────────────────────────────────────────────────────
  defineTool(server, _ctx, {
    name: 'ads_campaigns_list',
    title: 'Авито Реклама: список кампаний',
    risk: 'read',
    domain: 'ads',
    description:
      'Возвращает постраничный список рекламных кампаний ' +
      '(POST /ads/v1/account/{id}/campaigns).',
    method: 'POST',
    path: AD_SENTINEL_PATH,
    input: PageInput,
    customExecute: async (args, _ctx): Promise<RequestResponse<PaginatedResult<Campaign>>> => {
      const data = await getAdsClient().campaigns.list({
        page: args.page as number | undefined,
        limit: args.limit as number | undefined,
      });
      return sdkResult(data);
    },
  });

  // ── 5. Groups: list ────────────────────────────────────────────────────────
  defineTool(server, _ctx, {
    name: 'ads_groups_list',
    title: 'Авито Реклама: список групп объявлений',
    risk: 'read',
    domain: 'ads',
    description:
      'Возвращает постраничный список групп объявлений ' +
      '(POST /ads/v1/account/{id}/groups). Группа — набор объявлений внутри кампании.',
    method: 'POST',
    path: AD_SENTINEL_PATH,
    input: PageInput,
    customExecute: async (args, _ctx): Promise<RequestResponse<PaginatedResult<Group>>> => {
      const data = await getAdsClient().groups.list({
        page: args.page as number | undefined,
        limit: args.limit as number | undefined,
      });
      return sdkResult(data);
    },
  });

  // ── 6. Creatives: list ─────────────────────────────────────────────────────
  defineTool(server, _ctx, {
    name: 'ads_creatives_list',
    title: 'Авито Реклама: список креативов',
    risk: 'read',
    domain: 'ads',
    description:
      'Возвращает постраничный список креативов (объявлений) ' +
      '(POST /ads/v1/account/{id}/creatives).',
    method: 'POST',
    path: AD_SENTINEL_PATH,
    input: PageInput,
    customExecute: async (args, _ctx): Promise<RequestResponse<PaginatedResult<Creative>>> => {
      const data = await getAdsClient().creatives.list({
        page: args.page as number | undefined,
        limit: args.limit as number | undefined,
      });
      return sdkResult(data);
    },
  });

  // ── 7. Statistics: campaign-level ──────────────────────────────────────────
  defineTool(server, _ctx, {
    name: 'ads_statistics_campaign',
    title: 'Авито Реклама: статистика кампании',
    risk: 'read',
    domain: 'ads',
    description:
      'Статистика по рекламной кампании со сводками по группам и креативам ' +
      '(POST /ads/v1/account/{id}/campaigns/{campaignId}/stats). ' +
      'Период dateFrom..dateTo — не более 100 дней, формат YYYY-MM-DD.',
    method: 'POST',
    path: AD_SENTINEL_PATH,
    input: {
      campaignId: z
        .number()
        .int()
        .positive()
        .describe('ID кампании, для которой нужна статистика.'),
      dateFrom: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
        .describe('Начало периода (включительно), формат YYYY-MM-DD.'),
      dateTo: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
        .describe('Конец периода (включительно), формат YYYY-MM-DD. ≤100 дней от dateFrom.'),
    },
    customExecute: async (
      args,
      _ctx,
    ): Promise<RequestResponse<CampaignStatisticResult>> => {
      const data = await getAdsClient().statistics.campaign(
        args.campaignId as number,
        args.dateFrom as string,
        args.dateTo as string,
      );
      return sdkResult(data);
    },
  });
};
