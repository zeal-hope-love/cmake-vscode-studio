/**
 * 通用「把任意 TS 文件打包后跑」的小工具。
 *
 *   node tools/run-ts.mjs tools/selftest.ts
 *   node tools/run-ts.mjs tools/scan.ts "C:\path\to\project"
 *
 * 主进程的业务逻辑不依赖 Electron，所以这样能在不启动界面的前提下调试/验证。
 */

import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const entryArg = process.argv[2]
if (!entryArg) {
  console.error('用法: node tools/run-ts.mjs <entry.ts> [args...]')
  process.exit(1)
}

const entry = path.resolve(process.cwd(), entryArg)
const outfile = path.join(root, '.ts-run-bundle.cjs')

/**
 * 把 @shared/* @main/* 指到源码目录（与 electron.vite.config.ts 保持一致）。
 *
 * 注意：别名指向的可能是**目录**（`@shared/types` → `src/shared/types/index.ts`）。
 * esbuild 不会像 tsc 那样自动找 index，所以要在这里手动判断 —— 否则
 * 「只是把 types.ts 拆成了 types/ 目录」就会让自检直接打不开。
 */
function resolveAlias(base) {
  const asFile = `${base}.ts`
  if (existsSync(asFile)) return asFile
  const asIndex = path.join(base, 'index.ts')
  if (existsSync(asIndex)) return asIndex
  return asFile // 交给 esbuild 报「找不到」，错误信息里带着期望路径
}

const aliasPlugin = {
  name: 'src-alias',
  setup(buildApi) {
    buildApi.onResolve({ filter: /^@shared\// }, (args) => ({
      path: resolveAlias(path.join(root, 'src', 'shared', args.path.slice('@shared/'.length)))
    }))
    buildApi.onResolve({ filter: /^@main\// }, (args) => ({
      path: resolveAlias(path.join(root, 'src', 'main', args.path.slice('@main/'.length)))
    }))
  }
}

try {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile,
    external: ['electron'],
    plugins: [aliasPlugin],
    logLevel: 'warning'
  })

  const result = spawnSync(process.execPath, [outfile, ...process.argv.slice(3)], {
    stdio: 'inherit',
    cwd: root
  })
  process.exitCode = result.status ?? 1
} finally {
  rmSync(outfile, { force: true })
}
