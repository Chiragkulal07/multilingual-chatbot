import { useState } from "react";
import { searchChunks } from "../api";

const QUICK_TEST_QUERIES = [
  "invoice total amount",
  "registration number",
  "terms and conditions",
  "date of transaction",
];

export default function SearchTest({ onSelectFile }) {
  const [query, setQuery] = useState("");
  const [k, setK] = useState(5);
  const [results, setResults] = useState(null);
  const [searchedFor, setSearchedFor] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const runSearch = async (overrideQ) => {
    const q = (overrideQ || query).trim();
    if (!q || loading) return;
    setLoading(true);
    setError("");
    try {
      const hits = await searchChunks(q, k);
      setResults(hits);
      setSearchedFor(q);
    } catch (e) {
      setError(e.message === "Failed to fetch" ? "Cannot reach the backend. Verify server is running on port 8000." : e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="retrieval-explorer">
      <div className="retrieval-header">
        <div className="retrieval-title-group">
          <span className="retrieval-title">Vector Retrieval Explorer</span>
          <span className="retrieval-sub">
            Directly test semantic chunk similarity without LLM answer generation
          </span>
        </div>
      </div>

      <div className="retrieval-form">
        <div className="retrieval-input-row">
          <div className="retrieval-search-box">
            <svg className="retrieval-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              className="retrieval-input"
              value={query}
              placeholder="Enter search phrase to evaluate semantic vector matches…"
              maxLength={1000}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && runSearch()}
            />
          </div>

          <div className="retrieval-k-selector">
            <label className="k-label">Top K:</label>
            <select
              className="k-select"
              value={k}
              onChange={(e) => setK(Number(e.target.value))}
            >
              {[3, 5, 8, 10].map((n) => (
                <option key={n} value={n}>
                  {n} chunks
                </option>
              ))}
            </select>
          </div>

          <button
            className="retrieval-submit-btn"
            onClick={() => runSearch()}
            disabled={loading || !query.trim()}
          >
            {loading ? "Searching…" : "Search Vectors"}
          </button>
        </div>

        <div className="retrieval-quick-chips">
          <span className="chips-label">Try query:</span>
          {QUICK_TEST_QUERIES.map((q, idx) => (
            <button
              key={idx}
              className="quick-chip"
              onClick={() => {
                setQuery(q);
                runSearch(q);
              }}
            >
              {q}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="error-toast">{error}</div>}

      <div className="retrieval-results-area">
        {results === null && !loading && (
          <div className="retrieval-empty-prompt">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            <p>Enter a query above to evaluate embedding similarity scores across all indexed chunks.</p>
          </div>
        )}

        {results && results.length === 0 && (
          <div className="retrieval-empty-prompt">
            <p>No matching chunks exceeded the similarity threshold for "{searchedFor}".</p>
          </div>
        )}

        {results && results.length > 0 && (
          <div className="results-wrapper">
            <div className="results-meta-bar">
              <span>
                Found <strong>{results.length}</strong> matching chunk{results.length === 1 ? "" : "s"} for{" "}
                <em className="searched-query">"{searchedFor}"</em>
              </span>
            </div>

            <div className="hit-card-grid">
              {results.map((r) => {
                const pct = Math.min(Math.round(r.score * 100), 100);
                const scoreColor = r.score >= 0.6 ? "score-emerald" : r.score >= 0.45 ? "score-amber" : "score-slate";

                return (
                  <div
                    key={r.chunk_id}
                    className="vector-hit-card"
                    onClick={() => onSelectFile(r.file_id, r.page_number, r.text)}
                    role="button"
                    tabIndex={0}
                    title="Click to inspect this document chunk"
                  >
                    <div className="hit-card-top">
                      <div className="hit-rank-badge">#{r.rank}</div>
                      <div className="hit-doc-meta">
                        <span className="hit-filename">{r.filename}</span>
                        <span className="hit-page-badge">
                          {r.file_type === "pdf" ? `Page ${r.page_number}` : "Image"}
                        </span>
                      </div>
                      <div className={`hit-score-pill ${scoreColor}`}>
                        <span>{(r.score).toFixed(3)}</span>
                        <span className="score-pct">({pct}%)</span>
                      </div>
                    </div>

                    <div className="score-bar-bg">
                      <div
                        className={`score-bar-fill ${scoreColor}`}
                        style={{ width: `${Math.max(pct, 5)}%` }}
                      ></div>
                    </div>

                    <p className="hit-card-text">{r.text}</p>

                    <div className="hit-card-footer">
                      <span className="hit-action-link">Inspect in Document Viewer →</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
