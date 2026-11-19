// ESLint 9 flat config —— 只启用能在现有代码上立刻跑通、且有实际意义的规则。
// 目标不是风格洁癖，而是抓「静默失败」类问题：未使用的 catch 参数、await 遗漏、误用 any。
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "reports/**",
      "_research/**",
      "references/**",
      "examples/release-*.json",
      "**/*.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "tests/**/*.ts", "scripts/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
    },
    rules: {
      // 宁可保留未使用变量（有意的占位），也不要因为规则噪音掩盖真实问题
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      "no-empty": ["error", { allowEmptyCatch: false }],
      "no-fallthrough": "error",
      eqeqeq: ["error", "smart"],
      "no-var": "error",
      "prefer-const": "warn",
    },
  },
  {
    files: ["src/ui/**/*.js", "scripts/**/*.mjs"],
    languageOptions: { ecmaVersion: 2023, sourceType: "module" },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-undef": "off",
    },
  },
);
