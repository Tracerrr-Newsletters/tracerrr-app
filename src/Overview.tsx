import { useEffect, useMemo, useState } from "react";
import { AreaChart, Area, Tooltip, ResponsiveContainer } from "recharts";
import { createClient } from "@supabase/supabase-js";
 
const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL ?? "",
  import.meta.env.VITE_SUPABASE_ANON_KEY ?? ""
);
 
interface Newsletter { id: string; name: string; slug: string; status: string; }
interface SubscriberSnapshot { newsletter_id: string; date: string; total_subscribers: number; active_subscribers?: number; new_subscribers_7d?: number; }
interface Send { newsletter_id: string; send_date: string; open_rate: number | null; subject_line: string; }
interface Invoice { id: string; invoice_number: string; amount: number; amount_paid?: number; status: string; due_date: string | null; sponsor_id: string | null; extracted_data: Record<string, unknown> | null; newsletter_id: string | null; revolut_transaction_id: string | null; }
interface BalanceSnapshot { date: string; balance_gbp: number; balance_usd: number; gbp_usd_rate: number; }
interface BaselineCost { id: string; name: string; allocation: string; expected_amount_usd: number; status: string; alert_notes: string | null; alert_date: string | null; }
interface RevolutTransaction { id: string; date: string; description: string | null; amount: number; currency: string; counterparty_name: string | null; match_status: string; type: string; }
interface Operation { id: string; title: string; type: string; due_date: string | null; priority: string | null; newsletter_id: string | null; }
interface Sponsor { id: string; name: string; }
interface OverviewData {
  newsletters: Newsletter[];
  latestSnapshots: SubscriberSnapshot[];
  snapshotHistory: SubscriberSnapshot[];
  recentSends: Send[];
  unpaidInvoices: Invoice[];
  sponsors: Sponsor[];
  latestBalance: BalanceSnapshot | null;
  baselineCosts: BaselineCost[];
  recentTransactions: RevolutTransaction[];
  upcomingOps: Operation[];
  q1RevenueTotal: number;
  q1RevenueByNewsletter: Record<string, number>;
  q1DealCountByNewsletter: Record<string, number>;
}
 
const currentQuarter = (): { start: string; end: string; label: string } => {
  const now = new Date();
  const q = Math.ceil((now.getMonth() + 1) / 3);
  const year = now.getFullYear();
  const starts = [`${year}-01-01`, `${year}-04-01`, `${year}-07-01`, `${year}-10-01`];
  const ends = [`${year}-03-31`, `${year}-06-30`, `${year}-09-30`, `${year}-12-31`];
  return { start: starts[q - 1], end: ends[q - 1], label: `Q${q} ${year}` };
};
 
