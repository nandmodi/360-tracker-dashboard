/**
 * api/reports-sheet.js — reads the 360_spin / 360_rt / 360_region tabs from
 * the Delivery Metrics Google Sheet, server-side, using the service-account
 * credentials (GOOGLE_SHEETS_CREDENTIALS) — the same one sync-sheets.js uses
 * to write. The Sheet itself can now be fully private; only this endpoint
 * (and the GitHub Action that writes to it) can read it.
 *
 * Requires a valid signed session token (see api/auth-check.js) — a request
 * without one, or with an expired/invalid one, gets nothing back. This
 * closes the gap where the Sheet's data was reachable directly via gviz by
 * anyone with the Sheet ID, bypassing the dashboard's sign-in gate.
 */

const crypto = require('crypto');

const SHEET_ID = '1f_Ds-wXmAPFvyFez2QkiC9mtGiTEXphPrkvjEl1tCj0';
const SHEETS = ['360_spin', '360_rt', '360_region'];

function sign(payload) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest('base64url');
}
function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadB64, sig] = token.split('.');
  const expected = sign(payloadB64);
  const a = Buffer.from(sig || ''), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const [email, expStr] = Buffer.from(payloadB64, 'base64url').toString('utf8').split('|');
  const exp = parseInt(expStr, 10);
  if (!email || !exp || Date.now() > exp) return null;
  return email;
}
function isAllowed(email) {
  const list = (process.env.ALLOWED_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  return list.includes(email);
}

let _tokenCache = null; // { accessToken, expiresAt } — reused across warm invocations
async function getAccessToken() {
  if (_tokenCache && Date.now() < _tokenCache.expiresAt - 60000) return _tokenCache.accessToken;

  const creds = JSON.parse(process.env.GOOGLE_SHEETS_CREDENTIALS);
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claim = Buffer.from(JSON.stringify({
    iss: creds.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now,
  })).toString('base64url');
  const signInput = header + '.' + claim;
  const signature = crypto.createSign('RSA-SHA256').update(signInput).sign(creds.private_key).toString('base64url');
  const jwt = signInput + '.' + signature;

  const body = `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('No access_token from Google: ' + JSON.stringify(data));
  _tokenCache = { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

async function fetchSheetValues(accessToken, sheetName) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(sheetName)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Sheets API ${res.status} for ${sheetName}`);
  const data = await res.json();
  return data.values || [];
}
function rowsToObjects(values) {
  if (!values.length) return [];
  const headers = values[0];
  return values.slice(1).map(row => {
    const o = {};
    headers.forEach((h, i) => { o[h] = row[i] === undefined ? '' : row[i]; });
    return o;
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  const token = (req.query && req.query.token) || (req.headers['x-session-token']);
  const email = verifyToken(token);
  if (!email || !isAllowed(email)) {
    return res.status(401).json({ error: 'Not signed in or session expired' });
  }

  try {
    const accessToken = await getAccessToken();
    const results = {};
    await Promise.all(SHEETS.map(async name => {
      const values = await fetchSheetValues(accessToken, name);
      results[name] = rowsToObjects(values);
    }));
    return res.status(200).json(results);
  } catch (err) {
    console.error('[reports-sheet]', err.message);
    return res.status(500).json({ error: 'Could not read the workbook' });
  }
};
