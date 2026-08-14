import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createArtifactServer } from "../src/server.mjs";

const token = "test-token";
const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

async function waitForJob(baseUrl, id) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${baseUrl}/v1/jobs/${id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await response.json();
    if (body.job?.status === "completed" || body.job?.status === "failed") {
      return body.job;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Job did not finish.");
}

test("serves text, durable image bytes, explicit deletion, and GC", async () => {
  const jobsRoot = await mkdtemp(path.join(tmpdir(), "artifact-server-test-"));
  const runner = {
    async generateText({ prompt, responseSchema }) {
      return {
        text: responseSchema ? JSON.stringify({ echoed: prompt }) : `echo:${prompt}`,
        responseId: "thread_text",
        model: "codex-sdk/test",
        usage: null,
      };
    },
    async generateImage({ job, inputPaths, outputPath }) {
      assert.equal(job.aspectRatio, "3:4");
      assert.equal(inputPaths.length, 1);
      assert.deepEqual(await readFile(inputPaths[0]), Buffer.from("reference"));
      await writeFile(outputPath, png);
      return {
        responseId: "thread_image",
        model: "codex-sdk/test",
        contentType: "image/png",
      };
    },
  };
  const artifactServer = await createArtifactServer({
    host: "127.0.0.1",
    port: 0,
    token,
    jobsRoot,
    runner,
    terminalTtlMs: 1000,
  });

  try {
    const address = await artifactServer.listen();
    assert.equal(typeof address, "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const unauthorized = await fetch(`${baseUrl}/v1/health`);
    assert.equal(unauthorized.status, 401);

    const health = await fetch(`${baseUrl}/v1/health`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(health.status, 200);
    assert.equal((await health.json()).imageConcurrency, 3);

    const textResponse = await fetch(`${baseUrl}/v1/text`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        prompt: "hello",
        responseSchema: {
          type: "object",
          properties: { echoed: { type: "string" } },
          required: ["echoed"],
        },
      }),
    });
    assert.equal(textResponse.status, 200);
    assert.equal((await textResponse.json()).text, '{"echoed":"hello"}');

    const form = new FormData();
    form.set("id", "image_test");
    form.set("prompt", "Create a test image.");
    form.set("aspectRatio", "3:4");
    form.append("image", new Blob(["reference"], { type: "image/png" }), "reference.png");
    const enqueue = await fetch(`${baseUrl}/v1/images`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
    assert.equal(enqueue.status, 202);
    assert.equal(enqueue.headers.get("location"), "/v1/jobs/image_test");

    const job = await waitForJob(baseUrl, "image_test");
    assert.equal(job.status, "completed");
    assert.equal(job.contentLength, png.byteLength);
    assert.match(job.contentHash, /^[a-f0-9]{64}$/);
    assert.ok(job.expiresAt);

    const result = await fetch(`${baseUrl}/v1/jobs/image_test/result`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await result.arrayBuffer()), png);
    await new Promise((resolve) => setImmediate(resolve));

    const deletion = await fetch(`${baseUrl}/v1/jobs/image_test`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(deletion.status, 200);
    assert.equal(
      (await fetch(`${baseUrl}/v1/jobs/image_test`, {
        headers: { authorization: `Bearer ${token}` },
      })).status,
      404,
    );

    const gcForm = new FormData();
    gcForm.set("id", "image_gc");
    gcForm.set("prompt", "Create a disposable image.");
    const gcEnqueue = await fetch(`${baseUrl}/v1/images`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: gcForm,
    });
    assert.equal(gcEnqueue.status, 202);
    await waitForJob(baseUrl, "image_gc");
    const gcJob = artifactServer.jobs.get("image_gc");
    gcJob.expiresAt = new Date(0).toISOString();
    await artifactServer.store.save(gcJob);
    await artifactServer.garbageCollect();
    assert.equal(artifactServer.jobs.has("image_gc"), false);
  } finally {
    await artifactServer.close();
    await rm(jobsRoot, { recursive: true, force: true });
  }
});
