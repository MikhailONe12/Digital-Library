/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    './index.html',
    './App.tsx',
    './index.tsx',
    './components/**/*.{ts,tsx}',
    './pages/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          '-apple-system', 'BlinkMacSystemFont', '"SF Pro Display"', '"SF Pro Text"',
          'Inter', 'system-ui', 'Roboto', 'Helvetica', 'Arial', 'sans-serif',
        ],
      },
      // Two-step neutral shadow scale (Apple-style: soft, grey, never coloured).
      boxShadow: {
        card: '0 1px 2px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.04)',
        'card-hover': '0 4px 8px rgba(0,0,0,0.05), 0 12px 32px rgba(0,0,0,0.08)',
      },
    },
  },
  plugins: [],
};
