/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/src/**/*.{js,ts,jsx,tsx}', './src/renderer/index.html'],
  theme: {
    extend: {
      colors: {
        surface: {
          50: '#f8f8f8',
          100: '#f0f0f0',
          200: '#e4e4e4',
          800: '#1c1c1e',
          900: '#141414',
          950: '#0a0a0a'
        },
        accent: {
          DEFAULT: '#6366f1',
          hover: '#4f46e5'
        }
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif']
      }
    }
  },
  plugins: []
}
