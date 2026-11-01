import type { Config } from "tailwindcss";
// Applied Computing design tokens, light theme
export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#faf9f6", card: "#ffffff", "card-alt": "#f7f6f3", ink: "#18181c",
        "ink-2": "#555555", muted: "#767676", red: "#e9311a", nav: "#18181c", "nav-text": "#c8d5de",
        blue: "#1f4381", green: "#188258", "green-2": "#22a870", amber: "#9a6700",
      },
      fontFamily: { sans: ["Figtree", "Arial", "sans-serif"], mono: ["Space Grotesk", "sans-serif"] },
      borderRadius: { DEFAULT: "6px", lg: "8px" },
      boxShadow: { sm: "0 1px 2px rgba(0,0,0,0.06)" },
    },
  },
  plugins: [],
} satisfies Config;
