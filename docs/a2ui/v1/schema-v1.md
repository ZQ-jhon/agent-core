# A2UI 动态表单 Schema v1

状态：`1.0.0` 冻结候选（完成后端契约评审后冻结）  
适用项目：`agent-core` 的 A2UI 动态表单演示与后端适配  
规范 Schema：[`schema/a2ui-form-v1.schema.json`](schema/a2ui-form-v1.schema.json)  
API 消息 Schema：[`schema/a2ui-api-v1.schema.json`](schema/a2ui-api-v1.schema.json)  
规范 TypeScript 类型：[`types/a2ui-form-v1.ts`](types/a2ui-form-v1.ts)

## 1. 定位与范围

本文定义项目本地的 **A2UI Form Profile v1**。它借鉴 A2UI 的声明式 UI、稳定组件标识、数据绑定和受控 action 思想，但为了首期 REST 下发、表单渲染与提交场景，使用一份完整快照而不是增量 JSONL 消息。

本 Profile 服务于 Agent 当前任务：每次 resolve 应下发**最小、聚焦、可立即完成**的字段集合，而不是复用静态全量资料表。生产者必须遵循：

- 单字段修改只包含目标字段和完成动作，不重复索取无关资料；
- 条件化资料补全通过现有白名单规则显示、禁用或清空必要字段；
- 申请或预约只收集完成当前动作所必需且有明确约束的字段；
- 可编辑字段超过 7 个时应拆成多个任务/表单；确因原子业务动作不可拆分时，必须在产品评审材料中说明，协议本身不新增或执行该业务解释。

上述约束是文档生产策略，不是 `Form` 或输入组件的通用 prop。renderer 不负责猜测业务相关性，服务端/Agent 生产者负责选择最小组件树。

