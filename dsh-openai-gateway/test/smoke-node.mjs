import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.DSH_OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL ?? "http://127.0.0.1:3080/v1",
});

const completion = await client.chat.completions.create({
  model: "auto-tier",
  messages: [{ role: "user", content: "Call get_temperature for Chicago." }],
  tools: [{
    type: "function",
    function: {
      name: "get_temperature",
      description: "Get the current temperature for a city",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  }],
});

console.log(JSON.stringify(completion, null, 2));
