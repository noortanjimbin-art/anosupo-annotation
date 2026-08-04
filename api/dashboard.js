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

    // ===== Personal stats for the signed-in worker (annotator + QA/admin) =====
    // Computed from the SAME tasks table the admin views read, so the numbers
    // a worker sees always match what the admin sees for that person.
    let mine = null;
    if (user_id) {
      const c = async (build) => {
        const { count } = await build(supabase.from('tasks').select('*', { count: 'exact', head: true }));
        return count || 0;
      };
      // --- as annotator (work they produced) ---
      const a_total     = await c(q => q.eq('annotator_id', user_id));
      const a_assigned  = await c(q => q.eq('annotator_id', user_id).eq('status', 'assigned'));
      const a_completed = await c(q => q.eq('annotator_id', user_id).eq('status', 'completed'));
      const a_approved  = await c(q => q.eq('annotator_id', user_id).eq('status', 'completed').eq('review_status', 'approved'));
      const a_rejected  = await c(q => q.eq('annotator_id', user_id).eq('review_status', 'rejected'));
      const a_revised   = await c(q => q.eq('annotator_id', user_id).eq('status', 'completed').eq('review_status', 'revised'));
      const a_awaiting  = await c(q => q.eq('annotator_id', user_id).eq('status', 'completed').in('review_status', ['none', 'in_review']));

      // --- as reviewer (current snapshot: tasks whose latest reviewer is them) ---
      const r_total    = await c(q => q.eq('reviewer_id', user_id));
      const r_approved = await c(q => q.eq('reviewer_id', user_id).eq('review_status', 'approved'));
      const r_rejected = await c(q => q.eq('reviewer_id', user_id).eq('review_status', 'rejected'));
      // their approvals an admin later sent back
      const r_sentback = await c(q => q.eq('reviewer_id', user_id).eq('review_status', 'revised'));

      // --- exact lifetime review history, if the review_events table exists ---
      let events = null;
      try {
        const { data: evc } = await supabase.rpc('review_event_counts');
        const row = (evc || []).find(e => e.reviewer_id === user_id);
        if (row) {
          const ap = Number(row.approved) || 0, rj = Number(row.rejected) || 0, ov = Number(row.overturned) || 0;
          events = { approved: ap, rejected: rj, overturned: ov, total_actions: ap + rj, net_good_approvals: ap - ov };
        }
      } catch (e) { /* history table not present */ }

      mine = {
        annotated: { total: a_total, assigned: a_assigned, completed: a_completed,
          approved: a_approved, rejected: a_rejected, revised: a_revised, awaiting: a_awaiting,
          progress: a_total > 0 ? Math.round((a_completed / a_total) * 100) : 0 },
        reviewed: { total: r_total, approved: r_approved, rejected: r_rejected, sent_back: r_sentback },
        review_events: events
      };
    }

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
      perWorker,
      mine
    });
  } catch (err) {
    console.error('dashboard error:', err);
    return res.status(500).json({ error: err.message });
  }
}
