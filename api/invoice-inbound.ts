import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  console.log('BODY KEYS:', Object.keys(req.body));
  console.log('FULL BODY:', JSON.stringify(req.body, null, 2));

  res.status(200).json({ received: true });
}
