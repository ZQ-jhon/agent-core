# A2UI Form Profile v1 后端契约评审记录

## 评审状态

| 项目 | 值 |
| --- | --- |
| 候选版本 | `1.0.0` |
| 候选发布日期 | 2026-07-25 |
| 协议负责人 | 泛前端开发专家 |
| 后端评审方 | A2UI Python 后端任务负责人 |
| 当前结论 | 初稿已完成机器校验；等待后端独立评审后冻结 |

冻结门禁：后端评审方必须对下表每项给出“接受”或给出具体变更意见；协议负责人吸收反馈、重新运行契约测试并把结论记录到本文后，才把 `schema-v1.md` 状态改为“已冻结”。

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
| 幂等/并发 | requestId 建议作为提交幂等键；revision 防旧表单提交 | 重复请求返回同一结果；旧 revision 返回 409 `FORM_REVISION_CONFLICT`。 |
| 远程选项 | Schema 只下发 endpointKey；v1 仅 GET | 服务端/宿主注册真实 URL、鉴权、参数白名单和响应映射。 |
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
- resolve 能根据 client capabilities 返回文档或明确的 422；
- submit 成功返回 submissionId；重复 requestId 保持幂等；
- required、范围、枚举、远程 option 和业务规则错误返回字段 path；
- 无法映射为字段的业务错误进入通用 errors；
- revision 过期返回 409；未认证/无权限分别返回 401/403；
- upload 和远程 options 不接受 Schema 自带 URL/Headers；
- 日志可用 requestId/formId/revision 关联，但不记录敏感表单原文。

## 4. 初稿自审结论

- 请求、下发、提交、成功、字段错误与通用错误均有唯一包络；
- `formId + revision` 解决定义一致性，`requestId` 解决追踪与幂等；
- fieldErrors 以 dataPath 为主键，避免依赖可变组件布局；
- endpointKey 把网络与鉴权配置留在可信宿主；
- 完整快照适合首期 REST 和三个 demo，流式更新留到后续协议版本；
- 规范 JSON Schema 和语义测试已验证三个示例。

## 5. 变更记录

| 日期 | 版本 | 变更 | 结论 |
| --- | --- | --- | --- |
| 2026-07-25 | `1.0.0` 冻结候选 | 建立快照包络、14 个组件、同步校验、白名单联动、三类 action、远程选项与 REST 错误契约 | 初稿进入后端评审 |
