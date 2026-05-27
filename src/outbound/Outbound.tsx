// ============================================================================
// outbound/Outbound.tsx — top-level container. Self-contained nav between the
// four views, with URL sync so /outbound/{id} deep-links to ProspectDetail and
// the browser back/forward buttons work.
// ============================================================================
import { useEffect, useState } from "react";
import { OutboundStyles, tokens } from "./ui";
import ProspectList from "./ProspectList";
import Inbox from "./Inbox";
import Pipeline from "./Pipeline";
import ProspectDetail from "./ProspectDetail";

type View = "list" | "inbox" | "pipeline";

// Match /outbound/{uuid-ish} so Slack's "Open in app" link lands on the detail.
const idFromPath = (): string | null => {
  const m = window.location.pathname.match(/^\/outbound\/([0-9a-fA-F-]{8,})$/);
  return m ? m[1] : null;
};

export default function Outbound() {
  const [view, setView] = useState<View>("list");
  const [openId, setOpenId] = useState<string | null>(() => idFromPath());

  // Keep the URL in sync with the open prospect, without re-mounting on each change.
  useEffect(() => {
    const target = openId ? `/outbound/${openId}` : `/outbound`;
    if (window.location.pathname !== target) {
      window.history.pushState({}, "", target);
    }
  }, [openId]);

  // Respect browser back/forward.
  useEffect(() => {
    const onPop = () => setOpenId(idFromPath());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  return (
    <div className="ob-root">
      <OutboundStyles />

      {/* primary nav */}
      {!openId && (
        <div style={{ display: "flex", gap: 4, marginBottom: 28 }}>
          {(["list","inbox","pipeline"] as View[]).map(v => (
            <button key={v}
              onClick={() => setView(v)}
              style={{
                fontFamily: tokens.fontBody, fontSize: 18, fontWeight: 600,
                padding: "8px 18px", borderRadius: 10, border: "none", cursor: "pointer",
                background: view === v ? tokens.lime : "transparent",
                color: view === v ? "#0a0a0a" : tokens.textDim,
              }}>
              {v === "list" ? "Prospects" : v === "inbox" ? "Inbox" : "Pipeline"}
            </button>
          ))}
        </div>
      )}

      {openId
        ? <ProspectDetail id={openId} onBack={() => setOpenId(null)} />
        : view === "list"   ? <ProspectList onOpen={setOpenId} />
        : view === "inbox"  ? <Inbox onOpen={setOpenId} />
        :                      <Pipeline onOpen={setOpenId} />}
    </div>
  );
}
