// Computes period-summary tables (360_spin, 360_region, 360_rt) matching the
// Delivery_Metrics.xlsx template, and writes them to a Google Sheet.
// Reads from the already-synced public/data/<YYYY-MM>.json month-files
// (produced by sync-data.js) — no separate Metabase fetch needed.
//
// Date-basis for this export specifically: processedAt (fallback createdAt)
// -> first_qc_done (fallback final_time). This differs from the dashboard's
// own TAT/E2E, which use sku_created_on as the start point — a deliberate,
// separate choice for this Sheets output.

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'public', 'data');
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SLA_H = 6;
const SEGMENTS = ['ent', 'mid', 'resellers', 'smb'];
const SEG_LABELS = { ent: 'Ent', mid: 'Mid', resellers: 'Resellers', smb: 'SMB' };

function normSeg(s) {
  if (!s) return 'Unknown';
  const v = String(s).trim();
  if (/^smb$/i.test(v)) return 'SMB';
  if (/^resell/i.test(v)) return 'Resellers';
  return v;
}
function segKey(s) {
  const n = normSeg(s);
  if (n === 'Ent') return 'ent';
  if (n === 'Mid') return 'mid';
  if (n === 'SMB') return 'smb';
  if (n === 'Resellers') return 'resellers';
  return null;
}

// ── Load all synced month-files ──────────────────────────────
function loadAllRows() {
  const files = fs.readdirSync(DATA_DIR).filter(f => /^\d{4}-\d{2}\.json$/.test(f));
  const rows = [];
  for (const f of files) {
    const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
    for (const r of d.rows) {
      r._pa = parseDate(r.pa) || parseDate(r.c); // processedAt fallback createdAt
      r._fq = parseDate(r.fq) || parseDate(r.u); // first_qc_done fallback final_time
      rows.push(r);
    }
  }
  return rows;
}
function parseDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d) ? null : d;
}
function isDelivered(r) { return (r.fs || '').trim() === 'Delivered'; }
function isPending(r) { const c = (r.cs || '').trim(); return c === 'qc_unassigned' || c === 'qc_inprogress'; }
const TAT_ELIGIBLE = new Set(['Delivered', 'QC Failed', 'Validation Failed', 'Tech Failure', 'AI Failed', 'Undelivered']);
function isTatEligible(r) { return TAT_ELIGIBLE.has((r.fs || '').trim()); }

// ── Metrics ───────────────────────────────────────────────────
function computeMetrics(rows) {
  if (!rows.length) return { sla_pct: null, p99_tat_hrs: null, p95_tat_hrs: null, delivery_pct: null };
  const tatRows = rows.filter(isTatEligible).map(r => {
    if (!r._pa || !r._fq) return null;
    const ms = r._fq - r._pa;
    return ms >= 0 ? +(ms / 3600000).toFixed(2) : null;
  }).filter(v => v != null);

  const sla_pct = tatRows.length ? +((tatRows.filter(v => v <= SLA_H).length / tatRows.length) * 100).toFixed(2) : null;
  const sorted = [...tatRows].sort((a, b) => a - b);
  const pct = (p) => sorted.length ? +sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)].toFixed(2) : null;
  const p99_tat_hrs = pct(0.99);
  const p95_tat_hrs = pct(0.95);

  const received = rows.length;
  const pending = rows.filter(isPending).length;
  const delivered = rows.filter(isDelivered).length;
  const delivery_pct = +((delivered / Math.max(received - pending, 1)) * 100).toFixed(2);

  return { sla_pct, p99_tat_hrs, p95_tat_hrs, delivery_pct };
}

// ── Periods (matches the xlsx template exactly) ───────────────
function getPeriods(allRows) {
  let maxDate = new Date(2026, 3, 1);
  for (const r of allRows) { if (r._pa && r._pa > maxDate) maxDate = r._pa; }

  const periods = [];
  // Weekly: W-0 (current, may be partial) through W-3
  const dow = maxDate.getDay() || 7;
  const thisMon = new Date(maxDate.getFullYear(), maxDate.getMonth(), maxDate.getDate() - dow + 1);
  for (let i = 0; i <= 3; i++) {
    const s = new Date(thisMon); s.setDate(thisMon.getDate() - i * 7);
    const e = new Date(s); e.setDate(s.getDate() + 7);
    periods.push({ sort_group: 0, sort_date: s, granularity: 'week', period: 'W-' + i, from: s, to: e });
  }
  // Monthly: MTD through M-4
  for (let i = 0; i <= 4; i++) {
    const s = new Date(maxDate.getFullYear(), maxDate.getMonth() - i, 1);
    const e = new Date(maxDate.getFullYear(), maxDate.getMonth() - i + 1, 1);
    periods.push({ sort_group: 1, sort_date: s, granularity: 'month', period: i === 0 ? 'MTD' : 'M-' + i, from: s, to: e });
  }
  return periods;
}
function inPeriod(r, p) { return r._pa && r._pa >= p.from && r._pa < p.to; }

