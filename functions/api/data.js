// functions/api/data.js — Cloudflare Pages Function (Workers runtime)

const UUID = "7f9326d8-9eb9-4cc2-bded-efb1aac967db";
const BASE = "https://metabase.spyne.ai";
const SLA_THRESHOLD_HOURS = 6;

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
    if (ms > 0) tat = parseFloat((ms / 3600000).toFixed(3));
  }

  let e2e_tat = null;
  if (createdAt && finalTime) {
    const ms2 = finalTime.getTime() - createdAt.getTime();
    if (ms2 > 0) e2e_tat = parseFloat((ms2 / 3600000).toFixed(3));
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
  // 25s timeout — CF Workers limit is 30s
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);

  let res;
  try {
    res = await fetch(`${BASE}/api/public/card/${UUID}/query/csv`, {
      headers: { 'Accept': 'text/csv' },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

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

  const delivered = rows.filter(r => (r.final_status || '').trim() === 'Delivered').length;
  const rejected  = rows.filter(r => ['QC Failed', 'Validation Failed', 'Tech Failure', 'AI Failed'].includes((r.final_status || '').trim())).length;
  const pending   = rows.filter(r => (r.crm_status || '').trim() === 'qc_unassigned').length;

  return {
    rows,
    lastSynced: new Date().toISOString(),
    meta: { total: rows.length, delivered, rejected, pending },
  };
}

export async function onRequestGet(context) {
  const { request } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  try {
    const payload = await fetchFromMetabase();
    const json = JSON.stringify(payload);

    return new Response(json, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=480, stale-while-revalidate=600',
        'Access-Control-Allow-Origin': '*',
        'X-Row-Count': String(payload.meta.total),
      },
    });

  } catch (err) {
    // Return error as JSON so we can see what went wrong
    return new Response(
      JSON.stringify({ error: err.message, type: err.name }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      }
    );
  }
}
