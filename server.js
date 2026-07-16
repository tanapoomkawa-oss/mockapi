// Local mock of the Fundup AI API (v1.4.0), backed by data/fundings.json
// (a real dump taken from GET /fundings). Mirrors the routes, query params,
// pagination envelope, auth, and error shapes documented at
// https://fundup.ai/api/docs/openapi.json — see README.md for known gaps.
//
// Also includes a mock of PitchBook's Company Search / Company Bio /
// Company Deals / Deal Detail endpoints under /pitchbook/*, using the same
// auth, error shapes, and dispatcher as the routes above.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT) || 4010;
const API_KEY = process.env.FUNDUP_MOCK_API_KEY || 'test_api_key_123';

const PER_MINUTE_LIMIT = 20;
const DAILY_LIMIT = 300;
const MONTHLY_LIMIT = 3000;
const MONTHLY_EXPORT_LIMIT = 3000;
const DAILY_COMPANY_DETAIL_LIMIT = 100;
const MONTHLY_PAGINATION_LIMIT = 200;
const MAX_TOTAL_ACCESSIBLE = 500;
const SERVER_STARTED_AT = Date.now();

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

const fundings = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'data', 'fundings.json'), 'utf-8')
);

const companiesById = new Map();
for (const f of fundings) {
  const c = f.company;
  if (!c || !c.id) continue;
  if (!companiesById.has(c.id)) companiesById.set(c.id, { company: c, fundings: [] });
  companiesById.get(c.id).fundings.push(f);
}
for (const entry of companiesById.values()) {
  entry.fundings.sort((a, b) => new Date(b.fundingAnnounceDate) - new Date(a.fundingAnnounceDate));
}

const filterData = (() => {
  const countries = new Set();
  const currencies = new Set();
  const stages = new Set();
  const industries = new Set();
  const tagsById = new Map();
  for (const f of fundings) {
    if (f.currency) currencies.add(f.currency);
    if (f.stage) stages.add(f.stage);
    const c = f.company;
    if (c) {
      if (c.country) countries.add(c.country);
      if (c.industry && c.industry.name) industries.add(c.industry.name);
      for (const t of c.tags || []) if (t && t.id) tagsById.set(t.id, t);
    }
  }
  return {
    countries: [...countries].sort(),
    currencies: [...currencies].sort(),
    stages: [...stages].sort(),
    industries: [...industries].sort(),
    tags: [...tagsById.values()],
    // Not present anywhere in the dumped dataset:
    company_sizes: [],
    technologyOptions: [],
  };
})();

// ---------------------------------------------------------------------------
// PitchBook mock data
// ---------------------------------------------------------------------------

const pitchbookCompanies = [
  {
    companyId: '300001-11',
    companyName: { formalName: 'Solara Grid Systems', alsoKnownAs: 'Solara' },
    hqLocation: { city: 'Austin', stateProvince: 'Texas', country: 'United States' },
    description: 'Developer of utility-scale solar tracking systems and grid integration software for renewable energy operators.',
    sicCodes: [{ code: '3674', description: 'Solar power generation' }],
    companySocialURLs: { linkedInProfileUrl: 'https://www.linkedin.com/company/solara-grid' },
  },
  {
    companyId: '300002-22',
    companyName: { formalName: 'CarbonForge Technologies' },
    hqLocation: { city: 'Rotterdam', country: 'Netherlands' },
    description: 'Direct air capture and CO2 mineralization technology for industrial decarbonization applications.',
    sicCodes: [{ code: '2819', description: 'Industrial inorganic chemicals' }],
    companySocialURLs: { linkedInProfileUrl: 'https://www.linkedin.com/company/carbonforge' },
  },
  {
    companyId: '300003-33',
    companyName: 'GridPulse',
    hqLocation: null,
    description: 'Smart grid monitoring startup.',
    sicCodes: [],
    companySocialURLs: {},
  },
];