// ── Build the 3 sheets ─────────────────────────────────────────
function buildSpinOrRt(allRows, laneId) {
  const periods = getPeriods(allRows);
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

  // "rt" (Rooftop) lane: compute each team's own metrics, then average across
  // teams — mirrors the Reports tab's Rooftop lane. "spin" (VIN) lane: pool
  // all matching rows directly, no per-team grouping.
  function laneMetrics(rowset) {
    if (laneId !== 'rt') return computeMetrics(rowset);
    const byTeam = new Map();
    for (const r of rowset) {
      if (!r.tm) continue;
      if (!byTeam.has(r.tm)) byTeam.set(r.tm, []);
      byTeam.get(r.tm).push(r);
    }
    const teamMetrics = [...byTeam.values()].map(computeMetrics);
    return averageMetrics(teamMetrics);
  }

  return periods.map(p => {
    const pop = allRows.filter(r => inPeriod(r, p));
    const overall = laneMetrics(pop);
    const row = {
      sort_group: p.sort_group, sort_date: p.sort_date.toISOString().slice(0, 10),
      granularity: p.granularity, period: p.period,
      sla_pct: overall.sla_pct, p99_tat_hrs: overall.p99_tat_hrs, p95_tat_hrs: overall.p95_tat_hrs, delivery_pct: overall.delivery_pct,
    };
    for (const sk of SEGMENTS) {
      const segRows = pop.filter(r => segKey(r.seg) === sk);
      const m = laneMetrics(segRows);
      row[sk + '_sla_pct'] = m.sla_pct; row[sk + '_p99_tat_hrs'] = m.p99_tat_hrs;
      row[sk + '_p95_tat_hrs'] = m.p95_tat_hrs; row[sk + '_delivery_pct'] = m.delivery_pct;
    }
    row.last_updated = now;
    return row;
  });
}

function averageMetrics(list) {
  const avg = (key) => {
    const vals = list.map(m => m[key]).filter(v => v != null);
    return vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2) : null;
  };
  return { sla_pct: avg('sla_pct'), p99_tat_hrs: avg('p99_tat_hrs'), p95_tat_hrs: avg('p95_tat_hrs'), delivery_pct: avg('delivery_pct') };
}

function buildRegion(allRows) {
  const periods = getPeriods(allRows);
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const regions = [...new Set(allRows.map(r => r.region).filter(Boolean))].sort();
  const rows = [];
  for (const p of periods) {
    const pop = allRows.filter(r => inPeriod(r, p));
    for (const region of [...regions, null]) {
      const regionPop = pop.filter(r => (r.region || null) === region);
      if (!regionPop.length) continue;
      const overall = computeMetrics(regionPop);
      const row = {
        sort_group: p.sort_group, sort_date: p.sort_date.toISOString().slice(0, 10),
        granularity: p.granularity, period: p.period, region: region || '',
        sla_pct: overall.sla_pct, p99_tat_hrs: overall.p99_tat_hrs, p95_tat_hrs: overall.p95_tat_hrs,
      };
      const segMetrics = {};
      for (const sk of SEGMENTS) {
        segMetrics[sk] = computeMetrics(regionPop.filter(r => segKey(r.seg) === sk));
        row[sk + '_sla_pct'] = segMetrics[sk].sla_pct; row[sk + '_p99_tat_hrs'] = segMetrics[sk].p99_tat_hrs; row[sk + '_p95_tat_hrs'] = segMetrics[sk].p95_tat_hrs;
      }
      row.delivery_pct = overall.delivery_pct;
      for (const sk of SEGMENTS) {
        row[sk + '_delivery_pct'] = segMetrics[sk].delivery_pct;
      }
      row.last_updated = now;
      rows.push(row);
    }
  }
  return rows;
}

