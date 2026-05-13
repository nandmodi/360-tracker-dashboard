/**
 * api/data.js — Vercel Serverless Function
 * Fetches Spyne Metabase data with aggressive caching so the
 * dashboard loads instantly after the first hit.
 *
 * Cache strategy:
 *  - In-memory: data is reused for CACHE_TTL_MS within the same
 *    warm function instance (instant — no network call)
 *  - HTTP headers: CDN/browser caches the response for 60 s,
 *    stale-while-revalidate for 5 min in the background
 *  - Force-refresh: add ?force=1 to bypass cache (Sync button)
 */

const UUID         = "7f9326d8-9eb9-4cc2-bded-efb1aac967db";
const METABASE_URL = `https://metabase.spyne.ai/api/public/card/${UUID}/query/json`;

const SLA_THRESHOLD_HOURS = 24;  // TAT <= 24 h → Within SLA
const CACHE_TTL_MS        = 5 * 60 * 1000; // 5 minutes in-memory cache

// ── In-memory cache ───────────────────────────────────────────────────────────
let _cache = null; // { rows, lastSynced, ts }

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseDate(s) {
  if (!s) return null;
  const clean = String(s).trim().replace(/"/g, "");
  const d1 = new Date(clean);
  if (!isNaN(d1.getTime())) return d1;
  const d2 = new Date(clean.replace(/,/g, ""));
  return isNaN(d2.getTime()) ? null : d2;
}

function mapStatus(finalStatus, crmStatus) {
  const fs = String(finalStatus || "").trim().toLowerCase();
  const cs = String(crmStatus  || "").trim().toLowerCase();
  if (fs === "delivered")                          return { crm: "qc_done",    ver: "verified" };
  if (fs === "qc failed" || fs === "rejected")     return { crm: "qc_done",    ver: "rejected" };
  if (cs === "qc_done")                            return { crm: "qc_done",    ver: "none"     };
  return                                                  { crm: cs || "processing", ver: "none" };
}

function mapRow(r) {
  const createdAt = parseDate(r.createdAt);
  const finalTime = parseDate(r.final_time);
  let tat = null;
  if (createdAt && finalTime) {
    const ms = finalTime.getTime() - createdAt.getTime();
    if (ms >= 0) tat = ms / 3_600_000;
  }

  const { crm, ver } = mapStatus(r.final_status, r.crm_status);
  let sla = null;
  if (tat !== null && (ver === "verified" || ver === "rejected")) {
    sla = tat <= SLA_THRESHOLD_HOURS ? 1 : 0;
  }

  return {
    c:    r.createdAt,
    u:    r.final_time,
    ent:  r.enterprise_name,
    team: r.team_name,
    qc:   r.qc_user,
    poc_ob: null,
    poc_cs: null,
    crm, ver, sla, tat,
    rej:   r.failure_reason  || null,
    vid:   r.mediaId         || r["ss.spin_id"],
    vurl:  null,
    vmode: r["fd.platform"],
    ttype: r.input_type,
    vin:   r.vinName,
    sku:   r.spin_sku_id,
    // extra
    final_status:         r.final_status,
    issues_by_severity:   r.issues_by_severity,
    is_assisted_by_qc:    r.is_assisted_by_qc,
    placement_logic:      r.placement_logic,
    retry_count:          r.retry_count,
    exterior_image_count: r.exterior_image_count,
    version_count:        r.version_count,
    platform:             r["fd.platform"],
    source:               r["fd.source"],
  };
}

// ── Fetch + transform from Metabase ───────────────────────────────────────────
async function fetchFromMetabase() {
  const t0 = Date.now();
  const response = await fetch(METABASE_URL);
  if (!response.ok) throw new Error(`Metabase error: ${response.status}`);

  const raw = await response.json();

  let rawRows = [];
  if (Array.isArray(raw)) {
    rawRows = raw;
  } else if (raw?.data?.rows && raw?.data?.cols) {
    const cols = raw.data.cols.map(c => c.display_name || c.name);
    rawRows = raw.data.rows.map(r => Object.fromEntries(r.map((v, i) => [cols[i], v])));
  } else if (Array.isArray(raw?.rows)) {
    rawRows = raw.rows;
  }

  const rows        = rawRows.map(mapRow);
  const lastSynced  = new Date().toISOString();
  const delivered   = rows.filter(r => r.crm === "qc_done" && r.ver === "verified").length;
  const rejected    = rows.filter(r => r.crm === "qc_done" && r.ver === "rejected").length;
  const pending     = rows.filter(r => r.crm !== "qc_done").length;

  console.log(`[api/data] fetched ${rows.length} rows in ${Date.now()-t0}ms — D:${delivered} R:${rejected} P:${pending}`);
  return { rows, lastSynced, meta: { total: rows.length, delivered, rejected, pending } };
}

// ── Handler ───────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const force = req.query?.force === "1";

  try {
    const now = Date.now();

    // Return in-memory cache if fresh and not forced
    if (!force && _cache && (now - _cache.ts) < CACHE_TTL_MS) {
      console.log(`[api/data] cache hit — age ${Math.round((now - _cache.ts)/1000)}s`);
      res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
      res.setHeader("X-Cache", "HIT");
      return res.status(200).json({ rows: _cache.rows, lastSynced: _cache.lastSynced, meta: _cache.meta });
    }

    // Cache miss — fetch fresh data
    const payload = await fetchFromMetabase();
    _cache = { ...payload, ts: now };

    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
    res.setHeader("X-Cache", "MISS");
    res.status(200).json(payload);

  } catch (err) {
    console.error("[api/data] error:", err.message);

    // Return stale cache on error rather than failing completely
    if (_cache) {
      console.log("[api/data] returning stale cache due to error");
      res.setHeader("X-Cache", "STALE");
      return res.status(200).json({ rows: _cache.rows, lastSynced: _cache.lastSynced, meta: _cache.meta });
    }

    res.status(500).json({ error: err.message });
  }
};
