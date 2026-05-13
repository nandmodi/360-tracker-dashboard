const UUID         = "7f9326d8-9eb9-4cc2-bded-efb1aac967db";
const METABASE_URL = `https://metabase.spyne.ai/api/public/card/${UUID}/query/json`;

const norm = s => String(s ?? "").toLowerCase().replace(/[\s_\-]/g, "");

const FIELD_MAP = [
  ["c",      ["created_at","created","create_time","createdat","date_created","c"]],
  ["u",      ["updated_at","updated","update_time","updatedat","last_updated","u"]],
  ["ent",    ["enterprise","enterprise_name","enterprisename","ent","company","client"]],
  ["team",   ["team","team_name","teamname","group"]],
  ["qc",     ["qc_user","qc_name","qc","user","username","assigned_to","owner","email"]],
  ["poc_ob", ["poc_ob","pocob","ob_poc","poc_outbound","account_manager","am"]],
  ["poc_cs", ["poc_cs","poccs","cs_poc","poc_customer","customer_success","cs"]],
  ["crm",    ["crm_status","crm","status","workflow_status","state"]],
  ["ver",    ["verified","verification","ver","verification_status","qc_status"]],
  ["sla",    ["sla","sla_status","sla_flag","within_sla","sla_met"]],
  ["tat",    ["tat","tat_hrs","tat_hours","turnaround","turn_around_time","tathrs"]],
  ["rej",    ["rejection_reason","rej_reason","rejection","reason","rej"]],
  ["vid",    ["video_id","vid","video","id","record_id","asset_id"]],
  ["vurl",   ["video_url","vurl","url","link","asset_url","file_url"]],
  ["vmode",  ["video_mode","vmode","mode","asset_type"]],
  ["ttype",  ["template_type","ttype","template","temp_type","temptype"]],
  ["vin",    ["vin","vehicle_id","vehicle_number","vin_number"]],
  ["sku",    ["sku","sku_id","product_sku","item_sku","part_number"]],
];

function buildLookup() {
  const map = {};
  for (const [target, sources] of FIELD_MAP)
    for (const src of sources) map[norm(src)] = target;
  return map;
}

function mapRow(raw, lookup, rawKeys) {
  const out = {};
  for (const key of rawKeys) {
    const target = lookup[norm(key)];
    if (target) out[target] = raw[key];
  }

  // SLA → 1 / 0 / null
  if ("sla" in out) {
    const v = out.sla;
    if (v === true  || v === 1 || /^(1|yes|within|in|true|pass)$/i.test(String(v))) out.sla = 1;
    else if (v === false || v === 0 || /^(0|no|out|false|fail)$/i.test(String(v)))  out.sla = 0;
    else out.sla = null;
  }

  // TAT → number
  if ("tat" in out) {
    const t = parseFloat(out.tat);
    out.tat = isNaN(t) ? null : t;
  }

  // Derive ver from crm if not present
  if (!("ver" in out) && "crm" in out) {
    const s = String(out.crm ?? "").toLowerCase();
    if (/verif/.test(s))        out.ver = "verified";
    else if (/reject/.test(s))  out.ver = "rejected";
    else                        out.ver = "none";
  }
  if (!out.crm) out.crm = "qc_done";

  // Keep unmapped columns too
  for (const key of rawKeys)
    if (!lookup[norm(key)]) out[key] = raw[key];

  return out;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate");

  try {
    const response = await fetch(METABASE_URL);
    if (!response.ok)
      return res.status(500).json({ error: `Metabase error: ${response.status}` });

    const raw = await response.json();

    let rawRows = [];
    if (Array.isArray(raw)) {
      rawRows = raw;
    } else if (raw?.data?.rows && raw?.data?.cols) {
      const cols = raw.data.cols.map(c => c.display_name || c.name);
      rawRows = raw.data.rows.map(r => Object.fromEntries(r.map((v, i) => [cols[i], v])));
    } else if (Array.isArray(raw?.rows)) {
      rawRows = raw.rows;
    }

    const lookup  = buildLookup();
    const rawKeys = rawRows.length ? Object.keys(rawRows[0]) : [];
    const rows    = rawRows.map(r => mapRow(r, lookup, rawKeys));

    res.status(200).json({ rows, lastSynced: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