async function fetchOverviewData(): Promise<OverviewData> {
  const { start, end } = currentQuarter();
 
  const [
    { data: newsletters },
    { data: latestSnapshots },
    { data: snapshotHistory },
    { data: recentSends },
    { data: unpaidInvoicesRaw },
    { data: latestBalanceArr },
    { data: baselineCosts },
    { data: recentTransactions },
    { data: upcomingOps },
    { data: sponsorsRaw },
  ] = await Promise.all([
    supabase.from("newsletters").select("id, name, slug, status").eq("status", "active"),
    supabase.from("subscriber_snapshots").select("newsletter_id, date, total_subscribers, active_subscribers, new_subscribers_7d").order("date", { ascending: false }).limit(10),
    supabase.from("subscriber_snapshots").select("newsletter_id, date, total_subscribers").gte("date", new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]).order("date", { ascending: true }),
    supabase.from("sends").select("newsletter_id, send_date, open_rate, subject_line").order("send_date", { ascending: false }).limit(20),
    // Only show real sponsor invoices — must have a deal_id to appear here
    supabase.from("invoices").select("id, invoice_number, amount, status, due_date, sponsor_id, extracted_data, newsletter_id, revolut_transaction_id").eq("type", "revenue").in("status", ["sent", "unmatched"]).not("deal_id", "is", null).order("due_date", { ascending: true }),
    supabase.from("balance_snapshots").select("date, balance_gbp, balance_usd, gbp_usd_rate").order("date", { ascending: false }).limit(1),
    supabase.from("baseline_costs").select("id, name, allocation, expected_amount_usd, status, alert_notes, alert_date").order("expected_amount_usd", { ascending: false }),
    supabase.from("revolut_transactions").select("id, date, description, amount, currency, counterparty_name, match_status, type").lt("amount", 0).not("type", "in", "(merchant_reserve,transfer,exchange,refund,topup,cashback)").order("date", { ascending: false }).limit(10),
    supabase.from("operations").select("id, title, type, due_date, priority, newsletter_id").is("completed_at", null).gte("due_date", new Date().toISOString().split("T")[0]).lte("due_date", new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]).order("due_date", { ascending: true }).limit(8),
    supabase.from("sponsors").select("id, name"),
  ]);
 
  // Q1 revenue = cash received in Q1 (Revolut credit landed in Q1), per newsletter
  const { data: paidInvoices } = await supabase
    .from("invoices")
    .select("id, amount, amount_paid, status, revolut_transaction_id, newsletter_id")
    .eq("type", "revenue")
    .in("status", ["matched", "paid", "partial"])
    .not("revolut_transaction_id", "is", null);
 
  const revolut_ids = (paidInvoices ?? []).map((i: any) => i.revolut_transaction_id).filter(Boolean);
  const { data: q1Credits } = revolut_ids.length > 0
    ? await supabase.from("revolut_transactions").select("id, date").in("id", revolut_ids).gte("date", start).lte("date", end)
    : { data: [] };
  const q1CreditIds = new Set((q1Credits ?? []).map((r: any) => r.id));
 
  const q1RevenueByNewsletter: Record<string, number> = {};
  const q1DealCountByNewsletter: Record<string, number> = {};
  let q1RevenueTotal = 0;
 
  for (const inv of (paidInvoices ?? [])) {
    if (!q1CreditIds.has(inv.revolut_transaction_id)) continue;
    const amount = inv.status === "partial" ? (inv.amount_paid ?? 0) : (inv.amount ?? 0);
    const nlId = inv.newsletter_id;
    if (nlId) {
      q1RevenueByNewsletter[nlId] = (q1RevenueByNewsletter[nlId] ?? 0) + amount;
      q1DealCountByNewsletter[nlId] = (q1DealCountByNewsletter[nlId] ?? 0) + 1;
    }
    q1RevenueTotal += amount;
  }
 
  return {
    newsletters: newsletters ?? [],
    latestSnapshots: latestSnapshots ?? [],
    snapshotHistory: snapshotHistory ?? [],
    recentSends: recentSends ?? [],
    unpaidInvoices: unpaidInvoicesRaw ?? [],
    sponsors: sponsorsRaw ?? [],
    latestBalance: latestBalanceArr?.[0] ?? null,
    baselineCosts: baselineCosts ?? [],
    recentTransactions: recentTransactions ?? [],
    upcomingOps: upcomingOps ?? [],
    q1RevenueTotal,
    q1RevenueByNewsletter,
    q1DealCountByNewsletter,
  };
}
 
