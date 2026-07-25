# A2UI Form Profile v1 后端契约评审记录

## 评审状态

| 项目 | 值 |
| --- | --- |
| 候选版本 | `1.0.0` |
| 候选发布日期 | 2026-07-25 |
| 协议负责人 | 泛前端开发专家 |
| 后端评审方 | A2UI Python 后端任务负责人 |
| 当前结论 | 后端最终复审 `accepted_freeze`；请求、下发、提交/幂等和字段错误四项均已接受，`1.0.0` 已冻结 |

冻结门禁已满足：后端评审方基于 PR #3 的 `d0257ef` 确认 `accepted_freeze`；协议负责人复跑全量契约测试并记录结论后，已把 `schema-v1.md` 状态改为“已冻结”。

## 1. 待确认契约基线

| 主题 | v1 决策 | 后端实现含义 |
| --- | --- | --- |
| 请求 | `POST /api/a2ui/v1/forms:resolve`，body 含 `schemaVersion/requestId/formKey/context/client` | Pydantic 模型拒绝未知字段；基于认证主体和 context 解析表单。 |
| 下发 | HTTP 200 返回完整 `A2UIFormDocumentV1` 快照 | 下发前执行 JSON Schema + 语义校验；记录 requestId/formId/revision。 |
| 版本 | 客户端声明精确 `supportedSchemaVersions`，不自动接受未来 minor | 无共同版本返回 422 `CLIENT_CAPABILITY_MISMATCH`。 |
| 提交 | `POST /api/a2ui/v1/forms/{formId}/submissions` | path/body formId、revision、action/sourceComponent 必须交叉验证。 |
| 数据 | 提交完整 data；字段路径使用 RFC 6901 JSON Pointer | 服务端按当前 revision 的字段白名单投影并拒绝未知键。 |
| 字段错误 | HTTP 422，`status=validation_error`，`fieldErrors` 为 `Record<DataPath, FieldError[]>` | 错误 path 必须指向提交数据；可附 componentId，但 path 是稳定主键。 |
| 通用错误 | `status=error` + `errors[{code,message,retryable}]` | 不把内部堆栈、URL、查询或秘密放入 message。 |
| 幂等/并发 | submit 必填 `idempotencyKey`，`requestId` 仅追踪；作用域为认证主体 + formId + revision + actionId | 严格解析后先原子查询记录：已完成同 key/同指纹即使当前 revision/action 失效也回放；同 key/异指纹返回 409 `IDEMPOTENCY_KEY_CONFLICT`；仅无记录时校验当前 revision/action。 |
| 远程选项 | remote source 除 `id/type` 外只下发 endpointKey；v1 descriptor 仅允许 GET | 可信注册表的不可变 descriptor 唯一定义真实 URL、鉴权、参数白名单、允许的数据来源、响应映射及触发/缓存策略；Schema 携带这些执行语义必须拒绝。 |
| 上传 | multipart 上传成功后只把服务端文件引用写入 data | 提交时复核 fileId 的所有权、状态、大小和内容安全。 |
| Agent 集成 | 对话响应可携带完整快照；v1 不规定增量/流式消息 | 既有 Agent 文本 API 不变；新适配层显式识别 A2UI 文档。 |

## 2. 服务端模型建议映射

建议使用 `extra="forbid"` 的 Pydantic v2 模型，并对联合类型使用 `type` 判别字段。JSON Schema 无法覆盖的检查放在 model validator 或 service 层：

1. 组件 ID 和 action/dataSource/rule ID 唯一；
2. action、dataSource、规则目标引用存在且类型适配；
3. dataPath 能在 initialValues 中解析；
4. setValue 规则依赖图无环；
5. option value 唯一且类型一致；
6. generatedAt/expiresAt 顺序正确；
7. submit 数据只包含当前 revision 允许的路径。

模型层只验证协议形状；权限、endpointKey 注册、业务 required、远程 option 合法性、文件所有权和数据库写入放在 service 层。不要把业务依赖注入 Pydantic validator。

## 3. 典型请求/响应验收

后端评审与后续契约测试至少覆盖：

- 三个标准示例可被模型完整解析并无损序列化；
- 缺少 schemaVersion、未知组件、未知 prop、重复 ID、悬空 action、非法 dataPath 均拒绝；
- resolve 能根据 client capabilities 返回文档或独立的 422 `formResolveError`，错误包络含 formKey 且不要求 formId；
- submit 缺少 `idempotencyKey` 必须拒绝；成功响应必须同时包含 result 和 submissionId；
- 同 key/同规范化请求返回同一 submissionId 和等价 result，同 key/异请求返回 409 且不执行副作用；
- rev4 成功但响应丢失、表单升至 rev5 后以原 key/原请求重试，仍回放 rev4 响应；仅没有幂等记录的过期 revision 返回 409；
- required、范围、枚举、远程 option 和业务规则错误返回字段 path；
- 无法映射为字段的业务错误进入通用 errors；
- revision 过期返回 409；未认证/无权限分别返回 401/403；
- upload 和远程 options 不接受 Schema 自带 URL/Headers；remote options 还必须拒绝 Schema 自带的参数名、数据来源路径与响应映射；
- 日志可用 requestId/formId/revision 关联，但不记录敏感表单原文。

