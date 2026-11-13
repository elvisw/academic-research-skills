# ARS OpenCode V2 适配器

> [English](README.md) | **简体中文**

一个薄适配层，让 Academic Research Skills（ARS）插件可以在 OpenCode V2 中使用，**不复制、不修改 ARS 核心**。Claude Code 文件仍是唯一事实来源；这个包只在运行时翻译宿主契约。

已验证基线（只实际跑过这组组合）：

- Windows，OpenCode `v2.2.7`
- `@opencode/plugin` `2.2.7`
- Node.js 24（插件和测试直接运行 TypeScript）

其他操作系统、其他 OpenCode/插件版本未验证。缺少必需的宿主契约成员时，适配器会拒绝注册，而不是猜测。

**真实宿主状态。** 一个隔离的 OpenCode 2.2.7 项目验证了 5 个技能、16 个命令、4 个配置代理、权限决策，以及安装器之前的真实 write/edit/patch/move/delete 执行器。安装门禁也在 Node `24.21.0` 上跑通两个渠道 × 两个作用域，没有跳过：原生技能/资源加载、组装后的 instructions，以及同一个全局配置服务器中两个位置的合法写入和 ARS 拒绝写入。只检查配置存在不算验收。真实 `/ars-full` 已在 Windows 11 上用 `commandcode/deepseek/deepseek-v4.1-flash` 完成 Stage 1–6（USD 0.2328），16 个公开命令都有调用记录（其中 15 个停在第一检查点；`/ars-full` 是完整工作流）。一次原生子代理派发探针成功。完整多代理编排（流水线派发原生子代理）仍未验证；PDF 导出、Windows durable ledger、Claude/Pi 运行时回归也仍是验收矩阵中已记录的限制。一个本地协议夹具在没有外部模型调用的情况下验证了命令轮次和工具续轮中的模型 ID。测试还使用已安装 SDK、内存回调和真实 Python guard/screening 夹具，这些都不能替代完整多代理编排验收。

## 原样复用的内容

- 5 个技能（`academic-paper`、`academic-paper-reviewer`、`academic-pipeline`、`deep-research`、`sr-screener`）
- 16 个 `/ars-*` 命令
- 4 个插件公开代理（`research-architect-agent`、`synthesis-agent`、`report-compiler-agent`、`screening-reviewer-agent`）
- `scripts/ars_write_scope_guard.py` 和 `scripts/ars_phase_scope_manifest.json`
- `sr-screener/scripts/*.py` 和 `sr-screener/templates/*`

核心源码和用户配置不会被自动改写。没有后台任务、定时维护、发布、提交或付费运行。

## 依赖

- Node 24+ 与 npm。首次安装前在 `opencode/` 中运行 `npm ci`。只有 Windows 11 + OpenCode 2.2.7 + Node 24 验证过；macOS 和 Linux 路径已实现，但本仓库未验证。
- 一份完整的 ARS 检出：五个技能目录、`.claude-plugin/`、`shared/`、`scripts/`，以及检出后的 `opencode/` 包。安装器会注册或复制这些资产；它不是独立发行包。
- 一个真实的 Python 3 解释器，用于写入范围 guard 和三个 CLI 命令（`ars-mark-read`、`ars-unmark-read`、`ars-cache-invalidate`）。按 `py -3`、`python3`、`python` 的顺序尝试；Microsoft Store 占位程序会因为没有标记输出而被拒绝。
- PyYAML，用于 mark-read CLI 和其他 Python 工具。mark/unmark 预检会用选中的解释器检查导入；合法 user-site 依赖对 CLI 命令可用，而 guard 保持隔离。
- Pandoc/Tectonic 只在 ARS 文档本来就要求它们的模式中使用。
- 全文筛选需要可读的 PDF 路径；标题/摘要筛选需要 `<work>/batches/` 下的批次文件。

## 安装渠道

安装器补齐原项目文档中的路径。两个渠道都支持项目级和用户全局级；各自保留自己的能力边界。

| 渠道 | 安装什么 | 不安装什么 |
|---|---|---|
| `plugin` | 适配器注册及其四个可移植原生代理。插件在运行时提供五个技能、十六个 `/ars-*` 命令、适配器工具和写入范围 guard。 | 不复制技能。永远不需要再装一次 skills。 |
| `skills` | 五个完整技能目录（原生 OpenCode 发现）、`screening-reviewer-agent` 原生子代理，以及一个受管 instruction 文件。项目级会嵌入路由核心；全局级只写兼容说明。 | 没有插件入口、命令、适配器工具、hook 或写入范围 guard。`sr-screener` 使用自己的 reviewer，不走插件派发。 |

