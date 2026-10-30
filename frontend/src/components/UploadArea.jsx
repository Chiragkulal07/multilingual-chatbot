import { useRef, useState } from "react";

export default function UploadArea({ onFiles, disabled }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [language, setLanguage] = useState("auto");

  const handleDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    if (disabled) return;
    const files = Array.from(e.dataTransfer.files);
    if (files.length) onFiles(files, language);
  };

  const handleSelect = (e) => {
    const files = Array.from(e.target.files);
    if (files.length) onFiles(files, language);
    e.target.value = "";
  };

  return (
    <div className="add-document-card">
      <div className="add-document-header">
        <div className="add-doc-icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="12" y1="18" x2="12" y2="12" />
            <line x1="9" y1="15" x2="15" y2="15" />
          </svg>
        </div>
        <div className="add-doc-text">
          <h3 className="add-doc-title">Add Document</h3>
          <p className="add-doc-subtitle">Auto-indexed for Q&A</p>
        </div>
      </div>

      <div className="ocr-select-wrapper">
        <label className="ocr-label" htmlFor="ocr-lang-dropdown">
          OCR:
        </label>
        <select
          id="ocr-lang-dropdown"
          className="ocr-select"
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          disabled={disabled}
        >
          <option value="auto">Auto-detect</option>
          <option value="en">English (en)</option>
          <option value="hi">हिन्दी (Hindi)</option>
          <option value="kn">ಕನ್ನಡ (Kannada)</option>
        </select>
        <svg className="select-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>

      <div
        className={`dropzone-box ${dragging ? "dragging" : ""} ${disabled ? "disabled" : ""}`}
        onClick={() => !disabled && inputRef.current.click()}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && !disabled && inputRef.current.click()}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".jpg,.jpeg,.png,.pdf"
          onChange={handleSelect}
          style={{ display: "none" }}
        />

        <div className="dropzone-content">
          <div className="dropzone-cloud-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
              <path d="M12 12v9" />
              <path d="m16 16-4-4-4 4" />
            </svg>
          </div>
          <div className="dropzone-labels">
            <span className="dropzone-main-text">
              {disabled ? "Uploading documents…" : "Drop documents or browse"}
            </span>
            <span className="dropzone-sub-text">PDF, PNG, JPG, JPEG • Max 10MB</span>
          </div>
        </div>
      </div>
    </div>
  );
}
