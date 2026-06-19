// Returns a resumable upload session URL so the browser can upload one file
// directly to Google Drive without passing the bytes through Vercel.

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { video_filename, file_name, mime_type } = req.body;
    if (!video_filename || !file_name) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    const token = await getAccessToken();
    const rootFolder = process.env.GOOGLE_DRIVE_FOLDER_ID;
    const videoFolderName = video_filename.replace(/\.[^.]+$/, '') || 'video';
    const folderId = await ensureFolder(token, videoFolderName, rootFolder);

    // Start a resumable upload session
    const initRes = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': mime_type || 'application/octet-stream'
        },
        body: JSON.stringify({ name: file_name, parents: [folderId] })
      }
    );

    if (!initRes.ok) {
      const t = await initRes.text();
      throw new Error('Could not start upload: ' + t.slice(0, 200));
    }

    const uploadUrl = initRes.headers.get('location');
    return res.status(200).json({ uploadUrl, folder_name: videoFolderName });
  } catch (err) {
    console.error('drive-upload-url error:', err);
    return res.status(500).json({ error: err.message });
  }
}
