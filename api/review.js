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
    const { task_id, reviewer_id, decision, note } = req.body;
    if (!task_id || !reviewer_id || !decision) {
      return res.status(400).json({ error: 'Missing fields' });
    }
    if (!['approved', 'declined'].includes(decision)) {
      return res.status(400).json({ error: 'Invalid decision' });
    }

    // Verify reviewer is admin or qa
    const { data: reviewer } = await supabase
      .from('profiles').select('role').eq('id', reviewer_id).single();
    if (!reviewer || !['admin', 'qa'].includes(reviewer.role)) {
      return res.status(403).json({ error: 'Not authorized to review' });
    }

    if (decision === 'approved') {
      await supabase.from('tasks').update({
        review_status: 'approved',
        reviewer_id,
        review_note: note || null
      }).eq('id', task_id);
    } else {
      // Declined: send back to annotator. Reset task to assigned so they redo it.
      await supabase.from('tasks').update({
        review_status: 'declined',
        reviewer_id,
        review_note: note || null,
        status: 'assigned',
        completed_at: null
      }).eq('id', task_id);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('review error:', err);
    return res.status(500).json({ error: err.message });
  }
}
