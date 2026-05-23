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
        card: '0 1px 3px rgba(0,0,0,0.05), 0 8px 24px rgba(0,0,0,0.10)',
        'card-hover': '0 8px 16px rgba(0,0,0,0.08), 0 20px 48px rgba(0,0,0,0.16)',
      },
    },
  },
  plugins: [],
};
