/**
 * api/data.js
 * Uses /query/json (full dataset) instead of /query (2000-row limit).
 * Streams + parses the large JSON response efficiently.
 */

const UUID = "7f9326d8-9eb9-4cc2-bded-efb1aac967db";
const BASE = "https://metabase.spyne.ai";

const SLA_THRESHOLD_HOURS = 6;
const CACHE_TTL_MS        = 5 * 60 * 1000;  // 5 min — near-live refresh

let _cache = null;

// ── Simple CSV parser ─────────────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.split('\n');
  if (!lines.length) return [];
  // Parse headers
  const headers = parseCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const vals = parseCSVLine(line);
    const row = {};
    headers.forEach((h, idx) => { row[h] = vals[idx] ?? ''; });
    rows.push(row);
  }
  return rows;
}

function parseCSVLine(line) {
  const result = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i+1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === ',' && !inQ) {
      result.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}

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
  const createdAt   = parseDate(r.createdAt);
  const finalTime   = parseDate(r.final_time);
  const firstQcDone = parseDate(r.first_qc_done);  // preferred for TAT/SLA

  // TAT = first_qc_done - createdAt  (fallback: final_time - createdAt)
  const tatTime = firstQcDone || finalTime;
  let tat = null;
  if (createdAt && tatTime) {
    const ms = tatTime.getTime() - createdAt.getTime();
    if (ms > 0) tat = parseFloat((ms / 3_600_000).toFixed(3));
  }

  // E2E TAT always uses final_time - createdAt (regardless of first_qc_done)
  let e2e_tat = null;
  if (createdAt && finalTime) {
    const ms2 = finalTime.getTime() - createdAt.getTime();
    if (ms2 > 0) e2e_tat = parseFloat((ms2 / 3_600_000).toFixed(3));
  }

  const fs = (r.final_status || '').trim();

  // SLA = TAT ≤ 6h, exclude Under Review only
  let sla = null;
  if (tat !== null && fs !== 'Under Review')
    sla = tat <= SLA_THRESHOLD_HOURS ? 1 : 0;

  return {
    c:      r.createdAt,
    u:      r.final_time,
    ent:    r.enterprise_name,
    team:   r.team_name,
    qc:     r.qc_user,
    sla, tat, e2e_tat,
    rej:   r.failure_reason || null,
    vid:      r.mediaId || null,
    spin_id:  r['ss.spin_id'] || null,
    vmode: r["fd.platform"],
    seg:   r.customer_segment || null,  // Ent / Mid / SMB / Resellers
    ttype: r.input_type,
    vin:   r.vinName,
    sku:   r.spin_sku_id,
    final_status:         r.final_status,
    issues_by_severity:   r.issues_by_severity,
    manual_editing:       r.manual_editing === true || r.manual_editing === 'true' || r.manual_editing === 1 ? true : false,

  };
}

// ── Fetch full dataset ────────────────────────────────────────────────────────
async function fetchFromMetabase() {
  const t0 = Date.now();

  // CSV endpoint: ~8MB vs 89MB JSON = 10x faster
  const res = await fetch(`${BASE}/api/public/card/${UUID}/query/csv`, {
    headers: { "Accept": "text/csv" },
  });

  if (!res.ok) throw new Error(`Metabase HTTP ${res.status}`);

  const text = await res.text();
  console.log(`[api/data] CSV bytes=${text.length} time=${Date.now()-t0}ms`);

  const rawRows = parseCSV(text);
  console.log(`[api/data] parsed ${rawRows.length} rows total=${Date.now()-t0}ms`);
  if (rawRows.length) console.log(`[api/data] sample keys: ${Object.keys(rawRows[0]).join(", ")}`);

  const rows      = rawRows.map(mapRow);
  const delivered = rows.filter(r => (r.final_status||'').trim() === 'Delivered').length;
  const rejected  = rows.filter(r => ['QC Failed','Validation Failed','Tech Failure','AI Failed'].includes((r.final_status||'').trim())).length;
  const pending   = rows.filter(r => (r.final_status||'').trim() === 'Under Review').length;

  console.log(`[api/data] D:${delivered} R:${rejected} P:${pending}`);

  return {
    rows,
    lastSynced: new Date().toISOString(),
    meta: { total: rows.length, delivered, rejected, pending },
  };
}

// ── Background refresh (fire-and-forget) ─────────────────────────────────────
let _refreshing = false;
async function backgroundRefresh() {
  if (_refreshing) return;
  _refreshing = true;
  try {
    const payload = await fetchFromMetabase();
    _cache = { ...payload, ts: Date.now() };
    console.log('[api/data] background refresh complete');
  } catch (err) {
    console.error('[api/data] background refresh failed:', err.message);
  } finally {
    _refreshing = false;
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const force = req.query?.force === "1";
  const now   = Date.now();

  // ── Case 1: Fresh cache — return immediately ──────────────────
  if (!force && _cache && (now - _cache.ts) < CACHE_TTL_MS) {
    console.log(`[api/data] HIT age=${Math.round((now-_cache.ts)/1000)}s`);
    res.setHeader("X-Cache", "HIT");
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=600");
    return res.status(200).json({ rows: _cache.rows, lastSynced: _cache.lastSynced, meta: _cache.meta });
  }

  // ── Case 2: Stale cache exists — return it, refresh in background ──
  if (!force && _cache) {
    console.log(`[api/data] STALE age=${Math.round((now-_cache.ts)/1000)}s — serving stale, refreshing in bg`);
    res.setHeader("X-Cache", "STALE");
    res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=600");
    res.status(200).json({ rows: _cache.rows, lastSynced: _cache.lastSynced, meta: _cache.meta });
    backgroundRefresh(); // fire and forget — no await
    return;
  }

  // ── Case 3: No cache — must fetch (first load or force) ──────────
  try {
    console.log('[api/data] MISS — fetching fresh data');
    const payload = await fetchFromMetabase();
    _cache = { ...payload, ts: now };
    res.setHeader("X-Cache", "MISS");
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=600");
    res.status(200).json(payload);
  } catch (err) {
    console.error("[api/data] ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
};
