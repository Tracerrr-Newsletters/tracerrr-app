// ============================================================================
// outbound/Pipeline.tsx — the mini-CRM. Deals in active conversation -> closed.
// ============================================================================
import React, { useEffect, useMemo, useState } from "react";
import { listProspects, updateProspect, type Prospect, type DealStage } from "./api";
import { tokens } from "./ui";

const STAGES: { key: DealStage; label: string; defaultProb: number }[] = [
  { key: "discovery",     label: "Discovery",     defaultProb: 20 },
  { key: "proposal_sent", label: "Proposal sent", defaultProb: 40 },
  { key: "negotiating",   label: "Negotiating",   defaultProb: 60 },
  { key: "verbal_yes",    label: "Verbal yes",    defaultProb: 80 },
  { key: "contract_sent", label: "Contract sent", defaultProb: 90 },
  { key: "signed",        label: "Signed",        defaultProb: 100 },
];

const gbp = (n: number | null) =>
  n == null ? "—" : new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 }).format(n);

export default function Pipeline({ onOpen }: { onOpen: (id: string) => void }) {
  const [rows, setRows] = useState<Prospect[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try { setRows(await listProspects(["in_convo", "won"])); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  async function patch(id: string, p: Partial<Prospect>) {
    await updateProspect(id, p);
    setRows(rs => rs.map(r => r.id === id ? { ...r, ...p } as Prospect : r));
  }

  const weighted = useMemo(() =>
    rows.reduce((sum, r) => sum + ((r.deal_value_gbp ?? 0) * (r.deal_probability_pct ?? 0) / 100), 0),
  [rows]);
  const total = useMemo(() =>
    rows.reduce((sum, r) => sum + (r.deal_value_gbp ?? 0), 0), [rows]);

  return (
    <>
      <h1 className="ob-h1">Pipeline</h1>
      <p className="ob-sub">Live deals. Set stage, value, and next step — weighted total updates live.</p>

      <div style={{ display: "flex", gap: 16, marginBottom: 22 }}>
        <div className="ob-panel" style={{ padding: "16px 22px" }}>
          <div style={{ color: tokens.textDim, fontSize: 13, textTransform: "uppercase", letterSpacing: .6 }}>Weighted pipeline</div>
          <div style={{ fontFamily: tokens.fontDisplay, fontSize: 36, color: tokens.lime }}>{gbp(weighted)}</div>
        </div>
        <div className="ob-panel" style={{ padding: "16px 22px" }}>
          <div style={{ color: tokens.textDim, fontSize: 13, textTransform: "uppercase", letterSpacing: .6 }}>Total (unweighted)</div>
          <div style={{ fontFamily: tokens.fontDisplay, fontSize: 36 }}>{gbp(total)}</div>
        </div>
        <div className="ob-panel" style={{ padding: "16px 22px" }}>
          <div style={{ color: tokens.textDim, fontSize: 13, textTransform: "uppercase", letterSpacing: .6 }}>Open deals</div>
          <div style={{ fontFamily: tokens.fontDisplay, fontSize: 36 }}>{rows.filter(r => r.status !== "won").length}</div>
        </div>
      </div>

      <div className="ob-panel" style={{ overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>
            <th className="ob-th">Company</th><th className="ob-th">Newsletter</th>
            <th className="ob-th">Stage</th><th className="ob-th">Value</th>
            <th className="ob-th">Prob.</th><th className="ob-th">Weighted</th>
            <th className="ob-th">Next step</th><th className="ob-th">Due</th>
          </tr></thead>
          <tbody>
            {!loading && rows.length === 0 &&
              <tr><td className="ob-td" colSpan={8} style={{ color: tokens.textDim }}>
                No live deals yet. They appear here once a conversation is active.</td></tr>}
            {rows.map(r => {
              const w = (r.deal_value_gbp ?? 0) * (r.deal_probability_pct ?? 0) / 100;
              return (
                <tr key={r.id}>
                  <td className="ob-td" style={{ cursor: "pointer" }} onClick={() => onOpen(r.id)}>
                    <div style={{ fontWeight: 600 }}>{r.company ?? r.domain}</div>
                    <div style={{ color: tokens.textDim, fontSize: 13 }}>{r.contact_name}</div>
                  </td>
                  <td className="ob-td" style={{ fontSize: 14 }}>{r.fit_newsletter_name ?? "—"}</td>
                  <td className="ob-td">
                    <select className="ob-input" style={{ padding: "6px 10px", fontSize: 14 }}
                      value={r.deal_stage ?? "discovery"}
                      onChange={e => {
                        const stage = e.target.value as DealStage;
                        const def = STAGES.find(s => s.key === stage)?.defaultProb ?? r.deal_probability_pct;
                        patch(r.id, { deal_stage: stage, deal_probability_pct: r.deal_probability_pct ?? def });
                      }}>
                      {STAGES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                    </select>
                  </td>
                  <td className="ob-td">
                    <input className="ob-input" style={{ width: 92, padding: "6px 10px", fontSize: 14 }}
                      type="number" placeholder="£" defaultValue={r.deal_value_gbp ?? ""}
                      onBlur={e => patch(r.id, { deal_value_gbp: e.target.value ? Number(e.target.value) : null })} />
                  </td>
                  <td className="ob-td">
                    <input className="ob-input" style={{ width: 60, padding: "6px 10px", fontSize: 14 }}
                      type="number" min={0} max={100} defaultValue={r.deal_probability_pct ?? ""}
                      onBlur={e => patch(r.id, { deal_probability_pct: e.target.value ? Number(e.target.value) : null })} />
                  </td>
                  <td className="ob-td" style={{ color: tokens.lime, fontWeight: 600 }}>{gbp(w)}</td>
                  <td className="ob-td">
                    <input className="ob-input" style={{ width: 180, padding: "6px 10px", fontSize: 14 }}
                      placeholder="Next step" defaultValue={r.next_step ?? ""}
                      onBlur={e => patch(r.id, { next_step: e.target.value || null })} />
                  </td>
                  <td className="ob-td">
                    <input className="ob-input" style={{ padding: "6px 10px", fontSize: 14 }}
                      type="date" defaultValue={r.next_step_due ?? ""}
                      onBlur={e => patch(r.id, { next_step_due: e.target.value || null })} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
