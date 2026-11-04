import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "core",
          root: "./packages/core",
          include: ["test/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "agent",
          root: "./packages/agent",
          include: ["test/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "sdk",
          root: "./packages/sdk",
          include: ["test/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "server",
          root: "./apps/server",
          include: ["test/**/*.test.ts"],
          environment: "node",
          testTimeout: 30000,
          fileParallelism: false,
        },
      },
      {
        test: {
          name: "web",
          root: "./apps/web",
          include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
          environment: "node",
        },
      },
    ],
  },
});
