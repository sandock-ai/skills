import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { findRawApiKey, isCandidateApiResponse, parseCaptureArgs } from "./capture-and-deploy.mjs";

const skillPath = new URL("../SKILL.md", import.meta.url);

test("requires an armed atomic handoff before API key creation", async () => {
  const skill = await readFile(skillPath, "utf8");
  const armIndex = skill.indexOf("establish and verify an atomic secret handoff");
  const createIndex = skill.indexOf("create exactly one dedicated key");

  assert.notEqual(armIndex, -1);
  assert.notEqual(createIndex, -1);
  assert.ok(armIndex < createIndex);
  assert.match(skill, /report that it is armed before creation is allowed/);
});

test("keeps the one-time key out of observable and persistent channels", async () => {
  const skill = await readFile(skillPath, "utf8");
  const helper = await readFile(new URL("./capture-and-deploy.mjs", import.meta.url), "utf8");

  for (const prohibitedChannel of [
    "browser text extraction",
    "screenshots",
    "clipboard output",
    "terminal output",
    "command-line arguments",
    "temporary files",
    "shell history",
    "browser storage",
    "heap snapshots",
  ]) {
    assert.match(skill, new RegExp(prohibitedChannel));
  }

  assert.match(helper, /redactSecrets\(error, \[apiKey\]\)/);
  assert.doesNotMatch(helper, /log\([^\n]*apiKey/);
});

test("stops after a failed handoff instead of recovering or duplicating the key", async () => {
  const skill = await readFile(skillPath, "utf8");

  assert.match(skill, /If key creation succeeds but the atomic handoff fails, stop immediately/);
  assert.match(skill, /Do not navigate away, close the dialog, scan browser memory/);
  assert.match(skill, /Do not revoke, rotate, or otherwise modify/);
  assert.match(skill, /ask the user whether to create one replacement key/);
});

test("extracts only a raw Sandock key from a structured create response", () => {
  const raw = `sk-${"a".repeat(48)}`;

  assert.equal(findRawApiKey({ data: [{ result: { raw } }] }), raw);
  assert.equal(findRawApiKey({ data: { key: raw } }), raw);
  assert.equal(findRawApiKey({ id: raw }), null);
  assert.equal(findRawApiKey({ raw: `sk-${"a".repeat(24)}` }), null);
  assert.equal(findRawApiKey({ raw: `sk-${"z".repeat(48)}` }), null);
  assert.equal(findRawApiKey({ raw: "sk-too-short" }), null);
});

test("captures both current oRPC and legacy auth API responses", () => {
  assert.equal(
    isCandidateApiResponse(
      { status: 200, url: "https://sandock.ai/api/rpc/apiKeys/create/__batch__" },
      "Fetch",
    ),
    true,
  );
  assert.equal(
    isCandidateApiResponse(
      { status: 201, url: "https://sandock.ai/api/auth/api-key/create" },
      "XHR",
    ),
    true,
  );
  assert.equal(
    isCandidateApiResponse({ status: 200, url: "https://example.com/api/key" }, "Fetch"),
    false,
  );
  assert.equal(
    isCandidateApiResponse({ status: 500, url: "https://sandock.ai/api/key" }, "Fetch"),
    false,
  );
});

test("capture CLI requires a non-secret CDP endpoint and validates its timeout", () => {
  assert.deepEqual(parseCaptureArgs(["--json"], { BROWSER_CDP_URL: "http://127.0.0.1:9223" }), {
    cdpUrl: "http://127.0.0.1:9223/",
    json: true,
    timeoutMs: 600000,
  });
  assert.throws(() => parseCaptureArgs([], {}), /BROWSER_CDP_URL/);
  assert.throws(
    () => parseCaptureArgs(["--cdp-url", "ws://127.0.0.1:9223"], {}),
    /must use http or https/,
  );
  assert.throws(
    () => parseCaptureArgs(["--cdp-url", "http://127.0.0.1:9223", "--timeout-ms", "999"], {}),
    /at least 1000/,
  );
});
