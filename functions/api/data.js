// functions/api/data.js — Cloudflare Pages Function (Workers runtime)

const METABASE_UUID = '7f9326d8-9eb9-4cc2-bded-efb1aac967db';
const METABASE_URL = `https://metabase.spyne.ai/api/public/card/${METABASE_UUID}/query/csv`;
const CACHE_TTL = 480; // 8 minutes

const KEEP_FIELDS = new Set([
  'vin', 'sku_id', 'spin_id', 'enterprise', 'team',
  'qc_user', 'crm_status', 'final_status', 'sla_status',
  'first_qc_done', 'final_time', 'created_at',
  'rejection_reason', 'input_type', 'platform',
  'customer_segment', 'is_hidden', 'tat', 'e2e_tat', 'within_3h'
]);

function getCutoffDate() {
  const d = new Date();
  d.setMonth(d.getMonth() - 6);
  return d;
}

function parseCSV(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));

  return lines.slice(1).map(line => {
    const values = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === ',' && !inQ) { values.push(cur); cur = ''; continue; }
      cur += ch;
    }
    values.push(cur);

    const row = {};
    headers.forEach((h, i) => {
      if (KEEP_FIELDS.has(h)) row[h] = values[i]?.trim() ?? '';
    });
    return row;
  });
}

function applyDateFilter(rows, cutoff) {
  return rows.filter(row => {
    if (row.crm_status === 'qc_unassigned') return true;
    if (!row.created_at) return false;
    const d = new Date(row.created_at);
    return !isNaN(d) && d >= cutoff;
  });
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
    const upstream = await fetch(METABASE_URL, {
      headers: { 'Accept': 'text/csv' },
    });

    if (!upstream.ok) {
      return new Response(
        JSON.stringify({ error: `Metabase error: ${upstream.status}` }),
        { status: 502, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
      );
    }

    const csvText = await upstream.text();
    const rows = parseCSV(csvText);
    const cutoff = getCutoffDate();
    const filtered = applyDateFilter(rows, cutoff);
    const json = JSON.stringify({ rows: filtered, total: filtered.length });

    // NO manual gzip — Cloudflare handles compression automatically
    return new Response(json, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${CACHE_TTL}`,
        'Access-Control-Allow-Origin': '*',
        'X-Row-Count': String(filtered.length),
      },
    });

  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
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
