#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { pathToFileURL } from "node:url";

import { createSandockClient } from "sandock";

import { deployAgent, redactSecrets } from "./deploy.mjs";

const DEFAULT_CAPTURE_TIMEOUT_MS = 10 * 60 * 1000;
const RAW_KEY_PATTERN = /^sk-[a-f0-9]{48}$/;

export const parseCaptureArgs = (argv, environment = process.env) => {
  const options = {
    cdpUrl: environment.BROWSER_CDP_URL?.trim() || "",
    json: false,
    timeoutMs: DEFAULT_CAPTURE_TIMEOUT_MS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--cdp-url") options.cdpUrl = argv[++index] ?? "";
    else if (argument === "--timeout-ms") options.timeoutMs = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }

  if (!options.cdpUrl) throw new Error("BROWSER_CDP_URL or --cdp-url is required");
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1000) {
    throw new Error("--timeout-ms must be an integer of at least 1000");
  }

  const cdpUrl = new URL(options.cdpUrl);
  if (cdpUrl.protocol !== "http:" && cdpUrl.protocol !== "https:") {
    throw new Error("The CDP URL must use http or https");
  }

  return { ...options, cdpUrl: cdpUrl.toString() };
};

export const findRawApiKey = (value) => {
  if (!value || typeof value !== "object") return null;

  if (!Array.isArray(value)) {
    for (const field of ["raw", "key"]) {
      if (
        Object.hasOwn(value, field) &&
        typeof value[field] === "string" &&
        RAW_KEY_PATTERN.test(value[field])
      ) {
        return value[field];
      }
    }
  }

  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const key = findRawApiKey(child);
    if (key) return key;
  }

  return null;
};

export const isCandidateApiResponse = ({ status, url }, type) => {
  if (type !== "Fetch" && type !== "XHR") return false;
  if (status < 200 || status >= 300) return false;

  const responseUrl = new URL(url);
  return responseUrl.origin === "https://sandock.ai" && responseUrl.pathname.startsWith("/api/");
};

class CdpSession {
  constructor(webSocketUrl) {
    this.webSocket = new WebSocket(webSocketUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.webSocket.addEventListener("open", resolve, { once: true });
      this.webSocket.addEventListener("error", () => reject(new Error("CDP connection failed")), {
        once: true,
      });
    });

    this.webSocket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || "CDP command failed"));
        else pending.resolve(message.result);
        return;
      }

      for (const listener of this.listeners) listener(message);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.webSocket.send(JSON.stringify({ id, method, params }));
    return result;
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    this.webSocket.close();
  }
}

const resolveDashboardTarget = async (cdpUrl, fetchImpl) => {
  const targetsUrl = new URL("/json/list", cdpUrl);
  const response = await fetchImpl(targetsUrl);
  if (!response.ok) throw new Error(`Could not list CDP targets (${response.status})`);

  const targets = await response.json();
  const target = targets.find(
    (candidate) =>
      candidate.type === "page" &&
      typeof candidate.url === "string" &&
      candidate.url.startsWith("https://sandock.ai/dashboard") &&
      typeof candidate.webSocketDebuggerUrl === "string",
  );
  if (!target) throw new Error("An authenticated Sandock Dashboard CDP target was not found");
  return target.webSocketDebuggerUrl;
};

export const captureRawApiKey = async ({
  cdpUrl,
  timeoutMs = DEFAULT_CAPTURE_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  log = (message) => process.stderr.write(`${message}\n`),
}) => {
  const webSocketUrl = await resolveDashboardTarget(cdpUrl, fetchImpl);
  const session = new CdpSession(webSocketUrl);
  await session.connect();
  await session.send("Network.enable");

  const candidateRequests = new Set();
  let settled = false;

  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        settled = true;
        reject(new Error("Timed out waiting for the one-time Sandock API key create response"));
      }, timeoutMs);

      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };

      session.onEvent(async (message) => {
        if (message.method === "Network.responseReceived") {
          const { requestId, response, type } = message.params;
          if (isCandidateApiResponse(response, type)) {
            candidateRequests.add(requestId);
          }
          return;
        }

        if (message.method !== "Network.loadingFinished") return;
        const { requestId } = message.params;
        if (!candidateRequests.delete(requestId)) return;

        try {
          const response = await session.send("Network.getResponseBody", { requestId });
          const body = response.base64Encoded
            ? Buffer.from(response.body, "base64").toString("utf8")
            : response.body;
          const key = findRawApiKey(JSON.parse(body));
          if (key) finish(resolve, key);
        } catch {
          // Ignore unrelated or non-JSON RPC responses without logging their contents.
        }
      });

      log("HANDOFF_ARMED: create exactly one Sandock Agent Creator API key now");
    });
  } finally {
    session.close();
  }
};

const validateApiKey = async (apiKey, environment) => {
  const baseUrl = environment.SANDOCK_BASE_URL?.trim() || undefined;
  const client = createSandockClient({
    ...(baseUrl ? { baseUrl } : {}),
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  await client.sandbox.list();
};

export const captureAndDeploy = async ({
  cdpUrl,
  timeoutMs,
  environment = process.env,
  fetchImpl = globalThis.fetch,
  log = (message) => process.stderr.write(`${message}\n`),
}) => {
  let apiKey = await captureRawApiKey({ cdpUrl, timeoutMs, fetchImpl, log });
  try {
    try {
      await validateApiKey(apiKey, environment);
    } catch (error) {
      throw new Error(`Sandock API key validation failed: ${redactSecrets(error, [apiKey])}`);
    }
    log("Captured and validated the one-time Sandock API key in memory; starting deployment");

    return await deployAgent({
      environment: { ...environment, SANDOCK_API_KEY: apiKey },
      fetchImpl,
      log,
    });
  } finally {
    apiKey = null;
  }
};

const runCli = async () => {
  try {
    const options = parseCaptureArgs(process.argv.slice(2));
    const result = await captureAndDeploy(options);
    if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else {
      for (const [key, value] of Object.entries(result)) process.stdout.write(`${key}: ${value}\n`);
    }
  } catch (error) {
    const failure = {
      error: error instanceof Error ? error.message : String(error),
      ...(error?.sandboxId ? { sandboxId: error.sandboxId } : {}),
      ...(error?.cleanupFailed ? { cleanupFailed: true } : {}),
      ...(error?.manualCleanup ? { manualCleanup: error.manualCleanup } : {}),
    };
    process.stderr.write(`${JSON.stringify(failure)}\n`);
    process.exitCode = 1;
  }
};

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runCli();
}