const pitchbookDeals = [
  {
    dealId: '500001-01T', companyId: '300001-11', dealDate: '2026-07-08',
    dealSize: { amount: 12000000, currency: 'USD' },
    dealType1: { code: 'EVC', description: 'Early Stage VC' },
    vcRound: 'Series A',
    dealSynopsis: 'The company raised $12M in a Series A round led by Breakthrough Energy Ventures.',
  },
  {
    dealId: '500001-02T', companyId: '300001-11', dealDate: '2026-07-10',
    dealSize: { amount: 3000000, currency: 'USD' },
    dealType1: { code: 'Debt', description: 'Debt - General' },
    vcRound: null,
    dealSynopsis: 'The company received a $3M venture debt facility from Trinity Capital.',
  },
  {
    dealId: '500002-01T', companyId: '300002-22', dealDate: '2026-07-09',
    dealSize: { amount: 45000000, currency: 'EUR' },
    dealType1: { code: 'LVC', description: 'Later Stage VC' },
    vcRound: 'Series C',
    dealSynopsis: 'The company raised €45M in a Series C round to scale its DAC facility.',
  },
  {
    dealId: '500003-01T', companyId: '300003-33', dealDate: '2026-07-11',
    dealSize: null, dealType1: null, vcRound: 'Seed', dealSynopsis: null,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseAmount(str) {
  if (str == null) return null;
  if (typeof str === 'number') return str;
  const m = String(str).trim().match(/^([\d.]+)\s*([KMB])?$/i);
  if (!m) return null;
  let n = parseFloat(m[1]);
  const suffix = (m[2] || '').toUpperCase();
  if (suffix === 'K') n *= 1e3;
  else if (suffix === 'M') n *= 1e6;
  else if (suffix === 'B') n *= 1e9;
  return n;
}

function toIsoMidnight(dateStr) {
  if (!dateStr) return dateStr;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toISOString().replace(/\.\d+Z$/, '+00:00').replace('Z', '+00:00');
}

function getQueryArray(searchParams, name) {
  const all = [...searchParams.getAll(name + '[]'), ...searchParams.getAll(name)];
  if (all.length === 0) return [];
  return all.flatMap((v) => v.split(',').map((s) => s.trim()).filter(Boolean));
}

function matchesArrayFilter(queryValues, candidates) {
  if (!queryValues || queryValues.length === 0) return true;
  const lowerQ = queryValues.map((v) => v.toLowerCase());
  return candidates.filter(Boolean).some((c) => lowerQ.includes(String(c).toLowerCase()));
}

function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(json);
}

class ApiError extends Error {
  constructor(status, body) {
    super(body.error || 'Error');
    this.status = status;
    this.body = body;
  }
}

// ---------------------------------------------------------------------------
// Filtering (shared by /fundings and /companies)
// ---------------------------------------------------------------------------

function filterFundings(list, q) {
  let result = list;

  if (q.funding_date_start) {
    const start = new Date(q.funding_date_start);
    result = result.filter((f) => new Date(f.fundingAnnounceDate) >= start);
  }
  if (q.funding_date_end) {
    const end = new Date(q.funding_date_end);
    result = result.filter((f) => new Date(f.fundingAnnounceDate) <= end);
  }
  if (q.stages.length) {
    result = result.filter((f) => matchesArrayFilter(q.stages, [f.stage]));
  }
  if (q.countries.length) {
    result = result.filter((f) =>
      matchesArrayFilter(q.countries, [f.company?.country, f.company?.country_name])
    );
  }
  if (q.industries.length) {
    result = result.filter((f) =>
      matchesArrayFilter(q.industries, [f.company?.industry?.name, f.company?.industry?.slug])
    );
  }
  if (q.currency) {
    result = result.filter((f) => (f.currency || '').toLowerCase() === q.currency.toLowerCase());
  }
  if (q.tags.length) {
    result = result.filter((f) =>
      matchesArrayFilter(q.tags, (f.company?.tags || []).flatMap((t) => [t.name, t.slug]))
    );
  }
  if (q.min_amount != null) {
    const min = parseAmount(q.min_amount);
    result = result.filter((f) => {
      const a = parseAmount(f.fundingAmount);
      return min == null || a == null ? true : a >= min;
    });
  }
  if (q.max_amount != null) {
    const max = parseAmount(q.max_amount);
    result = result.filter((f) => {
      const a = parseAmount(f.fundingAmount);
      return max == null || a == null ? true : a <= max;
    });
  }
  if (q.search) {
    const s = q.search.toLowerCase();
    result = result.filter((f) => {
      const c = f.company || {};
      return (
        (c.name || '').toLowerCase().includes(s) ||
        (c.description || '').toLowerCase().includes(s) ||
        (c.industry?.name || '').toLowerCase().includes(s)
      );
    });
  }
  // technologies / company_size / validated_contacts / investors / has_open_roles
  // (+ hiring_departments / hiring_seniority / hiring_role_type): accepted but not
  // applied — the dumped dataset has no tech-stack, headcount, contact-reveal,
  // investor, or hiring data to filter on. See README.md.

  return [...result].sort((a, b) => new Date(b.fundingAnnounceDate) - new Date(a.fundingAnnounceDate));
}

function validatePagination(q, { maxLimit = 50 } = {}) {
  const errors = [];
  let limit = 50;
  if (q.limit !== undefined) {
    limit = Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
      errors.push(`limit must be an integer between 1 and ${maxLimit}`);
    }
  }
  let offset = 0;
  if (q.offset !== undefined) {
    offset = Number(q.offset);
    if (!Number.isInteger(offset) || offset < 0 || offset > MAX_TOTAL_ACCESSIBLE - 1) {
      errors.push(`offset must be an integer between 0 and ${MAX_TOTAL_ACCESSIBLE - 1}`);
    }
  }
  return { limit, offset, errors };
}

