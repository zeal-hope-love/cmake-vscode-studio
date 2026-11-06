# Proposal: make the Windows sandbox permission surface user-configurable (integrity level, ACL entries, scope)

Follow-up to #12085, which asks narrowly to opt out of the inheritable Low label.
This one is the bigger ask: **the whole permission surface of the Windows sandbox
should be configurable by the user — integrity level, ACL entries, and where each
one is applied — instead of being a fixed strategy with no knobs.**

## Why this needs saying separately

I searched the discussions (≈1270 threads). Every Windows sandbox report is a
symptom report:

- #9649 — inheritable Low label makes in-tree build outputs run at Low
- #11193 — labeling a volume root bricks every Chromium app on it
- #10676 — temp root / MIC failures
- #10951, #11214, #11312, #11536, #11696, #11760, #12025 … — the large family of
  `0xC0000142` / `STATUS_DLL_INIT_FAILED` / named-pipe DENY failures
- #11090 — asks to *relax* one precondition (ownership check)

And three configuration-shaped requests that are adjacent but **not this**:

- #10882 — **additional writable roots** (scope of what is writable, not how it is confined)
- #11720 — **`backend: 'platform' | 'external'`** (delegate everything to the host)
- #10945 — separate **authorization** from **sandbox mode**

**Nobody has asked for what this proposal asks:** a first-class, user-defined
description of the security posture the Windows ACL backend should apply. The
community keeps patching *outputs* of one hardcoded strategy. The strategy itself
is not addressable.

## The problem in one sentence

`workspace-write` on Windows is **one fixed, opinionated strategy** —
`[Low integrity label (OI|CI)] + [Everyone delete-child deny] + [S-1-4-* capability SID]`
— applied unconditionally to whatever folder the user opens, permanently, with no
visibility, no configuration, and no reclaim path.

Nothing about that bundle is required by the *policy* the user actually selected.
`workspace-write` means "the agent may write inside the workspace and nothing else."
The implementation chose one specific mechanism to enforce it, and then made the
mechanism's side effects non-negotiable.

## What the user should be able to define

### 1. Integrity level

Today the only choice is "Low, inherited, everywhere". The user should be able to
express:

