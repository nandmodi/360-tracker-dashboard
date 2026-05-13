import { useEffect, useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, LineChart, Line, Legend
} from "recharts";

export default function Dashboard() {
  const [data, setData]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [view, setView]       = useState("table"); // "table" | "bar" | "line"
  const [search, setSearch]   = useState("");
  const [lastUpdated, setLastUpdated] = useState(null);

  useEffect(() => {
    fetchData();
  }, []);

  function fetchData() {
    setLoading(true);
    setError(null);
    fetch("/api/data")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setData(Array.isArray(d) ? d : []);
        setLastUpdated(new Date().toLocaleTimeString());
        setLoading(false);
      })
      .catch((e) => {
        setError(e.message);
        setLoading(false);
      });
  }

  const keys        = data.length ? Object.keys(data[0]) : [];
  const numericKeys = keys.filter((k) => typeof data[0]?.[k] === "number");
  const labelKey    = keys[0] || "";
  const valueKey    = numericKeys[0] || keys[1] || "";

  const filtered = data.filter((row) =>
    search === "" ||
    keys.some((k) => String(row[k] ?? "").toLowerCase().includes(search.toLowerCase()))
  );

  const chartData = filtered.slice(0, 20).map((row) => ({
    name: String(row[labelKey] ?? "").slice(0, 20),
    ...numericKeys.reduce((acc, k) => ({ ...acc, [k]: row[k] }), {}),
  }));

  const kpis = numericKeys.slice(0, 4).map((k) => ({
    label: k,
    value: data.reduce((sum, r) => sum + (Number(r[k]) || 0), 0),
  }));

  return (
    <div style={styles.root}>
      {/* Sidebar */}
      <aside style={styles.sidebar}>
        <div style={styles.logo}>
          <span style={styles.logoIcon}>360°</span>
          <span style={styles.logoText}>360 Dashboard</span>
        </div>
        <nav style={styles.nav}>
          {["Overview", "Charts", "Data Table", "Settings"].map((item, i) => (
            <div key={item} style={{ ...styles.navItem, ...(i === 0 ? styles.navActive : {}) }}>
              {item}
            </div>
          ))}
        </nav>
        <div style={styles.sidebarFooter}>
          <div style={styles.footerDot} />
          <span style={{ fontSize: 11, color: "#94a3b8" }}>Live — Metabase</span>
        </div>
      </aside>

      {/* Main */}
      <main style={styles.main}>
        {/* Header */}
        <header style={styles.header}>
          <div>
            <h1 style={styles.title}>360 Dashboard</h1>
            {lastUpdated && (
              <p style={styles.subtitle}>Last updated: {lastUpdated}</p>
            )}
          </div>
          <div style={styles.headerActions}>
            <button onClick={fetchData} style={styles.refreshBtn}>
              ↻ Refresh
            </button>
          </div>
        </header>

        {loading && (
          <div style={styles.center}>
            <div style={styles.spinner} />
            <p style={{ color: "#64748b", marginTop: 12 }}>Fetching data from Metabase...</p>
          </div>
        )}

        {error && (
          <div style={styles.errorBox}>
            <strong>Failed to load data</strong>
            <p style={{ margin: "6px 0 0", fontSize: 13 }}>{error}</p>
            <button onClick={fetchData} style={styles.retryBtn}>Retry</button>
          </div>
        )}

        {!loading && !error && data.length > 0 && (
          <>
            {/* KPI Cards */}
            {kpis.length > 0 && (
              <div style={styles.kpiRow}>
                {kpis.map((kpi) => (
                  <div key={kpi.label} style={styles.kpiCard}>
                    <p style={styles.kpiLabel}>{kpi.label}</p>
                    <p style={styles.kpiValue}>
                      {Number(kpi.value.toFixed(0)).toLocaleString()}
                    </p>
                  </div>
                ))}
                <div style={styles.kpiCard}>
                  <p style={styles.kpiLabel}>Total rows</p>
                  <p style={styles.kpiValue}>{data.length.toLocaleString()}</p>
                </div>
              </div>
            )}

            {/* View toggle + search */}
            <div style={styles.toolbar}>
              <div style={styles.toggleGroup}>
                {["table", "bar", "line"].map((v) => (
                  <button
                    key={v}
                    onClick={() => setView(v)}
                    style={{ ...styles.toggleBtn, ...(view === v ? styles.toggleActive : {}) }}
                  >
                    {v === "table" ? "⊞ Table" : v === "bar" ? "▪ Bar" : "∿ Line"}
                  </button>
                ))}
              </div>
              <input
                placeholder="Search..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={styles.searchInput}
              />
            </div>

            {/* Chart view */}
            {(view === "bar" || view === "line") && chartData.length > 0 && (
              <div style={styles.chartCard}>
                <ResponsiveContainer width="100%" height={340}>
                  {view === "bar" ? (
                    <BarChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 60 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                      <XAxis dataKey="name" tick={{ fontSize: 11 }} angle={-35} textAnchor="end" />
                      <YAxis tick={{ fontSize: 11 }} />
                      <Tooltip />
                      <Legend />
                      {numericKeys.slice(0, 3).map((k, i) => (
                        <Bar key={k} dataKey={k} fill={["#6366f1","#06b6d4","#f59e0b"][i]} radius={[4,4,0,0]} />
                      ))}
                    </BarChart>
                  ) : (
                    <LineChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 60 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                      <XAxis dataKey="name" tick={{ fontSize: 11 }} angle={-35} textAnchor="end" />
                      <YAxis tick={{ fontSize: 11 }} />
                      <Tooltip />
                      <Legend />
                      {numericKeys.slice(0, 3).map((k, i) => (
                        <Line key={k} type="monotone" dataKey={k} stroke={["#6366f1","#06b6d4","#f59e0b"][i]} strokeWidth={2} dot={false} />
                      ))}
                    </LineChart>
                  )}
                </ResponsiveContainer>
              </div>
            )}

            {/* Table view */}
            {view === "table" && (
              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      {keys.map((k) => (
                        <th key={k} style={styles.th}>{k}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((row, i) => (
                      <tr key={i} style={i % 2 === 0 ? {} : { background: "#f8fafc" }}>
                        {keys.map((k) => (
                          <td key={k} style={styles.td}>{row[k] ?? "—"}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {filtered.length === 0 && (
                  <p style={{ padding: 24, color: "#94a3b8", textAlign: "center" }}>No results match your search.</p>
                )}
              </div>
            )}
          </>
        )}

        {!loading && !error && data.length === 0 && (
          <div style={styles.center}>
            <p style={{ color: "#94a3b8" }}>No data returned from Metabase.</p>
          </div>
        )}
      </main>
    </div>
  );
}

const styles = {
  root: {
    display: "flex", minHeight: "100vh", background: "#f1f5f9",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },
  sidebar: {
    width: 220, background: "#0f172a", display: "flex",
    flexDirection: "column", padding: "24px 0", flexShrink: 0,
  },
  logo: {
    display: "flex", alignItems: "center", gap: 10,
    padding: "0 20px 28px", borderBottom: "1px solid #1e293b",
  },
  logoIcon: {
    background: "#6366f1", color: "#fff", borderRadius: 8,
    width: 32, height: 32, display: "flex", alignItems: "center",
    justifyContent: "center", fontSize: 11, fontWeight: 700,
  },
  logoText: { color: "#f1f5f9", fontSize: 15, fontWeight: 600 },
  nav: { padding: "20px 12px", flex: 1 },
  navItem: {
    padding: "9px 12px", borderRadius: 6, color: "#94a3b8",
    fontSize: 13, cursor: "pointer", marginBottom: 2,
  },
  navActive: { background: "#1e293b", color: "#f1f5f9" },
  sidebarFooter: {
    padding: "16px 20px", borderTop: "1px solid #1e293b",
    display: "flex", alignItems: "center", gap: 8,
  },
  footerDot: {
    width: 7, height: 7, borderRadius: "50%", background: "#22c55e",
  },
  main: { flex: 1, padding: 28, overflow: "auto" },
  header: {
    display: "flex", justifyContent: "space-between",
    alignItems: "flex-start", marginBottom: 24,
  },
  title: { fontSize: 22, fontWeight: 600, margin: 0, color: "#0f172a" },
  subtitle: { fontSize: 12, color: "#94a3b8", margin: "4px 0 0" },
  headerActions: { display: "flex", gap: 10 },
  refreshBtn: {
    padding: "8px 16px", background: "#6366f1", color: "#fff",
    border: "none", borderRadius: 8, cursor: "pointer", fontSize: 13,
  },
  center: {
    display: "flex", flexDirection: "column",
    alignItems: "center", justifyContent: "center", minHeight: 300,
  },
  spinner: {
    width: 36, height: 36, border: "3px solid #e2e8f0",
    borderTop: "3px solid #6366f1", borderRadius: "50%",
    animation: "spin 0.8s linear infinite",
  },
  errorBox: {
    background: "#fef2f2", border: "1px solid #fecaca",
    borderRadius: 10, padding: 20, color: "#b91c1c", maxWidth: 500,
  },
  retryBtn: {
    marginTop: 12, padding: "6px 14px", background: "#ef4444",
    color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13,
  },
  kpiRow: { display: "flex", gap: 16, marginBottom: 24, flexWrap: "wrap" },
  kpiCard: {
    background: "#fff", borderRadius: 12, padding: "18px 22px",
    flex: "1 1 160px", boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
  },
  kpiLabel: { fontSize: 12, color: "#94a3b8", margin: "0 0 6px", textTransform: "uppercase", letterSpacing: "0.05em" },
  kpiValue: { fontSize: 26, fontWeight: 700, color: "#0f172a", margin: 0 },
  toolbar: {
    display: "flex", justifyContent: "space-between",
    alignItems: "center", marginBottom: 16, gap: 12, flexWrap: "wrap",
  },
  toggleGroup: { display: "flex", gap: 6 },
  toggleBtn: {
    padding: "7px 14px", border: "1px solid #e2e8f0", background: "#fff",
    borderRadius: 8, cursor: "pointer", fontSize: 13, color: "#64748b",
  },
  toggleActive: { background: "#6366f1", color: "#fff", borderColor: "#6366f1" },
  searchInput: {
    padding: "7px 14px", border: "1px solid #e2e8f0", borderRadius: 8,
    fontSize: 13, outline: "none", minWidth: 200, background: "#fff",
  },
  chartCard: {
    background: "#fff", borderRadius: 12, padding: "20px 8px",
    marginBottom: 24, boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
  },
  tableWrap: {
    background: "#fff", borderRadius: 12, overflow: "hidden",
    boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
  },
  table: { width: "100%", borderCollapse: "collapse" },
  th: {
    padding: "12px 16px", textAlign: "left", fontSize: 12,
    fontWeight: 600, color: "#64748b", background: "#f8fafc",
    borderBottom: "1px solid #e2e8f0", textTransform: "uppercase", letterSpacing: "0.04em",
  },
  td: {
    padding: "11px 16px", fontSize: 13, color: "#1e293b",
    borderBottom: "1px solid #f1f5f9",
  },
};
