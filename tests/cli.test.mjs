import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const entryPoint = fileURLToPath(new URL("../src/server.mjs", import.meta.url));

// npm publishes bin entries as symlinks into node_modules/.bin, so starting the
// server through one has to behave exactly like starting the file directly.
test("starts when launched through a symlink, as an installed bin is", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "artifact-cli-test-"));
  const link = path.join(directory, "codex-artifact-server");
  await symlink(entryPoint, link);

  const child = spawn(process.execPath, [link], {
    env: {
      ...process.env,
      CODEX_ARTIFACT_TOKEN: "cli-test-token",
      CODEX_ARTIFACT_PORT: "0",
      CODEX_ARTIFACT_JOBS_DIR: path.join(directory, "jobs"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const banner = await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(
        () => reject(new Error(`Server did not start. Output: ${output || "(none)"}`)),
        20_000,
      );
      child.once("error", reject);
      child.once("exit", (code) =>
        reject(new Error(`Server exited early with code ${code}. Output: ${output || "(none)"}`)),
      );
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      child.stdout.on("data", (chunk) => {
        output += chunk;
        const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve({ port: Number(match[1]) });
        }
      });
    });

    const response = await fetch(`http://127.0.0.1:${banner.port}/v1/health`, {
      headers: { authorization: "Bearer cli-test-token" },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ready, true);

    const unauthorized = await fetch(`http://127.0.0.1:${banner.port}/v1/health`);
    assert.equal(unauthorized.status, 401);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
