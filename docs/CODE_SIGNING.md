# 代码签名（SignPath Foundation，免费开源方案）

> 目标：让 Windows 上「发行者：发布者未知 / Windows 已保护你的电脑」消失。
>
> **未签名时**，SmartScreen 按「文件哈希」积累信誉：每个新版本都是新哈希、零信誉，
> 所以每发一版都会再弹一次。只有**受信任 CA 签发的证书**才能根治 ——
> Authenticode 的「发布者」字段取自证书 Subject，**不能填 GitHub 用户名**，
> 自签名证书也没用（用户机器不信任你的根证书）。

## 为什么选 SignPath Foundation

[SignPath Foundation](https://signpath.org/) 给开源项目**免费**提供代码签名：

| | 细节 |
|---|---|
| 费用 | 免费（OSS 专用） |
| 私钥 | 生成并保存在 SignPath 的 HSM 里，**不经过你的机器、不需要 USB 令牌** |
| 证书归属 | 签给项目（经 SignPath 背书），不是签给你个人 |
| 效果 | **Extended Validation（EV）** 证书 → SmartScreen **即时信任**，不等信誉积累 |
| 约束 | ① 必须装 SignPath GitHub App；② **OSS 项目所有构建必须在 GitHub 托管的 runner 上跑**（不能本地打包后上传） |

最后那条很关键：**签名版的构建必须搬到 GitHub Actions**。这也是 `.github/workflows/release.yml` 存在的原因。

---

## 需要你本人做的三步（我无法代做）

涉及邮箱验证、OAuth 授权和人工审核，命令行做不了。

### 第 1 步：申请

1. 打开 <https://signpath.org/apply>，用邮箱注册
2. 提交项目信息，大致填：
   - **Repository**：`https://github.com/zeal-hope-love/cmake-vscode-studio`
   - **License**：MIT
   - **What it does**：A GUI tool that configures VSCode debug/build settings for CMake-based embedded projects (STM32 / Cortex-M), including an optional module pack for VOFA+ live tuning.
   - **Why signing**：Windows SmartScreen blocks the unsigned NSIS installer with "Unknown publisher", which deters users of an otherwise fully open-source tool.
3. 等审核（人工，通常几天到两三周）

### 第 2 步：装 GitHub App

审核通过后，在 <https://github.com/apps/signpath> 安装到 `zeal-hope-love/cmake-vscode-studio`（只给这一个仓库即可）。

### 第 3 步：在 SignPath 后台建三样东西，把 slug 填到 GitHub

登录 SignPath 后创建：

| 建什么 | 取值建议 | 之后填到 |
|---|---|---|
| Organization | — | GitHub 仓库变量 `SIGNPATH_ORGANIZATION_ID` |
| Project | slug 建议 `cmake-vscode-studio` | `SIGNPATH_PROJECT_SLUG` |
| Signing Policy | 建议 `release-signing` | `SIGNPATH_SIGNING_POLICY_SLUG` |
| Artifact Configuration | 建议 `windows-installers` | `SIGNPATH_ARTIFACT_CONFIGURATION_SLUG`（可选） |

**Artifact Configuration 的内容**（因为 `upload-artifact` 默认打成 ZIP，根元素必须是 `<zip-file>`）：

```xml
<artifact-configuration xmlns="http://signpath.io/artifact-configuration">
  <zip-file>
    <pe-file-set>
      <include path="*.exe" />
    </pe-file-set>
  </zip-file>
</artifact-configuration>
```

> 用 `pe-file-set` 而不是逐个写死文件名，以后加了别的 exe 也不用改配置。

**API Token**：在 SignPath 里创建一个有 submitter 权限的 token，加到 GitHub 仓库的
**Secret** `SIGNPATH_API_TOKEN`（Settings → Secrets and variables → Actions → Secrets）。

其余四项加到 **Variables**（同一页面 → Variables 标签）：

```
SIGNPATH_ORGANIZATION_ID
SIGNPATH_PROJECT_SLUG
SIGNPATH_SIGNING_POLICY_SLUG
SIGNPATH_ARTIFACT_CONFIGURATION_SLUG
```

---

## 已经准备好的工作流

`.github/workflows/release.yml`，行为：

1. **没有配置 SignPath 变量时** —— 照常构建、跑自检、产出**未签名**安装包并上传为 workflow artifact。不会失败。
2. **配置了之后** —— 多一步：把未签名的包交给 SignPath 签，签完的包替换未签名的上传。

触发方式：

- 推 `v*` 标签 → 构建 + 签名 + 附加到同名 GitHub Release
- 手动 `workflow_dispatch` → 只构建 + 签名，产物在 Actions 页面下载

## 验证签名

下载签名后的安装包，在 PowerShell 里：

```powershell
Get-AuthenticodeSignature .\CMake-VSCode-Configurator-*-x64.exe |
  Select-Object Status, @{n='签名者';e={$_.SignerCertificate.Subject}}
```

`Status` 应该是 `Valid`，`签名者` 里能看到 SignPath 的证书。

## 常见问题

**Q：能不能不搬到 Actions，本地打包完再签？**
不行。SignPath 的免费 OSS 方案要求「所有构建在 GitHub 托管 runner 上完成」，这是它验证
「这个二进制确实来自这个仓库」的方式。本地打包会被拒绝。

**Q：签名后还要 SmartScreen 攒信誉吗？**
不用。EV 证书是即时信任。OV 证书才需要攒（这就是选 Foundation 的原因之一）。

**Q：多久生效？**
签名完成、用户重新下载后立即生效。**已下载的旧文件不会变** —— 签名是签在文件里的。

**Q：还能不能继续本地打包自己用？**
可以，本地包不签名、只给自己用没问题；只是发给别人时会被 SmartScreen 提示。
