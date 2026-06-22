// Uploads ONE annotation image to R2 under pending/<task_id>/<filename>.
// Returns a presigned PUT url so the browser uploads directly to R2 (no size limit).
import { createClient } from '@supabase/supabase-js';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const r2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY }
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { user_id, task_id, file_name } = req.body;
    if (!user_id || !task_id || !file_name) return res.status(400).json({ error: 'Missing fields' });

    // Verify the requester owns this task or is admin
    const { data: prof } = await supabase.from('profiles').select('role').eq('id', user_id).single();
    const { data: task } = await supabase.from('tasks').select('annotator_id').eq('id', task_id).single();
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const isOwner = task.annotator_id === user_id;
    const isAdmin = prof && prof.role === 'admin';
    if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Not allowed' });

    const key = 'pending/' + task_id + '/' + file_name;
    const command = new PutObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key });
    const uploadUrl = await getSignedUrl(r2, command, { expiresIn: 3600 });
    return res.status(200).json({ uploadUrl, key });
  } catch (err) {
    console.error('save-one error:', err);
    return res.status(500).json({ error: err.message });
  }
}