```powershell
# 保留完整检出；把两个路径替换成你的实际目录。
npm --prefix "C:/work/academic-research-skills/opencode" ci

# 预览（默认）：不写任何文件。
node "C:/work/academic-research-skills/opencode/install.ts" install --channel plugin --scope project --project "C:/research/my-project"

# 检查预览后再应用。
node "C:/work/academic-research-skills/opencode/install.ts" install --channel plugin --scope project --project "C:/research/my-project" --models "C:/research/ars-models.json" --apply

# 只读诊断。
node "C:/work/academic-research-skills/opencode/install.ts" check --channel plugin --scope project --project "C:/research/my-project"
```

这些是替代路径，不是四次安装叠加。全局插件用 `--scope global`，同一个检出和 models 配置。只装 skills 用 `--channel skills`（任一作用域）并省略 `--models`。始终显式传 `--project`。安装到 ARS 检出目录本身会被拒绝；`--allow-checkout` 只保留给适配器开发，会把受管文件写进源码树。

`install`、`check`、`update`、`uninstall` 是受支持的动作。`--channel plugin|skills` 必填。`--scope project|global` 默认取已有配置的作用域（两者都有时优先 project）；两个作用域都有无关配置时请显式指定。`--project <dir>` 选择项目（默认当前目录）。`--models <json|file>` 只为 plugin 渠道添加显式模型映射；skills 渠道保留源端 `inherit` 模型，并拒绝该选项。`--adopt-legacy` 只被 `install` 和 `update` 接受，`check`/`uninstall` 不接受。

退出码：`0` 成功，`1` 被拒绝或检查失败，`2` 用法错误。任何检查报错时 `check` 返回 `1`（例如 Node 低于 24，或缺 `opencode/node_modules/@opencode/plugin`）。

安装路径：

- 项目插件配置：`opencode.json`（或已有的 `opencode.jsonc` / `.opencode/opencode.json(c)`）。同一作用域存在多个项目配置时按歧义拒绝，不猜测。
- 全局插件配置：`~/.config/opencode/opencode.json(c)`（遵循 `XDG_CONFIG_HOME`）。
- 项目 skills：`<project>/.opencode/skills/<name>/`，受管 instructions 在 `<project>/.opencode/ars-instructions.md`，由 `instructions` 引用。
- 全局 skills：`~/.config/opencode/skills/<name>/`，受管 instructions 在 `~/.config/opencode/ars-instructions.md`。

安装是保守的：

- 每次改动都先预览。必须 `--apply`；`check` 从不写盘。
- JSONC 用 `jsonc-parser` 原位编辑：注释、空白、Unicode 和无关键（包括已有密钥值）都会保留。UTF-8 BOM 会被接受，并在重写时移除。日志从不打印配置内容。
- 已定义但格式错误的 `plugins` 或 `instructions` 会被拒绝，绝不静默替换成数组。源技能树含符号链接时会拒绝安装，因为复制会不完整。
- 备份和所有权清单放在 `~/.ars/opencode-install/`（可用 `ARS_OPENCODE_STATE_DIR` 覆盖），位于项目 VCS 之外。状态目录落在项目或任何外层 Git worktree 内（包括解析后的 junction）会被拒绝。
- 敏感暂存也留在私有状态目录。原子替换要求状态目录和目标在同一文件系统。跨文件系统替换会显式失败，不会回退为原地复制；请在**首次安装前**把私有状态位置选在该文件系统上。后续生命周期命令保持同一状态位置。
- 安装器锁和写入前重读会在并发编辑时中止。
- 所有权基于摘要。第二次 apply 是 no-op；用户改过的条目会保留并报告，绝不覆盖。卸载只删除未改动的自有条目，修改过的 instruction 文件连同其 `instructions` 引用一起保留。
- 技能更新以目录为单位。修改过的 bundle 整体保留，不会把旧模板和新正文混在一起。退役的自有资产只在未改动时删除；删除失败会保留记录以便重试。
- 源副本省略 VCS 元数据和生成的依赖/字节码缓存。所有权检查**不会**忽略后来安装的额外文件或 junction：这些会保留整个 bundle。重试 update 前请自行检查/删除不需要的生成缓存；安装器绝不静默丢弃它们。
- 已存在的相同资产会被复用，但不会取得所有权。内容不同的无主资产是冲突，会阻止运行。
- 旧的固定根代理模板会被识别，但只有 `--adopt-legacy` 才会接管；单纯 install 请求不会取得所有权。

