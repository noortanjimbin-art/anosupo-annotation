// QA review actions, all in one function to respect the 12-function limit.
// GET  /api/review?action=next&user_id=...&queue=default|revised|rejected -> next task (atomically claimed)
// GET  /api/review?action=count&user_id=...&queue=...                     -> how many tasks await review
// POST /api/review {action:'approve'|'reject', user_id, task_id, note}
//
// Claiming (no-overlap): serving "next" stamps assigned_reviewer_id + claimed_at.
// Other reviewers skip claimed tasks; claims expire after 30 minutes so an
// abandoned task returns to the pool. Approve/reject clears the claim.
// Admin-designated tasks (assigned_reviewer_id set, claimed_at null) never expire.
import { createClient } from '@supabase/supabase-js';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const r2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY }
});

async function getRole(id){
  const { data } = await supabase.from('profiles').select('role').eq('id', id).single();
  return data ? data.role : null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      const { action, user_id } = req.query;
      const role = await getRole(user_id);
      if (role !== 'qa' && role !== 'admin') return res.status(403).json({ error: 'QA or admin only' });

      const queue = (req.query.queue === 'revised' || req.query.queue === 'rejected') ? req.query.queue : 'default';
      const CLAIM_MIN = 30; // minutes before an abandoned claim expires
      const cutoff = new Date(Date.now() - CLAIM_MIN * 60 * 1000).toISOString();
      // Visible to me: unclaimed, or claimed/designated to me, or claim expired
      const visible = `assigned_reviewer_id.is.null,assigned_reviewer_id.eq.${user_id},claimed_at.lt.${cutoff}`;
      const applyQueue = (q) => {
        if (queue === 'revised')  return q.eq('status', 'completed').eq('review_status', 'revised');
        if (queue === 'rejected') return q.eq('review_status', 'rejected');
        return q.eq('status', 'completed').in('review_status', ['none', 'in_review', 'revised']);
      };

      // Count of tasks waiting for review in the requested queue
      if (action === 'count') {
        let q = supabase.from('tasks').select('*', { count: 'exact', head: true });
        q = applyQueue(q).or(visible);
        const { count } = await q;
        return res.status(200).json({ pending: count || 0 });
      }

      // Next task in the requested queue — atomically claimed so reviewers never overlap
      if (action === 'next') {
        let q = supabase
          .from('tasks')
          .select('id, video_id, annotator_id, review_status, assigned_reviewer_id, claimed_at, videos(filename, storage_path), profiles!tasks_annotator_id_fkey(email, full_name)');
        q = applyQueue(q).or(visible)
          .order('assigned_reviewer_id', { ascending: true, nullsFirst: false })
          .order('completed_at', { ascending: true })
          .limit(5);
        const { data: cands } = await q;
        if (!cands || cands.length === 0) return res.status(200).json({ done: true, message: 'No tasks waiting for review.' });

        // Try to claim candidates in order; the guard makes the claim atomic —
        // if another reviewer grabbed it a moment earlier, 0 rows update and we move on.
        let task = null;
        for (const cand of cands) {
          const { data: got } = await supabase.from('tasks')
            .update({ assigned_reviewer_id: user_id, claimed_at: new Date().toISOString() })
            .eq('id', cand.id)
            .or(`assigned_reviewer_id.is.null,assigned_reviewer_id.eq.${user_id},claimed_at.lt.${cutoff}`)
            .select('id');
          if (got && got.length === 1) { task = cand; break; }
        }
        if (!task) return res.status(200).json({ done: true, message: 'No tasks waiting for review (another reviewer just took the last one — try again).' });

      return res.status(400).json({ error: 'Unknown action' });
    }

    if (req.method === 'POST') {
      const { action, user_id, task_id, note } = req.body;
      const role = await getRole(user_id);
      if (role !== 'qa' && role !== 'admin') return res.status(403).json({ error: 'QA or admin only' });
      if (!task_id) return res.status(400).json({ error: 'task_id required' });

      if (action === 'approve') {
        // status:'completed' also covers approving a REJECTED task (admin overrule):
        // it leaves the annotator's queue and counts as completed again.
        await supabase.from('tasks').update({
          status: 'completed',
          review_status: 'approved',
          reviewer_id: user_id,
          assigned_reviewer_id: null,
          claimed_at: null,
          reviewed_at: new Date().toISOString(),
          review_note: null
        }).eq('id', task_id);
        return res.status(200).json({ ok: true });
      }

      if (action === 'reject') {
        await supabase.from('tasks').update({
          review_status: 'rejected',
          reviewer_id: user_id,
          assigned_reviewer_id: null,
          claimed_at: null,
          reviewed_at: new Date().toISOString(),
          review_note: note || 'Needs correction'
        }).eq('id', task_id);
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: 'Unknown action' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('review error:', err);
    return res.status(500).json({ error: err.message });
  }
}
