import Link from 'next/link';
import { Search, Home } from 'lucide-react';

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-100 p-6">
      <div className="max-w-md text-center">
        <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-6">
          <Search size={40} className="text-primary" />
        </div>
        <h1 className="text-7xl font-display font-bold text-white mb-2">404</h1>
        <p className="text-slate-400 mb-6">Страница не найдена</p>
        <Link href="/dashboard" className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-primary text-white font-medium hover:bg-primary/90 transition">
          <Home size={16} />На дашборд
        </Link>
      </div>
    </div>
  );
}
