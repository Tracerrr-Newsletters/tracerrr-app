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
 
    const pdfMeta = emailData.attachments?.find((a: any) =>
      a.content_type === 'application/pdf' || a.filename?.endsWith('.pdf')
    );
 
    if (!pdfMeta) {
      return res.status(200).json({ message: 'No PDF attachment, skipping' });
    }
 
    // Deduplication check
    const emailId = emailData.email_id;
    const { data: existing } = await supabase
      .from('incoming_invoices')
      .select('id')
      .eq('extracted_data->>email_id', emailId)
      .limit(1);
 
    if (existing && existing.length > 0) {
      return res.status(200).json({ message: 'Already processed this email, skipping', email_id: emailId });
    }
 
    const attachmentsRes = await fetch(
      `https://api.resend.com/emails/receiving/${emailData.email_id}/attachments`,
      { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` } }
    );
    const attachmentsData = await attachmentsRes.json();
 
    const pdfAttachment = attachmentsData?.data?.find((a: any) =>
      a.content_type === 'application/pdf' || a.filename?.endsWith('.pdf')
    );
 
    if (!pdfAttachment?.download_url) {
      return res.status(200).json({ message: 'No download_url found', raw: attachmentsData });
    }
 
    // Download PDF
    const pdfResponse = await fetch(pdfAttachment.download_url);
    const pdfArrayBuffer = await pdfResponse.arrayBuffer();
    const pdfBuffer = Buffer.from(pdfArrayBuffer);
    const pdfBase64 = pdfBuffer.toString('base64');
 
    // Upload to Supabase Storage
    const filename = `revenue/${Date.now()}-${pdfAttachment.filename}`;
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
            source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
          },
          {
            type: 'text',
            text: `Extract the following from this invoice and return ONLY a JSON object with no markdown or preamble:
{
  "invoice_number": "invoice number as it appears on the document",
  "invoice_date": "YYYY-MM-DD",
  "client_name": "name of the client being billed",
  "amount": numeric total amount (excluding VAT),
  "currency": "GBP or USD or EUR etc",
  "vat_amount": numeric VAT amount or null,
  "total_amount": numeric total including VAT,
  "confidence": 0.0 to 1.0
}`,
          }
        ],
      }],
    });
 
    const extractedText = extractionResponse.content
      .filter(b => b.type === 'text')
      .map(b => (b as any).text)
      .join('');
 
    const extracted = JSON.parse(extractedText);
    console.log('EXTRACTED REVENUE INVOICE:', JSON.stringify(extracted, null, 2));
 
    const invoiceTotal = extracted.total_amount ?? extracted.amount ?? 0;
    const clientName = (extracted.client_name ?? '').toLowerCase().trim();
 
    // Look for Revolut credits within a wide window
    const invoiceDate = extracted.invoice_date ? new Date(extracted.invoice_date) : new Date();
    const dateFrom = new Date(invoiceDate);
    dateFrom.setDate(dateFrom.getDate() - 14);
    const dateTo = new Date(invoiceDate);
    dateTo.setDate(dateTo.getDate() + 90);
 
    const { data: credits } = await supabase
      .from('revolut_transactions')
      .select('id, description, amount, currency, date, counterparty_name')
      .gt('amount', 0)
      .gte('date', dateFrom.toISOString().split('T')[0])
      .lte('date', dateTo.toISOString().split('T')[0])
      .is('invoice_id', null);
 
    // ── PASS 1: Single invoice match (within 2%) ──────────────────────────────
    let matchedTransactionId: string | null = null;
    let matchType: string | null = null;
 
    for (const credit of credits ?? []) {
      const creditAmount = Math.abs(credit.amount ?? 0);
      const amountDiff = Math.abs(creditAmount - invoiceTotal) / Math.max(invoiceTotal, 1);
      if (amountDiff < 0.02) {
        matchedTransactionId = credit.id;
        matchType = 'single';
        break;
      }
    }
 
    // ── Save this invoice first (needed for bulk pass) ────────────────────────
    const { data: invoice, error: insertError } = await supabase
      .from('incoming_invoices')
      .insert({
        vendor_id: null,
        cost_id: null,
        revolut_transaction_id: matchedTransactionId,
        invoice_date: extracted.invoice_date,
        invoice_number: extracted.invoice_number,
        amount: invoiceTotal,
        currency: extracted.currency,
        amount_usd: extracted.currency === 'USD' ? invoiceTotal : null,
        pdf_storage_path: filename,
        extraction_confidence: extracted.confidence,
        extracted_data: {
          ...extracted,
          type: 'revenue',
          client_name: extracted.client_name,
          email_id: emailId,
          match_type: matchType,
        },
        status: matchedTransactionId ? 'matched' : 'unmatched',
      })
      .select()
      .single();
 
    if (insertError) throw new Error(`Insert failed: ${insertError.message}`);
 
    // If single match found, link and we're done
    if (matchedTransactionId && invoice) {
      await supabase
        .from('revolut_transactions')
        .update({ invoice_id: invoice.id, match_status: 'matched' })
        .eq('id', matchedTransactionId);
 
      return res.status(200).json({
        success: true,
        invoice_number: extracted.invoice_number,
        client: extracted.client_name,
        amount: invoiceTotal,
        matched: true,
        match_type: 'single',
        status: 'matched',
      });
    }
 
    // ── PASS 2: Bulk payment match ────────────────────────────────────────────
    // Fetch all unmatched revenue invoices for this client
    const { data: unmatchedForClient } = await supabase
      .from('incoming_invoices')
      .select('id, amount, invoice_number, extracted_data')
      .eq('status', 'unmatched')
      .eq('extracted_data->>type', 'revenue')
      .ilike('extracted_data->>client_name', `%${clientName}%`);
 
    const allUnmatched = unmatchedForClient ?? [];
    const totalUnmatched = allUnmatched.reduce((sum, inv) => sum + (inv.amount ?? 0), 0);
 
    console.log(`Bulk check: ${allUnmatched.length} unmatched invoices for "${clientName}" totalling ${totalUnmatched}`);
 
    // Check if any Revolut credit matches the combined total
    let bulkMatchedTransactionId: string | null = null;
 
    for (const credit of credits ?? []) {
      const creditAmount = Math.abs(credit.amount ?? 0);
      const amountDiff = Math.abs(creditAmount - totalUnmatched) / Math.max(totalUnmatched, 1);
      if (amountDiff < 0.02) {
        bulkMatchedTransactionId = credit.id;
        break;
      }
    }
 
    if (bulkMatchedTransactionId) {
      console.log(`Bulk match found! Linking ${allUnmatched.length} invoices to credit ${bulkMatchedTransactionId}`);
 
      // Link all unmatched invoices for this client to the one Revolut credit
      // Use the first invoice as the "primary" link on the transaction
      await supabase
        .from('revolut_transactions')
        .update({ invoice_id: invoice.id, match_status: 'matched' })
        .eq('id', bulkMatchedTransactionId);
 
      // Update each invoice individually to preserve their extracted_data
      for (const inv of allUnmatched) {
        await supabase
          .from('incoming_invoices')
          .update({
            status: 'matched',
            revolut_transaction_id: bulkMatchedTransactionId,
            extracted_data: {
              ...(inv.extracted_data ?? {}),
              match_type: 'bulk',
              bulk_credit_id: bulkMatchedTransactionId,
              bulk_total: totalUnmatched,
              bulk_invoice_count: allUnmatched.length,
            },
          })
          .eq('id', inv.id);
      }
 
      return res.status(200).json({
        success: true,
        invoice_number: extracted.invoice_number,
        client: extracted.client_name,
        amount: invoiceTotal,
        matched: true,
        match_type: 'bulk',
        bulk_invoice_count: allUnmatched.length,
        bulk_total: totalUnmatched,
        status: 'matched',
      });
    }
 
    // No match found — saved as unmatched, will retry on next Revolut sync
    return res.status(200).json({
      success: true,
      invoice_number: extracted.invoice_number,
      client: extracted.client_name,
      amount: invoiceTotal,
      matched: false,
      status: 'unmatched',
    });
 
  } catch (err: any) {
    console.error('Revenue invoice processing error:', err);
    res.status(500).json({ error: err.message });
  }
}
