/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/src/**/*.{js,ts,jsx,tsx}', './src/renderer/index.html'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Theme-aware palette — CSS variables switch on .dark
        chassis:       'rgb(var(--chassis-rgb) / <alpha-value>)',
        'chassis-soft':'rgb(var(--chassis-soft-rgb) / <alpha-value>)',
        paper:         'rgb(var(--paper-rgb) / <alpha-value>)',
        ink:           'rgb(var(--ink-rgb) / <alpha-value>)',
        'ink-soft':    'rgb(var(--ink-soft-rgb) / <alpha-value>)',
        muted:         'rgb(var(--muted-rgb) / <alpha-value>)',
        border:        'rgb(var(--border-rgb) / <alpha-value>)',
        accent:        'rgb(var(--accent-rgb) / <alpha-value>)',
        // Fixed dark tokens for the player section (always dark regardless of theme)
        surface: {
          900: '#111118',
          950: '#0b0b10'
        },
        // Earthen categorical palette (Offcut) — for crates, cue markers, track tags
        cat: {
          stone:  '#8E8473',
          clay:   '#B07A4E',
          moss:   '#6E8059',
          ocean:  '#4E7090',
          rose:   '#B86E72',
          wine:   '#874850',
          ochre:  '#C9A02C',
          // legacy aliases kept for backwards compat
          teal:   '#3CA8A1',
          blue:   '#2E6FB8',
        }
      },
      fontFamily: {
        sans: ["'Archivo'", '-apple-system', 'BlinkMacSystemFont', "'Segoe UI'", 'sans-serif'],
        mono: ["'JetBrains Mono'", "'Fira Code'", 'Consolas', 'monospace'],
      },
      fontSize: {
        '2xs': ['9px',  '13px'],
        xs:    ['10px', '14px'],
        sm:    ['11px', '16px'],
        base:  ['12px', '18px'],
      }
    }
  },
  plugins: []
}
