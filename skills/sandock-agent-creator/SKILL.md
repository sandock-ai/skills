---
name: sandock-agent-creator
description: Deploy the upstream Bunny Agent web UI into a Sandock sandbox using the latest sandock-cli device authentication and return a signed Preview URL. Use when a user explicitly asks to create, launch, or deploy a Bunny Agent UI on Sandock; do not use for questions about Sandock or Bunny Agent that do not request a deployment.
---

# Sandock Agent Creator

Deploy one unmodified checkout of `buda-ai/bunny-agent` from its latest public `main` branch. The user's initial prompt authorizes and triggers the deployment only; it does not become the generated Agent's system prompt.

## Preconditions

- An explicit request to create or deploy the Agent UI authorizes one billable Sandock sandbox. Research, explanation, planning, skill maintenance, and dry runs do not authorize resource creation.
- Use the latest published `sandock-cli` for every Sandock operation: device authentication, creation/lifetime, status, remote execution, signed Preview generation/revocation, and deletion. Do not import SDK modules, call Sandock HTTP APIs directly, read credential files, or execute legacy deployment/capture scripts. Let the CLI manage credentials; do not scrape browser API keys or ask the user to paste a key into chat.
- `sandock-space` is optional. Only when the user explicitly supplies a space for this deployment, translate it to CLI `--space <space-id>`. Otherwise omit `--space` completely and use the service's personal-space default. Do not ask for a space, infer one from another project, or automatically use `SANDOCK_SPACE_ID` or a remembered space.
- Do not collect, record, or upload an LLM key during deployment. The user configures it in the deployed Bunny Agent Settings page.

## Prepare The Latest CLI

Install the latest CLI into a task-local temporary directory without modifying the repository or a global installation:

```bash
sandock_cli_dir=$(mktemp -d /tmp/sandock-agent-cli.XXXXXX)
npm install --prefix "$sandock_cli_dir" --no-audit --no-fund sandock-cli@latest
"$sandock_cli_dir/node_modules/.bin/sandock" --version
"$sandock_cli_dir/node_modules/.bin/sandock" login --help
"$sandock_cli_dir/node_modules/.bin/sandock" sandbox create --help
"$sandock_cli_dir/node_modules/.bin/sandock" sandbox preview --help
"$sandock_cli_dir/node_modules/.bin/sandock" sandbox revoke-preview --help
"$sandock_cli_dir/node_modules/.bin/sandock" sandbox exec --help
"$sandock_cli_dir/node_modules/.bin/sandock" sandbox info --help
"$sandock_cli_dir/node_modules/.bin/sandock" sandbox delete --help
```

Keep the resolved directory for subsequent commands, including across shell sessions. Ensure the current Node runtime satisfies the installed package's engine requirement. Treat a successful `sandock-cli@latest` install plus the version and help checks above as the capability gate; do not rely on a hardcoded minimum version. If installation fails or any required command is missing, stop before creation and report the published-package incompatibility instead of falling back to SDK modules, direct HTTP calls, browser key capture, or a repository-local build.

Use the CLI's configured API URL, defaulting to `https://sandock.ai`. If the user specifies another endpoint, use `sandock config --set-url <endpoint>` before login (prefer an isolated `XDG_CONFIG_HOME` for a development account and preserve it across every command); credentials and deployment must use the same endpoint. Do not print configuration files or credentials.

## Device Authentication

Reuse a working CLI login. A read-only `sandock sandbox list` can check it; distinguish an authentication failure from a network/service error. When authentication is needed, run the following in a persistent process:

```bash
"$sandock_cli_dir/node_modules/.bin/sandock" login --no-browser
```

Give the user the authorization URL and one-time user code printed by the CLI. Ask them to complete device authorization in their own browser. Keep the CLI polling while waiting; never approve the device on their behalf. Continue only after the CLI reports `API key saved. You are signed in.` A user message saying authorization is complete is not a substitute for CLI success.

The CLI exchanges the device code and saves the API key locally. Do not extract it through browser text, screenshots, clipboard, CDP, or chat. If a configured key needs replacement, respect the CLI's confirmation instead of automatically answering yes. On denial, expiry, or cancellation, stop before creating a sandbox and report the result; do not loop through new device requests automatically.

