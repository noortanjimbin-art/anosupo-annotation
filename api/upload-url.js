import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { path } = req.body;
    if (!path) return res.status(400).json({ error: 'path required' });

    const { data, error } = await supabase.storage
      .from('frames')
      .createSignedUploadUrl(path);

    if (error) throw error;

    return res.status(200).json({ token: data.token, path: data.path });
  } catch (err) {
    console.error('Upload URL error:', err);
    return res.status(500).json({ error: err.message });
  }
}
