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
3. Open the Dashboard, then Account Settings > API Keys. Existing API Key rows do not reveal their raw values. Reuse a raw key only when it is still visibly available from a creation completed during this same attempt; otherwise create exactly one dedicated key named `Sandock Agent Creator <UTC timestamp>` and capture the raw value shown once after creation.
4. Do not create a second key after an interruption, and do not revoke, rotate, or otherwise modify existing keys. If it is unclear whether this attempt already created a key, pause and ask the user before creating another.
5. Treat the raw key as a secret. Do not include it in chat, logs, screenshots, commits, files, shell history, or persistent shell configuration. Inject it into the deployment process through the host's secret/environment facility, retain it only for this deployment, and discard it afterward. If the host cannot pass it without exposing or persisting it, ask the user to set `SANDOCK_API_KEY` locally and resume after they confirm; do not ask them to send the value.

If no browser capability is available, provide `https://sandock.ai/sign-in`, ask the user to sign in and configure `SANDOCK_API_KEY` locally, then pause. Do not create a sandbox until a key is available.

## Deploy

Resolve the directory containing this `SKILL.md` as `<skill-directory>`, then run:

```bash
node "<skill-directory>/scripts/deploy.mjs" --json
```

Pass the acquired Sandock key only as `SANDOCK_API_KEY` in the child process environment. Do not interpolate it into the command string.

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
