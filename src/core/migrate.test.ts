import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { migrateLegacyMill } from "./migrate.js";
import { projectStateDir } from "./paths.js";
import { SqliteStateStore } from "./store.sqlite.js";

// Build a fake legacy `.mill/` dir at <repoRoot>/.mill/ with a populated
// SQLite DB. Returns the repoRoot so the caller can invoke the importer.
async function makeLegacyRepo(opts: { withJournal?: boolean } = {}): Promise<{
  repoRoot: string;
  millHome: string;
}> {
  const repoRoot = await mkdtemp(join(tmpdir(), "mill-mig-repo-"));
  const millHome = await mkdtemp(join(tmpdir(), "mill-mig-home-"));
  const millDir = join(repoRoot, ".mill");
  mkdirSync(millDir, { recursive: true });
  const dbPath = join(millDir, "mill.db");

  // Populate via the production store so the legacy DB has the same
  // schema and indexes the migrator will read from.
  const legacy = new SqliteStateStore(dbPath);
  legacy.init();
  legacy.createRun({
    id: "r1",
    status: "completed",
    kind: "ui",
    created_at: 1_700_000_000_000,
    requirement_path: "/legacy/req1.md",
  });
  legacy.startStage("r1", "spec");
  legacy.finishStage("r1", "spec", {
    status: "completed",
    artifact_path: "/legacy/spec.md",
  });
  legacy.appendEvent("r1", "spec", "stage_started", { hint: "legacy" });
  legacy.insertFinding({
    run_id: "r1",
    iteration: 1,
    critic: "security",
    severity: "HIGH",
    title: "Legacy issue",
    detail_path: "/legacy/sec.md",
  });
  legacy.suppressFingerprint("security|HIGH|legacy issue", "noisy");
  legacy.saveSession("r1", "implement", "sess-abc", 0.42);
  legacy.saveClarifications("r1", {
    kind: "ui",
    questions: [{ id: "q1", question: "ok?", why: "because" }],
    answers: { q1: "yes" },
  });
  legacy.close();

  if (opts.withJournal) {
    writeFileSync(join(millDir, "journal.md"), "### r1\nlegacy entry\n", "utf8");
  }

  return { repoRoot, millHome };
}

