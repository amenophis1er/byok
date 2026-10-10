# Changelog

All notable changes to this package. It follows [semantic versioning](https://semver.org);
while on 0.x, a breaking change bumps the minor version.

## 0.5.0 — renamed to @amenophis1er/byok, published to npm

- Published to the npm registry as **`@amenophis1er/byok`**, with provenance,
  instead of installed from git as `@amenophis1er/extension-ai-connect`. Same
  code, same storage: see "Coming from extension-ai-connect" in the README.
- **`PROTOCOL_VERSION`**: every client message carries `v`; a worker meeting a
  newer protocol refuses the message with an error asking to reload the
  extension. Messages without `v` are read as version 1, so existing clients
  keep working.
- The public API is recorded in `api/*.api.md` and checked in CI.
- No more compile-on-install: the package ships its built `dist/`, and `dist/`
  is no longer committed to git.

## 0.4.1

- ChatGPT models come from the account's Codex catalog (`listModels`), with the
  built-in list as a fallback.

## 0.4.0

- `chat()` with tool calling for the ChatGPT subscription (Codex Responses API).
- Clearer network errors, marked `retryable` when sending again is safe.

## 0.2.0 – 0.3.0

- `chat()`: one model turn with native tool calling, streamed and validated to
  the provider's terminal event, for Anthropic and OpenAI-compatible servers.
- PDF `document` parts.

## 0.1.0

- BYO-key connections for Chrome extensions: encrypted key storage, Claude
  subscription OAuth, ChatGPT device sign-in, Ollama Cloud device keys,
  OpenAI-compatible servers, one message-passing API.
