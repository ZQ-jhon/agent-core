# A2UI Form Profile v1 组件目录

本目录是 `schemaVersion: "1.0.0"` 唯一允许的组件集合。组件名区分大小写；未列出的 prop 一律非法。

组件齐全不代表每次都应下发全量表单。Agent/服务端生产者应按当前任务选择最小组件树：单字段修改只下发该字段，条件化补全用 `rules` 控制必要字段，申请/预约只保留完成动作所需输入。可编辑字段超过 7 个时优先拆分任务；这一产品策略不编码为组件 prop，也不由 renderer 推断。

## 1. 通用约定

所有节点必须包含：

- `id`：文档内全局唯一且跨 revision 稳定；
- `type`：本目录中的组件名；
- `props`：组件专属属性对象；
- `children`：容器为子节点数组，叶子组件固定 `[]`。

所有输入组件必须提供 `dataPath`。其通用 props 为：

| 属性 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `label` | `string` | 无，必填 | 可见标签，不得只用 placeholder 代替。 |
| `helpText` | `string` | 无 | 标签后的辅助说明。 |
| `disabled` | `boolean` | `false` | 禁用后不允许编辑，不执行客户端字段校验。 |
| `visible` | `boolean` | `true` | `false` 时不占布局、不聚焦、不执行客户端字段校验。 |

通用无障碍要求：

1. label、help、错误信息通过稳定 DOM id 与控件的 `for`、`aria-describedby`、`aria-errormessage` 关联。
2. 必填状态同时以文本和 `aria-required` 表示，不能只用颜色或星号。
3. 错误出现时设置 `aria-invalid`；提交失败后聚焦错误摘要，摘要包含指向字段的链接。
4. 键盘焦点顺序按文档树顺序，不允许 Schema 自定义 `tabIndex`。
5. 隐藏节点从辅助技术树移除；禁用节点使用原生 `disabled` 语义。
6. 颜色、字号、间距和焦点样式由宿主设计系统控制，Schema 不下发任意 CSS。

## 2. 容器组件

### Form

唯一根节点，负责表单上下文、错误摘要和提交状态。

| prop | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `title` | `string` | 无 | 表单主标题。 |
| `description` | `string` | 无 | 简短说明。 |
| `submitOnEnter` | `boolean` | `false` | 仅在没有多行文本焦点且 submit action 唯一时生效。 |

数据模型：无 `dataPath`；使用文档级 `data.initialValues`。  
children：至少一个；只允许非 `Form` 节点。  
无障碍：渲染为原生 `<form>`；title 成为可感知名称；错误摘要使用 `role="alert"` 或等价的礼貌播报策略。

### Section

对相关字段进行语义分组。

| prop | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `title` | `string` | 无，必填 | 分组标题。 |
| `description` | `string` | 无 | 分组说明。 |
| `collapsible` | `boolean` | `false` | 是否允许折叠。 |
| `defaultCollapsed` | `boolean` | `false` | 初始折叠状态；仅 `collapsible=true` 时有效。 |
| `visible` | `boolean` | `true` | 是否显示整个分组。 |

数据模型：无。  
children：任意非 `Form` 节点。  
无障碍：优先使用 `<fieldset>` + `<legend>`；折叠按钮提供 `aria-expanded` 和 `aria-controls`。

## 3. 文本与数值输入

### TextInput

数据：`string | null`。

| 专属 prop | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `placeholder` | `string` | 无 | 示例或输入提示，不代替 label。 |
| `autoComplete` | `string` | 无 | 浏览器标准 autocomplete token；renderer 做白名单。 |
| `inputMode` | `text \| email \| tel \| url \| search` | `text` | 软键盘/输入提示，不替代校验。 |
| `readOnly` | `boolean` | `false` | 可聚焦但不可编辑；值仍参与提交。 |

children：`[]`。  
无障碍：使用与 `inputMode` 对应的原生输入语义；格式错误不能只靠 `type=email`。

### TextArea

数据：`string | null`。

| 专属 prop | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `placeholder` | `string` | 无 | 输入提示。 |
| `rows` | `2..20` | `4` | 初始可见行数。 |
| `maxRows` | `2..40` | 无 | 自动增长上限；不得小于 `rows`。 |

children：`[]`。  
无障碍：保留换行；若显示剩余字符数，使用非打断式 live region。

### NumberInput

数据：`number | null`。中间编辑态可在客户端保存为字符串，但提交和联动计算前必须归一化为 number 或 null。

| 专属 prop | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `placeholder` | `string` | 无 | 输入提示。 |
| `step` | 正数 | `1` | 步进提示；是否为整数由 validator 决定。 |
| `unit` | `string` | 无 | 可见单位，不进入提交值。 |

children：`[]`。  
无障碍：单位加入可感知说明；不要阻止用户输入负号/小数点的中间态，错误在 blur/提交时提示。

## 4. 选择组件

`Option` 结构为 `{ label, value, disabled? }`，`value` 只能是 string、number 或 boolean，同一选项集合内类型应一致且值唯一。

### Select

数据：单个 option value 或 `null`。v1 不支持多选 Select，多选使用 CheckboxGroup。

| 专属 prop | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `placeholder` | `string` | 无 | 未选择时提示。 |
| `clearable` | `boolean` | `true` | 是否允许恢复为 null。 |
| `options` | `Option[]` | 与 dataSource 二选一 | 静态选项。 |
| `dataSourceId` | `string` | 与 options 二选一 | 引用远程选项数据源。 |

