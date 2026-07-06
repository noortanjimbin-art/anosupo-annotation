import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ===== Description POV rule engine =====
// The rule: directional/body-part references must be from the subject's point of view,
// i.e. "the left hand" should be "his/her/its/their left hand" depending on the subject.
// This is intentionally CONSERVATIVE: it only flags/fixes clear cases and leaves anything
// ambiguous for manual review (returned with needsReview=true).

// Body/direction nouns that clearly belong to a subject's body -> safe to make possessive.
// Deliberately EXCLUDES ambiguous words like "side" (e.g. "left side of the screen").
const BODY_DIR_NOUNS = ['hand','hands','arm','arms','leg','legs','foot','feet','shoulder','shoulders','eye','eyes','ear','ears','knee','knees','elbow','elbows','wing','wings','paw','paws','fin','fins','claw','claws','antenna','antennae','horn','horns','hoof','hooves','tail','cheek','cheeks','wrist','wrists','ankle','ankles','thigh','thighs','hip','hips','finger','fingers','thumb','toe','toes'];
const MALE_CUES = ['\\bhe\\b','\\bhis\\b','\\bhim\\b','\\bman\\b','\\bboy\\b','\\bmale\\b','\\bgentleman\\b','\\bfather\\b','\\bson\\b','\\bhusband\\b','\\bking\\b','\\bmr\\b'];
const FEMALE_CUES = ['\\bshe\\b','\\bher\\b','\\bwoman\\b','\\bgirl\\b','\\bfemale\\b','\\blady\\b','\\bmother\\b','\\bdaughter\\b','\\bwife\\b','\\bqueen\\b','\\bmrs\\b','\\bms\\b'];
const PERSON_CUES = ['\\bperson\\b','\\bpeople\\b','\\bhuman\\b','\\bchild\\b','\\bchildren\\b','\\bindividual\\b','\\bworker\\b','\\bplayer\\b','\\bdancer\\b','\\bfriend\\b','\\bthey\\b','\\btheir\\b','\\bthem\\b'];
const ANIMAL_CUES = ['\\bdog\\b','\\bcat\\b','\\bfish\\b','\\bmonkey\\b','\\bbird\\b','\\bhorse\\b','\\bcow\\b','\\belephant\\b','\\binsect\\b','\\bant\\b','\\bbee\\b','\\bspider\\b','\\bsnake\\b','\\blizard\\b','\\bfrog\\b','\\bchicken\\b','\\bduck\\b','\\bgoat\\b','\\bsheep\\b','\\bpig\\b','\\brabbit\\b','\\bmouse\\b','\\brat\\b','\\bbear\\b','\\blion\\b','\\btiger\\b','\\banimal\\b','\\bcamel\\b','\\bmule\\b','\\bpangolin\\b','\\bcreature\\b'];

function anyMatch(text, patterns){
  const low = text.toLowerCase();
  return patterns.some(p => new RegExp(p).test(low));
}

// Decide the possessive for a description based on cues present in the whole text.
// Returns one of: 'his','her','their','its', or null if it can't decide confidently.
function decidePossessive(text){
  const male = anyMatch(text, MALE_CUES);
  const female = anyMatch(text, FEMALE_CUES);
  const person = anyMatch(text, PERSON_CUES);
  const animal = anyMatch(text, ANIMAL_CUES);

  // Conflicting gender cues -> ambiguous, don't guess
  if (male && female) return null;
  if (male) return 'his';
  if (female) return 'her';
  if (person) return 'their';    // person, unspecified gender
  if (animal) return 'its';      // animal -> its (per the rule; 'their' also acceptable but its is safe)
  // No living-being cue at all -> treat as object
  return 'its';
}

