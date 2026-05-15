---
summary: "Use VEFaaS as a remote sandbox backend for OpenClaw agents"
title: VEFaaS sandbox
read_when:
  - You want VEFaaS-hosted remote sandboxes instead of local Docker
  - You are setting up the VEFaaS sandbox plugin
  - You need the production transport model for VEFaaS cloud sandboxes
---

The VEFaaS sandbox plugin registers the `vefaas` sandbox backend for OpenClaw.
OpenClaw uses it to create VEFaaS sandbox applications, start cloud sandbox
instances, seed a remote workspace, and run agent tools against that remote
workspace.

The production path uses the Volcengine VEFaaS SDK for the control plane and the
VEFaaS All-in-One sandbox runtime for execution. When an HTTP route to the
All-in-One runtime is configured, OpenClaw calls `/v1/bash/exec` and file APIs
directly. Without an HTTP route, the plugin falls back to the VEFaaS WebShell
endpoint returned by `GenWebshellEndpoint`, so `exec`, `read`, `write`, `edit`,
and `apply_patch` can still run through the remote shell.

## Prerequisites

- VEFaaS sandbox plugin installed with `openclaw plugins install @openclaw/vefaas-sandbox`
- Volcengine credentials with permission to create, update, release, list, and
  delete VEFaaS functions and sandbox instances
- Node.js 22 or newer on the Gateway host
- A VEFaaS sandbox image. The default is
  `enterprise-public-cn-beijing.cr.volces.com/vefaas-public/all-in-one-sandbox:1.9.3`
- Optional but recommended for production: an HTTP route or API Gateway route to
  the All-in-One runtime port so OpenClaw can call shell and file APIs directly

The plugin reads SDK credentials from `VOLCSTACK_ACCESS_KEY_ID`,
`VOLCSTACK_ACCESS_KEY`, `VOLCENGINE_ACCESS_KEY`, `VOLCENGINE_ACCESS_KEY_ID`,
`VOLCSTACK_SECRET_ACCESS_KEY`, `VOLCSTACK_SECRET_KEY`, `VOLCENGINE_SECRET_KEY`,
and `VOLCENGINE_SECRET_ACCESS_KEY`. You can also pass `accessKeyId`,
`secretAccessKey`, and `sessionToken` as SecretRefs in plugin config.

## Quickstart

Install and enable the plugin, then set the sandbox backend:

