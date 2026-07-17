import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

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

// Create the file, or UPDATE it in place if a file with this name already
// exists in the folder. Drive allows duplicate filenames in one folder, so a
// plain POST on re-export would silently stack a 2nd annotations.json.
async function upsertFile(token, parentId, name, mimeType, buffer) {
  const safe = name.replace(/'/g, "\\'");
  const q = `name='${safe}' and '${parentId}' in parents and trashed=false`;
  const sr = await fetch(
    'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q) +
    '&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true',
    { headers: { Authorization: 'Bearer ' + token } }
  );
  const sd = await sr.json();
  if (!sr.ok) throw new Error('Drive lookup failed: ' + JSON.stringify(sd));
  const existingId = sd.files && sd.files.length ? sd.files[0].id : null;

  if (existingId) {
    // Overwrite contents of the existing file (keeps the same file ID/link).
    const r = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files/' + existingId +
      '?uploadType=media&supportsAllDrives=true',
      { method: 'PATCH', headers: { Authorization: 'Bearer ' + token, 'Content-Type': mimeType }, body: buffer }
    );
    const d = await r.json();
    if (!r.ok) throw new Error('Drive update failed: ' + JSON.stringify(d));
    return d.id;
  }

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

// ---- Query helpers ----

// FIX #3: .in() is sent as a URL query string. A few thousand UUIDs = a ~75KB URL,
// which PostgREST rejects with 414. Never pass a big array to .in() in one go.
const IN_CHUNK = 100;
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// FIX #2: every query checks `error` and THROWS. A failed query must never be
// mistaken for "no more rows" -- that is what silently truncated the exports.
// FIX #4 (builder reuse): buildQuery() is a factory, so each page gets a fresh builder.
async function pageAll(buildQuery) {
  const rows = [];
  const step = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await buildQuery().range(from, from + step - 1);
    if (error) throw new Error('Supabase query failed at offset ' + from + ': ' + error.message);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < step) break;
    from += step;
  }
  return rows;
}

function matchingTasksQuery({ mode, approvedOnly, selectedIds }) {
  return () => {
    let q = supabase.from('tasks').select('id, exported, review_status, completed_at, videos(filename)')
      .eq('status', 'completed');
    if (approvedOnly) q = q.eq('review_status', 'approved');
    if (mode === 'new') q = q.eq('exported', false);
    // 'id' tiebreaker: completed_at alone is not unique, and Postgres gives no
    // stable order for ties across separate LIMIT/OFFSET queries -> rows could
    // be skipped or duplicated at page boundaries.
    return q.order('completed_at', { ascending: false }).order('id', { ascending: true });
  };
}

// Resolve the full set of task IDs the user asked for.
async function resolveTaskIds({ mode, approvedOnly, selectedIds }) {
  if (mode === 'selected') {
    if (!selectedIds.length) return [];
    // Chunked so the URL stays short, and so approved_only still applies.
    const ids = [];
    for (const part of chunk(selectedIds, IN_CHUNK)) {
      let q = supabase.from('tasks').select('id').eq('status', 'completed').in('id', part);
      if (approvedOnly) q = q.eq('review_status', 'approved');
      const { data, error } = await q;
      if (error) throw new Error('Failed resolving selected tasks: ' + error.message);
      ids.push(...(data || []).map(t => t.id));
    }
    return ids;
  }
  const rows = await pageAll(matchingTasksQuery({ mode, approvedOnly }));
  return rows.map(t => t.id);
}

// Fetch annotations for a batch of task ids, chunking the .in() call.
async function fetchAnnotations(ids) {
  const map = {};
  for (const part of chunk(ids, IN_CHUNK)) {
    const { data, error } = await supabase
      .from('annotations')
      .select('task_id, video_filename, annotator_id, frames')
      .in('task_id', part);
    if (error) throw new Error('Failed fetching annotations: ' + error.message);
    (data || []).forEach(a => { map[a.task_id] = a; });
  }
  return map;
}

async function fetchTaskMeta(ids) {
  const map = {};
  for (const part of chunk(ids, IN_CHUNK)) {
    const { data, error } = await supabase
      .from('tasks').select('id, review_status, videos(filename)').in('id', part);
    if (error) throw new Error('Failed fetching task meta: ' + error.message);
    (data || []).forEach(t => { map[t.id] = t; });
  }
  return map;
}