function paginate(list, limit, offset) {
  const total = Math.min(list.length, MAX_TOTAL_ACCESSIBLE);
  const clampedOffset = Math.min(offset, MAX_TOTAL_ACCESSIBLE);
  const page = list.slice(clampedOffset, clampedOffset + limit);
  const has_more = clampedOffset + page.length < total;
  return { page, pagination: { limit, offset: clampedOffset, total, has_more } };
}

function parseListQuery(searchParams) {
  return {
    funding_date_start: searchParams.get('funding_date_start'),
    funding_date_end: searchParams.get('funding_date_end'),
    stages: getQueryArray(searchParams, 'stages'),
    countries: getQueryArray(searchParams, 'countries'),
    industries: getQueryArray(searchParams, 'industries'),
    currency: searchParams.get('currency'),
    tags: getQueryArray(searchParams, 'tags'),
    min_amount: searchParams.get('min_amount') ?? searchParams.get('min_funding'),
    max_amount: searchParams.get('max_amount') ?? searchParams.get('max_funding'),
    search: searchParams.get('search'),
  };
}

// ---------------------------------------------------------------------------
// Company detail builders
// ---------------------------------------------------------------------------

function companySummary(f) {
  const c = f.company || {};
  return {
    id: c.id,
    companyName: c.name,
    country: c.country,
    country_name: c.country_name,
    currency: f.currency,
    fundingAmount: f.fundingAmount,
    fundingAnnounceDate: f.fundingAnnounceDate,
    stage: f.stage,
  };
}

function buildCompanyDetail(entry) {
  const { company, fundings: compFundings } = entry;
  return {
    id: company.id,
    companyName: company.name,
    description: company.description || '',
    website: company.website || null,
    linkedinUrl: company.linkedin_url || null,
    country: company.country,
    country_name: company.country_name,
    industries: company.industry ? [company.industry.name] : [],
    tags: company.tags || [],
    total_fundings: compFundings.length,
    fundings: compFundings.map((f) => ({
      id: f.id,
      fundingAmount: f.fundingAmount,
      fundingAnnounceDate: f.fundingAnnounceDate,
      stage: f.stage,
    })),
    // Not present anywhere in the dumped dataset:
    contacts: [],
    total_contacts: 0,
    tech_stack: null,
    highlights: [],
    funding_news: [],
  };
}

