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
    if (req.method === 'GET') {
      const { data } = await supabase
        .from('documents')
        .select('id, title, body, updated_at')
        .order('updated_at', { ascending: false });
      return res.status(200).json({ documents: data || [] });
    }

    if (req.method === 'POST') {
      const { action, user_id, id, title, body } = req.body;
      if (!user_id || !(await isAdmin(user_id))) {
        return res.status(403).json({ error: 'Admin only' });
      }
      if (action === 'save') {
        if (id) {
          await supabase.from('documents')
            .update({ title, body, updated_at: new Date().toISOString() })
            .eq('id', id);
        } else {
          await supabase.from('documents')
            .insert({ title, body, created_by: user_id });
        }
        return res.status(200).json({ ok: true });
      }
      if (action === 'delete') {
        await supabase.from('documents').delete().eq('id', id);
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ error: 'Unknown action' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('documents error:', err);
    return res.status(500).json({ error: err.message });
  }
}
