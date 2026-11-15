import '@fontsource-variable/manrope';
import '@fontsource-variable/jetbrains-mono';
import './globals.css';
import { Toaster } from 'react-hot-toast';
import { AuraBackdrop } from '@/components/aura/AuraBackdrop';

export const metadata = {
  title: 'Aura SafeZone — интеллектуальная безопасность объекта',
  description: 'Aura SafeZone — видеоаналитика для магазинов, торговых центров, кафе и производств. Mila Chess IT',
  applicationName: 'Aura SafeZone',
  icons: { icon: '/brand/mila-mark-white.png' },
};

export const viewport = { themeColor: '#06081e' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" className="aura">
      <body className="font-sans">
        <AuraBackdrop />
        {children}
        <Toaster position="top-right" toastOptions={{
          style: {
            background: 'rgba(9, 14, 46, 0.92)', color: '#f5f8ff', border: '1px solid rgba(150, 215, 255, 0.2)',
            backdropFilter: 'blur(22px)', borderRadius: '12px', fontFamily: '"Manrope Variable", Manrope, sans-serif',
          },
          duration: 4000,
        }} />
      </body>
    </html>
  );
}
