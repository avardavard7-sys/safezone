import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { rateLimit } from '@/lib/rate-limit';
import { auditFromRequest } from '@/lib/audit';
import { mediaBaseUrl, mediaConfigured, mediaPath, viewerToken } from '@/lib/media/token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TTL_SEC = 120;
const noStore = { 'Cache-Control': 'no-store' };

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const limited = await rateLimit(req, 'camera-live', { limit: 120, window: 60 });
  if (limited) return limited;

  if (!UUID.test(params.id)) {
    return NextResponse.json({ error: 'bad_camera_id' }, { status: 400, headers: noStore });
  }
  if (!mediaConfigured()) {
    return NextResponse.json({ error: 'live_not_configured' }, { status: 503, headers: noStore });
  }

  const header = req.headers.get('authorization') || '';
  const accessToken = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!accessToken) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: noStore });
  }

  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: auth, error: authError } = await sb.auth.getUser(accessToken);
  if (authError || !auth?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: noStore });
  }

  // запрос идёт под токеном пользователя: RLS отдаст камеру, только если она на его объекте
  const { data: camera } = await sb
    .from('cameras')
    .select('id, mall_id, is_active')
    .eq('id', params.id)
    .maybeSingle();

  if (!camera || camera.is_active === false) {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: noStore });
  }

  const token = viewerToken(camera.id, auth.user.id, TTL_SEC);

  auditFromRequest(req, {
    user_id: auth.user.id,
    mall_id: camera.mall_id,
    action: 'camera.live_view',
    resource_type: 'camera',
    resource_id: camera.id,
  }).catch(() => {});

  return NextResponse.json(
    {
      whepUrl: `${mediaBaseUrl()}/${mediaPath(camera.id)}/whep`,
      token,
      expiresAt: Date.now() + TTL_SEC * 1000,
    },
    { headers: noStore },
  );
}
