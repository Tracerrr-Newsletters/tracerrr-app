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
 
  const suffixes = ['pte.', 'ltd.', 'ltd', 'inc.', 'inc', 'llc.', 'llc', 'limited', 'corporation', 'corp.', 'corp', 'group', 'co.', 'co'];
  let matched = 0;
 
  for (const invoice of (unmatchedCosts ?? [])) {
    const extracted = invoice.extracted_data;
    if (!extracted?.vendor) continue;
 
    const invoiceDate = extracted.invoice_date ? new Date(extracted.invoice_date) : new Date();
    const dateFrom = new Date(invoiceDate);
    dateFrom.setDate(dateFrom.getDate() - 45);
    const dateTo = new Date(invoiceDate);
    dateTo.setDate(dateTo.getDate() + 45);
 
    const { data: transactions } = await supabase
      .from('revolut_transactions')
      .select('id, description, amount, currency, date')
      .gte('date', dateFrom.toISOString().split('T')[0])
      .lte('date', dateTo.toISOString().split('T')[0])
      .lt('amount', 0)
      .is('invoice_id', null);
 
    const vendorLower = extracted.vendor?.toLowerCase() ?? '';
    const vendorWords = vendorLower
      .split(/\s+/)
      .filter((w: string) => w.length > 2 && !suffixes.includes(w));
 
    let matchedTransactionId = null;
    let bestScore = 0;
 
    for (const tx of (transactions ?? [])) {
      const descLower = (tx.description ?? '').toLowerCase();
      const wordMatches = vendorWords.filter((w: string) => descLower.includes(w)).length;
      const nameScore = vendorWords.length > 0 ? wordMatches / vendorWords.length : 0;
      if (nameScore < 0.5) continue;
 
      const txAmount = Math.abs(tx.amount ?? 0);
      const invoiceAmount = extracted.amount ?? 0;
      const amountDiff = Math.abs(txAmount - invoiceAmount) / Math.max(invoiceAmount, 1);
      const amountScore = amountDiff < 0.1 ? 1 : amountDiff < 0.3 ? 0.5 : 0;
      const totalScore = (nameScore * 0.6) + (amountScore * 0.4);
 
      if (totalScore > bestScore) {
        bestScore = totalScore;
        matchedTransactionId = tx.id;
      }
    }
 
    if (matchedTransactionId) {
      await supabase
        .from('invoices')
        .update({ status: 'matched', revolut_transaction_id: matchedTransactionId })
        .eq('id', invoice.id);
 
      await supabase
        .from('revolut_transactions')
        .update({ invoice_id: invoice.id, match_status: 'matched' })
        .eq('id', matchedTransactionId);
 
      matched++;
    }
  }
 
  const { data: allCredits } = await supabase
    .from('revolut_transactions')
    .select('id, description, amount, currency, date')
    .gt('amount', 0)
    .is('invoice_id', null);
 
  for (const invoice of (unmatchedRevenue ?? [])) {
    const invoiceTotal = invoice.amount ?? 0;
 
    for (const credit of (allCredits ?? [])) {
      const creditAmount = Math.abs(credit.amount ?? 0);
      const diff = Math.abs(creditAmount - invoiceTotal) / Math.max(invoiceTotal, 1);
      if (diff < 0.02) {
        await supabase
          .from('invoices')
          .update({ status: 'matched', revolut_transaction_id: credit.id })
          .eq('id', invoice.id);
 
        await supabase
          .from('revolut_transactions')
          .update({ invoice_id: invoice.id, match_status: 'matched' })
          .eq('id', credit.id);
 
        matched++;
        break;
      }
    }
  }
 
  return matched;
}
 
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
  const GBP_USD_RATE = 1.33;
 
  const response = await fetch('https://b2b.revolut.com/api/1.0/accounts', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
 
  const accounts = await response.json();
  if (!Array.isArray(accounts)) throw new Error(`Accounts error: ${JSON.stringify(accounts)}`);
 
  // Sum all active accounts per currency
  const activeAccounts = accounts.filter((a: any) => a.state === 'active');
  const balanceGbp = activeAccounts
    .filter((a: any) => a.currency === 'GBP')
    .reduce((sum: number, a: any) => sum + (a.balance ?? 0), 0);
  const balanceUsd = activeAccounts
    .filter((a: any) => a.currency === 'USD')
    .reduce((sum: number, a: any) => sum + (a.balance ?? 0), 0);
 
  const today = new Date().toISOString().split('T')[0];
 
  const { error } = await supabase
    .from('balance_snapshots')
    .upsert(
      { date: today, balance_gbp: balanceGbp, balance_usd: balanceUsd, gbp_usd_rate: GBP_USD_RATE },
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
