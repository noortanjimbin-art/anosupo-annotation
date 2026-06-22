// One-time admin tool: scans the R2 bucket and registers any videos
// that aren't yet in the database, so they appear in the annotation queue.
import { createClient } from '@supabase/supabase-js';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const r2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY }
});

async function isAdmin(id){
  const { data } = await supabase.from('profiles').select('role').eq('id', id).single();
  return data && data.role === 'admin';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { user_id } = req.body;
    if (!user_id || !(await isAdmin(user_id))) return res.status(403).json({ error: 'Admin only' });

    // List all objects in the bucket (paginated)
    let token = undefined;
    const videoKeys = [];
    do {
      const out = await r2.send(new ListObjectsV2Command({
        Bucket: process.env.R2_BUCKET,
        ContinuationToken: token,
        MaxKeys: 1000
      }));
      (out.Contents || []).forEach(o => {
        const key = o.Key;
        // Only video files in the bucket root (skip the pending/ annotation images)
        if (/\.(mp4|mov|webm|mkv|avi)$/i.test(key) && !key.startsWith('pending/')) {
          videoKeys.push(key);
        }
      });
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);

    if (videoKeys.length === 0) {
      return res.status(200).json({ added: 0, total_in_bucket: 0, message: 'No videos found in bucket' });
    }

    // Find which ones are already registered
    const { data: existing } = await supabase.from('videos').select('storage_path');
    const known = new Set((existing || []).map(v => v.storage_path));

    const toAdd = videoKeys.filter(k => !known.has(k));
    if (toAdd.length === 0) {
      return res.status(200).json({ added: 0, total_in_bucket: videoKeys.length, message: 'All videos already registered' });
    }

    // Insert in batches of 500
    let added = 0;
    for (let i = 0; i < toAdd.length; i += 500) {
      const batch = toAdd.slice(i, i + 500).map(k => ({
        filename: k,
        storage_path: k,
        status: 'unassigned'
      }));
      const { error } = await supabase.from('videos').insert(batch);
      if (error) throw error;
      added += batch.length;
    }

    return res.status(200).json({ added, total_in_bucket: videoKeys.length });
  } catch (err) {
    console.error('register-videos error:', err);
    return res.status(500).json({ error: err.message });
  }
}
