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
      const { data: members } = await supabase
        .from('profiles')
        .select('id, email, full_name, role, created_at')
        .order('created_at', { ascending: true });

      // Attach task counts per member
      const { data: tasks } = await supabase.from('tasks').select('annotator_id, status');
      const counts = {};
      (tasks || []).forEach(t => {
        if (!t.annotator_id) return;
        if (!counts[t.annotator_id]) counts[t.annotator_id] = { assigned: 0, completed: 0, total: 0 };
        counts[t.annotator_id].total++;
        if (t.status === 'completed') counts[t.annotator_id].completed++;
        else counts[t.annotator_id].assigned++;
      });
      const withCounts = (members || []).map(m => ({ ...m, counts: counts[m.id] || { assigned:0, completed:0, total:0 } }));
      return res.status(200).json({ members: withCounts });
    }

    if (req.method === 'POST') {
      const { action, target_id, new_role, count } = req.body;

      // Change someone's role
      if (!action || action === 'set-role') {
        if (!target_id || !['admin','annotator','pending'].includes(new_role)) {
          return res.status(400).json({ error: 'Invalid input' });
        }
        await supabase.from('profiles').update({ role: new_role }).eq('id', target_id);
        return res.status(200).json({ ok: true });
      }

      // Bulk-assign N unassigned videos to a specific person
      if (action === 'bulk-assign') {
        const n = Math.max(1, Math.min(1000, parseInt(count) || 0));
        if (!target_id) return res.status(400).json({ error: 'target_id required' });
        const { data: vids } = await supabase
          .from('videos').select('id').eq('status','unassigned').limit(n);
        if (!vids || vids.length === 0) return res.status(200).json({ ok: true, assigned: 0 });
        const taskRows = vids.map(v => ({ video_id: v.id, annotator_id: target_id, status: 'assigned' }));
        await supabase.from('tasks').insert(taskRows);
        await supabase.from('videos').update({ status: 'assigned' }).in('id', vids.map(v=>v.id));
        return res.status(200).json({ ok: true, assigned: vids.length });
      }

      return res.status(400).json({ error: 'Unknown action' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('team error:', err);
    return res.status(500).json({ error: err.message });
  }
}