## Create One Sandbox With The CLI

```bash
"$sandock_cli_dir/node_modules/.bin/sandock" sandbox create \
  --image node:24.18.0-bookworm --cpu 2000 --memory 4096 --active-deadline-seconds 3600 --auto-delete-interval 0
```

Append `--space <space-id>` only when the user explicitly specified `sandock-space`. Capture the returned sandbox ID immediately and reuse it throughout deployment and cleanup. Do not issue a second create call via the SDK or the old deployment script. If creation times out without an ID, reconcile with the read-only sandbox list before considering another attempt.

The CLI requests a maximum runtime of 3600 seconds and deletion after stopping (auto-delete interval 0 minutes). The service scheduler enforces these settings; do not promise deletion at an exact wall-clock instant. Signed URL expiry is separate from sandbox runtime.

## Finish Deployment In That Sandbox

Creation starts the sandbox; no separate start call is needed. Use the installed CLI executable for every command below (the short `sandock` spelling means that executable, not an older global installation).

1. Run `sandock sandbox info <sandbox-id>` and confirm RUNNING before setup. If it is still starting, poll with a bounded wait; if it stops, expires, or errors, follow failure cleanup.
2. Execute [Bunny Agent setup](references/bunny-agent-cli-setup.md), entirely through `sandock sandbox exec`. Capture the exact source commit and check each remote exit code and timeout status.
3. Run `sandock sandbox preview <sandbox-id> --port 3000 --expires-in 3600`. Capture the returned URL and set its path to `/example`, preserving the hostname and query parameters.
4. Probe the signed `/example` URL with an ordinary HTTP client such as curl. Require three consecutive successful HTTP responses, one second apart, with a five-second request timeout and a two-minute overall limit. This checks the deployed web page, not a Sandock management API. Return success only after readiness passes.

On a failed deployment, clean up only the sandbox created by this invocation:

```bash
"$sandock_cli_dir/node_modules/.bin/sandock" sandbox delete <sandbox-id> --force
```

Report the failure and sandbox ID, plus a manual-cleanup warning if deletion fails. Do not automatically retry deployment or create a second sandbox. For an explicit dry run, show the CLI commands and setup recipe without login, creation, or other account changes. When the user asks to remove an existing deployment, use the same delete command for their specified sandbox.

## Revoke A Generated Preview

When the user asks to cancel/revoke an existing Preview, use the same CLI account and sandbox ID:

```bash
"$sandock_cli_dir/node_modules/.bin/sandock" sandbox revoke-preview <sandbox-id> <token>
```

The CLI owns the revocation request; do not implement signing, expiration, or revocation separately. For a generated URL shaped `https://3000-t0123456789abcde.<proxy-domain>/example`, the token is `t0123456789abcde` (the first hostname label after the port and hyphen). Keep it private. If the URL format differs, check the installed CLI documentation rather than guessing. Do not generate another URL to retrieve the token: generation may refresh/reuse an existing token.

Revocation withdraws access through that token and does not delete the sandbox or stop its billing. URLs sharing that token are affected. Report API success only after the command succeeds; do not claim existing connections closed or that every proxy cache was instantly invalidated. Do not create a new sandbox or automatically regenerate the revoked link.

## Return The Result

If the host supports a Preview panel, open the returned URL there. Always provide the clickable URL as well.

On success, tell the user:

- The Agent Preview URL, its one-hour URL expiry, sandbox ID, source commit, and remaining sandbox runtime (the one-hour sandbox clock already includes build time). The link stops working when either the sandbox stops or the token expires/is revoked.
- Open `Settings`, enter an Anthropic, OpenAI, or Gemini API key, then select the corresponding runner and model shown by the current Bunny Agent UI before chatting.
- The LLM key is stored in browser `localStorage` and is sent with chat requests to this Preview instance.
- The signed Preview URL acts as a temporary access credential and must not be shared publicly.

End with this exact follow-up, substituting the returned sandbox ID:

`如需为这个 Agent 集成浏览器能力，请回复：为这个 Agent 添加浏览器能力（sandboxId: <id>）`
