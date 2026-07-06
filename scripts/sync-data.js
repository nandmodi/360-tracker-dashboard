// scripts/sync-data.js — GitHub Actions data sync
// Runs in Node.js, no size limits, serves via Vercel static hosting

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const zlib  = require('zlib');

const UUID      = "7f9326d8-9eb9-4cc2-bded-efb1aac967db";
const URL       = `https://metabase.spyne.ai/api/public/card/${UUID}/query/csv`;
const SLA_H     = 6;
const OUT       = path.join(__dirname, '..', 'public', 'data.json');
const KEEP_DAYS = 183; // 6 months

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

function parseDate(s) {
  if (!s) return null;
  const d = new Date(String(s).trim());
  return isNaN(d.getTime()) ? null : d;
}

function getDateStr(s) {
  if (!s) return '';
  s = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = parseDate(s);
  return d ? d.toISOString().slice(0, 10) : '';
}

function mapRow(r) {
  const ca = parseDate(r.createdAt);
  const ft = parseDate(r.final_time);
  const fq = parseDate(r.first_qc_done);

  const tatTime = fq || ft;
  let tat = null;
  if (ca && tatTime) {
    const ms = tatTime - ca;
    if (ms > 0) tat = Math.round(ms / 36000) / 100;
  }
  let e2e_tat = null;
  if (ca && ft) {
    const ms = ft - ca;
    if (ms > 0) e2e_tat = Math.round(ms / 36000) / 100;
  }

  const fs = (r.final_status || '').trim();
  // SLA uses first_qc_done - sku_created_on (not createdAt)
  let sla = null;
  if (fq && r.sku_created_on) {
    const skuCreated = parseDate(r.sku_created_on);
    if (skuCreated) {
      const skuTat = (fq - skuCreated) / 3600000;
      if (fs !== 'Under Review' && skuTat > 0)
        sla = skuTat <= SLA_H ? 1 : 0;
    }
  } else if (tat !== null && fs !== 'Under Review') {
    sla = tat <= SLA_H ? 1 : 0; // fallback
  }

  // Only include non-null/non-empty fields to minimize JSON size
  const row = {};
  const set = (k, v) => { if (v != null && v !== '') row[k] = v; };

  set('c',    r.createdAt);
  set('u',    r.final_time);
  set('ent',  r.enterprise_name);
  set('team', r.team_name);
  set('qc',   r.qc_user);
  if (sla    !== null) row.sla    = sla;
  if (tat    !== null) row.tat    = tat;
  if (e2e_tat!== null) row.e2e_tat= e2e_tat;
  set('rej',        r.failure_reason);
  set('vid',        r.mediaId);
  set('spin_id',    r['ss.spin_id']);
  set('vmode',      r['fd.platform']);
  set('crm_status', r.crm_status);
  set('seg',        r.customer_segment);
  set('ttype',      r.input_type);
  set('vin',        r.vinName);
  set('sku',        r.spin_sku_id);
  set('sc',         r.sku_created_on); // sku_created_on for TAT calculation
  set('final_status',       r.final_status);
  set('issues_by_severity', r.issues_by_severity);
  if (r.manual_editing === 'true' || r.manual_editing === '1' || r.manual_editing === true)
    row.manual_editing = true;

  return row;
}

async function main() {
  console.log('Fetching CSV from Metabase...');
  const t0   = Date.now();
  const text = await fetchCSV(URL);
  console.log(`Fetched ${(text.length/1024/1024).toFixed(1)}MB in ${((Date.now()-t0)/1000).toFixed(1)}s`);

  const lines   = text.split('\n');
  const headers = parseCSVLine(lines[0]);
  console.log(`Total lines: ${lines.length}`);

  // Log sample date format
  for (let i = 1; i <= 3; i++) {
    const l = lines[i]?.trim(); if (!l) continue;
    const v = parseCSVLine(l); const r = {};
    headers.forEach((h,j) => r[h]=v[j]??'');
    console.log(`Sample → createdAt:"${r.createdAt}" dateStr:"${getDateStr(r.createdAt)}" crm:"${r.crm_status}"`);
    break;
  }

  const cutoff = new Date(Date.now() - KEEP_DAYS * 24 * 3600 * 1000).toISOString().slice(0,10);
  console.log(`Cutoff: ${cutoff} (${KEEP_DAYS} days)`);

  const rows = [];
  let skipped = 0, badDate = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const vals = parseCSVLine(line);
    const r    = {};
    headers.forEach((h, idx) => { r[h] = vals[idx] ?? ''; });

    const isPending = r.crm_status === 'qc_unassigned';
    const isHidden  = r.is_hidden === '1' || r.is_hidden === 1 || r.is_hidden === true;
    const dateStr   = getDateStr(r.createdAt);
    if (!dateStr)                       { badDate++; continue; }
    if (isHidden) { skipped++; continue; }
    if (!isPending && dateStr < cutoff) { skipped++;  continue; }

    rows.push(mapRow(r));
  }

  console.log(`Kept: ${rows.length} | Skipped: ${skipped} | Bad date: ${badDate}`);

  const delivered = rows.filter(r => (r.final_status||'') === 'Delivered').length;
  const rejected  = rows.filter(r => ['QC Failed','Validation Failed','Tech Failure','AI Failed']
    .includes(r.final_status||'')).length;
  const pending   = rows.filter(r => r.crm_status === 'qc_unassigned').length;

  const payload = {
    rows,
    lastSynced: new Date().toISOString(),
    meta: { total: rows.length, delivered, rejected, pending, cutoff },
  };

  const json   = JSON.stringify(payload);
  const sizeMB = (json.length/1024/1024).toFixed(2);
  console.log(`Output size: ${sizeMB} MB`);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, json);
  console.log(`✅ Written → public/data.json (${rows.length} rows, ${sizeMB} MB)`);
  console.log(`Total time: ${((Date.now()-t0)/1000).toFixed(1)}s`);
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
