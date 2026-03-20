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

    // Upload to Supabase Storage in a revenue/ subfolder
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
  "invoice_number": "invoice number",
  "invoice_date": "YYYY-MM-DD",
  "client_name": "name of the client being billed",
  "amount": numeric total amount,
  "currency": "GBP or USD or EUR etc",
  "vat_amount": numeric VAT amount or null,
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

    // Try to match against outgoing_invoices by invoice number first (most reliable)
    let matchedInvoiceId = null;
    let matchMethod = null;

    if (extracted.invoice_number) {
      const { data: byNumber } = await supabase
        .from('outgoing_invoices')
        .select('id, invoice_number, total_usd, status')
        .eq('invoice_number', extracted.invoice_number)
        .single();

      if (byNumber) {
        matchedInvoiceId = byNumber.id;
        matchMethod = 'invoice_number';
      }
    }

    // Fallback: match by amount + date if invoice number didn't match
    if (!matchedInvoiceId && extracted.amount && extracted.invoice_date) {
      const invoiceDate = new Date(extracted.invoice_date);
      const dateFrom = new Date(invoiceDate);
      dateFrom.setDate(dateFrom.getDate() - 30);
      const dateTo = new Date(invoiceDate);
      dateTo.setDate(dateTo.getDate() + 30);

      const { data: candidates } = await supabase
        .from('outgoing_invoices')
        .select('id, invoice_number, total_usd, subtotal_usd, currency, issue_date')
        .gte('issue_date', dateFrom.toISOString().split('T')[0])
        .lte('issue_date', dateTo.toISOString().split('T')[0]);

      for (const candidate of candidates ?? []) {
        const candidateAmount = candidate.total_usd ?? candidate.subtotal_usd ?? 0;
        const amountDiff = Math.abs(candidateAmount - extracted.amount) / Math.max(extracted.amount, 1);
        if (amountDiff < 0.05) {
          matchedInvoiceId = candidate.id;
          matchMethod = 'amount_and_date';
          break;
        }
      }
    }

    const status = matchedInvoiceId ? 'matched' : 'unmatched';
    console.log('MATCH:', { matchedInvoiceId, matchMethod, status });

    // Update the outgoing invoice with the PDF path
    if (matchedInvoiceId) {
      await supabase
        .from('outgoing_invoices')
        .update({ pdf_storage_path: filename })
        .eq('id', matchedInvoiceId);
    }

    // Save a record to incoming_invoices so it appears in the report
    const { data: invoice, error: insertError } = await supabase
      .from('incoming_invoices')
      .insert({
        vendor_id: null,
        cost_id: null,
        revolut_transaction_id: null,
        invoice_date: extracted.invoice_date,
        invoice_number: extracted.invoice_number,
        amount: extracted.amount,
        currency: extracted.currency,
        amount_usd: extracted.currency === 'USD' ? extracted.amount : null,
        pdf_storage_path: filename,
        extraction_confidence: extracted.confidence,
        extracted_data: { ...extracted, type: 'revenue', matched_outgoing_invoice_id: matchedInvoiceId, match_method: matchMethod },
        status,
      })
      .select()
      .single();

    if (insertError) throw new Error(`Insert failed: ${insertError.message}`);

    res.status(200).json({
      success: true,
      invoice_number: extracted.invoice_number,
      client: extracted.client_name,
      amount: extracted.amount,
      matched: !!matchedInvoiceId,
      match_method: matchMethod,
    });

  } catch (err: any) {
    console.error('Revenue invoice processing error:', err);
    res.status(500).json({ error: err.message });
  }
}
