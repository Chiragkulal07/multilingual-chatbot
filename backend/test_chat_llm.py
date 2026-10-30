import traceback

from google import genai
from google.genai import types
from pydantic import BaseModel

from app.config import GEMINI_API_KEY, GEMINI_MODEL
from app.llm import SYSTEM_INSTRUCTION, AnswerSchema, build_prompt

print("Model:", GEMINI_MODEL)

chunks = [
    {
        "filename": "image.png",
        "page_number": 1,
        "text": "It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness...",
    }
]
prompt = build_prompt("What was the age of wisdom?", chunks)

client = genai.Client(api_key=GEMINI_API_KEY, http_options=types.HttpOptions(timeout=60_000))

def attempt(label, config):
    print(f"\n--- {label} ---")
    try:
        r = client.models.generate_content(model=GEMINI_MODEL, contents=prompt, config=config)
        print("RAW TEXT:", repr(r.text))
        print("FINISH:", r.candidates[0].finish_reason if r.candidates else "no candidates")
    except Exception:
        traceback.print_exc()

attempt(
    "A: with JSON schema (what the app does)",
    types.GenerateContentConfig(
        system_instruction=SYSTEM_INSTRUCTION,
        temperature=0.2,
        response_mime_type="application/json",
        response_schema=AnswerSchema,
    ),
)
attempt(
    "B: plain text, no schema",
    types.GenerateContentConfig(system_instruction=SYSTEM_INSTRUCTION, temperature=0.2),
)