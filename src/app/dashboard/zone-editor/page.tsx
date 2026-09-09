'use client';

import DashboardLayout from '@/components/layout/DashboardLayout';
import { ZoneEditor } from '@/components/zones/ZoneEditor';

export default function ZoneEditorPage() {
  return (
    <DashboardLayout>
      <div className="mb-6">
        <h1 className="text-2xl font-display font-bold text-white">Редактор зон</h1>
        <p className="text-slate-400 text-sm">
          Нарисуй зоны на кадре с камеры: где сидят гости, где стоит персонал, где столы.
          Правила работают локально на бридже и ничего не стоят.
        </p>
      </div>
      <ZoneEditor />
    </DashboardLayout>
  );
}
