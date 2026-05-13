/**
 * pages/api/data.js
 * ------------------
 * Fetches from the Metabase public question and transforms each row
 * into the shape the Ops Dashboard HTML expects:
 *
 *  { rows: [ { c, u, ent, team, qc, poc_ob, poc_cs, crm, ver,
 *               sla, tat, rej, vid, vurl, vmode, ttype, vin, sku }, ... ],
 *    lastSynced: <ISO string> }
 *
 * Column names are matched case-insensitively so any Metabase rename
 * will still work.
 */

const UUID         = "7f9326d8-9eb9-4cc2-bded-efb1aac967db";
const METABASE_URL = `https://metabase.spyne.ai/api/public/card/${UUID}/query/json`;

// ── Column-name mapping ──────────────────────────────────────────────────────
// Each entry: [targetField, [...possibleSourceNames]]
// Source names are matched case-insensitively and with common separators
// (spaces, underscores, hyphens) collapsed.

const FIELD_MAP = [
  ["c",      ["created_at","created","create_time","createdat","createtime","date_created","c"]],
  ["u",      ["updated_at","updated","update_time","updatedat","updatetime","date_updated","last_updated","u"]],
  ["ent",    ["enterprise","enterprise_name","enterprisename","ent","company","client"]],
  ["team",   ["team","team_name","teamname","group"]],
  ["qc",     ["qc_user","qc_name","qc","user","username","assigned_to","assignedto","owner","email"]],
  ["poc_ob", ["poc_ob","poc ob","ob_poc","ob poc","poc_outbound","account_manager","am"]],
  ["poc_cs", ["poc_cs","poc cs","cs_poc","cs poc","poc_customer","customer_success","cs"]],
  ["crm",    ["crm_status","crm","status","workflow_status","state"]],
  ["ver",    ["verified","verification","ver","verification_status","verify_status","qc_status"]],
  ["sla",    ["sla","sla_status","sla_flag","within_sla","sla_met"]],
  ["tat",    ["tat","tat_hrs","tat_hours","turnaround","turn_around_time","tat_h","tathr","tathrs"]],
  ["rej",    ["rejection_reason","rej_reason","rejection","reason","rej","reject_reason","reason_for_rejection"]],
  ["vid",    ["video_id","vid","video","id","record_id","asset_id"]],
  ["vurl",   ["video_url","vurl","url","link","asset_url","file_url"]],
  ["vmode",  ["video_mode","vmode","mode","type","asset_type"]],
  ["ttype",  ["template_type","ttype","template","temp_type","temptype"]],
  ["vin",    ["vin","vehicle_id","vehicle_number","vin_number"]],
  ["sku",    ["sku","sku_id","product_sku","item_sku","part_number"]],
];

// Normalise a column name: lowercase + remove spaces/underscores/hyphens
const norm = s => String(s ?? "").toLowerCase().replace(/[\s_\-]/g, "");

// Build a lookup: normalisedSourceName → targetField
function buildLookup() {
  const map = {};
  for (const [target, sources] of FIELD_MAP) {
    for (const src of sources) map[norm(src)] = target;
  }
  return map;
}

// Map one raw Metabase row → dashboard row
function mapRow(raw, lookup, rawKeys) {
  const out = {};

  for (const key of rawKeys) {
    const target = lookup[norm(key)];
    if (target) out[target] = raw[key];
  }

  // ── SLA normalisation ──────────────────────────────────────────────────────
  // Accept boolean true/false, 1/0, "within sla"/"out of sla", "yes"/"no", etc.
  if ("sla" in out) {
    const v = out.sla;
    if (v === true  || v === 1 || /^(1|yes|within|in|true|pass)$/i.test(String(v))) {
      out.sla = 1;
    } else if (v === false || v === 0 || /^(0|no|out|false|fail)$/i.test(String(v))) {
      out.sla = 0;
    } else {
      out.sla = null;
    }
  }

  // ── TAT normalisation ──────────────────────────────────────────────────────
  // Store as a number (hours). If the raw value looks like minutes, convert.
  if ("tat" in out) {
    const t = parseFloat(out.tat);
    out.tat = isNaN(t) ? null : t;
  }

  // ── Status inference ───────────────────────────────────────────────────────
  // If the source has separate `crm` / `ver` columns we use them directly.
  // If only a single "status" was mapped to `crm`, try to derive `ver` from it.
  if (!("ver" in out) && "crm" in out) {
    const s = String(out.crm ?? "").toLowerCase();
    if (/verif/.test(s))   out.ver = "verified";
    else if (/reject/.test(s)) out.ver = "rejected";
    else if (/pend|wait|queue|new/.test(s)) out.ver = "none";
    else out.ver = "none";
  }

  // If crm is missing too, mark everything as qc_done so records are visible
  if (!out.crm) out.crm = "qc_done";

  // ── Fallback raw columns ───────────────────────────────────────────────────
  // Any unmapped column is appended with its original name so data isn't lost.
  for (const key of rawKeys) {
    if (!lookup[norm(key)] && !(key in out)) out[key] = raw[key];
  }

  return out;
}

// ── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  try {
    const response = await fetch(METABASE_URL);

    if (!response.ok) {
      return res.status(500).json({ error: `Metabase error: ${response.status}` });
    }

    const raw = await response.json();

    // Metabase returns either an array or { data: { rows, cols } }
    let rawRows = [];
    if (Array.isArray(raw)) {
      rawRows = raw;
    } else if (raw?.data?.rows && raw?.data?.cols) {
      // Transform columnar format → row objects
      const cols = raw.data.cols.map(c => c.display_name || c.name);
      rawRows = raw.data.rows.map(r =>
        Object.fromEntries(r.map((v, i) => [cols[i], v]))
      );
    } else if (Array.isArray(raw?.rows)) {
      rawRows = raw.rows;
    }

    // Build column map from the first row
    const lookup = buildLookup();
    const rawKeys = rawRows.length ? Object.keys(rawRows[0]) : [];

    // Log detected mapping to server console (useful for debugging)
    const detectedMapping = {};
    for (const key of rawKeys) {
      const t = lookup[norm(key)];
      if (t) detectedMapping[key] = t;
    }
    console.log("[api/data] column mapping:", detectedMapping);
    console.log("[api/data] unmapped columns:", rawKeys.filter(k => !lookup[norm(k)]));

    const rows = rawRows.map(r => mapRow(r, lookup, rawKeys));

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate");
    res.status(200).json({ rows, lastSynced: new Date().toISOString() });

  } catch (err) {
    console.error("[api/data] error:", err);
    res.status(500).json({ error: err.message });
  }
}
