import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Railway deploy invariants (ADR-0008). Migrations run once per deploy, in the
 * pre-deploy phase and nowhere else: not at install, build or start, and with
 * no per-environment override. A start path that migrates re-runs migrations on
 * every container restart.
 *
 * The commands below are pinned to exact values rather than pattern-matched,
 * because `npm run` indirection and npm's automatic pre/post hooks can hide a
 * migration behind any script name, and a `db:migrate` that stops migrating
 * would leave deploys silently unmigrated. Changing any of them should be a
 * deliberate decision that updates this test.
 */

const root = path.resolve(__dirname, "..");

function readJson(file: string) {
  return JSON.parse(readFileSync(path.join(root, file), "utf8"));
}

describe("railway.json", () => {
  const railway = readJson("railway.json");
  const { deploy } = railway;

  it("migrates in the pre-deploy phase and nothing else", () => {
    expect(deploy.preDeployCommand).toEqual(["npm run db:migrate"]);
  });

  it("starts with exactly `npm run start`", () => {
    expect(deploy.startCommand).toBe("npm run start");
  });

  it("leaves the build command to Railpack's `npm run build`", () => {
    expect(railway.build.buildCommand).toBeUndefined();
  });

  it("has no per-environment overrides", () => {
    expect(railway.environments).toBeUndefined();
  });

  it("health-checks a route that exists", () => {
    expect(deploy.healthcheckPath).toBe("/api/health");
    expect(existsSync(path.join(root, "src/app", deploy.healthcheckPath, "route.ts"))).toBe(true);
  });
});

describe("package.json", () => {
  const { scripts } = readJson("package.json");

  it("db:migrate runs drizzle-kit migrate", () => {
    expect(scripts["db:migrate"]).toBe("drizzle-kit migrate");
  });

  it("build only builds", () => {
    expect(scripts.build).toBe("next build");
  });

  it("start only starts the server", () => {
    expect(scripts.start).toBe("next start");
  });

  // npm runs these around `npm run start` on its own.
  it.each(["prestart", "poststart"])("has no %s hook", (name) => {
    expect(scripts[name]).toBeUndefined();
  });

  it("migrates from no script but db:migrate", () => {
    const migrating = Object.entries(scripts as Record<string, string>)
      .filter(([name]) => name !== "db:migrate")
      .filter(([, cmd]) => /db:migrate/.test(cmd) || /drizzle-kit\s+(migrate|push)/.test(cmd))
      .map(([name]) => name);
    expect(migrating).toEqual([]);
  });
});

describe("render.yaml", () => {
  it("is gone, so no second host config can drift from railway.json", () => {
    expect(existsSync(path.join(root, "render.yaml"))).toBe(false);
  });
});
