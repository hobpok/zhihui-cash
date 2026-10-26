# 给评审 AI 的阅读入口

## 你的任务

先理解，再提出修改意见。默认只读；没有人的明确开发要求，不改文件、不运行部署、不接入真实账户、不调用收费模型。反馈直接输出给同事，由同事转交负责人，不要求 GitHub 账号。

## 十分钟阅读顺序

1. [README](README.md)：项目目的、版本与运行边界。
2. [业务流程与指标](docs/业务流程与指标.md)：现行流程、样例与口径。
3. [数据与公开范围](docs/数据与公开范围.md)：区分初始演示、规则与历史指标目录。
4. 根据问题选择下表对应源码和同名测试，不必一次读遍所有文件。
5. 阅读[验证记录](docs/验证记录.md)，按[反馈模板](docs/反馈模板.md)给意见。

## 当前状态

应用版本为 **6-0.39.0**，版本初始化标记仍为 **6-0.28.0**。新默认是五笔“补救案例（默认，未预设卖券）”；旧六笔“三项银行约束（预设卖券）”（revision 2）和原始零现金九笔计划继续可选。已按标记初始化的账号不会因本次升级重置，未初始化账号沿用既有一次初始化流程。已有账号／浏览器数据要体验新默认，须在“初始数据”手动点击一次默认补救案例，保留旧运行历史并新建运行。云端版本初始化逻辑保留在后端源码供理解；本地静态预览只使用浏览器存储，不会进入生产账户。刷新不会自动覆盖旧模板或运行。

本仓库是经过整理的公开快照。历史资料、生产运行记录与原始附件不在这里；缺少它们不意味着需要编造数据、重建账号或重复发布。后续同步由负责人审核后进行，不能假设它实时等同正在开发的目录。

三银行参数展示两种顺序约束：广州公司敞口先从79/1000=7.9%降至7.7%，才可整笔存3亿元到8%；直接存款会到8.2%并阻断。新默认没有预设卖券，须发现候选并人工确认；旧六笔则预设该卖券计划。江南从58/1000=5.8%先整笔存2亿元到6%，再买存单1亿元到6.1%；逆序会阻断存款。存款在计算、下达、成交和撤销环节均按整笔处理，历史部分成交的剩余金额也按整笔处理；其他品种仍允许符合规则的安全部分成交。投管环节按实际成交状态提示顺序并拦截受限动作，AI解释须给出上述正反顺序和数字。

默认补救案例保留存量广州银行CD持仓。计算发现存款未安排时，或AI明确规划完整计划／寻找补救时，会核算补卖CD 2亿元：实际成交后敞口77亿，整笔存3亿后80亿／8%。融资49亿、逆回购20亿及原投资目标保留；新增卖券必须单独勾选同意，随后仍须重算、审核及手动下达。搜索同银行CD优先、支持银行债和组合，默认最多24个候选、8项持仓；未找到不表示全局无解，明确禁卖会阻止自动补救。AI依据错误分类并支持受校验的摘要恢复，不能把旧引用或无效候选修成通过。

本次同步包含6-0.30至6-0.37的剩余计划排单、渐进改善统一口径、成交／结算入口简化、当前比例及下一笔融资只读核验、云冲突恢复、AI语言解析、重复计算削减和逆回购较小现金分片搜索。细节见[业务说明](docs/业务流程与指标.md)。

## 按问题找代码

| 想了解什么 | 入口 |
|---|---|
| 默认五笔、旧六笔及原始九笔样例 | [default-scenario.js](app/default-scenario.js)、[original-scenario.js](app/original-scenario.js)、对应 `.test.js` |
| 初始数据格式、金额单位与模板切换 | [initial-data.js](app/initial-data.js)、[initial-ui.js](app/initial-ui.js)、[initial-ui-presets.test.js](app/initial-ui-presets.test.js) |
| 现金、敞口、期限的规则结果 | [core-rules.js](app/core-rules.js)、[core-rules.test.js](app/core-rules.test.js) |
| 计划排序、批次计算、可执行容量 | [engine.js](app/engine.js)、[calculation-controller.js](app/calculation-controller.js)、[planning-solver.js](app/planning-solver.js) |
| 下达、成交、结算、撤改与占用 | [model.js](app/model.js)、[execution.js](app/execution.js)、[business.js](app/business.js) |
| 工作台操作与诊断解释 | [ui.js](app/ui.js)、[c-ui.js](app/c-ui.js)、[readiness-diagnostics.js](app/readiness-diagnostics.js) |
| 指标目录和只读分析 | [analysis.js](app/analysis.js)、[metric-catalog.js](app/metric-catalog.js) |
| AI 候选、流式结果与人工确认 | [ai-conversation.js](app/ai-conversation.js)、[ai-draft.js](app/ai-draft.js)、[ai-dialogue.js](server/ai-dialogue.js)、[ai-service.js](server/ai-service.js) |
| 无预设卖券的发现与确认 | [remediation.js](app/remediation.js)、[remediation-ui.js](app/remediation-ui.js)、[remediation.test.js](app/remediation.test.js)、[remediation-integration.test.js](server/remediation-integration.test.js) |
| 当前比例缺口与下一笔融资 | [planning-tools.js](server/planning-tools.js)、[next-trade-funding.js](server/next-trade-funding.js)、[next-trade-funding.test.js](server/next-trade-funding.test.js) |
| 云存档、认证、版本初始化的设计 | [api.js](server/api.js)、[storage.js](server/storage.js)、[migrations](migrations)；未提供部署配置与账户 |

## 提意见时注意

- 重点评审计划→计算→下达→模拟成交／收付→重新计算的完整路径，不要只讨论单个按钮。
- 业务实时头寸和账户现金是不同口径；“可下达”不代表“已经成交／已到账”。
- 新增存款的公司级6%／批准8%门槛，与本基金无托管资格银行5%限额独立；不要重新引入错误的本基金8%规则。
- 默认案例确认加入卖CD 2亿元的补救后，完整模拟融资49亿元、逆回购20亿元并偿还旧融资25亿元，账户现金5亿元、C02为5%、C09为46700/549≈85.06375228天。旧六笔也展示这一路径。计算顺序与实际成交顺序都影响能否完成，存款不能拆小绕过门槛。
- 121项分析目录（10项已有配置、111项待补数据）与102项历史指标名称不是同一集合，也不是223条完整风控规则。
- 规则阈值是本项目当前模拟合同，不凭名称认定为适用于所有基金的现行监管要求。讨论制度变更须另列待确认依据。
- AI 输出先是建议或临时预览，最终验证通过的候选仍需人确认、计算和复核才能进入下达流程。
- 测试 fixture 和旧设计图用于回归或设计解释，不覆盖当前默认样例。对冲突标注文件与版本。
- 优先给3至5项有依据、可验收的建议；明确“已经实现”“本次测试覆盖”“仍需验证”，不要把猜测写成故障。
