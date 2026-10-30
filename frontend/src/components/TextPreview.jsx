import { useEffect, useState } from "react";
import { getChunks, getPages, originalUrl } from "../api";

const LOW_CONFIDENCE = 0.8;
const LANG_LABEL = { en: "English", hi: "Hindi", kn: "Kannada" };

export default function TextPreview({ file, focus, onReread }) {
  const [tab, setTab] = useState("original");
  const [pages, setPages] = useState([]);
  const [chunks, setChunks] = useState([]);
  const [viewPage, setViewPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [rereadLang, setRereadLang] = useState("auto");
  const [copiedKey, setCopiedKey] = useState(null);

  const fileId = file?.file_id;
  const status = file?.status;

  useEffect(() => {
    setPages([]);
    setChunks([]);
    setError("");
    setViewPage(1);
    if (!fileId || status !== "ready") return;

    let cancelled = false;
    setLoading(true);
    Promise.all([getPages(fileId), getChunks(fileId)])
      .then(([p, c]) => {
        if (cancelled) return;
        setPages(p.pages);
        setChunks(c.chunks);
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));

    return () => {
      cancelled = true;
    };
  }, [fileId, status]);

  // When focus changes from a citation click, switch to original view
  useEffect(() => {
    if (!focus) return;
    setTab("original");
    setViewPage(focus.page || 1);
  }, [focus]);

  const handleCopy = (text, key) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  if (!file) {
    return (
      <div className="preview-pane-empty">
        <div className="empty-preview-icon">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
          </svg>
        </div>
        <p className="empty-preview-title">No document selected</p>
        <p className="empty-preview-sub">Select an item from the left to view original pages, OCR text, and chunks.</p>
      </div>
    );
  }

  const isPdf = file.file_type === "pdf";
  const totalPages = Math.max(pages.length, 1);
  const currentPage = Math.min(Math.max(viewPage, 1), totalPages);
  const currentText = pages.find((p) => p.page_number === currentPage);
  const citedText = focus && focus.page === currentPage ? focus.chunkText : null;
  const url = originalUrl(fileId);
  const canReread = status === "ready" || status === "failed";
  const detectedLangName = file.detected_language ? (LANG_LABEL[file.detected_language] || file.detected_language) : "English";

  return (
    <div className="inspector-panel">
      {/* Top Header Matching Screenshot */}
      <div className="inspector-header">
        <div className="inspector-header-left">
          <div className="doc-title-row">
            <svg className="doc-icon-purple" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <span className="inspector-filename" title={file.filename}>
              {file.filename}
            </span>
            <span className={`file-badge-pill pill-${file.file_type.toLowerCase()}`}>
              {file.file_type.toUpperCase()}
            </span>
          </div>

          <div className="doc-sub-row">
            <span className="ready-indicator">
              <span className="dot-green"></span>
              <span>Ready</span>
            </span>
            <span className="sub-detail">
              {isPdf ? `${pages.length} pages` : "Single image"} | Lang: {detectedLangName}
            </span>
          </div>
        </div>

        {canReread && (
          <div className="inspector-header-right">
            <div className="ocr-quick-select">
              <span className="ocr-quick-label">OCR:</span>
              <select
                className="ocr-quick-dropdown"
                value={rereadLang}
                onChange={(e) => setRereadLang(e.target.value)}
              >
                <option value="auto">Auto-detect</option>
                <option value="en">English (en)</option>
                <option value="hi">हिन्दी (Hindi)</option>
                <option value="kn">ಕನ್ನಡ (Kannada)</option>
              </select>
              <svg className="quick-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </div>

            <button
              className="rerun-btn"
              onClick={() => onReread(fileId, rereadLang)}
              title="Re-run OCR extraction"
            >
              <span>Re-run</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
              </svg>
            </button>
          </div>
        )}
      </div>

      {/* Tabs Row Matching Screenshot */}
      <div className="inspector-tabs-row">
        <button
          className={`inspector-tab ${tab === "original" ? "tab-active-terracotta" : ""}`}
          onClick={() => setTab("original")}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
          <span>Original View</span>
        </button>

        <button
          className={`inspector-tab ${tab === "text" ? "tab-active-terracotta" : ""}`}
          onClick={() => setTab("text")}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="17" y1="10" x2="3" y2="10" />
            <line x1="21" y1="6" x2="3" y2="6" />
            <line x1="21" y1="14" x2="3" y2="14" />
            <line x1="17" y1="18" x2="3" y2="18" />
          </svg>
          <span>Extracted Text ({pages.length})</span>
        </button>

        <button
          className={`inspector-tab ${tab === "chunks" ? "tab-active-terracotta" : ""}`}
          onClick={() => setTab("chunks")}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 6h16" />
            <path d="M4 12h16" />
            <path d="M4 18h10" />
          </svg>
          <span>RAG Chunks ({chunks.length})</span>
        </button>
      </div>

      {/* Scrollable Content Area */}
      <div className="inspector-scroll-body">
        {loading && (
          <div className="inspector-loading">
            <span>Loading document details…</span>
          </div>
        )}

        {error && <div className="inspector-error-alert">{error}</div>}

        {/* Tab 1: Original Document */}
        {tab === "original" && (
          <div className="tab-original-container">
            <div className="original-view-header">
              <span className="view-title">Original Document Image</span>
              <a
                className="open-file-link"
                href={url}
                target="_blank"
                rel="noreferrer"
              >
                <span>Open File</span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
              </a>
            </div>

            {/* Document Image / PDF Display */}
            <div className="document-media-card">
              {isPdf ? (
                <>
                  <div className="pdf-page-bar">
                    <button
                      className="pdf-page-btn"
                      disabled={currentPage <= 1}
                      onClick={() => setViewPage(currentPage - 1)}
                    >
                      ‹ Prev
                    </button>
                    <span>Page {currentPage} of {totalPages}</span>
                    <button
                      className="pdf-page-btn"
                      disabled={currentPage >= totalPages}
                      onClick={() => setViewPage(currentPage + 1)}
                    >
                      Next ›
                    </button>
                  </div>
                  <iframe
                    key={`${fileId}-${currentPage}`}
                    className="pdf-viewer-frame"
                    title={`${file.filename} page ${currentPage}`}
                    src={`${url}#page=${currentPage}`}
                  />
                </>
              ) : (
                <img className="image-viewer-el" src={url} alt={file.filename} />
              )}
            </div>

            {/* Referenced Passage Box (when jumped from a citation) */}
            {citedText && (
              <div className="cited-passage-box">
                <div className="cited-passage-title-bar">
                  <span className="cited-label">📍 Referenced Passage in Q&A</span>
                  <button
                    className="copy-snippet-btn"
                    onClick={() => handleCopy(citedText, "cited")}
                  >
                    {copiedKey === "cited" ? "Copied" : "Copy"}
                  </button>
                </div>
                <div className="cited-text-content">{citedText}</div>
              </div>
            )}

            {/* Extracted Text Section Matching Screenshot */}
            <div className="extracted-text-section">
              <div className="extracted-section-header">
                <span className="extracted-heading">Extracted Text</span>
                {currentText && (
                  <button
                    className="copy-extracted-btn"
                    onClick={() => handleCopy(currentText.text, `page-${currentPage}`)}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                    <span>{copiedKey === `page-${currentPage}` ? "Copied" : "Copy"}</span>
                  </button>
                )}
              </div>

              {/* Low confidence warning banner matching screenshot */}
              {currentText && currentText.confidence !== null && currentText.confidence < LOW_CONFIDENCE && (
                <div className="low-confidence-banner">
                  <span className="warning-spark">⚡</span>
                  <span>
                    Low OCR confidence ({(currentText.confidence * 100).toFixed(1)}%). Consider re-running with an explicit language setting.
                  </span>
                </div>
              )}

              <div className="extracted-text-box">
                <pre className="extracted-text-pre">
                  {currentText?.text || "(No text detected on this page)"}
                </pre>
              </div>
            </div>
          </div>
        )}

        {/* Tab 2: Extracted Text (All Pages) */}
        {tab === "text" && (
          <div className="tab-all-pages-container">
            {pages.map((p) => {
              const lowConf = p.confidence !== null && p.confidence < LOW_CONFIDENCE;
              return (
                <div key={p.page_number} className="page-text-card-row">
                  <div className="page-card-top-bar">
                    <div className="page-card-badges">
                      <span className="page-badge-main">
                        {isPdf ? `Page ${p.page_number}` : "Image Text"}
                      </span>
                      <span className="page-method-badge">
                        {p.method === "ocr" ? "Tesseract OCR" : "Direct PDF"}
                      </span>
                      <span className="page-method-badge">
                        {LANG_LABEL[p.language] || p.language}
                      </span>
                      {p.confidence !== null && (
                        <span className={`confidence-pill ${lowConf ? "conf-low" : "conf-high"}`}>
                          {(p.confidence * 100).toFixed(1)}% conf
                        </span>
                      )}
                    </div>

                    <button
                      className="copy-extracted-btn"
                      onClick={() => handleCopy(p.text, `page-all-${p.page_number}`)}
                    >
                      <span>{copiedKey === `page-all-${p.page_number}` ? "Copied" : "Copy"}</span>
                    </button>
                  </div>

                  {lowConf && (
                    <div className="low-confidence-banner">
                      <span>Low OCR confidence ({(p.confidence * 100).toFixed(1)}%).</span>
                    </div>
                  )}

                  <pre className="extracted-text-pre">{p.text || "(No text extracted)"}</pre>
                </div>
              );
            })}
          </div>
        )}

        {/* Tab 3: RAG Chunks */}
        {tab === "chunks" && (
          <div className="tab-chunks-container">
            {chunks.map((c) => (
              <div key={c.chunk_id} className="chunk-card-row">
                <div className="chunk-card-top">
                  <div className="chunk-badges">
                    <span className="chunk-num-badge">Chunk #{c.chunk_index + 1}</span>
                    <span className="page-method-badge">{isPdf ? `Page ${c.page_number}` : "Image"}</span>
                    <span className="page-method-badge">{c.token_count} tokens</span>
                    <span className="page-method-badge">{LANG_LABEL[c.language] || c.language}</span>
                  </div>
                  <button
                    className="copy-extracted-btn"
                    onClick={() => handleCopy(c.text, `chunk-${c.chunk_id}`)}
                  >
                    <span>{copiedKey === `chunk-${c.chunk_id}` ? "Copied" : "Copy"}</span>
                  </button>
                </div>
                <pre className="extracted-text-pre">{c.text}</pre>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
