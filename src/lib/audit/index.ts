

import { createClient } from '@supabase/supabase-js';

type AuditAction =
  | 'login' | 'logout' | 'login_failed'
  | 'user.create' | 'user.update' | 'user.delete' | 'user.role_change' | 'user.approve' | 'user.block'
  | 'mall.create' | 'mall.update' | 'mall.delete' | 'mall.approve'
  | 'camera.create' | 'camera.update' | 'camera.delete'
  | 'event.create' | 'event.resolve' | 'event.delete' | 'event.bulk_delete'
  | 'tenant.create' | 'tenant.update' | 'tenant.delete'
  | 'violation.create' | 'violation.update'
  | 'settings.update'
  | 'ai.analyze';

interface AuditEntry {
  user_id?: string;
  username?: string;
  mall_id?: string;
  action: AuditAction;
  resource_type?: string;
  resource_id?: string;
  metadata?: Record<string, any>;
  ip_address?: string;
  user_agent?: string;
}

export async function audit(entry: AuditEntry): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return;

  try {
    const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    await sb.from('audit_logs').insert({
      ...entry,
      metadata: entry.metadata || {},
      created_at: new Date().toISOString(),
    });
  } catch (e) {

    console.error('[audit] failed:', e);
  }
}

export function auditFromRequest(req: Request, entry: Omit<AuditEntry, 'ip_address' | 'user_agent'>) {
  return audit({
    ...entry,
    ip_address:
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      req.headers.get('x-real-ip') ||
      undefined,
    user_agent: req.headers.get('user-agent') || undefined,
  });
}
