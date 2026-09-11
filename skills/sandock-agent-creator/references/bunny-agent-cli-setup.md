# Bunny Agent setup through sandock-cli

Use this recipe only after the skill has authenticated and created one sandbox. In the host shell, set `sandock_cli` to the absolute path of the installed latest CLI and `sandock_id` to the returned sandbox ID. Preserve any isolated CLI configuration environment across all invocations.

Run each command below sequentially. The quoted remote command must reach the sandbox unchanged: do not let host-shell expansion execute remote substitutions. Check the reported remote Exit Code is 0 and no timeout is reported before proceeding; `sandock sandbox exec` can exit successfully even when the remote command reports failure.

```bash
"$sandock_cli" sandbox exec "$sandock_id" 'command -v git >/dev/null && git --version && test -r /etc/ssl/certs/ca-certificates.crt' --timeout 30
"$sandock_cli" sandbox exec "$sandock_id" 'npm install --global pnpm@10.11.0' --timeout 900 --stream
"$sandock_cli" sandbox exec "$sandock_id" 'mkdir -p /workspace && git clone --depth 1 --branch main https://github.com/buda-ai/bunny-agent.git /workspace/bunny-agent' --timeout 900 --stream
"$sandock_cli" sandbox exec "$sandock_id" 'git -C /workspace/bunny-agent rev-parse HEAD' --timeout 30
"$sandock_cli" sandbox exec "$sandock_id" 'cd /workspace/bunny-agent && pnpm install --frozen-lockfile' --timeout 900 --stream
"$sandock_cli" sandbox exec "$sandock_id" 'cd /workspace/bunny-agent && pnpm --filter @bunny-agent/runner-cli... build' --timeout 900 --stream
"$sandock_cli" sandbox exec "$sandock_id" 'cd /workspace/bunny-agent && pnpm --filter @bunny-agent/web... build' --timeout 900 --stream
"$sandock_cli" sandbox exec "$sandock_id" 'cd /workspace/bunny-agent && nohup env SANDBOX_PROVIDER=local NEXT_TELEMETRY_DISABLED=1 pnpm --filter @bunny-agent/web start --hostname 0.0.0.0 --port 3000 >/tmp/bunny-agent-web.log 2>&1 </dev/null &' --timeout 30
```

Record the 40-hex-character source commit from `rev-parse HEAD`. A background launch returning 0 does not prove readiness: return to the skill's signed URL probe before reporting success.

If setup fails, inspect the test instance through CLI only, for example:

```bash
"$sandock_cli" sandbox exec "$sandock_id" 'tail -n 80 /tmp/bunny-agent-web.log' --timeout 30
```

Do not restart a stopped or expired sandbox via another API, create a replacement automatically, or run the legacy deployment scripts. Follow the skill's failure cleanup.
