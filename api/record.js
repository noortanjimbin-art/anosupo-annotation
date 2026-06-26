import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { task_id, annotator_id, video_filename, frames } = req.body;
    if (!task_id || !video_filename || !annotator_id) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Preserve the original annotator if this task already has one
    const { data: existingTask } = await supabase
      .from('tasks').select('annotator_id').eq('id', task_id).single();
    const finalAnnotator = (existingTask && existingTask.annotator_id) || annotator_id;

    // Upsert: one annotation row per task. Editing updates instead of duplicating.
    await supabase.from('annotations').upsert({
      task_id,
      video_filename,
      annotator_id: finalAnnotator,
      frames: frames || [],
      submitted_at: new Date().toISOString(),
      exported: false
    }, { onConflict: 'task_id' });

    // Check if this task was rejected — if so, saving makes it 'revised' (back to review pool)
    const { data: curTask } = await supabase
      .from('tasks').select('review_status').eq('id', task_id).single();
    const wasRejected = curTask && curTask.review_status === 'rejected';

    // Mark completed, un-exported. If it was rejected, set review_status to 'revised'
    // (clears the rejection flag for the annotator, sends it back for QA re-review).
    const taskUpdate = {
      status: 'completed',
      completed_at: new Date().toISOString(),
      exported: false
    };
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
