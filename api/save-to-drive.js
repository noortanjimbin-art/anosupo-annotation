import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

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
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const data = await r.json();
  if (!r.ok) throw new Error('Google auth failed: ' + (data.error_description || data.error));
  tokenCache.token = data.access_token;
  tokenCache.exp = Date.now() + (data.expires_in - 120) * 1000;
  return data.access_token;
}

const folderCache = {};

async function ensureFolder(token, name, parentId) {
  const cacheKey = parentId + '/' + name;
  if (folderCache[cacheKey]) return folderCache[cacheKey];
  const safe = name.replace(/'/g, "\\'");
  const q = `mimeType='application/vnd.google-apps.folder' and trashed=false and name='${safe}' and '${parentId}' in parents`;
  const searchUrl = 'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q) + '&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true';
  const sr = await fetch(searchUrl, { headers: { Authorization: 'Bearer ' + token } });
  const sd = await sr.json();
  if (sd.files && sd.files.length >= 1) {
    folderCache[cacheKey] = sd.files[0].id;
    return sd.files[0].id;
  }
  const cr = await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] })
  });
  const cd = await cr.json();
  if (!cr.ok) throw new Error('Folder create failed: ' + JSON.stringify(cd));
  folderCache[cacheKey] = cd.id;
  return cd.id;
}

async function uploadFile(token, parentId, name, mimeType, base64Data) {
  const boundary = 'anosupo' + Date.now();
  const meta = JSON.stringify({ name, parents: [parentId] });
  const buffer = Buffer.from(base64Data, 'base64');
  const pre = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`;
  const post = `\r\n--${boundary}--\r\n`;
  const body = Buffer.concat([Buffer.from(pre, 'utf8'), buffer, Buffer.from(post, 'utf8')]);
  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body
  });
  const d = await r.json();
  if (!r.ok) throw new Error('Upload failed: ' + JSON.stringify(d));
  return d.id;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { task_id, annotator_id, video_filename, frames, summary_base64 } = req.body;
    if (!video_filename || !frames || !annotator_id) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const token = await getAccessToken();
    const rootFolder = process.env.GOOGLE_DRIVE_FOLDER_ID;
    const videoFolderName = video_filename.replace(/\.[^.]+$/, '') || 'video';
    const videoFolder = await ensureFolder(token, videoFolderName, rootFolder);

    // Upload the combined summary image first (00_summary.png) if provided
    if (summary_base64) {
      const sb = summary_base64.replace(/^data:image\/\w+;base64,/, '');
      await uploadFile(token, videoFolder, '00_summary.png', 'image/png', sb);
    }

    const savedFrames = [];
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      const imgName = String(i + 1).padStart(2, '0') + '_' + (frame.timecode || '').replace(/[:.]/g, '-') + '.png';
      if (frame.image_base64) {
        const base64 = frame.image_base64.replace(/^data:image\/\w+;base64,/, '');
        await uploadFile(token, videoFolder, imgName, 'image/png', base64);
      }
      savedFrames.push({
        index: i + 1,
        timecode: frame.timecode,
        description: frame.description || '',
        box: frame.box || null,
        image: imgName
      });
    }

    // Build the JSON for this video and upload it into the same folder
    const jsonObj = {
      video: video_filename,
      annotator_id,
      submitted_at: new Date().toISOString(),
      frames: savedFrames
    };
    const jsonBase64 = Buffer.from(JSON.stringify(jsonObj, null, 2), 'utf8').toString('base64');
    await uploadFile(token, videoFolder, 'annotations.json', 'application/json', jsonBase64);

    // Also record in Supabase for tracking + the combined export
    await supabase.from('annotations').insert({
      task_id: task_id || null,
      video_filename,
      annotator_id,
      frames: savedFrames
    });

    if (task_id) {
      await supabase.from('tasks')
        .update({ status: 'completed', completed_at: new Date().toISOString() })
        .eq('id', task_id);
    }

    return res.status(200).json({ ok: true, frames_saved: savedFrames.length });
  } catch (err) {
    console.error('Save to Drive error:', err);
    return res.status(500).json({ error: err.message });
  }
}
