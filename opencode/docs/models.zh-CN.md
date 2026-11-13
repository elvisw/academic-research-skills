# 模型选择与映射

> [English](models.md) | **简体中文**

> 本文与英文版同步；如有不一致，以英文版为准。

ARS 最初是为 Claude Code 写的，命令文件里会出现 `sonnet`、`opus` 这样的 Claude 模型名。**你不需要使用 Claude，也不需要知道这些产品名。** 在这个适配器里，它们只是“能力档位”的提示：把每个提示映射到你 OpenCode provider 实际提供的模型即可。

适配器不会自己选择档位。它只使用你提供的映射；缺少映射时，相关命令会在派发前被阻断。

## 三个档位分别是什么意思

| 源端提示 | 按什么理解 | 典型用途 | 当前 ARS 命令 |
|---|---|---|---|
| `sonnet` | **中端 / 均衡** | 主要的研究、规划、写作和审稿命令；默认的质量/成本平衡 | 16 个 `/ars-*` 命令中有 12 个声明了它 |
| `opus` | **高端 / 最强** | 困难综合、复杂审稿、高风险规划；通常更慢、更贵 | 当前源命令没有声明；仅在你自己新增声明 `opus` 的命令或代理时需要 |
| `haiku` | **低端 / 快速、低成本** | 分类、抽取、批量检查、低风险机械工作 | 当前源命令没有声明；仅在你自己新增声明 `haiku` 的命令或代理时需要 |

代理覆盖（`models.agents.<id>`）和筛选角色（`screening.roles.<role>`）填写的是**直连模型引用**，不是 `models.aliases` 的档位键。

剩下 4 个命令没有声明模型，会继承当前会话模型。配置里的键仍然叫 `sonnet`，因为源端就是这么写的；它**不表示**“必须使用 Claude Sonnet”。把它映射到你 provider 的中端模型即可。

以上是建议，不是强制。如果你把高端模型映射到 `sonnet`，那 12 个声明了 `sonnet` 的命令会用高端模型（其中 3 个 CLI 包装命令不经过模型路由）；映射便宜模型就用便宜模型。按你自己的质量、延迟和成本要求选择。

## 映射文件

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

需要其他档位时再加：

```json
{
  "aliases": {
    "sonnet": { "providerID": "your-provider", "model": "your-balanced-model" },
    "opus": { "providerID": "your-provider", "model": "your-strongest-model" },
    "haiku": { "providerID": "your-provider", "model": "your-fast-model" }
  }
}
```

筛选角色可以使用不同档位。一个合理的起点是：

| 角色 | 建议档位 | 原因 |
|---|---|---|
| `A`、`B` | 中端 / 均衡 | 标题与摘要阶段的主审 |
| `FTA`、`FTB` | 中端 / 均衡 | 全文阶段的主审 |
| `ADJ`、`FTADJ` | 高端 / 最强 | 需要裁决冲突，强推理更有价值 |
| `QC` | 低端 / 低成本 | 机械性质检 |

这些只是建议，不是自动分配。如果你希望简单，也可以所有角色用同一个模型。七个角色名是 `A`、`B`、`ADJ`、`QC`、`FTA`、`FTB`、`FTADJ`；安装器会校验每个引用并写入 `options.screening.roles`。这里的每个角色填写的是**直连模型引用**，不是 `models.aliases` 的档位键。

**完全不配置这些角色会怎样？** 取决于生成的筛选配置有没有为角色指定模型：

- **没有指定模型：** 不需要该角色的映射。reviewer 使用自己的生效模型；默认继承当前会话模型，如果你给 `screening-reviewer-agent` 配了模型覆盖，则使用那个覆盖。
- **指定了模型：** 该角色必须有映射。缺失时会在任何评审调用派发前阻断，并报告 `blocked models` 及缺少映射的角色，**不会静默回退到会话模型**。

所以不配置 `screening.roles` 不会阻止安装；它只会在筛选配置要求某个角色模型时阻止该次筛选派发。

后续 update/check 省略 `--models` 会保留已持久化映射，不会重置。凭据请通过 OpenCode 存储，不要写进这个文件。

## 哪些配置会消费映射

- **Plugin 渠道：** 命令别名（`models.aliases.<alias>`）、原生代理覆盖（`models.agents.<id>`）和筛选角色映射（`screening.roles.<role>`）。适配器自己不会发明模型。
- **Skills 渠道：** 没有插件 options。reviewer 保留源端 `inherit` 模型；`--models` 会被拒绝，而不是静默丢弃。
- 映射只是 provider/model 引用，绝不携带凭据。

## 路由规则

- 每个声明了能力提示的命令都必须有 `models.aliases.<提示>`；缺失或不可用的映射会在任何 prompt 被接纳前**阻止该次调用**，没有继承回退。
- 命令别名通过宿主 `experimental.model.resolve` hook 按请求路由，OpenCode 文档说明它只支持同 provider。别名用 route tag 绑定到已接纳的命令 prompt，跟随该轮的主请求，包括工具续轮。无关 prompt 不能消费它；无法关联路由时，请求会显式阻断，而不是继承。
- 路由在正常 idle 以及文档化的失败/中断执行事件上释放，所以同会话的下一个别名命令可以运行。
- 如果映射模型与当前会话不在同一 provider，命令会带可操作消息阻断，而不是静默使用会话模型。
- 原生代理保持源端继承，除非设置了 `models.agents.<id>`；安装检查会验证生效的 agent 模型。
- 状态工具记录最近实际应用的路由。

## 完整插件配置示例

下面的例子给 12 个声明了 `sonnet` 的命令配均衡模型，给一个可选的、声明 `opus` 的自定义命令配高端模型，并通过 `models.agents` 给 `synthesis-agent` 配高端模型，同时给筛选角色分配不同档位。这是模板，不是必须照抄的分配：

```jsonc
{
  "plugins": [
    {
      "package": "./academic-research-skills/opencode",
      "options": {
        "repoRoot": "C:/work/academic-research-skills",
        "models": {
          "aliases": {
            // 中端 / 均衡：12 个声明了 `sonnet` 的命令。
            "sonnet": { "providerID": "your-provider", "model": "your-balanced-model" },
            // 高端 / 最强：只有你新增声明 `opus` 的命令或代理才需要。
            "opus": { "providerID": "your-provider", "model": "your-strongest-model" }
          },
          "agents": {
            // 可选覆盖；不写就继承会话模型。
            "synthesis-agent": { "providerID": "your-provider", "model": "your-strongest-model" }
          }
        },
        "screening": {
          "roles": {
            "A": { "providerID": "your-provider", "model": "your-balanced-model" },
            "B": { "providerID": "your-provider", "model": "your-balanced-model" },
            "ADJ": { "providerID": "your-provider", "model": "your-strongest-model" },
            "QC": { "providerID": "your-provider", "model": "your-fast-model" },
            "FTA": { "providerID": "your-provider", "model": "your-balanced-model" },
            "FTB": { "providerID": "your-provider", "model": "your-balanced-model" },
            "FTADJ": { "providerID": "your-provider", "model": "your-strongest-model" }
          }
        }
      }
    }
  ]
}
```

当生成的 `screening_config.json` 为七个筛选角色命名模型时，七个角色都必须映射。派发器会切换每个子会话的模型，读回生效模型，不一致就拒绝 prompt。缺失映射会阻止派发。
