# agent-core

**一个不到 70 行的 Agent 核心循环。不依赖任何框架，只用 Python。**  
每条代码你都能看懂，每个步骤你都能 print 出来调试。

---

## 这是什么

如果你用过 ChatGPT，你知道你问一句它答一句。Agent 的区别在于：**它能自己调用工具**。

比如你问「帮我查一下今天的天气，如果是晴天就帮我创建明天的晨跑日历」，Agent 会：
1. 调用天气查询工具 → 知道是晴天
2. 调用日历工具 → 创建事件
3. 把结果告诉你

这个项目就是那根让模型能自己调工具的「骨架」。它只有 70 行核心代码，剩下的全是注释和例子。

---

## 前置条件

你电脑上要有 **Python 3.10 或以上**。检查方法：

```bash
python --version
# 输出类似 Python 3.11.x 就对了
```

如果没有，去 [python.org](https://python.org) 下载安装。

还需要 **uv**（Python 包管理器）：

```bash
# Windows (PowerShell)
powershell -c "irm https://astral.sh/uv/install.ps1 | iex"

# 装完重启终端，然后验证
uv --version
```

---

## 5 分钟跑起来

### 1. 进入项目目录

```bash
cd D:\project\agent-core
```

### 2. 配置大模型

项目支持**同时配置多家大模型**，一键切换。推荐用 `profiles.yaml`：

**方式一：profiles.yaml（推荐，支持多 provider）**

```bash
copy profiles.example.yaml profiles.yaml
```

打开 `profiles.yaml`，填上你要用的 key：

```yaml
deepseek:                           # ← 这是 profile 名，随便取
  base_url: https://api.deepseek.com/v1
  api_key: sk-你的key
  model: deepseek-chat

openai:                             # ← 公司如果有 OpenAI key 也可以加
  base_url: https://api.openai.com/v1
  api_key: sk-你的key
  model: gpt-4o
```

文件里可以放任意多个 provider，互不影响。`profiles.yaml` 已加入 `.gitignore`，不会提交到仓库。

**方式二：.env（简单场景，单 provider）**

```bash
copy .env.example .env
```

打开 `.env`，填入：

```bash
OPENAI_BASE_URL=https://api.deepseek.com/v1
OPENAI_API_KEY=sk-你的key
OPENAI_MODEL=deepseek-chat
```

### 3. 安装依赖

```bash
uv sync
```

这一步会自动安装 `openai` 和 `pydantic` 两个依赖包，大约 10 秒。

### 4. 运行

```bash
# 用 profiles.yaml（推荐）
PYTHONPATH="" uv run python examples/basic.py deepseek

# 或者用 .env
PYTHONPATH="" uv run python examples/basic.py
```

---

## 怎么用（从简单到复杂）

### 场景 1：加上你自己的工具

打开 `examples/basic.py`，在 `registry` 下面加：

```python
@registry.register(description="获取当前时间")
def get_current_time() -> str:
    from datetime import datetime
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")
```

不需要写 JSON Schema —— 装饰器会从函数签名自动生成。`description` 里的文字会告诉模型这个工具是干什么的。

然后改 prompt：

```python
result = run(
    prompt="现在几点了？",
    registry=registry,
)
```

### 场景 2：接你自己的业务系统

```python
@registry.register(description="查询用户订单状态")
def query_order(order_id: str) -> str:
    # 这里调你自己的数据库或 API
    orders = {"ORD001": "已发货", "ORD002": "待支付"}
    return orders.get(order_id, "未找到该订单")
```

Agent 会自动判断什么时候该调这个工具。

### 场景 3：从中断处恢复

Agent 每一步都会自动保存到 `checkpoints/` 目录。如果中途挂了：

```python
result = run(
    prompt="...",
    registry=registry,
    resume=True,  # ← 从上次断点继续
)
```

---

## 多 Provider 切换

项目支持同时配置多家大模型，一个命令就能切换。**不需要改代码，不需要改环境变量。**

### 三种指定方式（优先级从高到低）

```
命令行 --profile  >  环境变量 AGENT_PROFILE  >  .env 文件
```

### 用法

```bash
# 方式 1：命令行指定（最灵活）
PYTHONPATH="" uv run python examples/basic.py deepseek
PYTHONPATH="" uv run python examples/basic.py openai
PYTHONPATH="" uv run python examples/repl.py ollama

# 方式 2：环境变量（一次设置，整个终端窗口生效）
export AGENT_PROFILE=deepseek
PYTHONPATH="" uv run python examples/repl.py

# 方式 3：不指定，自动用 .env（向后兼容）
PYTHONPATH="" uv run python examples/basic.py
```

### 怎么添加新 provider

编辑 `profiles.yaml`，加一个条目即可：

```yaml
# 你家用的
deepseek:
  base_url: https://api.deepseek.com/v1
  api_key: sk-xxx
  model: deepseek-chat

# 公司用的
openai:
  base_url: https://api.openai.com/v1
  api_key: sk-xxx
  model: gpt-4o

# 本地跑的
ollama:
  base_url: http://localhost:11434/v1
  api_key: ollama
  model: qwen2.5:7b
```

### 内置模板（profiles.example.yaml）

| profile 名 | 供应商 | 说明 |
|-----------|--------|------|
| `deepseek` | DeepSeek | 性价比高，中文好 |
| `openai` | OpenAI | 质量最高 |
| `siliconflow` | 硅基流动 | 国内聚合平台 |
| `openrouter` | OpenRouter | 海外聚合，一个 key 调所有 |
| `groq` | Groq | LPU 推理，速度极快 |
| `qwen` | 通义千问 | 阿里云 |
| `glm` | 智谱 GLM | 中文能力强 |
| `ollama` | Ollama | 免费，本地跑，数据不出本机 |

---

## 项目结构 —— 每个文件干什么

```
agent-core/
├── pyproject.toml              # 项目配置
├── profiles.example.yaml       # 多 provider 模板，复制为 profiles.yaml 使用
├── .env.example                # 单 provider 模板
├── .gitignore
│
├── src/agent_core/
│   ├── core.py                 # ★ 主角 —— agent 循环，~70 行
│   ├── config.py               # provider 配置加载
│   ├── tools.py                # 工具注册器
│   ├── checkpoint.py           # 进度保存（JSON 文件）
│   └── types.py                # 数据类型
│
├── examples/
│   ├── basic.py                # 单次出行规划
│   ├── repl.py                 # 持续对话 REPL
│   └── interactive.py          # 带 ask_user 的交互式 Agent
│
└── tests/
    └── test_agent.py           # 自动化测试
```

### 核心循环图解

```
用户提问
    ↓
┌─────────────────────────────┐
│  while 还没结束:             │
│                              │
│  ① 把当前消息发给模型         │
│  ② 模型回复："我要调工具X"    │
│  ③ 执行工具X，拿到结果        │
│  ④ 保存进度到 checkpoints/   │
│  ⑤ 把结果追加到消息列表       │
│  ⑥ 回到①                    │
│                              │
│  …或者模型回复："结束了"      │
└─────────────────────────────┘
    ↓
返回最终答案
```

### core.py 对照阅读

如果你看 `src/agent_core/core.py`，整个 agent 循环就是这一段：

```python
while state.step < max_steps:           # 防止死循环
    response = client.chat.completions.create(
        model=model,
        messages=[...],                  # 聊天记录
        tools=tools,                     # 可用工具列表
    )

    if finish_reason == "stop":          # 模型说完了
        return content

    if tool_calls:                       # 模型要调工具
        result = registry.execute(...)    # 执行工具
        messages.append(result)           # 把结果告诉模型
        save_checkpoint(state)            # 存档
        continue                          # 继续循环
```

---

## 常见问题

### Q: 运行报 `PYTHONPATH` 相关错误？
A: 命令前加 `PYTHONPATH=""`。这是本机 Hermes 的环境变量冲突，不影响项目本身。

### Q: 运行报 API 连接错误？
A: 检查三件事：
1. `.env` 文件是否存在
2. `OPENAI_API_KEY` 是否正确
3. 是否需要代理（如果在本机，确认 Clash 开着）

### Q: 怎么切换大模型？
A: 三种方式——
```bash
# 临时切换：命令行加 profile 名
PYTHONPATH="" uv run python examples/repl.py openai

# 固定切换：设置环境变量
export AGENT_PROFILE=openai

# 或者直接在 .env 里改 OPENAI_MODEL
```

### Q: 怎么添加新的 provider？
A: 编辑 `profiles.yaml`，加一个条目，写清 `base_url`、`api_key`、`model` 三个字段即可。所有兼容 OpenAI 接口的都能用。

### Q: Agent 卡住了怎么办？
A: 默认最多跑 20 步自动停止。如果你想改，在 `run()` 里传 `max_steps=50`。

### Q: 项目需要 Python 基础吗？
A: 用的话不需要 —— 改 `.env` 和 `examples/basic.py` 里的工具就行。看源码的话，70 行核心代码，有 TypeScript/JavaScript 基础足够看懂。

---

## 运行测试

```bash
PYTHONPATH="" uv run pytest tests/ -v
```

当前 8 个测试全部通过。

---

## 技术选型说明

本项目故意**不用**任何 Agent 框架（LangChain、CrewAI、Mastra 等），原因：

| 框架方式的代价 | 原生方式的好处 |
|---------------|---------------|
| 出问题要翻框架源码 | 出问题就 70 行，一眼定位 |
| 框架升级可能 breaking | 依赖只有 openai + pydantic，十年不变 |
| 新人要学框架概念（Graph/Node/Edge） | 新人只需要看懂 while + if |
| 框架绑定特定生态 | 换模型 = 改环境变量 |
