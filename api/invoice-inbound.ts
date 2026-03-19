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
 
    // Step 1: Get attachment metadata including download_url
    const attachmentMetaResponse = await fetch(
      `https://api.resend.com/emails/${emailData.email_id}/attachments/${pdfMeta.id}`,
      {
        headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}` },
      }
    );
    const attachmentMeta = await attachmentMetaResponse.json();
    console.log('ATTACHMENT META:', JSON.stringify(attachmentMeta, null, 2));
 
    if (!attachmentMeta.download_url) {
      return res.status(200).json({ message: 'No download_url in attachment response', raw: attachmentMeta });
    }
 
    // Step 2: Download the actual PDF content
    const pdfResponse = await fetch(attachmentMeta.download_url);
    const pdfArrayBuffer = await pdfResponse.arrayBuffer();
    const pdfBuffer = Buffer.from(pdfArrayBuffer);
    const pdfBase64 = pdfBuffer.toString('base64');
 
    // Upload PDF to Supabase Storage
    const filename = `${Date.now()}-${pdfMeta.filename}`;
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
 
    // Match to baseline_cost by vendor name
    const { data: costs } = await supabase
      .from('baseline_costs')
      .select('id, name');
 
    let matchedCostId = null;
    let bestMatch = 0;
 
    for (const cost of (costs ?? [])) {
      const vendorLower = extracted.vendor?.toLowerCase() ?? '';
      const costLower = cost.name?.toLowerCase() ?? '';
      if (vendorLower.includes(costLower) || costLower.includes(vendorLower)) {
        const score = costLower.length / Math.max(vendorLower.length, costLower.length);
        if (score > bestMatch) {
          bestMatch = score;
          matchedCostId = cost.id;
        }
      }
    }
 
    // Save to incoming_invoices
    const { error: insertError } = await supabase
      .from('incoming_invoices')
      .insert({
        vendor_id: null,
        cost_id: matchedCostId,
        invoice_date: extracted.invoice_date,
        invoice_number: extracted.invoice_number,
        amount: extracted.amount,
        currency: extracted.currency,
        amount_usd: extracted.currency === 'USD' ? extracted.amount : null,
        pdf_storage_path: filename,
        extraction_confidence: extracted.confidence,
        extracted_data: extracted,
        status: matchedCostId ? 'matched' : 'unmatched',
      });
 
    if (insertError) throw new Error(`Insert failed: ${insertError.message}`);
 
    res.status(200).json({
      success: true,
      vendor: extracted.vendor,
      amount: extracted.amount,
      matched: !!matchedCostId,
    });
 
  } catch (err: any) {
    console.error('Invoice processing error:', err);
    res.status(500).json({ error: err.message });
  }
}
