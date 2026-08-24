import os

from openai import OpenAI


client = OpenAI(
    api_key=os.environ["DSH_OPENAI_API_KEY"],
    base_url=os.getenv("OPENAI_BASE_URL", "http://127.0.0.1:3080/v1"),
)

completion = client.chat.completions.create(
    model="auto-tier",
    messages=[{"role": "user", "content": "Call get_temperature for Chicago."}],
    tools=[{
        "type": "function",
        "function": {
            "name": "get_temperature",
            "description": "Get the current temperature for a city",
            "parameters": {
                "type": "object",
                "properties": {"city": {"type": "string"}},
                "required": ["city"],
            },
        },
    }],
)

print(completion.model_dump_json(indent=2))
