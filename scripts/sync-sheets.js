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
      // Period-bucketing uses sku_created_on, matching Operations — with the
      // same epoch-placeholder (~1970-01-01, meaning "no real value") handling
      // sync-data.js already applies, falling back to createdAt in that case.
      let sc = parseDate(r.sc);
      if (sc && sc.getTime() < 86400000) sc = null;
      r._period = sc || parseDate(r.c);
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
// Reuses r.e2e (already computed by sync-data.js from sku_created_on ->
// first_qc_done, with the same fallbacks Operations uses) instead of
// re-deriving TAT here — keeps Reports/Sheet-export numbers identical to
// Operations for the same underlying rows.
function computeMetrics(rows) {
  if (!rows.length) return { total_vin: 0, total_delivered: 0, sla_pct: null, p99_tat_hrs: null, p95_tat_hrs: null, delivery_pct: null };
  const tatRows = rows.filter(isTatEligible).map(r => (typeof r.e2e === 'number' && r.e2e >= 0) ? r.e2e : null).filter(v => v != null);

  const sla_pct = tatRows.length ? +((tatRows.filter(v => v <= SLA_H).length / tatRows.length) * 100).toFixed(2) : null;
  const sorted = [...tatRows].sort((a, b) => a - b);
  const pct = (p) => sorted.length ? +sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)].toFixed(2) : null;
  const p99_tat_hrs = pct(0.99);
  const p95_tat_hrs = pct(0.95);

  const received = rows.length;
  const pending = rows.filter(isPending).length;
  const delivered = rows.filter(isDelivered).length;
  const delivery_pct = +((delivered / Math.max(received - pending, 1)) * 100).toFixed(2);

  return { total_vin: received, total_delivered: delivered, sla_pct, p99_tat_hrs, p95_tat_hrs, delivery_pct };
}

