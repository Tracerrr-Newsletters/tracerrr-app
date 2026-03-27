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

    // Only process emails addressed to invoices@mail.tracerrr.com
    const recipients = emailData.to || [];
    if (!recipients.some((addr: string) => addr.toLowerCase().includes('invoices@mail.tracerrr.com'))) {
      return res.status(200).json({ message: 'Not addressed to invoices@mail.tracerrr.com, skipping' });
    }

    const pdfMeta = emailData.attachments?.find((a: any) =>
      a.content_type === 'application/pdf' || a.filename?.endsWith('.pdf')
    );

    if (!pdfMeta) {
      return res.status(200).json({ message: 'No PDF attachment, skipping' });
    }

    const emailId = emailData.email_id;

    // Deduplication: check across BOTH cost and revenue types by email_id
    const { data: existing } = await supabase
      .from('invoices')
      .select('id, type')
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

    const filename = `costs/${Date.now()}-${pdfAttachment.filename}`;
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
  "vendor": "company name on the invoice — the supplier/seller, NOT the recipient",
  "invoice_number": "invoice number",
  "invoice_date": "YYYY-MM-DD",
  "due_date": "YYYY-MM-DD or null",
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
    console.log('EXTRACTED COST INVOICE:', JSON.stringify(extracted, null, 2));

    // Save as unmatched — revolut-sync will handle matching on next hourly run
    const { data: invoice, error: insertError } = await supabase
      .from('invoices')
      .insert({
        type: 'cost',
        vendor_name: extracted.vendor,
        invoice_number: extracted.invoice_number,
        invoice_date: extracted.invoice_date,
        due_date: extracted.due_date,
        amount: extracted.amount,
        currency: extracted.currency,
        amount_usd: extracted.currency === 'USD' ? extracted.amount : null,
        vat_amount: extracted.vat_amount ?? 0,
        revolut_transaction_id: null,
        pdf_storage_path: filename,
        extraction_confidence: extracted.confidence,
        extracted_data: { ...extracted, email_id: emailId },
        status: 'unmatched',
      })
      .select()
      .single();

    if (insertError) throw new Error(`Insert failed: ${insertError.message}`);

    res.status(200).json({
      success: true,
      vendor: extracted.vendor,
      amount: extracted.amount,
      currency: extracted.currency,
      invoice_id: invoice?.id,
      status: 'unmatched — will be matched on next revolut-sync run',
    });

  } catch (err: any) {
    console.error('Invoice processing error:', err);
    res.status(500).json({ error: err.message });
  }
}
