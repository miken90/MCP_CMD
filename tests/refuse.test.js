import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function connectClient(t, serverParams) {
  const transport = new StdioClientTransport({
    cwd: repoRoot,
    stderr: "pipe",
    ...serverParams,
  });

  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const client = new Client({ name: "mcp-cmd-refuse-tests", version: "1.0.0" });
  t.after(async () => {
    await transport.close().catch(() => { });
  });

  await client.connect(transport);
  return { client, stderr };
}

function resultText(result) {
  return result.content
    ?.map((item) => ("text" in item ? item.text : ""))
    .filter(Boolean)
    .join("\n") ?? "";
}

test("AC1: refuses blocked commands via --refuse-re and custom --refuse-msg", async (t) => {
  const refuseRe = "\\.ps1\\b|\\b(cargo|pnpm|npm|npx|yarn|dotnet|msbuild)\\b";
  const refuseMsg = "Windows builds, tests and .ps1 scripts run through Boom gate wrappers";

  const { client } = await connectClient(t, {
    command: process.execPath,
    args: ["index.js", "--refuse-re", refuseRe, "--refuse-msg", refuseMsg],
  });

  // 1. powershell_run: & .\build.ps1 -SkipRust
  const psResult = await client.callTool({
    name: "powershell_run",
    arguments: {
      command: "& .\\build.ps1 -SkipRust",
      cwd: repoRoot,
    },
  });
  const psText = resultText(psResult);
  assert.equal(psResult.content.length, 1);
  assert.match(psText, /\[BLOCKED\] Windows builds, tests and \.ps1 scripts run through Boom gate wrappers/);
  assert.match(psText, /\[EXIT 1\]/);

  // 2. cmd_run: pnpm test
  const cmdResult = await client.callTool({
    name: "cmd_run",
    arguments: {
      command: "pnpm test",
      cwd: repoRoot,
    },
  });
  const cmdText = resultText(cmdResult);
  assert.equal(cmdResult.content.length, 1);
  assert.match(cmdText, /\[BLOCKED\] Windows builds, tests and \.ps1 scripts run through Boom gate wrappers/);
  assert.match(cmdText, /\[EXIT 1\]/);

  // 3. cmd_batch holding cargo build
  const batchResult = await client.callTool({
    name: "cmd_batch",
    arguments: {
      commands: [{ command: "cargo build", cwd: repoRoot }],
    },
  });
  const batchText = resultText(batchResult);
  assert.equal(batchResult.content.length, 1);
  assert.match(batchText, /\[BLOCKED\] Windows builds, tests and \.ps1 scripts run through Boom gate wrappers/);
  assert.match(batchText, /\[EXIT 1\]/);
});

test("AC1 default message: uses fallback message when --refuse-msg is not provided", async (t) => {
  const { client } = await connectClient(t, {
    command: process.execPath,
    args: ["index.js", "--refuse-re", "cargo"],
  });

  const cmdResult = await client.callTool({
    name: "cmd_run",
    arguments: { command: "cargo build", cwd: repoRoot },
  });
  const cmdText = resultText(cmdResult);
  assert.equal(cmdResult.content.length, 1);
  assert.match(cmdText, /^\[BLOCKED\] command refused by --refuse-re\n\[EXIT 1\]$/);
});

test("AC4 bad regex: exits non-zero at startup with stderr line naming the flag", () => {
  const result = spawnSync(process.execPath, ["index.js", "--refuse-re", "("], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--refuse-re/);
});

test("AC2 pass-through: allowed command runs normally with [EXIT 0]", { skip: process.platform !== "win32" && !process.env.TEST_WINDOWS_PASSTHROUGH }, async (t) => {
  const refuseRe = "\\.ps1\\b|\\b(cargo|pnpm|npm|npx|yarn|dotnet|msbuild)\\b";
  const { client } = await connectClient(t, {
    command: process.execPath,
    args: ["index.js", "--refuse-re", refuseRe],
  });

  const psResult = await client.callTool({
    name: "powershell_run",
    arguments: {
      command: "Get-Process -Id $PID | Select-Object -ExpandProperty Id",
      cwd: repoRoot,
    },
  });
  const psText = resultText(psResult);
  assert.match(psText, /\[EXIT 0\]/);
});