// ---------------------------------------------------------------------------
// Rate limiting / stats (per_minute is actually enforced; the daily/monthly/
// pagination/company-detail budgets below are surfaced via GET /stats for
// realism but are not enforced — see README.md)
// ---------------------------------------------------------------------------

const perMinuteWindows = new Map(); // apiKey -> timestamps[]
const stats = {
  total_requests: 0,
  successful_requests: 0,
  failed_requests: 0,
  endpoints_used: new Set(),
  daily_usage: new Map(),
};

function checkAndTrackRateLimit(apiKey) {
  const now = Date.now();
  const arr = (perMinuteWindows.get(apiKey) || []).filter((t) => now - t < 60000);
  perMinuteWindows.set(apiKey, arr);
  if (arr.length >= PER_MINUTE_LIMIT) {
    return false;
  }
  return true;
}

function recordSuccess(apiKey, endpoint) {
  const arr = perMinuteWindows.get(apiKey) || [];
  arr.push(Date.now());
  perMinuteWindows.set(apiKey, arr);

  stats.successful_requests += 1;
  stats.endpoints_used.add(endpoint);
  const day = new Date().toISOString().slice(0, 10);
  stats.daily_usage.set(day, (stats.daily_usage.get(day) || 0) + 1);
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

function handleHealth(req, res) {
  sendJson(res, 200, {
    message: 'API is running',
    status: 'healthy',
    timestamp: Math.floor(Date.now() / 1000),
    version: '1.4.0',
  });
}

function handleFundings(req, res, searchParams) {
  const listQuery = parseListQuery(searchParams);
  if (!listQuery.funding_date_start || !listQuery.funding_date_end) {
    throw new ApiError(400, {
      error: 'Bad Request',
      message: 'funding_date_start and funding_date_end are required',
    });
  }
  const { limit, offset, errors } = validatePagination(
    Object.fromEntries(searchParams.entries())
  );
  if (errors.length) throw new ApiError(400, { error: 'Bad Request', message: errors.join('; ') });

  const filtered = filterFundings(fundings, listQuery);
  const { page, pagination } = paginate(filtered, limit, offset);
  sendJson(res, 200, { data: page, pagination });
}

function handleCompaniesList(req, res, searchParams) {
  const listQuery = parseListQuery(searchParams);
  if (!listQuery.funding_date_start || !listQuery.funding_date_end) {
    throw new ApiError(400, {
      error: 'Bad Request',
      message: 'funding_date_start and funding_date_end are required',
    });
  }
  const { limit, offset, errors } = validatePagination(
    Object.fromEntries(searchParams.entries())
  );
  if (errors.length) throw new ApiError(400, { error: 'Bad Request', message: errors.join('; ') });

  const filtered = filterFundings(fundings, listQuery);
  const latestPerCompany = new Map();
  for (const f of filtered) {
    const id = f.company?.id;
    if (!id) continue;
    const existing = latestPerCompany.get(id);
    if (!existing || new Date(f.fundingAnnounceDate) > new Date(existing.fundingAnnounceDate)) {
      latestPerCompany.set(id, f);
    }
  }
  const companyList = [...latestPerCompany.values()]
    .sort((a, b) => new Date(b.fundingAnnounceDate) - new Date(a.fundingAnnounceDate))
    .map(companySummary);

  const { page, pagination } = paginate(companyList, limit, offset);
  sendJson(res, 200, { data: page, pagination });
}

function handleCompanyDetail(req, res, companyId) {
  const entry = companiesById.get(companyId);
  if (!entry) throw new ApiError(404, { error: 'Company not found', message: 'The requested company could not be found' });
  sendJson(res, 200, buildCompanyDetail(entry));
}

function handleCompanyFundings(req, res, companyId) {
  const entry = companiesById.get(companyId);
  if (!entry) throw new ApiError(404, { error: 'Company not found' });
  const data = entry.fundings.map((f) => ({
    companyId,
    currency: f.currency,
    fundingAmount: f.fundingAmount,
    fundingAmountUsd: f.currency === 'USD' ? parseAmount(f.fundingAmount) : null,
    fundingAnnounceDate: toIsoMidnight(f.fundingAnnounceDate),
    id: f.id,
    stage: f.stage,
    // Not present anywhere in the dumped dataset:
    investors: [],
  }));
  sendJson(res, 200, { data });
}

function handleCompanyContacts(req, res, companyId) {
  const entry = companiesById.get(companyId);
  if (!entry) throw new ApiError(404, { error: 'Company not found' });
  throw new ApiError(404, {
    code: 'CONTACTS_NOT_AVAILABLE',
    error: 'Contacts not available via API for this company.',
    hint: 'Contacts are returned during the 30-day fresh window after funding, or if you have revealed this company via the Fundup AI dashboard.',
  });
}

function handleCompanyTechStack(req, res, companyId) {
  const entry = companiesById.get(companyId);
  if (!entry) throw new ApiError(404, { error: 'Company not found' });
  throw new ApiError(404, { error: 'Tech stack not found' });
}

function handleCompanyHighlights(req, res, companyId) {
  const entry = companiesById.get(companyId);
  if (!entry) throw new ApiError(404, { error: 'Company not found' });
  throw new ApiError(404, { code: 'HIGHLIGHTS_NOT_FOUND', error: 'No highlights found for this company' });
}

function handleCompanyNews(req, res, companyId) {
  const entry = companiesById.get(companyId);
  if (!entry) throw new ApiError(404, { error: 'Company not found' });
  throw new ApiError(404, { code: 'NEWS_NOT_FOUND', error: 'No news found for this company' });
}

function handleCompanyOpenRoles(req, res, companyId, searchParams) {
  const entry = companiesById.get(companyId);
  if (!entry) throw new ApiError(404, { error: 'Company not found' });

  let page = Number(searchParams.get('page') ?? 1);
  let per_page = Number(searchParams.get('per_page') ?? 25);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(per_page) || per_page < 1 || per_page > 50) {
    throw new ApiError(400, { error: 'page and per_page must be positive integers' });
  }
  // Not present anywhere in the dumped dataset -> always empty.
  sendJson(res, 200, { data: [], pagination: { has_more: false, page, per_page, total: 0 } });
}

