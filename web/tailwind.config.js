/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace",
        ],
      },
      colors: {
        ink: {
          900: "#0d1117",
          800: "#161b22",
          700: "#1f2937",
          600: "#273141",
          500: "#3a4658",
          300: "#9ba3ae",
          200: "#c8cdd4",
          100: "#e6e9ed",
        },
      },
    },
  },
  plugins: [],
};
