#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { createSandockClient } from "sandock";

export const DEPLOYMENT = Object.freeze({
  image: "node:24.18.0-bookworm-slim",
  port: 3000,
  cpu: 2000,
  memory: 4096,
  lifetimeSeconds: 3600,
  autoDeleteInterval: 0,
  repository: "https://github.com/buda-ai/bunny-agent.git",
  branch: "main",
  appDirectory: "/workspace/bunny-agent",
  readyConsecutiveSuccesses: 3,
  probeIntervalMs: 1000,
  probeTimeoutMs: 5000,
  readyTimeoutMs: 120000,
  shellTimeoutMs: 900000,
});

export const SETUP_STEPS = Object.freeze([
  {
    name: "install system dependencies",
    command:
      "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*",
  },
  {
    name: "install pnpm",
    command: "npm install --global pnpm@10.11.0",
  },
  {
    name: "clone Bunny Agent",
    command: `git clone --depth 1 --branch ${DEPLOYMENT.branch} ${DEPLOYMENT.repository} ${DEPLOYMENT.appDirectory}`,
  },
  {
    name: "read source commit",
    command: `git -C ${DEPLOYMENT.appDirectory} rev-parse HEAD`,
    capture: "sourceCommit",
  },
  {
    name: "install Bunny Agent dependencies",
    command: `cd ${DEPLOYMENT.appDirectory} && pnpm install --frozen-lockfile`,
  },
  {
    name: "build Bunny Agent runner",
    command: `cd ${DEPLOYMENT.appDirectory} && pnpm --filter @bunny-agent/runner-cli... build`,
  },
  {
    name: "build Bunny Agent web",
    command: `cd ${DEPLOYMENT.appDirectory} && pnpm --filter @bunny-agent/web build`,
  },
  {
    name: "start Bunny Agent web",
    command: `cd ${DEPLOYMENT.appDirectory} && rm -f /tmp/bunny-agent-web.log /tmp/bunny-agent-web.pid && setsid sh -c 'echo $$ > /tmp/bunny-agent-web.pid; exec env SANDBOX_PROVIDER=local NEXT_TELEMETRY_DISABLED=1 pnpm --filter @bunny-agent/web start --hostname 0.0.0.0 --port ${DEPLOYMENT.port} >> /tmp/bunny-agent-web.log 2>&1' < /dev/null > /dev/null 2>&1 &`,
  },
]);

const HELP = `Usage: deploy.mjs [--dry-run] [--json]

Environment:
  SANDOCK_API_KEY   Required for a real deployment
  SANDOCK_BASE_URL  Optional Sandock API base URL
  SANDOCK_SPACE_ID  Optional Sandock space ID
`;

export class DeploymentError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "DeploymentError";
    this.sandboxId = options.sandboxId;
    this.cleanupFailed = options.cleanupFailed ?? false;
    this.manualCleanup = options.manualCleanup;
  }
}

export const parseArgs = (argv) => {
  const options = { dryRun: false, json: false, help: false };

  for (const argument of argv) {
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }

  return options;
};

export const resolveConfig = (environment, { requireApiKey = true } = {}) => {
  const apiKey = environment.SANDOCK_API_KEY?.trim();
  if (requireApiKey && !apiKey) {
    throw new Error("SANDOCK_API_KEY is required for deployment");
  }

  const baseUrl = environment.SANDOCK_BASE_URL?.trim() || undefined;
  if (baseUrl) {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("SANDOCK_BASE_URL must use http or https");
    }
  }

  return {
    apiKey,
    baseUrl,
    spaceId: environment.SANDOCK_SPACE_ID?.trim() || undefined,
  };
};

export const redactSecrets = (value, secrets = []) => {
  let result = String(value);
  for (const secret of secrets.filter(Boolean)) {
    result = result.split(secret).join("[REDACTED]");
  }
  return result;
};

const createOptions = (spaceId) => ({
  image: DEPLOYMENT.image,
  title: "Bunny Agent",
  command: ["sleep", "infinity"],
  env: { SANDBOX_PROVIDER: "local" },
  cpu: DEPLOYMENT.cpu,
  memory: DEPLOYMENT.memory,
  activeDeadlineSeconds: DEPLOYMENT.lifetimeSeconds,
  autoDeleteInterval: DEPLOYMENT.autoDeleteInterval,
  ...(spaceId ? { spaceId } : {}),
});

export const buildDryRun = (environment = {}) => {
  const config = resolveConfig(environment, { requireApiKey: false });
  return {
    dryRun: true,
    create: createOptions(config.spaceId),
    setupSteps: SETUP_STEPS.map(({ name, command }) => ({ name, command })),
    preview: {
      port: DEPLOYMENT.port,
      path: "/example",
      expiresIn: DEPLOYMENT.lifetimeSeconds,
      consecutiveSuccesses: DEPLOYMENT.readyConsecutiveSuccesses,
    },
  };
};

const shellSucceeded = (result) => result?.exitCode === 0 || result?.code === 0;

const runShellStep = async (client, sandboxId, step, log) => {
  log(`Running: ${step.name}`);
  const response = await client.sandbox.shell(
    sandboxId,
    { cmd: step.command, timeoutMs: DEPLOYMENT.shellTimeoutMs },
    {
      onStdout: (chunk) => log(redactSecrets(chunk)),
      onStderr: (chunk) => log(redactSecrets(chunk)),
    },
  );
  const result = response.data;

  if (!shellSucceeded(result)) {
    throw new Error(
      `${step.name} failed with exit code ${result?.exitCode ?? result?.code ?? "unknown"}`,
    );
  }

  return result;
};

