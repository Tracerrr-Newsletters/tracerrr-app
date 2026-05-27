// ============================================================================
// outbound/ProspectList.tsx — the main working surface
// ============================================================================
import { useEffect, useState } from "react";
import {
  listProspects, addProspect, type Prospect, type ProspectStatus,
} from "./api";
import {
  tokens, STATUS_META, PRIORITY_META, Pill, ScoreBar, relTime,
} from "./ui";

type FilterTab = "active" | "ready" | "review" | "rejected" | "all";

const TAB_STATUSES: Record<FilterTab, ProspectStatus[] | undefined> = {
  active:   ["new","qualifying","qualified","enriching","enriched","drafting","ready"],
  ready:    ["ready"],
  review:   ["needs_review"],
  rejected: ["rejected"],
  all:      undefined,
};

export default function ProspectList({ onOpen }: { onOpen: (id: string) => void }) {
  const [tab, setTab] = useState<FilterTab>("active");
  const [rows, setRows] = useState<Prospect[]>([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState("");
  const [adding, setAdding] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try { setRows(await listProspects(TAB_STATUSES[tab])); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [tab]);

  // light polling so statuses advance live as the pipeline churns
  useEffect(() => {
    const i = setInterval(load, 8000);
    return () => clearInterval(i);
    /* eslint-disable-next-line */
  }, [tab]);

  async function handleAdd() {
    const domains = input.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    if (!domains.length) return;
    setAdding(true);
    try {
      for (const d of domains) await addProspect(d);
      setToast(`Added ${domains.length} — qualifying now…`);
      setInput("");
      setTimeout(load, 1200);
    } catch (e) {
      setToast(`Error: ${(e as Error).message}`);
    } finally {
      setAdding(false);
      setTimeout(() => setToast(null), 4000);
    }
  }


  return (
    <>
      <h1 className="ob-h1">Outbound</h1>
      <p className="ob-sub">Paste a domain — the system qualifies, enriches, and drafts. You approve.</p>

      {/* Add bar */}
      <div style={{ display: "flex", gap: 10, marginBottom: 24, maxWidth: 720 }}>
        <input
          className="ob-input" style={{ flex: 1 }}
          placeholder="takomo.golf  ·  paste one or several domains"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") handleAdd(); }}
        />
        <button className="ob-btn ob-btn-primary" onClick={handleAdd} disabled={adding}>
          {adding ? "Adding…" : "Add prospect"}
        </button>
      </div>
      {toast && <div style={{ color: tokens.lime, marginBottom: 16, fontSize: 15 }}>{toast}</div>}

      {/* Tabs */}
      <div style={{ marginBottom: 16, borderBottom: `1px solid ${tokens.border}` }}>
        {(["active","ready","review","rejected","all"] as FilterTab[]).map(t => (
          <button key={t}
            className={`ob-tab ${tab === t ? "ob-tab-active" : ""}`}
            onClick={() => setTab(t)}>
            {t === "active" ? "Active" : t === "ready" ? "Ready to send"
              : t === "review" ? "Needs review" : t === "rejected" ? "Rejected" : "All"}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="ob-panel" style={{ overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th className="ob-th">Company</th>
              <th className="ob-th">Status</th>
              <th className="ob-th">Priority</th>
              <th className="ob-th">Fit</th>
              <th className="ob-th">Contact</th>
              <th className="ob-th">Angle</th>
              <th className="ob-th">Last action</th>
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 && (
              <tr><td className="ob-td" colSpan={7} style={{ color: tokens.textDim }}>Loading…</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td className="ob-td" colSpan={7} style={{ color: tokens.textDim }}>
                Nothing here yet. Paste a domain above to begin.</td></tr>
            )}
            {rows.map(r => (
              <tr key={r.id} className="ob-row" onClick={() => onOpen(r.id)}>
                <td className="ob-td">
                  <div style={{ fontWeight: 600, fontSize: 16 }}>{r.company ?? r.domain}</div>
                  <div style={{ color: tokens.textDim, fontSize: 13 }}>{r.domain}</div>
                </td>
                <td className="ob-td">
                  <Pill color={STATUS_META[r.status].color}>{STATUS_META[r.status].label}</Pill>
                </td>
                <td className="ob-td">
                  {r.priority && <span style={{ color: PRIORITY_META[r.priority].color }}>
                    {PRIORITY_META[r.priority].label}</span>}
                </td>
                <td className="ob-td">
                  <div style={{ fontSize: 13, color: tokens.textDim, marginBottom: 4 }}>
                    {r.fit_newsletter_name ?? "—"}</div>
                  <ScoreBar score={r.fit_score} />
                </td>
                <td className="ob-td">
                  {r.contact_name
                    ? <><div>{r.contact_name}</div>
                        <div style={{ color: tokens.textDim, fontSize: 13 }}>{r.contact_role}</div></>
                    : <span style={{ color: tokens.textDim }}>—</span>}
                </td>
                <td className="ob-td" style={{ maxWidth: 280 }}>
                  <span style={{ color: r.top_angle ? tokens.text : tokens.textDim, fontSize: 14 }}>
                    {r.top_angle ? (r.top_angle.length > 110 ? r.top_angle.slice(0,110)+"…" : r.top_angle) : "—"}
                  </span>
                </td>
                <td className="ob-td" style={{ color: tokens.textDim, fontSize: 13, whiteSpace: "nowrap" }}>
                  {relTime(r.last_action_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