// Find POV mistakes in one description and (optionally) produce a corrected version.
// A "mistake" = "the <left|right> [optional adjectives] <body/direction noun>" or
// "to/towards the <left|right>" where 'the' should be a possessive.
// Returns { hasIssue, needsReview, fixed, matches:[...] }
function analyzeDescription(text){
  if (!text || typeof text !== 'string') return { hasIssue:false, needsReview:false, fixed:text, matches:[] };

  const matches = [];
  // Pattern A: "the left/right ... <body/dir noun>"  (within a few words)
  const nounGroup = BODY_DIR_NOUNS.join('|');
  const reA = new RegExp('\\bthe\\s+(left|right)\\b((?:\\s+\\w+){0,3}?\\s+(?:' + nounGroup + '))', 'gi');
  // Pattern B: "to/towards/on the left/right"
  const reB = new RegExp('\\b(to|towards|toward|on)\\s+the\\s+(left|right)\\b', 'gi');

  let hasIssue = false;
  reA.lastIndex = 0; let m;
  while ((m = reA.exec(text)) !== null) { hasIssue = true; matches.push(m[0]); }
  reB.lastIndex = 0;
  while ((m = reB.exec(text)) !== null) { hasIssue = true; matches.push(m[0]); }

  if (!hasIssue) return { hasIssue:false, needsReview:false, fixed:text, matches:[] };

  const poss = decidePossessive(text);
  if (!poss) {
    // Found the pattern but can't confidently pick the possessive -> flag for manual review
    return { hasIssue:true, needsReview:true, fixed:text, matches };
  }

  // Guard: if a matched body-part phrase is immediately followed by "of ..." it's likely
  // describing someone/something else's part (e.g. "the right hand of the other monkey"),
  // which is genuinely ambiguous -> flag for manual review rather than risk a wrong fix.
  const ofFollows = new RegExp('\\bthe\\s+(left|right)\\b(?:\\s+\\w+){0,3}?\\s+(?:' + nounGroup + ')\\s+of\\b', 'i');
  if (ofFollows.test(text)) {
    return { hasIssue:true, needsReview:true, fixed:text, matches };
  }

  // Apply the fix: replace "the <left|right>" with "<poss> <left|right>" only in the matched shapes
  let fixed = text
    .replace(new RegExp('\\bthe\\s+(left|right)\\b((?:\\s+\\w+){0,3}?\\s+(?:' + nounGroup + '))', 'gi'),
             (full, dir, rest) => poss + ' ' + dir + rest)
    .replace(new RegExp('\\b(to|towards|toward|on)\\s+the\\s+(left|right)\\b', 'gi'),
             (full, prep, dir) => prep + ' ' + poss + ' ' + dir);

  // Capitalize possessive if it starts a sentence (rare, but keep it clean)
  fixed = fixed.replace(/(^|[.!?]\s+)(his|her|its|their)\b/g, (full, pre, w) => pre + w.charAt(0).toUpperCase() + w.slice(1));

  const changed = fixed !== text;
  return { hasIssue:true, needsReview:!changed, fixed, matches };
}

