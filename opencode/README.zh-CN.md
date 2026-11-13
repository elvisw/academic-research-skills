# ARS OpenCode V2 适配器（中文使用指南）

> [English](README.md) | **简体中文**

这个适配器让 **Academic Research Skills（ARS）** 可以在 **OpenCode V2** 中使用。它不复制、不修改 ARS 的核心文件；技能、命令和研究流程仍然来自原项目。

装好之后，你会在 OpenCode 里得到：

- 5 个 ARS 技能：`academic-paper`、`academic-paper-reviewer`、`academic-pipeline`、`deep-research`、`sr-screener`
- 16 个 `/ars-*` 命令，例如 `/ars-plan`、`/ars-lit-review`、`/ars-full`
- 4 个 ARS 子代理
- 写入范围保护（防止代理越过当前阶段改文件）

> 本文是面向使用者的简明安装指南；完整技术细节在文末的[技术文档](#10-技术文档)中。

---

## 1. 安装前准备

### 必需

- **Windows 11**（目前只在 Windows 上实测过）
- **OpenCode 2.2.7**（适配器按这个版本验证；更高版本未验证）
- **Node.js 24 或更高**
- **完整的 ARS 仓库**，不能只复制 `opencode/` 一个目录
- **Python 3**（写入保护和部分 CLI 命令需要）
- **PyYAML**（`ars-mark-read` / `ars-unmark-read` 需要）

### 先检查版本

在 PowerShell 中运行：

```powershell
node --version
opencode --version
py -3 --version
py -3 -c "import yaml; print(yaml.__version__)"
```

如果 PyYAML 没装：

```powershell
py -3 -m pip install pyyaml
```

> 如果 `opencode --version` 显示 2.3.0 或更高，而安装后无法加载，请先回退到 2.2.7 再试。本文只对 2.2.7 负责。

---

## 2. 安装适配器依赖

假设 ARS 仓库在：

```text
C:\work\academic-research-skills
```

运行：

```powershell
cd "C:\work\academic-research-skills"
npm --prefix opencode ci
```

这一步只安装适配器自己的 Node 依赖，不会改 ARS 源码。

如果 `npm ci` 失败，先确认：Node 是 24+、当前目录是 ARS 仓库根目录、`opencode/package-lock.json` 存在。

---

## 3. 准备你的研究项目

适配器要装到**你实际写论文的项目**里，而不是 ARS 源码目录。假设项目是：

```text
C:\research\my-project
```

如果目录还不存在，先创建：

```powershell
mkdir "C:\research\my-project"
```

> 不要用 `C:\work\academic-research-skills` 作为 `--project`。安装器会拒绝把插件写进 ARS 源码仓库。

---

## 4. 配置模型

ARS 源文件里会出现 `sonnet`、`opus` 这样的 Claude 模型名。你**不需要使用 Claude，也不需要知道这些产品名**；在这个适配器里，它们只是“能力档位”的提示：

| 源端提示 | 按什么理解 | 说明 |
|---|---|---|
| `sonnet` | **中端 / 均衡** | 12 个 `/ars-*` 命令声明它；映射到你 provider 的中端模型 |
| `opus` | **高端 / 最强** | 当前命令没有声明；只有你新增声明 `opus` 的自定义命令或代理时才需要，另外也是默认的 `ADJ`/`FTADJ` 筛选档位 |
| `haiku` | **低端 / 快速、低成本** | 当前命令没有声明；只有你新增声明 `haiku` 的自定义命令或代理时才需要，另外也是默认的 `QC` 筛选档位 |

代理覆盖（`models.agents.<id>`）和显式配置的 `screening.roles.<role>` 填写的是**直连模型引用**。没有显式配置的筛选角色会读取这些别名：源端默认的 `sonnet` 会按角色解析为 `sonnet`（`A`/`B`/`FTA`/`FTB`）、`opus`（`ADJ`/`FTADJ`）和 `haiku`（`QC`）；缺失的档位会回退到 `models.aliases.sonnet` 并给出警告。

这 12 个声明 `sonnet` 的命令里有 3 个是 CLI 包装命令（`ars-cache-invalidate`、`ars-mark-read`、`ars-unmark-read`），它们不经过模型路由。

配置里的键仍然叫 `sonnet`，因为源端就是这么写的；它**不表示**“必须使用 Claude Sonnet”。

先列出本机可用模型：

```powershell
opencode models
```

输出格式是：

```text
provider/model
```

例如：

```text
your-provider/your-balanced-model
```

然后在项目外创建一个模型映射文件，例如：

```text
C:\research\ars-models.json
```

内容：

```json
{
  "aliases": {
    "sonnet": {
      "providerID": "your-provider",
      "model": "your-balanced-model"
    },
    "opus": {
      "providerID": "your-provider",
      "model": "your-strongest-model"
    },
    "haiku": {
      "providerID": "your-provider",
      "model": "your-fast-model"
    }
  }
}
```

把三个 `providerID` / `model` 换成你 `opencode models` 里真实存在、并且和当前会话同一 provider 的模型。

说明：

- 16 个 ARS 命令中有 **12 个**声明了 `sonnet`，所以 `sonnet` 至少要映射；剩下 4 个继承当前会话模型。
- `opus` 和 `haiku` 是筛选档位默认会用的档位（`ADJ`/`FTADJ` 和 `QC`）；不配时这些角色会回退到 `models.aliases.sonnet` 并给出警告。示例先列出来方便你看到三档的写法；如果暂时不用，可以删掉对应条目，保留就必须填真实模型，不能留着 `your-strongest-model` 这样的占位符。
- 如果你自己新增了声明 `opus` 或 `haiku` 的命令或代理，再补对应档位。
- 使用 `sr-screener` 筛选时，源端默认的 `sonnet` 会按角色解析到对应档位（`ADJ`/`FTADJ` 用 `opus`，`QC` 用 `haiku`，其余用 `sonnet`）；缺失的档位回退到 `models.aliases.sonnet` 并给出警告。生成的条目没有为角色指定模型时，reviewer 继承会话模型。档位格式、`screening.roles` 覆盖和路由规则见[中文模型文档](docs/models.zh-CN.md)。
- 模型映射文件只写 provider/model，不要写 API key。

---

## 5. 安装

先选一种安装方式。两种方式用同一个安装器，区别是装什么：

| 方式 | 适合谁 | 装好后有什么 |
|---|---|---|
| **插件方式（推荐）** | 想用完整 ARS 工作流 | 5 个技能、16 个 `/ars-*` 命令、4 个子代理、写入范围保护 |
| **skills 方式** | 只想在 OpenCode 里调用技能 | 5 个技能和筛选 reviewer；**没有** `/ars-*` 命令、插件工具和写入保护 |

下面先讲插件方式。只想装技能的话，直接跳到 5.2。

### 5.1 插件方式（推荐）

安装分三步。

**第 1 步：预览（不会写任何文件）**

```powershell
node "C:\work\academic-research-skills\opencode\install.ts" install --channel plugin --scope project --project "C:\research\my-project"
```

预览会告诉你准备改哪些配置、复制哪些文件、有没有冲突。**先读一遍输出。**

**第 2 步：正式安装**

确认预览无误后运行：

```powershell
node "C:\work\academic-research-skills\opencode\install.ts" install --channel plugin --scope project --project "C:\research\my-project" --models "C:\research\ars-models.json" --apply
```

`--apply` 才会真正写入。没有它，命令始终只是预览。

**第 3 步：检查并重载**

```powershell
node "C:\work\academic-research-skills\opencode\install.ts" check --channel plugin --scope project --project "C:\research\my-project"
```

退出码为 `0` 才表示检查通过。然后重载 OpenCode：

```powershell
opencode reload
```

如果 `reload` 不生效，直接重启 OpenCode。

安装成功后应该能看到：

- `check` 退出码为 `0`；
- 在 OpenCode 里输入 `/`，能看到 `ars-*` 命令；
- `/ars-plan` 能正常开始对话，而不是提示命令不存在。

### 5.2 只安装技能（skills）

如果你只需要技能，不需要 `/ars-*` 命令和写入保护，用这种方式。它不需要模型映射，也不要传 `--models`。

先预览：

```powershell
node "C:\work\academic-research-skills\opencode\install.ts" install --channel skills --scope project --project "C:\research\my-project"
```

确认后正式安装：

```powershell
node "C:\work\academic-research-skills\opencode\install.ts" install --channel skills --scope project --project "C:\research\my-project" --apply
```

检查：

```powershell
node "C:\work\academic-research-skills\opencode\install.ts" check --channel skills --scope project --project "C:\research\my-project"
```

> skills 方式没有 `/ars-*` 命令、插件工具和写入保护。需要完整功能，回到 5.1 用插件方式。

### 5.3 全局安装

如果希望所有项目共用同一份 ARS 检出，把 `--scope project` 换成 `--scope global`：

```powershell
node "C:\work\academic-research-skills\opencode\install.ts" install --channel plugin --scope global --project "C:\research\my-project" --models "C:\research\ars-models.json" --apply
```

全局安装会写 `~/.config/opencode/opencode.json`，所有项目共用同一份 ARS 检出。它不是“每个项目自动切换不同 checkout”的机制。

skills 渠道也支持 `--scope global`；把 `--channel plugin` 换成 `--channel skills` 即可，但同样没有 `/ars-*` 命令和写入保护。

---

## 6. 开始使用

进入你的项目：

```powershell
cd "C:\research\my-project"
opencode
```

在 OpenCode 里直接输入命令，例如：

```text
/ars-plan 帮我规划一篇关于 AI 辅助学术写作的论文
```

常用命令：

| 命令 | 用途 |
|---|---|
| `/ars-plan` | 用苏格拉底式对话规划论文结构 |
| `/ars-outline` | 生成论文大纲 |
| `/ars-lit-review` | 做文献综述 |
| `/ars-full` | 跑完整研究流水线 |
| `/ars-revision` | 修改已有论文 |
| `/ars-reviewer` | 审查论文并给出审稿意见 |

也可以不进入交互界面，直接跑一次：

```powershell
opencode run --model "your-provider/your-balanced-model" "/ars-plan 帮我规划一篇关于 AI 辅助学术写作的论文"
```

把模型换成你自己的 provider/model。

---

## 7. 更新与卸载

更新插件：

```powershell
node "C:\work\academic-research-skills\opencode\install.ts" update --channel plugin --scope project --project "C:\research\my-project" --apply
```

更新技能：

```powershell
node "C:\work\academic-research-skills\opencode\install.ts" update --channel skills --scope project --project "C:\research\my-project" --apply
```

卸载：

```powershell
node "C:\work\academic-research-skills\opencode\install.ts" uninstall --channel plugin --scope project --project "C:\research\my-project" --apply
```

安装器只删除它自己创建、且没有被你改过的文件。你手工改过的内容会保留。

---

## 8. 常见问题

### 命令提示 `no OpenCode mapping`

说明中端档位（配置键 `sonnet`）没有映射。检查：

```text
C:\research\ars-models.json
```

里面要有 `aliases.sonnet`，并且 `providerID` / `model` 是真实存在的。`sonnet` 只是源端的能力提示，不是要求使用 Claude Sonnet。

### 命令提示跨 provider

`experimental.model.resolve` 只能在同一个 provider 内切换模型。把会话模型和 `ars-models.json` 里的模型换成同一个 provider，或者切换当前会话模型。

### `/ars-mark-read` 或 `/ars-unmark-read` 失败

检查：

- 是否装了 PyYAML；
- 是否传了 `--passport-path`，或者设置了 `ARS_PASSPORT_PATH`。

### 装了 skills 方式，但没有 `/ars-*` 命令

这是正常的。skills 方式只复制技能，不安装命令和写入保护。需要完整功能请用 `--channel plugin`。

---

## 9. 目前的限制

- 只在 **Windows 11 + OpenCode 2.2.7 + Node 24** 上验证；macOS/Linux 未验证。
- 完整多代理编排、PDF 导出、Windows durable ledger、Claude/Pi 运行时回归仍未验证；这些是已记录的限制，不是“已经支持”。
- `--channel skills` 没有 `/ars-*` 命令、插件工具和写入保护。

---

## 10. 技术文档

中文版只保留安装和使用步骤。模型文档有中文版，其余为英文技术文档：

- [模型选择与映射（中文）](docs/models.zh-CN.md) — 三档模型、别名、筛选角色、路由规则
- [Model selection and mapping (English)](docs/models.md) — 英文原文
- [安装参考](docs/installation.md) — 依赖、安装渠道、选项、路径、手动安装
- [写入范围与权限](docs/permissions.md) — 权限矩阵、阶段围栏、降级模式
- [命令与 CLI 包装器](docs/commands.md) — 命令渲染与参数校验
- [筛选派发](docs/screening.md) — sr-screener 派发、审批与重试
- [更新、卸载与迁移](docs/lifecycle.md) — 生命周期与所有权规则
- [开发与验证](docs/development.md) — 测试、审计状态与未验证项
