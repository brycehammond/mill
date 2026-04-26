import { strict as assert } from "node:assert";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  BindConfigError,
  parseBindMode,
  primaryLanIPv4,
  resolveBindHost,
  validateBind,
} from "./bind.js";

describe("parseBindMode", () => {
  it("defaults missing/empty input to loopback", () => {
    assert.equal(parseBindMode(undefined), "loopback");
    assert.equal(parseBindMode(null), "loopback");
    assert.equal(parseBindMode(""), "loopback");
  });

  it("accepts the three valid modes (case-insensitive)", () => {
    assert.equal(parseBindMode("loopback"), "loopback");
    assert.equal(parseBindMode("LAN"), "lan");
    assert.equal(parseBindMode("All"), "all");
  });

  it("returns null for invalid modes", () => {
    assert.equal(parseBindMode("public"), null);
    assert.equal(parseBindMode("vpn"), null);
  });
});

describe("primaryLanIPv4", () => {
  it("returns either a string or null without throwing", () => {
    const v = primaryLanIPv4();
    assert.ok(v === null || typeof v === "string");
  });
});

describe("resolveBindHost", () => {
  it("loopback honors envHost when present", () => {
    const r = resolveBindHost("loopback", "127.0.0.1");
    assert.equal(r.hostname, "127.0.0.1");
    assert.equal(r.isLoopback, true);
  });

  it("loopback falls back to 127.0.0.1 when envHost is unset", () => {
    const r = resolveBindHost("loopback", undefined);
    assert.equal(r.hostname, "127.0.0.1");
  });

  it("all binds to 0.0.0.0", () => {
    const r = resolveBindHost("all", undefined);
    assert.equal(r.hostname, "0.0.0.0");
    assert.equal(r.isLoopback, false);
  });
});

describe("validateBind — auth requirement (AC-3)", () => {
  it("loopback never requires auth", () => {
    const r = validateBind(
      { mode: "loopback", authConfigured: false },
      "127.0.0.1",
    );
    assert.equal(r.isLoopback, true);
    assert.equal(r.tls, null);
  });

  it("--bind lan without auth fails fast with a clear error", () => {
    assert.throws(
      () =>
        validateBind(
          { mode: "lan", authConfigured: false, insecure: true },
          undefined,
        ),
      (err: unknown) => {
        assert.ok(err instanceof BindConfigError);
        assert.match((err as Error).message, /requires authentication/);
        assert.match((err as Error).message, /mill auth init/);
        return true;
      },
    );
  });

  it("--bind all without auth fails fast with a clear error", () => {
    assert.throws(
      () =>
        validateBind(
          { mode: "all", authConfigured: false, insecure: true },
          undefined,
        ),
      (err: unknown) => {
        assert.ok(err instanceof BindConfigError);
        assert.match((err as Error).message, /requires authentication/);
        return true;
      },
    );
  });
});

describe("validateBind — HTTPS / --insecure rule", () => {
  it("non-loopback bind without TLS or --insecure fails", () => {
    assert.throws(
      () =>
        validateBind(
          { mode: "all", authConfigured: true },
          undefined,
        ),
      (err: unknown) => {
        assert.ok(err instanceof BindConfigError);
        assert.match((err as Error).message, /HTTPS or --insecure/);
        return true;
      },
    );
  });

  it("non-loopback bind with --insecure passes (no TLS material)", () => {
    const r = validateBind(
      { mode: "all", authConfigured: true, insecure: true },
      undefined,
    );
    assert.equal(r.hostname, "0.0.0.0");
    assert.equal(r.tls, null);
    assert.equal(r.insecure, true);
  });

  it("non-loopback bind with TLS material passes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mill-bind-tls-"));
    const certPath = join(dir, "cert.pem");
    const keyPath = join(dir, "key.pem");
    // Mock files: validateBind only checks existsSync, not contents.
    await writeFile(certPath, "MOCK CERT", "utf8");
    await writeFile(keyPath, "MOCK KEY", "utf8");
    const r = validateBind(
      {
        mode: "all",
        authConfigured: true,
        certPath,
        keyPath,
      },
      undefined,
    );
    assert.deepEqual(r.tls, { certPath, keyPath });
  });

  it("half-configured TLS (cert without key) is a hard fail", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mill-bind-half-"));
    const certPath = join(dir, "cert.pem");
    await writeFile(certPath, "MOCK CERT", "utf8");
    assert.throws(
      () =>
        validateBind(
          {
            mode: "all",
            authConfigured: true,
            certPath,
          },
          undefined,
        ),
      (err: unknown) => {
        assert.ok(err instanceof BindConfigError);
        assert.match((err as Error).message, /half-configured/);
        return true;
      },
    );
  });

  it("missing cert/key files throw with a clear message", () => {
    assert.throws(
      () =>
        validateBind(
          {
            mode: "all",
            authConfigured: true,
            certPath: "/no/such/cert.pem",
            keyPath: "/no/such/key.pem",
          },
          undefined,
        ),
      (err: unknown) => {
        assert.ok(err instanceof BindConfigError);
        assert.match((err as Error).message, /file not found/);
        return true;
      },
    );
  });
});
