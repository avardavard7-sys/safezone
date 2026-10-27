export type Role = 'developer' | 'admin' | 'manager' | 'security' | string | undefined;

// all — все на объекте; manage — администратор объекта; dev — только разработчик платформы
const PAGES: [string, 'manage' | 'dev'][] = [
  ['/dashboard/developer', 'dev'],
  ['/dashboard/ai-demo', 'dev'],
  ['/dashboard/bridge', 'dev'],
  ['/dashboard/zone-editor', 'dev'],
  ['/dashboard/functions', 'dev'],
  ['/dashboard/business', 'dev'],
  ['/dashboard/blacklist', 'manage'],
  ['/dashboard/zones', 'manage'],
  ['/dashboard/settings', 'manage'],
  ['/dashboard/compliance', 'manage'],
  ['/dashboard/tenants', 'manage'],
  ['/dashboard/violations', 'manage'],
];

export function canOpen(path: string, role: Role) {
  if (role === 'developer') return true;
  const rule = PAGES.find(([p]) => path === p || path.startsWith(p + '/'))?.[1];
  if (!rule) return true;
  return rule === 'manage' && role === 'admin';
}

export const isDev = (role: Role) => role === 'developer';
