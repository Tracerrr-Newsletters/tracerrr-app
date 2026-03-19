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
  const { data: unmatchedInvoices } = await supabase
    .from('incoming_invoices')
    .select('id, extracted_data, amount, currency, invoice_date')
    .eq('status', 'unmatched');
 
  if (!unmatchedInvoices || unmatchedInvoices.length === 0) return 0;
 
  const suffixes = ['pte.', 'ltd.', 'ltd', 'inc.', 'inc', 'llc.', 'llc', 'limited', 'corporation', 'corp.', 'corp', 'group', 'co.', 'co'];
  let matched = 0;
 
  for (const invoice of unmatchedInvoices) {
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
        .from('incoming_invoices')
        .update({ status: 'matched', revolut_transaction_id: matchedTransactionId })
        .eq('id', invoice.id);
 
      await supabase
        .from('revolut_transactions')
        .update({ invoice_id: invoice.id })
        .eq('id', matchedTransactionId);
 
      matched++;
    }
  }
 
  return matched;
}
 
async function flagMissingInvoices() {
  // Flag debit transactions older than 7 days with no matched invoice
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
 
  const { error } = await supabase
    .from('revolut_transactions')
    .update({ needs_invoice: true })
    .lt('date', sevenDaysAgo.toISOString().split('T')[0])
    .is('invoice_id', null)
    .lt('amount', 0); // Only debits (negative amounts)
 
  // Also clear the flag on any that now have a matched invoice
  await supabase
    .from('revolut_transactions')
    .update({ needs_invoice: false })
    .not('invoice_id', 'is', null);
 
  if (error) console.error('Flag missing invoices error:', error.message);
}
 
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const accessToken = await getAccessToken();
 
    // Fetch transactions from Revolut
    const txResponse = await fetch('https://b2b.revolut.com/api/1.0/transactions?count=100', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
 
    const transactions = await txResponse.json();
 
    if (!Array.isArray(transactions)) {
      return res.status(200).json({ error: 'Unexpected response', raw: transactions });
    }
 
    // Upsert each transaction into Supabase
    const rows = transactions.map((tx: any) => ({
      revolut_id: tx.id,
      amount: tx.legs?.[0]?.amount,
      currency: tx.legs?.[0]?.currency,
      description: tx.legs?.[0]?.description || tx.reference || '',
      type: tx.type,
      state: tx.state,
      created_at: tx.created_at,
    }));
 
    const { error } = await supabase
      .from('revolut_transactions')
      .upsert(rows, { onConflict: 'revolut_id' });
 
    if (error) throw new Error(error.message);
 
    // Run matching pass on unmatched invoices
    const newlyMatched = await matchUnmatchedInvoices();
 
    // Flag transactions missing invoices after 7 days
    await flagMissingInvoices();
 
    res.status(200).json({ success: true, synced: rows.length, newlyMatched });
 
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
