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
    const { task_id, annotator_id, video_filename, frames } = req.body;
    if (!video_filename || !annotator_id) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    await supabase.from('annotations').insert({
      task_id: task_id || null,
      video_filename,
      annotator_id,
      frames: frames || []
    });

    if (task_id) {
      await supabase.from('tasks')
        .update({ status: 'completed', completed_at: new Date().toISOString() })
        .eq('id', task_id);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Record error:', err);
    return res.status(500).json({ error: err.message });
  }
}
