import sys
from pathlib import Path

from app.extraction import extract_file

path = Path(sys.argv[1])
suffix = path.suffix.lower()
file_type = "pdf" if suffix == ".pdf" else "png" if suffix == ".png" else "jpeg"

pages = extract_file(path, file_type)

for p in pages:
    print("=" * 60)
    print(f"Page {p['page_number']} | method: {p['method']} | confidence: {p['confidence']}")
    print("-" * 60)
    print(p["text"] or "(no text found)")