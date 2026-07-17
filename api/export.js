import { createClient } from '@supabase/supabase-js';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const r2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY }
});

// ---- Google Drive helpers ----
let tokenCache = { token: null, exp: 0 };
async function getAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp) return tokenCache.token;
  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    grant_type: 'refresh_token'
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
  });
  const data = await r.json();
  if (!r.ok) throw new Error('Google auth failed: ' + (data.error_description || data.error));
  tokenCache.token = data.access_token;
  tokenCache.exp = Date.now() + (data.expires_in - 120) * 1000;
  return data.access_token;
}
const folderCache = {};
async function ensureFolder(token, name, parentId) {
  const ck = parentId + '/' + name;
  if (folderCache[ck]) return folderCache[ck];
  const safe = name.replace(/'/g, "\\'");
  const q = `mimeType='application/vnd.google-apps.folder' and trashed=false and name='${safe}' and '${parentId}' in parents`;
  const sr = await fetch('https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q) + '&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true', { headers: { Authorization: 'Bearer ' + token } });
  const sd = await sr.json();
  if (sd.files && sd.files.length) { folderCache[ck] = sd.files[0].id; return sd.files[0].id; }
  const cr = await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] })
  });
  const cd = await cr.json();
  if (!cr.ok) throw new Error('Folder create failed: ' + JSON.stringify(cd));
  folderCache[ck] = cd.id; return cd.id;
}
async function uploadFile(token, parentId, name, mimeType, buffer) {
  const boundary = 'anosupo' + Date.now() + Math.random().toString(36).slice(2);
  const meta = JSON.stringify({ name, parents: [parentId] });
  const pre = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`;
  const post = `\r\n--${boundary}--\r\n`;
  const body = Buffer.concat([Buffer.from(pre, 'utf8'), buffer, Buffer.from(post, 'utf8')]);
  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': `multipart/related; boundary=${boundary}` }, body
  });
  const d = await r.json();
  if (!r.ok) throw new Error('Drive upload failed: ' + JSON.stringify(d));
  return d.id;
}
async function r2GetBuffer(key) {
  const obj = await r2.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }));
  const chunks = [];
  for await (const c of obj.Body) chunks.push(c);
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user_id = req.method === 'GET' ? req.query.user_id : req.body.user_id;

  try {
    const { data: prof } = await supabase.from('profiles').select('role').eq('id', user_id).single();
    if (!prof || prof.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

    // GET = list completed tasks with export state (for the Export page)
    if (req.method === 'GET') {
      // Page through ALL completed tasks (Supabase caps each query at 1000 rows)
      const rows = [];
      let from = 0; const step = 1000;
      while (true) {
        const { data: batch } = await supabase
          .from('tasks')
          .select('id, exported, completed_at, review_status, videos(filename)')
          .eq('status', 'completed')
          .order('completed_at', { ascending: false })
          .range(from, from + step - 1);
        if (!batch || batch.length === 0) break;
        for (const t of batch) {
          rows.push({
            id: t.id,
            filename: t.videos?.filename || 'unknown',
            exported: !!t.exported,
            review_status: t.review_status || 'none',
            completed_at: t.completed_at
          });
        }
        if (batch.length < step) break;
        from += step;
      }
      const newCount = rows.filter(r => !r.exported).length;
      const approvedCount = rows.filter(r => r.review_status === 'approved').length;
      // Only send the first 1000 rows to the browser table (keep payload sane), but
      // the counts above reflect ALL completed tasks.
      return res.status(200).json({ tasks: rows.slice(0, 1000), total: rows.length, new: newCount, approved: approvedCount, table_truncated: rows.length > 1000 });
    }

    // POST = run export. mode: 'new' | 'all' | 'selected'; approved_only narrows to approved tasks
    const mode = req.body.mode || 'new';
    const approvedOnly = !!req.body.approved_only;
    const selectedIds = req.body.task_ids || [];
    const download = !!req.body.download; // true = return combined JSON to browser (no Drive)

    // ===== DOWNLOAD MODE: return one combined JSON of the matching tasks, straight to the browser =====
    // No Google Drive, no images. Pages through all matching tasks (past the 1000 cap).
    if (download) {
      const collected = [];
      let from = 0; const step = 1000;
      while (true) {
        let q = supabase.from('tasks').select('id, video_id, review_status, videos(filename)').eq('status', 'completed');
        if (approvedOnly) q = q.eq('review_status', 'approved');
        if (mode === 'new') q = q.eq('exported', false);
        else if (mode === 'selected') q = q.in('id', selectedIds.length ? selectedIds : ['00000000-0000-0000-0000-000000000000']);
        q = q.order('completed_at', { ascending: false }).range(from, from + step - 1);
        const { data: batch } = await q;
        if (!batch || batch.length === 0) break;
        // Fetch annotations for this batch
        const ids = batch.map(t => t.id);
        const { data: anns } = await supabase.from('annotations').select('task_id, video_filename, annotator_id, frames').in('task_id', ids);
        const amap = {}; (anns || []).forEach(a => { amap[a.task_id] = a; });
        for (const t of batch) {
          const a = amap[t.id];
          if (!a) continue;
          collected.push({
            video: a.video_filename || (t.videos && t.videos.filename) || 'video',
            review_status: t.review_status || 'none',
            annotator_id: a.annotator_id || null,
            frames: (a.frames || []).map(f => ({ index: f.index, timecode: f.timecode, description: f.description || '', box: f.box || null }))
          });
        }
        if (batch.length < step) break;
        from += step;
      }
      return res.status(200).json({ download: true, count: collected.length, annotations: collected });
    }

    let taskQuery = supabase
      .from('tasks').select('id, exported, videos(filename)')
      .eq('status', 'completed');

    if (approvedOnly) taskQuery = taskQuery.eq('review_status', 'approved');
    if (mode === 'new') taskQuery = taskQuery.eq('exported', false);
    else if (mode === 'selected') taskQuery = taskQuery.in('id', selectedIds.length ? selectedIds : ['00000000-0000-0000-0000-000000000000']);
    // mode 'all' = no extra filter

    // Page through all matching tasks (past the 1000 cap) for Drive export
    let allTasks = [];
    {
      let from = 0; const step = 1000;
      while (true) {
        const { data: batch } = await taskQuery.range(from, from + step - 1);
        if (!batch || batch.length === 0) break;
        allTasks = allTasks.concat(batch);
        if (batch.length < step) break;
        from += step;
      }
    }
    const tasks = allTasks;
    if (!tasks || tasks.length === 0) return res.status(200).json({ exported: 0, message: 'Nothing to export' });

    const token = await getAccessToken();
    const rootFolder = process.env.GOOGLE_DRIVE_FOLDER_ID;
    let exportedCount = 0;
    const errors = [];
    const debug = [];

    for (const task of tasks) {
      try {
        const { data: ann } = await supabase
          .from('annotations').select('frames, video_filename').eq('task_id', task.id).single();
        if (!ann) { errors.push(task.id + ': no annotation row'); continue; }

        const videoName = ann.video_filename || (task.videos && task.videos.filename) || 'video';
        const folderName = videoName.replace(/\.[^.]+$/, '') || 'video';
        const folderId = await ensureFolder(token, folderName, rootFolder);

        // JSON only — images are no longer exported.
        const savedFrames = (ann.frames || []).map(f => ({ index: f.index, timecode: f.timecode, description: f.description || '', box: f.box || null }));

        const jsonObj = { video: videoName, submitted_at: new Date().toISOString(), frames: savedFrames };
        await uploadFile(token, folderId, 'annotations.json', 'application/json', Buffer.from(JSON.stringify(jsonObj, null, 2), 'utf8'));

        debug.push({ task: task.id, folder: folderName, frames: (ann.frames||[]).length });

        await supabase.from('annotations').update({ exported: true, exported_at: new Date().toISOString() }).eq('task_id', task.id);
        await supabase.from('tasks').update({ exported: true }).eq('id', task.id);
        exportedCount++;
      } catch (e) {
        errors.push((task.videos?.filename || task.id) + ': ' + e.message);
      }
    }

    return res.status(200).json({ exported: exportedCount, errors, debug });
  } catch (err) {
    console.error('export error:', err);
    return res.status(500).json({ error: err.message });
  }
}
