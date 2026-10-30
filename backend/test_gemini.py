import os
import sys
import time

from dotenv import load_dotenv
from google import genai
from google.genai import types

load_dotenv()
key = os.getenv("GEMINI_API_KEY")
if not key:
    sys.exit("GEMINI_API_KEY is missing. Check backend\\.env")

client = genai.Client(api_key=key, http_options=types.HttpOptions(timeout=60_000))  # 60 s

CANDIDATES = [
    "gemini-3.8-flash",
    "gemini-3.5-flash-lite",
    "gemini-flash-latest",
    "gemini-2.5-flash",
]

models = sys.argv[1:] or CANDIDATES
for model in models:
    start = time.time()
    try:
        response = client.models.generate_content(
            model=model, contents="Reply with exactly: RAG test OK"
        )
        print(f"OK    {model:28} {time.time() - start:4.1f}s  -> {response.text.strip()}")
    except Exception as e:
        msg = str(e).replace("\n", " ")[:140]
        print(f"FAIL  {model:28} {time.time() - start:4.1f}s  {type(e).__name__}: {msg}")