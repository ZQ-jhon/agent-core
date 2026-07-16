"""示例：可以向用户提问的 Agent

To run:
    PYTHONPATH="" uv run python examples/interactive.py
"""

from dotenv import load_dotenv
load_dotenv()

from agent_core import ToolRegistry, run

registry = ToolRegistry()


# ── 工具 1：城市间距离 ──────────────────────────────────────

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
        return f"未找到 {from_city} 到 {to_city} 的距离数据"
    return f"{from_city} 到 {to_city} 驾车距离约 {dist} 公里"


# ── 工具 2：计算 ──────────────────────────────────────────


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


# ── 工具 3：向用户提问 ────────────────────────────────────


@registry.register(description="当你缺少关键信息、需要用户确认或做选择时，调用此工具向用户提问")
def ask_user(question: str) -> str:
    """向用户提问并等待回答"""
    print(f"\n🤔 Agent 提问：{question}")
    answer = input("> ")
    return answer


# ── 运行 ───────────────────────────────────────────────────

if __name__ == "__main__":
    result = run(
        prompt="我想自驾出去玩几天，帮我做个出行计划。先查一下两个城市之间的距离再算费用。",
        registry=registry,
        system=(
            "你是一个出行规划助手。使用中文回答。"
            "规划出行前必须确认以下信息（如果不清楚就用 ask_user 工具询问）：\n"
            "1. 出发城市和目的地\n"
            "2. 车辆每公里油费\n"
            "3. 计划开几天\n"
            "信息不全时不要猜测，必须向用户确认。"
            "回答简洁实用。"
        ),
        resume=False,
    )
    print(f"\n{'='*60}")
    print(f"最终回答：\n{result}")
