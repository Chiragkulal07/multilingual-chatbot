import re

import tiktoken
from langchain_text_splitters import RecursiveCharacterTextSplitter

from app.config import CHUNK_OVERLAP_TOKENS, CHUNK_SIZE_TOKENS

_encoding = tiktoken.get_encoding("cl100k_base")

# Tries paragraph breaks first, then sentence ends, then any whitespace,
# and only cuts mid-word as a last resort.
_splitter = RecursiveCharacterTextSplitter.from_tiktoken_encoder(
    encoding_name="cl100k_base",
    chunk_size=CHUNK_SIZE_TOKENS,
    chunk_overlap=CHUNK_OVERLAP_TOKENS,
    separators=[r"\n\n", r"(?<=[.!?])\s+", r"\s+", ""],
    is_separator_regex=True,
    keep_separator=True,
)


def count_tokens(text: str) -> int:
    return len(_encoding.encode(text))


def prepare_text(text: str) -> str:
    """
    OCR and PDF extraction put a line break at the end of every visual line,
    even mid-sentence. Turn single line breaks into spaces and keep blank
    lines as paragraph breaks.
    """
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"(?<!\n)\n(?!\n)", " ", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def chunk_pages(file_id: str, pages: list[dict]) -> list[dict]:
    """
    pages: [{"page_number": int, "text": str, ...}]
    Returns chunk records. Each page is chunked separately so every chunk
    keeps its page number for citations.
    """
    chunks = []
    index = 0
    for page in sorted(pages, key=lambda p: p["page_number"]):
        text = prepare_text(page["text"])
        if not text:
            continue
        for piece in _splitter.split_text(text):
            piece = piece.strip()
            if not piece:
                continue
            chunks.append(
                {
                    "chunk_id": f"{file_id}_chunk_{index:04d}",
                    "file_id": file_id,
                    "page_number": page["page_number"],
                    "chunk_index": index,
                    "text": piece,
                    "token_count": count_tokens(piece),
                }
            )
            index += 1
    return chunks