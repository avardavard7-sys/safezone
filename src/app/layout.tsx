import './globals.css';
import { Toaster } from 'react-hot-toast';

export const metadata = {
  title: 'SafeZone — Безопасная среда | AI-система безопасности ТРЦ',
  description: 'AI-платформа видеоаналитики для торговых центров',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>
        {children}
        <Toaster position="top-right" toastOptions={{
          style: { background: '#1C2236', color: '#E2E8F0', border: '1px solid #2A3148' },
          duration: 4000,
        }} />
      </body>
    </html>
  );
}
