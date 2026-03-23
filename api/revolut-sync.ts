import type { VercelRequest, VercelResponse } from '@vercel/node';
import * as jose from 'jose';
import { createClient } from '@supabase/supabase-js';
 
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);
 
async function getAccessToken(): Promise<string> {
  const clientId = process.env.REVOLUT_CLIENT_ID!;
  const privateKeyPem = process.env.REVOLUT_PRIVATE_KEY!.replace(/\\n/g, '\n');
  const refreshToken = process.env.REVOLUT_REFRESH_TOKEN!;
 
  const privateKey = await jose.importPKCS8(privateKeyPem, 'RS256');
 
  const jwt = await new jose.SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()
    .setIssuer('tracerrr-app.vercel.app')
    .setSubject(clientId)
    .setAudience('https://revolut.com')
    .setExpirationTime('1h')
    .sign(privateKey);
 
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: jwt,
  });
 
  const response = await fetch('https://b2b.revolut.com/api/1.0/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
 
  const data = await response.json();
  if (!data.access_token) throw new Error(`Token error: ${JSON.stringify(data)}`);
  return data.access_token;
}
 
// ─── FX RATE CACHE ────────────────────────────────────────────────────────────
const fxCache = new Map<string, number>();
 
async function getUsdToGbpRate(date: string): Promise<number> {
  const cacheKey = `USD-GBP-${date}`;
  if (fxCache.has(cacheKey)) return fxCache.get(cacheKey)!;
 
  try {
    const res = await fetch(`https://api.frankfurter.app/${date}?from=USD&to=GBP`);
    if (!res.ok) throw new Error(`Frankfurter ${res.status}`);
    const data = await res.json();
    const rate = data?.rates?.GBP;
    if (!rate) throw new Error('No GBP rate in response');
    fxCache.set(cacheKey, rate);
    return rate;
  } catch (err) {
    console.warn(`FX rate fetch failed for ${date}, using fallback 0.752:`, err);
    return 0.752;
  }
}
 
async function normaliseToGBP(amount: number, currency: string, date: string): Promise<number> {
  if (currency === 'GBP') return amount;
  if (currency === 'USD') {
    const rate = await getUsdToGbpRate(date);
    return amount * rate;
  }
  return amount;
}
 
// ─── MATCHING ENGINE ──────────────────────────────────────────────────────────
 
const LEGAL_SUFFIXES = new Set([
  'pte', 'ltd', 'inc', 'llc', 'limited', 'corporation', 'corp', 'group',
  'co', 'doing', 'business', 'as', 'dba', 'and', 'the', 'of', 'for',
]);
 
// Transaction types that should NEVER be matched to invoices
const EXCLUDED_MATCH_TYPES = new Set([
  'merchant_reserve', 'transfer', 'exchange', 'refund', 'topup', 'cashback'
]);
 
function normaliseVendor(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !LEGAL_SUFFIXES.has(w));
}
 
function vendorScore(invoiceVendor: string, txDescription: string, txCounterparty: string | null): number {
  const invoiceWords = normaliseVendor(invoiceVendor);
  const txText = `${txDescription} ${txCounterparty ?? ''}`.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  const txWords = normaliseVendor(txText);
 
  if (invoiceWords.length === 0) return 0;
 
  const forwardMatches = invoiceWords.filter(w => txText.includes(w)).length;
  const forwardScore = forwardMatches / invoiceWords.length;
 
  const invoiceText = invoiceVendor.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  const reverseMatches = txWords.filter(w => invoiceText.includes(w)).length;
  const reverseScore = txWords.length > 0 ? reverseMatches / txWords.length : 0;
 
  return Math.max(forwardScore, reverseScore);
}
 
async function amountScore(
  invoiceAmount: number, invoiceCurrency: string, invoiceDate: string,
  txAmount: number, txCurrency: string, txDate: string
): Promise<number> {
  const invoiceGBP = await normaliseToGBP(invoiceAmount, invoiceCurrency, invoiceDate);
  const txGBP = await normaliseToGBP(Math.abs(txAmount), txCurrency, txDate);
  const diff = Math.abs(invoiceGBP - txGBP) / Math.max(invoiceGBP, 0.01);
  if (diff <= 0.03) return 1.0;
  if (diff <= 0.10) return 0.7;
  if (diff <= 0.20) return 0.3;
  return 0;
}
 
