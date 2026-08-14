# Codex Artifact Server

A standalone, local HTTP service that turns Codex SDK runs into synchronous text
responses and durable image artifacts. The directory is self-contained: it does
not import application code or inspect the parent repository.

The service is intended for trusted local applications. It binds to
`127.0.0.1` by default, requires a bearer token, disables network access and web
search for Codex threads, and gives every image job an isolated temporary
working directory.

## Install and run

Requires Node.js 22.13 or newer, and a working local Codex CLI installation.

Run the published package without installing it:

```sh
CODEX_ARTIFACT_TOKEN="replace-me" npx codex-artifact-server
```

Install it as a command instead:

```sh
npm install -g codex-artifact-server
CODEX_ARTIFACT_TOKEN="replace-me" codex-artifact-server
```

Use it as a dependency of another local project:

```sh
npm install codex-artifact-server
```

To work on the source, clone the repository and run it from there:

```sh
git clone https://github.com/satmihir/codex-artifact-server.git
cd codex-artifact-server
npm install
CODEX_ARTIFACT_TOKEN="replace-me" npm start
```

Alternatively, copy `.env.example` into your process manager's environment;
the server deliberately does not load parent-project environment files.

Codex uses the local machine's existing Codex authentication. The server does
not accept or require an OpenAI API key. **This means every request it serves is
authenticated as your own Codex/ChatGPT account — please read [Account terms and
intended use](#account-terms-and-intended-use) before running it.**

Configuration:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEX_ARTIFACT_TOKEN` | required | Bearer token |
| `CODEX_ARTIFACT_HOST` | `127.0.0.1` | Listen address |
| `CODEX_ARTIFACT_PORT` | `4319` | Listen port |
| `CODEX_ARTIFACT_MODEL` | account default | Optional Codex model |
| `CODEX_ARTIFACT_CONCURRENCY` | `3` | Concurrent image jobs, 1–16 |
| `CODEX_ARTIFACT_JOBS_DIR` | OS temporary directory | Durable job files |
| `CODEX_ARTIFACT_TTL_MS` | 24 hours | Terminal-job retention |
| `CODEX_ARTIFACT_MAX_REQUEST_BYTES` | 96 MB | Maximum multipart request |

See [openapi.yaml](./openapi.yaml) for the complete API contract.

## Text response

```sh
curl http://127.0.0.1:4319/v1/text \
  -H "Authorization: Bearer $CODEX_ARTIFACT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Return exactly: hello"}'
```

An optional `responseSchema` JSON Schema requests a structured final response.

## Image artifact

```sh
curl http://127.0.0.1:4319/v1/images \
  -H "Authorization: Bearer $CODEX_ARTIFACT_TOKEN" \
  -F 'id=my-image-1' \
  -F 'aspectRatio=3:4' \
  -F 'prompt=A natural-light studio portrait' \
  -F 'image=@reference.jpg'
```

The server returns `202 Accepted`. Poll the returned job URL:

```sh
curl http://127.0.0.1:4319/v1/jobs/my-image-1 \
  -H "Authorization: Bearer $CODEX_ARTIFACT_TOKEN"
```

Download completed bytes:

```sh
curl http://127.0.0.1:4319/v1/jobs/my-image-1/result \
  -H "Authorization: Bearer $CODEX_ARTIFACT_TOKEN" \
  --output result.png
```

After safely storing the bytes, acknowledge the job and immediately remove its
prompt, uploaded images, metadata, and result:

```sh
curl -X DELETE http://127.0.0.1:4319/v1/jobs/my-image-1 \
  -H "Authorization: Bearer $CODEX_ARTIFACT_TOKEN"
```

If a client does not acknowledge a terminal job, garbage collection removes it
after its `expiresAt` time. Reading a result extends that expiry so an interrupted
download can be retried safely.

## Account terms and intended use

This server does not use an OpenAI API key. It drives the Codex CLI and SDK
already installed on the machine, so every request it serves runs as *your*
Codex/ChatGPT account and consumes that account's entitlements.

Please take that seriously rather than as boilerplate. Putting an HTTP interface
in front of those credentials turns a personal, interactive subscription into a
programmatic API, which is not what a consumer plan is sold as. Depending on how
it is deployed, that can breach the terms governing your OpenAI account.

Use it as a local convenience for yourself, on your own machine. Do not:

- expose it to other people, a shared network, or the public internet;
- use it to provide a service to third parties, or resell its output;
- use it to work around API pricing, quotas, or rate limits;
- run it as backing infrastructure for a product or a commercial deployment.

If you need programmatic access for an application, use the OpenAI platform API
with your own API key and the commercial terms that come with it. That is the
supported path, and this project is not a substitute for it.

You are responsible for your own compliance. Consult the terms and policies that
apply to your account:

- <https://openai.com/policies/terms-of-use/>
- <https://openai.com/policies/usage-policies/>

This project is not affiliated with OpenAI, and nothing here is legal advice.

## Security boundary

This is not an internet-ready multi-tenant service. It lacks TLS, durable
identity-based authentication, rate limits, tenant-isolated storage, audit
logging, and a strict request policy.

Building those in would not make exposing it acceptable, because the blocker is
not only technical: the credentials behind it are a personal Codex/ChatGPT
account, as described in [Account terms and intended
use](#account-terms-and-intended-use). Treat `127.0.0.1` as the intended and only
deployment.

The image endpoint is an adapter over a local Codex agent using its available
image-generation capability. It is not an implementation of the OpenAI Images
API, and availability depends on the local Codex environment.

Image requests are buffered fully in memory up to
`CODEX_ARTIFACT_MAX_REQUEST_BYTES` before they are parsed. That is a deliberate
simplification for a local, single-user service.

## License

MIT. See [LICENSE](./LICENSE).

This is an independent project. It is not affiliated with, endorsed by, or
supported by OpenAI; it only calls the Codex SDK installed on the local machine.