const normFrames = f => ({ index: f.index, timecode: f.timecode, description: f.description || '', box: f.box || null });

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user_id = req.method === 'GET' ? req.query.user_id : req.body.user_id;

  try {
    const { data: prof, error: profErr } = await supabase.from('profiles').select('role').eq('id', user_id).single();
    if (profErr) return res.status(500).json({ error: 'Auth lookup failed: ' + profErr.message });
    if (!prof || prof.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

    // ===== GET: list completed tasks + counts for the Export page =====
    if (req.method === 'GET') {
      const rows = (await pageAll(matchingTasksQuery({ mode: 'all' }))).map(t => ({
        id: t.id,
        filename: t.videos?.filename || 'unknown',
        exported: !!t.exported,
        review_status: t.review_status || 'none',
        completed_at: t.completed_at
      }));
      return res.status(200).json({
        tasks: rows.slice(0, 1000),
        total: rows.length,
        new: rows.filter(r => !r.exported).length,
        approved: rows.filter(r => r.review_status === 'approved').length,
        table_truncated: rows.length > 1000
      });
    }

    const action = req.body.action || (req.body.download ? 'download' : 'drive');
    const mode = req.body.mode || 'new';
    const approvedOnly = !!req.body.approved_only;
    const selectedIds = req.body.task_ids || [];

    // ===== PLAN: return the list of task IDs to process. The CLIENT then feeds
    // these back in small batches. This is FIX #1 -- no single request has to do
    // thousands of network round-trips inside a 10s (or even 300s) budget.
    if (action === 'plan') {
      const ids = await resolveTaskIds({ mode, approvedOnly, selectedIds });
      return res.status(200).json({ ids, count: ids.length });
    }

    // ===== BATCH DOWNLOAD: annotations for one small batch of ids.
    // FIX #5: the client concatenates batches, so we never approach Vercel's
    // 4.5MB response cap on a single response.
    if (action === 'download') {
      const ids = selectedIds;
      if (!ids.length) return res.status(200).json({ count: 0, annotations: [] });
      if (ids.length > 500) return res.status(400).json({ error: 'Batch too large; send <= 500 ids per request' });

      const amap = await fetchAnnotations(ids);
      const tmap = await fetchTaskMeta(ids);
      const collected = [];
      const missing = [];
      for (const id of ids) {
        const a = amap[id];
        if (!a) { missing.push(id); continue; }
        const t = tmap[id];
        collected.push({
          task_id: id,
          video: a.video_filename || t?.videos?.filename || 'video',
          review_status: t?.review_status || 'none',
          annotator_id: a.annotator_id || null,
          frames: (a.frames || []).map(normFrames)
        });
      }
      return res.status(200).json({ count: collected.length, annotations: collected, missing });
    }

    // ===== BATCH DRIVE EXPORT: upload one small batch of ids to Drive. =====
    const ids = selectedIds;
    if (!ids.length) return res.status(200).json({ exported: 0, message: 'Nothing to export' });
    if (ids.length > 50) return res.status(400).json({ error: 'Batch too large; send <= 50 ids per request' });

    const amap = await fetchAnnotations(ids);
    const tmap = await fetchTaskMeta(ids);
    const token = await getAccessToken();
    const rootFolder = process.env.GOOGLE_DRIVE_FOLDER_ID;

    let exportedCount = 0;
    const errors = [];

    for (const id of ids) {
      try {
        const ann = amap[id];
        if (!ann) { errors.push(id + ': no annotation row'); continue; }
        const t = tmap[id];
        const videoName = ann.video_filename || t?.videos?.filename || 'video';
        const folderName = videoName.replace(/\.[^.]+$/, '') || 'video';
        const folderId = await ensureFolder(token, folderName, rootFolder);

        const jsonObj = {
          video: videoName,
          submitted_at: new Date().toISOString(),
          frames: (ann.frames || []).map(normFrames)
        };
        await upsertFile(token, folderId, 'annotations.json', 'application/json', Buffer.from(JSON.stringify(jsonObj, null, 2), 'utf8'));

        // Mark exported only AFTER the upload actually succeeded.
        const { error: e1 } = await supabase.from('annotations').update({ exported: true, exported_at: new Date().toISOString() }).eq('task_id', id);
        if (e1) throw new Error('marking annotation exported: ' + e1.message);
        const { error: e2 } = await supabase.from('tasks').update({ exported: true }).eq('id', id);
        if (e2) throw new Error('marking task exported: ' + e2.message);
        exportedCount++;
      } catch (e) {
        errors.push((tmap[id]?.videos?.filename || id) + ': ' + e.message);
      }
    }

    return res.status(200).json({ exported: exportedCount, errors });
  } catch (err) {
    console.error('export error:', err);
    return res.status(500).json({ error: err.message });
  }
}