function handleFilters(req, res) {
  sendJson(res, 200, {
    data: filterData,
    success: true,
    timestamp: Math.floor(Date.now() / 1000),
  });
}

function handleStats(req, res) {
  const now = Date.now();
  const perMinuteUsed = (perMinuteWindows.get(API_KEY) || []).filter((t) => now - t < 60000).length;
  const dailyUsage = [...stats.daily_usage.entries()].map(([date, requests]) => ({ date, requests }));

  sendJson(res, 200, {
    api_key: {
      created_at: Math.floor(SERVER_STARTED_AT / 1000),
      last_used_at: Math.floor(now / 1000),
      name: 'Mock Test Key',
      type: 'test',
    },
    average_response_time: 0,
    daily_usage: dailyUsage,
    endpoints_used: [...stats.endpoints_used],
    failed_requests: stats.failed_requests,
    rate_limits: {
      per_minute: { limit: PER_MINUTE_LIMIT, used: perMinuteUsed, remaining: Math.max(0, PER_MINUTE_LIMIT - perMinuteUsed), reset_unix: Math.floor(now / 1000) + 60 },
      daily: { limit: DAILY_LIMIT, used: stats.total_requests, remaining: Math.max(0, DAILY_LIMIT - stats.total_requests), reset_unix: Math.floor(now / 1000) + 86400 },
      monthly: { limit: MONTHLY_LIMIT, used: stats.total_requests, remaining: Math.max(0, MONTHLY_LIMIT - stats.total_requests), reset_unix: Math.floor(now / 1000) + 30 * 86400 },
      monthly_export: { limit: MONTHLY_EXPORT_LIMIT, used: 0, remaining: MONTHLY_EXPORT_LIMIT, reset_unix: Math.floor(now / 1000) + 30 * 86400 },
      daily_company_detail: { limit: DAILY_COMPANY_DETAIL_LIMIT, used: 0, remaining: DAILY_COMPANY_DETAIL_LIMIT, reset_unix: Math.floor(now / 1000) + 86400 },
      monthly_pagination: { limit: MONTHLY_PAGINATION_LIMIT, used: 0, remaining: MONTHLY_PAGINATION_LIMIT, reset_unix: Math.floor(now / 1000) + 30 * 86400 },
    },
    successful_requests: stats.successful_requests,
    total_requests: stats.total_requests,
    user_rate_limit: MONTHLY_LIMIT,
  });
}

