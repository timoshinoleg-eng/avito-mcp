# Fork Notes — Bakugan's avito-mcp v1.3.0

> **Upstream:** https://github.com/elchin92/avito-mcp (v1.2.0, MIT, © 2026 avito-mcp contributors)
> **Fork maintained by:** Bakugan (Бакуган), 2026, for solo-indie use
> **License:** MIT — наши добавки публикуются под MIT. Часть кода (lookup) портирована с `MissiaL/avito-api` (Apache-2.0); upstream MIT-часть сохраняется.
> **Sync policy:** Track upstream `main`. Re-merge при значимых релизах. PR upstream не планируются (только личные улучшения).

## Что добавлено в v1.3.0

### 1. Domain `ads` — Авито Реклама (7 read-only tools)

Upstream имеет 18 доменов (148 tools) для основного API Авито, но **не покрывает Авито Рекламу** — отдельный API на `api.avito.ru/ads/v1/`. Закрываем этот пробел.

**Реализация:** обёртка вокруг официального SDK [`avito-ads`](https://www.npmjs.com/package/avito-ads) v1.0.0 (MIT, © avito-tech org, zero runtime deps, native fetch).

**Tools (MVP, все read-only, risk='read'):**

| Tool | SDK resource.method | Назначение |
|---|---|---|
| `ads_account_get_balance` | `account.getBalance()` | Баланс рекламного аккаунта |
| `ads_advertisers_list` | `advertisers.list()` | Список рекламодателей |
| `ads_contracts_list` | `contracts.list()` | Список договоров |
| `ads_campaigns_list` | `campaigns.list()` | Список кампаний |
| `ads_groups_list` | `groups.list()` | Список групп объявлений |
| `ads_creatives_list` | `creatives.list()` | Список креативов |
| `ads_statistics_campaign` | `statistics.campaign()` | Статистика одной кампании за период |

**Не включено в MVP (write-операции, high risk):**
- `ads_*_create` / `update` / `delete` (создание кампаний, креативов, etc.)
- `ads_*_pay` / `ads_account_recharge` (списание денег)
- `groups.updatePrices`, `campaigns.updateStatus`, `creatives.upload`
- Эти операции требуют confirmation flow с human-in-the-loop (планируется в v1.4+)

**Файлы:**
- `src/domains/ads.ts` — 7 tools (читает `AVITO_ADS_*` env vars)
- 1 строка в `src/meta/domain-registry.ts`

**Env vars (см. `.env.example`):**
- `AVITO_ADS_CLIENT_ID` — OAuth client ID для Рекламы (отдельный!)
- `AVITO_ADS_CLIENT_SECRET` — OAuth client secret для Рекламы
- `AVITO_ADS_ACCOUNT_ID` — числовой ID рекламного аккаунта
- `AVITO_ADS_ENVIRONMENT` — `sandbox` | `production` (default: production)
- `AVITO_ADS_TIMEOUT_MS` — request timeout (default 30000)
- `AVITO_ADS_FETCH` — optional custom fetch override (advanced)

**Graceful degradation:** если `AVITO_ADS_*` не заполнены, домен `ads` не регистрируется. Остальные 148+lookup tools работают как раньше. Это позволяет использовать форк даже без рекламного API.

**Risk profile:** все 7 ads tools помечены `risk: 'read'`, но классифицируются по домену `ads` и НЕ входят в дефолтную группу `read` policy — оператор должен явно разрешить их через `AVITO_MCP_ALLOWED_TOOL_DOMAINS=ads,lookup,...` (или `AVITO_MCP_POLICY=full_access`).

### 2. Domain `lookup` — port MissiaL/avito-api lookup_endpoint.py

Проблема: 148 tools (а с нашим форком — 155 максимум) сложно навигировать. LLM-агент часто знает что хочет сделать по-русски, но не помнит точного имени tool. elchin92's tools имеют хорошие English descriptions, но search внутри них не предусмотрен.

Решение: портируем [`MissiaL/avito-api/scripts/lookup_endpoint.py`](https://github.com/MissiaL/avito-api) (189 строк, Apache-2.0) с Python на TypeScript.

**Что делает lookup:**
- Загружает все OpenAPI specs из `swaggers/` (18 файлов) один раз при старте
- Индексирует все `paths` (138 операций / 18 файлов — реально 144 эндпоинта в спеках, но HTTP-метод-фильтр оставляет 138)
- Substring search по `summary` + `description` + `tags` + `path`
- Single 2-char stem-fallback (`needle.slice(0, -2)`) если 0 результатов и needle длиннее 2 символов
- Возвращает top-N совпадений; по запросу resolve-ит `$ref` параметры на один уровень вложенности

**Tools (2 tools, risk='public' — никакого fetch к Avito):**
- `avito_lookup_search({query: string, limit?: number})` → массив совпадений `{method, path, summary, description, domain, tags}`
- `avito_lookup_show({path: string, method: string})` → развёрнутая запись эндпоинта с resolved `$ref` (один уровень)

**Файлы:**
- `src/domains/lookup.ts` — 2 tools + встроенный index loader (~245 строк)
- 1 строка в `src/meta/domain-registry.ts`

**Отличия от оригинального Python:**
- Без NLTK Snowball stemmer. MissiaL использует только простейший 2-символьный stem (`slice(0, -2)`) как fallback когда substring search не дал результатов. Полноценный stemmer избыточен для MVP и привнёс бы 200+ строк зависимостей.
- Без рекурсивного resolve `$ref` — оставлен single-level, чтобы не уходить в бесконечный цикл на spec с самоссылками.
- `limit` дефолт 50 (vs 30 в Python).

**License attribution:** оригинальный Python — MissiaL/avito-api (Apache-2.0). TS-порт — Bakugan, MIT. NLTK не используется.

## Что НЕ менялось

Всё остальное — **полностью upstream v1.2.0**:
- 18 domains (auth, user, items, messenger, autoload, orders, delivery, promotion, cpa×3, stock, hierarchy, reviews, tariffs, trxpromo, calltracking, messenger_discounts, webhook, meta)
- Вся safety infrastructure: read_only/guarded/full_access modes, dry-run, confirmation TTL, allow/deny tools
- OAuth2 token cache + cross-process file lock
- Idempotency ledger
- Webhook receiver
- HTTP transport (Express 5, OAuth 2.1)
- MCP resources/prompts/logging
- 18 swaggers в `swaggers/`
- Bilingual README (EN+RU)
- CHANGELOG (исторически с v0.1.0)

## Re-merge с upstream

Перед значимыми релизами upstream:
```bash
# 1. Сохраняем наши изменения
git diff v1.2.0..HEAD -- src/domains/ads.ts src/domains/lookup.ts src/meta/domain-registry.ts > bakugan-changes.patch

# 2. Re-base
git fetch upstream && git rebase upstream/main

# 3. Re-apply
git apply bakugan-changes.patch

# 4. Проверяем
npm install && npm run verify
```

## Upstream credits

```
avito-mcp v1.2.0  — © 2026 avito-mcp contributors (MIT)
                    src: https://github.com/elchin92/avito-mcp
                    npm: avito-mcp@1.2.0
                    mcp: io.github.elchin92/avito-mcp

avito-ads v1.0.0   — © avito-tech org (MIT, official Avito Ads SDK)
                    src: https://github.com/avito-tech/avito-ads-sdk-typescript
                    npm: avito-ads@1.0.0

avito-api (lookup) — MissiaL (Apache-2.0)
                    src: https://github.com/MissiaL/avito-api
                    scripts/lookup_endpoint.py — Russian stem-search по OpenAPI
                    TS-порт: Bakugan, MIT. NLTK не используется (только упрощённый
                    2-char slice-fallback из оригинала).
```

## Disclaimer

> "Avito" is a trademark of AO "KEKH eCommerce". This project is not affiliated with, endorsed by, or sponsored by Avito.ru. Use of the Avito API is subject to Avito's Terms of Service (https://www.avito.ru/legal/pro_tools/public-api).
