import { useMemo, useState } from "react";

const LANG_LABEL = { en: "EN", hi: "HI", kn: "KN" };

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export default function FileList({ files, selectedId, onSelect, onRetry }) {
  const [filterQuery, setFilterQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const filtered = useMemo(() => {
    return files.filter((f) => {
      const matchName = f.filename.toLowerCase().includes(filterQuery.toLowerCase());
      const matchStatus = statusFilter === "all" || f.status === statusFilter;
      return matchName && matchStatus;
    });
  }, [files, filterQuery, statusFilter]);

  return (
    <div className="uploaded-docs-section">
      <div className="uploaded-docs-header">
        <span className="uploaded-docs-title">Uploaded Documents</span>
        <span className="uploaded-docs-count">{files.length}</span>
      </div>

      <div className="docs-search-bar">
        <svg className="docs-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="text"
          className="docs-search-input"
          placeholder="Search documents..."
          value={filterQuery}
          onChange={(e) => setFilterQuery(e.target.value)}
        />
        {filterQuery && (
          <button className="docs-clear-btn" onClick={() => setFilterQuery("")}>
            ✕
          </button>
        )}
      </div>

      <div className="docs-filter-tabs">
        {["all", "ready", "processing", "failed"].map((status) => (
          <button
            key={status}
            className={`docs-filter-tab ${statusFilter === status ? "active" : ""}`}
            onClick={() => setStatusFilter(status)}
          >
            {status.charAt(0).toUpperCase() + status.slice(1)}
          </button>
        ))}
      </div>

      <ul className="docs-items-list">
        {filtered.length === 0 ? (
          <li className="no-docs-message">
            {files.length === 0 ? "No documents uploaded yet." : "No matching documents found."}
          </li>
        ) : (
          filtered.map((f) => {
            const isSelected = f.file_id === selectedId;
            const isPdf = f.file_type === "pdf";
            const canRetry = f.status === "failed" || f.status === "uploaded";
            const lang = f.detected_language && LANG_LABEL[f.detected_language];

            return (
              <li
                key={f.file_id}
                className={`doc-item-row ${isSelected ? "selected" : ""}`}
                role="button"
                tabIndex={0}
                onClick={() => onSelect(f.file_id)}
                onKeyDown={(e) => e.key === "Enter" && onSelect(f.file_id)}
              >
                {/* File Type Glyphs */}
                <div className={`doc-type-badge ${isPdf ? "badge-pdf" : "badge-img"}`}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    {isPdf ? (
                      <>
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                      </>
                    ) : (
                      <>
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                        <circle cx="8.5" cy="8.5" r="1.5" />
                        <polyline points="21 15 16 10 5 21" />
                      </>
                    )}
                  </svg>
                  <span className="type-label">{f.file_type.toUpperCase()}</span>
                </div>

                {/* Details */}
                <div className="doc-item-details">
                  <div className="doc-item-name" title={f.filename}>
                    {f.filename}
                  </div>
                  <div className="doc-item-meta">
                    <span>{formatSize(f.size_bytes)}</span>
                    <span className="meta-sep">•</span>
                    <span>{formatDate(f.created_at)}</span>
                  </div>
                  {lang && f.status === "ready" && (
                    <div className="doc-lang-tag">{lang}</div>
                  )}
                  {f.status === "failed" && f.error_message && (
                    <div className="doc-error-tag" title={f.error_message}>
                      {f.error_message}
                    </div>
                  )}
                </div>

                {/* Status & Options */}
                <div className="doc-item-status-group">
                  {f.status === "ready" && (
                    <span className="status-indicator ready">
                      <span className="status-dot"></span>
                      <span>Ready</span>
                    </span>
                  )}
                  {f.status === "processing" && (
                    <span className="status-indicator processing">
                      <span className="status-dot pulsing"></span>
                      <span>Processing</span>
                    </span>
                  )}
                  {f.status === "failed" && (
                    <span className="status-indicator failed">
                      <span>Failed</span>
                    </span>
                  )}
                  {f.status === "uploaded" && (
                    <span className="status-indicator uploaded">
                      <span>Uploaded</span>
                    </span>
                  )}

                  {canRetry ? (
                    <button
                      className="doc-retry-btn"
                      title={f.status === "failed" ? "Retry Processing" : "Start Processing"}
                      onClick={(e) => {
                        e.stopPropagation();
                        onRetry(f.file_id);
                      }}
                    >
                      {f.status === "failed" ? "Retry" : "Extract"}
                    </button>
                  ) : (
                    <button
                      className="doc-menu-btn"
                      title="More options"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="1" />
                        <circle cx="12" cy="5" r="1" />
                        <circle cx="12" cy="19" r="1" />
                      </svg>
                    </button>
                  )}
                </div>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}