// ---------------------------------------------------------------------------
// PitchBook route handlers
// ---------------------------------------------------------------------------

function handlePitchbookCompanySearch(req, res, searchParams) {
  const dealDateParam = searchParams.get('dealDate'); // e.g. ">2026-07-08", "<2026-07-09", or "2026-07-08^2026-07-10"

  let matchingCompanyIds = new Set(pitchbookCompanies.map((c) => c.companyId));

  if (dealDateParam) {
    let lowerBound = null;
    let upperBound = null;

    if (dealDateParam.includes('^')) {
      const [start, end] = dealDateParam.split('^');
      lowerBound = start;
      upperBound = end;
    } else if (dealDateParam[0] === '>') {
      lowerBound = dealDateParam.slice(1);
    } else if (dealDateParam[0] === '<') {
      upperBound = dealDateParam.slice(1);
    }

    matchingCompanyIds = new Set(
      pitchbookDeals
        .filter((d) => {
          if (lowerBound && d.dealDate < lowerBound) return false;
          if (upperBound && d.dealDate > upperBound) return false;
          return true;
        })
        .map((d) => d.companyId)
    );
  }

  const items = pitchbookCompanies
    .filter((c) => matchingCompanyIds.has(c.companyId))
    .map((c) => ({
      companyId: c.companyId,
      companyName: typeof c.companyName === 'string' ? c.companyName : c.companyName.formalName,
      website: `www.${c.companyId}.com`,
    }));

  sendJson(res, 200, { stats: { total: items.length, perPage: 25, page: 1, lastPage: 1 }, items });
}

function handlePitchbookCompanyBio(req, res, companyId) {
  const company = pitchbookCompanies.find((c) => c.companyId === companyId);
  if (!company) throw new ApiError(404, { error: 'Company not found' });
  sendJson(res, 200, company);
}

function handlePitchbookCompanyDeals(req, res, companyId) {
  const companyDeals = pitchbookDeals
    .filter((d) => d.companyId === companyId)
    .map((d) => ({ dealId: d.dealId, companyId: d.companyId, dealDate: d.dealDate, dealType1: d.dealType1 }));
  sendJson(res, 200, companyDeals);
}

