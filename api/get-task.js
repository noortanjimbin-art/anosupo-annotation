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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { annotator_id } = req.query;
  if (!annotator_id) return res.status(400).json({ error: 'annotator_id required' });

  try {
    async function signVideo(storagePath) {
      const command = new GetObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: storagePath
      });
      return await getSignedUrl(r2, command, { expiresIn: 3600 });
    }

    // Existing assigned task?
    const { data: existing } = await supabase
      .from('tasks')
      .select('id, video_id, videos(id, filename, storage_path)')
      .eq('annotator_id', annotator_id)
      .eq('status', 'assigned')
      .limit(1)
      .single();

    if (existing) {
      const url = await signVideo(existing.videos.storage_path);
      return res.status(200).json({
        task_id: existing.id,
        video_id: existing.video_id,
        filename: existing.videos.filename,
        url
      });
    }

    // Next unassigned video
    const { data: video } = await supabase
      .from('videos')
      .select('id, filename, storage_path')
      .eq('status', 'unassigned')
      .limit(1)
      .single();

    if (!video) {
      return res.status(200).json({ done: true, message: 'All videos completed!' });
    }

    const { data: task, error: taskError } = await supabase
      .from('tasks')
      .insert({ video_id: video.id, annotator_id, status: 'assigned' })
      .select()
      .single();

    if (taskError) throw taskError;

    await supabase.from('videos').update({ status: 'assigned' }).eq('id', video.id);

    const url = await signVideo(video.storage_path);

    return res.status(200).json({
      task_id: task.id,
      video_id: video.id,
      filename: video.filename,
      url
    });
  } catch (err) {
    console.error('Get task error:', err);
    return res.status(500).json({ error: err.message });
  }
}