本协议不是 Google A2UI v0.9.1/v1.0 的线级兼容实现。官方 v1.0 仍是 Candidate；后续若接入官方 renderer，应新增独立 adapter，不得在同一 `schemaVersion` 下悄悄改变报文。参考：[A2UI 版本状态](https://a2ui.org/)与[官方协议概览](https://a2ui.org/concepts/overview/)。

v1 包含：

- 表单完整快照下发；
- 固定组件目录；
- JSON Pointer 数据绑定与初始值；
- 同步字段校验；
- 白名单条件和显隐、禁用、赋值联动；
- 白名单提交、重置、上传 action；
- 静态与远程选项数据源；
- 成功、字段错误和通用错误响应。

v1 不包含：

- 任意 JavaScript、模板表达式、`eval` 或动态模块；
- 任意 URL、HTTP Header、鉴权信息或请求代码下发；
- 流程编排、跨表单事务、动态组件注册、可视化编辑器；
- 官方 A2UI 的 surface、增量更新、JSONL 或 RPC actionResponse；
- 服务端异步校验的客户端直连实现。

## 2. 版本策略

`schemaVersion` 使用 SemVer，v1 首版固定为字符串 `1.0.0`。

- 主版本不同：客户端必须拒绝整份文档，显示“协议版本不受支持”，不得尝试渲染。
- 次版本或补丁版本不同：只有版本位于客户端显式声明的 `supportedSchemaVersions` 中时才能接收；不按“同主版本自动兼容”猜测。
- 新组件、新必填字段、字段语义改变均至少发布新次版本及新 Schema；破坏性变更发布新主版本。
- 同一 `formId` 的内容更新递增 `revision`。提交必须回传该值；服务端遇到过期 revision 返回 `FORM_REVISION_CONFLICT`。
- Schema 文件默认严格校验未知字段。若未先协商新版本，未知字段属于 `SCHEMA_INVALID`，不能静默生效。

## 3. 下发文档包络

```json
{
  "schemaVersion": "1.0.0",
  "requestId": "req-01J2ABC",
  "formId": "travel-application",
  "revision": 4,
  "generatedAt": "2026-07-25T10:00:00Z",
  "expiresAt": "2026-07-25T11:00:00Z",
  "root": {
    "id": "travel-form",
    "type": "Form",
    "props": { "title": "差旅申请" },
    "children": []
  },
  "data": { "initialValues": {} },
  "actions": [],
  "dataSources": [],
  "rules": [],
  "meta": { "locale": "zh-CN", "traceId": "trace-01J2ABC" }
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `schemaVersion` | 是 | 精确协议版本；v1 为 `1.0.0`。 |
| `requestId` | 是 | 本次请求链路标识，原样回传到日志和响应。 |
| `formId` | 是 | 表单业务标识；一次渲染生命周期内稳定。 |
| `revision` | 是 | 正整数；用于防止旧页面提交覆盖新定义。 |
| `generatedAt` / `expiresAt` | 否 | RFC 3339 时间；过期文档必须重新请求。 |
| `root` | 是 | 唯一根节点，`type` 必须为 `Form`。 |
| `data.initialValues` | 是 | 表单完整初始数据对象。 |
| `actions` | 是 | action 定义；组件只用 `actionId` 引用。 |
| `dataSources` | 否 | 远程选项数据源定义。 |
| `rules` | 否 | 有限联动规则。 |
| `meta` | 否 | 非业务元信息；不得存放秘密、权限结论或执行指令。 |

## 4. 组件节点与数据绑定

每个节点都必须显式包含 `id`、`type`、`props`、`children`：

```ts
interface ComponentNode {
  id: string;
  type: ComponentType;
  props: Record<string, unknown>;
  children: ComponentNode[];
  dataPath?: `/${string}`;
  action?: { actionId: string; confirm?: ConfirmSpec };
  validation?: Validator[];
}
```

约束：

1. `id` 在一份文档内全局唯一，不能用数组序号或渲染时随机数生成。
2. `type` 必须来自 v1 组件目录。
3. `props` 只允许对应组件定义的字段；未知字段校验失败。
4. `children` 总是存在。叶子组件必须是 `[]`；容器可嵌套，但 `Form` 只能作为根节点。
5. 输入组件必须有绝对 JSON Pointer `dataPath`，例如 `/applicant/email`。不允许相对路径、`..`、通配符或数组查询表达式。
6. `dataPath` 指向 `data.initialValues` 中已存在的位置。空文本为 `""`，未选单值为 `null`，多选与上传为 `[]`，开关为布尔值。
7. action 组件通过 `action.actionId` 引用顶层定义，不能内嵌 URL 或脚本。
8. 隐藏或禁用字段不执行客户端校验；服务端仍按当前业务规则重新校验并决定是否接收其值。

## 5. 数据值约定

| 组件 | 数据值 |
| --- | --- |
| `TextInput` / `TextArea` | `string`；未填写为 `""` 或 `null`，一个表单内应统一。 |
| `NumberInput` | `number \| null`；不得以格式化字符串提交。 |
| `Select` / `RadioGroup` | `string \| number \| boolean \| null`，必须等于一个 option value。 |
| `CheckboxGroup` | 上述标量组成的数组，无重复值。 |
| `DatePicker` | `YYYY-MM-DD \| null`，不带时区。 |
| `Switch` | `boolean`。 |
| `Upload` | `UploadValue[]`，只保存服务端签发的文件引用。 |

```ts
interface UploadValue {
  fileId: string;
  name: string;
  size: number;
  mimeType: string;
  status: "uploaded";
}
```

提交前客户端复制完整表单数据，不只发送脏字段。服务端不得信任客户端的类型、枚举、文件属性或校验结果。

## 6. HTTP 契约

传输默认使用 UTF-8 JSON，`Content-Type: application/json`。鉴权由宿主应用处理，协议文档不携带 token。

### 6.1 请求表单

`POST /api/a2ui/v1/forms:resolve`

```json
{
  "schemaVersion": "1.0.0",
  "requestId": "req-resolve-001",
  "formKey": "travel-application",
  "context": { "conversationId": "conv-001" },
  "client": {
    "supportedSchemaVersions": ["1.0.0"],
    "supportedComponents": ["Form", "Section", "TextInput", "Button"],
    "locale": "zh-CN",
    "timeZone": "Asia/Shanghai"
  }
}
```

成功返回 HTTP `200` 和完整 `A2UIFormDocumentV1`。服务端必须在下发前用规范 Schema 验证文档，并校验 ID、引用和路径等 JSON Schema 无法表达的语义约束。

若客户端组件能力不足，返回 HTTP `422`、`status: "error"`、错误码 `CLIENT_CAPABILITY_MISMATCH`，而不是下发客户端无法完成的核心流程。

### 6.2 提交表单

`POST /api/a2ui/v1/forms/{formId}/submissions`

```json
{
  "schemaVersion": "1.0.0",
  "requestId": "req-submit-001",
  "idempotencyKey": "idem-submit-01J2ABC",
  "formId": "travel-application",
  "revision": 4,
  "action": {
    "actionId": "submit-trip",
    "sourceComponentId": "trip-submit-button"
  },
  "data": {
    "destination": { "countryCode": "CN", "cityId": "sha" }
  },
  "client": { "locale": "zh-CN", "timeZone": "Asia/Shanghai" }
}
```

提交规则：

- path 中的 `{formId}` 必须与 body 一致；
- `idempotencyKey` 必填，由客户端为一次逻辑提交生成；`requestId` 只用于追踪，重试时可以变化；
- `actionId` 必须存在且类型为 `submit`，`sourceComponentId` 必须引用绑定该 action 的组件；
- `revision` 必须仍有效；
- 服务端重新执行类型、枚举、字段和业务校验；
- 日志至少包含 `requestId`、`formId`、`revision`、认证主体和结果码，但不记录敏感字段原文。

### 6.3 成功响应

```json
{
  "schemaVersion": "1.0.0",
  "requestId": "req-submit-001",
  "formId": "travel-application",
  "status": "success",
  "result": {
    "submissionId": "submission-01J2ABC",
    "message": "提交成功"
  }
}
```

`result` 与 `result.submissionId` 均为必填。同一幂等提交的成功回放必须返回首次提交相同的 `submissionId` 和 JSON 深度等价的 `result`；允许使用新的 `requestId` 回显本次重试链路。

### 6.4 字段错误响应

字段校验失败返回 HTTP `422`：

```json
{
  "schemaVersion": "1.0.0",
  "requestId": "req-submit-001",
  "formId": "travel-application",
  "status": "validation_error",
  "fieldErrors": {
    "/destination/cityId": [
      {
        "code": "CITY_NOT_AVAILABLE",
        "message": "所选城市当前不可用",
        "componentId": "remote-city"
      }
    ]
  },
  "errors": []
}
```

`fieldErrors` 的 key 必须是提交数据的绝对 JSON Pointer。客户端按 `dataPath` 映射到字段，聚焦首个可见错误，并在表单顶部提供错误摘要。无法映射的字段错误仍放入摘要，不得丢弃。

### 6.5 resolve 错误响应

resolve 尚未产生 `formId`，因此使用独立包络，并以请求中的 `formKey` 关联：

```json
{
  "schemaVersion": "1.0.0",
  "requestId": "req-resolve-001",
  "formKey": "travel-application",
  "status": "error",
  "errors": [
    {
      "code": "CLIENT_CAPABILITY_MISMATCH",
      "message": "客户端不支持完成该任务所需的组件",
      "retryable": false
    }
  ]
}
```

该包络用于 resolve 的所有非成功响应，不得填充虚构 `formId`，也不得复用 submit 通用错误模型。

## 7. 错误包络与状态码

submit 的非字段错误统一为：

```json
{
  "schemaVersion": "1.0.0",
  "requestId": "req-001",
  "formId": "travel-application",
  "status": "error",
  "errors": [
    {
      "code": "FORM_REVISION_CONFLICT",
      "message": "表单已更新，请重新加载",
      "retryable": true
    }
  ]
}
```

| HTTP | 典型错误码 |
| --- | --- |
| `400` | `REQUEST_INVALID`、`SCHEMA_INVALID` |
| `401` / `403` | `UNAUTHENTICATED`、`FORBIDDEN` |
| `404` | `FORM_NOT_FOUND`、`ENDPOINT_NOT_FOUND` |
| `409` | `FORM_REVISION_CONFLICT`、`IDEMPOTENCY_CONFLICT`、`SUBMISSION_IN_PROGRESS` |
| `422` | `VALIDATION_FAILED`、`CLIENT_CAPABILITY_MISMATCH` |
| `429` | `RATE_LIMITED` |
| `500` / `503` | `INTERNAL_ERROR`、`DEPENDENCY_UNAVAILABLE` |

## 8. 解析、渲染与提交顺序

1. 校验 JSON 可解析、大小在宿主限制内。
2. 校验 `schemaVersion` 是否被客户端明确支持。
3. 按规范 JSON Schema 校验结构。
4. 校验组件 ID、action/dataSource 引用、dataPath、规则目标和循环依赖。
5. 构建初始数据，再计算一次联动状态。
6. 渲染组件并绑定字段；单个非关键子组件失败时显示降级占位。
7. 用户编辑时仅执行匹配 `sourceDataPath` 的白名单规则，然后执行可见且启用字段的同步校验。
8. 触发 submit 时先做客户端校验，为逻辑提交创建 `idempotencyKey`，再提交完整数据；安全重试复用该 key，服务端是最终裁决者。
9. 服务端先原子登记幂等键和规范化请求指纹，再执行写入并持久化可回放结果；具体规则见 `validation-and-actions-v1.md`。
10. 将字段错误按 JSON Pointer 映射回组件；通用错误显示在 Form 错误摘要。

## 9. 完整性约束

JSON Schema 之外，生产者和消费者都必须检查：

- 组件、action、dataSource、rule 的 ID 各自在其命名空间内唯一；
- 所有组件 action 引用存在且类型适配（`Upload` 只能引用 `upload`）；
- 所有远程 Select 的 `dataSourceId` 存在；
- 所有字段 `dataPath` 在 `initialValues` 中可解析；
- rule 的 source/condition/target path 与目标组件存在；
- `setValue` 规则依赖图无环，同一次 change 事件每条规则最多执行一次；
- `expiresAt` 晚于 `generatedAt`；
- 同一字段不能声明互相矛盾的上下限或长度限制。

任何一项失败都产生结构化错误，且不得执行 action 或远程数据源。
