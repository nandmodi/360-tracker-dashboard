// scripts/sync-data.js — GitHub Actions data sync
// Runs in Node.js on GitHub Actions (no memory/timeout limits)
// Saves compact JSON to public/data.json → served as static file

const fs   = require('fs');
const path = require('path');
const https= require('https');
const zlib = require('zlib');

const UUID     = "7f9326d8-9eb9-4cc2-bded-efb1aac967db";
const URL      = `https://metabase.spyne.ai/api/public/card/${UUID}/query/csv`;
const SLA_H    = 6;
const OUT      = path.join(__dirname, '..', 'public', 'data.json');
const KEEP_DAYS= 183; // 6 months

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
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
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

function parseDate(s) {
  if (!s) return null;
  const d = new Date(String(s).trim());
  return isNaN(d.getTime()) ? null : d;
}

function getDateStr(s) {
  if (!s) return '';
  const d = parseDate(s);
  return d ? d.toISOString().slice(0, 10) : '';
}

function mapRow(r) {
  const ca  = parseDate(r.createdAt);
  const ft  = parseDate(r.final_time);
  const fq  = parseDate(r.first_qc_done);
  const tatTime = fq || ft;

  let tat = null;
  if (ca && tatTime) {
    const ms = tatTime - ca;
    if (ms > 0) tat = Math.round(ms / 36000) / 100;
  }
  let e2e = null;
  if (ca && ft) {
    const ms = ft - ca;
    if (ms > 0) e2e = Math.round(ms / 36000) / 100;
  }

  const finalStatus = (r.final_status || '').trim();
  let sla = null;
  if (tat !== null && finalStatus !== 'Under Review')
    sla = tat <= SLA_H ? 1 : 0;

  // Compact field names — must match index.html exactly
  const row = {};
  const set = (k, v) => { if (v != null && v !== '') row[k] = v; };

  set('c',   r.createdAt);
  set('u',   r.final_time);
  set('ent', r.enterprise_name);
  set('tm',  r.team_name);          // tm = team_name
  set('qc',  r.qc_user);
  if (sla !== null) row.sla = sla;
  if (tat !== null) row.tat = tat;
  if (e2e !== null) row.e2e = e2e;  // e2e = e2e_tat
  set('rej', r.failure_reason);
  set('vid', r.mediaId);
  set('sid', r['ss.spin_id']);      // sid = spin_id
  set('vm',  r['fd.platform']);     // vm = vmode/platform
  set('cs',  r.crm_status);        // cs = crm_status
  set('seg', r.customer_segment);
  set('tt',  r.input_type);        // tt = ttype/input_type
  set('vin', r.vinName);
  set('sku', r.spin_sku_id);
  set('fs',  r.final_status);      // fs = final_status
  set('isv', r.issues_by_severity);// isv = issues_by_severity
  // me = manual_editing (0/1)
  if (r.manual_editing === 'true' || r.manual_editing === true) row.me = 1;
  // aq = is_assisted_by_qc (0/1) — used for Accuracy card
  if (r.is_assisted_by_qc === 'true' || r.is_assisted_by_qc === true) row.aq = 1;

  return row;
}

async function main() {
  console.log('Fetching CSV from Metabase...');
  const t0   = Date.now();
  const text = await fetchCSV(URL);
  console.log(`Fetched ${(text.length/1024/1024).toFixed(1)}MB in ${((Date.now()-t0)/1000).toFixed(1)}s`);

  const lines   = text.split('\n');
  const headers = parseCSVLine(lines[0]);
  console.log(`Total rows: ${lines.length - 1}`);

  const cutoff = new Date(Date.now() - KEEP_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10);
  console.log(`Keeping last ${KEEP_DAYS} days (cutoff: ${cutoff}) + all pending`);

  const rows = [];
  let skipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const vals = parseCSVLine(line);
    const r = {};
    headers.forEach((h, idx) => { r[h] = vals[idx] ?? ''; });

    const isPending = r.crm_status === 'qc_unassigned';
    const dateStr   = getDateStr(r.createdAt);
    if (!dateStr) { skipped++; continue; }
    if (!isPending && dateStr < cutoff) { skipped++; continue; }

    rows.push(mapRow(r));
  }

  console.log(`Kept: ${rows.length} | Skipped: ${skipped}`);

  const delivered = rows.filter(r => r.fs === 'Delivered').length;
  const rejected  = rows.filter(r => ['QC Failed','Validation Failed','Tech Failure','AI Failed'].includes(r.fs||'')).length;
  const pending   = rows.filter(r => r.cs === 'qc_unassigned').length;

  const payload = {
    rows,
    lastSynced: new Date().toISOString(),
    meta: { total: rows.length, delivered, rejected, pending },
  };

  const json   = JSON.stringify(payload);
  const sizeMB = (json.length / 1024 / 1024).toFixed(2);
  console.log(`Output: ${sizeMB} MB`);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, json);
  console.log(`✅ Saved → public/data.json (${rows.length} rows, ${sizeMB} MB)`);
  console.log(`Total time: ${((Date.now()-t0)/1000).toFixed(1)}s`);
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
