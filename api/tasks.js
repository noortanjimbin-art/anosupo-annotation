import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // POST = admin reassign a task to a different person (resets it to fresh)
  if (req.method === 'POST') {
    const { user_id, action, task_id, new_annotator_id } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });
    const { data: prof } = await supabase.from('profiles').select('role').eq('id', user_id).single();
    if (!prof || prof.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

    if (action === 'reassign') {
      if (!task_id || !new_annotator_id) return res.status(400).json({ error: 'task_id and new_annotator_id required' });
      // Reset the task to fresh for the new person: clear annotation + review state
      await supabase.from('annotations').delete().eq('task_id', task_id);
      await supabase.from('tasks').update({
        annotator_id: new_annotator_id,
        status: 'assigned',
        review_status: 'none',
        review_note: null,
        reviewer_id: null,
        reviewed_at: null,
        completed_at: null,
        exported: false
      }).eq('id', task_id);
      return res.status(200).json({ ok: true });
    }

    // Assign an unowned task to a person, KEEPING the existing annotation work.
    if (action === 'reassign-keep') {
      if (!task_id || !new_annotator_id) return res.status(400).json({ error: 'task_id and new_annotator_id required' });
      await supabase.from('tasks').update({
        annotator_id: new_annotator_id,
        review_status: 'none', review_note: null, reviewer_id: null, reviewed_at: null
      }).eq('id', task_id);
      return res.status(200).json({ ok: true });
    }

    // Detach a task from its owner but KEEP the annotation work.
    // The task stays linked to its video (no duplicate), just owned by nobody.
    // It keeps its completed status + annotation so the next owner inherits the work.
    if (action === 'unassign') {
      if (!task_id) return res.status(400).json({ error: 'task_id required' });
      await supabase.from('tasks').update({
        annotator_id: null,
        review_status: 'none',
        review_note: null,
        reviewer_id: null,
        reviewed_at: null
      }).eq('id', task_id);
      return res.status(200).json({ ok: true });
    }

    // Bulk detach — return many tasks to "unowned", keeping their annotations
    if (action === 'bulk-unassign') {
      const { task_ids, from_user, count } = req.body;
      let ids = [];
      if (Array.isArray(task_ids) && task_ids.length) {
        ids = task_ids;
      } else if (from_user && count) {
        const { data: picks } = await supabase
          .from('tasks').select('id')
          .eq('annotator_id', from_user)
          .order('assigned_at', { ascending: true })
          .limit(parseInt(count) || 0);
        ids = (picks || []).map(t => t.id);
      } else {
        return res.status(400).json({ error: 'Provide task_ids, or from_user + count' });
      }
      if (ids.length === 0) return res.status(200).json({ unassigned: 0 });
      await supabase.from('tasks').update({
        annotator_id: null, review_status: 'none',
        review_note: null, reviewer_id: null, reviewed_at: null
      }).in('id', ids);
      return res.status(200).json({ unassigned: ids.length });
    }

    // Bulk reassign — only UNSTARTED tasks (status 'assigned'), protecting completed/reviewed work.
    // Either by count (from_user + count) or by explicit task_ids.
    if (action === 'bulk-reassign') {
      const { from_user, count, task_ids } = req.body;
      if (!new_annotator_id) return res.status(400).json({ error: 'new_annotator_id required' });

      let idsToMove = [];
      if (Array.isArray(task_ids) && task_ids.length) {
        // By selection — but verify each is unstarted before moving
        const { data: valid } = await supabase
          .from('tasks').select('id').in('id', task_ids).eq('status', 'assigned');
        idsToMove = (valid || []).map(t => t.id);
      } else if (from_user && count) {
        // By count — take N of this person's unstarted tasks
        const { data: picks } = await supabase
          .from('tasks').select('id')
          .eq('annotator_id', from_user).eq('status', 'assigned')
          .order('assigned_at', { ascending: true })
          .limit(parseInt(count) || 0);
        idsToMove = (picks || []).map(t => t.id);
      } else {
        return res.status(400).json({ error: 'Provide task_ids, or from_user + count' });
      }

      if (idsToMove.length === 0) {
        return res.status(200).json({ moved: 0, message: 'No unstarted tasks available to move' });
      }

      // Move them (these are unstarted, so no annotation to clear)
      await supabase.from('tasks').update({ annotator_id: new_annotator_id }).in('id', idsToMove);
      return res.status(200).json({ moved: idsToMove.length });
    }

    return res.status(400).json({ error: 'Unknown action' });
  }

  const { user_id, role, view_user, reviewed_by, search, status_filter, review_filter, annotator_filter, page } = req.query;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });

  try {
    const pageNum = Math.max(0, parseInt(page) || 0);
    const pageSize = 100;

    // If searching by filename, first find matching video IDs (filename lives in videos table)
    let searchVideoIds = null;
    if (search && search.trim()) {
      const { data: vids } = await supabase
        .from('videos').select('id').ilike('filename', '%' + search.trim() + '%').limit(2000);
      searchVideoIds = (vids || []).map(v => v.id);
      if (searchVideoIds.length === 0) {
        return res.status(200).json({ tasks: [], total: 0, page: pageNum, page_size: pageSize, remaining: 0, my_remaining: 0, my_rejected: 0 });
      }
    }

    // Build the base filter (shared by the count query and the data query)
    const applyFilters = (q) => {
      if (role === 'annotator') q = q.eq('annotator_id', user_id);
      else if (reviewed_by) q = q.eq('reviewer_id', reviewed_by);
      else if (view_user === 'unassigned') q = q.is('annotator_id', null);
      else if (view_user) q = q.eq('annotator_id', view_user);
      // Explicit annotator filter (admin/QA browsing by who did the task)
      if (annotator_filter && annotator_filter !== 'all') q = q.eq('annotator_id', annotator_filter);
      if (status_filter && status_filter !== 'all') q = q.eq('status', status_filter);
      if (review_filter && review_filter !== 'all') q = q.eq('review_status', review_filter);
      if (searchVideoIds) q = q.in('video_id', searchVideoIds);
      return q;
    };

    // Total matching count (for pagination controls)
    let countQuery = supabase.from('tasks').select('*', { count: 'exact', head: true });
    countQuery = applyFilters(countQuery);
    const { count: total } = await countQuery;

    // The actual page of rows
    let query = supabase
      .from('tasks')
      .select('id, status, review_status, review_note, reviewer_id, assigned_at, completed_at, video_id, annotator_id, videos(filename), profiles!tasks_annotator_id_fkey(email, full_name)')
      .order('assigned_at', { ascending: false })
      .range(pageNum * pageSize, pageNum * pageSize + pageSize - 1);
    query = applyFilters(query);

    const { data: tasks, error } = await query;
    if (error) throw error;

    let rows = (tasks || []).map(t => ({
      id: t.id,
      video_id: t.video_id,
      filename: t.videos?.filename || 'unknown',
      status: t.status,
      review_status: t.review_status || 'none',
      review_note: t.review_note || null,
      reviewer_id: t.reviewer_id || null,
      assignee: t.profiles?.full_name || t.profiles?.email || 'unassigned',
      annotator_id: t.annotator_id,
      assigned_at: t.assigned_at,
      completed_at: t.completed_at
    }));

    // Look up reviewer names for the tasks on this page (who approved/rejected each)
    const reviewerIds = [...new Set(rows.map(r => r.reviewer_id).filter(Boolean))];
    if (reviewerIds.length) {
      const { data: revs } = await supabase
        .from('profiles').select('id, email, full_name').in('id', reviewerIds);
      const rmap = {};
      (revs || []).forEach(p => { rmap[p.id] = p.full_name || p.email; });
      rows = rows.map(r => ({ ...r, reviewer_name: r.reviewer_id ? (rmap[r.reviewer_id] || 'unknown') : null }));
    } else {
      rows = rows.map(r => ({ ...r, reviewer_name: null }));
    }

    // Count of remaining unassigned videos in the pool (admin self-serve)
    const { count: remaining } = await supabase
      .from('videos').select('*', { count: 'exact', head: true }).eq('status', 'unassigned');

    // Count of THIS user's own assigned-but-incomplete tasks (their personal queue),
    // excluding rejected ones (those are counted separately and shown as "fix rejected").
    const { count: myRemaining } = await supabase
      .from('tasks').select('*', { count: 'exact', head: true })
      .eq('annotator_id', user_id).eq('status', 'assigned').neq('review_status', 'rejected');

    // Count of THIS user's rejected tasks (must be fixed first)
    const { count: myRejected } = await supabase
      .from('tasks').select('*', { count: 'exact', head: true })
      .eq('annotator_id', user_id).eq('review_status', 'rejected');

    return res.status(200).json({ tasks: rows, total: total || 0, page: pageNum, page_size: pageSize, remaining: remaining || 0, my_remaining: myRemaining || 0, my_rejected: myRejected || 0 });
  } catch (err) {
    console.error('tasks error:', err);
    return res.status(500).json({ error: err.message });
  }
}