// ── Google Sheets write (service-account JWT, no external deps) ──────────
function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function getAccessToken(creds) {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const claim = base64url(JSON.stringify({
    iss: creds.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now,
  }));
  const signInput = header + '.' + claim;
  const signature = crypto.createSign('RSA-SHA256').update(signInput).sign(creds.private_key);
  const jwt = signInput + '.' + base64url(signature).replace(/\+/g, '-').replace(/\//g, '_');
  // (signature is already base64url via base64url(), the extra replace is a no-op safety net)
  const body = `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`;

  return new Promise((resolve, reject) => {
    const req = https.request('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { const j = JSON.parse(data); if (j.access_token) resolve(j.access_token); else reject(new Error('No access_token: ' + data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

function writeSheet(accessToken, sheetName, headerOrder, rows) {
  const values = [headerOrder, ...rows.map(r => headerOrder.map(h => (r[h] == null ? '' : r[h])))];
  const body = JSON.stringify({ values });
  const range = encodeURIComponent(`${sheetName}!A1`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}?valueInputOption=RAW`;
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'PUT', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(data));
        else reject(new Error(`Sheets API ${res.statusCode} for ${sheetName}: ${data.slice(0, 300)}`));
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

const SPIN_RT_HEADER = ['sort_group', 'sort_date', 'granularity', 'period', 'sla_pct', 'p99_tat_hrs', 'p95_tat_hrs', 'delivery_pct',
  'ent_sla_pct', 'ent_p99_tat_hrs', 'ent_p95_tat_hrs', 'ent_delivery_pct',
  'mid_sla_pct', 'mid_p99_tat_hrs', 'mid_p95_tat_hrs', 'mid_delivery_pct',
  'resellers_sla_pct', 'resellers_p99_tat_hrs', 'resellers_p95_tat_hrs', 'resellers_delivery_pct',
  'smb_sla_pct', 'smb_p99_tat_hrs', 'smb_p95_tat_hrs', 'smb_delivery_pct', 'last_updated'];

const REGION_HEADER = ['sort_group', 'sort_date', 'granularity', 'period', 'region', 'sla_pct', 'p99_tat_hrs', 'p95_tat_hrs',
  'ent_sla_pct', 'ent_p99_tat_hrs', 'ent_p95_tat_hrs', 'mid_sla_pct', 'mid_p99_tat_hrs', 'mid_p95_tat_hrs',
  'resellers_sla_pct', 'resellers_p99_tat_hrs', 'resellers_p95_tat_hrs', 'smb_sla_pct', 'smb_p99_tat_hrs', 'smb_p95_tat_hrs',
  'delivery_pct', 'ent_delivery_pct', 'mid_delivery_pct', 'resellers_delivery_pct', 'smb_delivery_pct', 'last_updated'];

function getSpreadsheetInfo(accessToken) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=sheets.properties.title`;
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Authorization: `Bearer ${accessToken}` } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(data));
        else reject(new Error(`Sheets API ${res.statusCode} (get spreadsheet): ${data.slice(0, 300)}`));
      });
    }).on('error', reject);
  });
}
function ensureTabsExist(accessToken, existingTitles, neededTitles) {
  const missing = neededTitles.filter(t => !existingTitles.includes(t));
  if (!missing.length) return Promise.resolve();
  const body = JSON.stringify({ requests: missing.map(title => ({ addSheet: { properties: { title } } })) });
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`;
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) { console.log(`Created missing tab(s): ${missing.join(', ')}`); resolve(); }
        else reject(new Error(`Sheets API ${res.statusCode} (create tabs): ${data.slice(0, 300)}`));
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

async function main() {
  if (!SHEET_ID) throw new Error('GOOGLE_SHEET_ID env var not set');
  const credsRaw = process.env.GOOGLE_SHEETS_CREDENTIALS;
  if (!credsRaw) throw new Error('GOOGLE_SHEETS_CREDENTIALS env var not set');
  const creds = JSON.parse(credsRaw);

  console.log('Loading synced month-files…');
  const allRows = loadAllRows();
  console.log(`Loaded ${allRows.length} rows`);

  console.log('Computing 360_spin…');
  const spinRows = buildSpinOrRt(allRows, 'spin');
  console.log('Computing 360_rt…');
  const rtRows = buildSpinOrRt(allRows, 'rt');
  console.log('Computing 360_region…');
  const regionRows = buildRegion(allRows);

  console.log('Authenticating with Google…');
  const token = await getAccessToken(creds);

  console.log('Checking spreadsheet tabs…');
  const info = await getSpreadsheetInfo(token);
  const existingTitles = (info.sheets || []).map(s => s.properties.title);
  console.log(`Existing tabs: ${existingTitles.join(', ') || '(none)'}`);
  await ensureTabsExist(token, existingTitles, ['360_spin', '360_region', '360_rt']);

  console.log('Writing 360_spin…');
  await writeSheet(token, '360_spin', SPIN_RT_HEADER, spinRows);
  console.log('Writing 360_region…');
  await writeSheet(token, '360_region', REGION_HEADER, regionRows);
  console.log('Writing 360_rt…');
  await writeSheet(token, '360_rt', SPIN_RT_HEADER, rtRows);

  console.log('Done.');
}

main().catch(err => { console.error('Failed:', err.message); process.exit(1); });