describe("migrateLegacyMill", () => {
  it("returns migrated:false when no legacy DB exists", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "mill-mig-empty-"));
    const millHome = await mkdtemp(join(tmpdir(), "mill-mig-home-"));
    process.env.MILL_HOME = millHome;
    const central = new SqliteStateStore(":memory:");
    central.init();
    central.addProject({
      id: "p1-aaaa",
      name: "p1",
      root_path: repoRoot,
    });
    const result = await migrateLegacyMill({
      repoRoot,
      projectId: "p1-aaaa",
      store: central,
    });
    assert.equal(result.migrated, false);
    central.close();
  });

  it("imports rows and copies state files when central is empty", async () => {
    const { repoRoot, millHome } = await makeLegacyRepo({ withJournal: true });
    process.env.MILL_HOME = millHome;

    const central = new SqliteStateStore(":memory:");
    central.init();
    central.addProject({
      id: "p1-aaaa",
      name: "p1",
      root_path: repoRoot,
    });

    const result = await migrateLegacyMill({
      repoRoot,
      projectId: "p1-aaaa",
      store: central,
    });

    assert.equal(result.migrated, true);
    assert.ok(result.importedCounts);
    assert.equal(result.importedCounts!.runs, 1);
    assert.equal(result.importedCounts!.stages, 1);
    assert.equal(result.importedCounts!.events, 1);
    assert.equal(result.importedCounts!.findings, 1);
    assert.equal(result.importedCounts!.suppressed_findings, 1);
    assert.equal(result.importedCounts!.clarifications, 1);
    assert.equal(result.importedCounts!.sessions, 1);

    // Run row carries the new project_id.
    const run = central.getRun("r1");
    assert.ok(run);
    assert.equal(run.project_id, "p1-aaaa");
    assert.equal(run.requirement_path, "/legacy/req1.md");

    // Sibling tables came over.
    const stage = central.getStage("r1", "spec");
    assert.ok(stage);
    assert.equal(stage.artifact_path, "/legacy/spec.md");
    const findings = central.listFindings("r1");
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.title, "Legacy issue");

    // Marker file written; legacy DB renamed (still present under
    // the new name); state file copied.
    const markerPath = join(repoRoot, ".mill", "migrated-to-central.json");
    assert.equal(existsSync(markerPath), true);
    assert.equal(existsSync(join(repoRoot, ".mill", "mill.db")), false);
    assert.ok(result.legacyDbBackupPath);
    assert.equal(existsSync(result.legacyDbBackupPath!), true);

    const stateDir = projectStateDir("p1-aaaa", { MILL_HOME: millHome });
    const journalCopy = await readFile(join(stateDir, "journal.md"), "utf8");
    assert.match(journalCopy, /legacy entry/);

    central.close();
  });

  it("is idempotent on a second call", async () => {
    const { repoRoot, millHome } = await makeLegacyRepo();
    process.env.MILL_HOME = millHome;

    const central = new SqliteStateStore(":memory:");
    central.init();
    central.addProject({
      id: "p1-aaaa",
      name: "p1",
      root_path: repoRoot,
    });

    const first = await migrateLegacyMill({
      repoRoot,
      projectId: "p1-aaaa",
      store: central,
    });
    assert.equal(first.migrated, true);

    // The marker file is present, so a second run reports
    // `migrated:false` with an "already migrated" warning rather than
    // re-importing rows.
    const second = await migrateLegacyMill({
      repoRoot,
      projectId: "p1-aaaa",
      store: central,
    });
    assert.equal(second.migrated, false);
    assert.deepEqual(second.warnings, ["already migrated"]);

    // Counts in the central DB unchanged after the no-op second run.
    assert.equal(central.listRuns({ limit: 100 }).length, 1);
    const findings = central.listFindings("r1");
    assert.equal(findings.length, 1);

    central.close();
  });

  it("preserves existing rows on conflict (INSERT OR IGNORE keyed on id)", async () => {
    const { repoRoot, millHome } = await makeLegacyRepo();
    process.env.MILL_HOME = millHome;

    const central = new SqliteStateStore(":memory:");
    central.init();
    central.addProject({
      id: "p1-aaaa",
      name: "p1",
      root_path: repoRoot,
    });
    // Pre-existing central row with the same id but different content.
    central.createRun({
      id: "r1",
      project_id: "p1-aaaa",
      status: "running",
      kind: "cli",
      created_at: 999,
      requirement_path: "/central/keep-me.md",
    });

    const result = await migrateLegacyMill({
      repoRoot,
      projectId: "p1-aaaa",
      store: central,
    });
    assert.equal(result.migrated, true);
    // Legacy run was NOT imported because the central DB already had id=r1.
    assert.equal(result.importedCounts!.runs, 0);
    const run = central.getRun("r1");
    assert.ok(run);
    assert.equal(run.requirement_path, "/central/keep-me.md");
    assert.equal(run.kind, "cli");
    central.close();
  });

  it("warns when state file exists on both sides — central wins", async () => {
    const { repoRoot, millHome } = await makeLegacyRepo({ withJournal: true });
    process.env.MILL_HOME = millHome;

    const central = new SqliteStateStore(":memory:");
    central.init();
    central.addProject({
      id: "p1-aaaa",
      name: "p1",
      root_path: repoRoot,
    });

    // Pre-populate the central state dir with a non-empty journal.md
    // so the migration must NOT overwrite it.
    const stateDir = projectStateDir("p1-aaaa", { MILL_HOME: millHome });
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "journal.md"), "central content\n", "utf8");

    const result = await migrateLegacyMill({
      repoRoot,
      projectId: "p1-aaaa",
      store: central,
    });
    assert.equal(result.migrated, true);
    // Warning surfaced for the conflicting state file.
    const ws = result.warnings ?? [];
    assert.ok(
      ws.some((w) => w.includes("state-file conflict") && w.includes("journal.md")),
      `expected state-file conflict warning, got: ${JSON.stringify(ws)}`,
    );

    // Central content preserved.
    const survived = await readFile(join(stateDir, "journal.md"), "utf8");
    assert.match(survived, /central content/);
    central.close();
  });

  it("leaves runs/ workdir directory untouched", async () => {
    const { repoRoot, millHome } = await makeLegacyRepo();
    process.env.MILL_HOME = millHome;

    // Drop a fake workdir so we can confirm it's preserved.
    const workdirPath = join(repoRoot, ".mill", "runs", "r1", "workdir");
    mkdirSync(workdirPath, { recursive: true });
    writeFileSync(join(workdirPath, "marker.txt"), "hello", "utf8");

    const central = new SqliteStateStore(":memory:");
    central.init();
    central.addProject({
      id: "p1-aaaa",
      name: "p1",
      root_path: repoRoot,
    });
    const result = await migrateLegacyMill({
      repoRoot,
      projectId: "p1-aaaa",
      store: central,
    });
    assert.equal(result.migrated, true);

    assert.equal(existsSync(join(workdirPath, "marker.txt")), true);
    const entries = await readdir(join(repoRoot, ".mill", "runs"));
    assert.ok(entries.includes("r1"));

    // Marker file content includes the importedCounts payload.
    const marker = JSON.parse(
      readFileSync(join(repoRoot, ".mill", "migrated-to-central.json"), "utf8"),
    ) as { projectId: string; importedCounts: { runs: number } };
    assert.equal(marker.projectId, "p1-aaaa");
    assert.equal(marker.importedCounts.runs, 1);

    central.close();
  });
});
