import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { buildDryRun, DEPLOYMENT, deployAgent, parseArgs, SETUP_STEPS } from "./deploy.mjs";

const execFileAsync = promisify(execFile);
const SOURCE_COMMIT = "e782c0b6a46f6c9a4d847bb5f591866b856afb32";

const fakeClient = ({ failCommand, failDelete = false } = {}) => {
  const calls = [];
  const client = {
    sandbox: {
      create: async (options) => {
        calls.push(["create", options]);
        return { success: true, data: { id: "sandbox-123" } };
      },
      start: async (sandboxId) => {
        calls.push(["start", sandboxId]);
      },
      shell: async (sandboxId, options) => {
        calls.push(["shell", sandboxId, options]);
        if (failCommand && options.cmd.includes(failCommand)) {
          return {
            success: true,
            data: { exitCode: 9, stdout: "", stderr: "failed", timedOut: false, durationMs: 1 },
          };
        }
        return {
          success: true,
          data: {
            exitCode: 0,
            stdout: options.cmd.includes("rev-parse HEAD") ? `${SOURCE_COMMIT}\n` : "",
            stderr: "",
            timedOut: false,
            durationMs: 1,
          },
        };
      },
      getSignedPreviewUrl: async (sandboxId, options) => {
        calls.push(["preview", sandboxId, options]);
        return {
          success: true,
          data: { url: "https://preview.sandock.test/?token=signed-value" },
        };
      },
      delete: async (sandboxId) => {
        calls.push(["delete", sandboxId]);
        if (failDelete) throw new Error("delete unavailable");
      },
    },
  };
  return { client, calls };
};

test("missing API key fails before creating a client", async () => {
  let factoryCalled = false;

  await assert.rejects(
    deployAgent({
      environment: {},
      clientFactory: () => {
        factoryCalled = true;
      },
    }),
    /SANDOCK_API_KEY is required/,
  );

  assert.equal(factoryCalled, false);
});

test("deploys in order with fixed resources and waits for consecutive readiness", async () => {
  const { client, calls } = fakeClient();
  const clientFactoryCalls = [];
  const statuses = [503, 200, 200, 503, 200, 200, 200];
  const requestedUrls = [];
  let clock = Date.parse("2026-09-03T00:00:00.000Z");

  const result = await deployAgent({
    environment: {
      SANDOCK_API_KEY: "sandock-secret",
      SANDOCK_BASE_URL: "https://api.sandock.test",
      SANDOCK_SPACE_ID: "space-7",
      OPENAI_API_KEY: "must-not-be-forwarded",
    },
    clientFactory: (options) => {
      clientFactoryCalls.push(options);
      return client;
    },
    fetchImpl: async (url) => {
      requestedUrls.push(url);
      return {
        ok: statuses.shift() === 200,
        body: { cancel: async () => {} },
      };
    },
    sleep: async (milliseconds) => {
      clock += milliseconds;
    },
    now: () => clock,
    log: () => {},
  });

  assert.deepEqual(clientFactoryCalls, [
    {
      baseUrl: "https://api.sandock.test",
      headers: { Authorization: "Bearer sandock-secret" },
    },
  ]);
  assert.deepEqual(calls[0], [
    "create",
    {
      image: "node:24.18.0-bookworm-slim",
      title: "Bunny Agent",
      command: ["sleep", "infinity"],
      env: { SANDBOX_PROVIDER: "local" },
      cpu: 2000,
      memory: 4096,
      activeDeadlineSeconds: 3600,
      autoDeleteInterval: 0,
      spaceId: "space-7",
    },
  ]);
  assert.deepEqual(calls[1], ["start", "sandbox-123"]);

  const shellOptions = calls.filter(([kind]) => kind === "shell").map(([, , options]) => options);
  const shellCommands = shellOptions.map(({ cmd }) => cmd);
  assert.deepEqual(
    shellCommands,
    SETUP_STEPS.map(({ command }) => command),
  );
  assert.match(shellCommands.join("\n"), /pnpm install --frozen-lockfile/);
  assert.match(shellCommands.join("\n"), /--filter @bunny-agent\/runner-cli\.\.\. build/);
  assert.match(shellCommands.join("\n"), /--filter @bunny-agent\/web build/);
  assert.match(shellCommands.at(-1), /SANDBOX_PROVIDER=local/);
  assert.ok(shellOptions.every(({ timeoutMs }) => timeoutMs === DEPLOYMENT.shellTimeoutMs));
  assert.doesNotMatch(JSON.stringify(calls), /must-not-be-forwarded/);
  assert.deepEqual(calls.at(-1), [
    "preview",
    "sandbox-123",
    { port: DEPLOYMENT.port, expiresIn: DEPLOYMENT.lifetimeSeconds },
  ]);
  assert.equal(requestedUrls.length, 7);
  assert.ok(
    requestedUrls.every((url) => url === "https://preview.sandock.test/example?token=signed-value"),
  );
  assert.deepEqual(result, {
    sandboxId: "sandbox-123",
    previewUrl: "https://preview.sandock.test/example?token=signed-value",
    expiresAt: "2026-09-03T01:00:00.000Z",
    sourceCommit: SOURCE_COMMIT,
  });
  assert.equal(
    calls.some(([kind]) => kind === "delete"),
    false,
  );
});

