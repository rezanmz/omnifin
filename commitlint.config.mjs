const config = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "header-max-length": [2, "always", 100],
    "scope-enum": [
      2,
      "always",
      [
        "auth",
        "ci",
        "connectors",
        "db",
        "deps",
        "docs",
        "gateway",
        "release",
        "security",
        "ui",
        "web",
      ],
    ],
  },
};

export default config;
