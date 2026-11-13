# 模型选择与映射

> [English](models.md) | **简体中文**

> 本文与英文版同步；如有不一致，以英文版为准。

ARS 最初是为 Claude Code 写的，命令文件里会出现 `sonnet`、`opus` 这样的 Claude 模型名。**你不需要使用 Claude，也不需要知道这些产品名。** 在这个适配器里，它们只是“能力档位”的提示：把每个提示映射到你 OpenCode provider 实际提供的模型即可。

命令用哪个模型完全由你提供的映射决定，适配器不会自己挑；缺少映射时，相关命令会在派发前被阻断。筛选是唯一的例外：源端对所有角色都写 `sonnet`，适配器会把这一个默认值按角色解析成档位（见下文）；其他源端模型保持原样。

## 三个档位分别是什么意思

| 源端提示 | 按什么理解 | 典型用途 | 当前 ARS 命令 |
|---|---|---|---|
| `sonnet` | **中端 / 均衡** | 主要的研究、规划、写作和审稿命令；默认的质量/成本平衡 | 16 个 `/ars-*` 命令中有 12 个声明了它 |
| `opus` | **高端 / 最强** | 困难综合、复杂审稿、高风险规划；通常更慢、更贵 | 当前源命令没有声明；仅在你自己新增声明 `opus` 的命令或代理时需要，另外也是默认的 `ADJ`/`FTADJ` 筛选档位 |
| `haiku` | **低端 / 快速、低成本** | 分类、抽取、批量检查、低风险机械工作 | 当前源命令没有声明；仅在你自己新增声明 `haiku` 的命令或代理时需要，另外也是默认的 `QC` 筛选档位 |

代理覆盖（`models.agents.<id>`）和显式配置的筛选角色（`screening.roles.<role>`）填写的是**直连模型引用**；没有显式配置的角色会按下面的档位从 `models.aliases` 解析。

剩下 4 个命令没有声明模型，会继承当前会话模型。配置里的键仍然叫 `sonnet`，因为源端就是这么写的；它**不表示**“必须使用 Claude Sonnet”。把它映射到你 provider 的中端模型即可。

以上是建议，不是强制。如果你把高端模型映射到 `sonnet`，那 12 个声明了 `sonnet` 的命令会用高端模型（其中 3 个 CLI 包装命令不经过模型路由）；映射便宜模型就用便宜模型。按你自己的质量、延迟和成本要求选择。

## 安装输入：`ars-models.json`

`ars-models.json` 只是安装输入，不是运行时配置文件。安装完成后适配器不会再读它；安装器会把内容写进 `opencode.json`（或 `opencode.jsonc`）的插件 options。这个文件是项目级的 `opencode.json` / `.opencode/opencode.json(c)`，或全局的 `~/.config/opencode/opencode.json(c)`。直接编辑它时不需要 `ars-models.json`，也不要同时维护两份。

安装器的 `--models` 值会写进插件 options，所以重载后同一套映射仍然有效：

```powershell
node "C:/work/academic-research-skills/opencode/install.ts" install --channel plugin --scope project --project "C:/research/my-project" --models "C:/research/ars-models.json" --apply
```

最小配置只映射均衡档：

```json
{
  "aliases": {
    "sonnet": { "providerID": "your-provider", "model": "your-balanced-model" }
  }
}
```

需要其他档位时再加；这样筛选角色会按下面的档位分布解析，缺档位时会回退到 `sonnet` 并给出警告：

```json
{
  "aliases": {
    "sonnet": { "providerID": "your-provider", "model": "your-balanced-model" },
    "opus": { "providerID": "your-provider", "model": "your-strongest-model" },
    "haiku": { "providerID": "your-provider", "model": "your-fast-model" }
  }
}
```

### 筛选角色

源端生成器对所有角色都写 `model: sonnet`（`srlib.py:374-375`）。规划阶段会把这一个源端默认值解析成下面的档位分布，所以只配 `models.aliases.sonnet` 的默认安装也能跑筛选：

| 角色 | 档位 | 原因 |
|---|---|---|
| `A`、`B` | `sonnet` | 标题与摘要阶段的主审 |
| `FTA`、`FTB` | `sonnet` | 全文阶段的主审 |
| `ADJ`、`FTADJ` | `opus` | 需要裁决冲突，强推理更有价值 |
| `QC` | `haiku` | 机械性质检 |

解析只发生一次，在规划阶段，顺序是：

1. 配了 `screening.roles.<role>` 时它优先：这是直连模型引用。
2. 否则使用该角色的档位别名（`ADJ` 用 `models.aliases.opus`，以此类推）。
3. 该档位别名不存在时使用 `models.aliases.sonnet`，并在审批文本里警告缺失的档位。
4. 两者都不存在时阻断派发，并指出是哪个角色。

