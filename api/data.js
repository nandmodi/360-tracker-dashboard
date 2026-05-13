/**
 * api/data.js — Vercel Serverless Function
 * -----------------------------------------
 * Fetches Spyne Metabase data and maps exact CSV columns to the
 * shape the Ops Dashboard HTML expects.
 *
 * CSV columns:
 *  mediaId, createdAt, enterpriseId, enterprise_name, teamId, team_name,
 *  vinName, spin_sku_id, video_count, fd.platform, exterior_image_count,
 *  fd.source, input_type, failure_reason, final_status, is_assisted_by_qc,
 *  issues_by_severity, is_mvg, final_time, placement_logic, retry_count,
 *  ss.spin_id, crm_status, ss.qc_user_id, qc_user, spin_id_create_time,
 *  version_count
 *
 * Dashboard fields expected:
 *  c, u, ent, team, qc, poc_ob, poc_cs, crm, ver, sla, tat,
 *  rej, vid, vurl, vmode, ttype, vin, sku
 */

const UUID         = "7f9326d8-9eb9-4cc2-bded-efb1aac967db";
const METABASE_URL = `https://metabase.spyne.ai/api/public/card/${UUID}/query/json`;

// SLA threshold in hours — records completed within this are "Within SLA"
const SLA_THRESHOLD_HOURS = 24;

// ── Date parser ───────────────────────────────────────────────────────────────
// Handles "19 Feb, 2026, 08:16" and ISO strings
function parseDate(s) {
  if (!s) return null;
  const clean = String(s).trim().replace(/"/g, "");
  // Try native parse first (handles ISO)
  const d1 = new Date(clean);
  if (!isNaN(d1.getTime())) return d1;
  // Handle "DD Mon, YYYY, HH:MM" → "DD Mon YYYY HH:MM"
  const normalized = clean.replace(/,/g, "");
  const d2 = new Date(normalized);
  return isNaN(d2.getTime()) ? null : d2;
}

// ── Status mapping ─────────────────────────────────────────────────────────────
// final_status → crm + ver fields the dashboard uses
//   isDelivered = crm==='qc_done' && ver==='verified'
//   isRejected  = crm==='qc_done' && ver==='rejected'
//   isPending   = crm!=='qc_done'
function mapStatus(finalStatus, crmStatus) {
  const fs = String(finalStatus || "").trim().toLowerCase();
  const cs = String(crmStatus  || "").trim().toLowerCase();

  if (fs === "delivered") {
    return { crm: "qc_done", ver: "verified" };
  }
  if (fs === "qc failed" || fs === "rejected" || fs === "failed") {
    return { crm: "qc_done", ver: "rejected" };
  }
  // Pending / in-progress
  if (cs === "qc_done") {
    return { crm: "qc_done", ver: "none" };
  }
  return { crm: cs || "processing", ver: "none" };
}

// ── Row mapper ────────────────────────────────────────────────────────────────
function mapRow(r) {
  const createdAt = parseDate(r.createdAt);
  const finalTime = parseDate(r.final_time);

  // TAT in hours between creation and completion
  let tat = null;
  if (createdAt && finalTime) {
    const diffMs = finalTime.getTime() - createdAt.getTime();
    if (diffMs >= 0) tat = diffMs / 3_600_000; // ms → hours
  }

  const { crm, ver } = mapStatus(r.final_status, r.crm_status);

  // SLA: only meaningful for completed records
  let sla = null;
  if (tat !== null && (ver === "verified" || ver === "rejected")) {
    sla = tat <= SLA_THRESHOLD_HOURS ? 1 : 0;
  }

  return {
    // ── Core dashboard fields ──────────────────────────────────────
    c:       r.createdAt,                          // created timestamp
    u:       r.final_time,                         // updated timestamp
    ent:     r.enterprise_name,                    // enterprise name
    team:    r.team_name,                          // team name
    qc:      r.qc_user,                            // QC user name
    poc_ob:  null,                                 // not in dataset
    poc_cs:  null,                                 // not in dataset
    crm,                                           // crm status
    ver,                                           // verified / rejected / none
    sla,                                           // 1 = within, 0 = out, null
    tat,                                           // hours (computed)
    rej:     r.failure_reason   || null,           // rejection reason
    vid:     r.mediaId          || r["ss.spin_id"],// media / spin ID
    vurl:    null,                                 // no URL in dataset
    vmode:   r["fd.platform"],                     // FTP / App_ios / App_android
    ttype:   r.input_type,                         // "video" / "8 or more images"
    vin:     r.vinName,                            // VIN
    sku:     r.spin_sku_id,                        // SKU

    // ── Extra fields (shown in table, available for drill-downs) ──
    final_status:         r.final_status,
    platform:             r["fd.platform"],
    source:               r["fd.source"],
    video_count:          r.video_count,
    exterior_image_count: r.exterior_image_count,
    issues_by_severity:   r.issues_by_severity,
    is_assisted_by_qc:    r.is_assisted_by_qc,
    is_mvg:               r.is_mvg,
    placement_logic:      r.placement_logic,
    retry_count:          r.retry_count,
    version_count:        r.version_count,
    spin_id:              r["ss.spin_id"],
    enterprise_id:        r.enterpriseId,
    team_id:              r.teamId,
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate");

  try {
    const response = await fetch(METABASE_URL);

    if (!response.ok) {
      return res.status(500).json({ error: `Metabase error: ${response.status}` });
    }

    const raw = await response.json();

    // Metabase public JSON endpoint returns an array of row objects
    let rawRows = [];
    if (Array.isArray(raw)) {
      rawRows = raw;
    } else if (raw?.data?.rows && raw?.data?.cols) {
      // Columnar format → row objects
      const cols = raw.data.cols.map(c => c.display_name || c.name);
      rawRows = raw.data.rows.map(r =>
        Object.fromEntries(r.map((v, i) => [cols[i], v]))
      );
    } else if (Array.isArray(raw?.rows)) {
      rawRows = raw.rows;
    }

    const rows = rawRows.map(mapRow);

    // Summary log (visible in Vercel function logs)
    const delivered = rows.filter(r => r.crm === "qc_done" && r.ver === "verified").length;
    const rejected  = rows.filter(r => r.crm === "qc_done" && r.ver === "rejected").length;
    const pending   = rows.filter(r => r.crm !== "qc_done").length;
    console.log(`[api/data] total=${rows.length} delivered=${delivered} rejected=${rejected} pending=${pending}`);

    res.status(200).json({
      rows,
      lastSynced: new Date().toISOString(),
      meta: { total: rows.length, delivered, rejected, pending },
    });

  } catch (err) {
    console.error("[api/data] error:", err.message);
    res.status(500).json({ error: err.message });
  }
};
