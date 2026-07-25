/** @type {import("prettier").Config} */
const config = {
  arrowParens: "always",
  plugins: ["prettier-plugin-tailwindcss"],
  printWidth: 100,
  proseWrap: "preserve",
  semi: true,
  singleQuote: false,
  tabWidth: 2,
  trailingComma: "all",
};

export default config;
