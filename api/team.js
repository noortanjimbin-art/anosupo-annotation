import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function isAdmin(id){
  const { data } = await supabase.from('profiles').select('role').eq('id', id).single();
  return data && data.role === 'admin';
}
async function isAdminOrQA(id){
  const { data } = await supabase.from('profiles').select('role').eq('id', id).single();
  return data && (data.role === 'admin' || data.role === 'qa');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const requester = req.method === 'GET' ? req.query.user_id : req.body.user_id;
    // GET (reading the member list) is allowed for admins AND QAs (QAs need it for the
    // annotator filter). POST actions (role changes, invites, assignment) stay admin-only.
    if (req.method === 'GET') {
      if (!requester || !(await isAdminOrQA(requester))) {
        return res.status(403).json({ error: 'Not authorized' });
      }
    } else {
      if (!requester || !(await isAdmin(requester))) {
        return res.status(403).json({ error: 'Admin only' });
      }
    }

    // ===== Per-member task export (Team tab -> member page -> Download CSV) =====
    // Returns every task this person ANNOTATED and/or REVIEWED, across all pages
    // (Supabase caps a single select at 1000 rows, so this loops). Admin only.
    //   member_export=<profile id>
    //   kind=annotated | reviewed | both   (default: both)
    if (req.method === 'GET' && req.query.member_export) {
      if (!(await isAdmin(requester))) return res.status(403).json({ error: 'Admin only' });
      const memberId = String(req.query.member_export);
      const kind = ['annotated', 'reviewed', 'both'].includes(req.query.kind) ? req.query.kind : 'both';
      const MAX_ROWS = 20000;
      const STEP = 1000;
      const SELECT = 'id, video_id, status, review_status, review_note, annotator_id, reviewer_id, assigned_at, completed_at, reviewed_at, exported, videos(filename)';

      // Pull every task matching one column (annotator_id or reviewer_id), paging past 1000.
      async function pullAll(column) {
        const out = [];
        for (let from = 0; from < MAX_ROWS; from += STEP) {
          const { data, error } = await supabase
            .from('tasks').select(SELECT)
            .eq(column, memberId)
            .order('assigned_at', { ascending: false })
            .range(from, from + STEP - 1);
          if (error) throw error;
          if (!data || data.length === 0) break;
          out.push(...data);
          if (data.length < STEP) break;
        }
        return out;
      }

      const annotated = (kind === 'annotated' || kind === 'both') ? await pullAll('annotator_id') : [];
      const reviewed = (kind === 'reviewed' || kind === 'both') ? await pullAll('reviewer_id') : [];

      // One row per task per role. A task this person both annotated AND reviewed
      // appears twice, tagged differently — that is intentional for per-role tracking.
      const tagged = [
        ...annotated.map(t => ({ t, role_in_task: 'annotated' })),
        ...reviewed.map(t => ({ t, role_in_task: 'reviewed' }))
      ];

      // Resolve the OTHER person's name on each row (annotator or reviewer counterpart)
      const otherIds = [...new Set(tagged.flatMap(x => [x.t.annotator_id, x.t.reviewer_id]).filter(Boolean))];
      const nameMap = {};
      for (let i = 0; i < otherIds.length; i += 200) {
        const { data: profs } = await supabase
          .from('profiles').select('id, email, full_name').in('id', otherIds.slice(i, i + 200));
        (profs || []).forEach(p => { nameMap[p.id] = p.full_name || p.email || p.id; });
      }

      // Frame counts + last-edit time, batched. Skipped on very large exports so the
      // request cannot run past the 60s function limit.
      const frameMap = {};
      const taskIds = [...new Set(tagged.map(x => x.t.id))];
      let framesIncluded = false;
      if (taskIds.length <= 5000) {
        framesIncluded = true;
        for (let i = 0; i < taskIds.length; i += 200) {
          const { data: anns } = await supabase
            .from('annotations').select('task_id, frames, submitted_at').in('task_id', taskIds.slice(i, i + 200));
          (anns || []).forEach(a => {
            frameMap[a.task_id] = {
              frame_count: Array.isArray(a.frames) ? a.frames.length : 0,
              annotation_updated_at: a.submitted_at || null
            };
          });
        }
      }

      const rows = tagged.map(({ t, role_in_task }) => {
        const fm = frameMap[t.id] || {};
        return {
          role_in_task,
          task_id: t.id,
          video_id: t.video_id || '',
          filename: (t.videos && t.videos.filename) || '(unknown)',
          task_status: t.status || '',
          review_status: t.review_status || 'none',
          annotator: t.annotator_id ? (nameMap[t.annotator_id] || 'unknown') : '',
          reviewer: t.reviewer_id ? (nameMap[t.reviewer_id] || 'unknown') : '',
          assigned_at: t.assigned_at || null,
          completed_at: t.completed_at || null,
          reviewed_at: t.reviewed_at || null,
          frame_count: (fm.frame_count != null) ? fm.frame_count : '',
          annotation_updated_at: fm.annotation_updated_at || null,
          exported: t.exported ? 'yes' : 'no',
          review_note: t.review_note || ''
        };
      }).sort((a, b) => {
        const da = a.completed_at || a.reviewed_at || a.assigned_at || '';
        const db = b.completed_at || b.reviewed_at || b.assigned_at || '';
        return String(db).localeCompare(String(da));
      });

      const { data: who } = await supabase
        .from('profiles').select('id, email, full_name, role').eq('id', memberId).maybeSingle();

      return res.status(200).json({
        member: who || { id: memberId },
        kind,
        rows,
        count: rows.length,
        annotated_count: annotated.length,
        reviewed_count: reviewed.length,
        frames_included: framesIncluded,
        truncated: annotated.length >= MAX_ROWS || reviewed.length >= MAX_ROWS
      });
    }

    if (req.method === 'GET') {
      const { data: members } = await supabase
        .from('profiles')
        .select('id, email, full_name, role, created_at')
        .order('created_at', { ascending: true });

      // Get per-person counts from the DATABASE (aggregated server-side).
      // Transfers ~1 row per person instead of every task row — much faster on slow links.
      const counts = {};
      const reviewCounts = {};
      const { data: annCounts } = await supabase.rpc('annotation_counts');
      (annCounts || []).forEach(r => {
        counts[r.annotator_id] = {
          total: Number(r.total) || 0,
          completed: Number(r.completed) || 0,
          assigned: Number(r.assigned) || 0
        };
      });
      // Snapshot counts (current state) — kept as a fallback.
      const { data: revCounts } = await supabase.rpc('review_counts');
      (revCounts || []).forEach(r => {
        reviewCounts[r.reviewer_id] = {
          reviewed: Number(r.reviewed) || 0,
          approved: Number(r.approved) || 0,
          rejected: Number(r.rejected) || 0
        };
      });
      // Exact lifetime counts from the review_events history (Path 2).
      // approved/rejected = every such action ever taken; overturned = tasks this
      // reviewer approved that an admin later sent back (revised/rejected); net_good
      // = approved minus overturned. Available from the day the events table exists.
      const eventCounts = {};
      let hasEvents = false;
      try {
        const { data: evc } = await supabase.rpc('review_event_counts');
        (evc || []).forEach(r => {
          hasEvents = true;
          eventCounts[r.reviewer_id] = {
            approved: Number(r.approved) || 0,
            rejected: Number(r.rejected) || 0,
            overturned: Number(r.overturned) || 0,
            net_good_approvals: (Number(r.approved) || 0) - (Number(r.overturned) || 0),
            total_actions: (Number(r.approved) || 0) + (Number(r.rejected) || 0)
          };
        });
      } catch (e) { /* table/RPC not present yet — fall back to snapshot */ }

      const withCounts = (members || []).map(m => ({
        ...m,
        counts: counts[m.id] || { assigned:0, completed:0, total:0 },
        review_counts: reviewCounts[m.id] || { reviewed:0, approved:0, rejected:0 },
        review_events: eventCounts[m.id] || null
      }));

      // Also return the pre-authorized invite list (emails not yet signed up)
      const { data: invites } = await supabase
        .from('invites').select('email, role, created_at').order('created_at', { ascending: false });
      const memberEmails = new Set((members||[]).map(m => (m.email||'').toLowerCase()));
      const pendingInvites = (invites||[]).filter(i => !memberEmails.has((i.email||'').toLowerCase()));

      return res.status(200).json({ members: withCounts, invites: pendingInvites });
    }

    if (req.method === 'POST') {
      const { action, target_id, new_role, count } = req.body;

      // Change someone's role
      if (!action || action === 'set-role') {
        if (!target_id || !['admin','annotator','qa','pending'].includes(new_role)) {
          return res.status(400).json({ error: 'Invalid input' });
        }
        await supabase.from('profiles').update({ role: new_role }).eq('id', target_id);
        return res.status(200).json({ ok: true });
      }

      // Add a pre-authorized invite (email + role)
      if (action === 'add-invite') {
        const email = (req.body.email||'').trim().toLowerCase();
        const role = req.body.role;
        if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
        if (!['admin','annotator','qa'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
        // If they already signed up, just set their role directly
        const { data: existing } = await supabase.from('profiles').select('id').eq('email', email).single();
        if (existing) {
          await supabase.from('profiles').update({ role }).eq('id', existing.id);
        } else {
          await supabase.from('invites').upsert({ email, role });
        }
        return res.status(200).json({ ok: true });
      }

      // Remove an invite
      if (action === 'remove-invite') {
        const email = (req.body.email||'').trim().toLowerCase();
        await supabase.from('invites').delete().eq('email', email);
        return res.status(200).json({ ok: true });
      }

      // Bulk-assign N unassigned videos to a specific person
      if (action === 'bulk-assign') {
        const n = Math.max(1, Math.min(1000, parseInt(count) || 0));
        if (!target_id) return res.status(400).json({ error: 'target_id required' });
        const { data: vids } = await supabase
          .from('videos').select('id').eq('status','unassigned').limit(n);
        if (!vids || vids.length === 0) return res.status(200).json({ ok: true, assigned: 0 });
        const taskRows = vids.map(v => ({ video_id: v.id, annotator_id: target_id, status: 'assigned' }));
        await supabase.from('tasks').insert(taskRows);
        await supabase.from('videos').update({ status: 'assigned' }).in('id', vids.map(v=>v.id));
        return res.status(200).json({ ok: true, assigned: vids.length });
      }

      return res.status(400).json({ error: 'Unknown action' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('team error:', err);
    return res.status(500).json({ error: err.message });
  }
}
