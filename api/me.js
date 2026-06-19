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
  if (!user_id) return res.status(400).json({ error: 'user_id required' });

  try {
    let { data: profile } = await supabase
      .from('profiles')
      .select('id, email, full_name, role')
      .eq('id', user_id)
      .single();

    // If no profile yet (older account), create one as pending
    if (!profile) {
      const { data: created } = await supabase
        .from('profiles')
        .insert({ id: user_id, role: 'pending' })
        .select('id, email, full_name, role')
        .single();
      profile = created;
    }

    return res.status(200).json({ profile });
  } catch (err) {
    console.error('me error:', err);
    return res.status(500).json({ error: err.message });
  }
}
