// ============================================================================
// outbound/Inbox.tsx — the reply queue. Triage replies, approve/edit responses.
// ============================================================================
import React, { useEffect, useState } from "react";
import { listProspects, sendReply, updateProspect, type Prospect } from "./api";
import { tokens, REPLY_META, Pill, relTime } from "./ui";

export default function Inbox({ onOpen }: { onOpen: (id: string) => void }) {
  const [rows, setRows] = useState<Prospect[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try { setRows(await listProspects(["replied"])); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); const i = setInterval(load, 10000); return () => clearInterval(i); }, []);

  async function send(p: Prospect) {
    setBusy(p.id);
    try {
      if (editing === p.id) { await updateProspect(p.id, { draft_response: draft }); }
      await sendReply(p.id);
      setEditing(null);
      await load();
    } finally { setBusy(null); }
  }

  return (
    <>
      <h1 className="ob-h1">Inbox</h1>
      <p className="ob-sub">Replies waiting on you. Each has a suggested response — send, edit, or take over.</p>

      {loading && rows.length === 0 && <div style={{ color: tokens.textDim }}>Loading…</div>}
      {!loading && rows.length === 0 &&
        <div className="ob-panel" style={{ padding: 28, color: tokens.textDim }}>
          No replies waiting. 🎉</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {rows.map(p => (
          <div key={p.id} className="ob-panel" style={{ padding: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div onClick={() => onOpen(p.id)} style={{ cursor: "pointer" }}>
                <span style={{ fontSize: 19, fontWeight: 600 }}>{p.company ?? p.domain}</span>
                <span style={{ color: tokens.textDim, marginLeft: 10, fontSize: 14 }}>
                  {p.contact_name} · {p.contact_role}</span>
              </div>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                {p.reply_classification &&
                  <Pill color={REPLY_META[p.reply_classification].color}>
                    {REPLY_META[p.reply_classification].label}</Pill>}
                <span style={{ color: tokens.textDim, fontSize: 13 }}>{relTime(p.reply_received_at)}</span>
              </div>
            </div>

            <div style={{ background: tokens.bg, border: `1px solid ${tokens.border}`,
              borderRadius: 10, padding: 14, marginBottom: 14 }}>
              <div style={{ color: tokens.textDim, fontSize: 12, textTransform: "uppercase",
                letterSpacing: .6, marginBottom: 6 }}>They said</div>
              <div style={{ fontSize: 15, whiteSpace: "pre-wrap", color: tokens.text }}>
                {p.reply_body}</div>
            </div>

            <div style={{ color: tokens.lime, fontSize: 12, textTransform: "uppercase",
              letterSpacing: .6, marginBottom: 6 }}>Suggested reply</div>
            {editing === p.id ? (
              <textarea className="ob-input" style={{ width: "100%", minHeight: 140, resize: "vertical" }}
                value={draft} onChange={e => setDraft(e.target.value)} />
            ) : (
              <div style={{ fontSize: 15, whiteSpace: "pre-wrap", marginBottom: 12 }}>
                {p.draft_response}</div>
            )}

            <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
              <button className="ob-btn ob-btn-primary" disabled={busy === p.id}
                onClick={() => send(p)}>
                {busy === p.id ? "Sending…" : editing === p.id ? "Save & send" : "Send reply"}</button>
              {editing === p.id ? (
                <button className="ob-btn ob-btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
              ) : (
                <button className="ob-btn ob-btn-ghost"
                  onClick={() => { setEditing(p.id); setDraft(p.draft_response ?? ""); }}>Edit</button>
              )}
              <button className="ob-btn ob-btn-ghost" onClick={() => onOpen(p.id)}>Open</button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
