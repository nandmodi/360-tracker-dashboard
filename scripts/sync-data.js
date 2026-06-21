const fs    = require('fs');
const path  = require('path');
const https = require('https');
const zlib  = require('zlib');

const UUID = "7f9326d8-9eb9-4cc2-bded-efb1aac967db";
const URL  = `https://metabase.spyne.ai/api/public/card/${UUID}/query/csv`;
const SLA_THRESHOLD_HOURS = 6;
const OUT  = path.join(__dirname, '..', 'public', 'data.json');
const KEEP_MONTHS = 6;

function fetchCSV(url, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Accept: 'text/csv', 'Accept-Encoding': 'gzip, deflate' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return resolve(fetchCSV(res.headers.location, redirects + 1));
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let stream = res;
      const enc = res.headers['content-encoding'];
      if (enc === 'gzip')    stream = res.pipe(zlib.createGunzip());
      if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end',  () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    }).on('error', reject);
  });
}

function parseCSVLine(line) {
  const result = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i+1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === ',' && !inQ) { result.push(cur); cur = ''; }
    else cur += ch;
  }
  result.push(cur);
  return result;
}

// Handles multiple date formats from Metabase:
// "2026-06-21T19:38:00Z" (ISO)
// "21 Jun, 2026, 19:38" (Metabase display)
// "June 21, 2026 19:38" etc.
function parseDate(s) {
  if (!s || !s.trim()) return null;
  s = s.trim();

  // Try ISO first
  let d = new Date(s);
  if (!isNaN(d.getTime())) return d;

  // Try stripping commas: "21 Jun, 2026, 19:38" → "21 Jun 2026 19:38"
  d = new Date(s.replace(/,/g, ''));
  if (!isNaN(d.getTime())) return d;

  // Try appending UTC
  d = new Date(s.replace(/,/g, '') + ' UTC');
  if (!isNaN(d.getTime())) return d;

  return null;
}

// Extract YYYY-MM-DD from various date formats for cutoff comparison
function getDateStr(s) {
  if (!s || !s.trim()) return '';
  s = s.trim();

  // ISO format: starts with YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);

  // Parse and convert
  const d = parseDate(s);
  if (d) return d.toISOString().slice(0, 10);
  return '';
}

function mapRow(r) {
  const createdAt   = parseDate(r.createdAt);
  const finalTime   = parseDate(r.final_time);
  const firstQcDone = parseDate(r.first_qc_done);

  const tatTime = firstQcDone || finalTime;
  let tat = null;
  if (createdAt && tatTime) {
    const ms = tatTime.getTime() - createdAt.getTime();
    if (ms > 0) tat = parseFloat((ms / 3600000).toFixed(2));
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

  const row = {};
  const set = (k, v) => { if (v !== null && v !== undefined && v !== '') row[k] = v; };

  set('c',    r.createdAt);
  set('u',    r.final_time);
  set('ent',  r.enterprise_name);
  set('team', r.team_name);
  set('qc',   r.qc_user);
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
  set('final_status',       r.final_status);
  set('issues_by_severity', r.issues_by_severity);
  if (r.manual_editing === true || r.manual_editing === 'true' || r.manual_editing === 1)
    row.manual_editing = true;

  return row;
}

async function main() {
  console.log('Fetching CSV from Metabase...');
  const t0 = Date.now();
  const text = await fetchCSV(URL);
  console.log(`Fetched ${(text.length/1024/1024).toFixed(1)} MB in ${((Date.now()-t0)/1000).toFixed(1)}s`);

  const lines = text.split('\n');
  console.log(`Total lines: ${lines.length}`);
  const headers = parseCSVLine(lines[0]);
  console.log(`Headers: ${headers.join(', ')}`);

  // Log first data row to see date format
  for (let i = 1; i <= 5; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    const vals = parseCSVLine(line);
    const r = {};
    headers.forEach((h, idx) => { r[h] = vals[idx] ?? ''; });
    console.log(`Sample createdAt: "${r.createdAt}" | crm_status: "${r.crm_status}" | dateStr: "${getDateStr(r.createdAt)}"`);
    break;
  }

  const cutoff = new Date(Date.now() - KEEP_MONTHS * 30 * 24 * 3600 * 1000)
    .toISOString().slice(0, 10);
  console.log(`Cutoff: ${cutoff}`);

  const rows = [];
  let skipped = 0, badDate = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const vals = parseCSVLine(line);
    const r = {};
    headers.forEach((h, idx) => { r[h] = vals[idx] ?? ''; });

    const isPending = (r.crm_status || '') === 'qc_unassigned';
    const dateStr   = getDateStr(r.createdAt);

    if (!dateStr) { badDate++; continue; }
    if (!isPending && dateStr < cutoff) { skipped++; continue; }

    rows.push(mapRow(r));
  }

  console.log(`Kept: ${rows.length} | Skipped old: ${skipped} | Bad date: ${badDate}`);

  const delivered = rows.filter(r => (r.final_status||'').trim() === 'Delivered').length;
  const rejected  = rows.filter(r => ['QC Failed','Validation Failed','Tech Failure','AI Failed']
    .includes((r.final_status||'').trim())).length;
  const pending   = rows.filter(r => (r.crm_status||'').trim() === 'qc_unassigned').length;

  const payload = {
    rows,
    lastSynced: new Date().toISOString(),
    meta: { total: rows.length, delivered, rejected, pending, cutoff },
  };

  const json = JSON.stringify(payload);
  console.log(`Output: ${(json.length/1024/1024).toFixed(2)} MB`);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, json);
  console.log(`✅ Written → public/data.json (${rows.length} rows)`);
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
