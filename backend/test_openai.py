import os

from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()  # reads backend/.env, so you don't need to set the key by hand

client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
model = os.getenv("OPENAI_LLM_MODEL", "gpt-6-luna")

# Chat test
r = client.chat.completions.create(
    model=model,
    messages=[{"role": "user", "content": 'Reply with a JSON object like {"ok": true}'}],
    response_format={"type": "json_object"},
    max_completion_tokens=4096,
)
print("CHAT OK:", model, "->", r.choices[0].message.content)

# Embedding test
e = client.embeddings.create(model="text-embedding-3-small", input=["hello"], dimensions=768)
print("EMBEDDING OK: vector size =", len(e.data[0].embedding))