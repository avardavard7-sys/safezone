import type { Config } from 'tailwindcss';
const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        surface: { DEFAULT: '#0B0F1A', 100: '#141929', 200: '#1C2236', 300: '#2A3148' },
        primary: { DEFAULT: '#6366F1', dark: '#4F46E5', light: '#818CF8' },
        accent: { DEFAULT: '#F59E0B', dark: '#D97706' },
        danger: '#EF4444',
        success: '#10B981',
        warning: '#F59E0B',
      },
      fontFamily: {
        display: ['Exo 2', 'sans-serif'],
        body: ['IBM Plex Sans', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [],
};
export default config;
