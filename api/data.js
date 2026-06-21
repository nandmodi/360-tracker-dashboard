const zlib = require('zlib');

const UUID = "7f9326d8-9eb9-4cc2-bded-efb1aac967db";
const BASE = "https://metabase.spyne.ai";
const SLA_THRESHOLD_HOURS = 6;
const CACHE_TTL_MS = 8 * 60 * 1000;

let _cache = null;

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

function parseCSV(text) {
  const lines = text.split('\n');
  if (!lines.length) return [];
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

function parseDate(s) {
  if (!s) return null;
  const d = new Date(String(s).trim());
  return isNaN(d.getTime()) ? null : d;
}

function mapRow(r) {
  const createdAt   = parseDate(r.createdAt);
  const finalTime   = parseDate(r.final_time);
  const firstQcDone = parseDate(r.first_qc_done);

  const tatTime = firstQcDone || finalTime;
  let tat = null;
  if (createdAt && tatTime) {
    const ms = tatTime.getTime() - createdAt.getTime();
    if (ms > 0) tat = parseFloat((ms / 3_600_000).toFixed(3));
  }

  let e2e_tat = null;
  if (createdAt && finalTime) {
    const ms2 = finalTime.getTime() - createdAt.getTime();
    if (ms2 > 0) e2e_tat = parseFloat((ms2 / 3_600_000).toFixed(3));
  }

  const fs = (r.final_status || '').trim();
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
    rej:          r.failure_reason || null,
    vid:          r.mediaId || null,
    spin_id:      r['ss.spin_id'] || null,
    vmode:        r["fd.platform"],
    crm_status:   r.crm_status || null,
    seg:          r.customer_segment || null,
    ttype:        r.input_type,
    vin:          r.vinName,
    sku:          r.spin_sku_id,
    final_status:       r.final_status,
    issues_by_severity: r.issues_by_severity,
    manual_editing: r.manual_editing === true || r.manual_editing === 'true' || r.manual_editing === 1,
  };
}

async function fetchFromMetabase() {
  const res = await fetch(`${BASE}/api/public/card/${UUID}/query/csv`, {
    headers: { 'Accept': 'text/csv', 'Accept-Encoding': 'gzip, deflate' },
  });
  if (!res.ok) throw new Error(`Metabase HTTP ${res.status}`);

  const text = await res.text();
  const rawRows = parseCSV(text);
  const allRows = rawRows.map(mapRow);

  const cutoff = new Date(Date.now() - 183 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const rows = allRows.filter(r => {
    if ((r.crm_status || '') === 'qc_unassigned') return true;
    const d = String(r.c || '').slice(0, 10);
    return d >= cutoff;
  });

  const delivered = rows.filter(r => (r.final_status||'').trim() === 'Delivered').length;
  const rejected  = rows.filter(r => ['QC Failed','Validation Failed','Tech Failure','AI Failed']
    .includes((r.final_status||'').trim())).length;
  const pending   = rows.filter(r => (r.crm_status||'').trim() === 'qc_unassigned').length;

  return {
    rows,
    lastSynced: new Date().toISOString(),
    meta: { total: rows.length, delivered, rejected, pending },
  };
}

function sendGzip(res, statusCode, payload) {
  const json       = JSON.stringify(payload);
  const compressed = zlib.gzipSync(json);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Encoding', 'gzip');
  res.setHeader('Content-Length', compressed.length);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(statusCode).send(compressed);
}

let _refreshing = false;
async function backgroundRefresh() {
  if (_refreshing) return;
  _refreshing = true;
  try {
    const payload = await fetchFromMetabase();
    _cache = { ...payload, ts: Date.now() };
  } catch (err) {
    console.error('[api/data] bg refresh failed:', err.message);
  } finally {
    _refreshing = false;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const force = req.query?.force === '1';
  const now   = Date.now();

  if (!force && _cache && (now - _cache.ts) < CACHE_TTL_MS) {
    res.setHeader('X-Cache', 'HIT');
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=600');
    return sendGzip(res, 200, { rows: _cache.rows, lastSynced: _cache.lastSynced, meta: _cache.meta });
  }

  if (!force && _cache) {
    res.setHeader('X-Cache', 'STALE');
    sendGzip(res, 200, { rows: _cache.rows, lastSynced: _cache.lastSynced, meta: _cache.meta });
    backgroundRefresh();
    return;
  }

  try {
    const payload = await fetchFromMetabase();
    _cache = { ...payload, ts: now };
    res.setHeader('X-Cache', 'MISS');
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=600');
    sendGzip(res, 200, payload);
  } catch (err) {
    console.error('[api/data] ERROR:', err.message);
    res.status(500).json({ error: err.message });
  }
};
