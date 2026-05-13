/**
 * api/data.js — Vercel Serverless Function
 * Uses /query (columnar, 820 KB) instead of /query/json (89 MB)
 */

const UUID         = "7f9326d8-9eb9-4cc2-bded-efb1aac967db";
const METABASE_URL = `https://metabase.spyne.ai/api/public/card/${UUID}/query`;

const SLA_THRESHOLD_HOURS = 24;
const CACHE_TTL_MS        = 5 * 60 * 1000; // 5 min

let _cache = null;

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseDate(s) {
  if (!s) return null;
  const d = new Date(String(s).trim());
  return isNaN(d.getTime()) ? null : d;
}

function mapStatus(finalStatus, crmStatus) {
  const fs = String(finalStatus || "").trim().toLowerCase();
  const cs = String(crmStatus  || "").trim().toLowerCase();
  if (fs === "delivered")                      return { crm: "qc_done", ver: "verified" };
  if (fs === "qc failed" || fs === "rejected") return { crm: "qc_done", ver: "rejected" };
  if (cs === "qc_done")                        return { crm: "qc_done", ver: "none"     };
  return                                              { crm: cs || "processing", ver: "none" };
}

function mapRow(r) {
  const createdAt = parseDate(r.createdAt);
  const finalTime = parseDate(r.final_time);

  let tat = null;
  if (createdAt && finalTime) {
    const ms = finalTime.getTime() - createdAt.getTime();
    if (ms >= 0) tat = ms / 3_600_000; // hours
  }

  // total_qc_time from Metabase overrides computed TAT if available
  if (r.total_qc_time != null && !isNaN(+r.total_qc_time)) {
    tat = +r.total_qc_time / 60; // assume minutes → convert to hours
  }

  const { crm, ver } = mapStatus(r.final_status, r.crm_status);

  let sla = null;
  if (tat !== null && (ver === "verified" || ver === "rejected"))
    sla = tat <= SLA_THRESHOLD_HOURS ? 1 : 0;

  return {
    // Core dashboard fields
    c:      r.createdAt,
    u:      r.final_time,
    ent:    r.enterprise_name,
    team:   r.team_name,
    qc:     r.qc_user,
    poc_ob: null,
    poc_cs: null,
    crm, ver, sla, tat,
    rej:    r.failure_reason  || null,
    vid:    r.mediaId         || r["ss.spin_id"],
    vurl:   null,
    vmode:  r["fd.platform"],
    ttype:  r.input_type,
    vin:    r.vinName,
    sku:    r.spin_sku_id,
    // Extra fields
    final_status:         r.final_status,
    issues_by_severity:   r.issues_by_severity,
    is_assisted_by_qc:    r.is_assisted_by_qc,
    placement_logic:      r.placement_logic,
    retry_count:          r.retry_count,
    exterior_image_count: r.exterior_image_count,
    version_count:        r.version_count,
    total_qc_time:        r.total_qc_time,
    platform:             r["fd.platform"],
    source:               r["fd.source"],
  };
}

// ── Fetch from Metabase ───────────────────────────────────────────────────────
async function fetchFromMetabase() {
  const t0 = Date.now();

  const response = await fetch(METABASE_URL);

  // Metabase /query returns 202 Accepted (normal — data is in body)
  if (response.status !== 200 && response.status !== 202) {
    throw new Error(`Metabase HTTP ${response.status}`);
  }

  const raw = await response.json();

  // Columnar format: { data: { cols: [{name},...], rows: [[v,v,v],[v,v,v]] } }
  if (!raw?.data?.cols || !Array.isArray(raw?.data?.rows)) {
    throw new Error(`Unexpected Metabase format. Keys: ${Object.keys(raw || {}).join(", ")}`);
  }

  const cols    = raw.data.cols.map(c => c.display_name || c.name);
  const rawRows = raw.data.rows.map(r =>
    Object.fromEntries(r.map((v, i) => [cols[i], v]))
  );

  console.log(`[api/data] cols: ${cols.join(", ")}`);
  console.log(`[api/data] ${rawRows.length} rows fetched in ${Date.now() - t0}ms`);

  const rows      = rawRows.map(mapRow);
  const delivered = rows.filter(r => r.crm === "qc_done" && r.ver === "verified").length;
  const rejected  = rows.filter(r => r.crm === "qc_done" && r.ver === "rejected").length;
  const pending   = rows.filter(r => r.crm !== "qc_done").length;

  console.log(`[api/data] D:${delivered} R:${rejected} P:${pending}`);

  return {
    rows,
    lastSynced: new Date().toISOString(),
    meta: { total: rows.length, delivered, rejected, pending },
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const force = req.query?.force === "1";

  try {
    const now = Date.now();

    if (!force && _cache && (now - _cache.ts) < CACHE_TTL_MS) {
      res.setHeader("X-Cache", "HIT");
      res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
      return res.status(200).json({ rows: _cache.rows, lastSynced: _cache.lastSynced, meta: _cache.meta });
    }

    const payload = await fetchFromMetabase();
    _cache = { ...payload, ts: now };

    res.setHeader("X-Cache", "MISS");
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
    res.status(200).json(payload);

  } catch (err) {
    console.error("[api/data] error:", err.message);
    if (_cache) {
      res.setHeader("X-Cache", "STALE");
      return res.status(200).json({ rows: _cache.rows, lastSynced: _cache.lastSynced, meta: _cache.meta });
    }
    res.status(500).json({ error: err.message });
  }
};
