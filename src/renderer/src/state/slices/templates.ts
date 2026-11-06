/**
 * 模板：套用 / 另存 / 复制 / 删除。套用是这套东西里最绕的一段。
 *
 * 从 `state/store.ts` 里切出来的一段；state 的初始值仍留在门面里 ——
 * 这样「有哪些字段」始终只在 store.ts 一处能看全。
 */

import type { ConfigTemplate } from '@shared/types'
import { adaptTemplateOptions } from '@shared/templateAdapt'
import { findUnresolvedVariables, renderTemplateFiles, templateVarsFromOptions } from '@shared/templateRender'
import type { StudioGet, StudioSet, StudioState } from '../storeTypes'

export function templatesSlice(
  set: StudioSet,
  get: StudioGet
): Pick<StudioState, 'refreshTemplates' | 'applyTemplateToCurrent' | 'switchTemplate' | 'saveCurrentAsTemplate' | 'saveTemplate' | 'deleteTemplate' | 'duplicateTemplate' | 'openTemplateInEditor' | 'consumePendingTemplate'> {
  return {
    refreshTemplates: async () => {
      try {
        set({ templates: await window.api.listTemplates() })
      } catch {
        /* 忽略 */
      }
    },

    // ------------------------------------------------------------------------
    // 模块包（扩展组导航由它生成）
    // ------------------------------------------------------------------------,

    /**
     * 把模板套用到当前工程。
     *
     * 模板分三层，套用时的处理各不相同：
     *   · target.probe      → 并进生成参数
     *   · options           → 只沿用「用户的选择」，工程相关的按目标工程重算
     *   · files             → 用占位符渲染成可直接写的内容，覆盖掉自动生成的那几份
     */
    applyTemplateToCurrent: async (template) => {
      const { projectRoot, options } = get()
      if (!projectRoot || !options) {
        get().notify('warn', '请先载入一个工程')
        return
      }

      const adapted = adaptTemplateOptions(
        { ...template.options, probeKey: template.target.probe },
        options
      )
      await get().loadProject(projectRoot, adapted)

      // 渲染必须在 loadProject 之后：占位符要填的是**目标工程**的值
      const next = get().options
      const files =
        template.files && next
          ? renderTemplateFiles(template.files, templateVarsFromOptions(next, projectRoot))
          : null

      set({ activeTemplate: { id: template.id, name: template.name }, activeTemplateFiles: files })

      const missing = files
        ? [
            ...new Set(
              Object.values(template.files ?? {}).flatMap((text) =>
                findUnresolvedVariables(text, templateVarsFromOptions(next!, projectRoot))
              )
            )
          ]
        : []
      if (missing.length) {
        get().notify('warn', `模板里有没解析的占位符：${missing.map((m) => '${' + m + '}').join('、')}`)
      } else {
        get().notify('ok', `已套用模板「${template.name}」`)
      }

      void window.api
        .addHistory({
          kind: 'template-apply',
          title: `套用模板「${template.name}」`,
          detail: files ? '四份文件按模板内容替换（占位符已按本工程填充）' : '生成参数已按本工程重新推导',
          ok: true,
          projectRoot,
          templateId: template.id,
          actions: [
            { kind: 'preview', label: '预览差异', projectRoot },
            { kind: 'reconfigure', label: '重新配置这个工程', projectRoot },
            { kind: 'open-template', label: '打开这个模板', templateId: template.id }
          ]
        })
        .then(() => get().refreshHistory())
        .catch(() => undefined)
    },

    /**
     * 按 id 切换模板。
     *
     * 空串 = 「默认：按本工程的检测结果生成」，也就是不带任何模板覆盖重新检测一遍。
     * 切换后如果预览弹窗正开着，顺手把差异重算一遍 —— 否则显示的还是换之前的。
     */
    switchTemplate: async (templateId) => {
      const { projectRoot, project, templates, previewOpen } = get()
      if (!projectRoot) return

      if (!templateId) {
        if (project) await get().loadProject(project.root)
        set({ activeTemplate: null, activeTemplateFiles: null })
      } else {
        const template = templates.find((t) => t.id === templateId)
        if (!template) return
        await get().applyTemplateToCurrent(template)
      }

      if (previewOpen) await get().openPreview()
    },

    saveCurrentAsTemplate: async (name, note) => {
      const { bundle, options, project } = get()
      if (!bundle || !options) {
        get().notify('warn', '请先载入工程')
        return
      }
      const now = Date.now()
      const templates = await window.api.saveTemplate({
        id: '',
        name,
        note,
        createdAt: now,
        updatedAt: now,
        target: {
          editor: 'vscode',
          buildSystem: project?.presets.length ? 'preset' : 'dir',
          probe: options.probeKey
        },
        options,
        bundle
      })
      set({ templates })
      get().notify('ok', `模板「${name}」已保存`)
    },

    saveTemplate: async (template) => {
      const templates = await window.api.saveTemplate(template)
      set({ templates })
      void get().refreshHistory()
      return templates
    },

    deleteTemplate: async (id) => {
      const templates = await window.api.deleteTemplate(id)
      set({ templates })
      void get().refreshHistory()
    },

    duplicateTemplate: async (template) => {
      const now = Date.now()
      const copy: ConfigTemplate = {
        ...template,
        id: '',
        name: `${template.name} 副本`,
        createdAt: now,
        updatedAt: now,
        builtin: false
      }
      const templates = await window.api.saveTemplate(copy)
      set({ templates })
      void get().refreshHistory()
      const created =
        templates.find((t) => t.name === copy.name) ??
        [...templates].filter((t) => !t.builtin).sort((a, b) => b.updatedAt - a.updatedAt)[0] ??
        null
      get().notify('ok', `已复制为「${copy.name}」`)
      return created
    },

    // ------------------------------------------------------------------------
    // 历史记录
    // ------------------------------------------------------------------------,

    openTemplateInEditor: (templateId) => set({ pendingTemplateId: templateId }),

    consumePendingTemplate: () => set({ pendingTemplateId: null })
  }
}
