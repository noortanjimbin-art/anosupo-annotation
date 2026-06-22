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

    // Upsert: one annotation row per task. Editing updates instead of duplicating.
    // frames each contain: index, timecode, description, box, r2_key (pending image path)
    await supabase.from('annotations').upsert({
      task_id,
      video_filename,
      annotator_id,
      frames: frames || [],
      submitted_at: new Date().toISOString(),
      exported: false
    }, { onConflict: 'task_id' });

    // Mark the task completed but NOT exported yet
    await supabase.from('tasks')
      .update({ status: 'completed', completed_at: new Date().toISOString(), exported: false })
      .eq('id', task_id);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Record error:', err);
    return res.status(500).json({ error: err.message });
  }
}
