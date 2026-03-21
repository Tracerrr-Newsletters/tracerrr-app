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
 
async function markOutgoingInvoicePaid(invoiceNumber: string, revolut_transaction_id: string) {
  // Find the outgoing invoice by number and mark as paid
  const { data: outgoing } = await supabase
    .from('outgoing_invoices')
    .select('id')
    .eq('invoice_number', invoiceNumber)
    .single();
 
  if (outgoing) {
    await supabase
      .from('outgoing_invoices')
      .update({
        status: 'paid',
        paid_date: new Date().toISOString().split('T')[0],
      })
      .eq('id', outgoing.id);
 
    console.log(`Marked outgoing invoice ${invoiceNumber} as paid`);
  }
}
 
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
 
    const pdfResponse = await fetch(pdfAttachment.download_url);
    const pdfArrayBuffer = await pdfResponse.arrayBuffer();
    const pdfBuffer = Buffer.from(pdfArrayBuffer);
    const pdfBase64 = pdfBuffer.toString('base64');
 
    const filename = `revenue/${Date.now()}-${pdfAttachment.filename}`;
    const { error: uploadError } = await supabase.storage
      .from('invoices')
      .upload(filename, pdfBuffer, { contentType: 'application/pdf' });
 
    if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`);
 
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
    const invoiceSubtotal = extracted.amount ?? 0;
    const clientName = (extracted.client_name ?? '').toLowerCase().trim();
 
    // Fetch ALL unmatched credits
    const { data: credits } = await supabase
      .from('revolut_transactions')
      .select('id, description, amount, currency, date, counterparty_name')
      .gt('amount', 0)
      .is('invoice_id', null);
 
    // PASS 1: Single invoice match on total OR subtotal within 2%
    let matchedTransactionId: string | null = null;
    let matchType: string | null = null;
 
    for (const credit of credits ?? []) {
      const creditAmount = Math.abs(credit.amount ?? 0);
      const diffTotal    = Math.abs(creditAmount - invoiceTotal)    / Math.max(invoiceTotal, 1);
      const diffSubtotal = Math.abs(creditAmount - invoiceSubtotal) / Math.max(invoiceSubtotal, 1);
      if (diffTotal < 0.02 || diffSubtotal < 0.02) {
        matchedTransactionId = credit.id;
        matchType = 'single';
        break;
      }
    }
 
    // Save invoice
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
 
    // Single match — link Revolut transaction and mark outgoing invoice as paid
    if (matchedTransactionId && invoice) {
      await supabase
        .from('revolut_transactions')
        .update({ invoice_id: invoice.id, match_status: 'matched' })
        .eq('id', matchedTransactionId);
 
      // Mark outgoing invoice as paid
      await markOutgoingInvoicePaid(extracted.invoice_number, matchedTransactionId);
 
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
 
    // PASS 2: Bulk payment match
    const { data: unmatchedForClient } = await supabase
      .from('incoming_invoices')
      .select('id, amount, invoice_number, extracted_data')
      .eq('status', 'unmatched')
      .eq('extracted_data->>type', 'revenue')
      .ilike('extracted_data->>client_name', `%${clientName}%`);
 
    const allUnmatched = unmatchedForClient ?? [];
    const totalUnmatched = allUnmatched.reduce((sum, inv) => sum + (inv.amount ?? 0), 0);
 
    console.log(`Bulk check: ${allUnmatched.length} unmatched invoices for "${clientName}" totalling ${totalUnmatched}`);
 
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
 
      await supabase
        .from('revolut_transactions')
        .update({ invoice_id: invoice.id, match_status: 'matched' })
        .eq('id', bulkMatchedTransactionId);
 
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
 
        // Mark each outgoing invoice as paid
        const invNumber = inv.extracted_data?.invoice_number ?? inv.invoice_number;
        if (invNumber) {
          await markOutgoingInvoicePaid(invNumber, bulkMatchedTransactionId);
        }
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
