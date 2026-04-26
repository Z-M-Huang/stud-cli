# Tools

Tool extensions add invocable capabilities the LLM can call. Every tool
declares an `inputSchema`, an `outputSchema`, whether it is `gated`
(approval-stack), and (for gated tools) a `deriveApprovalKey` function
producing the per-invocation approval scope.

Reference implementations in this directory:

| ID                    | Approval key     | Use                                                          |
| --------------------- | ---------------- | ------------------------------------------------------------ |
| `simple-tools/read/`  | parent directory | Read a file under the project root.                          |
| `simple-tools/write/` | parent directory | Atomic write within the project root.                        |
| `simple-tools/list/`  | listed directory | Depth-bounded directory walk.                                |
| `edit/`               | parent directory | Targeted in-file edit.                                       |
| `bash/`               | command prefix   | Shell command (most security-sensitive).                     |
| `web-fetch/`          | URL hostname     | HTTP(S) with Network-Policy gating; body marked `untrusted`. |
| `ask-user/`           | none             | Raise a prompt through the Interaction Protocol.             |
| `catalog/`            | none             | Registry introspection.                                      |
| `context-compaction/` | none             | Compact the message history under a token budget.            |

Schema surface: see [`src/contracts/tools.ts`](../../src/contracts/tools.ts).

When in doubt: pick the `simple-tools/read` example as the smallest
gated-tool starter. Pick `bash/` only if you need shell semantics — and
read [`security/Tool-Approvals.md`](../../../stud-cli.wiki/security/Tool-Approvals.md) first.
