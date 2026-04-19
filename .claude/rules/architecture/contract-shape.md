# Contract shape (meta-shape)

Every extension category has a typed, versioned contract. This file is the **meta-shape** that every per-category contract specializes.

> Wiki source: [`../../../../stud-cli.wiki/contracts/Contract-Pattern.md`](../../../../stud-cli.wiki/contracts/Contract-Pattern.md).

---

## The eleven fields

```ts
interface ExtensionContract<TConfig> {
  readonly kind: CategoryKind;
  readonly contractVersion: SemVer; // e.g., "1.3.0"
  readonly requiredCoreVersion: SemVerRange; // e.g., ">=1.0.0 <2.0.0"
  readonly lifecycle: LifecycleFns;
  readonly configSchema: JSONSchema; // validates TConfig
  readonly loadedCardinality: Cardinality; // unlimited | one | n
  readonly activeCardinality: Cardinality; // unlimited | one | "one-attached"
  readonly stateSlot: StateSlotShape | null;
  readonly validationSeverity: "critical" | "optional";
  readonly discoveryRules: DiscoveryRules;
  readonly reloadBehavior: "in-turn" | "between-turns" | "never";
}

interface LifecycleFns {
  init?(host: HostAPI, cfg: TConfig): Promise<void>;
  activate?(host: HostAPI): Promise<void>;
  deactivate?(host: HostAPI): Promise<void>;
  dispose?(host: HostAPI): Promise<void>; // always idempotent
}
```

Every field is **normative**. An extension whose contract omits a field or mis-specifies its type fails validation.

## Field notes

- **`kind`** — fixed at load. An extension cannot change category.
- **`contractVersion`** — core refuses to load an extension whose `contractVersion` is incompatible with core.
- **`requiredCoreVersion`** — semver range; excludes or includes the current core version.
- **`lifecycle`** — implement any subset; missing ones default to no-op. `dispose` is **always idempotent**.
- **`configSchema`** — lives in the contract (not the implementation) so the wiki can describe what a conforming extension accepts. See "Config schema" below.
- **`loadedCardinality`** — how many may load (e.g., `unlimited` for most; `one` for rare singletons).
- **`activeCardinality`** — how many may be active (`one` for UI interactor and Session Store; `one-attached` for State Machines; `unlimited` for the rest).
- **`stateSlot`** — shape of per-extension state persisted by the active Session Store. `null` ⇒ entirely stateless across resume. A slot declares its own version for drift handling.
- **`validationSeverity`** — `critical` → session refuses to start if the extension fails to load. `optional` → warn-and-skip.
- **`discoveryRules`** — where on disk the extension is found and how it participates in ordering manifests.
- **`reloadBehavior`** — `in-turn` (any stage boundary), `between-turns` (only outside a turn), `never` (requires session restart).

## Config schema pattern

The contract's `configSchema` is a JSON-Schema document. Core uses it to:

1. Reject malformed config before the extension sees it.
2. Route config through `host.config.readOwn()`.
3. Produce diagnostics pointing at exact field paths.

For every new contract, provide three fixture shapes alongside the schema:

1. **Valid** — the minimal conforming config; tests assert this loads.
2. **Invalid** — the smallest breaking input; tests assert this returns a typed `Validation` error with a correct path.
3. **Worst-plausible** — realistic hostile input (deep nesting, unexpected types, unicode quirks); tests assert graceful rejection, not crash.

Do **not** validate runtime shape; only config. Runtime payload shape is a code concern — not something the wiki or the contract describes.

## Invariants for every contract

- **One category per extension.** No multi-role extensions.
- **One contract version per extension load.** An extension cannot speak `v1` for one handler and `v2` for another.
- **Contract is normative; reference is illustrative.** A reference extension may never redefine a contract field.
- **Config is validated; runtime fields are not.**
- **No extension reaches another extension's state slot.** Only `host.session.stateSlot(extId)` and only for its own `extId`.

## Changelog discipline

Every contract change requires a `contractVersion` bump and a changelog entry on the wiki page. Breaking changes to the meta-shape itself are recorded on the affected category contracts' changelogs; the meta-shape page has no independent version.
