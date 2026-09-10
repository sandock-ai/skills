---
name: sandock-agent-creator
description: Deploy the upstream Bunny Agent web UI into a temporary Sandock sandbox and return a signed Preview URL. Use when a user explicitly asks to create, launch, or deploy a Bunny Agent UI on Sandock; do not use for questions about Sandock or Bunny Agent that do not request a deployment.
---

# Sandock Agent Creator

Deploy one unmodified checkout of `buda-ai/bunny-agent` from its latest public `main` branch. The user's initial prompt authorizes and triggers the deployment only; it does not become the generated Agent's system prompt.

## Preconditions

- Treat an explicit request to create or deploy the Agent UI as authorization to create one billable Sandock sandbox. Do not create a sandbox for research, explanation, planning, or a dry run.
- Use `SANDOCK_API_KEY` from the local environment when it is already available. Never ask the user to paste a key into chat, print it, or pass it as a command-line argument.
- Read optional `SANDOCK_BASE_URL` and `SANDOCK_SPACE_ID` from the local environment when present.
- Do not collect, record, or upload an LLM key during deployment. The user configures it in the deployed Bunny Agent Settings page.

## Acquire A Sandock API Key

When `SANDOCK_API_KEY` is absent, use the host's browser capability instead of stopping immediately:

1. Open `https://sandock.ai` in a browser.
2. If the browser is unauthenticated or reaches a sign-in screen, navigate to `https://sandock.ai/sign-in`. Ask the user to complete sign-in in that browser and pause. Never request, inspect, or enter their password, passkey, OAuth approval, or multi-factor code. Resume in the same browser session after the user confirms completion or the authenticated dashboard becomes visible.
3. Open the Dashboard, then Account Settings > API Keys. Existing rows identify keys but never reveal their raw values.
4. Before clicking any button that creates a key, establish and verify an atomic secret handoff. When the browser exposes a host-local HTTP CDP endpoint, start `node "<skill-directory>/scripts/capture-and-deploy.mjs" --cdp-url <cdp-http-url> --json` in a background process and wait until its non-secret output contains `HANDOFF_ARMED`. The helper captures the create response, validates the key, and calls `deployAgent()` in the same process. Otherwise use a host secret destination that can pass the captured value only in a deployment child's `SANDOCK_API_KEY` environment variable. The listener or host secret destination must report that it is armed before creation is allowed.
5. If the host cannot establish that handoff, do not create a key. Ask the user to set `SANDOCK_API_KEY` through the host's local secret/environment facility and resume after they confirm. Never ask them to paste the value into chat.
6. Once the handoff is armed, create exactly one dedicated key named `Sandock Agent Creator <UTC timestamp>`. The helper or host handoff must capture the one-time key from the successful create response's current `raw` field or legacy `key` field, require the Sandock `sk-` plus 48 hexadecimal character format, validate it with one read-only Sandock API request, and immediately begin deployment. Keep the creation dialog and browser page open until the deployment process reports that it captured and validated the key.
7. After the deployment process has accepted the key, release all in-memory references to it. Do not revoke or persist the dedicated key automatically; the user may manage it later in Sandock Account Settings.

The raw key is a one-time secret. Do not use browser text extraction, screenshots, clipboard output, terminal output, command-line arguments, temporary files, shell history, browser storage, or heap snapshots to transfer or recover it. Those mechanisms either expose the secret or are unreliable after the UI discards its React state.

If key creation succeeds but the atomic handoff fails, stop immediately. Do not navigate away, close the dialog, scan browser memory, or create a replacement key automatically. Report that no sandbox deployment was started, identify the newly created key by its non-secret name, and ask the user whether to create one replacement key in a fresh armed attempt. Do not revoke, rotate, or otherwise modify the failed-attempt key without explicit authorization.

If no browser capability is available, provide `https://sandock.ai/sign-in`, ask the user to sign in and configure `SANDOCK_API_KEY` locally, then pause. Do not create a sandbox until a key is available.

## Deploy

Resolve the directory containing this `SKILL.md` as `<skill-directory>`, then run:

```bash
node "<skill-directory>/scripts/deploy.mjs" --json
```

Pass the acquired Sandock key only as `SANDOCK_API_KEY` in the child process environment. Do not interpolate it into the command string.

`capture-and-deploy.mjs` imports `deployAgent` and calls it with an ephemeral environment object containing `SANDOCK_API_KEY`. Never log or return that environment object. Use `deploy.mjs` directly only when `SANDOCK_API_KEY` was already available before browser key creation.

The script creates a one-hour sandbox, clones the latest public Bunny Agent `main`, records the exact commit, builds the runner and web app, starts the web service with `SANDBOX_PROVIDER=local`, creates a signed Preview URL, and waits for `/example` to return three consecutive successful HTTP responses.

Do not automatically retry a failed deployment. The script attempts to delete an incomplete sandbox. Report the error, include the sandbox ID when one was created, and include the script's manual-cleanup warning if deletion failed. Then wait for the user to decide whether to retry.

Use `--dry-run --json` only when the user explicitly asks to inspect the deployment without creating resources.

## Return The Result

If the host supports a Preview panel, open the returned URL there. Always provide the clickable URL as well.

On success, tell the user:

- The Agent Preview URL and that it expires in one hour.
- Open `Settings`, enter an Anthropic, OpenAI, or Gemini API key, then select the corresponding runner and model shown by the current Bunny Agent UI before chatting.
- The LLM key is stored in browser `localStorage` and is sent with chat requests to this Preview instance.
- The signed Preview URL acts as a temporary access credential and must not be shared publicly.

End with this exact follow-up, substituting the returned sandbox ID:

`如需为这个 Agent 集成浏览器能力，请回复：为这个 Agent 添加浏览器能力（sandboxId: <id>）`
