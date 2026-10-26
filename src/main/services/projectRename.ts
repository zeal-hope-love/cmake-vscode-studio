/**
 * 「把工程名统一成文件夹名」—— 检测到不一致时的一键改名。
 *
 * 为什么需要：工程从一个模板复制出来、目录改名了，但 CMakeLists.txt 里的
 * `set(CMAKE_PROJECT_NAME ...)` 还留着模板的名字，于是
 *   · 构建产物叫 <旧名>.elf / .hex / .bin
 *   · 而 VSCode 的构建分析器、Keil 工程覆盖、别人看目录名时都按**文件夹名**去找
 * 结果就是「名字对不上、工具链里查不到」这类怪问题。
 *
 * 改名范围刻意很小 —— 只改**真正决定名字的那一处**：
 *   · CMakeLists.txt 里的 `set(CMAKE_PROJECT_NAME 旧名)` / `project(旧名)`
 *   · .ioc 文件名（可选）和它内部的 ProjectManager.ProjectName
 * 其它地方（cmake/user.cmake、cmake/stm32cubemx/CMakeLists.txt）用的都是
 * `${CMAKE_PROJECT_NAME}` 这种引用，改上面那一处就自动跟着变。
 *
 * **不改**：MDK-ARM/ 里的 Keil 工程（那是另一个构建系统的残留，改名没意义）、
 * 文档和笔记（改了对构建没帮助，反而破坏你写的东西）。
 */

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, posix, sep } from 'node:path'
import type { RenamePlan, RenameFileChange } from '@shared/types'
import { inspectVscodeOwnership } from './vscodeOwnership'
import { captureSnapshot } from './snapshotStore'
import { recordWrite } from './historyStore'

/** 名字比较：忽略大小写，把 - 和 _ 视作等价（很多工程两者混用） */
export function sameName(a: string, b: string): boolean {
  const norm = (s: string): string => s.toLowerCase().replace(/[-_]/g, '')
  return norm(a) === norm(b)
}

