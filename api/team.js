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

      // Attach task counts per member — page through ALL tasks (avoid 1000-row cap)
      const counts = {};
      const reviewCounts = {};
      let offset = 0;
      const pageSize = 1000;
      while (true) {
        const { data: tpage } = await supabase
          .from('tasks').select('annotator_id, reviewer_id, status, review_status')
          .range(offset, offset + pageSize - 1);
        if (!tpage || tpage.length === 0) break;
        tpage.forEach(t => {
          // Annotation counts (by annotator)
          if (t.annotator_id) {
            if (!counts[t.annotator_id]) counts[t.annotator_id] = { assigned: 0, completed: 0, total: 0 };
            counts[t.annotator_id].total++;
            if (t.status === 'completed') counts[t.annotator_id].completed++;
            else counts[t.annotator_id].assigned++;
          }
          // Review counts (by reviewer) — for QA payment tracking
          if (t.reviewer_id) {
            if (!reviewCounts[t.reviewer_id]) reviewCounts[t.reviewer_id] = { reviewed: 0, approved: 0, rejected: 0 };
            reviewCounts[t.reviewer_id].reviewed++;
            if (t.review_status === 'approved') reviewCounts[t.reviewer_id].approved++;
            else if (t.review_status === 'rejected') reviewCounts[t.reviewer_id].rejected++;
          }
        });
        if (tpage.length < pageSize) break;
        offset += pageSize;
      }
      const withCounts = (members || []).map(m => ({
        ...m,
        counts: counts[m.id] || { assigned:0, completed:0, total:0 },
        review_counts: reviewCounts[m.id] || { reviewed:0, approved:0, rejected:0 }
      }));

      // Also return the pre-authorized invite list (emails not yet signed up)
      const { data: invites } = await supabase
        .from('invites').select('email, role, created_at').order('created_at', { ascending: false });
      const memberEmails = new Set((members||[]).map(m => (m.email||'').toLowerCase()));
      const pendingInvites = (invites||[]).filter(i => !memberEmails.has((i.email||'').toLowerCase()));

      return res.status(200).json({ members: withCounts, invites: pendingInvites });
    }

    if (req.method === 'POST') {
      const { action, target_id, new_role, count } = req.body;

      // Change someone's role
      if (!action || action === 'set-role') {
        if (!target_id || !['admin','annotator','qa','pending'].includes(new_role)) {
          return res.status(400).json({ error: 'Invalid input' });
        }
        await supabase.from('profiles').update({ role: new_role }).eq('id', target_id);
        return res.status(200).json({ ok: true });
      }

      // Add a pre-authorized invite (email + role)
      if (action === 'add-invite') {
        const email = (req.body.email||'').trim().toLowerCase();
        const role = req.body.role;
        if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
        if (!['admin','annotator','qa'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
        // If they already signed up, just set their role directly
        const { data: existing } = await supabase.from('profiles').select('id').eq('email', email).single();
        if (existing) {
          await supabase.from('profiles').update({ role }).eq('id', existing.id);
        } else {
          await supabase.from('invites').upsert({ email, role });
        }
        return res.status(200).json({ ok: true });
      }

      // Remove an invite
      if (action === 'remove-invite') {
        const email = (req.body.email||'').trim().toLowerCase();
        await supabase.from('invites').delete().eq('email', email);
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
