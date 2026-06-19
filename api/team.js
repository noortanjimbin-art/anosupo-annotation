import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function isAdmin(id){
  const { data } = await supabase.from('profiles').select('role').eq('id', id).single();
  return data && data.role === 'admin';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const requester = req.method === 'GET' ? req.query.user_id : req.body.user_id;
    if (!requester || !(await isAdmin(requester))) {
      return res.status(403).json({ error: 'Admin only' });
    }

    if (req.method === 'GET') {
      const { data } = await supabase
        .from('profiles')
        .select('id, email, full_name, role, created_at')
        .order('created_at', { ascending: true });
      return res.status(200).json({ members: data || [] });
    }

    if (req.method === 'POST') {
      const { target_id, new_role } = req.body;
      if (!target_id || !['admin','qa','annotator','pending'].includes(new_role)) {
        return res.status(400).json({ error: 'Invalid input' });
      }
      await supabase.from('profiles').update({ role: new_role }).eq('id', target_id);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('team error:', err);
    return res.status(500).json({ error: err.message });
  }
}
