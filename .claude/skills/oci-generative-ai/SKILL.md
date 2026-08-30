---
name: oci-generative-ai
description: OCI Generative AI + Enterprise AI Agents integration for Node/TS apps — Responses API (OpenAI-compatible), auth (API key vs OCI request signing), endpoints/regions, agents (Conversations, tools: File Search/Code Interpreter/Function Calling/MCP Calling), vector stores, NL2SQL, oci-sdk usage. Use when calling OCI GenAI from a web app, debugging 400s/401s, or wiring agents/RAG/MCP.
---

# OCI Generative AI — integration guide (Node/TypeScript)

Verified: this repo (`oci-proxy.js`, `oci-auth.js`, `pi-brain.js`, `genaiAgentsService.js`, `guardrails.js`, DMCC `oci-llm.js`) + official docs
(https://docs.oracle.com/en-us/iaas/Content/generative-ai/agents.htm). Full research: `docs/research/oci-generative-ai.md` .

## Two ways to build agents (official)

1. **OCI Responses API (API-first)** — what this repo uses. OpenAI-compatible syntax, OCI authentication + OCI-managed execution. Multi-step agent workflows, conversations, tools (File Search, Code Interpreter, Function Calling, MCP Calling), foundational APIs (Files, Vector Stores, Containers — all OpenAI-compatible).
2. **Hosted agentic applications** — package your own agent runtime as a container; OCI IAM identity-domain application, OAuth/SSO, public/private endpoints, managed storage (OCI PostgreSQL/Cache/ADB). Use when you already have an agent runtime to deploy.
3. Hybrid.

## Core mental model: two hosts, two auths (repo-verified)

| Host | Base path | Auth | Used for |
|---|---|---|---|
| `inference.generativeai.<REGION>.oci.oraclecloud.com` | `/openai/v1` | Bearer API key (`sk-...`: `OCI_GENAI_API_KEY \|\| API_KEY_1 \|\| API_KEY_2`) | MODEL CALLS (Responses/chat), files, vector-store **search**, uploads — data plane |
| `generativeai.<REGION>.oci.oraclecloud.com` | `/20231130` (+ `/openai/v1` variant) | **OCI request signing** (`~/.oci/config`: user OCID, tenancy OCID, fingerprint, PEM key; oci-sdk `ConfigFileAuthenticationDetailsProvider`) | ListModels, vector-store/semantic-store CRUD, containers — control plane. Bearer key → 401 here |

- Region default in repo: `us-chicago-1` (env `OCI_REGION`).
- Agentic/OpenAI-compatible regions (OC1): sa-saopaulo-1, eu-frankfurt-1, ap-hyderabad-1, ap-osaka-1,
  me-riyadh-1, uk-london-1, us-ashburn-1, us-chicago-1, us-phoenix-1. UAE East excluded for
  OpenAI-compat endpoints; xAI models only in us-ashburn-1/us-chicago-1/us-phoenix-1. Dedicated
  mode: use the AI-cluster endpoint OCID as `model` (must match cluster region). On-demand: `vendor.name` ids.
- GenAI API keys (`ocid1.generativeaiapikey...`): created in the SAME region as the model; IAM must
  authorize: `allow any-user to use generative-ai-family in compartment <c> where ALL {request.principal.type='generativeaiapikey', request.principal.id='<key-ocid>'}`.
- Legacy "Generative AI Agents" managed service (`agent.generativeai.<r>...`, oci-generativeaiagent
  SDK, sessions/knowledge bases) is NOT the recommended path — Enterprise AI = Responses API / hosted apps.
- Headers every model call needs: `openai-project` (`OCI_GENAI_PROJECT_ID` — REQUIRED for gemini/Vertex passthrough or 400), `opc-compartment-id` (`OCI_COMPARTMENT_ID`).
- Prod control-plane: mount `./.oci:/root/.oci:ro` (HOME=/root); dev without `.oci` → `/api/models` errors (expected).

## Responses API (agent path in this app)

- Request via pi-agent's `streamOpenAIResponses` against `/openai/v1/responses` (see pi-agent-sdk skill for payload rules).
- **Conversations & memory**: Conversations API keeps cross-turn context; pass `conversation` + `store:true`. **Projects** group agent resources (responses, conversations, files, containers) and configure memory: *long-term memory* (persistent across related interactions in a project) and *short-term memory* (within a conversation). Repo: `OCI_CONVERSATIONS=1` → sessionId = conversation id; skip client history replay + compaction.
- **Tools** (supported via Responses): File Search, Code Interpreter, Function Calling, MCP Calling. Foundational: Files, Vector Stores, Containers — OpenAI-compatible, combine in one workflow.
- **NL2SQL**: `GenerateSqlFromNl` API + Semantic Store (structured-data vector store); query execution via DBTools MCP Server. Source must be Oracle Autonomous AI Database. (Repo has semantic-stores API route.)
- Response API quirks vs real OpenAI (repo-proven, `pi-brain.js ociCompatPayload`): gemini rejects `reasoning` block (400 thinking_level) · requires `instructions` hoist (system/developer roles rejected as input) · strip reasoning parts on continuation · delete `function_call.id` keep `call_id` · `reasoning.effort` valid = minimal|low|medium|high|xhigh ("none" rejected) · conversation + `previous_response_id` can't combine · JSON mode via `text_format json_schema`.

## Chat (native oci-sdk path — DMCC stack, oci-llm.js)

```js
import * as ociGenerativeAiInference from 'oci-generativeaiinference';
// auth: ConfigFileAuthenticationDetailsProvider (or SimpleAuthenticationDetailsProvider with key content)
const client = new ociGenerativeAiInference.GenerativeAiInferenceClient({ authenticationDetailsProvider });
const response = await client.chat({ chatDetails: {
  compartmentId, servingMode: { servingType: 'ON_DEMAND', modelId },
  chatRequest: { apiFormat: 'GENERIC',
    messages: [{ role: 'SYSTEM'|'USER'|'ASSISTANT', content: [{ type: 'TEXT', text }] }],
    maxTokens, temperature, topP, topK: -1 /* Llama 4 rejects 0 */, isStream: false } } });
```
- Packages: `oci-common` + `oci-generativeaiinference` (Node). Wrap `client.chat(...)` in your own timeout; map service errors to friendly messages; validate compartmentId/modelId first.
- Streaming: `isStream: true` + async iterator over SSE chunks.

## Node oci-sdk essentials

- Packages: monolith `oci-sdk` (repo ^2.124.0; current 2.139.x safe) or granular `oci-common`,
  `oci-generativeai` (control plane), `oci-generativeaiinference` (inference), `oci-generativeaiagent*` (legacy).
- Client init: `new oci.generativeai.GenerativeAiClient({ authenticationDetailsProvider })` from
  `ConfigFileAuthenticationDetailsProvider('~/.oci/config','DEFAULT')`; endpoint setter APPENDS
  `/20231130` — always pin `client.endpoint` (or provider region) per region, else cross-region config hits wrong host.
- Streaming native chat: `isStream: true` returns raw WHATWG `ReadableStream<Uint8Array>` (no typed
  async-generator helper) — parse SSE yourself (`data: {...}` until `[DONE]`); repo does this in responses/route.js.
- Errors: SDK throws `common.OciError` `{statusCode, serviceCode, message, opcRequestId, ...}` — log
  `opcRequestId` (key Oracle support needs). OpenAI-compat endpoints return `{error:{message,type,code}}`
  (sometimes mid-stream SSE `event: error`). Guardrails: native `ApplyGuardrails` = SIGNED call to
  `generativeai.{r}/20231130/actions/applyGuardrails` (repo guardrails.js).
- 404 "Authorization failed or requested resource not found" = model not served/permitted in that region.

## Guardrails & governance

- `ApplyGuardrails` (env `OCI_GUARDRAILS=1` in repo, fail-open design); 404 on us-chicago-1 today → active controls: model self-refusal + HITL approvals + tool policy.
- Enterprise AI Governance = security/compliance layer for enterprise models/agents (official).

## Gotchas

- gemini + Responses REQUIRES `openai-project` header; never send reasoning to gemini-2.5*.
- IPv6 bridge black hole: pin IPv4 (`lib/network-compat`) in containerized Node.
- SDK defaults (openai: 10-min timeout / 2 retries) are a chat-UI latency trap — set explicit timeouts.
- OCI does NOT honor `prompt_cache_key`/`session_id` today — own TTL caches.
- Model IDs env-only; no hardcoded models (MODEL_ID); client default `NEXT_PUBLIC_DEFAULT_MODEL` baked at build.

## Official docs

- Agents: https://docs.oracle.com/en-us/iaas/Content/generative-ai/agents.htm
- Overview (models/agents/governance): https://docs.oracle.com/en-us/iaas/Content/generative-ai/overview.htm
- API reference + region endpoint catalog (model-endpoint-regions.htm) + OpenAI-compat API (openai-compatible-api.htm); full research report: `docs/research/oci-generative-ai.md` (36KB: auth/signing, regions, native vs Responses, oci-sdk TS patterns, route→API map).