```bash
openclaw plugins install @openclaw/vefaas-sandbox
```

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        backend: "vefaas",
        scope: "session",
        workspaceAccess: "rw",
      },
    },
  },
  plugins: {
    entries: {
      "vefaas-sandbox": {
        enabled: true,
        config: {
          functionName: "openclaw-vefaas-sandbox",
          region: "cn-beijing",
          mode: "remote",
        },
      },
    },
  },
}
```

On the next sandboxed agent turn, OpenClaw creates or reuses the VEFaaS sandbox
function, releases the latest revision, starts a sandbox instance, seeds the
remote workspace, and runs tools in that instance.

Verify the runtime:

```bash
openclaw sandbox list
openclaw sandbox explain
```

## Configure direct HTTP access

The WebShell fallback is useful for first success and environments without a
published route. For production throughput, configure an HTTP route to the
All-in-One runtime and set `access.baseUrl`:

```json5
{
  plugins: {
    entries: {
      "vefaas-sandbox": {
        enabled: true,
        config: {
          functionId: "<VEFAAS_SANDBOX_FUNCTION_ID>",
          region: "cn-beijing",
          access: {
            baseUrl: "https://<gateway-host>/<route-prefix>",
            apiKey: { source: "env", id: "VEFAAS_SANDBOX_API_KEY" },
          },
        },
      },
    },
  },
}
```

The route must forward to the sandbox instance's All-in-One HTTP port, which is
`8080` by default. When `access.baseUrl` is set, the plugin sends the provider
instance name as both the `faasInstanceName` query parameter and the
`x-faas-instance-name` header so routing layers can select the right sandbox
instance.

## Workspace model

The VEFaaS backend supports `remote` mode. The remote workspace is canonical
after the first seed:

- On first use, OpenClaw uploads the local workspace into `remoteWorkspaceDir`.
- `exec`, `read`, `write`, `edit`, and `apply_patch` operate against the remote
  VEFaaS workspace.
- OpenClaw does not automatically sync remote changes back to the local checkout.
- Host-local edits after the first seed are not visible until the sandbox is
  recreated.

Use `openclaw sandbox recreate` when you want a fresh remote workspace seeded
from the current local checkout.

## What the plugin creates

When `functionId` is not set, the plugin creates or reuses a VEFaaS function
named by `functionName` with:

- `FunctionType: "sandbox"`
- `Runtime: "native/v1"`
- `SourceType: "image"`
- `Source`: the configured sandbox image
- `Command`: `imageCommand`, defaulting to `/opt/gem/run.sh`
- `Port`: `8080` by default

For each OpenClaw sandbox runtime, the plugin calls `CreateSandbox` with the
OpenClaw sandbox name as `SessionId` and metadata. It uses `ListSandboxes` plus
`ListFunctionInstances` to find the exact provider instance, then uses
`GenWebshellEndpoint` for the WebShell fallback and `KillSandbox` for cleanup.

## Configuration reference

All VEFaaS plugin config lives under
`plugins.entries["vefaas-sandbox"].config`:

| Key                       | Type                  | Default                        | Description                                                    |
| ------------------------- | --------------------- | ------------------------------ | -------------------------------------------------------------- |
| `mode`                    | `"remote"`            | `"remote"`                     | Workspace mode. Only `remote` is supported.                    |
| `functionId`              | `string`              | -                              | Existing VEFaaS sandbox function id.                           |
| `functionName`            | `string`              | `"openclaw-vefaas-sandbox"`    | Function name to create or reuse when `functionId` is omitted. |
| `accessKeyId`             | `SecretRef` or string | env fallback                   | VEFaaS control-plane access key.                               |
| `secretAccessKey`         | `SecretRef` or string | env fallback                   | VEFaaS control-plane secret key.                               |
| `sessionToken`            | `SecretRef` or string | -                              | Optional temporary credential token.                           |
| `region`                  | `string`              | -                              | VEFaaS region, for example `cn-beijing`.                       |
| `endpoint`                | `string`              | -                              | Optional VEFaaS control-plane endpoint override.               |
| `image`                   | `string`              | VEFaaS public all-in-one image | Sandbox image.                                                 |
| `imageCommand`            | `string`              | `"/opt/gem/run.sh"`            | Container command for sandbox instances.                       |
| `port`                    | `number`              | `8080`                         | All-in-One HTTP port.                                          |
| `remoteWorkspaceDir`      | `string`              | `"/workspace"`                 | Primary writable workspace inside the sandbox.                 |
| `remoteAgentWorkspaceDir` | `string`              | `"/agent"`                     | Agent workspace mirror path.                                   |
| `ttlSeconds`              | `number`              | `3600`                         | Requested sandbox lifetime.                                    |
| `timeoutSeconds`          | `number`              | `120`                          | SDK, shell, and file operation timeout.                        |
| `resources`               | `object`              | -                              | CPU, memory, and GPU request fields.                           |
| `network`                 | `object`              | -                              | Reserved for network placement and egress policy.              |
| `access.baseUrl`          | `string`              | -                              | Optional direct HTTP route to All-in-One APIs.                 |
| `access.apiKey`           | `SecretRef` or string | -                              | Optional API key sent as `Authorization: Bearer`.              |
| `access.headers`          | object                | -                              | Extra HTTP headers for the All-in-One route.                   |
| `env`                     | object                | -                              | Sandbox instance environment overrides.                        |

Sandbox-level settings (`mode`, `scope`, `workspaceAccess`) are configured under
`agents.defaults.sandbox` as with any backend. See
[Sandboxing](/gateway/sandboxing) for the full matrix.

## Limitations

- Browser sandbox/noVNC/CDP support is not implemented for the VEFaaS backend.
- `sandbox.docker.binds` is Docker-specific and is rejected by the VEFaaS
  backend.
- Mirror mode is not implemented. The remote workspace is canonical after the
  first seed.
- WebShell fallback runs through an interactive shell transport. Direct
  `access.baseUrl` HTTP mode is recommended for sustained production traffic.
- The plugin does not create API Gateway or custom HTTP route resources. Create
  that route outside OpenClaw when you want direct All-in-One HTTP access.

## Troubleshooting

`InvalidCredential` from the VEFaaS SDK means the SDK did not receive usable
control-plane credentials. Set the `VOLCSTACK_*` or `VOLCENGINE_*` environment
variables on the Gateway host, or configure `accessKeyId` and `secretAccessKey`
as SecretRefs.

If sandbox creation succeeds but tool execution fails, first check whether
`access.baseUrl` is reachable. If it is not configured, check whether
`GenWebshellEndpoint` is permitted for the VEFaaS account because the plugin will
use WebShell fallback.

If the All-in-One image exits during sandbox startup, verify that required image
environment variables have not been removed by overrides. The plugin supplies a
complete default environment for the public All-in-One image; use `env` only for
specific overrides.

## Related

- [Sandboxing](/gateway/sandboxing)
- [OpenShell](/gateway/openshell)
- [Plugin reference](/plugins/reference/vefaas-sandbox)
