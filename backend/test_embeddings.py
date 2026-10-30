from app.embeddings import embed_query, embed_texts

chunks = [
    "Retrieval-Augmented Generation combines information retrieval with text generation.",
    "The retriever finds relevant documents. The language model uses retrieved information to formulate an answer.",
    "Python is a popular programming language for data science.",
    "The capital of France is Paris, known for the Eiffel Tower.",
    "Photosynthesis converts sunlight into chemical energy in plants.",
]
questions = [
    "How does RAG produce an answer?",
    "Which city is the Eiffel Tower in?",
    "How do plants make energy?",
]

vectors = embed_texts(chunks)
print("Shape:", vectors.shape, "| first vector length (should be ~1.0):",
      round(float((vectors[0] ** 2).sum() ** 0.5), 3))

for q in questions:
    scores = vectors @ embed_query(q)[0]   # cosine similarity (vectors are normalized)
    order = scores.argsort()[::-1]
    print(f"\nQ: {q}")
    for i in order[:3]:
        print(f"   {scores[i]:.3f}  {chunks[i][:70]}")