function fmtMoney(n: number | null | undefined): string {
  if (n == null) return "—";
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}
function fmtGBP(n: number | null | undefined): string {
  if (n == null) return "—";
  if (Math.abs(n) >= 1_000) return `£${(n / 1_000).toFixed(1)}K`;
  return `£${n.toFixed(0)}`;
}
function fmtSubs(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}
function fmtPct(n: number | null | undefined): string {
  if (n == null) return "—";
  return `${(n * 100).toFixed(1)}%`;
}
function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
function daysUntil(s: string): number {
  return Math.ceil((new Date(s).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}
 
interface StatCardProps { label: string; value: string; sub?: string; variant?: "default" | "green" | "red" | "amber" | "blue"; }
function StatCard({ label, value, sub, variant = "default" }: StatCardProps) {
  const colors: Record<string, string> = { default: "#F0EDE6", green: "#1D9E75", red: "#D85A30", amber: "#EF9F27", blue: "#378ADD" };
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={{ color: colors[variant] }}>{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}
 
interface SparklineProps { data: { date: string; total_subscribers: number }[]; color: string; }
function Sparkline({ data, color }: SparklineProps) {
  if (!data.length) return <div className="sparkline-empty">No data</div>;
  return (
    <ResponsiveContainer width="100%" height={48}>
      <AreaChart data={data} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={`grad-${color.replace("#", "")}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={color} stopOpacity={0.3} />
            <stop offset="95%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area type="monotone" dataKey="total_subscribers" stroke={color} strokeWidth={1.5} fill={`url(#grad-${color.replace("#", "")})`} dot={false} isAnimationActive={false} />
        <Tooltip
          contentStyle={{ background: "#141412", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 4, fontSize: 11, fontFamily: "'DM Mono', monospace", color: "#F0EDE6" }}
          formatter={(v: number) => [fmtSubs(v), "subs"]}
          labelFormatter={(l: string) => fmtDate(l)}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
 
function AccountantReportPanel() {
  const { start, end } = currentQuarter();
  const [dateFrom, setDateFrom] = useState(start);
  const [dateTo, setDateTo] = useState(end);
  const [status, setStatus] = useState<"idle" | "loading" | "warning" | "success" | "error">("idle");
  const [message, setMessage] = useState("");
  const [, setUnmatchedCount] = useState(0);
 
  async function generateReport(override = false) {
    setStatus("loading");
    setMessage("");
    try {
      const res = await fetch("/api/accountant-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dateFrom, dateTo, override }),
      });
      const data = await res.json();
      if (!res.ok) { setStatus("error"); setMessage(data.error ?? "Something went wrong."); return; }
      if (data.warning) { setStatus("warning"); setUnmatchedCount(data.unmatchedCount ?? 0); setMessage(data.message ?? "Some transactions have no invoice."); return; }
      setStatus("success");
      const driveNote = data.driveFolderUrl ? " PDFs -> Drive." : "";
      setMessage(`Sent - ${data.transactionsIncluded ?? 0} transactions, ${data.revenueInvoices ?? 0} invoices, Net VAT $${Math.abs(data.netVatUSD ?? 0).toFixed(2)}.${driveNote}`);
    } catch (e: unknown) {
      setStatus("error");
      setMessage(e instanceof Error ? e.message : "Network error.");
    }
  }
 
  return (
    <div className="report-bar">
      <span className="report-bar-title">ACCOUNTANT REPORT</span>
      <div className="report-bar-fields">
        <div className="report-bar-field">
          <label className="report-bar-label">FROM</label>
          <input type="date" className="report-bar-input" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setStatus("idle"); }} />
        </div>
        <div className="report-bar-field">
          <label className="report-bar-label">TO</label>
          <input type="date" className="report-bar-input" value={dateTo} onChange={e => { setDateTo(e.target.value); setStatus("idle"); }} />
        </div>
        {status !== "warning" && (
          <button className="report-bar-btn" disabled={status === "loading"} onClick={() => generateReport(false)}>
            {status === "loading" ? "Generating..." : "Generate & Send"}
          </button>
        )}
      </div>
      {status === "warning" && (
        <div className="report-bar-warning">
          <span>{message}</span>
          <div className="report-bar-warning-actions">
            <button className="report-bar-ghost" onClick={() => setStatus("idle")}>Cancel</button>
            <button className="report-bar-btn" onClick={() => generateReport(true)}>Send anyway</button>
          </div>
        </div>
      )}
      {status === "success" && <div className="report-bar-success">{message}</div>}
      {status === "error" && <div className="report-bar-error">{message}</div>}
    </div>
  );
}
 
export default function Overview() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
 
  useEffect(() => {
    fetchOverviewData()
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Unknown error"))
      .finally(() => setLoading(false));
  }, []);
 
  const { label: quarterLabel } = currentQuarter();
 
  const derived = useMemo(() => {
    if (!data) return null;
    const sponsorMap = new Map((data.sponsors ?? []).map(s => [s.id, s.name]));
    const seenKeys = new Set<string>();
    let monthlyBurn = 0;
    const sortedCosts = [...(data.baselineCosts ?? [])].sort((a) => a.status === "active" ? -1 : 1);
    for (const c of sortedCosts) {
      if (c.status !== "active") continue;
      const key = `${c.name}::${c.allocation}`;
      if (!seenKeys.has(key)) { seenKeys.add(key); monthlyBurn += c.expected_amount_usd; }
    }
    const balGBP = data.latestBalance?.balance_gbp ?? null;
    const balUSD = data.latestBalance?.balance_usd ?? null;
    const gbpUsdRate = data.latestBalance?.gbp_usd_rate ?? null;
    const totalUSD = (balUSD ?? 0) + (balGBP != null && gbpUsdRate != null ? balGBP * gbpUsdRate : 0);
    const runway = monthlyBurn > 0 && totalUSD > 0 ? Math.floor(totalUSD / monthlyBurn) : null;
    const unpaidTotal = (data.unpaidInvoices ?? []).reduce((s, i) => s + (i.amount ?? 0), 0);
    const overdueInvoices = (data.unpaidInvoices ?? []).filter((i) => i.status === "overdue");
    const alerts: { label: string; severity: "warning" | "critical" }[] = [];
    for (const c of data.baselineCosts ?? []) {
      if (c.status === "cancel") alerts.push({ label: `${c.name} (${fmtMoney(c.expected_amount_usd)}/mo) - marked for cancellation`, severity: "warning" });
      if (c.alert_date && c.alert_notes) {
        const d = daysUntil(c.alert_date);
        if (d >= 0 && d <= 60) alerts.push({ label: `${c.name} - ${c.alert_notes} in ${d} days`, severity: d <= 14 ? "critical" : "warning" });
      }
    }
    for (const inv of overdueInvoices) {
      const sponsorName = inv.sponsor_id ? sponsorMap.get(inv.sponsor_id) : (inv.extracted_data?.client_name as string ?? null);
      alerts.push({ label: `${sponsorName ?? inv.invoice_number} ${fmtMoney(inv.amount)} invoice overdue`, severity: "critical" });
    }
    const openRateByNewsletter: Record<string, number | null> = {};
    for (const nl of data.newsletters ?? []) {
      const sends = (data.recentSends ?? []).filter((s) => s.newsletter_id === nl.id && s.open_rate != null).slice(0, 10);
      openRateByNewsletter[nl.id] = sends.length > 0 ? sends.reduce((s, x) => s + (x.open_rate ?? 0), 0) / sends.length : null;
    }
    const latestSubsByNewsletter: Record<string, SubscriberSnapshot> = {};
    for (const snap of data.latestSnapshots ?? []) {
      if (!latestSubsByNewsletter[snap.newsletter_id]) latestSubsByNewsletter[snap.newsletter_id] = snap;
    }
    return { monthlyBurn, totalUSD, runway, unpaidTotal, overdueInvoices, alerts, openRateByNewsletter, latestSubsByNewsletter, sponsorMap };
  }, [data]);
 
  if (loading) {
    return (
      <div className="overview-loading">
        <span className="loading-dot" />
        <span className="loading-dot" style={{ animationDelay: "0.15s" }} />
        <span className="loading-dot" style={{ animationDelay: "0.30s" }} />
      </div>
    );
  }
  if (error || !data || !derived) {
    return (
      <div className="overview-error">
        <span className="error-icon">!</span>
        <span>{error ?? "Failed to load data"}</span>
      </div>
    );
  }
 
  const totalDealCount = Object.values(data.q1DealCountByNewsletter).reduce((s, n) => s + n, 0);
  const newsletterColors = ["#1D9E75", "#378ADD"];
 
  return (
    <div className="overview">
      <div className="overview-header">
        <div>
          <><style>{`@keyframes titleFlow { 0%, 100% { color: #ffffff; } 50% { color: #1D9E75; } } .overview-title-animated { animation: titleFlow 3s ease-in-out infinite; }`}</style><h1 className="overview-title overview-title-animated">Overview</h1></>
          <div className="overview-subtitle">{quarterLabel} · Updated {fmtDate(data.latestBalance?.date ?? null)}</div>
        </div>
        <button className="refresh-btn" onClick={() => {
          setLoading(true);
          fetchOverviewData().then(setData).catch((e: unknown) => setError(e instanceof Error ? e.message : "Error")).finally(() => setLoading(false));
        }}>Refresh</button>
      </div>
 
      <div className="stats-row">
        <StatCard label="Revolut Balance" value={derived.totalUSD > 0 ? fmtMoney(derived.totalUSD) : "—"} sub="GBP + USD combined" variant="blue" />
        <StatCard label={`${quarterLabel} Revenue`} value={fmtMoney(data.q1RevenueTotal)} sub={`${totalDealCount} payments received`} variant="green" />
        <StatCard label="Monthly Burn" value={fmtMoney(derived.monthlyBurn)} sub="recurring costs" variant="red" />
        <StatCard label="Runway" value={derived.runway != null ? `${derived.runway} mo` : "—"} sub="at current burn" variant={derived.runway == null ? "default" : derived.runway <= 3 ? "red" : derived.runway <= 6 ? "amber" : "green"} />
        <StatCard label="Invoiced & Unpaid" value={fmtMoney(derived.unpaidTotal)} sub={`${data.unpaidInvoices.length} invoices`} variant={derived.overdueInvoices.length > 0 ? "red" : "amber"} />
      </div>
 
      {derived.alerts.length > 0 && (
        <div className="alerts-section">
          <div className="section-header"><span className="section-title">{derived.alerts.length} Alert{derived.alerts.length !== 1 ? "s" : ""}</span></div>
          <div className="alerts-list">
            {derived.alerts.map((a, i) => (
              <div key={i} className={`alert-item alert-${a.severity}`}>
                <span className="alert-dot" />{a.label}
              </div>
            ))}
          </div>
        </div>
      )}
 
      <div className="section-header"><span className="section-title">Newsletters</span></div>
      <div className="newsletter-grid">
        {(data.newsletters ?? []).map((nl, idx) => {
          const snap = derived.latestSubsByNewsletter[nl.id];
          const qRev = data.q1RevenueByNewsletter[nl.id] ?? 0;
          const qCount = data.q1DealCountByNewsletter[nl.id] ?? 0;
          const openRate = derived.openRateByNewsletter[nl.id];
          const sparkData = (data.snapshotHistory ?? []).filter((s) => s.newsletter_id === nl.id).map((s) => ({ date: s.date, total_subscribers: s.total_subscribers }));
          const color = newsletterColors[idx % newsletterColors.length];
          return (
            <div key={nl.id} className="newsletter-card">
              <div className="nl-card-header">
                <div className="nl-dot" style={{ background: color }} />
                <span className="nl-name">{nl.name}</span>
                <span className="nl-status badge badge-green">{nl.status}</span>
              </div>
              <div className="nl-stats">
                <div className="nl-stat">
                  <div className="nl-stat-label">Subscribers</div>
                  <div className="nl-stat-value" style={{ color }}>{fmtSubs(snap?.total_subscribers)}</div>
                  {snap?.new_subscribers_7d != null && <div className="nl-stat-sub">+{snap.new_subscribers_7d} this week</div>}
                </div>
                <div className="nl-stat">
                  <div className="nl-stat-label">{quarterLabel} Revenue</div>
                  <div className="nl-stat-value" style={{ color: "#1D9E75" }}>{fmtMoney(qRev)}</div>
                  <div className="nl-stat-sub">{qCount} payments</div>
                </div>
                <div className="nl-stat">
                  <div className="nl-stat-label">Rolling Open Rate</div>
                  <div className="nl-stat-value" style={{ color: openRate == null ? "#8A8880" : openRate >= 0.4 ? "#1D9E75" : openRate >= 0.3 ? "#EF9F27" : "#D85A30" }}>{fmtPct(openRate)}</div>
                  <div className="nl-stat-sub">last 10 sends</div>
                </div>
              </div>
              <div className="nl-sparkline">
                <div className="nl-sparkline-label">90-day subscriber growth</div>
                <Sparkline data={sparkData} color={color} />
              </div>
            </div>
          );
        })}
      </div>
 
      <div className="bottom-grid">
        <div className="panel">
          <div className="section-header"><span className="section-title">Recent Transactions</span><span className="section-sub">Revolut</span></div>
          {(data.recentTransactions ?? []).length === 0 ? <div className="empty-state">No recent transactions</div> : (
            <table className="data-table">
              <thead><tr><th>Date</th><th>Description</th><th className="text-right">Amount</th></tr></thead>
              <tbody>
                {(data.recentTransactions ?? []).map((t) => (
                  <tr key={t.id}>
                    <td className="mono">{fmtDate(t.date)}</td>
                    <td>{t.counterparty_name || t.description || "—"}</td>
                    <td className="text-right mono text-red">{fmtGBP(Math.abs(t.amount))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
 
        <div className="panel">
          <div className="section-header"><span className="section-title">Upcoming</span><span className="section-sub">Next 30 days</span></div>
          {(data.upcomingOps ?? []).length === 0 ? <div className="empty-state">Nothing scheduled</div> : (
            <div className="ops-list">
              {(data.upcomingOps ?? []).map((op) => {
                const daysLeft = op.due_date ? daysUntil(op.due_date) : null;
                const nl = (data.newsletters ?? []).find((n) => n.id === op.newsletter_id);
                return (
                  <div key={op.id} className="ops-item">
                    <div className="ops-left">
                      <div className="ops-title">{op.title}</div>
                      {nl && <div className="ops-nl">{nl.name}</div>}
                    </div>
                    <div className="ops-right">
                      {op.due_date && <div className="ops-date" style={{ color: daysLeft != null && daysLeft <= 2 ? "#D85A30" : daysLeft != null && daysLeft <= 7 ? "#EF9F27" : "#8A8880" }}>{fmtDate(op.due_date)}</div>}
                      {op.priority && <span className={`badge ${op.priority === "high" ? "badge-red" : op.priority === "medium" ? "badge-amber" : "badge-muted"}`}>{op.priority}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
 
        <div className="panel">
          <div className="section-header"><span className="section-title">Invoiced & Unpaid</span><span className="section-sub">{fmtMoney(derived.unpaidTotal)}</span></div>
          {(data.unpaidInvoices ?? []).length === 0 ? <div className="empty-state">All invoices paid</div> : (
            <table className="data-table">
              <thead><tr><th>Invoice</th><th>Sponsor</th><th>Due</th><th className="text-right">Amount</th></tr></thead>
              <tbody>
                {(data.unpaidInvoices ?? []).map((inv) => {
                  const sponsorName = inv.sponsor_id
                    ? derived.sponsorMap.get(inv.sponsor_id)
                    : (inv.extracted_data?.client_name as string ?? null);
                  const daysLeft = inv.due_date ? daysUntil(inv.due_date) : null;
                  const isOverdue = daysLeft != null && daysLeft < 0;
                  const isDueSoon = daysLeft != null && daysLeft >= 0 && daysLeft <= 7;
                  const dueDateColor = isOverdue ? "#D85A30" : isDueSoon ? "#EF9F27" : "#1D9E75";
                  return (
                    <tr key={inv.id} style={isOverdue ? { background: "rgba(216,90,48,0.04)" } : {}}>
                      <td className="mono">{inv.invoice_number}</td>
                      <td>{sponsorName ?? "—"}</td>
                      <td className="mono" style={{ color: dueDateColor }}>{fmtDate(inv.due_date)}</td>
                      <td className="text-right mono text-amber">{fmtMoney(inv.amount)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
 
      <AccountantReportPanel />
    </div>
  );
}
 
const styles = `
@import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap');
:root {
  --bg: #0C0C0A; --bg2: #141412; --bg3: #1C1C19; --bg4: #242420;
  --border: rgba(255,255,255,0.07); --border2: rgba(255,255,255,0.12);
  --text: #F0EDE6; --text2: #8A8880; --text3: #5A5855;
  --green: #1D9E75; --red: #D85A30; --amber: #EF9F27; --blue: #378ADD;
  --font-sans: 'Syne', sans-serif; --font-mono: 'DM Mono', monospace;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
.overview { font-family: var(--font-sans); background: var(--bg); color: var(--text); min-height: 100vh; padding: 32px 40px 80px; max-width: 1400px; margin: 0 auto; }
.overview-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 32px; }
.overview-title { font-size: 28px; font-weight: 700; letter-spacing: -0.5px; }
.overview-subtitle { font-size: 13px; color: var(--text3); font-family: var(--font-mono); margin-top: 4px; }
.refresh-btn { background: var(--bg3); border: 1px solid var(--border); color: var(--text2); font-family: var(--font-mono); font-size: 12px; padding: 6px 14px; border-radius: 6px; cursor: pointer; }
.stats-row { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; margin-bottom: 24px; }
.stat-card { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; padding: 18px 20px; }
.stat-label { font-size: 11px; color: var(--text3); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 8px; font-family: var(--font-mono); }
.stat-value { font-size: 24px; font-weight: 700; letter-spacing: -0.5px; line-height: 1; }
.stat-sub { font-size: 11px; color: var(--text3); font-family: var(--font-mono); margin-top: 6px; }
.alerts-section { margin-bottom: 24px; background: rgba(216,90,48,0.05); border: 1px solid rgba(216,90,48,0.2); border-radius: 10px; padding: 16px 20px; }
.alerts-list { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
.alert-item { display: flex; align-items: center; gap: 10px; font-size: 13px; font-family: var(--font-mono); }
.alert-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.alert-warning .alert-dot { background: var(--amber); }
.alert-critical .alert-dot { background: var(--red); }
.alert-warning { color: #c49b5b; }
.alert-critical { color: #c06040; }
.section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.section-title { font-size: 13px; font-weight: 600; color: var(--text2); text-transform: uppercase; letter-spacing: 0.08em; }
.section-sub { font-size: 12px; color: var(--text3); font-family: var(--font-mono); }
.newsletter-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 16px; margin-bottom: 24px; }
.newsletter-card { background: var(--bg2); border: 1px solid var(--border); border-radius: 12px; padding: 22px 24px; }
.nl-card-header { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; }
.nl-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.nl-name { font-size: 16px; font-weight: 600; flex: 1; }
.nl-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 20px; }
.nl-stat-label { font-size: 11px; color: var(--text3); font-family: var(--font-mono); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px; }
.nl-stat-value { font-size: 20px; font-weight: 700; letter-spacing: -0.4px; }
.nl-stat-sub { font-size: 11px; color: var(--text3); font-family: var(--font-mono); margin-top: 4px; }
.nl-sparkline-label { font-size: 11px; color: var(--text3); font-family: var(--font-mono); margin-bottom: 6px; }
.sparkline-empty { height: 48px; display: flex; align-items: center; font-size: 11px; color: var(--text3); font-family: var(--font-mono); }
.bottom-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; }
.panel { background: var(--bg2); border: 1px solid var(--border); border-radius: 12px; padding: 20px 22px; }
.data-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.data-table th { font-family: var(--font-mono); font-size: 10px; color: var(--text3); text-transform: uppercase; letter-spacing: 0.06em; padding: 0 0 10px; text-align: left; border-bottom: 1px solid var(--border); }
.data-table td { padding: 9px 0; border-bottom: 1px solid var(--border); color: var(--text2); vertical-align: middle; }
.data-table tr:last-child td { border-bottom: none; }
.data-table .row-alert td { background: rgba(216,90,48,0.04); }
.text-right { text-align: right; padding-right: 12px; }
.ops-list { display: flex; flex-direction: column; gap: 2px; }
.ops-item { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--border); }
.ops-item:last-child { border-bottom: none; }
.ops-title { font-size: 13px; color: var(--text); margin-bottom: 3px; }
.ops-nl { font-size: 11px; color: var(--text3); font-family: var(--font-mono); }
.ops-right { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex-shrink: 0; margin-left: 16px; }
.ops-date { font-size: 12px; font-family: var(--font-mono); }
.badge { font-family: var(--font-mono); font-size: 10px; padding: 2px 7px; border-radius: 4px; text-transform: uppercase; letter-spacing: 0.05em; display: inline-block; }
.badge-green { background: rgba(29,158,117,0.15); color: var(--green); }
.badge-red { background: rgba(216,90,48,0.15); color: var(--red); }
.badge-amber { background: rgba(239,159,39,0.15); color: var(--amber); }
.badge-muted { background: var(--bg4); color: var(--text3); }
.text-green { color: var(--green); }
.text-red { color: var(--red); }
.text-amber { color: var(--amber); }
.text-blue { color: var(--blue); }
.mono { font-family: var(--font-mono); }
.empty-state { font-size: 13px; color: var(--text3); font-family: var(--font-mono); padding: 16px 0; }
.overview-loading { display: flex; gap: 8px; justify-content: center; align-items: center; height: 100vh; background: var(--bg); }
.loading-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text3); animation: pulse 1s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 0.2; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1); } }
.overview-error { display: flex; gap: 12px; justify-content: center; align-items: center; height: 100vh; background: var(--bg); color: var(--red); font-family: var(--font-mono); font-size: 14px; }
.error-icon { font-size: 20px; }
.report-bar { margin-top: 24px; background: var(--bg2); border: 1px solid var(--border); border-radius: 12px; padding: 14px 22px; display: flex; flex-direction: column; align-items: flex-start; gap: 10px; }
.report-bar-title { font-size: 11px; font-weight: 600; color: var(--text3); font-family: var(--font-mono); text-transform: uppercase; letter-spacing: 0.08em; }
.report-bar-fields { display: flex; align-items: flex-end; gap: 10px; flex-wrap: wrap; }
.report-bar-field { display: flex; flex-direction: column; gap: 4px; }
.report-bar-label { font-size: 9px; color: var(--text3); font-family: var(--font-mono); text-transform: uppercase; letter-spacing: 0.06em; }
.report-bar-input { background: var(--bg3); border: 1px solid var(--border); border-radius: 6px; color: var(--text); font-family: var(--font-mono); font-size: 12px; padding: 6px 10px; width: 130px; outline: none; }
.report-bar-btn { background: var(--green); border: none; border-radius: 6px; color: #fff; font-family: var(--font-sans); font-size: 12px; font-weight: 600; padding: 7px 14px; cursor: pointer; white-space: nowrap; }
.report-bar-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.report-bar-ghost { background: var(--bg3); border: 1px solid var(--border); border-radius: 6px; color: var(--text2); font-family: var(--font-sans); font-size: 12px; padding: 6px 12px; cursor: pointer; }
.report-bar-warning { font-size: 12px; color: #c49b5b; font-family: var(--font-mono); background: rgba(239,159,39,0.07); border: 1px solid rgba(239,159,39,0.2); border-radius: 6px; padding: 10px 14px; }
.report-bar-warning-actions { display: flex; gap: 8px; margin-top: 10px; }
.report-bar-success { font-size: 12px; color: var(--green); font-family: var(--font-mono); background: rgba(29,158,117,0.07); border: 1px solid rgba(29,158,117,0.2); border-radius: 6px; padding: 8px 14px; }
.report-bar-error { font-size: 12px; color: var(--red); font-family: var(--font-mono); background: rgba(216,90,48,0.07); border: 1px solid rgba(216,90,48,0.2); border-radius: 6px; padding: 8px 14px; }
`;
 
if (typeof document !== "undefined") {
  const existing = document.getElementById("tracerrr-overview-styles");
  if (!existing) {
    const tag = document.createElement("style");
    tag.id = "tracerrr-overview-styles";
    tag.textContent = styles;
    document.head.appendChild(tag);
  }
}
 