应用后重载（`/reload`），并用 `check` 加宿主自己的清单验证。磁盘检查不能证明宿主加载了插件、注册了命令或激活了 guard。

### 手动安装兜底

插件仍可手工添加。项目配置示例：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["./academic-research-skills/opencode"]
}
```

绝对路径也可用。`repoRoot` 从适配器自身位置推导；只有包被移出 ARS 检出时才需要设置。四个原生代理仍需要各自的 `agents.<id>` 条目。用 `ars_opencode_status`（只读）一次请求一个完整 agent 片段；整包会超过宿主的工具输出上限。生成的 agent 说明是项目可移植的，只嵌入检出根。与已有 command、skill 或 agent 冲突时会拒绝，不会覆盖。

适配器还注册两个工具：`ars_run_script`（无 shell 的 CLI 执行，经过宿主权限检查）和 `ars_screening`（sr-screener 派发）。四个原生 ARS 子代理对两者都被硬拒绝，它们的工具边界保持源端 `tools:` 列表。

OpenCode 命令由用户调用；适配器把源端 `disable-model-invocation` 保留为元数据，不暴露模型可调用的 command 工具。

## 模型

OpenCode 没有 Claude 的 `sonnet`/`opus` 别名。适配器强制显式映射。安装器的 `--models` 值会写入插件 options，所以重载后同一套映射仍然有效：

```powershell
node "C:/work/academic-research-skills/opencode/install.ts" install --channel plugin --scope project --project "C:/research/my-project" --models "C:/research/ars-models.json" --apply
```

models 文件只包含映射，例如 `{"aliases":{"sonnet":{"providerID":"your-provider","model":"your-model"}}}`。它也可以包含 `{"screening":{"roles":{"FTA":{"providerID":"your-provider","model":"your-model"}}}}`。筛选角色名是 `A`、`B`、`ADJ`、`QC`、`FTA`、`FTB`、`FTADJ`；安装器会校验每个引用并写入 `options.screening.roles`。后续 update/check 省略 `--models` 会保留并使用已持久化映射，不会重置。凭据请通过 OpenCode 存储，不要写进这个文件。

模型消费者按渠道不同：

- **Plugin 渠道：** 命令别名（`models.aliases.<alias>`）、原生代理覆盖（`models.agents.<id>`）和筛选角色映射（`screening.roles.<role>`）。适配器自己绝不发明模型。
- **Skills 渠道：** 没有插件 options。reviewer 保留源端 `inherit` 模型；`--models` 会被拒绝，而不是静默丢弃。
- 映射只是 provider/model 引用，绝不携带凭据。

- 每个声明 Claude 别名的命令都必须有 `models.aliases.<alias>`；缺失或不可用的映射会在任何 prompt 被接纳之前**阻止该次调用**，没有继承回退；
- 命令别名通过宿主 `experimental.model.resolve` hook 按请求路由，OpenCode 文档说明它只支持同 provider。别名用 route tag 绑定到已接纳的命令 prompt，跟随该轮的主请求，包括工具续轮。无关 prompt 不能消费它；无法关联路由时，请求会显式阻断，而不是继承。路由在正常 idle 以及文档化的失败/中断执行事件上释放，所以同会话的下一个别名命令可以运行。如果映射模型与当前会话不在同一 provider，命令会带可操作消息阻断，而不是静默使用会话模型；
- 原生代理保持源端继承，除非设置了 `models.agents.<id>`；安装检查会验证生效的 agent 模型；
- 状态工具记录最近实际应用的路由。

```jsonc
{
  "plugins": [
    {
      "package": "./academic-research-skills/opencode",
      "options": {
        "repoRoot": "C:/work/academic-research-skills",
        "models": {
          "aliases": {
            "sonnet": { "providerID": "your-provider", "model": "your-model" },
            "opus": { "providerID": "your-provider", "model": "your-other-model" }
          },
          "agents": {
            "synthesis-agent": { "providerID": "your-provider", "model": "your-other-model" }
          }
        },
        "screening": {
          "roles": {
            "A": { "providerID": "your-provider", "model": "your-model" },
            "B": { "providerID": "your-provider", "model": "your-model" },
            "ADJ": { "providerID": "your-provider", "model": "your-model" },
            "QC": { "providerID": "your-provider", "model": "your-model" },
            "FTA": { "providerID": "your-provider", "model": "your-model" },
            "FTB": { "providerID": "your-provider", "model": "your-model" },
            "FTADJ": { "providerID": "your-provider", "model": "your-model" }
          }
        }
      }
    }
  ]
}
```

当生成的 `screening_config.json` 为七个筛选角色命名模型时，七个角色都必须映射。派发器会切换每个子会话的模型，读回生效模型，不一致就拒绝 prompt。缺失映射会阻止派发。

## 写入范围与权限

原生权限矩阵镜像每个 agent 的源端 `tools:` 列表：

- `screening-reviewer-agent` 只读（无 edit、无 shell、无 subagent、无 web）。
- `synthesis-agent` 和 `research-architect-agent` 保留 edit，但失去 shell、subagent、web 和 skill 动作。
- `report-compiler-agent` 保留 edit，失去 shell、subagent、web 和 skill。

CLI 工具和三个 CLI 命令会在启动子进程前请求宿主对真实写入目标求值 `edit`；项目外目标还要通过宿主 `external_directory` 门。只读 reviewer 被直接拒绝。

阶段围栏**没有**重新实现。每次 `edit` 和 `shell` 权限求值时，适配器解析可信 actor——有显式 hook actor 就用它，否则用 `ctx.session.get({ sessionID }).agent`——把该 ID 和所有目标传给 `scripts/ars_write_scope_guard.py`，然后只转发 `deny`。无法解析可信 agent 身份时，该操作会显式拒绝，而不是当作无作用域放行。pass-through 不改变宿主决策，所以适配器只能收紧访问，不能放宽。

可信根是分开的：ARS 检出（`repoRoot`，从包位置或显式 option 推导）和当前项目（`ctx.location.project.canonical`）。环境中的 `CLAUDE_*` 变量会从 guard 子进程和 shell 子进程中移除，然后显式设置两个根。

### 降级模式（可见 pass-through）

guard 是可选强化。如果找不到真实 Python、guard 脚本缺失、运行超时、非零退出、输出无法解析，或转发 guard 建议（例如 manifest 不可读），适配器会放行宿主决策，并在 `ars_opencode_status` 和控制台一条警告中报告 `degraded`。它绝不自己发出 `allow` 或 `ask`。

只有两个原生 Bucket A 子代理会被围栏（`synthesis-agent`、`research-architect-agent`）。在主会话中内联运行的角色不受 guard 围栏，这与源端范围一致。筛选的 reviewer 独立性来自独立的只读会话，不是写入 guard。

## 命令与三个 CLI 包装器

`/ars-full`、`/ars-*` 模式命令及其余命令都按原始正文注册。适配器把 `${CLAUDE_PLUGIN_ROOT}` 重写为可信包根，解释 OpenCode 工具名，展开 `$ARGUMENTS`，并透传文件/agent/skill 附件（mention 偏移会重映射）。

三个命令是 CLI 包装器，**不会**交给 shell：

- `ars-cache-invalidate`
- `ars-mark-read`
- `ars-unmark-read`

调用参数确定性地分词（只处理引号和反斜杠，不做展开），然后在任何进程启动前校验 option/value 配对、位置参数数量、重复 flag、`--scope` 值、`--locator` 上下文、`--note` 上下文，以及冲突的 `--unmark` flag。allowlist 是第二道检查。没有 shell 字符串，也没有模型辅助解析。

`ars-mark-read`/`ars-unmark-read` 需要当前 Material Passport 路径。如果调用和 `ARS_PASSPORT_PATH` 都没有 `--passport-path`，适配器返回可操作的不执行消息；它不猜测，也不把参数交给模型。任何 CLI 运行前，适配器会请求宿主对真实目标求值 `edit`（同级的 `_human_read_log.yaml` 及其锁，或验证缓存数据库）。四个原生 ARS 子代理对两个适配器工具都被直接拒绝，所以这个工具不能成为绕过源端 `tools:` 边界的出口。三个斜杠命令也走同一检查。

## 筛选派发

```bash
python sr-screener/scripts/build_workflow.py ta \
  --work W --protocol protocol.md --config screening_config.json \
  --jobs pilot --emit-prompts W/prompts