## 4. 修订自审结论

- 请求、下发、resolve 错误、提交、成功、字段错误与 submit 通用错误均有唯一包络；
- `formId + revision` 解决定义一致性，`requestId` 只负责追踪，`idempotencyKey` 负责逻辑提交去重；
- fieldErrors 以 dataPath 为主键，避免依赖可变组件布局；
- endpointKey 把网络、鉴权、请求构造与响应映射全部留在可信宿主注册表；
- 完整快照适合首期 REST 和三个 demo，流式更新留到后续协议版本；
- 规范 JSON Schema 和语义测试已验证三个示例。

## 5. 两轮反馈吸收与复审映射

| 后端阻断项 | 修订结果 | 机器证据 |
| --- | --- | --- |
| resolve 422 无独立模型 | `a2ui-api-v1.schema.json` 新增 `formResolveError`；`FormResolveErrorV1` 要求 `requestId/formKey/status/errors`，禁止虚构 `formId` | `test_api_message_examples_match_api_schema` 正例；`test_api_schema_rejects_ambiguous_resolve_and_submit_messages` 覆盖误用 submit 包络与缺少 errors 反例 |
| submit 成功结果可缺失 | `formSubmitSuccess` 强制 `result`，其内部强制 `submissionId`；TS 同步为必填；文档要求回放同一 ID 和等价结果 | 同一 API 反例测试分别拒绝缺少 result、缺少 submissionId |
| 幂等仅为建议 | submit 请求强制 `idempotencyKey`；明确作用域、重试复用、规范化指纹、409 冲突、并发占用、原子业务写入和结果回放 | API 正例带 key、反例拒绝缺 key；`validation-and-actions-v1.md` 第 5.1 节给出完整 MUST 语义 |
| 最新 PRD 的最小聚焦表单 | 未新增组件 prop；生产者规范限定单字段、条件化补全、必要申请，超过 7 字段优先拆分 | `test_examples_are_minimal_and_cover_agent_task_shapes` 验证 1 字段示例、联动、远程选项及所有示例不超过 7 个可编辑字段 |
| 幂等回放与过期 revision 优先级冲突 | 固定为严格解析后先按请求 scope 原子查记录；已完成同 key/同指纹优先回放，只有无记录时才校验当前 revision/action/source | `test_completed_idempotent_replay_precedes_current_revision_validation` 固化处理顺序与“rev4 响应丢失、升到 rev5 后重试”正例 |
| remote options 配置权属不一致 | Form Schema 与 TS 删除 method/query/source-path/response/dependsOn；示例只引用 endpointKey，可信注册表 descriptor 成为执行语义唯一权威 | `test_remote_options_execution_semantics_are_registry_owned` 校验最小模型，并分别拒绝参数名、数据来源路径和响应映射三类不匹配 |

复审结论：后端评审方已确认第二轮两项阻断关闭，并分别接受请求、下发、提交/幂等和字段错误四项；结论为 `accepted_freeze`。冻结技术基线为 PR #3 的 `d0257ef`，后续协议字段或范围变更必须走新版本与兼容性流程。

本轮验证命令：`PYTHONPATH=src uv run --extra dev pytest -q`；结果：`17 passed`。

## 6. 变更记录

| 日期 | 版本 | 变更 | 结论 |
| --- | --- | --- | --- |
| 2026-07-25 | `1.0.0` 冻结候选 | 建立快照包络、14 个组件、同步校验、白名单联动、三类 action、远程选项与 REST 错误契约 | 初稿进入后端评审 |
| 2026-07-25 | `1.0.0` 冻结候选修订 1 | 吸收 resolve 错误、成功结果必填、submit 幂等三项阻断；示例对齐最小聚焦 PRD | 修订完成，等待后端复审，不可冻结 |
| 2026-07-25 | `1.0.0` 冻结候选修订 2 | 明确幂等回放优先于当前 revision/action 校验；远程 options 执行语义收归可信注册表唯一托管 | 修订完成，17 passed，等待后端最终复审，不可冻结 |
| 2026-07-25 | `1.0.0` 已冻结 | 后端基于 PR #3 `d0257ef` 确认 `accepted_freeze`；未新增协议字段或范围 | 请求、下发、提交/幂等、字段错误四项接受；17 passed |
