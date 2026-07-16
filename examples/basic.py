"""示例：出行规划助手

用法：
    PYTHONPATH="" uv run python examples/basic.py               # 使用 .env
    PYTHONPATH="" uv run python examples/basic.py deepseek      # 使用 profiles.yaml
"""

from dotenv import load_dotenv
load_dotenv()

import sys
from agent_core import ToolRegistry, run

registry = ToolRegistry()


# ── 工具 1：城市间距离 ────────────────────────────────

CITY_DISTANCE = {
    ("北京", "上海"): 1213,
    ("北京", "杭州"): 1270,
    ("北京", "广州"): 2137,
    ("上海", "杭州"): 176,
    ("上海", "南京"): 300,
    ("广州", "深圳"): 136,
    ("成都", "重庆"): 309,
    ("成都", "西安"): 742,
}


@registry.register(description="查询两个城市之间的驾车距离（公里）")
def get_distance(from_city: str, to_city: str) -> str:
    key = (from_city, to_city)
    reverse = (to_city, from_city)
    if key in CITY_DISTANCE:
        dist = CITY_DISTANCE[key]
    elif reverse in CITY_DISTANCE:
        dist = CITY_DISTANCE[reverse]
    else:
        dist = 500
    return f"{from_city} 到 {to_city} 驾车距离约 {dist} 公里"


# ── 工具 2：计算 ──────────────────────────────────────


@registry.register(description="计算数学表达式，支持加减乘除和小数")
def calculate(expression: str) -> str:
    allowed = set("0123456789+-*/().^ ")
    if not all(c in allowed for c in expression):
        return f"表达式包含不允许的字符：{expression}"
    expr = expression.replace("^", "**")
    try:
        result = eval(expr, {"__builtins__": {}})
        return str(result)
    except Exception as e:
        return f"计算出错：{e}"


# ── 运行 ──────────────────────────────────────────────

if __name__ == "__main__":
    profile = sys.argv[1] if len(sys.argv) > 1 else None
    result = run(
        prompt=(
            "我打算从北京自驾去上海，帮我算几件事：\n"
            "1. 两地距离多少公里？\n"
            "2. 如果平均时速 100 公里，要开多久？\n"
            "3. 如果每公里油费 0.7 元，总油费多少？"
        ),
        registry=registry,
        profile=profile,
        system="你是一个出行规划助手。使用中文回答。遇到需要计算的地方用 calculate 工具。回答简洁实用。",
        resume=False,
    )
    print(f"\n{'='*60}")
    print(f"最终回答：\n{result}")
