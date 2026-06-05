// ============================================================================
// outbound/Sent.tsx — every email the system has sent, plus what came back.
// Different lens to Inbox/Pipeline: focused on the outbound side of the loop.
// ============================================================================
import { useEffect, useMemo, useState } from "react";
import { listProspects, type Prospect } from "./api";
import { tokens, STATUS_META, REPLY_META, Pill, relTime } from "./ui";

// Anything that's been emailed at least once
const SENT_STATUSES = ["sent", "replied", "in_convo", "won", "lost"] as const;

export default function Sent({ onOpen }: { onOpen: (id: string) => void }) {
  const [rows, setRows] = useState<Prospect[]>([]);
  const [loading, setLoading] = useState(true);
  const [newsletter, setNewsletter] = useState<string>("");
  const [search, setSearch] = useState<string>("");
  const [showReplied, setShowReplied] = useState<"all" | "no_reply" | "replied">("all");

  async function load() {
    setLoading(true);
    try {
      const data = await listProspects([...SENT_STATUSES]);
      // listProspects sorts by priority/updated_at; resort by sent_at desc
      data.sort((a, b) => (b.sent_at ?? "").localeCompare(a.sent_at ?? ""));
      setRows(data);
    } finally { setLoading(false); }
  }
  useEffect(() => {
    load();
    const i = setInterval(load, 10000);
    return () => clearInterval(i);
  }, []);

  const newsletters = useMemo(() => {
    const set = new Set<string>();
    rows.forEach(r => { if (r.fit_newsletter_name) set.add(r.fit_newsletter_name); });
    return [...set].sort();
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(r => {
      if (newsletter && r.fit_newsletter_name !== newsletter) return false;
      if (showReplied === "no_reply" && r.reply_received_at) return false;
      if (showReplied === "replied" && !r.reply_received_at) return false;
      if (q) {
        const hay = `${r.company ?? ""} ${r.domain ?? ""} ${r.contact_name ?? ""} ${r.contact_email ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, newsletter, showReplied, search]);

  // Quick stats above the table
  const stats = useMemo(() => {
    const total = rows.length;
    const replied = rows.filter(r => !!r.reply_received_at).length;
    const positive = rows.filter(r => r.reply_classification === "positive").length;
    return { total, replied, positive, replyRate: total ? Math.round((replied / total) * 100) : 0 };
  }, [rows]);

  return (
    <>
      <h1 className="ob-h1">Sent</h1>
      <p className="ob-sub">Every email the system's sent. Click a row to open the dossier.</p>

      {/* Stat strip */}
      <div style={{ display: "flex", gap: 14, marginBottom: 22, flexWrap: "wrap" }}>
        <Stat label="Total sent"   value={stats.total} />
        <Stat label="Replies"      value={stats.replied} sub={`${stats.replyRate}% reply rate`} />
        <Stat label="Positive"     value={stats.positive} color={tokens.green} />
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        <select className="ob-input" value={newsletter} onChange={e => setNewsletter(e.target.value)}>
          <option value="">All newsletters</option>
          {newsletters.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
        <select className="ob-input" value={showReplied} onChange={e => setShowReplied(e.target.value as "all" | "no_reply" | "replied")}>
          <option value="all">All</option>
          <option value="no_reply">No reply yet</option>
          <option value="replied">Replied</option>
        </select>
        <input
          className="ob-input"
          style={{ flex: 1, minWidth: 220 }}
          placeholder="Search company / contact / domain"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {/* Table */}
      <div className="ob-panel" style={{ overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th className="ob-th">Company</th>
              <th className="ob-th">Contact</th>
              <th className="ob-th">Newsletter</th>
              <th className="ob-th">Subject</th>
              <th className="ob-th">Status</th>
              <th className="ob-th">Sent</th>
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 && (
              <tr><td className="ob-td" colSpan={6} style={{ color: tokens.textDim }}>Loading…</td></tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr><td className="ob-td" colSpan={6} style={{ color: tokens.textDim }}>
                {rows.length === 0
                  ? "Nothing sent yet. When approved drafts go out, they'll land here."
                  : "No sends match these filters."}
              </td></tr>
            )}
            {filtered.map(r => (
              <tr key={r.id} className="ob-row" onClick={() => onOpen(r.id)}>
                <td className="ob-td">
                  <div style={{ fontWeight: 600, fontSize: 16 }}>{r.company ?? r.domain}</div>
                  <div style={{ color: tokens.textDim, fontSize: 13 }}>{r.domain}</div>
                </td>
                <td className="ob-td">
                  {r.contact_name
                    ? <>
                        <div>{r.contact_name}</div>
                        <div style={{ color: tokens.textDim, fontSize: 13 }}>{r.contact_email}</div>
                      </>
                    : <span style={{ color: tokens.textDim }}>—</span>}
                </td>
                <td className="ob-td" style={{ color: tokens.textDim, fontSize: 14 }}>
                  {r.fit_newsletter_name ?? "—"}
                </td>
                <td className="ob-td" style={{ maxWidth: 280 }}>
                  <span style={{ color: r.draft_subject ? tokens.text : tokens.textDim, fontSize: 14 }}>
                    {r.draft_subject
                      ? (r.draft_subject.length > 80 ? r.draft_subject.slice(0, 80) + "…" : r.draft_subject)
                      : "—"}
                  </span>
                </td>
                <td className="ob-td">
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
                    <Pill color={STATUS_META[r.status].color}>{STATUS_META[r.status].label}</Pill>
                    {r.reply_classification && (
                      <Pill color={REPLY_META[r.reply_classification].color}>
                        {REPLY_META[r.reply_classification].label}
                      </Pill>
                    )}
                  </div>
                </td>
                <td className="ob-td" style={{ color: tokens.textDim, fontSize: 13, whiteSpace: "nowrap" }}>
                  {relTime(r.sent_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Stat({ label, value, sub, color }: { label: string; value: number | string; sub?: string; color?: string }) {
  return (
    <div className="ob-panel" style={{ padding: "14px 20px", minWidth: 140 }}>
      <div style={{ color: tokens.textDim, fontSize: 12, textTransform: "uppercase", letterSpacing: .6 }}>{label}</div>
      <div style={{ fontFamily: tokens.fontDisplay, fontSize: 32, color: color ?? tokens.text, lineHeight: 1.1 }}>
        {value}
      </div>
      {sub && <div style={{ color: tokens.textDim, fontSize: 12, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}
