// scripts/sync-data.js — GitHub Actions data sync
// Handles large + growing Metabase CSV (currently ~64MB, increasing monthly)
// Strategy: fetch full CSV in Node, aggressively filter + compress, write lean JSON

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const zlib  = require('zlib');

const UUID = "7f9326d8-9eb9-4cc2-bded-efb1aac967db";
const URL  = `https://metabase.spyne.ai/api/public/card/${UUID}/query/csv`;
const SLA_THRESHOLD_HOURS = 6;
const OUT  = path.join(__dirname, '..', 'public', 'data.json');

// How many months of history to keep in the dashboard
// Increase this number if the dashboard needs older data
const KEEP_MONTHS = 6;

// ── Fetch with redirect follow + progress logging ────────────────────────────
function fetchCSV(url, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Accept: 'text/csv', 'Accept-Encoding': 'gzip, deflate' } }, res => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        console.log(`  Redirect → ${res.headers.location}`);
        return resolve(fetchCSV(res.headers.location, redirects + 1));
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));

      // Handle gzip response from server
      let stream = res;
      const enc = res.headers['content-encoding'];
      if (enc === 'gzip')    stream = res.pipe(zlib.createGunzip());
      if (enc === 'deflate') stream = res.pipe(zlib.createInflate());

      const chunks = [];
      let bytes = 0;
      stream.on('data', c => {
        chunks.push(c);
        bytes += c.length;
        if (bytes % (5 * 1024 * 1024) < c.length) {
          console.log(`  Downloaded ${(bytes / 1024 / 1024).toFixed(0)} MB...`);
        }
      });
      stream.on('end',   () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    }).on('error', reject);
  });
}

// ── Streaming CSV parser — memory-efficient for large files ──────────────────
function parseCSVLine(line) {
  const result = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
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

// ── Compact row mapper — only keeps fields index.html actually uses ──────────
// Null/empty values are dropped entirely to minimize JSON size
function mapRow(r) {
  const createdAt   = parseDate(r.createdAt);
  const finalTime   = parseDate(r.final_time);
  const firstQcDone = parseDate(r.first_qc_done);

  const tatTime = firstQcDone || finalTime;
  let tat = null;
  if (createdAt && tatTime) {
    const ms = tatTime.getTime() - createdAt.getTime();
    if (ms > 0) tat = parseFloat((ms / 3600000).toFixed(2)); // 2dp not 3dp saves space
  }

  let e2e_tat = null;
  if (createdAt && finalTime) {
    const ms2 = finalTime.getTime() - createdAt.getTime();
    if (ms2 > 0) e2e_tat = parseFloat((ms2 / 3600000).toFixed(2));
  }

  const fs = (r.final_status || '').trim();
  let sla = null;
  if (tat !== null && fs !== 'Under Review')
    sla = tat <= SLA_THRESHOLD_HOURS ? 1 : 0;

  // Build row — omit null/empty values entirely (saves ~30% JSON size)
  const row = {};
  const set = (k, v) => { if (v !== null && v !== undefined && v !== '') row[k] = v; };

  set('c',   r.createdAt);
  set('u',   r.final_time);
  set('ent', r.enterprise_name);
  set('team',r.team_name);
  set('qc',  r.qc_user);
  if (sla !== null) row.sla = sla;
  if (tat !== null) row.tat = tat;
  if (e2e_tat !== null) row.e2e_tat = e2e_tat;
  set('rej',        r.failure_reason);
  set('vid',        r.mediaId);
  set('spin_id',    r['ss.spin_id']);
  set('vmode',      r['fd.platform']);
  set('crm_status', r.crm_status);
  set('seg',        r.customer_segment);
  set('ttype',      r.input_type);
  set('vin',        r.vinName);
  set('sku',        r.spin_sku_id);
  set('final_status', r.final_status);
  set('issues_by_severity', r.issues_by_severity);
  if (r.manual_editing === true || r.manual_editing === 'true' || r.manual_editing === 1)
    row.manual_editing = true;

  return row;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Fetching CSV from Metabase...`);
  const t0 = Date.now();
  const text = await fetchCSV(URL);
  console.log(`Fetched ${(text.length / 1024 / 1024).toFixed(1)} MB in ${((Date.now()-t0)/1000).toFixed(1)}s`);

  // Parse line by line — don't build intermediate full-row objects for filtered rows
  const lines = text.split('\n');
  console.log(`Parsing ${lines.length.toLocaleString()} lines...`);
  const headers = parseCSVLine(lines[0]);

  const cutoff = new Date(Date.now() - KEEP_MONTHS * 30 * 24 * 3600 * 1000)
    .toISOString().slice(0, 10);
  console.log(`Date cutoff: ${cutoff} (keeping ${KEEP_MONTHS} months)`);

  const rows = [];
  let skipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const vals = parseCSVLine(line);
    const r = {};
    headers.forEach((h, idx) => { r[h] = vals[idx] ?? ''; });

    const isPending = (r.crm_status || '') === 'qc_unassigned';
    const dateStr   = String(r.createdAt || '').slice(0, 10);

    // Always keep pending; drop old non-pending rows early (before mapRow)
    if (!isPending && dateStr < cutoff) {
      skipped++;
      continue;
    }

    rows.push(mapRow(r));
  }

  console.log(`Kept ${rows.length.toLocaleString()} rows, skipped ${skipped.toLocaleString()} old rows`);

  // Compute meta stats
  const delivered = rows.filter(r => (r.final_status||'').trim() === 'Delivered').length;
  const rejected  = rows.filter(r => ['QC Failed','Validation Failed','Tech Failure','AI Failed']
    .includes((r.final_status||'').trim())).length;
  const pending   = rows.filter(r => (r.crm_status||'').trim() === 'qc_unassigned').length;

  const payload = {
    rows,
    lastSynced: new Date().toISOString(),
    meta: { total: rows.length, delivered, rejected, pending, cutoff },
  };

  const json = JSON.stringify(payload); // no pretty-print — saves space
  const sizeMB = (json.length / 1024 / 1024).toFixed(2);
  console.log(`Output size: ${sizeMB} MB`);

  // Warn if output is getting large
  if (json.length > 8 * 1024 * 1024) {
    console.warn(`⚠️  Output exceeds 8MB (${sizeMB}MB). Consider reducing KEEP_MONTHS (currently ${KEEP_MONTHS}).`);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, json);
  console.log(`✅ Written → public/data.json  (${rows.length} rows, ${sizeMB} MB, ${((Date.now()-t0)/1000).toFixed(1)}s total)`);
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
