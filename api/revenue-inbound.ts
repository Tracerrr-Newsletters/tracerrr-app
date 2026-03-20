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
 
    // Match against Revolut credit transactions (positive amounts = money in)
    // Look within 60 days of invoice date for a matching credit
    const invoiceDate = extracted.invoice_date ? new Date(extracted.invoice_date) : new Date();
    const dateFrom = new Date(invoiceDate);
    dateFrom.setDate(dateFrom.getDate() - 14); // payment could come before invoice date
    const dateTo = new Date(invoiceDate);
    dateTo.setDate(dateTo.getDate() + 60); // or up to 60 days after
 
    const { data: credits } = await supabase
      .from('revolut_transactions')
      .select('id, description, amount, currency, date, counterparty_name')
      .gt('amount', 0) // credits only
      .gte('date', dateFrom.toISOString().split('T')[0])
      .lte('date', dateTo.toISOString().split('T')[0])
      .is('invoice_id', null); // not already matched
 
    // Match on amount within 2% — unlikely to have two sponsors pay same amount
    const invoiceTotal = extracted.total_amount ?? extracted.amount ?? 0;
    let matchedTransactionId = null;
 
    for (const credit of credits ?? []) {
      const creditAmount = Math.abs(credit.amount ?? 0);
      const amountDiff = Math.abs(creditAmount - invoiceTotal) / Math.max(invoiceTotal, 1);
      if (amountDiff < 0.02) {
        matchedTransactionId = credit.id;
        break;
      }
    }
 
    const status = matchedTransactionId ? 'matched' : 'unmatched';
    console.log('REVOLUT CREDIT MATCH:', { matchedTransactionId, status });
 
    // Save to incoming_invoices with type=revenue
    const { data: invoice, error: insertError } = await supabase
      .from('incoming_invoices')
      .insert({
        vendor_id: null,
        cost_id: null,
        revolut_transaction_id: matchedTransactionId,
        invoice_date: extracted.invoice_date,
        invoice_number: extracted.invoice_number,
        amount: extracted.total_amount ?? extracted.amount,
        currency: extracted.currency,
        amount_usd: extracted.currency === 'USD' ? (extracted.total_amount ?? extracted.amount) : null,
        pdf_storage_path: filename,
        extraction_confidence: extracted.confidence,
        extracted_data: {
          ...extracted,
          type: 'revenue',
          client_name: extracted.client_name,
        },
        status,
      })
      .select()
      .single();
 
    if (insertError) throw new Error(`Insert failed: ${insertError.message}`);
 
    // If matched, link the Revolut transaction and mark it
    if (matchedTransactionId && invoice) {
      await supabase
        .from('revolut_transactions')
        .update({
          invoice_id: invoice.id,
          match_status: 'matched',
        })
        .eq('id', matchedTransactionId);
    }
 
    res.status(200).json({
      success: true,
      invoice_number: extracted.invoice_number,
      client: extracted.client_name,
      amount: extracted.total_amount ?? extracted.amount,
      currency: extracted.currency,
      matched: !!matchedTransactionId,
      status,
    });
 
  } catch (err: any) {
    console.error('Revenue invoice processing error:', err);
    res.status(500).json({ error: err.message });
  }
}
