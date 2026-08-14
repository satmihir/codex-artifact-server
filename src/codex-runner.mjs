import { readFile, rm } from "node:fs/promises";
import { Codex } from "@openai/codex-sdk";

export function createCodexRunner({ model, modelLabel, store }) {
  const codex = new Codex();

  return {
    async generateText({ prompt, responseSchema }) {
      const thread = codex.startThread({
        model,
        sandboxMode: "read-only",
        workingDirectory: store.root,
        skipGitRepoCheck: true,
        approvalPolicy: "never",
        networkAccessEnabled: false,
        webSearchMode: "disabled",
      });
      const result = await thread.run(
        [
          {
            type: "text",
            text: [
              "Follow the supplied request exactly.",
              "Do not inspect files, run commands, browse the web, or call tools.",
              "Return only the requested response.",
              "",
              prompt,
            ].join("\n"),
          },
        ],
        responseSchema ? { outputSchema: responseSchema } : undefined,
      );
      return {
        text: result.finalResponse,
        responseId: thread.id,
        model: `codex-sdk/${modelLabel}`,
        usage: result.usage,
      };
    },

    async generateImage({ job, inputPaths, outputPath }) {
      await rm(outputPath, { force: true });
      const instruction = [
        "Use the installed imagegen skill and the built-in image_gen tool to generate exactly one image.",
        "Do not use an image API, image_gen.py, another CLI fallback, OPENAI_API_KEY, web search, or files outside this job directory.",
        "Use attached images only as references described by the request.",
        `The requested composition is ${job.aspectRatio}.`,
        `After generation, copy the selected final PNG to exactly: ${outputPath}`,
        "Do not create any other output files. Finish only after that exact file exists.",
        "",
        job.prompt,
      ].join("\n");
      const thread = codex.startThread({
        model,
        sandboxMode: "workspace-write",
        workingDirectory: store.directory(job.id),
        skipGitRepoCheck: true,
        approvalPolicy: "never",
        networkAccessEnabled: false,
        webSearchMode: "disabled",
      });
      const result = await thread.run([
        { type: "text", text: instruction },
        ...inputPaths.map((inputPath) => ({ type: "local_image", path: inputPath })),
      ]);
      await readFile(outputPath);
      return {
        responseId: thread.id,
        model: `codex-sdk/${modelLabel}`,
        usage: result.usage,
        contentType: "image/png",
      };
    },
  };
}
