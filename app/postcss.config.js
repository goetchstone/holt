// /app/postcss.config.js
// Tailwind 4: the @tailwindcss/postcss plugin replaces the v3 tailwindcss
// plugin and bundles autoprefixer, so neither is listed separately anymore.
module.exports = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