// ── Periods (matches the xlsx template exactly) ───────────────
function getPeriods(allRows) {
  let maxDate = new Date(2026, 3, 1);
  for (const r of allRows) { if (r._period && r._period > maxDate) maxDate = r._period; }

  const periods = [];
  // Weekly: W-1 (previous complete Mon-Sun week) through W-4 — the current,
  // possibly-still-in-progress week is intentionally excluded.
  const dow = maxDate.getDay() || 7;
  const thisMon = new Date(maxDate.getFullYear(), maxDate.getMonth(), maxDate.getDate() - dow + 1);
  for (let i = 1; i <= 4; i++) {
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
function inPeriod(r, p) { return r._period && r._period >= p.from && r._period < p.to; }

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
    const overallTotals = computeMetrics(pop); // true pooled totals, even for 'rt' (averaging a count doesn't make sense)
    const row = {
      sort_group: p.sort_group, sort_date: p.sort_date.toISOString().slice(0, 10),
      granularity: p.granularity, period: p.period,
      total_vin: overallTotals.total_vin, total_delivered: overallTotals.total_delivered,
      sla_pct: overall.sla_pct, p99_tat_hrs: overall.p99_tat_hrs, p95_tat_hrs: overall.p95_tat_hrs, delivery_pct: overall.delivery_pct,
    };
    for (const sk of SEGMENTS) {
      const segRows = pop.filter(r => segKey(r.seg) === sk);
      const m = laneMetrics(segRows);
      const mTotals = computeMetrics(segRows);
      row['total_' + sk + '_vin'] = mTotals.total_vin; row['total_' + sk + '_delivered'] = mTotals.total_delivered;
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

// ── 360_issue — QC/Validation/Tech&AI failure-reason breakdown, last 30 days ──
// Mirrors the dashboard's own reason-card logic exactly (same field parsing,
// same "Blocker" extraction from issues_by_severity, same totalReviewed
// denominator) so the numbers match what Operations shows.
function buildIssueBreakdown(allRows) {
  const cutoff = new Date(Date.now() - 30 * 86400000);
  const rows30 = allRows.filter(r => r._period && r._period >= cutoff);

  const qcReasons = {}, valReasons = {}, techReasons = {};
  let totalReviewed = 0;
  for (const r of rows30) {
    const fs = (r.fs || '').trim();
    if ((r.cs || '').trim() === 'qc_done') totalReviewed++;

    if (fs === 'QC Failed') {
      let matchedBlocker = false;
      if (r.isv) {
        const parts = String(r.isv).split('||');
        for (const part of parts) {
          const t = part.trim();
          if (/^blocker/i.test(t)) {
            matchedBlocker = true;
            const items = t.replace(/^blocker\s*-\s*/i, '').split(',');
            for (const item of items) {
              const k = item.trim();
              if (k) qcReasons[k] = (qcReasons[k] || 0) + 1;
            }
          }
        }
      }
      if (!matchedBlocker) {
        const k = r.rej ? String(r.rej).trim().slice(0, 60) : '(no reason recorded)';
        qcReasons[k] = (qcReasons[k] || 0) + 1;
      }
    }
    if (fs === 'Validation Failed') {
      const k = r.rej ? String(r.rej).trim().slice(0, 80) : '(no reason recorded)';
      valReasons[k] = (valReasons[k] || 0) + 1;
    }
    if (fs === 'Tech Failure' || fs === 'AI Failed') {
      const k = r.rej ? String(r.rej).trim().slice(0, 80) : '(no reason recorded)';
      techReasons[k] = (techReasons[k] || 0) + 1;
    }
  }

  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const out = [];
  const addCategory = (category, map) => {
    const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
    for (const [sub_issue, count] of entries) {
      out.push({
        category, sub_issue, count,
        pct_of_reviewed: totalReviewed ? +((count / totalReviewed) * 100).toFixed(2) : null,
        last_updated: now,
      });
    }
  };
  addCategory('QC Failed', qcReasons);
  addCategory('Validation Failed', valReasons);
  addCategory('Tech & AI Failure', techReasons);
  return out;
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
        total_vin: overall.total_vin, total_delivered: overall.total_delivered,
        sla_pct: overall.sla_pct, p99_tat_hrs: overall.p99_tat_hrs, p95_tat_hrs: overall.p95_tat_hrs,
      };
      const segMetrics = {};
      for (const sk of SEGMENTS) {
        segMetrics[sk] = computeMetrics(regionPop.filter(r => segKey(r.seg) === sk));
        row['total_' + sk + '_vin'] = segMetrics[sk].total_vin; row['total_' + sk + '_delivered'] = segMetrics[sk].total_delivered;
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

function clearSheet(accessToken, sheetName) {
  const range = encodeURIComponent(`${sheetName}!A1:Z10000`); // generous range — comfortably covers any realistic row/column count
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}:clear`;
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Length': 0 },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`Sheets API ${res.statusCode} (clear ${sheetName}): ${data.slice(0, 300)}`));
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function writeSheet(accessToken, sheetName, headerOrder, rows) {
  await clearSheet(accessToken, sheetName); // wipe any stale rows from a previous run before writing fresh data
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

const SPIN_HEADER = ['sort_group', 'sort_date', 'granularity', 'period', 'total_vin', 'total_delivered', 'sla_pct', 'p99_tat_hrs', 'p95_tat_hrs', 'delivery_pct',
  'total_ent_vin', 'total_ent_delivered', 'ent_sla_pct', 'ent_p99_tat_hrs', 'ent_p95_tat_hrs', 'ent_delivery_pct',
  'total_mid_vin', 'total_mid_delivered', 'mid_sla_pct', 'mid_p99_tat_hrs', 'mid_p95_tat_hrs', 'mid_delivery_pct',
  'total_resellers_vin', 'total_resellers_delivered', 'resellers_sla_pct', 'resellers_p99_tat_hrs', 'resellers_p95_tat_hrs', 'resellers_delivery_pct',
  'total_smb_vin', 'total_smb_delivered', 'smb_sla_pct', 'smb_p99_tat_hrs', 'smb_p95_tat_hrs', 'smb_delivery_pct', 'last_updated'];

const RT_HEADER = ['sort_group', 'sort_date', 'granularity', 'period', 'total_vin', 'total_delivered', 'sla_pct', 'p99_tat_hrs', 'p95_tat_hrs', 'delivery_pct',
  'total_ent_vin', 'total_ent_delivered', 'ent_sla_pct', 'ent_p99_tat_hrs', 'ent_p95_tat_hrs', 'ent_delivery_pct',
  'total_mid_vin', 'total_mid_delivered', 'mid_sla_pct', 'mid_p99_tat_hrs', 'mid_p95_tat_hrs', 'mid_delivery_pct',
  'total_resellers_vin', 'total_resellers_delivered', 'resellers_sla_pct', 'resellers_p99_tat_hrs', 'resellers_p95_tat_hrs', 'resellers_delivery_pct',
  'total_smb_vin', 'total_smb_delivered', 'smb_sla_pct', 'smb_p99_tat_hrs', 'smb_p95_tat_hrs', 'smb_delivery_pct', 'last_updated'];

const REGION_HEADER = ['sort_group', 'sort_date', 'granularity', 'period', 'region', 'total_vin', 'total_delivered', 'sla_pct', 'p99_tat_hrs', 'p95_tat_hrs',
  'total_ent_vin', 'total_ent_delivered', 'ent_sla_pct', 'ent_p99_tat_hrs', 'ent_p95_tat_hrs',
  'total_mid_vin', 'total_mid_delivered', 'mid_sla_pct', 'mid_p99_tat_hrs', 'mid_p95_tat_hrs',
  'total_resellers_vin', 'total_resellers_delivered', 'resellers_sla_pct', 'resellers_p99_tat_hrs', 'resellers_p95_tat_hrs',
  'total_smb_vin', 'total_smb_delivered', 'smb_sla_pct', 'smb_p99_tat_hrs', 'smb_p95_tat_hrs',
  'delivery_pct', 'ent_delivery_pct', 'mid_delivery_pct', 'resellers_delivery_pct', 'smb_delivery_pct', 'last_updated'];

const ISSUE_HEADER = ['category', 'sub_issue', 'count', 'pct_of_reviewed', 'last_updated'];

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
  console.log('Computing 360_issue…');
  const issueRows = buildIssueBreakdown(allRows);

  console.log('Authenticating with Google…');
  const token = await getAccessToken(creds);

  console.log('Checking spreadsheet tabs…');
  const info = await getSpreadsheetInfo(token);
  const existingTitles = (info.sheets || []).map(s => s.properties.title);
  console.log(`Existing tabs: ${existingTitles.join(', ') || '(none)'}`);
  await ensureTabsExist(token, existingTitles, ['360_spin', '360_region', '360_rt', '360_issue']);

  console.log('Writing 360_spin…');
  await writeSheet(token, '360_spin', SPIN_HEADER, spinRows);
  console.log('Writing 360_region…');
  await writeSheet(token, '360_region', REGION_HEADER, regionRows);
  console.log('Writing 360_rt…');
  await writeSheet(token, '360_rt', RT_HEADER, rtRows);
  console.log('Writing 360_issue…');
  await writeSheet(token, '360_issue', ISSUE_HEADER, issueRows);

  console.log('Done.');
}

main().catch(err => { console.error('Failed:', err.message); process.exit(1); });