// Scan an annotation's frames, return per-frame analysis + whether any frame has an issue.
function analyzeFrames(frames){
  const out = { anyIssue:false, anyNeedsReview:false, frames:[] };
  (frames || []).forEach((f, i) => {
    const a = analyzeDescription(f.description || '');
    if (a.hasIssue) out.anyIssue = true;
    if (a.needsReview) out.anyNeedsReview = true;
    out.frames.push({ index:i, original:f.description||'', fixed:a.fixed, hasIssue:a.hasIssue, needsReview:a.needsReview, matches:a.matches });
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

    // ===== DESCRIPTION QC: scan all annotations for POV mistakes =====
    // Returns a report grouped by annotator, plus per-task detail with proposed fixes.
    if (action === 'qc-scan') {
      // Page through all annotations (could be thousands)
      const report = {}; // annotator_id -> { name, taskCount, issueCount, needsReviewCount, tasks:[] }
      let offset = 0; const pageSize = 500;
      while (true) {
        const { data: anns } = await supabase
          .from('annotations')
          .select('id, task_id, annotator_id, video_filename, frames')
          .range(offset, offset + pageSize - 1);
        if (!anns || anns.length === 0) break;
        for (const a of anns) {
          const res2 = analyzeFrames(a.frames);
          if (!res2.anyIssue) continue;
          const aid = a.annotator_id || 'unknown';
          if (!report[aid]) report[aid] = { annotator_id: aid, name: null, issueTasks: 0, needsReview: 0, fixable: 0, tasks: [] };
          report[aid].issueTasks++;
          if (res2.anyNeedsReview) report[aid].needsReview++;
          const fixableFrames = res2.frames.filter(f => f.hasIssue && !f.needsReview).length;
          if (fixableFrames > 0) report[aid].fixable++;
          report[aid].tasks.push({
            task_id: a.task_id,
            annotation_id: a.id,
            filename: a.video_filename,
            frames: res2.frames.filter(f => f.hasIssue)
          });
        }
        if (anns.length < pageSize) break;
        offset += pageSize;
      }
      // Attach annotator names
      const ids = Object.keys(report).filter(id => id !== 'unknown');
      if (ids.length) {
        const { data: profs } = await supabase.from('profiles').select('id, email, full_name').in('id', ids);
        const pmap = {}; (profs || []).forEach(p => { pmap[p.id] = p.full_name || p.email; });
        Object.values(report).forEach(r => { r.name = pmap[r.annotator_id] || 'Unknown'; });
      }
      return res.status(200).json({ report: Object.values(report) });
    }

    // Apply fixes to a set of tasks. Backs up originals first, then writes corrected frames.
    if (action === 'qc-apply') {
      const { task_ids } = req.body;
      if (!Array.isArray(task_ids) || task_ids.length === 0) return res.status(400).json({ error: 'task_ids required' });
      const batchId = (globalThis.crypto && globalThis.crypto.randomUUID) ? globalThis.crypto.randomUUID() : ('batch-' + Date.now());
      let fixed = 0;
      for (const tid of task_ids) {
        const { data: a } = await supabase
          .from('annotations').select('id, frames').eq('task_id', tid).maybeSingle();
        if (!a) continue;
        const res2 = analyzeFrames(a.frames);
        if (!res2.anyIssue) continue;
        // Build new frames applying only the confident (non-needsReview) fixes
        const newFrames = (a.frames || []).map((f, i) => {
          const info = res2.frames[i];
          if (info && info.hasIssue && !info.needsReview && info.fixed !== info.original) {
            return { ...f, description: info.fixed };
          }
          return f;
        });
        // Only proceed if something actually changed
        if (JSON.stringify(newFrames) === JSON.stringify(a.frames)) continue;
        // Backup original first
        await supabase.from('description_backups').insert({
          batch_id: batchId, task_id: tid, annotation_id: a.id, original_frames: a.frames
        });
        // Write corrected frames
        await supabase.from('annotations').update({ frames: newFrames }).eq('task_id', tid);
        fixed++;
      }
      return res.status(200).json({ ok: true, batch_id: batchId, fixed });
    }

    // Undo a batch: restore original frames from the backup, then remove that backup batch.
    if (action === 'qc-undo') {
      const { batch_id } = req.body;
      if (!batch_id) return res.status(400).json({ error: 'batch_id required' });
      const { data: backups } = await supabase
        .from('description_backups').select('task_id, original_frames').eq('batch_id', batch_id);
      if (!backups || backups.length === 0) return res.status(200).json({ ok: true, restored: 0 });
      let restored = 0;
      for (const b of backups) {
        await supabase.from('annotations').update({ frames: b.original_frames }).eq('task_id', b.task_id);
        restored++;
      }
      await supabase.from('description_backups').delete().eq('batch_id', batch_id);
      return res.status(200).json({ ok: true, restored });
    }

    // List past QC fix batches (so admin can undo a previous one)
    if (action === 'qc-batches') {
      const { data: rows } = await supabase
        .from('description_backups')
        .select('batch_id, created_at')
        .order('created_at', { ascending: false })
        .limit(1000);
      const batches = {};
      (rows || []).forEach(r => {
        if (!batches[r.batch_id]) batches[r.batch_id] = { batch_id: r.batch_id, created_at: r.created_at, count: 0 };
        batches[r.batch_id].count++;
      });
      return res.status(200).json({ batches: Object.values(batches) });
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
      .select('id, status, review_status, review_note, reviewer_id, assigned_at, completed_at, reviewed_at, video_id, annotator_id, videos(filename), profiles!tasks_annotator_id_fkey(email, full_name)')
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
      completed_at: t.completed_at,
      reviewed_at: t.reviewed_at
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
