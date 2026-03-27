const DEFAULT_BASE_URL = "https://data.cr.gov.hk/cr/api/api/v1/api_builder/csv/local";

const localRateWindow = new Map();

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseCsvToResults(csvText) {
  const lines = (csvText || "")
    .trim()
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter(Boolean);
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]).map((h) => h.replace(/^"|"$/g, ""));
  const results = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]).map((v) => v.replace(/^"|"$/g, ""));
    const row = {};
    headers.forEach((h, j) => {
      row[h] = values[j] || "";
    });

    results.push({
      BRN: row.Brn || "",
      "Company Name (Chinese)": row.Chinese_Company_Name || "",
      "Company Name (English)": row.English_Company_Name || "",
      "Registered Address": row.Address_of_Registered_Office || "",
      Status: row.Company_Type || "",
      "Incorporation Date": row.Date_of_Incorporation || "",
    });
  }

  return results;
}

function checkRateLimit(ip, maxPerMin) {
  const minute = Math.floor(Date.now() / 60000);
  const key = `${ip}:${minute}`;
  const current = localRateWindow.get(key) || 0;
  if (current >= maxPerMin) return false;
  localRateWindow.set(key, current + 1);
  return true;
}

async function fetchCrCsv(baseUrl, key1, key2, key3) {
  const url = `${baseUrl}/search?query[0][key1]=${encodeURIComponent(
    key1
  )}&query[0][key2]=${encodeURIComponent(key2)}&query[0][key3]=${encodeURIComponent(
    key3
  )}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), 15000);
  let res;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "text/csv, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent":
          "Mozilla/5.0 (compatible; RTC-CompanySearch-Worker/1.0; +https://rtc-companysearch.chrislau.workers.dev)",
        Referer: "https://data.cr.gov.hk/",
        Origin: "https://data.cr.gov.hk",
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new Error(`Upstream HTTP ${res.status}`);
  }

  const txt = await res.text();
  return parseCsvToResults(txt);
}

function cacheKeyRequest(url) {
  return new Request(url, { method: "GET" });
}

async function getCachedJson(cache, keyUrl) {
  const res = await cache.match(cacheKeyRequest(keyUrl));
  if (!res) return null;
  return await res.json();
}

async function putCachedJson(cache, keyUrl, payload, ttlSec) {
  const res = new Response(JSON.stringify(payload), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${ttlSec}`,
    },
  });
  await cache.put(cacheKeyRequest(keyUrl), res);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = env.CORS_ORIGIN || "*";
    const headers = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    if (url.pathname === "/health") {
      return json({ ok: true, service: "hk-company-worker" }, 200, headers);
    }

    if (!url.pathname.startsWith("/api/")) {
      return json({ success: false, error: "Not found" }, 404, headers);
    }

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const limit = Number(env.RATE_LIMIT_MAX_PER_MIN || "60");
    if (!checkRateLimit(ip, limit)) {
      return json(
        { success: false, error: "Rate limit exceeded. Try again later." },
        429,
        headers
      );
    }

    const baseUrl = (env.DATA_GOV_HK_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
    const ttlSec = Math.max(0, Number(env.CACHE_TTL_SEC || "300"));
    const cache = caches.default;

    try {
      // GET /api/search?q=xxx&type=brn|company
      if (request.method === "GET" && url.pathname === "/api/search") {
        const q = (url.searchParams.get("q") || "").trim();
        const type = (url.searchParams.get("type") || "brn").toLowerCase();
        if (!q) {
          return json({ success: false, error: "Missing query parameter: q" }, 400, headers);
        }
        if (type !== "brn" && type !== "company") {
          return json({ success: false, error: "Invalid type; use brn or company" }, 400, headers);
        }

        const cacheUrl = `${url.origin}/__cache/search?type=${encodeURIComponent(type)}&q=${encodeURIComponent(q)}`;
        if (ttlSec > 0) {
          const cached = await getCachedJson(cache, cacheUrl);
          if (cached) return json({ ...cached, cached: true }, 200, headers);
        }

        const key1 = type === "brn" ? "Brn" : "Comp_name";
        const key2 = type === "brn" ? "equal" : "begins_with";
        const results = await fetchCrCsv(baseUrl, key1, key2, q);
        const payload = { success: true, results };
        if (ttlSec > 0) await putCachedJson(cache, cacheUrl, payload, ttlSec);
        return json(payload, 200, headers);
      }

      // GET /api/company/:cr_no
      if (request.method === "GET" && url.pathname.startsWith("/api/company/")) {
        const crNo = decodeURIComponent(url.pathname.replace("/api/company/", "")).trim();
        if (!crNo) return json({ success: false, error: "Missing company number (BRN)" }, 400, headers);

        const cacheUrl = `${url.origin}/__cache/company?cr_no=${encodeURIComponent(crNo)}`;
        if (ttlSec > 0) {
          const cached = await getCachedJson(cache, cacheUrl);
          if (cached) return json({ ...cached, cached: true }, 200, headers);
        }

        const results = await fetchCrCsv(baseUrl, "Brn", "equal", crNo);
        const payload = { success: true, results };
        if (ttlSec > 0) await putCachedJson(cache, cacheUrl, payload, ttlSec);
        return json(payload, 200, headers);
      }

      // POST /api/search with { search_type, search_input } (Squarespace compatible)
      if (request.method === "POST" && url.pathname === "/api/search") {
        let body;
        try {
          body = await request.json();
        } catch {
          return json({ success: false, error: "Invalid JSON body" }, 400, headers);
        }

        const searchType = ((body && body.search_type) || "brn").toLowerCase();
        const searchInput = ((body && body.search_input) || "").toString().trim();
        if (!searchInput) {
          return json({ success: false, error: "No search input provided" }, 400, headers);
        }

        const type = searchType === "company" ? "company" : "brn";
        const term = searchInput.split(/\s+/)[0];
        const cacheUrl = `${url.origin}/__cache/post-search?type=${encodeURIComponent(type)}&term=${encodeURIComponent(term)}&full=${encodeURIComponent(searchInput)}`;
        if (ttlSec > 0) {
          const cached = await getCachedJson(cache, cacheUrl);
          if (cached) return json({ ...cached, cached: true }, 200, headers);
        }

        let allResults = [];
        if (type === "brn" && /\s+/.test(searchInput)) {
          const brns = searchInput.split(/\s+/).filter(Boolean);
          for (const brn of brns) {
            const list = await fetchCrCsv(baseUrl, "Brn", "equal", brn);
            allResults = allResults.concat(list);
          }
        } else {
          const key1 = type === "brn" ? "Brn" : "Comp_name";
          const key2 = type === "brn" ? "equal" : "begins_with";
          allResults = await fetchCrCsv(baseUrl, key1, key2, searchInput);
        }

        const payload = { success: true, results: allResults };
        if (ttlSec > 0) await putCachedJson(cache, cacheUrl, payload, ttlSec);
        return json(payload, 200, headers);
      }

      return json({ success: false, error: "Not found" }, 404, headers);
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      const code = msg.includes("timeout") ? 504 : 502;
      return json({ success: false, error: msg || "Upstream request failed" }, code, headers);
    }
  },
};
