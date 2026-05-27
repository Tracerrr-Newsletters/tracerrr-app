// ============================================================================
// outbound/ui.tsx — shared style tokens + tiny presentational helpers
// Matches Tracerrr design language: near-black bg, lime accent, condensed type.
// ============================================================================
import React from "react";
import type { ProspectStatus, Priority, ReplyClass } from "./api";

export const tokens = {
  bg:        "#0a0a0a",
  panel:     "#121212",
  panelHi:   "#181818",
  border:    "#262626",
  text:      "#ededed",
  textDim:   "#8a8a8a",
  lime:      "#D4FF3A",
  limeDim:   "#9bbb2a",
  blue:      "#154273",   // Creator Golf League title blue, kept for accents
  red:       "#ff4d4d",
  amber:     "#ffb020",
  green:     "#3ddc84",
  fontDisplay: "'Bebas Neue', sans-serif",
  fontBody:    "'Barlow Condensed', sans-serif",
};

export const STATUS_META: Record<ProspectStatus, { label: string; color: string }> = {
  new:          { label: "New",          color: tokens.textDim },
  qualifying:   { label: "Qualifying…",  color: tokens.amber },
  qualified:    { label: "Qualified",    color: tokens.lime },
  needs_review: { label: "Review",       color: tokens.amber },
  rejected:     { label: "Rejected",     color: tokens.textDim },
  enriching:    { label: "Enriching…",   color: tokens.amber },
  enriched:     { label: "Enriched",     color: tokens.lime },
  drafting:     { label: "Drafting…",    color: tokens.amber },
  ready:        { label: "Ready",        color: tokens.lime },
  approved:     { label: "Sending…",     color: tokens.amber },
  sent:         { label: "Sent",         color: tokens.blue },
  replied:      { label: "Replied",      color: tokens.green },
  in_convo:     { label: "In convo",     color: tokens.green },
  won:          { label: "Won",          color: tokens.lime },
  lost:         { label: "Lost",         color: tokens.textDim },
  skipped:      { label: "Skipped",      color: tokens.textDim },
};

export const PRIORITY_META: Record<Priority, { label: string; color: string }> = {
  hot:  { label: "🔥 Hot",  color: tokens.red },
  warm: { label: "Warm",    color: tokens.amber },
  cold: { label: "Cold",    color: tokens.textDim },
};

export const REPLY_META: Record<ReplyClass, { label: string; color: string }> = {
  positive:    { label: "Positive",    color: tokens.green },
  objection:   { label: "Objection",   color: tokens.amber },
  referral:    { label: "Referral",    color: tokens.blue },
  not_now:     { label: "Not now",     color: tokens.amber },
  ooo:         { label: "Out of office", color: tokens.textDim },
  soft_no:     { label: "Soft no",     color: tokens.textDim },
  hard_no:     { label: "Hard no",     color: tokens.red },
  unsubscribe: { label: "Unsubscribe", color: tokens.red },
  unclear:     { label: "Unclear",     color: tokens.textDim },
};

export function Pill({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span style={{
      display: "inline-block", padding: "2px 10px", borderRadius: 999,
      fontFamily: tokens.fontBody, fontSize: 13, letterSpacing: 0.3,
      color, border: `1px solid ${color}55`, background: `${color}14`,
      whiteSpace: "nowrap",
    }}>{children}</span>
  );
}

export function ScoreBar({ score }: { score: number | null }) {
  const s = score ?? 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div style={{ width: 54, height: 6, background: tokens.border, borderRadius: 4, overflow: "hidden" }}>
        <div style={{ width: `${s * 10}%`, height: "100%", background: tokens.lime }} />
      </div>
      <span style={{ fontFamily: tokens.fontBody, fontSize: 13, color: tokens.textDim }}>{s}/10</span>
    </div>
  );
}

export function relTime(iso: string | null): string {
  if (!iso) return "—";
  const d = Date.now() - new Date(iso).getTime();
  const m = Math.floor(d / 60000), h = Math.floor(m / 60), days = Math.floor(h / 24);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-GB");
}

// Inject the Google Fonts + base styles once.
export function OutboundStyles() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Barlow+Condensed:wght@400;500;600;700&display=swap');
      .ob-root { background:${tokens.bg}; color:${tokens.text}; font-family:${tokens.fontBody};
        min-height:100vh; padding:28px 32px; }
      .ob-h1 { font-family:${tokens.fontDisplay}; font-size:46px; letter-spacing:1px; margin:0;
        color:${tokens.text}; line-height:1; }
      .ob-sub { color:${tokens.textDim}; font-size:16px; margin:4px 0 24px; }
      .ob-panel { background:${tokens.panel}; border:1px solid ${tokens.border}; border-radius:14px; }
      .ob-row { transition:background .12s; cursor:pointer; }
      .ob-row:hover { background:${tokens.panelHi}; }
      .ob-input { background:${tokens.panel}; border:1px solid ${tokens.border}; color:${tokens.text};
        font-family:${tokens.fontBody}; font-size:16px; padding:12px 16px; border-radius:10px; outline:none; }
      .ob-input:focus { border-color:${tokens.lime}; }
      .ob-btn { font-family:${tokens.fontBody}; font-size:15px; font-weight:600; letter-spacing:.3px;
        padding:11px 20px; border-radius:10px; border:none; cursor:pointer; transition:filter .12s; }
      .ob-btn:hover { filter:brightness(1.08); }
      .ob-btn-primary { background:${tokens.lime}; color:#0a0a0a; }
      .ob-btn-ghost { background:transparent; color:${tokens.text}; border:1px solid ${tokens.border}; }
      .ob-btn-danger { background:transparent; color:${tokens.red}; border:1px solid ${tokens.red}55; }
      .ob-tab { font-family:${tokens.fontBody}; font-size:17px; padding:8px 4px; margin-right:26px;
        background:none; border:none; color:${tokens.textDim}; cursor:pointer; border-bottom:2px solid transparent; }
      .ob-tab-active { color:${tokens.text}; border-bottom-color:${tokens.lime}; }
      .ob-th { text-align:left; font-family:${tokens.fontBody}; font-weight:600; font-size:13px;
        text-transform:uppercase; letter-spacing:.6px; color:${tokens.textDim}; padding:12px 14px; }
      .ob-td { padding:14px; border-top:1px solid ${tokens.border}; font-size:15px; vertical-align:top; }
    `}</style>
  );
}
