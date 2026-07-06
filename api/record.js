import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { task_id, annotator_id, video_filename, frames, saver_id } = req.body;
    if (!task_id || !video_filename || !annotator_id) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Determine who is saving. If an ADMIN is editing (not the annotator/QA doing the actual
    // work), we DON'T bump the annotator's completed_at date — per requirement, admin edits
    // shouldn't change the recorded save dates. saver_id is the person clicking save.
    let saverIsAdmin = false;
    if (saver_id) {
      const { data: sp } = await supabase.from('profiles').select('role').eq('id', saver_id).maybeSingle();
      saverIsAdmin = sp && sp.role === 'admin';
    }

    // Preserve the original annotator if this task already has one
    const { data: existingTask } = await supabase
      .from('tasks').select('annotator_id').eq('id', task_id).single();
    const finalAnnotator = (existingTask && existingTask.annotator_id) || annotator_id;

    // Upsert: one annotation row per task. Editing updates instead of duplicating.
    // submitted_at only bumps for real annotator/QA saves, not admin edits.
    const annUpsert = {
      task_id,
      video_filename,
      annotator_id: finalAnnotator,
      frames: frames || [],
      exported: false
    };
    if (!saverIsAdmin) annUpsert.submitted_at = new Date().toISOString();
    await supabase.from('annotations').upsert(annUpsert, { onConflict: 'task_id' });

    // Check if this task was rejected — if so, saving makes it 'revised' (back to review pool)
    const { data: curTask } = await supabase
      .from('tasks').select('review_status').eq('id', task_id).single();
    const wasRejected = curTask && curTask.review_status === 'rejected';

    // Mark completed, un-exported. completed_at (the annotator's save date) only bumps for
    // real annotator/QA saves — an admin editing does NOT change it.
    const taskUpdate = {
      status: 'completed',
      exported: false
    };
    if (!saverIsAdmin) taskUpdate.completed_at = new Date().toISOString();
    if (wasRejected) {
      taskUpdate.review_status = 'revised';
      taskUpdate.review_note = null;
    }
    await supabase.from('tasks').update(taskUpdate).eq('id', task_id);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Record error:', err);
    return res.status(500).json({ error: err.message });
  }
}
