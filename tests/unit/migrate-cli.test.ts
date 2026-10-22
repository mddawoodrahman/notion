import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { resolveMigrationOperation } from "../../db/migrate.js";

describe("db:migrate CLI routing (BUG-005)", () => {
  it("routes `npm run db:migrate` (no argument) to running migrations", () => {
    expect(resolveMigrationOperation(["node", "db/migrate.ts"])).toBe("run_migrations");
    expect(resolveMigrationOperation(["node", "db/migrate.ts", "up"])).toBe("run_migrations");
  });

  it("routes `npm run db:migrate -- status` to status inspection, not runMigrations", () => {
    expect(resolveMigrationOperation(["node", "db/migrate.ts", "status"])).toBe("show_status");
  });

  it("shows that a hardcoded `up` in the npm script would shadow a user-provided command", () => {
    // Documents the exact BUG-005 failure mode: with the old script ("tsx db/migrate.ts up"),
    // `npm run db:migrate -- status` reached the CLI as argv[2]="up" and applied migrations.
    expect(resolveMigrationOperation(["node", "db/migrate.ts", "up", "status"])).toBe("run_migrations");
  });

  it("rejects unknown commands", () => {
    expect(resolveMigrationOperation(["node", "db/migrate.ts", "down"])).toBe("unknown");
  });

  it("keeps the package.json script free of a hardcoded command so `-- status` reaches argv[2]", async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(process.cwd(), "package.json"), "utf8")
    ) as { scripts: Record<string, string> };
    const script = packageJson.scripts["db:migrate"];

    expect(script).toBeDefined();
    expect(script).toContain("db/migrate.ts");
    // No trailing command: `-- status` must be the first script argument
    expect(script).not.toMatch(/(^|\s)(up|status)\s*$/);
  });
});