test("failed build deletes the incomplete sandbox and redacts secrets", async () => {
  const { client, calls } = fakeClient({ failCommand: "pnpm install --frozen-lockfile" });
  const logs = [];
  const secret = "sandock-secret-value";

  await assert.rejects(
    deployAgent({
      environment: { SANDOCK_API_KEY: secret },
      clientFactory: () => client,
      log: (message) => logs.push(message),
    }),
    (error) => {
      assert.equal(error.sandboxId, "sandbox-123");
      assert.equal(error.cleanupFailed, false);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );

  assert.deepEqual(calls.at(-1), ["delete", "sandbox-123"]);
  assert.doesNotMatch(logs.join("\n"), new RegExp(secret));
});

test("failed cleanup returns the sandbox ID and manual cleanup instruction", async () => {
  const { client } = fakeClient({
    failCommand: "pnpm install --frozen-lockfile",
    failDelete: true,
  });

  await assert.rejects(
    deployAgent({
      environment: { SANDOCK_API_KEY: "secret" },
      clientFactory: () => client,
      log: () => {},
    }),
    (error) => {
      assert.equal(error.sandboxId, "sandbox-123");
      assert.equal(error.cleanupFailed, true);
      assert.equal(error.manualCleanup, "Delete sandbox sandbox-123 manually in Sandock.");
      return true;
    },
  );
});

test("a Preview readiness failure deletes the incomplete sandbox", async () => {
  const { client, calls } = fakeClient();
  let clock = 0;

  await assert.rejects(
    deployAgent({
      environment: { SANDOCK_API_KEY: "secret" },
      clientFactory: () => client,
      fetchImpl: async () => ({ ok: false, body: null }),
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
      now: () => clock,
      log: () => {},
    }),
    /Preview did not return 3 consecutive successful responses/,
  );

  assert.deepEqual(calls.at(-1), ["delete", "sandbox-123"]);
});

test("client initialization errors are redacted", async () => {
  const secret = "sandock-secret-value";

  await assert.rejects(
    deployAgent({
      environment: { SANDOCK_API_KEY: secret },
      clientFactory: () => {
        throw new Error(`authorization failed for ${secret}`);
      },
      log: () => {},
    }),
    (error) => {
      assert.match(error.message, /\[REDACTED\]/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      assert.equal(error.cause, undefined);
      return true;
    },
  );
});

test("dry run contains the deployment plan but creates no client or resource", () => {
  const result = buildDryRun({
    SANDOCK_SPACE_ID: "space-dry-run",
    OPENAI_API_KEY: "not-used",
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.create.spaceId, "space-dry-run");
  assert.deepEqual(result.create.command, ["sleep", "infinity"]);
  assert.equal(result.preview.path, "/example");
  assert.equal(result.preview.expiresIn, 3600);
  assert.doesNotMatch(JSON.stringify(result), /not-used/);
});

test("dry-run CLI succeeds without credentials and emits JSON", async () => {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [fileURLToPath(new URL("./deploy.mjs", import.meta.url)), "--dry-run", "--json"],
    { env: {} },
  );

  assert.equal(stderr, "");
  assert.equal(JSON.parse(stdout).dryRun, true);
});

test("unknown CLI arguments are rejected", () => {
  assert.throws(() => parseArgs(["--deploy-all"]), /Unknown argument/);
});