children：`[]`。  
无障碍：优先原生 select；自定义 combobox 必须实现完整键盘、`aria-activedescendant`、loading/empty/error 状态。

### RadioGroup

数据：单个 option value 或 `null`。

| 专属 prop | 类型 | 默认值 |
| --- | --- | --- |
| `options` | `Option[]` | 无，必填 |
| `orientation` | `horizontal \| vertical` | `vertical` |

children：`[]`。  
无障碍：使用 fieldset/legend 或 `role="radiogroup"`；方向不改变方向键语义。

### CheckboxGroup

数据：不重复的 option value 数组；`initialValues` 必须显式提供，推荐初始值 `[]`。

| 专属 prop | 类型 | 默认值 |
| --- | --- | --- |
| `options` | `Option[]` | 无，必填 |
| `orientation` | `horizontal \| vertical` | `vertical` |

children：`[]`。  
无障碍：每项有独立 label，整组有 legend；组级错误关联到组容器。

## 5. 日期与布尔组件

### DatePicker

数据：`YYYY-MM-DD | null`。日期是本地日历日，不做 UTC 换算。

| 专属 prop | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `placeholder` | `string` | 无 | 日期输入提示。 |
| `minDate` | `YYYY-MM-DD` | 无 | 可选最早日期。 |
| `maxDate` | `YYYY-MM-DD` | 无 | 可选最晚日期。 |

children：`[]`。  
无障碍：必须允许键盘输入和操作；显示格式可本地化，但提交值固定 ISO 日期。

### Switch

数据：`boolean`；`initialValues` 必须显式提供，推荐初始值 `false`。

| 专属 prop | 类型 | 默认值 |
| --- | --- | --- |
| `onLabel` | `string` | 无 |
| `offLabel` | `string` | 无 |

children：`[]`。  
无障碍：使用 checkbox 或 `role="switch"`，始终暴露当前 checked 状态；label 描述设置本身而不是“是/否”。

## 6. 文件上传

### Upload

数据：上传完成后的 `UploadValue[]`；`initialValues` 必须显式提供，推荐初始值 `[]`。本地 `File`、base64 内容和临时 object URL 不进入表单数据。

| 专属 prop | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `accept` | `string[]` | 空数组 | MIME type 或扩展名提示；服务端仍校验真实类型。 |
| `maxFiles` | `1..20` | `1` | 客户端上限，不能放宽服务端策略。 |
| `maxSizeBytes` | 正整数 | 宿主策略 | 单文件提示上限，不能放宽服务端策略。 |
| `buttonLabel` | `string` | `选择文件` | 上传按钮文本。 |

必须提供 `action` 且引用 `type: "upload"` 的 action。children 为 `[]`。

无障碍：按钮可通过键盘触发；上传进度可感知；失败项给出重试/移除操作；删除已上传文件必须显式更新数据值。

安全：前端 `accept` 不是安全边界。服务端校验大小、内容类型、恶意文件和文件所有权，并只返回不可猜测的 `fileId`。

## 7. 操作与内容组件

### Button

| prop | 类型 | 默认值 |
| --- | --- | --- |
| `label` | `string` | 无，必填 |
| `variant` | `primary \| secondary \| danger \| text` | `secondary` |
| `loadingLabel` | `string` | 原 label |
| `disabled` | `boolean` | `false` |
| `visible` | `boolean` | `true` |

必须提供 `action`；children 为 `[]`。同一 Form 建议最多一个 primary submit。

无障碍：使用原生 button；提交中设置 `aria-busy` 并防止重复触发，但不要让焦点无故消失。

### Alert

| prop | 类型 | 默认值 |
| --- | --- | --- |
| `title` | `string` | 无 |
| `message` | `string` | 无，必填 |
| `variant` | `info \| success \| warning \| error` | `info` |
| `dismissible` | `boolean` | `false` |
| `visible` | `boolean` | `true` |

无数据、无 action、children 为 `[]`。  
无障碍：动态 error/success 使用合适 live region；静态提示不应每次重渲染都重复播报。

### Markdown

| prop | 类型 | 默认值 |
| --- | --- | --- |
| `content` | `string`，最多 20,000 字符 | 无，必填 |
| `ariaLabel` | `string` | 无 |
| `visible` | `boolean` | `true` |

无数据、无 action、children 为 `[]`。

仅支持段落、标题、列表、强调、行内代码和链接。禁用原始 HTML、图片、iframe、事件属性和 `javascript:`/`data:` URL；渲染器必须在 Markdown 解析后再次净化 DOM。链接默认仅允许 `https:`、`http:`、`mailto:`，外链按宿主策略添加安全属性。

## 8. 默认值应用规则

1. 文档中的显式 prop 优先于本目录默认值。
2. renderer 在内存中应用默认值，不回写或篡改原始文档。
3. 数据默认值只来自 `data.initialValues`，不能从 placeholder、option 第一项或组件目录猜测。
4. 若必需数据路径缺失，文档整体为 `SCHEMA_SEMANTIC_INVALID`；renderer 不自行创建路径。
5. 同一文档在不同 renderer 上应用默认值后的行为必须一致，视觉呈现可由宿主设计系统决定。
