import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      const { data } = await supabase.from('settings').select('key, value');
      const obj = {};
      (data || []).forEach(s => { obj[s.key] = s.value; });
      return res.status(200).json({ settings: obj });
    }
    if (req.method === 'POST') {
      const { user_id, key, value } = req.body;
      const { data: prof } = await supabase.from('profiles').select('role').eq('id', user_id).single();
      if (!prof || prof.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
      await supabase.from('settings').upsert({ key, value: String(value) });
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
