from app.chunking import chunk_pages

sentences = [
    f"This is sentence number {i} about retrieval augmented generation and how chunking works."
    for i in range(1, 81)
]
# 10 paragraphs of 8 sentences each, with OCR-style line breaks inside them
paragraphs = [" ".join(sentences[i:i + 8]).replace(". This", ".\nThis", 3) for i in range(0, 80, 8)]
long_page = {"page_number": 1, "text": "\n\n".join(paragraphs)}
short_page = {"page_number": 2, "text": "It was the best of\ntimes, it was the worst\nof times."}

chunks = chunk_pages("file_test", [long_page, short_page])

for c in chunks:
    t = c["text"]
    print(f"{c['chunk_id']} | page {c['page_number']} | {c['token_count']} tokens")
    print(f"   starts: {t[:70]!r}")
    print(f"   ends:   {t[-70:]!r}")

print(f"\nTotal chunks: {len(chunks)}")
print("Max tokens in any chunk:", max(c["token_count"] for c in chunks))