```

然后调用 `ars_screening`，参数 `{ "stage": "ta", "work": "W", "emit": "W/prompts" }`（可选 `out`）。没有 `"approve": true` 时，工具只返回调用次数预览，不派发任何东西；只有用户批准该预览后才设置它。适配器会：

1. 校验 `label@context_id`、批次文件或 PDF，以及七个角色模型；它还会在派发边界重新校验已安装的 `screening-reviewer-agent` 的 system、mode、permissions 和 model，如果契约不一致，会在任何子会话或费用提示之前阻断；
2. 当生成的 prompt 绑定到过期上下文时警告（profile 变更会归档早先决策）；
3. 写入结果文件及其 `.audit.json` 边车之前，请求宿主对两者求值 `edit`；
4. 对初始调用**以及**每次调用有界的一次重试上限，调用宿主权限检查 `permission.assert({ action: "ars_screening_dispatch", resources: [plan] })`。只有你的权限规则把该 action 设为 `ask` 或更严格时才会出现确认提示；如果全局规则自动允许，适配器不会再加一次确认。请显式配置，例如：

   ```jsonc
   {
     "permissions": [
       { "action": "ars_screening_dispatch", "resource": "*", "effect": "ask" }
     ]
   }
   ```
5. 把每个 prompt 派发到独立的 fresh `screening-reviewer-agent` 会话（看不到同侪输出），应用配置的角色模型，并在 prompt 前读回生效模型；
6. 应用源端决策检查（`d`/`code` 一致、预期 ID、重复），对缺失 ID 重试一次，仍然缺失的保持 pending——绝不默认填充。重试失败会保留第一次回复中已接受的决策；
7. 写出 `opencode_screening_<stage>.json`，是 `{ "label": "A:b001@<context>", "decisions": [...] }` 的普通数组，外加 `.audit.json` 边车，记录 pending/rejected 条目、实际调用次数和每个条目的生效模型路由。

用未修改的脚本合并：

```bash
python sr-screener/scripts/merge_decisions.py --work W --from W/opencode_screening_ta.json --config screening_config.json --protocol protocol.md --stage ta
```

pilot 门、protocol 身份和修订归档仍由 Python 工具负责。

## 更新、卸载与迁移

- **更新（plugin）：** 拉取 ARS 检出，然后运行 `node "C:/work/academic-research-skills/opencode/install.ts" update --channel plugin --scope project --project "C:/research/my-project" --apply`，刷新自有 agent 条目和插件 options。插件在加载时读取技能和命令；运行中的宿主需要 `/reload`。适配器本身变化时，在 `opencode/` 中重新运行 `npm ci`、`npm run typecheck` 和 `npm test`。
- **更新（skills）：** 拉取检出，然后运行 `node "C:/work/academic-research-skills/opencode/install.ts" update --channel skills --scope project --project "C:/research/my-project" --apply`。五个技能目录各自整体替换。如果你改过 bundle 内任何文件，整个 bundle 会保留并列为 retained；未改动的退役资源会删除。技能删除失败会保留记录，由下一次 update 或 uninstall 重试；instruction 删除失败由下一次 uninstall 重试。
- **卸载：** `node "C:/work/academic-research-skills/opencode/install.ts" uninstall --channel <plugin|skills> --scope project --project "C:/research/my-project" --apply`。只删除未改动的自有条目。修改过的 agent、skill 和 instruction 文件连同所有权记录一起保留；修改过的 instruction 文件连同其 `instructions` 引用保留。卸载绝不把旧的整份配置备份覆盖到后来的编辑上。
- **切换渠道：** 先预览目标渠道。已存在的相同资产会复用，但不取得所有权。内容不同的无主技能副本或 agent 条目是冲突；请有意删除或移动旧路由。安装器不会静默删除另一渠道的文件。
- **移动检出：** **移动前**先卸载未改动的自有条目，然后从新的完整检出安装。插件条目、instructions 和所有权绑定旧路径；`update` 不会迁移该身份。如果已经移动，恢复旧路径以卸载，或检查/备份后显式删除旧手工配置。绝不要为了强制接管而删除所有权记录。全局 profile 是一个固定检出/profile，不是自动按项目选择 clone。路径是本机路径，不是发行契约。
- **另一台机器：** clone 检出，在 `opencode/` 中运行 `npm ci`，然后在那里安装。不要把另一台机器的配置或 manifest 复制过来当作已安装证明。

手工安装仍遵循旧规则：自行删除手工合并的插件和 agent 条目。安装器只报告它拥有的内容，绝不声称拥有无关条目。

## 开发

```bash
cd opencode
npm ci
npm run typecheck
npm test