/** 从 CMakeLists.txt 里读出当前声明的工程名（优先 CMAKE_PROJECT_NAME，其次 project()） */
export function readCmakeProjectName(text: string): { name: string; kind: string } | null {
  const setM = /set\s*\(\s*CMAKE_PROJECT_NAME\s+([A-Za-z0-9_.-]+)\s*\)/i.exec(text)
  if (setM) return { name: setM[1], kind: 'set(CMAKE_PROJECT_NAME ...)' }
  const projM = /project\s*\(\s*([A-Za-z0-9_.-]+)/i.exec(text)
  if (projM) return { name: projM[1], kind: 'project(...)' }
  return null
}

/**
 * 算出改名要动哪些文件（**只算不写**）。
 * 返回每个文件的改前/改后全文，交给界面做 diff。
 */
export function planProjectRename(root: string, newName: string, withIoc = true): RenamePlan {
  const changes: RenameFileChange[] = []
  const notes: string[] = []

  // ---- CMakeLists.txt：真正决定产物名字的地方 ----
  const cmakeFile = join(root, 'CMakeLists.txt')
  if (!existsSync(cmakeFile)) {
    return { root, newName, changes: [], notes: ['工程根没有 CMakeLists.txt，无法改名'], blocked: true }
  }
  const before = readFileSync(cmakeFile, 'utf8')
  const cur = readCmakeProjectName(before)
  if (!cur) {
    return {
      root,
      newName,
      changes: [],
      notes: [
        'CMakeLists.txt 里既没有 set(CMAKE_PROJECT_NAME ...) 也没有 project(...)，认不出当前名字'
      ],
      blocked: true
    }
  }

  let after = before
  let touched = 0
  // set(CMAKE_PROJECT_NAME 旧名) —— 连同行尾注释一起保留
  after = after.replace(
    new RegExp(`(set\\s*\\(\\s*CMAKE_PROJECT_NAME\\s+)${escapeRe(cur.name)}(\\s*\\))`, 'gi'),
    (_m, p1: string, p2: string) => {
      touched += 1
      return `${p1}${newName}${p2}`
    }
  )
  // project(旧名 ...) —— 只换第一个参数
  after = after.replace(
    new RegExp(`(project\\s*\\(\\s*)${escapeRe(cur.name)}(?=\\s|,|\\))`, 'gi'),
    (_m, p1: string) => {
      touched += 1
      return `${p1}${newName}`
    }
  )

  if (touched === 0) {
    return {
      root,
      newName,
      changes: [],
      notes: [`认出了名字 ${cur.name}（来自 ${cur.kind}），但替换时没找到可改的地方`],
      blocked: true
    }
  }

  changes.push({
    path: 'CMakeLists.txt',
    action: before === after ? 'skip' : 'patch',
    before,
    after,
    note: `把 ${cur.kind} 里的 ${cur.name} 改成 ${newName}（${touched} 处）`
  })

  // ---- .vscode 里已经写进去的 ELF 名 ----
  //
  // 这一步是补一个真实的坑：改名之前工具可能已经生成过 .vscode 配置，
  // 里面写着 `build/Debug/<旧名>.elf`（当时是对的）。改名后那个文件就不存在了，
  // 于是 F5 报「找不到 elf」、烧录任务也会失败 —— 用户会以为是 CMake 的问题。
  //
  // 只改**本工具写的**那些文件；别人的配置不碰，但要在说明里点出来让他自己处理。
  const ownership = inspectVscodeOwnership(root)
  let patchedVscode = 0
  for (const rel of ownership.ours) {
    const abs = join(root, rel.split('/').join(sep))
    if (!existsSync(abs)) continue
    const vBefore = readFileSync(abs, 'utf8')
    let vAfter = vBefore
    for (const ext of ['elf', 'hex', 'bin', 'map']) {
      vAfter = vAfter.split(`${cur.name}.${ext}`).join(`${newName}.${ext}`)
    }
    if (vAfter === vBefore) continue
    patchedVscode += 1
    changes.push({
      path: rel,
      action: 'patch',
      before: vBefore,
      after: vAfter,
      note: `把里面引用的 ${cur.name}.elf/.hex/.bin 改成 ${newName}.*`
    })
  }

  // 别人的 .vscode 配置里如果还留着旧名，工具不能改，但必须告诉他
  const foreignStale = ownership.all
    .filter((v) => !v.ours)
    .filter((v) => {
      const abs = join(root, v.path.split('/').join(sep))
      if (!existsSync(abs)) return false
      try {
        return readFileSync(abs, 'utf8').includes(`${cur.name}.elf`)
      } catch {
        return false
      }
    })
    .map((v) => v.path)
  for (const p of foreignStale) {
    notes.push(
      `注意：${p} 不是本工具写的，里面还引用了 ${cur.name}.elf —— 工具不会改别人的文件，请手动更新`
    )
  }

  // ---- .ioc：文件名 + 内部 ProjectName ----
  const iocs = readdirSync(root).filter((f) => /\.ioc$/i.test(f))
  if (withIoc && iocs.length === 1) {
    const oldIoc = iocs[0]
    const baseOld = oldIoc.replace(/\.ioc$/i, '')
    const newIoc = `${newName}.ioc`
    if (sameName(baseOld, newName) || baseOld === newName) {
      notes.push(`.ioc 已经叫 ${oldIoc}，不用改`)
    } else if (existsSync(join(root, newIoc))) {
      notes.push(`已经存在 ${newIoc}，为安全起见不覆盖，.ioc 保持原样`)
    } else {
      const iocBefore = readFileSync(join(root, oldIoc), 'utf8')
      const iocAfter = iocBefore.replace(/(ProjectManager\.ProjectName\s*=\s*).*/g, `$1${newName}`)
      // 改名 = 旧路径写回原内容（还原时用）+ 新路径新建 + 旧路径删除
      changes.push({
        path: newIoc,
        action: 'create',
        before: null,
        after: iocAfter,
        note: `新建 ${newIoc}（内容来自 ${oldIoc}，ProjectName 改成 ${newName}）`
      })
      changes.push({
        path: oldIoc,
        action: 'delete',
        before: iocBefore,
        after: null,
        note: `删掉旧名文件 ${oldIoc}`
      })
    }
  } else if (iocs.length > 1) {
    notes.push(`根目录有 ${iocs.length} 个 .ioc，分不清该改哪个，.ioc 保持原样`)
  }

  notes.push(
    '改完 CMakeLists.txt 后，cmake/user.cmake 和 cmake/stm32cubemx/CMakeLists.txt 里的 ' +
      '${CMAKE_PROJECT_NAME} 会自动跟着变，不用手动改'
  )
  notes.push(
    `构建产物会从 ${cur.name}.elf/.hex/.bin 变成 ${newName}.elf/.hex/.bin —— 建议清理 build 目录后重新构建`
  )
  if (patchedVscode > 0) {
    notes.push(
      `已经生成的 .vscode 配置里有 ${patchedVscode} 个引用了旧 ELF 名，会一起改掉` +
        `（不改的话 F5 和烧录任务会因为找不到 <旧名>.elf 而失败）`
    )
  }
  notes.push('MDK-ARM/ 里的 Keil 工程不改（那是另一个构建系统的残留，改名没意义）')

  return {
    root,
    newName,
    changes,
    notes,
    blocked: changes.every((c) => c.action === 'skip')
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 落盘。先存快照，失败就中止（改名字是不可逆操作，必须能还原） */
export function applyProjectRename(plan: RenamePlan): {
  ok: boolean
  written: string[]
  errors: string[]
  snapshotId: string | null
} {
  const res = {
    ok: false,
    written: [] as string[],
    errors: [] as string[],
    snapshotId: null as string | null
  }
  const todo = plan.changes.filter((c) => c.action !== 'skip')
  if (!todo.length) {
    res.ok = true
    return res
  }

  try {
    res.snapshotId = captureSnapshot(
      plan.root,
      todo.map((c) => ({ relativePath: c.path, previous: c.before }))
    )
  } catch (err) {
    res.errors.push(`存快照失败，已中止：${(err as Error).message}`)
    return res
  }
  if (!res.snapshotId) {
    res.errors.push('没能存下快照，为避免改坏了无法还原，已中止（一个文件都没动）')
    return res
  }

  for (const c of todo) {
    const abs = join(plan.root, c.path.split(posix.sep).join('\\'))
    try {
      if (c.action === 'delete') {
        rmSync(abs, { force: true })
        res.written.push(`（删除）${c.path}`)
      } else if (c.after !== null) {
        writeFileSync(abs, c.after, 'utf8')
        res.written.push(c.path)
      }
    } catch (err) {
      res.errors.push(`${c.path}：${(err as Error).message}`)
    }
  }

  try {
    recordWrite(
      plan.root,
      [`把工程名改成 ${plan.newName}（${res.written.length} 个文件）`],
      res.errors,
      res.snapshotId
    )
  } catch {
    /* 历史记不上不影响主流程 */
  }

  res.ok = res.errors.length === 0
  return res
}
