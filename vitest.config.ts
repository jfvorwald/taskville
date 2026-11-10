import { defineConfig } from "vitest/config";

const names = ["protocol", "domain", "adapters", "demo"].map((n) => `packages/${n}`);
const apps = ["engine", "cli", "web"].map((n) => `apps/${n}`);
const deploys = ["staging"].map((n) => `deploy/${n}`);
const scripts = ["retro", "bootstrap"].map((n) => `scripts/${n}`);

export default defineConfig({
  test: {
    projects: [...names, ...apps, ...deploys, ...scripts].map((dir) => ({
      test: {
        name: `@taskville/${dir.split("/")[1]}${dir.startsWith("deploy/") ? "-worker" : ""}`,
        root: dir,
        include: ["test/**/*.test.ts"],
      },
    })),
  },
});
