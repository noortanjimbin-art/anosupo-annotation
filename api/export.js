import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { user_id } = req.query;

  try {
    // Only admin/qa can export
    const { data: prof } = await supabase.from('profiles').select('role').eq('id', user_id).single();
    if (!prof || !['admin','qa'].includes(prof.role)) {
      return res.status(403).json({ error: 'Admin or QA only' });
    }

    // Get qa_required setting
    const { data: setting } = await supabase.from('settings').select('value').eq('key','qa_required').single();
    const qaRequired = setting && setting.value === 'true';

    // If QA required: only approved tasks. If not: all completed tasks.
    let taskQuery = supabase.from('tasks').select('id, video_id, review_status, status, videos(filename)');
    if (qaRequired) {
      taskQuery = taskQuery.eq('review_status', 'approved');
    } else {
      taskQuery = taskQuery.eq('status', 'completed');
    }
    const { data: tasks } = await taskQuery;
    const taskIds = (tasks || []).map(t => t.id);

    let annotations = [];
    if (taskIds.length) {
      const { data: anns } = await supabase
        .from('annotations')
        .select('video_filename, frames, submitted_at, task_id')
        .in('task_id', taskIds);
      annotations = anns || [];
    }

    const exportData = annotations.map(a => ({
      video: a.video_filename,
      submitted_at: a.submitted_at,
      frames: a.frames
    }));

    return res.status(200).json({
      qa_required: qaRequired,
      count: exportData.length,
      annotations: exportData
    });
  } catch (err) {
    console.error('export error:', err);
    return res.status(500).json({ error: err.message });
  }
}