function dateScore(invoiceDate: Date, txDate: string): number {
  const txD = new Date(txDate);
  const diffDays = Math.abs((invoiceDate.getTime() - txD.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays <= 1)  return 1.0;
  if (diffDays <= 7)  return 0.8;
  if (diffDays <= 14) return 0.5;
  if (diffDays <= 30) return 0.2;
  return 0;
}
 
const MIN_SCORE = 0.55;
const MIN_VENDOR_SCORE = 0.3;
 
async function matchUnmatchedInvoices() {
  const { data: unmatchedCosts } = await supabase
    .from('invoices')
    .select('id, extracted_data, amount, currency, invoice_date')
    .eq('status', 'unmatched')
    .eq('type', 'cost');
 
  const { data: unmatchedRevenue } = await supabase
    .from('invoices')
    .select('id, extracted_data, amount, currency, invoice_date, invoice_number')
    .eq('status', 'unmatched')
    .eq('type', 'revenue');
 
  let matched = 0;
 
  // Track which transaction IDs have been matched this run
  // to prevent one transaction matching multiple invoices
  const matchedTxIds = new Set<string>();
 
  // ── COST INVOICES ──────────────────────────────────────────────────────────
  for (const invoice of (unmatchedCosts ?? [])) {
    const extracted = invoice.extracted_data;
    if (!extracted?.vendor) continue;
 
    const invoiceDate = extracted.invoice_date ? new Date(extracted.invoice_date) : new Date();
    const invoiceDateStr = invoiceDate.toISOString().split('T')[0];
    const dateFrom = new Date(invoiceDate);
    dateFrom.setDate(dateFrom.getDate() - 45);
    const dateTo = new Date(invoiceDate);
    dateTo.setDate(dateTo.getDate() + 45);
 
    // Exclude internal/non-cost transaction types from matching
    const { data: transactions } = await supabase
      .from('revolut_transactions')
      .select('id, description, counterparty_name, amount, currency, date, type')
      .gte('date', dateFrom.toISOString().split('T')[0])
      .lte('date', dateTo.toISOString().split('T')[0])
      .lt('amount', 0)
      .is('invoice_id', null)
      .not('type', 'in', `(${[...EXCLUDED_MATCH_TYPES].join(',')})`);
 
    const invoiceAmount = parseFloat(extracted.amount ?? invoice.amount ?? 0);
    const invoiceCurrency = (extracted.currency ?? invoice.currency ?? 'GBP').toUpperCase();
 
    let bestMatchId: string | null = null;
    let bestScore = 0;
    let bestBreakdown = { vScore: 0, aScore: 0, dScore: 0 };
 
    for (const tx of (transactions ?? [])) {
      // Skip if already matched this run
      if (matchedTxIds.has(tx.id)) continue;
 
      const vScore = vendorScore(extracted.vendor, tx.description ?? '', tx.counterparty_name);
      if (vScore < MIN_VENDOR_SCORE) continue;
 
      const aScore = await amountScore(invoiceAmount, invoiceCurrency, invoiceDateStr, tx.amount, tx.currency, tx.date);
      const dScore = dateScore(invoiceDate, tx.date);
      const score = (vScore * 0.35) + (aScore * 0.40) + (dScore * 0.25);
 
      if (score > bestScore) {
        bestScore = score;
        bestMatchId = tx.id;
        bestBreakdown = { vScore, aScore, dScore };
      }
    }
 
    if (bestMatchId && bestScore >= MIN_SCORE) {
      console.log(`MATCHED cost invoice ${invoice.id} → tx ${bestMatchId} | score=${bestScore.toFixed(3)} vendor=${bestBreakdown.vScore.toFixed(2)} amount=${bestBreakdown.aScore.toFixed(2)} date=${bestBreakdown.dScore.toFixed(2)}`);
 
      await supabase
        .from('invoices')
        .update({ status: 'matched', revolut_transaction_id: bestMatchId })
        .eq('id', invoice.id);
 
      await supabase
        .from('revolut_transactions')
        .update({ invoice_id: invoice.id, match_status: 'matched' })
        .eq('id', bestMatchId);
 
      matchedTxIds.add(bestMatchId);
      matched++;
    }
  }
 
  // ── REVENUE INVOICES ───────────────────────────────────────────────────────
  const { data: allCredits } = await supabase
    .from('revolut_transactions')
    .select('id, description, amount, currency, date')
    .gt('amount', 0)
    .is('invoice_id', null);
 
  for (const invoice of (unmatchedRevenue ?? [])) {
    const invoiceTotal = invoice.amount ?? 0;
 
    let matchedCreditId: string | null = null;
    for (const credit of (allCredits ?? [])) {
      if (matchedTxIds.has(credit.id)) continue;
 
      const creditAmount = Math.abs(credit.amount ?? 0);
      const diff = Math.abs(creditAmount - invoiceTotal) / Math.max(invoiceTotal, 1);
      if (diff < 0.03) {
        matchedCreditId = credit.id;
        break;
      }
    }
 
    if (matchedCreditId) {
      await supabase
        .from('invoices')
        .update({ status: 'matched', revolut_transaction_id: matchedCreditId })
        .eq('id', invoice.id);
 
      await supabase
        .from('revolut_transactions')
        .update({ invoice_id: invoice.id, match_status: 'matched' })
        .eq('id', matchedCreditId);
 
      matchedTxIds.add(matchedCreditId);
      matched++;
    }
  }
 
  return matched;
}
 
// ─────────────────────────────────────────────────────────────────────────────
 
const EXCLUDED_TYPES = ['merchant_reserve', 'transfer', 'exchange', 'refund', 'topup', 'cashback'];
 
async function flagMissingInvoices() {
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
 
  await supabase
    .from('revolut_transactions')
    .update({ needs_invoice: true })
    .lt('date', sevenDaysAgo.toISOString().split('T')[0])
    .is('invoice_id', null)
    .lt('amount', 0)
    .not('type', 'in', `(${EXCLUDED_TYPES.join(',')})`);
 
  await supabase
    .from('revolut_transactions')
    .update({ needs_invoice: false })
    .not('invoice_id', 'is', null);
 
  await supabase
    .from('revolut_transactions')
    .update({ needs_invoice: false })
    .in('type', EXCLUDED_TYPES);
}
 
async function syncBalance(accessToken: string) {
  const response = await fetch('https://b2b.revolut.com/api/1.0/accounts', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
 
  const accounts = await response.json();
  if (!Array.isArray(accounts)) throw new Error(`Accounts error: ${JSON.stringify(accounts)}`);
 
  const activeAccounts = accounts.filter((a: any) => a.state === 'active');
  const balanceGbp = activeAccounts
    .filter((a: any) => a.currency === 'GBP')
    .reduce((sum: number, a: any) => sum + (a.balance ?? 0), 0);
  const balanceUsd = activeAccounts
    .filter((a: any) => a.currency === 'USD')
    .reduce((sum: number, a: any) => sum + (a.balance ?? 0), 0);
 
  const today = new Date().toISOString().split('T')[0];
  const liveRate = await getUsdToGbpRate(today).then(r => 1 / r).catch(() => 1.33);
 
  const { error } = await supabase
    .from('balance_snapshots')
    .upsert(
      { date: today, balance_gbp: balanceGbp, balance_usd: balanceUsd, gbp_usd_rate: liveRate },
      { onConflict: 'date' }
    );
 
  if (error) throw new Error(`Balance upsert error: ${error.message}`);
 
  return { balanceGbp, balanceUsd };
}
 
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const accessToken = await getAccessToken();
 
    const txResponse = await fetch('https://b2b.revolut.com/api/1.0/transactions?count=100', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
 
    const transactions = await txResponse.json();
 
    if (!Array.isArray(transactions)) {
      return res.status(200).json({ error: 'Unexpected response', raw: transactions });
    }
 
    const rows = transactions
      .map((tx: any) => ({
        revolut_id: tx.id,
        amount: tx.legs?.[0]?.amount,
        currency: tx.legs?.[0]?.currency,
        description: tx.legs?.[0]?.description || tx.reference || '',
        type: tx.type,
        state: tx.state,
        created_at: tx.created_at,
        date: tx.created_at ? tx.created_at.split('T')[0] : null,
        counterparty_name: tx.merchant?.name || tx.counterparty?.name || null,
      }))
      .filter((row: any) => row.amount !== 0 && row.amount != null && row.date != null);
 
    const skipped = transactions.length - rows.length;
 
    const { error } = await supabase
      .from('revolut_transactions')
      .upsert(rows, { onConflict: 'revolut_id' });
 
    if (error) throw new Error(error.message);
 
    const newlyMatched = await matchUnmatchedInvoices();
    await flagMissingInvoices();
    const { balanceGbp, balanceUsd } = await syncBalance(accessToken);
 
    res.status(200).json({ success: true, synced: rows.length, skipped, newlyMatched, balanceGbp, balanceUsd });
 
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
 
