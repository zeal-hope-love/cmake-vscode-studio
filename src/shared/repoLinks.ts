/**
 * 仓库地址集中放这里。
 *
 * 以前「检查更新」「更新提示」「关于页」各写一份字符串，改仓库名要满仓库搜。
 * 主进程（查 latest release）和渲染进程（打开浏览器）都从这里取。
 *
 * 注意：这里的 owner/name 必须和 package.json 的 repository 字段一致。
 */
export const REPO_OWNER = 'zeal-hope-love'
export const REPO_NAME = 'cmake-vscode-studio'

/** 项目主页 */
export const REPO_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}`

/** 发布页 —— 所有历史版本都在这里，应用内更新失败时的退路 */
export const RELEASES_URL = `${REPO_URL}/releases`

/** 问题反馈 */
export const ISSUES_URL = `${REPO_URL}/issues`
