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

    // Check there's a PDF attachment
    const pdfMeta = emailData.attachments?.find((a: any) =>
      a.content_type === 'application/pdf' || a.filename?.endsWith('.pdf')
    );

    if (!pdfMeta) {
      return res.status(200).json({ message: 'No PDF attachment, skipping' });
    }

    // Fetch full email with attachment content from Resend
    const emailResponse = await fetch(`https://api.resend.com/emails/${emailData.email_id}`, {
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      },
    });

    const fullEmail = await emailResponse.json();
    console.log('FULL EMAIL:', JSON.stringify(fullEmail, null, 2));

    // Find PDF in full email
    const pdfAttachment = fullEmail.attachments?.find((a: any) =>
      a.content_type === 'application/pdf' || a.filename?.endsWith('.pdf')
    );

    if (!pdfAttachment?.content) {
      return res.status(200).json({ message: 'Could not retrieve PDF content' });
    }

    // Upload PDF to Supabase Storage
    const pdfBuffer = Buffer.from(pdfAttachment.content, 'base64');
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
              data: pdfAttachment.content,
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
  "curre
