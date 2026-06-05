/** @type {import('tailwindcss').Config} */
export default {
  content: ['./client/index.html', './client/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      boxShadow: {
        neon: '0 0 28px rgba(0, 229, 255, 0.28)',
      },
    },
  },
  plugins: [],
};
