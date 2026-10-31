import { defineConfig } from "vitest/config";

const names = ["protocol", "domain", "adapters", "demo"].map((n) => `packages/${n}`);
const apps = ["engine", "cli"].map((n) => `apps/${n}`);

export default defineConfig({
  test: {
    projects: [...names, ...apps].map((dir) => ({
      test: {
        name: `@taskville/${dir.split("/")[1]}`,
        root: dir,
        include: ["test/**/*.test.ts"],
      },
    })),
  },
});
