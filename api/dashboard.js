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

    // Review-state tallies (current snapshot).
    const { count: approved } = await supabase
      .from('tasks').select('*', { count: 'exact', head: true })
      .eq('status', 'completed').eq('review_status', 'approved');
    const { count: rejected } = await supabase
      .from('tasks').select('*', { count: 'exact', head: true })
      .eq('review_status', 'rejected');
    const { count: revised } = await supabase
      .from('tasks').select('*', { count: 'exact', head: true })
      .eq('status', 'completed').eq('review_status', 'revised');
    const { count: awaiting } = await supabase
      .from('tasks').select('*', { count: 'exact', head: true })
      .eq('status', 'completed').in('review_status', ['none', 'in_review']);

    const total = totalVideos || 0;
    const done = completed || 0;
    const progress = total > 0 ? Math.round((done / total) * 100) : 0;

    // Per-worker breakdown is an ADMIN view only. Annotators/QAs don't need it.
    let perWorker = [];
    if (role === 'admin') {
      // Aggregate on the database (fast) instead of transferring every task row
      const { data: annCounts } = await supabase.rpc('annotation_counts');
      if (annCounts && annCounts.length) {
        // Get member names/roles for the ids present
        const ids = annCounts.map(r => r.annotator_id);
        const { data: profs } = await supabase
          .from('profiles').select('id, email, full_name, role').in('id', ids);
        const pmap = {};
        (profs || []).forEach(p => { pmap[p.id] = p; });
        perWorker = annCounts.map(r => ({
          name: pmap[r.annotator_id]?.full_name || pmap[r.annotator_id]?.email || 'unknown',
          role: pmap[r.annotator_id]?.role || 'annotator',
          assigned: Number(r.assigned) || 0,
          completed: Number(r.completed) || 0,
          total: Number(r.total) || 0
        }));
      }
    }

    return res.status(200).json({
      totals: { total, unassigned: unassigned || 0, assigned: assigned || 0, completed: done, progress,
        approved: approved || 0, rejected: rejected || 0, revised: revised || 0, awaiting: awaiting || 0 },
      perWorker
    });
  } catch (err) {
    console.error('dashboard error:', err);
    return res.status(500).json({ error: err.message });
  }
}
