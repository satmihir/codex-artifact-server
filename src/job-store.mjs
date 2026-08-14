import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export function validJobId(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 160 &&
    /^[A-Za-z0-9:_-]+$/.test(value)
  );
}

export class FileJobStore {
  constructor(root) {
    this.root = path.resolve(root);
  }

  directory(id) {
    if (!validJobId(id)) throw new Error("Invalid job id.");
    return path.join(this.root, id);
  }

  metadataPath(id) {
    return path.join(this.directory(id), "job.json");
  }

  resultPath(id) {
    return path.join(this.directory(id), "result.png");
  }

  async initialize() {
    await mkdir(this.root, { recursive: true });
  }

  async save(job) {
    const directory = this.directory(job.id);
    await mkdir(directory, { recursive: true });
    const target = this.metadataPath(job.id);
    const temporary = `${target}.tmp`;
    await writeFile(temporary, JSON.stringify(job), "utf8");
    await rename(temporary, target);
  }

  async loadAll() {
    await this.initialize();
    const jobs = [];
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !validJobId(entry.name)) continue;
      try {
        const job = JSON.parse(await readFile(this.metadataPath(entry.name), "utf8"));
        if (job.id === entry.name && validJobId(job.id)) jobs.push(job);
      } catch {
        // Ignore incomplete or externally damaged job directories.
      }
    }
    return jobs;
  }

  async writeInput(id, index, extension, bytes) {
    const directory = path.join(this.directory(id), "inputs");
    await mkdir(directory, { recursive: true });
    const relativePath = path.join("inputs", `${index}.${extension}`);
    await writeFile(path.join(this.directory(id), relativePath), bytes);
    return relativePath;
  }

  inputPath(id, relativePath) {
    if (
      typeof relativePath !== "string" ||
      relativePath.includes("..") ||
      path.isAbsolute(relativePath)
    ) {
      throw new Error("Invalid job input path.");
    }
    const jobDirectory = this.directory(id);
    const resolved = path.resolve(jobDirectory, relativePath);
    if (!resolved.startsWith(`${jobDirectory}${path.sep}`)) {
      throw new Error("Job input is outside its directory.");
    }
    return resolved;
  }

  async remove(id) {
    await rm(this.directory(id), { recursive: true, force: true });
  }
}
