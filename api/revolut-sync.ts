/**
 * Tracerrr — Revolut Sync
 * Vercel Cron: 0 * * * * (hourly balance + daily transactions)
 * Also callable manually: GET /api/revolut-sync
 */

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const REVOLUT_CLIENT_ID = process.env.REVOLUT_CLIENT_ID!;
const REVOLUT_PRIVATE_KEY = process.env.REVOLUT_PRIVATE_KEY!;
const REVOLUT_BASE = "https://b2b.revolut.com/api/1.0";

// ── JWT helpers ───────────────────────────────────────────────

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const pemContents = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    binaryDer.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

function base64url(data: ArrayBuffer | string): string {
  let str: string;
  if (typeof data === "string") {
    str = btoa(data);
  } else {
    str = btoa(String.fromCharCode(...new Uint8Array(data)));
  }
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function makeJWT(): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: "tracerrr-app.vercel.app",
    sub: REVOLUT_CLIENT_ID,
    aud: "https://revolut.com",
    iat: now,
    exp: now + 3600,
  };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const key = await importPrivateKey(REVOLUT_PRIVATE_KEY);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput)
  );

  return `${signingInput}.${base64url(signature)}`;
}

async function getAccessToken(): Promise<string> {
  const jwt = await makeJWT();

  const res = await fetch("https://b2b.revolut.com/api/1.0/auth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_assertion_type:
        "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: jwt,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Revolut auth failed ${res.status}: ${body}`);
  }

  const data = await res.json() as { access_token: string };
  return data.access_token;
}

// ── Revolut API calls ─────────────────────────────────────────

async function getAccounts(token: string) {
  const res = await fetch(`${REVOLUT_BASE}/accounts`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Revolut accounts failed ${res.status}`);
  return res.json();
}

async function getTransactions(token: string, from: string) {
  const res = await fetch(
    `${REVOLUT_BASE}/transactions?from=${from}&count=100`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Revolut transactions failed ${res.status}`);
  return res.json();
}

// ── Exchange rate helper ──────────────────────────────────────

async function getGBPUSDRate(): Promise<number> {
  try {
    const res = await fetch(
      "https://api.exchangerate-api.com/v4/latest/GBP"
    );
    const data = await res.json() as { rates: Record<string, number> };
    return data.rates.USD ?? 1.27;
  } catch {
    return 1.27; // fallback
  }
}

// ── Main handler ──────────────────────────────────────────────

export default async function handler(
  req: { method: string; query: Record<string, string> },
  res: { status: (n: number) => { json: (d: unknown) => void } }
) {
  const results: Record<string, unknown> = {};
  const errors: string[] = [];

  try {
    // Get access token
    const token = await getAccessToken();
    results.auth = "ok";

    // Get accounts + balance
    const accounts = await getAccounts(token) as Array<{
      id: string;
      currency: string;
      balance: number;
      name: string;
    }>;

    const gbpAccount = accounts.find((a) => a.currency === "GBP");
    const usdAccount = accounts.find((a) => a.currency === "USD");

    const rate = await getGBPUSDRate();
    const balanceGBP = gbpAccount ? gbpAccount.balance / 100 : 0; // Revolut returns pence
    const balanceUSD = usdAccount
      ? usdAccount.balance / 100
      : balanceGBP * rate;

    // Save balance snapshot
    const today = new Date().toISOString().split("T")[0];
    const { error: balError } = await supabase
      .from("balance_snapshots")
      .upsert(
        {
          date: today,
          balance_gbp: balanceGBP,
          balance_usd: balanceUSD,
          gbp_usd_rate: rate,
          source: "revolut_api",
          raw_response: { accounts },
        },
        { onConflict: "date,source" }
      );

    if (balError) errors.push(`Balance snapshot: ${balError.message}`);
    results.balance_gbp = balanceGBP;
    results.balance_usd = balanceUSD;

    // Get transactions from last 30 days
    const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];

    const transactions = await getTransactions(token, from) as Array<{
      id: string;
      created_at: string;
      amount: number;
      currency: string;
      description?: string;
      type: string;
      counterparty?: { name?: string; account_no?: string };
      legs?: Array<{ amount: number; currency: string }>;
    }>;

    let txSynced = 0;
    for (const tx of transactions) {
      const amount = tx.amount / 100; // Revolut returns pence/cents
      const isCredit = amount > 0;
      const amountUSD =
        tx.currency === "USD" ? amount : amount * rate;

      const { error: txError } = await supabase
        .from("revolut_transactions")
        .upsert(
          {
            revolut_id: tx.id,
            date: tx.created_at,
            description: tx.description ?? null,
            amount: Math.abs(amount),
            currency: tx.currency,
            amount_usd: Math.abs(amountUSD),
            type: isCredit ? "credit" : "debit",
            counterparty_name: tx.counterparty?.name ?? null,
            counterparty_account: tx.counterparty?.account_no ?? null,
            match_status: "unmatched",
          },
          { onConflict: "revolut_id" }
        );

      if (txError) errors.push(`Transaction ${tx.id}: ${txError.message}`);
      else txSynced++;
    }

    results.transactions_synced = txSynced;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(msg);
  }

  return res.status(errors.length > 0 && !results.balance_gbp ? 500 : 200).json({
    success: errors.length === 0,
    synced_at: new Date().toISOString(),
    results,
    errors,
  });
}
