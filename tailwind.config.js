/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{html,ts}'],
  // Safelist classes that are dynamically constructed (e.g., `btn-${style}`)
  // Tailwind's JIT compiler can't detect these at build time
  safelist: [
    // Entity Action button styles (from metadata.entity_actions.button_style)
    'btn-primary',
    'btn-secondary',
    'btn-accent',
    'btn-neutral',
    'btn-info',
    'btn-success',
    'btn-warning',
    'btn-error',
    'btn-ghost',
    // Border colors for action bar dropdown items
    'border-l-primary',
    'border-l-secondary',
    'border-l-accent',
    'border-l-neutral',
    'border-l-info',
    'border-l-success',
    'border-l-warning',
    'border-l-error',
    'border-l-base-300',
  ],
  theme: {
    container: {
      center: true,
    },
    extend: {
      typography: {
        DEFAULT: {
          css: {
            maxWidth: 'none',
          },
        },
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
    require("daisyui")({
      themes: ["light", "dark", "corporate", "nord", "emerald"]
    })
  ]
}