const previewUrlForExample = (signedUrl) => {
  const previewUrl = new URL(signedUrl);
  previewUrl.pathname = "/example";
  return previewUrl.toString();
};

const probePreview = async (previewUrl, fetchImpl, timeoutMs) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(previewUrl, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
    });
    try {
      await response.body?.cancel?.();
    } catch {
      // The HTTP status is sufficient for readiness; body cancellation is best effort.
    }
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
};

export const waitForPreview = async (
  previewUrl,
  {
    fetchImpl = globalThis.fetch,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now = Date.now,
    timeoutMs = DEPLOYMENT.readyTimeoutMs,
    intervalMs = DEPLOYMENT.probeIntervalMs,
    probeTimeoutMs = DEPLOYMENT.probeTimeoutMs,
    requiredSuccesses = DEPLOYMENT.readyConsecutiveSuccesses,
  } = {},
) => {
  const deadline = now() + timeoutMs;
  let consecutiveSuccesses = 0;

  while (now() < deadline) {
    const succeeded = await probePreview(previewUrl, fetchImpl, probeTimeoutMs);
    consecutiveSuccesses = succeeded ? consecutiveSuccesses + 1 : 0;
    if (consecutiveSuccesses >= requiredSuccesses) return;
    await sleep(intervalMs);
  }

  throw new Error(
    `Preview did not return ${requiredSuccesses} consecutive successful responses within ${timeoutMs}ms`,
  );
};

export const deployAgent = async ({
  environment = process.env,
  clientFactory = createSandockClient,
  fetchImpl = globalThis.fetch,
  sleep,
  now = Date.now,
  log = (message) => process.stderr.write(`${message}\n`),
} = {}) => {
  const config = resolveConfig(environment);
  const secrets = [config.apiKey];
  const safeLog = (message) => log(redactSecrets(message, secrets));

  let client;
  let sandboxId;
  let sandboxExpiresAt;

  try {
    client = clientFactory({
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    safeLog("Creating Sandock sandbox");
    sandboxExpiresAt = now() + DEPLOYMENT.lifetimeSeconds * 1000;
    const sandbox = await client.sandbox.create(createOptions(config.spaceId));
    sandboxId = sandbox.data?.id;
    if (!sandboxId) throw new Error("Sandock create response did not include a sandbox ID");

    safeLog(`Starting Sandock sandbox ${sandboxId}`);
    await client.sandbox.start(sandboxId);

    let sourceCommit;
    for (const step of SETUP_STEPS) {
      const result = await runShellStep(client, sandboxId, step, safeLog);
      if (step.capture === "sourceCommit") sourceCommit = result.stdout?.trim();
    }

    if (!sourceCommit || !/^[0-9a-f]{40}$/i.test(sourceCommit)) {
      throw new Error("Bunny Agent source commit could not be determined");
    }

    const signedPreview = await client.sandbox.getSignedPreviewUrl(sandboxId, {
      port: DEPLOYMENT.port,
      expiresIn: DEPLOYMENT.lifetimeSeconds,
    });
    const previewUrl = previewUrlForExample(signedPreview.data.url);
    safeLog("Waiting for Bunny Agent Preview readiness");
    await waitForPreview(previewUrl, { fetchImpl, sleep, now });

    return {
      sandboxId,
      previewUrl,
      expiresAt: new Date(sandboxExpiresAt).toISOString(),
      sourceCommit,
    };
  } catch (error) {
    let cleanupFailed = false;
    let manualCleanup;

    if (client && sandboxId) {
      try {
        safeLog(`Deleting incomplete Sandock sandbox ${sandboxId}`);
        await client.sandbox.delete(sandboxId);
      } catch (cleanupError) {
        cleanupFailed = true;
        manualCleanup = `Delete sandbox ${sandboxId} manually in Sandock.`;
        safeLog(`Cleanup failed for sandbox ${sandboxId}: ${cleanupError}`);
      }
    }

    throw new DeploymentError(redactSecrets(error, secrets), {
      sandboxId,
      cleanupFailed,
      manualCleanup,
    });
  }
};

const printResult = (result, json) => {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  for (const [key, value] of Object.entries(result)) {
    process.stdout.write(`${key}: ${typeof value === "object" ? JSON.stringify(value) : value}\n`);
  }
};

export const runCli = async (argv = process.argv.slice(2), environment = process.env) => {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      process.stdout.write(HELP);
      return 0;
    }

    if (options.dryRun) {
      printResult(buildDryRun(environment), options.json);
      return 0;
    }

    printResult(await deployAgent({ environment }), options.json);
    return 0;
  } catch (error) {
    const failure = {
      error: error instanceof Error ? error.message : String(error),
      ...(error?.sandboxId ? { sandboxId: error.sandboxId } : {}),
      ...(error?.cleanupFailed ? { cleanupFailed: true } : {}),
      ...(error?.manualCleanup ? { manualCleanup: error.manualCleanup } : {}),
    };
    process.stderr.write(`${JSON.stringify(failure)}\n`);
    return 1;
  }
};

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await runCli();
}
