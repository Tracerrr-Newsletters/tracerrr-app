
Copy

import type { VercelRequest, VercelResponse } from '@vercel/node';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
 
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);
 
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});
 
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
 
  try {
    const payload = req.body;
    const emailData = payload.data;
 
    if (!emailData) {
      return res.status(200).json({ message: 'No email data in payload' });
    }
 
    // Check there's a PDF attachment
    const pdfMeta = emailData.attachments?.find((a: any) =>
      a.content_type === 'application/pdf' || a.filename?.endsWith('.pdf')
    );
 
    if (!pdfMeta) {
      return res.status(200).json({ message: 'No PDF attachment, skipping' });
    }
 
    // Use correct Resend receiving API endpoint
    const attachmentsRes = await fetch(
      `https://api.resend.com/emails/receiving/${emailData.email_id}/attachments`,
      {
        headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}` },
      }
    );
    const attachmentsData = await attachmentsRes.json();
 
    const pdfAttachment = attachmentsData?.data?.find((a: any) =>
      a.content_type === 'application/pdf' || a.filename?.endsWith('.pdf')
    );
 
    if (!pdfAttachment?.download_url) {
      return res.status(200).json({ message: 'No download_url found', raw: attachmentsData });
    }
 
    // Download the PDF
    const pdfResponse = await fetch(pdfAttachment.download_url);
    const pdfArrayBuffer = await pdfResponse.arrayBuffer();
    const pdfBuffer = Buffer.from(pdfArrayBuffer);
    const pdfBase64 = pdfBuffer.toString('base64');
 
    // Upload to Supabase Storage
    const filename = `${Date.now()}-${pdfAttachment.filename}`;
    const { error: uploadError } = await supabase.storage
      .from('invoices')
      .upload(filename, pdfBuffer, { contentType: 'application/pdf' });
 
    if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`);
 
    // Extract invoice data with Claude
    const extractionResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: pdfBase64,
            },
          },
          {
            type: 'text',
            text: `Extract the following from this invoice and return ONLY a JSON object with no markdown or preamble:
{
  "vendor": "company name on the invoice",
  "invoice_number": "invoice number",
  "invoice_date": "YYYY-MM-DD",
  "due_date": "YYYY-MM-DD or null",
  "amount": numeric total amount,
  "currency": "GBP or USD or EUR etc",
  "vat_amount": numeric VAT amount or null,
  "confidence": 0.0 to 1.0
}`
          }
        ],
      }],
    });
 
    const extractedText = extractionResponse.content
      .filter(b => b.type === 'text')
      .map(b => (b as any).text)
      .join('');
 
    const extracted = JSON.parse(extractedText);
    console.log('EXTRACTED:', JSON.stringify(extracted, null, 2));
 
    // Match to revolut_transactions by vendor name + amount
    // Look for transactions within 45 days of invoice date
    const invoiceDate = extracted.invoice_date ? new Date(extracted.invoice_date) : new Date();
    const dateFrom = new Date(invoiceDate);
    dateFrom.setDate(dateFrom.getDate() - 45);
    const dateTo = new Date(invoiceDate);
    dateTo.setDate(dateTo.getDate() + 45);
 
    const { data: transactions } = await supabase
      .from('revolut_transactions')
      .select('id, description, amount, currency, date')
      .gte('date', dateFrom.toISOString().split('T')[0])
      .lte('date', dateTo.toISOString().split('T')[0]);
 
    // Strip generic company suffixes before matching
    const suffixes = ['pte.', 'ltd.', 'ltd', 'inc.', 'inc', 'llc.', 'llc', 'limited', 'corporation', 'corp.', 'corp', 'group', 'co.', 'co'];
    const vendorLower = extracted.vendor?.toLowerCase() ?? '';
    const vendorWords = vendorLower
      .split(/\s+/)
      .filter((w: string) => w.length > 2 && !suffixes.includes(w));
 
    console.log('VENDOR WORDS:', vendorWords);
 
    let matchedTransactionId = null;
    let bestScore = 0;
 
    for (const tx of (transactions ?? [])) {
      const descLower = (tx.description ?? '').toLowerCase();
 
      // Check vendor word matches in description
      const wordMatches = vendorWords.filter((w: string) => descLower.includes(w)).length;
      const nameScore = vendorWords.length > 0 ? wordMatches / vendorWords.length : 0;
 
      console.log(`TX: ${tx.description} | nameScore: ${nameScore}`);
 
      if (nameScore < 0.5) continue;
 
      // Check amount is in the right ballpark (within 10%)
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
 
    const status = matchedTransactionId ? 'matched' : 'unmatched';
    console.log('MATCH:', { matchedTransactionId, bestScore, status });
 
    // Save to incoming_invoices
    const { data: invoice, error: insertError } = await supabase
      .from('incoming_invoices')
      .insert({
        vendor_id: null,
        cost_id: null,
        revolut_transaction_id: matchedTransactionId,
        invoice_date: extracted.invoice_date,
        invoice_number: extracted.invoice_number,
        amount: extracted.amount,
        currency: extracted.currency,
        amount_usd: extracted.currency === 'USD' ? extracted.amount : null,
        pdf_storage_path: filename,
        extraction_confidence: extracted.confidence,
        extracted_data: extracted,
        status,
      })
      .select()
      .single();
 
    if (insertError) throw new Error(`Insert failed: ${insertError.message}`);
 
    // If matched, update the revolut_transaction with the invoice_id
    if (matchedTransactionId && invoice) {
      await supabase
        .from('revolut_transactions')
        .update({ invoice_id: invoice.id })
        .eq('id', matchedTransactionId);
    }
 
    res.status(200).json({
      success: true,
      vendor: extracted.vendor,
      amount: extracted.amount,
      matched: !!matchedTransactionId,
      confidence: bestScore,
    });
 
  } catch (err: any) {
    console.error('Invoice processing error:', err);
    res.status(500).json({ error: err.message });
  }
}
 
