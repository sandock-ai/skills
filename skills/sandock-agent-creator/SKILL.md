---
name: sandock-agent-creator
description: Deploy the upstream Bunny Agent web UI into a temporary Sandock sandbox and return a signed Preview URL. Use when a user explicitly asks to create, launch, or deploy a Bunny Agent UI on Sandock; do not use for questions about Sandock or Bunny Agent that do not request a deployment.
---

# Sandock Agent Creator

Deploy one unmodified checkout of `buda-ai/bunny-agent` from its latest public `main` branch. The user's initial prompt authorizes and triggers the deployment only; it does not become the generated Agent's system prompt.

## Preconditions

- Treat an explicit request to create or deploy the Agent UI as authorization to create one billable Sandock sandbox. Do not create a sandbox for research, explanation, planning, or a dry run.
- Require `SANDOCK_API_KEY` in the local environment. Never ask the user to paste it into chat, print it, or pass it as a command-line argument.
- Read optional `SANDOCK_BASE_URL` and `SANDOCK_SPACE_ID` from the local environment when present.
- Do not collect, record, or upload an LLM key during deployment. The user configures it in the deployed Bunny Agent Settings page.

## Deploy

Resolve the directory containing this `SKILL.md` as `<skill-directory>`, then run:

```bash
node "<skill-directory>/scripts/deploy.mjs" --json
```

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