function handlePitchbookDealDetail(req, res, dealId) {
  const deal = pitchbookDeals.find((d) => d.dealId === dealId);
  if (!deal) throw new ApiError(404, { error: 'Deal not found' });
  sendJson(res, 200, deal);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host}`);
  } catch {
    return sendJson(res, 400, { error: 'Bad Request', message: 'Invalid URL' });
  }

  let pathname = url.pathname.replace(/\/+$/, '') || '/';
  if (pathname.startsWith('/api/v1')) pathname = pathname.slice('/api/v1'.length) || '/';
  const parts = pathname.split('/').filter(Boolean);
  const sp = url.searchParams;

  // GET /health is unauthenticated and unmetered (standard for health checks).
  if (req.method === 'GET' && parts.length === 1 && parts[0] === 'health') {
    return handleHealth(req, res);
  }

  // --- Auth ---
  const authHeader = req.headers['authorization'] || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const providedKey = match ? match[1].trim() : null;
  if (!providedKey || providedKey !== API_KEY) {
    return sendJson(res, 401, { error: 'Invalid API key' });
  }

  // --- Rate limit (per-minute; only 2xx responses count, per API docs) ---
  stats.total_requests += 1;
  if (!checkAndTrackRateLimit(API_KEY)) {
    stats.failed_requests += 1;
    return sendJson(res, 429, {
      detail: 'rate_limit_exceeded',
      error: `Per-minute rate limit exceeded (${PER_MINUTE_LIMIT} requests per minute). Retry after 60 seconds.`,
      limit: PER_MINUTE_LIMIT,
      limit_type: 'per_minute',
      retry_after: 60,
      used: PER_MINUTE_LIMIT,
    });
  }

  try {
    if (req.method !== 'GET') {
      throw new ApiError(404, { error: 'Not found' });
    }

    if (parts.length === 1 && parts[0] === 'fundings') {
      handleFundings(req, res, sp);
      recordSuccess(API_KEY, 'get_fundings');
    } else if (parts.length === 1 && parts[0] === 'companies') {
      handleCompaniesList(req, res, sp);
      recordSuccess(API_KEY, 'get_companies');
    } else if (parts.length === 1 && parts[0] === 'filters') {
      handleFilters(req, res);
      recordSuccess(API_KEY, 'get_filters');
    } else if (parts.length === 1 && parts[0] === 'stats') {
      handleStats(req, res);
      recordSuccess(API_KEY, 'get_stats');
    } else if (parts[0] === 'companies' && parts.length === 2) {
      handleCompanyDetail(req, res, decodeURIComponent(parts[1]));
      recordSuccess(API_KEY, 'get_company');
    } else if (parts[0] === 'companies' && parts.length === 3) {
      const companyId = decodeURIComponent(parts[1]);
      const sub = parts[2];
      if (sub === 'fundings') {
        handleCompanyFundings(req, res, companyId);
        recordSuccess(API_KEY, 'get_company_fundings');
      } else if (sub === 'contacts') {
        handleCompanyContacts(req, res, companyId);
        recordSuccess(API_KEY, 'get_company_contacts');
      } else if (sub === 'tech-stack') {
        handleCompanyTechStack(req, res, companyId);
        recordSuccess(API_KEY, 'get_company_tech_stack');
      } else if (sub === 'highlights') {
        handleCompanyHighlights(req, res, companyId);
        recordSuccess(API_KEY, 'get_company_highlights');
      } else if (sub === 'news') {
        handleCompanyNews(req, res, companyId);
        recordSuccess(API_KEY, 'get_company_news');
      } else if (sub === 'open-roles') {
        handleCompanyOpenRoles(req, res, companyId, sp);
        recordSuccess(API_KEY, 'get_company_open_roles');
      } else {
        throw new ApiError(404, { error: 'Not found' });
      }
    } else if (parts[0] === 'pitchbook' && parts[1] === 'company' && parts[2] === 'search' && parts.length === 3) {
      handlePitchbookCompanySearch(req, res, sp);
      recordSuccess(API_KEY, 'get_pitchbook_company_search');
    } else if (parts[0] === 'pitchbook' && parts[1] === 'company' && parts.length === 3) {
      handlePitchbookCompanyBio(req, res, decodeURIComponent(parts[2]));
      recordSuccess(API_KEY, 'get_pitchbook_company_bio');
    } else if (parts[0] === 'pitchbook' && parts[1] === 'company' && parts.length === 4 && parts[3] === 'deals') {
      handlePitchbookCompanyDeals(req, res, decodeURIComponent(parts[2]));
      recordSuccess(API_KEY, 'get_pitchbook_company_deals');
    } else if (parts[0] === 'pitchbook' && parts[1] === 'deal' && parts.length === 3) {
      handlePitchbookDealDetail(req, res, decodeURIComponent(parts[2]));
      recordSuccess(API_KEY, 'get_pitchbook_deal_detail');
    } else {
      throw new ApiError(404, { error: 'Not found' });
    }
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status >= 500) stats.failed_requests += 1;
      sendJson(res, err.status, err.body);
    } else {
      stats.failed_requests += 1;
      console.error(err);
      sendJson(res, 500, { error: 'Internal Server Error' });
    }
  }
});

server.listen(PORT, () => {
  console.log(`Fundup AI mock API listening on http://localhost:${PORT}/api/v1`);
  console.log(`Loaded ${fundings.length} funding records across ${companiesById.size} companies`);
  console.log(`API key: ${API_KEY} (send as "Authorization: Bearer ${API_KEY}")`);
});
