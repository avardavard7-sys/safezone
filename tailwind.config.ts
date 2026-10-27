import type { Config } from 'tailwindcss';

// Палитра Ауры: полночь — комната, кобальт — стекло, лёд — голос Ауры.
// Названия токенов прежние, поэтому все страницы перекрашиваются без правки их кода.
const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: 'rgb(6 8 30 / <alpha-value>)',
          100: 'rgb(11 18 56 / <alpha-value>)',
          200: 'rgb(17 26 74 / <alpha-value>)',
          300: 'rgb(34 50 108 / <alpha-value>)',
        },
        primary: {
          DEFAULT: 'rgb(51 85 242 / <alpha-value>)',
          dark: 'rgb(30 60 200 / <alpha-value>)',
          light: 'rgb(150 215 255 / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'rgb(150 215 255 / <alpha-value>)',
          dark: 'rgb(95 180 238 / <alpha-value>)',
        },
        ice: 'rgb(150 215 255 / <alpha-value>)',
        cobalt: 'rgb(30 60 200 / <alpha-value>)',
        midnight: 'rgb(6 8 30 / <alpha-value>)',
        gold: 'rgb(217 180 90 / <alpha-value>)',
        danger: 'rgb(239 68 68 / <alpha-value>)',
        success: 'rgb(16 185 129 / <alpha-value>)',
        warning: 'rgb(245 158 11 / <alpha-value>)',
        slate: {
          200: '#e3eaff',
          300: '#c6d2f0',
          400: '#a9b8de',
          500: '#8090bb',
          600: '#6c7ba6',
        },
      },
      fontFamily: {
        sans: ['"Manrope Variable"', 'Manrope', '"Helvetica Neue"', 'Arial', 'sans-serif'],
        display: ['"Manrope Variable"', 'Manrope', '"Helvetica Neue"', 'Arial', 'sans-serif'],
        body: ['"Manrope Variable"', 'Manrope', '"Helvetica Neue"', 'Arial', 'sans-serif'],
        mono: ['"JetBrains Mono Variable"', 'ui-monospace', '"SF Mono"', 'Menlo', 'monospace'],
        hand: ['"Caveat Aura"', '"Segoe Print"', 'cursive'],
      },
    },
  },
  plugins: [],
};
export default config;
