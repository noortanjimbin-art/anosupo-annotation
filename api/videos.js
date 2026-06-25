import { createClient } from '@supabase/supabase-js';
import { S3Client, DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
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

async function isAdmin(id){
  const { data } = await supabase.from('profiles').select('role').eq('id', id).single();
  return data && data.role === 'admin';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      const { user_id, search, page } = req.query;
      if (!user_id || !(await isAdmin(user_id))) return res.status(403).json({ error: 'Admin only' });

      const pageNum = Math.max(0, parseInt(page) || 0);
      const pageSize = 100;
      const from = pageNum * pageSize;
      const to = from + pageSize - 1;

      let listQuery = supabase
        .from('videos')
        .select('id, filename, status, created_at')
        .order('created_at', { ascending: false });

      if (search && search.trim()) {
        listQuery = listQuery.ilike('filename', '%' + search.trim() + '%');
      }
      listQuery = listQuery.range(from, to);

      const { data } = await listQuery;
      const { count: total } = await supabase.from('videos').select('*', { count:'exact', head:true });
      const { count: unassigned } = await supabase.from('videos').select('*', { count:'exact', head:true }).eq('status','unassigned');

      // Count matching the search (for pagination display)
      let matchCount = total;
      if (search && search.trim()) {
        const { count: mc } = await supabase.from('videos').select('*', { count:'exact', head:true }).ilike('filename', '%' + search.trim() + '%');
        matchCount = mc;
      }

      return res.status(200).json({
        videos: data || [],
        total: total||0,
        unassigned: unassigned||0,
        match_count: matchCount||0,
        page: pageNum,
        page_size: pageSize
      });
    }

    if (req.method === 'POST') {
      const { user_id, action, video_id, filename, content_type } = req.body;
      if (!user_id || !(await isAdmin(user_id))) return res.status(403).json({ error: 'Admin only' });

      // Get a presigned PUT url so the browser can upload directly to R2
      if (action === 'get-url') {
        if (!filename) return res.status(400).json({ error: 'filename required' });
        const command = new PutObjectCommand({
          Bucket: process.env.R2_BUCKET,
          Key: filename
        });
        const uploadUrl = await getSignedUrl(r2, command, { expiresIn: 3600 });
        return res.status(200).json({ uploadUrl, storage_path: filename });
      }

      // Register the uploaded video into the queue
      if (action === 'register') {
        if (!filename) return res.status(400).json({ error: 'filename required' });
        const { error } = await supabase.from('videos').insert({
          filename, storage_path: filename, status: 'unassigned'
        });
        if (error) throw error;
        return res.status(200).json({ ok: true });
      }

      // Delete a video everywhere
      if (action === 'delete') {
        const { data: vid } = await supabase.from('videos').select('storage_path').eq('id', video_id).single();
        if (vid) {
          const { data: tasks } = await supabase.from('tasks').select('id').eq('video_id', video_id);
          const taskIds = (tasks||[]).map(t=>t.id);
          if (taskIds.length) {
            await supabase.from('annotations').delete().in('task_id', taskIds);
            await supabase.from('tasks').delete().eq('video_id', video_id);
          }
          await supabase.from('videos').delete().eq('id', video_id);
          try {
            await r2.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: vid.storage_path }));
          } catch(e){ console.error('R2 delete failed:', e.message); }
        }
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: 'Unknown action' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('videos error:', err);
    return res.status(500).json({ error: err.message });
  }
}