只有源端默认的 `sonnet` 会被这样改写。生成配置里写了其他模型时（例如 `quality` profile 写 `opus`）保持原样：该角色通过 `models.aliases.opus` 解析，绝不会再被改写成档位分布。别名存在但宿主不提供该模型时会阻断派发，不会二次回退。生成的条目根本没有写模型时，reviewer 继承会话模型，此时给该角色配 `screening.roles` 会被忽略。

`sr-screener` 技能里的 Model Tiering 表和 `model_labels` 描述的是**源端**配置。这个适配器有意与之不同：`ADJ`/`FTADJ` 用 `opus`，`QC` 用 `haiku`。因此请以 `ars_screening` 返回的审批文本作为实际模型记录，它才是每个角色真正会用的模型。

七个角色名是 `A`、`B`、`ADJ`、`QC`、`FTA`、`FTB`、`FTADJ`。不配置 `screening.roles` 不会阻止安装。

### 如何配置 `screening.roles`

在传给 `--models` 的同一个 JSON 文件里，加一个顶层 `screening.roles`。它和 `aliases` 平级，不要放进 `aliases` 里面：

```json
{
  "aliases": {
    "sonnet": { "providerID": "your-provider", "model": "your-balanced-model" }
  },
  "screening": {
    "roles": {
      "A":     { "providerID": "your-provider", "model": "your-balanced-model" },
      "B":     { "providerID": "your-provider", "model": "your-balanced-model" },
      "ADJ":   { "providerID": "your-provider", "model": "your-strongest-model" },
      "QC":    { "providerID": "your-provider", "model": "your-fast-model" },
      "FTA":   { "providerID": "your-provider", "model": "your-balanced-model" },
      "FTB":   { "providerID": "your-provider", "model": "your-balanced-model" },
      "FTADJ": { "providerID": "your-provider", "model": "your-strongest-model" }
    }
  }
}
```

- 每个角色值是 `{ "providerID": "...", "model": "..." }`，和 `aliases` 的引用形状相同；这里填真实模型引用，不填 `sonnet`、`haiku` 这样的别名键。
- 只配你想覆盖的角色即可，没配的角色按上文的档位分布解析。只做标题/摘要筛选时可以只配 `A`、`B`、`ADJ`、`QC`，只做全文筛选时可以只配 `FTA`、`FTB`、`FTADJ`。
- 所有角色可以使用同一个模型。
- 安装器会校验每个引用的形状并写入插件 options 的 `screening.roles`；模型是否真实存在由宿主加载时验证，安装检查不能离线证明可用性。

配置后重新运行 `install` 或 `update` 并传入这个文件，例如：

```powershell
node "C:/work/academic-research-skills/opencode/install.ts" install `
  --channel plugin --scope project `
  --project "C:/research/my-project" `
  --models "C:/research/ars-models.json" --apply
```

后续 update/check 省略 `--models` 会保留已持久化映射，不会重置。凭据请通过 OpenCode 存储，不要写进这个文件。

## 哪些配置会消费映射

- **Plugin 渠道：** 命令别名（`models.aliases.<alias>`）、原生代理覆盖（`models.agents.<id>`）和筛选角色。筛选角色优先用 `screening.roles.<role>`，没配时用 `models.aliases.<档位>`。适配器自己不会发明模型。
- **Skills 渠道：** 没有插件 options。reviewer 保留源端 `inherit` 模型；`--models` 会被拒绝，而不是静默丢弃。
- 映射只是 provider/model 引用，绝不携带凭据。

## 路由规则

- 每个声明了能力提示的命令都必须有 `models.aliases.<提示>`；缺失或不可用的映射会在任何 prompt 被接纳前**阻止该次调用**，没有继承回退。
- 命令别名通过宿主 `experimental.model.resolve` hook 按请求路由，OpenCode 文档说明它只支持同 provider。别名用 route tag 绑定到已接纳的命令 prompt，跟随该轮的主请求，包括工具续轮。无关 prompt 不能消费它；无法关联路由时，请求会显式阻断，而不是继承。
- 路由在正常 idle 以及文档化的失败/中断执行事件上释放，所以同会话的下一个别名命令可以运行。
- 如果映射模型与当前会话不在同一 provider，命令会带可操作消息阻断，而不是静默使用会话模型。
- 原生代理保持源端继承，除非设置了 `models.agents.<id>`；安装检查会验证生效的 agent 模型。
- 状态工具记录最近实际应用的路由。

## 映射最终写到哪里

完整插件条目和手动配置示例见 [installation.md](installation.md#plugin-options-and-models)。不要同时维护两份相同的映射。
