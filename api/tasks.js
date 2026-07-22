import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ===== Description POV detector (detect-only, no auto-fix) =====
// Flags descriptions that reference direction/left/right so an admin can manually review
// whether the point-of-view is correct. Returns the matched phrases (for highlighting).

// Direction/body words worth flagging for POV review.
const DIR_WORDS = ['left','right'];
const BODY_DIR_NOUNS = ['hand','hands','arm','arms','leg','legs','foot','feet','shoulder','shoulders','eye','eyes','ear','ears','knee','knees','elbow','elbows','wing','wings','paw','paws','fin','fins','claw','claws','antenna','antennae','horn','horns','hoof','hooves','tail','cheek','cheeks','wrist','wrists','ankle','ankles','thigh','thighs','hip','hips','finger','fingers','thumb','toe','toes','side','sides'];

// Detect POV/direction references in one description.
// Returns { hasIssue, matches:[{phrase, start, end}] } where positions index into the text.
// Escape a user-typed term for safe use in a regex
function escapeRegex(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// term: optional custom word/phrase to search for. If provided, matches that literally
// (whole-word, case-insensitive). If empty, runs the default left/right POV check.
function analyzeDescription(text, term){
  if (!text || typeof text !== 'string') return { hasIssue:false, matches:[] };
  const matches = [];

  const pushRange = (s, e, phrase) => {
    for (const mm of matches) { if (s < mm.end && e > mm.start) return; } // skip overlaps
    matches.push({ phrase, start: s, end: e });
  };

  // ---- Custom term mode ----
  if (term && term.trim()) {
    const t = term.trim();
    // Whole-word-ish match: word boundaries around the phrase (handles one or two words)
    const re = new RegExp('(?<![\\w])' + escapeRegex(t).replace(/\s+/g, '\\s+') + '(?![\\w])', 'gi');
    let m; re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      pushRange(m.index, m.index + m[0].length, m[0]);
      if (m.index === re.lastIndex) re.lastIndex++; // avoid zero-length loop
    }
    matches.sort((a,b) => a.start - b.start);
    return { hasIssue: matches.length > 0, matches };
  }

  // ---- Default left/right POV mode ----
  const dirGroup = DIR_WORDS.join('|'); // left|right

  // Pattern A (MISTAKE): "the/a left/right" — article instead of a possessive.
  const reA = new RegExp('\\b(?:the|a|an)\\s+(?:left|right)\\b', 'gi');
  // Pattern B (MISTAKE): "to/towards/toward/on/at the left/right" without a possessive.
  const reB = new RegExp('\\b(?:to|towards|toward|on|at)\\s+the\\s+(?:left|right)\\b', 'gi');
  // Pattern C (MISTAKE): a bare direction word NOT preceded by a possessive.
  const reC = new RegExp('(?<!\\b(?:his|her|its|their|your|my|our)\\s)(?<!\'s\\s)\\b(?:' + dirGroup + ')\\b', 'gi');

  const overlaps = (s, e) => {
    for (const mm of matches) { if (s < mm.end && e > mm.start) return true; }
    return false;
  };
  const pushMatch = (m) => {
    const s = m.index, e = m.index + m[0].length;
    if (overlaps(s, e)) return;
    matches.push({ phrase: m[0], start: s, end: e });
  };

  let m;
  reA.lastIndex = 0; while ((m = reA.exec(text)) !== null) pushMatch(m);
  reB.lastIndex = 0; while ((m = reB.exec(text)) !== null) pushMatch(m);
  reC.lastIndex = 0;
  while ((m = reC.exec(text)) !== null) {
    const s = m.index, e = s + m[0].length;
    const before = text.slice(Math.max(0, s - 12), s).toLowerCase();
    if (/(?:his|her|its|their|your|my|our)\s+$/.test(before) || /'s\s+$/.test(before)) continue;
    if (overlaps(s, e)) continue;
    pushMatch(m);
  }

  matches.sort((a,b) => a.start - b.start || (b.end-b.start) - (a.end-a.start));
  return { hasIssue: matches.length > 0, matches };
}

// Scan an annotation's frames, return per-frame detection. term = optional custom search.
function analyzeFrames(frames, term){
  const out = { anyIssue:false, frames:[] };
  (frames || []).forEach((f, i) => {
    const a = analyzeDescription(f.description || '', term);
    if (a.hasIssue) out.anyIssue = true;
    out.frames.push({ index:i, original:f.description||'', hasIssue:a.hasIssue, matches:a.matches });
  });
  return out;
}

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

    // Assign selected unassigned VIDEOS to a person — creates the tasks.
    if (action === 'assign-videos') {
      const { video_ids, new_annotator_id } = req.body;
      if (!Array.isArray(video_ids) || video_ids.length === 0) return res.status(400).json({ error: 'video_ids required' });
      if (!new_annotator_id) return res.status(400).json({ error: 'new_annotator_id required' });
      // Only assign videos still unassigned (avoid double-creating tasks)
      const { data: vids } = await supabase
        .from('videos').select('id').in('id', video_ids).eq('status', 'unassigned');
      const okIds = (vids || []).map(v => v.id);
      if (okIds.length === 0) return res.status(200).json({ ok: true, assigned: 0 });
      const taskRows = okIds.map(vid => ({ video_id: vid, annotator_id: new_annotator_id, status: 'assigned' }));
      await supabase.from('tasks').insert(taskRows);
      await supabase.from('videos').update({ status: 'assigned' }).in('id', okIds);
      return res.status(200).json({ ok: true, assigned: okIds.length });
    }

    // Bulk reassign selected existing TASKS to a person (keeps their work/status).
    if (action === 'bulk-reassign-tasks') {
      const { task_ids, new_annotator_id } = req.body;
      if (!Array.isArray(task_ids) || task_ids.length === 0) return res.status(400).json({ error: 'task_ids required' });
      if (!new_annotator_id) return res.status(400).json({ error: 'new_annotator_id required' });
      await supabase.from('tasks').update({ annotator_id: new_annotator_id }).in('id', task_ids);
      return res.status(200).json({ ok: true, reassigned: task_ids.length });
    }

    // Bulk change review status for selected TASKS. Only two transitions allowed:
    //   approved -> revised  (send back to QA to review again; stays completed)
    //   approved -> rejected (send back to annotators; status -> assigned)
    if (action === 'bulk-review-change') {
      // target: 'revised' | 'rejected'. new_reviewer_id (optional, revised only):
      // designate a specific QA — only they will get these tasks from "Get next review".
      // task_ids can be an array of ids, OR the string 'all' together with reviewer_id
      // to act on EVERY approved task credited to that reviewer (no pagination limits).
      // reviewed_at is deliberately NOT touched here: admin send-backs must not
      // disturb the QA's review date (date semantics decision).
      const { task_ids, target, new_reviewer_id, reviewer_id } = req.body;
      if (target !== 'revised' && target !== 'rejected') return res.status(400).json({ error: 'target must be revised or rejected' });

      const revisedUpd = { review_status: 'revised', assigned_reviewer_id: new_reviewer_id || null };
      const rejectedUpd = { status: 'assigned', review_status: 'rejected',
        review_note: 'Please review and correct this task', assigned_reviewer_id: null };
      const upd = target === 'revised' ? revisedUpd : rejectedUpd;

      // ---- ALL mode: every approved task reviewed by one person ----
      if (task_ids === 'all') {
        if (!reviewer_id) return res.status(400).json({ error: 'reviewer_id required for all mode' });
        const { count } = await supabase
          .from('tasks').select('*', { count: 'exact', head: true })
          .eq('reviewer_id', reviewer_id).eq('review_status', 'approved');
        if (!count) return res.status(200).json({ ok: true, changed: 0 });
        // Single filtered update — applies to all matching rows, no 1000-row cap.
        const { error: uerr } = await supabase.from('tasks').update(upd)
          .eq('reviewer_id', reviewer_id).eq('review_status', 'approved');
        if (uerr) throw uerr;
        return res.status(200).json({ ok: true, changed: count });
      }

      // ---- Selected-ids mode ----
      if (!Array.isArray(task_ids) || task_ids.length === 0) return res.status(400).json({ error: 'task_ids required' });
      // Only act on tasks currently approved
      const { data: appr } = await supabase
        .from('tasks').select('id').in('id', task_ids).eq('review_status', 'approved');
      const ids = (appr || []).map(t => t.id);
      if (ids.length === 0) return res.status(200).json({ ok: true, changed: 0 });
      const { error: uerr2 } = await supabase.from('tasks').update(upd).in('id', ids);
      if (uerr2) throw uerr2;
      return res.status(200).json({ ok: true, changed: ids.length });
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

    // Move unassigned tasks that have kept annotation work into the QA review queue.
    // Sets status='completed' + review_status='none', and restores the annotator credit
    // from the annotation row (which preserves who originally did the work).
    // Either a single task_id, or all unassigned-with-work when task_ids='all'.
    if (action === 'unassigned-to-review') {
      const { task_ids } = req.body;
      let ids = [];
      if (Array.isArray(task_ids) && task_ids.length) {
        ids = task_ids;
      } else if (task_ids === 'all' || !task_ids) {
        // Find all unassigned tasks that have an annotation (kept work)
        const { data: annRows } = await supabase.from('annotations').select('task_id');
        const withWork = new Set((annRows || []).map(a => a.task_id));
        const { data: unTasks } = await supabase.from('tasks').select('id').is('annotator_id', null);
        ids = (unTasks || []).map(t => t.id).filter(id => withWork.has(id));
      }
      if (ids.length === 0) return res.status(200).json({ ok: true, moved: 0 });

      // Restore annotator from the annotation row where possible, then mark completed for review
      let moved = 0;
      for (const tid of ids) {
        const { data: ann } = await supabase
          .from('annotations').select('annotator_id').eq('task_id', tid).maybeSingle();
        const upd = { status: 'completed', review_status: 'none', review_note: null, reviewer_id: null, reviewed_at: null };
        if (ann && ann.annotator_id) upd.annotator_id = ann.annotator_id;
        await supabase.from('tasks').update(upd).eq('id', tid);
        moved++;
      }
      return res.status(200).json({ ok: true, moved });
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

    // ===== DESCRIPTION QC: scan all annotations for POV/direction references =====
    // Detect-only. Returns a report grouped by annotator, with the flagged phrases per task.
    if (action === 'qc-scan') {
      const qcTerm = (req.body && req.body.term) ? String(req.body.term) : '';
      const report = {};
      let offset = 0; const pageSize = 500;
      while (true) {
        const { data: anns } = await supabase
          .from('annotations')
          .select('id, task_id, annotator_id, video_filename, frames')
          .range(offset, offset + pageSize - 1);
        if (!anns || anns.length === 0) break;
        for (const a of anns) {
          const res2 = analyzeFrames(a.frames, qcTerm);
          if (!res2.anyIssue) continue;
          const aid = a.annotator_id || 'unknown';
          if (!report[aid]) report[aid] = { annotator_id: aid, name: null, issueTasks: 0, tasks: [] };
          report[aid].issueTasks++;
          report[aid].tasks.push({
            task_id: a.task_id,
            annotation_id: a.id,
            filename: a.video_filename,
            frames: res2.frames.filter(f => f.hasIssue)  // each: {index, original, matches:[{phrase,start,end}]}
          });
        }
        if (anns.length < pageSize) break;
        offset += pageSize;
      }
      const ids = Object.keys(report).filter(id => id !== 'unknown');
      if (ids.length) {
        const { data: profs } = await supabase.from('profiles').select('id, email, full_name').in('id', ids);
        const pmap = {}; (profs || []).forEach(p => { pmap[p.id] = p.full_name || p.email; });
        Object.values(report).forEach(r => { r.name = pmap[r.annotator_id] || 'Unknown'; });
      }
      return res.status(200).json({ report: Object.values(report) });
    }

    // Send flagged tasks back — either to the ANNOTATOR (reject, redo) or to QA (re-review).
    // Adds an automatic note. No description is modified.
    if (action === 'qc-send-back') {
      const { task_ids, target } = req.body; // target: 'annotator' | 'qa'
      if (!Array.isArray(task_ids) || task_ids.length === 0) return res.status(400).json({ error: 'task_ids required' });
      const note = 'POV/direction issue — please review';
      let sent = 0;
      if (target === 'annotator') {
        // Reject: status back to assigned so it re-appears in the annotator's queue with the note
        for (const tid of task_ids) {
          await supabase.from('tasks').update({
            status: 'assigned',
            review_status: 'rejected',
            review_note: note,
            reviewed_at: new Date().toISOString()
          }).eq('id', tid);
          sent++;
        }
      } else {
        // Send to QA for re-review: mark in_review with the note, keep completed status
        for (const tid of task_ids) {
          await supabase.from('tasks').update({
            review_status: 'in_review',
            review_note: note,
            reviewed_at: new Date().toISOString()
          }).eq('id', tid);
          sent++;
        }
      }
      return res.status(200).json({ ok: true, sent, target });
    }

    return res.status(400).json({ error: 'Unknown action' });
  }

  const { user_id, role, view_user, reviewed_by, search, status_filter, review_filter, annotator_filter, page, unassigned_videos } = req.query;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });

  try {
    const pageNum = Math.max(0, parseInt(page) || 0);
    const pageSize = 100;

    // ===== Unassigned VIDEOS mode: videos in the pool with no task yet =====
    // These are not tasks — just videos waiting to be handed out. Admin can select
    // and assign them (which creates the task). Returned in the same {tasks:[...]} shape
    // for the UI, but flagged is_video:true and with no status/review.
    if (unassigned_videos === '1') {
      let vq = supabase.from('videos').select('id, filename', { count: 'exact' }).eq('status', 'unassigned');
      if (search && search.trim()) vq = vq.ilike('filename', '%' + search.trim() + '%');
      vq = vq.order('created_at', { ascending: false }).range(pageNum * pageSize, pageNum * pageSize + pageSize - 1);
      const { data: vids, count: vtotal } = await vq;
      const vrows = (vids || []).map(v => ({ id: v.id, video_id: v.id, filename: v.filename, is_video: true, status: 'unassigned', review_status: 'none', assignee: 'unassigned' }));
      const { count: remaining } = await supabase.from('videos').select('*', { count: 'exact', head: true }).eq('status', 'unassigned');
      return res.status(200).json({ tasks: vrows, total: vtotal || 0, page: pageNum, page_size: pageSize, remaining: remaining || 0, my_remaining: 0, my_rejected: 0, unassigned_videos: true });
    }

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
      .select('id, status, review_status, review_note, reviewer_id, assigned_reviewer_id, assigned_at, completed_at, reviewed_at, video_id, annotator_id, videos(filename), profiles!tasks_annotator_id_fkey(email, full_name)')
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
      assigned_reviewer_id: t.assigned_reviewer_id || null,
      assignee: t.profiles?.full_name || t.profiles?.email || 'unassigned',
      annotator_id: t.annotator_id,
      assigned_at: t.assigned_at,
      completed_at: t.completed_at,
      reviewed_at: t.reviewed_at
    }));

    // Look up reviewer names for the tasks on this page (who approved/rejected each)
    const reviewerIds = [...new Set(rows.flatMap(r => [r.reviewer_id, r.assigned_reviewer_id]).filter(Boolean))];
    if (reviewerIds.length) {
      const { data: revs } = await supabase
        .from('profiles').select('id, email, full_name').in('id', reviewerIds);
      const rmap = {};
      (revs || []).forEach(p => { rmap[p.id] = p.full_name || p.email; });
      rows = rows.map(r => ({ ...r,
        reviewer_name: r.reviewer_id ? (rmap[r.reviewer_id] || 'unknown') : null,
        assigned_reviewer_name: r.assigned_reviewer_id ? (rmap[r.assigned_reviewer_id] || 'unknown') : null }));
    } else {
      rows = rows.map(r => ({ ...r, reviewer_name: null, assigned_reviewer_name: null }));
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
