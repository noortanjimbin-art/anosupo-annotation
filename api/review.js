// QA review actions, all in one function to respect the 12-function limit.
// GET  /api/review?action=next&user_id=...   -> next task in the review pool
// GET  /api/review?action=count&user_id=...  -> how many tasks await review
// POST /api/review {action:'approve'|'reject', user_id, task_id, note}
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

      // Count of tasks waiting for review (completed, not yet approved/rejected-pending)
      if (action === 'count') {
        const { count } = await supabase
          .from('tasks').select('*', { count: 'exact', head: true })
          .eq('status', 'completed')
          .in('review_status', ['none', 'in_review', 'revised'])
          .or(`assigned_reviewer_id.is.null,assigned_reviewer_id.eq.${user_id}`);
        return res.status(200).json({ pending: count || 0 });
      }

      // Next task in the review pool
      if (action === 'next') {
        const { data: task } = await supabase
          .from('tasks')
          .select('id, video_id, annotator_id, review_status, videos(filename, storage_path), profiles!tasks_annotator_id_fkey(email, full_name)')
          .eq('status', 'completed')
          .in('review_status', ['none', 'in_review', 'revised'])
          .or(`assigned_reviewer_id.is.null,assigned_reviewer_id.eq.${user_id}`)
          .order('assigned_reviewer_id', { ascending: true, nullsFirst: false })
          .order('completed_at', { ascending: true })
          .limit(1)
          .single();

        if (!task) return res.status(200).json({ done: true, message: 'No tasks waiting for review.' });

        // Load the annotation with presigned image URLs so the QA can see the work
        const { data: ann } = await supabase
          .from('annotations').select('frames').eq('task_id', task.id).single();
        let frames = ann?.frames || [];
        frames = await Promise.all(frames.map(async f => {
          let img_url = null;
          if (f.r2_key) {
            try { img_url = await getSignedUrl(r2, new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: f.r2_key }), { expiresIn: 3600 }); } catch(e){}
          }
          return { ...f, img_url };
        }));

        const videoUrl = await getSignedUrl(r2, new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: task.videos.storage_path }), { expiresIn: 3600 });

        return res.status(200).json({
          task_id: task.id,
          filename: task.videos.filename,
          video_url: videoUrl,
          annotator: task.profiles ? (task.profiles.full_name || task.profiles.email) : 'Unknown',
          frames
        });
      }

      return res.status(400).json({ error: 'Unknown action' });
    }

    if (req.method === 'POST') {
      const { action, user_id, task_id, note } = req.body;
      const role = await getRole(user_id);
      if (role !== 'qa' && role !== 'admin') return res.status(403).json({ error: 'QA or admin only' });
      if (!task_id) return res.status(400).json({ error: 'task_id required' });

      if (action === 'approve') {
        await supabase.from('tasks').update({
          review_status: 'approved',
          reviewer_id: user_id,
          assigned_reviewer_id: null,
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
