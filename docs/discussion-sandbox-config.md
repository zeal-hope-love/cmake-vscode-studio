# Feature request: user-configurable Windows sandbox ACL strategy (opt-out of the inheritable Low integrity label)

## TL;DR

On Windows, `workspace-write` persists three edits onto the workspace root DACL:
an inheritable Low integrity label, an `Everyone` delete-child deny, and a
`S-1-4-*` capability SID. Two of the three are **standing by design** — they survive
session end, DSH restart, and uninstall. There is **no supported way to turn the
label off, no way to customize the strategy, and no way to reclaim it**.

This is a request for a **configuration knob**, not only for a bug fix. The other
reports (#9649, #11193, #10676, #10951…) document the damage; this one asks for the
control surface that would let a user who understands the tradeoff avoid it.

I am proposing **two independent switches**, because they carry very different risk
and the maintainers may reasonably accept one and not the other:

- **A — process confinement** (restricted token / Low integrity token). This is the
  part that actually confines the agent. Removing it is a real safety regression, so
  it must be explicit, loud, and per-session.
- **B — workspace tree labeling** (the inheritable `OI|CI` Low label on the tree).
  **This is the part that hurts, and removing it costs the maintainers little** —
  see the argument in §4, which nobody has made in the other threads.

## 1. Environment

- Windows 11 `10.0.26200`, DSH Desktop (Electron), per-user install
- Workspace: `<workspace-root>` — a multi-project root
- Primary project: an Electron + electron-vite + React desktop app
  (`npm run dev`, `npm run dist:installer`, `npm run dist:setup`)
- Also: C/C++ firmware projects with `GCC cross-toolchain`, Ninja, vendor code generator under the same root

## 2. What the sandbox writes, and what stays

Observed on the workspace root while the label was active:

```
Everyone:(CI)(DENY)(DC)
S-1-4-275285986-556314953:(OI)(CI)(W,D,DC)
Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)   ← the one that matters
```

`packages/sandbox/sandbox-local/src/index.ts:406-416` calls
`materializeAclGrant(workspaceRoot)` with `standing = true`, and the catch block
states that a standing ACE "is the intended end state, not an error artifact —
nothing to revoke." `AclWriteGrant.dispose()` (grant.ts:116-140) revokes only
`revocablePaths` and leaves `standingPaths` alone.

So: **by design, permanent, and not revocable by the user.** The maintainers already
say so in the docs; the request is that "permanent" become a choice, not an
unconditional consequence of opening a folder.

## 3. Why this is expensive for a real project (my actual state)

### 3.1 The build output poisons itself

Every `.exe` produced in the tree inherits the label. Measured on my machine at the
time: **40 of 40 executables under the project were `Low`**, including
`node_modules\electron\dist\electron.exe`.

A clean control experiment — same binary, same parent process, only the directory
differs:

```
<workspace-root>\proj\.tmp   LOW(4096)      ← inside the tree
...\DSH_Workspace                           LOW(4096)      ← workspace root
...\<other-dir>                              Medium(8192)   ← outside
...\AppData\Local\Temp                      Medium(8192)   ← outside
```

So `npm run dev` launches an Electron main process that runs at **Low**, and it
cannot write its own `%APPDATA%` config or the target project directory:

```
EPERM: operation not permitted, open 'C:\Users\<user>\AppData\Roaming\<app>\probe.txt'
```

Meanwhile the **packaged build works fine** — it is installed under
`%LOCALAPPDATA%\Programs\`. Same source, same Electron version; the only difference
is the integrity label on the image. That asymmetry is the worst part for me: it
makes the packaged product look fine while the development loop is broken, so it
reads as "my dev setup is broken" rather than "the sandbox did this."

### 3.2 Deployment cleaning fails

`electron-builder` cleaning old artifacts, and moving old `release\` folders to the
Recycle Bin, fail against the `Everyone:(CI)(DENY)(DC)` entry
(`genie-trash: Some operations were aborted`). I have to fall back to
`Remove-Item -Force` outside the sandbox, which bypasses whatever the deny was
protecting anyway.

### 3.3 It is invisible and it comes back

- `Get-Acl` does not show the mandatory label; the usual "right-click → Properties →
  Security" shows a perfectly normal ACL. `icacls` is the only way to see it, and
  nothing tells the user to look.
- The failure mode is `EPERM`, which reads like "file is locked / read-only".
- Any manual cleanup is undone on the next provision — with no notice, as #9649 asks.

### 3.4 Today my only options are both bad

| Option | Cost |
| --- | --- |
| `danger-full-access` | Turns off the **file guard** too, not just process confinement. I lose the protection I actually want. |
| `read-only` | Can't work at all. |
| Manual `icacls` after every provision | Not automatable reliably; the `S-1-4-*` SID cannot be removed with `icacls /remove` (`ERROR_NONE_MAPPED` 1332). |

There is no fourth option. That is the gap.

## 4. The safety argument for making the label configurable

This is the part I would most like the maintainers to consider, because it inverts
the usual "turning a sandbox feature off makes things less safe" intuition.

**Labeling the tree makes the workspace binaries *less* protected, not more.**

- If a workspace `.exe` stays `Medium`: the confined Low agent process is subject to
  `SYSTEM_MANDATORY_LABEL_NO_WRITE_UP` and **cannot overwrite it**.
- With the label inherited: the `.exe` is `Low`, so the Low agent process
  **can** overwrite it.
- The user then runs that binary at `Medium` — double-click, `npm run dev`, an
  installer, CI on the same tree.

So the current strategy grants the confined process a capability that the default
would have withheld: **rewriting executables that the user later runs at Medium
integrity.** That is a new write surface, created by the confinement mechanism
itself.

Removing the label from the tree — while keeping the restricted token — is therefore
**not** a pure relaxation. On this specific axis it is a strengthening. If anything,
"don't label executables" is a hardening suggestion, and the configuration switch is
just the natural way to expose it.

(To be explicit: I am not arguing that the whole sandbox is net-negative. The token
confinement is doing real work. It's specifically the *inheritable tree label* whose
cost/benefit does not work out on a development workspace.)

## 5. Proposal

### 5.1 The config surface I would like

Something at the plugin level, e.g.:

```yaml
- id: sandbox
  config:
    windowsAcl:
      # Which objects get the inheritable Low label. Default preserves today's behavior.
      integrityTargets: ['agent-scratch']   # | 'workspace' (current) | 'none'
      # Where agent-scratch lives (created and managed by DSH, not the user's tree)
      scratchDir: '.dsh/sandbox'            # relative to workspace root
      # Keep the standing ACL grant (needed for the agent to write the workspace)
      workspaceGrant: true
      # Reclaim command, see 5.2
      allowRelease: true
```

The essential idea: **separate "the agent may write the workspace" from "the
workspace tree is Low-integrity."** They are currently welded together, and only the
first is actually required for the agent to be useful.

`integrityTargets: 'agent-scratch'` would label only a dedicated subdirectory the
agent uses for scratch work, leaving build outputs at the ambient integrity — while
the restricted token still limits what the agent's own processes can write.

### 5.2 A reclaim path (needed regardless of 5.1)

```
dsh sandbox status  [--workspace <dir>]   # show label / SID / deny entries
dsh sandbox release [--workspace <dir>]   # remove label + S-1-4-* ACE + Everyone deny
```

The docs already note that manual `icacls` fails with `ERROR_NONE_MAPPED` (1332) for
the `S-1-4-*` SID. If the tool can write those entries, it should be able to remove
them; making users reimplement that in PowerShell is the worst part of the current
experience.

### 5.3 Minimum acceptable fallback

If a full strategy config is out of scope, these would already remove most of my pain:

1. **`dsh sandbox release`** — even just for the workspace root, even if the next
   provision re-applies it. It turns "unrecoverable" into "annoying."
2. **Don't inherit the label onto executables.** After `grantWrite`, reset `*.exe`,
   `*.dll`, `*.node` to `Medium`. Cost: newly built binaries need re-correction, so
   either rescan on provision or use a directory watcher.
3. **Warn at provision time** when the workspace already contains or will contain
   executables, with a one-line explanation and the recovery command. The bundled
   `diagnose-windows-sandbox-acl` skill is the natural home for this.
4. **Refuse volume roots and drive-letter roots** before writing anything (#11193) —
   same class of "target validation before destructive edit."

### 5.4 On "by design / documented"

I want to be fair to the maintainers here. The README already concedes:

> 诊断保留完整性标签——它无法修复 Low 标签的可执行文件影响用户在 DSH 外启动程序的问题

That is an admission that it **cannot be fixed**, not that it **need not be fixed**.
A side effect that is invisible, unrecoverable by the user, permanently attached to
the user's filesystem after uninstall, and that silently breaks the development loop
of any project that compiles an executable — that is the case for a supported escape
hatch, even keeping every default exactly as it is today.

## 6. Why a config knob rather than just fixing the default

I don't think the default should necessarily change — a read-only or
`workspace-write` agent on an untrusted repository is a real scenario, and the label
is a genuine hardening for *source files*. The problem is that the same mechanism is
applied unconditionally to a **directory the user chose because they trust it** —
their own project root.

The user is the only party who knows whether a given folder is a throwaway clone or
the working copy of the app they ship. That asymmetry is exactly what a config knob
is for.

To be concrete: I am not asking for `danger-full-access` with a nicer name. I want
`workspace-write` (file guard on, agent cannot wander) **minus** the part that
permanently demotes every binary my compiler produces.

## 7. Related discussions

- #9649 — inheritable Low label makes in-tree build outputs run at Low integrity
- #11193 — labeling a volume root bricks every Chromium app on it
- #10676 — Windows temp root Low label / MIC failures
- #10882 — additional writable roots (a different axis of the same "the policy is
  all-or-nothing" problem)
- #11720 — `external` sandbox backend (proposes `backend: 'platform' | 'external'`;
  an adjacent configuration-surface precedent)
- #11090 — relaxing the Windows ACL preconditions

## 8. Current state on my machine (for calibration)

Right now the workspace root and all 36 executables under the project read
`Medium Mandatory Level` — I cleaned it manually. That is not a fix; it is a
temporary window that closes the next time DSH writes in this folder, and I will
have to notice it again through an `EPERM` that points nowhere.

I would rather configure this once and stop thinking about it.

Happy to test a build, or to provide the full P/Invoke reproduction script and the
`icacls` output for any proposal above.