- **level** — `untrusted` / `low` / `medium` (default: `low`)
- **target** — `token` (the agent's process) and/or `tree` (the files) — these are
  currently welded together and only the token one is load-bearing
- **inheritance** — `none` / `OI` / `CI` / `OI|CI` (today: always `OI|CI`)
- **no-write-up** — keep `SYSTEM_MANDATORY_LABEL_NO_WRITE_UP` or not
- **where** — the workspace root vs. a DSH-managed scratch subtree (my preference:
  scratch only, with the user's tree left at ambient integrity)

The key insight, restated because it is the crux: **`integrity: { token: low }` and
`integrity: { tree: low }` should be two settings.** The first confines the agent —
that is the security property. The second demotes every executable the user's
compiler produces — that is the cost, and it is currently indistinguishable from the
benefit.

### 2. ACL entries

The three standing entries should each be individually addressable:

- **`S-1-4-*` capability SID** — keep (the agent's write grant) / drop
- **`Everyone` DENY** — currently `(CI)(DC)` = deny `FILE_DELETE_CHILD` with
  container inheritance. This is what breaks Recycle Bin and `electron-builder`
  cleanup. The user should be able to scope it (only on directories DSH created),
  narrow it, or drop it — and know what it actually protects before doing so.
- **inheritance flags** on each — `OI` / `CI` / both / none

And crucially:

- **an explicit "what will be written" preview.** Before applying, show the exact
  SDDL that will be added. Today the user discovers it afterwards, by reading
  `icacls` output from a forum thread.

### 3. Scope and lifecycle

- **which paths** the entries apply to (workspace root, DSH scratch, explicit extras)
- **exclusions** — `*.exe` / `*.dll` / `*.node` / user-specified globs. Labeling
  executables is net-negative anyway (see below), so this should arguably be the
  default, not the option.
- **`standing` vs. session-scoped** — today a standing grant is "the intended end
  state, nothing to revoke" (`sandbox-local/src/index.ts:406-416`,
  `grant.ts:116-140`). Should be a choice, and `dsh sandbox release` must exist either way.
- **refuse volume / drive roots** before writing anything (#11193)

### 4. Introspection

- `dsh sandbox status --workspace <dir>` → current label, SID, deny entries,
  inheritance flags, and *which of them DSH wrote* vs. pre-existing
- `dsh sandbox release --workspace <dir>` → remove exactly those

`Get-Acl` does not surface the mandatory label at all; `icacls` is the only way to
see it and nothing tells the user to look. If DSH writes a security descriptor to
the user's filesystem, it should be able to report and remove it.

## Sketch

```yaml
- id: sandbox
  config:
    windowsAcl:
      integrity:
        token: { level: low, noWriteUp: true }      # confines the agent — the security property
        tree:  { level: none }                      # was: low + OI|CI on the workspace tree
        scratch: { enabled: true, dir: '.dsh/sandbox' }
      acl:
        workspaceGrant: true                        # the S-1-4-* write grant
        deleteChildDeny:
          enabled: true
          sid: 'Everyone'
          flags: ['CI']
          scope: 'dsh-created'                      # `workspace` replicates today's behavior
        exclude: ['*.exe', '*.dll', '*.node']
      lifecycle:
        standing: false                             # session-scoped by default when configured
        releaseCommand: true
```

Every default above preserves **today's behavior exactly**, so this is a pure
additive surface — nothing breaks for anyone who doesn't touch it.

## The argument that makes this more than a convenience request

This is not only "let me loosen the sandbox." On the most important axis, the user
being able to change THIS setting makes the system **safer**:

**Labeling the tree makes workspace binaries less protected, not more.**

- `.exe` stays `Medium` → the confined Low agent process is subject to
  `NO_WRITE_UP` and **cannot overwrite it**
- `.exe` inherits `Low` → the Low agent process **can** overwrite it
- the user then runs that binary at `Medium` — double-click, `npm run dev`, installer, CI

So inheritance grants the confined process a write capability over **executables
that the user later runs elevated**. That is a new write surface created by the
confinement mechanism itself. On that axis, exposing the switch is a *hardening*
change: `tree.level: none` + `token.level: low` is strictly better than today for
this threat.

The maintainers' README already concedes the consequence:

> 诊断保留完整性标签——它无法修复 Low 标签的可执行文件影响用户在 DSH 外启动程序的问题

That documents the inability to fix it. It does not argue the bundle is the only
correct posture — and a bundle whose parts have opposite signs on cost/benefit is
exactly where a configuration surface belongs.

## What I am not asking for

Not `danger-full-access` with a nicer name. That mode drops the **file guard** too,
which I want to keep:

| | file guard | process confinement | tree labeled |
| --- | --- | --- | --- |
| `danger-full-access` | ✗ | ✗ | ✗ |
| `workspace-write` today | ✓ | ✓ | ✓ permanently |
| **what I want** | **✓** | **✓** | **✗** |

I want the middle-of-the-road posture that currently does not exist.

## My context (why this matters day to day)

Multi-project root; primary project is Electron + electron-vite + React
(`npm run dev`, `npm run dist:installer`, `npm run dist:setup`), plus C/C++
firmware with `GCC cross-toolchain` / Ninja / vendor code generator.

With the label active: `npm run dev`'s Electron main runs at **Low** and gets
`EPERM` writing its own `%APPDATA%` config and the target project directory — while
the **packaged** build (installed under `%LOCALAPPDATA%\Programs\`) works fine.
Same source, same Electron version. That "dev broken / product fine" asymmetry is
what makes this so expensive to diagnose, and why I would rather configure it once.

Currently the tree reads `Medium` because I cleaned it manually. That is a window,
not a fix — the next provision closes it silently.

## Ask

If a full strategy config is too large a surface right now, the minimum that would
make this actionable:

1. **`dsh sandbox status` / `dsh sandbox release`** — see it, remove it. Removes the
   "unrecoverable" property on its own.
2. **Split `integrity.token` from `integrity.tree`** — the single highest-value knob,
   because it separates the security property from the cost.
3. **Don't inherit onto executables** — arguably should just be the default (§ above).
4. **Refuse volume roots** before writing (#11193).

Even 1 + 2 would turn this from "breaks my dev loop and I can't stop it" into
"a documented tradeoff I can tune."

Happy to test a build, and to provide the P/Invoke integrity-reader script, the
`icacls` before/after dumps, and the `electron-builder` failure output.