# 可选的真实宿主安装测试（固定 Windows/OpenCode 2.2.7/Node 24+）。
# 这个显式命令才开启门禁；缺少前置条件会失败，不会跳过。
npm run test:host:install
```

`npm test` 运行安装器矩阵：两个渠道 × 两个作用域、JSONC 注释/Unicode/密钥保留、preview/apply 幂等、模型 options、完整技能树、受管 instructions、修改 bundle 保留、未改动自有资产退役、部分卸载与重试记录、仅 `--adopt-legacy` 接管旧模板、坏配置中止、锁竞争、写入失败后的回滚，以及只读检查。环境隔离使用临时 HOME/USERPROFILE/XDG config/data/cache/state 加 `ProgramData`。宿主门禁还会隔离 APPDATA/LOCALAPPDATA、临时目录和凭据；检查真实宿主 data/config/cache 路径；调用原生技能和读工具；在故意中止推理前检查组装后的 instructions；并在一个全局配置服务器中检查两个位置的允许/ARS 拒绝原生写入。它启动真实可执行文件，不是启动器代理，并且只停止自己的子进程。可用显式 `ARS_OPENCODE_BINARY` 选择该可执行文件。Node 24 门禁四个用例全部通过、无跳过；外层测试解释了第五个报告通过。不执行外部推理：请求组装后会被检查，然后故意中断。

`npm ci` 报告 24 个 moderate advisory，没有 high 或 critical。`npm audit` 把直接风险归因于必需的 `@opencode/plugin@2.2.7` 依赖及其 `@opencode/util` npm 工具链。该直接链没有可用修复，但三个传递依赖报告 `fixAvailable: true`。只报告，不自动修复或压制；这里不执行 audit fix 或 lockfile 更新。

测试覆盖目录计数（5/16/4）、`$ARGUMENTS` 与附件重映射、argv 分词/配对/冲突校验、真实 Python guard（范围内放行、范围外和 shell 拒绝、move/delete 资源覆盖、带 infra 名称的用户文件、畸形目标、超时/坏输出降级、环境隔离、宿主 ask/deny 保留）、模型路由（hook 应用、缺失/不可用/跨 provider 阻断、无回退）、原生权限矩阵与生效 agent 诊断、脚本工具权限检查、四个原生 ARS agent 对两个适配器变更工具的硬拒绝、每 agent 状态片段（大小和完整 `system` 内容），以及真实 Python TA/ADJ/QC/FT prompt 夹具、路由角色模型和真实 `merge_decisions.py` 通过。真实缓存 CLI 测试断言退出状态、DB 创建、WAL/SHM 权限覆盖和无包内字节码。宿主权限 deny 在执行前被实际触发。

独立的 Windows/OpenCode 2.2.7 探针还检查了注册、显式和会话推导的权限 actor，以及真实内置 write/edit/patch（含 move/delete）执行器。被拒绝的变更保持文件不变。Reviewer 派发检查检测缺失 agent、改动 instructions 和削弱权限。仅 loopback 的协议夹具验证了顺序轮次和真实宿主工具续轮中的命令模型 ID；它不是真实模型或外部 provider。探针证据保持私有。

仍未验证：真实 provider 别名路由（loopback 夹具不是外部 provider）、完整多代理编排（一次原生子代理探针成功，但流水线本身没有派发子代理）、筛选审批 UI，以及已记录 resume 之外的中断/恢复。完整学术流水线已跑过一次（`/ars-full`，Stage 1–6）；PDF 导出、Windows durable ledger 和 Claude/Pi 运行时回归仍是已记录限制。`tests/runtime.test.ts` 的内存宿主只证明回调行为；直接宿主探针本身不能证明模型驱动工作流。
