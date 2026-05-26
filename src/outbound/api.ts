// ============================================================================
// outbound/api.ts — types + thin data layer over Supabase for the outbound UI
// ============================================================================
// Self-contained: initialises its own supabase client from the same Vite env
// vars Overview.tsx uses. Match what the rest of the dashboard already does.
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL ?? "",
  import.meta.env.VITE_SUPABASE_ANON_KEY ?? ""
);

export type ProspectStatus =
  | "new" | "qualifying" | "qualified" | "needs_review" | "rejected"
  | "enriching" | "enriched" | "drafting" | "ready" | "approved"
  | "sent" | "replied" | "in_convo" | "won" | "lost" | "skipped";

export type Priority = "hot" | "warm" | "cold";

export type ReplyClass =
  | "positive" | "objection" | "referral" | "not_now" | "ooo"
  | "soft_no" | "hard_no" | "unsubscribe" | "unclear";

export type DealStage =
  | "discovery" | "proposal_sent" | "negotiating" | "verbal_yes"
  | "contract_sent" | "signed" | "lost";

export interface Prospect {
  id: string;
  domain: string;
  raw_input: string | null;
  company: string | null;
  status: ProspectStatus;
  priority: Priority | null;

  qualification_status: string | null;
  qualification_score: number | null;
  qualification_reason: string | null;
  qualification_signals: Record<string, unknown> | null;

  fit_newsletter_id: string | null;
  fit_newsletter_name: string | null;
  fit_score: number | null;
  fit_reason: string | null;

  contact_name: string | null;
  contact_role: string | null;
  contact_email: string | null;
  contact_linkedin: string | null;
  company_data: Record<string, unknown> | null;
  enriched_at: string | null;

  top_angle: string | null;
  alt_angles: string[] | null;
  draft_subject: string | null;
  draft_body: string | null;

  sent_at: string | null;
  reply_received_at: string | null;
  reply_classification: ReplyClass | null;
  reply_body: string | null;
  draft_response: string | null;

  deal_stage: DealStage | null;
  deal_value_gbp: number | null;
  deal_probability_pct: number | null;
  expected_close_date: string | null;
  next_step: string | null;
  next_step_due: string | null;

  user_notes: string | null;
  created_at: string;
  updated_at: string;
  last_action: string | null;
  last_action_at: string | null;
}

export interface ProspectEvent {
  id: string;
  prospect_id: string;
  event_type: string;
  actor: string;
  summary: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
}

const FN_BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

async function callFn(name: string, body: unknown) {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(`${FN_BASE}/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${session?.access_token ?? import.meta.env.VITE_SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? `${name} failed`);
  return res.json();
}

// ---- queries ----
export async function listProspects(statuses?: ProspectStatus[]): Promise<Prospect[]> {
  let q = supabase.from("prospects").select("*");
  if (statuses?.length) q = q.in("status", statuses);
  const { data, error } = await q
    .order("priority", { ascending: true })
    .order("fit_score", { ascending: false, nullsFirst: false })
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return data as Prospect[];
}

export async function getProspect(id: string): Promise<Prospect> {
  const { data, error } = await supabase.from("prospects").select("*").eq("id", id).single();
  if (error) throw error;
  return data as Prospect;
}

export async function getEvents(prospectId: string): Promise<ProspectEvent[]> {
  const { data, error } = await supabase.from("prospect_events")
    .select("*").eq("prospect_id", prospectId).order("created_at", { ascending: false });
  if (error) throw error;
  return data as ProspectEvent[];
}

export async function updateProspect(id: string, patch: Partial<Prospect>) {
  const { error } = await supabase.from("prospects").update(patch).eq("id", id);
  if (error) throw error;
}

// ---- actions (call Edge Functions) ----
export const addProspect    = (domain: string) => callFn("add-prospect", { domain });
export const approveSend     = (id: string) => callFn("send-email", { prospect_id: id });
export const sendReply       = (id: string) => callFn("send-email", { prospect_id: id, is_reply: true });
export const requestEnrich   = (id: string) => callFn("enrich-prospect", { prospect_id: id });
export const redraft         = (id: string) => callFn("draft-email", { prospect_id: id });
