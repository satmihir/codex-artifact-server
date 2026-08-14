#!/usr/bin/env node

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createCodexRunner } from "./codex-runner.mjs";
import { FileJobStore, validJobId } from "./job-store.mjs";
import { createBoundedScheduler } from "./scheduler.mjs";

class HttpError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed)
    ? Math.min(Math.max(parsed, minimum), maximum)
    : fallback;
}

function json(response, status, body, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

async function readRequestBytes(request, maximum) {
  const declared = Number.parseInt(request.headers["content-length"] ?? "", 10);
  if (Number.isFinite(declared) && declared > maximum) {
    throw new HttpError("Request body is too large.", 413);
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maximum) throw new HttpError("Request body is too large.", 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request, maximum) {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new HttpError("Content-Type must be application/json.", 415);
  }
  try {
    return JSON.parse((await readRequestBytes(request, maximum)).toString("utf8"));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError("Request body must be valid JSON.");
  }
}

async function readMultipart(request, maximum) {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw new HttpError("Content-Type must be multipart/form-data.", 415);
  }
  try {
    return await new Response(await readRequestBytes(request, maximum), {
      headers: { "content-type": contentType },
    }).formData();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError("Request body must be valid multipart form data.");
  }
}

function requiredString(value, name, maximum) {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(`${name} is required.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maximum) {
    throw new HttpError(`${name} must be ${maximum} characters or fewer.`);
  }
  return trimmed;
}

function publicJob(job) {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    aspectRatio: job.aspectRatio,
    error: job.error ?? null,
    responseId: job.responseId ?? null,
    model: job.model,
    contentType: job.contentType ?? null,
    contentLength: job.contentLength ?? null,
    contentHash: job.contentHash ?? null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt ?? null,
    lastAccessedAt: job.lastAccessedAt ?? null,
    expiresAt: job.expiresAt ?? null,
  };
}

const IMAGE_EXTENSIONS = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);

function extensionFor(contentType) {
  const extension = IMAGE_EXTENSIONS.get(contentType);
  if (!extension) throw new HttpError("Images must be JPEG, PNG, or WebP files.");
  return extension;
}

function terminal(status) {
  return status === "completed" || status === "failed";
}

export async function createArtifactServer(options = {}) {
  const host = options.host ?? process.env.CODEX_ARTIFACT_HOST ?? "127.0.0.1";
  const port = boundedInteger(
    options.port ?? process.env.CODEX_ARTIFACT_PORT,
    4319,
    0,
    65535,
  );
  const token = options.token ?? process.env.CODEX_ARTIFACT_TOKEN;
  if (!token) throw new Error("CODEX_ARTIFACT_TOKEN is required.");

  // Compare digests rather than the header itself: equal-length inputs let the
  // comparison run in constant time and leak nothing about the token.
  const expectedAuthorization = createHash("sha256")
    .update(`Bearer ${token}`)
    .digest();

  function authorized(header) {
    if (typeof header !== "string") return false;
    return timingSafeEqual(
      createHash("sha256").update(header).digest(),
      expectedAuthorization,
    );
  }

  const model =
    options.model ?? (process.env.CODEX_ARTIFACT_MODEL?.trim() || undefined);
  const modelLabel = model || "account-default";
  const concurrency = boundedInteger(
    options.concurrency ?? process.env.CODEX_ARTIFACT_CONCURRENCY,
    3,
    1,
    16,
  );
  const terminalTtlMs = boundedInteger(
    options.terminalTtlMs ?? process.env.CODEX_ARTIFACT_TTL_MS,
    24 * 60 * 60 * 1000,
    1000,
    30 * 24 * 60 * 60 * 1000,
  );
  const maximumImageRequestBytes = boundedInteger(
    options.maximumImageRequestBytes ?? process.env.CODEX_ARTIFACT_MAX_REQUEST_BYTES,
    96 * 1024 * 1024,
    1024,
    512 * 1024 * 1024,
  );
  const jobsRoot =
    options.jobsRoot ??
    process.env.CODEX_ARTIFACT_JOBS_DIR ??
    path.join(tmpdir(), "codex-artifact-server-jobs");
  const store = options.store ?? new FileJobStore(jobsRoot);
  await store.initialize();
  const runner =
    options.runner ?? createCodexRunner({ model, modelLabel, store });
  const scheduler = createBoundedScheduler(concurrency);
  const jobs = new Map();
  const activeStreams = new Set();

  async function updateJob(job, patch) {
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    await store.save(job);
  }

  function expireAt(timestamp = Date.now()) {
    return new Date(timestamp + terminalTtlMs).toISOString();
  }

  function schedule(job) {
    void scheduler
      .schedule(async () => {
        await updateJob(job, { status: "running", error: null });
        try {
          const result = await runner.generateImage({
            job,
            inputPaths: job.inputs.map((input) => store.inputPath(job.id, input.path)),
            outputPath: store.resultPath(job.id),
          });
          const bytes = await readFile(store.resultPath(job.id));
          const completedAt = new Date().toISOString();
          await updateJob(job, {
            status: "completed",
            responseId: result.responseId ?? null,
            model: result.model ?? `codex-sdk/${modelLabel}`,
            contentType: result.contentType ?? "image/png",
            contentLength: bytes.byteLength,
            contentHash: createHash("sha256").update(bytes).digest("hex"),
            error: null,
            completedAt,
            expiresAt: expireAt(),
          });
        } catch (error) {
          const completedAt = new Date().toISOString();
          await updateJob(job, {
            status: "failed",
            error:
              error instanceof Error
                ? error.message.slice(0, 1000)
                : "Codex image generation failed.",
            completedAt,
            expiresAt: expireAt(),
          });
        }
      })
      .catch((error) => console.error("Artifact scheduler failed", error));
  }

  for (const job of await store.loadAll()) {
    jobs.set(job.id, job);
    if (job.status === "queued") schedule(job);
    if (job.status === "running") {
      const completedAt = new Date().toISOString();
      await updateJob(job, {
        status: "failed",
        error: "The local artifact server restarted before this job completed.",
        completedAt,
        expiresAt: expireAt(),
      });
    }
  }

  async function garbageCollect() {
    const now = Date.now();
    for (const job of jobs.values()) {
      if (
        terminal(job.status) &&
        !activeStreams.has(job.id) &&
        job.expiresAt &&
        Date.parse(job.expiresAt) <= now
      ) {
        jobs.delete(job.id);
        await store.remove(job.id);
      }
    }
  }

  const server = createServer(async (request, response) => {
    try {
      if (!authorized(request.headers.authorization)) {
        throw new HttpError("Unauthorized.", 401);
      }
      const url = new URL(request.url ?? "/", `http://${host}`);

      if (request.method === "GET" && url.pathname === "/v1/health") {
        json(response, 200, {
          ready: true,
          provider: "codex_sdk",
          model: `codex-sdk/${modelLabel}`,
          imageConcurrency: scheduler.limit,
          activeImages: scheduler.activeCount,
          queuedImages: scheduler.queuedCount,
          retainedJobs: jobs.size,
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/text") {
        const body = await readJson(request, 512 * 1024);
        const prompt = requiredString(body?.prompt, "prompt", 20_000);
        if (
          body.responseSchema !== undefined &&
          (!body.responseSchema || typeof body.responseSchema !== "object" || Array.isArray(body.responseSchema))
        ) {
          throw new HttpError("responseSchema must be a JSON object.");
        }
        const result = await runner.generateText({
          prompt,
          responseSchema: body.responseSchema,
        });
        json(response, 200, result);
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/images") {
        const form = await readMultipart(request, maximumImageRequestBytes);
        const prompt = requiredString(form.get("prompt"), "prompt", 20_000);
        const requestedId = form.get("id");
        const id =
          typeof requestedId === "string" && requestedId.trim()
            ? requestedId.trim()
            : `img_${randomUUID().replaceAll("-", "")}`;
        if (!validJobId(id)) throw new HttpError("id is invalid.");
        const existing = jobs.get(id);
        if (existing) {
          json(response, 202, { job: publicJob(existing) }, {
            location: `/v1/jobs/${encodeURIComponent(id)}`,
          });
          return;
        }
        const aspectRatioValue = form.get("aspectRatio");
        const aspectRatio =
          typeof aspectRatioValue === "string" && aspectRatioValue.trim()
            ? aspectRatioValue.trim()
            : "1:1";
        if (!["1:1", "3:4", "3:2"].includes(aspectRatio)) {
          throw new HttpError("aspectRatio must be 1:1, 3:4, or 3:2.");
        }
        const uploaded = [...form.getAll("image"), ...form.getAll("images")].filter(
          (value) => typeof value !== "string" && typeof value?.arrayBuffer === "function",
        );
        if (uploaded.length > 8) throw new HttpError("Upload at most 8 images.");
        const inputs = [];
        try {
          for (const [index, file] of uploaded.entries()) {
            if (file.size <= 0 || file.size > 8 * 1024 * 1024) {
              throw new HttpError("Each image must be between 1 byte and 8 MB.");
            }
            const extension = extensionFor(file.type);
            const inputPath = await store.writeInput(
              id,
              index,
              extension,
              new Uint8Array(await file.arrayBuffer()),
            );
            inputs.push({
              path: inputPath,
              name: (file.name || `image-${index}.${extension}`).slice(0, 240),
              contentType: file.type,
              size: file.size,
            });
          }
          const now = new Date().toISOString();
          const job = {
            id,
            kind: "image",
            status: "queued",
            prompt,
            aspectRatio,
            inputs,
            error: null,
            responseId: null,
            model: `codex-sdk/${modelLabel}`,
            contentType: null,
            contentLength: null,
            contentHash: null,
            createdAt: now,
            updatedAt: now,
            completedAt: null,
            lastAccessedAt: null,
            expiresAt: null,
          };
          jobs.set(id, job);
          await store.save(job);
          schedule(job);
          json(response, 202, { job: publicJob(job) }, {
            location: `/v1/jobs/${encodeURIComponent(id)}`,
          });
        } catch (error) {
          jobs.delete(id);
          await store.remove(id).catch(() => undefined);
          throw error;
        }
        return;
      }

      const jobMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)(\/result)?$/);
      if (jobMatch) {
        const id = decodeURIComponent(jobMatch[1]);
        if (!validJobId(id)) throw new HttpError("Invalid job id.");
        const job = jobs.get(id);
        if (!job) throw new HttpError("Job not found.", 404);

        if (request.method === "GET" && jobMatch[2] === "/result") {
          if (job.status !== "completed") {
            json(
              response,
              409,
              { job: publicJob(job), error: "Job is not complete." },
              { "retry-after": "3" },
            );
            return;
          }
          let bytes;
          try {
            bytes = await readFile(store.resultPath(id));
          } catch {
            throw new HttpError("The completed artifact file is missing.", 500);
          }
          activeStreams.add(id);
          await updateJob(job, {
            lastAccessedAt: new Date().toISOString(),
            expiresAt: expireAt(),
          });
          const contentType = job.contentType || "image/png";
          response.writeHead(200, {
            "content-type": contentType,
            "content-length": bytes.byteLength,
            "content-disposition": `inline; filename="${id}.${
              IMAGE_EXTENSIONS.get(contentType) ?? "png"
            }"`,
            etag: `"sha256-${job.contentHash}"`,
            "cache-control": "private, no-store",
          });
          response.end(bytes, () => activeStreams.delete(id));
          return;
        }

        if (request.method === "GET" && !jobMatch[2]) {
          json(response, 200, { job: publicJob(job) });
          return;
        }

        if (request.method === "DELETE" && !jobMatch[2]) {
          if (!terminal(job.status)) {
            throw new HttpError("An active job cannot be deleted.", 409);
          }
          if (activeStreams.has(id)) {
            throw new HttpError("The artifact is currently being downloaded.", 409);
          }
          jobs.delete(id);
          await store.remove(id);
          json(response, 200, { deleted: true, id });
          return;
        }
      }

      throw new HttpError("Not found.", 404);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error("Artifact server request failed", error);
      json(response, status, {
        error: error instanceof Error ? error.message : "Internal server error.",
      });
    }
  });

  const gcTimer = setInterval(() => {
    void garbageCollect().catch((error) =>
      console.error("Artifact garbage collection failed", error),
    );
  }, Math.min(Math.max(Math.floor(terminalTtlMs / 4), 1000), 60 * 60 * 1000));
  gcTimer.unref();

  return {
    server,
    store,
    scheduler,
    jobs,
    garbageCollect,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      return server.address();
    },
    async close() {
      clearInterval(gcTimer);
      if (!server.listening) return;
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
    config: { host, port, modelLabel, concurrency, jobsRoot, terminalTtlMs },
  };
}

async function main() {
  const artifactServer = await createArtifactServer();
  const address = await artifactServer.listen();
  const addressPort = typeof address === "object" && address ? address.port : artifactServer.config.port;
  console.log(
    `Codex artifact server ready on http://${artifactServer.config.host}:${addressPort} ` +
      `(${artifactServer.config.modelLabel}, ${artifactServer.config.concurrency} image slots, ` +
      `jobs in ${artifactServer.config.jobsRoot})`,
  );
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await artifactServer.close();
  };
  process.on("SIGINT", () => void close());
  process.on("SIGTERM", () => void close());
}

// npm installs bin entries as symlinks, so the invoked path must be resolved to
// its real location before it can be compared against this module's URL.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  await main();
}
