// scripts/sync-data.js — GitHub Actions data sync
// Runs in Node.js on GitHub Actions (no memory/timeout limits)
// Saves compact JSON to public/data.json → served as static file

const fs   = require('fs');
const path = require('path');
const https= require('https');
const zlib = require('zlib');

// ── Metabase auth (session-token based, NOT the public-link method) ──
// Requires GitHub Actions secrets: METABASE_USERNAME, METABASE_PASSWORD
// (never hardcode credentials here; they are injected as env vars by the workflow).
const METABASE_BASE     = process.env.METABASE_BASE     || 'https://metabase.spyne.ai';
const METABASE_CARD_ID  = process.env.METABASE_CARD_ID  || '12025'; // 360-vin-data(NK) model
const METABASE_USERNAME = process.env.METABASE_USERNAME;
const METABASE_PASSWORD = process.env.METABASE_PASSWORD;
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

// POST helper — sends JSON body, returns parsed JSON response.
function postJSON(url, bodyObj, extraHeaders = {}) {
    const data = JSON.stringify(bodyObj);
    const u = new URL(url);
    return new Promise((resolve, reject) => {
          const req = https.request(u, {
                  method: 'POST',
                  headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(data),
                        ...extraHeaders,
                  },
          }, res => {
                  const chunks = [];
                  res.on('data', c => chunks.push(c));
                  res.on('end', () => {
                        const body = Buffer.concat(chunks).toString('utf8');
                        if (res.statusCode < 200 || res.statusCode >= 300) {
                                  return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0,300)}`));
                        }
                        try { resolve(JSON.parse(body)); }
                        catch (e) { reject(new Error('Invalid JSON response: ' + body.slice(0,300))); }
                  });
          });
          req.on('error', reject);
          req.write(data);
          req.end();
    });
}

// Logs in with username/password (from GitHub Actions secrets) and returns a
// short-lived Metabase session token. Never logs the credentials themselves.
async function getMetabaseSession() {
    if (!METABASE_USERNAME || !METABASE_PASSWORD) {
          throw new Error('Missing METABASE_USERNAME / METABASE_PASSWORD — set them as GitHub Actions secrets.');
    }
    console.log('Authenticating with Metabase…');
    const resp = await postJSON(`${METABASE_BASE}/api/session`, {
          username: METABASE_USERNAME,
          password: METABASE_PASSWORD,
    });
    if (!resp || !resp.id) throw new Error('Metabase login did not return a session token.');
    console.log('Metabase session acquired.');
    return resp.id;
}

// Fetches a card/model's data as CSV using an authenticated session token
// (works for both regular questions and Models — both are "cards" in Metabase's API).
function fetchCardCSV(cardId, sessionToken, redirects = 0) {
    if (redirects > 5) return Promise.reject(new Error('Too many redirects'));
    const url = `${METABASE_BASE}/api/card/${cardId}/query/csv`;
    const postData = 'parameters=%5B%5D'; // form-encoded empty parameters array
    return new Promise((resolve, reject) => {
          const req = https.request(url, {
                  method: 'POST',
                  headers: {
                        'X-Metabase-Session': sessionToken,
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Content-Length': Buffer.byteLength(postData),
                        'Accept-Encoding': 'gzip, deflate',
                  },
          }, res => {
                  if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
                            return resolve(fetchCardCSV(cardId, sessionToken, redirects + 1));
                  if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} fetching card CSV`));
                  let stream = res;
                  const enc = res.headers['content-encoding'];
                  if (enc === 'gzip')    stream = res.pipe(zlib.createGunzip());
                  if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
                  const chunks = [];
                  stream.on('data', c => chunks.push(c));
                  stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
                  stream.on('error', reject);
          });
          req.on('error', reject);
          req.write(postData);
          req.end();
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

const _diag = { withProcessed:0, fallback:0, sample:[] };

function mapRow(r) {
    const ca  = parseDate(r.createdAt);      // SKU created_at
  const pa  = parseDate(r.processedAt || r.processed_at || r.processed_on); // processed timestamp (E2E start)
  const sc  = parseDate(r.sku_created_on); // sku_created_on (for TAT/SLA)
  const ft  = parseDate(r.final_time);
    const fq  = parseDate(r.first_qc_done);  // first QC done time

  // TAT = sku_created_on to first_qc_done
  let tat = null;
    if (sc && fq) {
          const ms = fq - sc;
          if (ms > 0) tat = Math.round(ms / 36000) / 100;
    }

  // E2E TAT = processedAt -> first_qc_done
  //   Fallback: if processedAt is null/blank/not a valid date, use createdAt -> first_qc_done
  let e2e = null;
    const e2eStart = pa || ca;   // pa is null when processedAt is blank/invalid
    if (e2eStart && fq) {
          const ms = fq - e2eStart;
          if (ms > 0) e2e = Math.round(ms / 36000) / 100;
    }
    // --- E2E diagnostics ---
    if (pa) _diag.withProcessed++; else _diag.fallback++;
    if (_diag.sample.length < 6 && fq) _diag.sample.push({ processedAt:r.processedAt, processed_at:r.processed_at, processed_on:r.processed_on, createdAt:r.createdAt, first_qc_done:r.first_qc_done, e2e });

  // SLA = sku_created_on to first_qc_done <= 6h
  const finalStatus = (r.final_status || '').trim();
    let sla = null;
    if (tat !== null && finalStatus !== 'Under Review')
          sla = tat <= SLA_H ? 1 : 0;

  const row = {};
    const set = (k, v) => { if (v != null && v !== '') row[k] = v; };

  set('c',   r.createdAt);
    set('u',   r.final_time);
    set('ent', r.enterprise_name);
    set('tm',  r.team_name);
    set('qc',  r.qc_user);
    if (sla !== null) row.sla = sla;
    if (tat !== null) row.tat = tat;
    if (e2e !== null) row.e2e = e2e;
    set('rej', r.failure_reason);
    set('vid', r.mediaId);
    set('sid', r['ss.spin_id']);
    set('vm',  r['fd.platform']);
    set('cs',  r.crm_status);
    set('csCol', r.CS);     // "CS" column (distinct from crm_status) — used in Find VIN detail card
    set('ob',  r.OB);       // "OB" column — fallback shown when CS is blank
    set('seg', r.customer_segment);
    set('tt',  r.input_type);
    set('vin', r.vinName);
    set('sku', r.spin_sku_id);
    set('fs',  r.final_status);
    set('isv', r.issues_by_severity);
    if (r.manual_editing === 'true' || r.manual_editing === true) row.me = 1;
    if (r.is_assisted_by_qc === 'true' || r.is_assisted_by_qc === true) row.aq = 1;

  return row;
}

async function main() {
    console.log('Fetching CSV from Metabase (authenticated)...');
    const t0   = Date.now();
    const sessionToken = await getMetabaseSession();
    const text = await fetchCardCSV(METABASE_CARD_ID, sessionToken);
    console.log(`Fetched ${(text.length/1024/1024).toFixed(1)}MB in ${((Date.now()-t0)/1000).toFixed(1)}s`);

  const lines   = text.split('\n');
    const headers = parseCSVLine(lines[0]);
    console.log(`Total rows: ${lines.length - 1}`);
    console.log('[CSV headers] ' + headers.join(' | '));
    const procCol = headers.find(h => /processed/i.test(h));
    console.log('[processed-like column] ' + (procCol || 'NONE FOUND — E2E will always fall back to createdAt'));

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

      const isPending = r.crm_status === 'qc_unassigned' || r.crm_status === 'qc_inprogress';
        const dateStr   = getDateStr(r.createdAt);
        if (!dateStr) { skipped++; continue; }
        if (!isPending && dateStr < cutoff) { skipped++; continue; }

      rows.push(mapRow(r));
  }

  console.log(`Kept: ${rows.length} | Skipped: ${skipped}`);
    console.log(`[E2E] rows using processedAt: ${_diag.withProcessed} | fell back to createdAt: ${_diag.fallback}`);
    console.log('[E2E sample] ' + JSON.stringify(_diag.sample, null, 0));

  const delivered = rows.filter(r => r.fs === 'Delivered').length;
    const rejected  = rows.filter(r => ['QC Failed','Validation Failed'].includes(r.fs||'')).length;
    const pending   = rows.filter(r => r.cs === 'qc_unassigned' || r.cs === 'qc_inprogress').length;

  const payload = {
        rows,
        lastSynced: new Date().toISOString(),
        meta: { total: rows.length, delivered, rejected, pending,
          e2eDiag: { withProcessedAt: _diag.withProcessed, fellBackToCreatedAt: _diag.fallback, sample: _diag.sample } },
  };

  const json   = JSON.stringify(payload);
    console.log(`Output: ${(json.length/1024/1024).toFixed(2)} MB`);
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, json);
    console.log(`Done in ${((Date.now()-t0)/1000).toFixed(1)}s`);
}

main().catch(err => { console.error('Failed:', err.message); process.exit(1); });
