import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export const config = { api: { bodyParser: { sizeLimit: '20mb' } } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { task_id, annotator_id, video_filename, frames } = req.body;

    if (!video_filename || !frames || !annotator_id) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Upload each frame image to Supabase Storage
    const savedFrames = [];
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      const imagePath = `${video_filename}/${annotator_id}/frame_${i + 1}.png`;

      if (frame.image_base64) {
        const base64Data = frame.image_base64.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        await supabase.storage.from('frames').upload(imagePath, buffer, {
          contentType: 'image/png',
          upsert: true
        });
      }

      savedFrames.push({
        index: i + 1,
        timecode: frame.timecode,
        description: frame.description || '',
        box: frame.box || null,
        image_path: imagePath
      });
    }

    // Save annotation JSON to database
    const { error } = await supabase.from('annotations').insert({
      task_id: task_id || null,
      video_filename,
      annotator_id,
      frames: savedFrames
    });

    if (error) throw error;

    // Mark task as completed if task_id provided
    if (task_id) {
      await supabase.from('tasks')
        .update({ status: 'completed', completed_at: new Date().toISOString() })
        .eq('id', task_id);
    }

    return res.status(200).json({ ok: true, frames_saved: savedFrames.length });
  } catch (err) {
    console.error('Submit error:', err);
    return res.status(500).json({ error: err.message });
  }
}
