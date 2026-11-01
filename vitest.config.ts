import { defineConfig } from "vitest/config";

const names = ["protocol", "domain", "adapters", "demo"].map((n) => `packages/${n}`);
const apps = ["engine", "cli", "web"].map((n) => `apps/${n}`);
const scripts = ["retro"].map((n) => `scripts/${n}`);

export default defineConfig({
  test: {
    projects: [...names, ...apps, ...scripts].map((dir) => ({
      test: {
        name: `@taskville/${dir.split("/")[1]}`,
        root: dir,
        include: ["test/**/*.test.ts"],
      },
    })),
  },
});
