# HK Company Worker (Cloudflare)

Cloudflare Worker version of your Railway proxy.

## Endpoints (same as before)

- `POST /api/search` with body:
  - `{ "search_type": "brn" | "company", "search_input": "..." }`
- `GET /api/search?q=xxx&type=brn|company`
- `GET /api/company/:cr_no`
- `GET /health`

## Features

- CORS (`CORS_ORIGIN` var)
- Basic rate limit (best-effort per worker instance)
- Edge cache via `caches.default` (`CACHE_TTL_SEC`)
- Upstream timeout + error handling

## Deploy (no terminal version)

1. Create a GitHub repo named `hk-company-worker`.
2. Upload these files/folders:
   - `wrangler.toml`
   - `package.json`
   - `src/worker.js`
   - `README.md`
3. In Cloudflare Dashboard:
   - **Workers & Pages** -> **Create** -> **Import a repository**
   - Select `hk-company-worker`
   - Build command: `npm install`
   - Deploy command: `npm run deploy`
4. In Worker Settings -> Variables, set if needed:
   - `CORS_ORIGIN` = `*` or `https://rtchk.com`
   - `DATA_GOV_HK_BASE_URL` = `https://data.cr.gov.hk/cr/api/api/v1/api_builder/csv/local`
   - `CACHE_TTL_SEC` = `300`
   - `RATE_LIMIT_MAX_PER_MIN` = `60`
5. After deploy, copy worker URL and update Squarespace:
   - `const API_URL = 'https://your-worker.your-subdomain.workers.dev';`

## Important

In Squarespace `API_URL`, make sure it starts with `https://`.
