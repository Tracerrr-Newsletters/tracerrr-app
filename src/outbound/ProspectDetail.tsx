// ============================================================================
// outbound/ProspectDetail.tsx — full dossier, editable draft, timeline, actions
// This is the "open in app" target from Slack for proper draft editing.
// ============================================================================
import React, { useEffect, useState } from "react";
import {
  getProspect, getEvents, updateProspect, approveSend, redraft, requestEnrich,
  type Prospect, type ProspectEvent,
} from "./api";
import { tokens, STATUS_META, Pill, ScoreBar, relTime } from "./ui";

export default function ProspectDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [p, setP] = useState<Prospect | null>(null);
  const [events, setEvents] = useState<ProspectEvent[]>([]);
  const [subject, setSubject] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    const [pr, ev] = await Promise.all([getProspect(id), getEvents(id)]);
    setP(pr); setEvents(ev);
    setSubject(pr.draft_subject ?? ""); setBodyText(pr.draft_body ?? "");
    setDirty(false);
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);

  if (!p) return <div style={{ color: tokens.textDim }}>Loading…</div>;

  async function saveDraft() {
    setBusy("save");
    try { await updateProspect(id, { draft_subject: subject, draft_body: bodyText }); setDirty(false); await load(); }
    finally { setBusy(null); }
  }
  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    try { if (dirty) await updateProspect(id, { draft_subject: subject, draft_body: bodyText }); await fn(); await load(); }
    finally { setBusy(null); }
  }

  const sig = (p.qualification_signals ?? {}) as Record<string, unknown>;
  const canSend = ["ready", "approved", "enriched"].includes(p.status) && !!p.contact_email;

  return (
    <>
      <button className="ob-btn ob-btn-ghost" onClick={onBack} style={{ marginBottom: 18 }}>← Back</button>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1 className="ob-h1">{p.company ?? p.domain}</h1>
          <a href={`https://${p.domain}`} target="_blank" rel="noreferrer"
            style={{ color: tokens.limeDim, fontSize: 15 }}>{p.domain} ↗</a>
        </div>
        <Pill color={STATUS_META[p.status].color}>{STATUS_META[p.status].label}</Pill>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 22, marginTop: 22 }}>
        {/* LEFT: dossier + draft */}
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          {/* Dossier */}
          <div className="ob-panel" style={{ padding: 20 }}>
            <SectionLabel>Dossier</SectionLabel>
            <KV k="Fit" v={`${p.fit_newsletter_name ?? "—"}`} extra={<ScoreBar score={p.fit_score} />} />
            <KV k="Why" v={p.fit_reason ?? "—"} />
            <KV k="Category" v={String(sig.category ?? "—")} />
            <KV k="Marketing active" v={String(sig.marketing_active ?? "—")} />
            <KV k="Competitor-locked" v={String(sig.competitor_locked ?? "—")} />
            <KV k="Size" v={String(sig.company_size_guess ?? "—")} />
          </div>

          {/* Contact */}
          <div className="ob-panel" style={{ padding: 20 }}>
            <SectionLabel>Contact</SectionLabel>
            {p.contact_email ? (
              <>
                <KV k="Name" v={p.contact_name ?? "—"} />
                <KV k="Role" v={p.contact_role ?? "—"} />
                <KV k="Email" v={p.contact_email} />
                {p.contact_linkedin && <KV k="LinkedIn" v={p.contact_linkedin} />}
              </>
            ) : (
              <div style={{ color: tokens.textDim }}>
                Not enriched yet.{" "}
                {["qualified","needs_review"].includes(p.status) &&
                  <button className="ob-btn ob-btn-ghost" disabled={busy === "enrich"}
                    onClick={() => act("enrich", () => requestEnrich(id))}>
                    {busy === "enrich" ? "Sending to Clay…" : "Enrich via Clay"}</button>}
              </div>
            )}
          </div>

          {/* Angle + draft */}
          <div className="ob-panel" style={{ padding: 20 }}>
            <SectionLabel>Angle</SectionLabel>
            <div style={{ fontSize: 15, marginBottom: 8 }}>{p.top_angle ?? "—"}</div>
            {!!p.alt_angles?.length &&
              <details style={{ color: tokens.textDim, fontSize: 14 }}>
                <summary style={{ cursor: "pointer" }}>Alternative angles</summary>
                <ul>{p.alt_angles.map((a, i) => <li key={i} style={{ marginTop: 4 }}>{a}</li>)}</ul>
              </details>}

            <SectionLabel style={{ marginTop: 18 }}>Draft email</SectionLabel>
            <input className="ob-input" style={{ width: "100%", marginBottom: 10 }}
              placeholder="Subject" value={subject}
              onChange={e => { setSubject(e.target.value); setDirty(true); }} />
            <textarea className="ob-input" style={{ width: "100%", minHeight: 220, resize: "vertical" }}
              placeholder="Body" value={bodyText}
              onChange={e => { setBodyText(e.target.value); setDirty(true); }} />

            <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
              <button className="ob-btn ob-btn-primary" disabled={!canSend || busy !== null}
                onClick={() => act("send", () => approveSend(id))}>
                {busy === "send" ? "Sending…" : "Approve & send"}</button>
              {dirty &&
                <button className="ob-btn ob-btn-ghost" disabled={busy !== null} onClick={saveDraft}>
                  {busy === "save" ? "Saving…" : "Save draft"}</button>}
              <button className="ob-btn ob-btn-ghost" disabled={busy !== null}
                onClick={() => act("redraft", () => redraft(id))}>
                {busy === "redraft" ? "Redrafting…" : "Regenerate draft"}</button>
              <button className="ob-btn ob-btn-danger" disabled={busy !== null}
                onClick={() => act("skip", () => updateProspect(id, { status: "skipped" }))}>Skip</button>
            </div>
            {!p.contact_email && <div style={{ color: tokens.amber, fontSize: 13, marginTop: 10 }}>
              Needs a contact email before sending.</div>}
          </div>

          {/* Notes */}
          <div className="ob-panel" style={{ padding: 20 }}>
            <SectionLabel>Your notes</SectionLabel>
            <textarea className="ob-input" style={{ width: "100%", minHeight: 80, resize: "vertical" }}
              defaultValue={p.user_notes ?? ""}
              onBlur={e => updateProspect(id, { user_notes: e.target.value })} />
          </div>
        </div>

        {/* RIGHT: timeline */}
        <div className="ob-panel" style={{ padding: 20, alignSelf: "start" }}>
          <SectionLabel>Timeline</SectionLabel>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {events.map(ev => (
              <div key={ev.id} style={{ borderLeft: `2px solid ${tokens.border}`, paddingLeft: 14 }}>
                <div style={{ fontSize: 14 }}>{ev.summary ?? ev.event_type}</div>
                <div style={{ color: tokens.textDim, fontSize: 12 }}>
                  {ev.actor} · {relTime(ev.created_at)}</div>
              </div>
            ))}
            {events.length === 0 && <div style={{ color: tokens.textDim }}>No events yet.</div>}
          </div>
        </div>
      </div>
    </>
  );
}

function SectionLabel({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div style={{ color: tokens.lime, fontSize: 12, textTransform: "uppercase",
    letterSpacing: .8, marginBottom: 12, ...style }}>{children}</div>;
}
function KV({ k, v, extra }: { k: string; v: string; extra?: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 12, marginBottom: 8, fontSize: 15 }}>
      <div style={{ width: 130, color: tokens.textDim, flexShrink: 0 }}>{k}</div>
      <div style={{ flex: 1 }}>{v}{extra && <div style={{ marginTop: 4 }}>{extra}</div>}</div>
    </div>
  );
}
