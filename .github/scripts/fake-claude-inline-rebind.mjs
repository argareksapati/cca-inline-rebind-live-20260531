#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { pathToFileURL } from "url";

const runnerTemp = process.env.RUNNER_TEMP || "/tmp";
const proofJsonPath = path.join(runnerTemp, "inline-rebind-proof.json");
const proofTxtPath = path.join(runnerTemp, "inline-rebind-proof.txt");
const eventPath = process.env.GITHUB_EVENT_PATH;
const githubActionPath = process.env.GITHUB_ACTION_PATH;
const githubToken = process.env.GITHUB_TOKEN;

function logLine(line) {
  fs.appendFileSync(proofTxtPath, `${line}\n`);
  process.stderr.write(`${line}\n`);
}

function parseMcpConfig(argv) {
  const values = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--mcp-config" && argv[i + 1]) {
      values.push(argv[i + 1]);
      i++;
      continue;
    }
    if (arg.startsWith("--mcp-config=")) {
      values.push(arg.slice("--mcp-config=".length));
    }
  }
  for (const value of values) {
    try {
      const parsed = JSON.parse(value);
      if (parsed?.mcpServers?.github_inline_comment) {
        return parsed;
      }
    } catch {}
  }
  throw new Error("Could not find github_inline_comment MCP config");
}

function readEvent() {
  if (!eventPath) {
    throw new Error("GITHUB_EVENT_PATH is required");
  }
  return JSON.parse(fs.readFileSync(eventPath, "utf8"));
}

function getHeadSha() {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

function getTargetLineInfo() {
  const lines = fs.readFileSync("target.txt", "utf8").split(/\r?\n/);
  const index = lines.findIndex((line) => line.includes("A_ONLY"));
  if (index === -1) {
    throw new Error("Could not find A_ONLY marker in target.txt");
  }
  return {
    line: index + 1,
    text: lines[index],
  };
}

async function callInlineCommentTool(mcpConfig, args) {
  const sdkBase = path.join(
    githubActionPath,
    "node_modules",
    "@modelcontextprotocol",
    "sdk",
    "dist",
    "esm",
  );
  const { Client } = await import(
    pathToFileURL(path.join(sdkBase, "client/index.js")).href
  );
  const { StdioClientTransport } = await import(
    pathToFileURL(path.join(sdkBase, "client/stdio.js")).href
  );

  const inlineServer = mcpConfig.mcpServers.github_inline_comment;
  const transport = new StdioClientTransport({
    command: inlineServer.command,
    args: inlineServer.args,
    env: {
      ...process.env,
      ...inlineServer.env,
    },
  });

  const client = new Client({
    name: "fake-inline-rebind-client",
    version: "1.0.0",
  });

  await client.connect(transport);
  const result = await client.callTool({
    name: "create_inline_comment",
    arguments: args,
  });
  await client.close();
  return result;
}

async function fetchPrHeadSha(owner, repo, pullNumber) {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${githubToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch PR head: ${res.status}`);
  }
  const data = await res.json();
  return data.head.sha;
}

const proof = {
  run_created_head: "",
  buffered_comment_commit_id_empty: true,
  buffered_comment_path: "target.txt",
  buffered_comment_line: 0,
  buffered_comment_body: "",
  buffered_at: "",
  live_head_observed_after_force_push: "",
  live_head_observed_at: "",
  pr_number: 0,
};

async function main() {
  fs.writeFileSync(proofTxtPath, "");

  const event = readEvent();
  const owner = event.repository.owner.login;
  const repo = event.repository.name;
  const pullNumber = event.pull_request.number;

  const headA = getHeadSha();
  const target = getTargetLineInfo();
  const mcpConfig = parseMcpConfig(process.argv.slice(2));

  proof.run_created_head = headA;
  proof.buffered_comment_line = target.line;
  proof.pr_number = pullNumber;
  proof.buffered_comment_body = `INLINE_REBIND_PROOF RUN_A=${headA} SEEN_TEXT=${target.text}`;

  logLine(`RUN_CREATED_HEAD=${headA}`);
  logLine(`BUFFERED_COMMENT_COMMIT_ID_EMPTY=true`);
  logLine(`BUFFERED_COMMENT_PATH=target.txt`);
  logLine(`BUFFERED_COMMENT_LINE=${target.line}`);
  logLine(`BUFFERED_COMMENT_BODY=${proof.buffered_comment_body}`);

  const toolResult = await callInlineCommentTool(mcpConfig, {
    path: "target.txt",
    line: target.line,
    body: proof.buffered_comment_body,
  });
  proof.buffered_at = new Date().toISOString();
  logLine(`BUFFERED_AT=${proof.buffered_at}`);
  logLine(`BUFFER_CALL_RESULT=${JSON.stringify(toolResult.content ?? [])}`);

  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const liveHead = await fetchPrHeadSha(owner, repo, pullNumber);
    if (liveHead !== headA) {
      proof.live_head_observed_after_force_push = liveHead;
      proof.live_head_observed_at = new Date().toISOString();
      logLine(`PR_HEAD_AFTER_FORCE_PUSH=${liveHead}`);
      logLine(`LIVE_HEAD_OBSERVED_AT=${proof.live_head_observed_at}`);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  if (!proof.live_head_observed_after_force_push) {
    logLine("PR_HEAD_AFTER_FORCE_PUSH_TIMEOUT=true");
  }

  fs.writeFileSync(proofJsonPath, JSON.stringify(proof, null, 2));

  process.stdout.write(
    JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "fake-inline-rebind-session",
      model: "fake-model",
    }) + "\n",
  );
  process.stdout.write(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 1,
      duration_api_ms: 0,
      num_turns: 1,
      result: "fake-inline-rebind-ok",
      session_id: "fake-inline-rebind-session",
      total_cost_usd: 0,
    }) + "\n",
  );
}

main().catch((error) => {
  logLine(`FAKE_CLI_ERROR=${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.stdout.write(
    JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "fake-inline-rebind-session",
      model: "fake-model",
    }) + "\n",
  );
  process.stdout.write(
    JSON.stringify({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      duration_ms: 1,
      duration_api_ms: 0,
      num_turns: 1,
      result: "fake-inline-rebind-failed",
      session_id: "fake-inline-rebind-session",
      total_cost_usd: 0,
      errors: [error instanceof Error ? error.message : String(error)],
    }) + "\n",
  );
  process.exit(0);
});
