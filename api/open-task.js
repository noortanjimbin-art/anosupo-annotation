import { createClient } from '@supabase/supabase-js';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const r2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { task_id } = req.query;
  if (!task_id) return res.status(400).json({ error: 'task_id required' });

  try {
    const { data: task } = await supabase
      .from('tasks')
      .select('id, status, review_status, review_note, video_id, annotator_id, videos(filename, storage_path)')
      .eq('id', task_id)
      .single();

    if (!task) return res.status(404).json({ error: 'Task not found' });

    const command = new GetObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: task.videos.storage_path
    });
    const url = await getSignedUrl(r2, command, { expiresIn: 3600 });

    // Load any existing annotation for this task (for review or re-edit)
    const { data: ann } = await supabase
      .from('annotations')
      .select('frames')
      .eq('task_id', task_id)
      .order('submitted_at', { ascending: false })
      .limit(1)
      .single();

    return res.status(200).json({
      task_id: task.id,
      filename: task.videos.filename,
      url,
      status: task.status,
      review_status: task.review_status,
      review_note: task.review_note,
      existing_frames: ann?.frames || null
    });
  } catch (err) {
    console.error('open-task error:', err);
    return res.status(500).json({ error: err.message });
  }
}
