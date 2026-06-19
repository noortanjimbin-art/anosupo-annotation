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

  const { user_id, role } = req.query;

  try {
    const { count: totalVideos } = await supabase
      .from('videos').select('*', { count: 'exact', head: true });
    const { count: unassigned } = await supabase
      .from('videos').select('*', { count: 'exact', head: true }).eq('status', 'unassigned');
    const { count: assigned } = await supabase
      .from('videos').select('*', { count: 'exact', head: true }).eq('status', 'assigned');
    const { count: completed } = await supabase
      .from('tasks').select('*', { count: 'exact', head: true }).eq('status', 'completed');

    const total = totalVideos || 0;
    const done = completed || 0;
    const progress = total > 0 ? Math.round((done / total) * 100) : 0;

    // Per-worker breakdown (admin sees all; annotator sees self only)
    let taskQuery = supabase
      .from('tasks')
      .select('annotator_id, status, profiles!tasks_annotator_id_fkey(email, full_name, role)');
    if (role === 'annotator') {
      taskQuery = taskQuery.eq('annotator_id', user_id);
    }
    const { data: tasks } = await taskQuery;

    const byWorker = {};
    (tasks || []).forEach(t => {
      const id = t.annotator_id;
      if (!id) return;
      if (!byWorker[id]) {
        byWorker[id] = {
          name: t.profiles?.full_name || t.profiles?.email || 'unknown',
          role: t.profiles?.role || 'annotator',
          assigned: 0, completed: 0, total: 0
        };
      }
      byWorker[id].total++;
      if (t.status === 'completed') byWorker[id].completed++;
      else byWorker[id].assigned++;
    });
    const perWorker = Object.values(byWorker);

    return res.status(200).json({
      totals: { total, unassigned: unassigned || 0, assigned: assigned || 0, completed: done, progress },
      perWorker
    });
  } catch (err) {
    console.error('dashboard error:', err);
    return res.status(500).json({ error: err.message });
  }
}
