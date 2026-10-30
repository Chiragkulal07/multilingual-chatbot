import { useCallback, useEffect, useState } from "react";
import UploadArea from "./components/UploadArea";
import FileList from "./components/FileList";
import TextPreview from "./components/TextPreview";
import Chat from "./components/Chat";
import SearchTest from "./components/SearchTest";
import { listFiles, reprocessFile, uploadFiles } from "./api";
import "./App.css";

const ALLOWED_EXT = [".jpg", ".jpeg", ".png", ".pdf"];
const MAX_SIZE = 10 * 1024 * 1024;
const POLL_MS = 2000;

function precheck(file) {
  const dot = file.name.lastIndexOf(".");
  const ext = dot === -1 ? "" : file.name.slice(dot).toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) return "Unsupported file type. Allowed: PDF, PNG, JPG, JPEG.";
  if (file.size === 0) return "File is empty.";
  if (file.size > MAX_SIZE) return "File exceeds the 10 MB limit.";
  return null;
}

export default function App() {
  const [files, setFiles] = useState([]);
  const [results, setResults] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [backendDown, setBackendDown] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [focus, setFocus] = useState(null); // { page, chunkText }
  const [centerTab, setCenterTab] = useState("chat"); // 'chat' | 'retrieval'
  const [mobileView, setMobileView] = useState("chat"); // 'sidebar' | 'chat' | 'inspector'

  const refresh = useCallback(async () => {
    try {
      const data = await listFiles();
      setFiles(data);
      setBackendDown(false);
    } catch {
      setBackendDown(true);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const anyProcessing = files.some((f) => f.status === "processing");
  useEffect(() => {
    if (!anyProcessing) return;
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [anyProcessing, refresh]);

  const handleSelect = useCallback((fileId, page, chunkText) => {
    setSelectedId(fileId);
    setFocus(page ? { page, chunkText: chunkText || null } : null);
    // On small screens, auto-switch to inspector when selecting
    if (window.innerWidth <= 992) {
      setMobileView("inspector");
    }
  }, []);

  const handleFiles = async (selected, language) => {
    setError("");
    const rejected = [];
    const valid = [];

    selected.forEach((file) => {
      const problem = precheck(file);
      if (problem) rejected.push({ filename: file.name, status: "rejected", error: problem });
      else valid.push(file);
    });

    let serverResults = [];
    if (valid.length) {
      setUploading(true);
      try {
        serverResults = await uploadFiles(valid, language);
      } catch (e) {
        setError(e.message === "Failed to fetch" ? "Cannot reach the backend. Check port 8000." : e.message);
      } finally {
        setUploading(false);
      }
    }

    setResults([...rejected, ...serverResults]);
    const firstNew = serverResults.find((r) => r.file_id);
    if (firstNew) handleSelect(firstNew.file_id);
    refresh();
  };

  const handleRetry = async (fileId, language) => {
    setError("");
    try {
      await reprocessFile(fileId, language);
    } catch (e) {
      setError(e.message);
    }
    refresh();
  };

  const selectedFile = files.find((f) => f.file_id === selectedId) || null;
  const readyFiles = files.filter((f) => f.status === "ready");

  return (
    <div className="app-shell">
      {/* Top Application Header */}
      <header className="app-header">
        <div className="header-left">
          <div className="brand-emblem">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <path d="M10 13l2 2 4-4" />
            </svg>
          </div>
          <div className="brand-info">
            <div className="brand-title-row">
              <h1 className="brand-title">DocuSense AI</h1>
              <span className="brand-version-tag">Studio</span>
            </div>
            <p className="brand-desc">Multilingual OCR & Document Intelligence (EN • HI • KN)</p>
          </div>
        </div>

        {/* Center Workspace Navigation Tabs */}
        <div className="workspace-tabs">
          <button
            className={`workspace-tab-btn ${centerTab === "chat" ? "active" : ""}`}
            onClick={() => setCenterTab("chat")}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <span>Document Q&A</span>
            {readyFiles.length > 0 && (
              <span className="tab-counter-badge">{readyFiles.length}</span>
            )}
          </button>

          <button
            className={`workspace-tab-btn ${centerTab === "retrieval" ? "active" : ""}`}
            onClick={() => setCenterTab("retrieval")}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <span>Vector Explorer</span>
          </button>
        </div>

        {/* Header Right Status Badges */}
        <div className="header-right">
          <div className={`status-pill ${backendDown ? "status-offline" : "status-online"}`}>
            <span className="pulse-dot"></span>
            <span>{backendDown ? "Backend Offline" : "API Connected"}</span>
          </div>

          <div className="doc-count-pill" title={`${files.length} Total Uploaded Documents`}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <span>{files.length} {files.length === 1 ? "Doc" : "Docs"}</span>
          </div>
        </div>
      </header>

      {/* Mobile/Tablet View Switcher Bar */}
      <div className="mobile-nav-bar">
        <button
          className={`mobile-tab-btn ${mobileView === "sidebar" ? "active" : ""}`}
          onClick={() => setMobileView("sidebar")}
        >
          Documents ({files.length})
        </button>
        <button
          className={`mobile-tab-btn ${mobileView === "chat" ? "active" : ""}`}
          onClick={() => setMobileView("chat")}
        >
          {centerTab === "chat" ? "Assistant" : "Search"}
        </button>
        <button
          className={`mobile-tab-btn ${mobileView === "inspector" ? "active" : ""}`}
          onClick={() => setMobileView("inspector")}
        >
          Viewer {selectedFile ? `(${selectedFile.file_type.toUpperCase()})` : ""}
        </button>
      </div>

      {/* Main 3-Column Studio Layout */}
      <main className={`studio-layout show-mobile-${mobileView}`}>
        {/* Column 1: Document Management Sidebar */}
        <aside className="studio-col studio-sidebar">
          <div className="sidebar-scrollable">
            <UploadArea onFiles={handleFiles} disabled={uploading} />

            {backendDown && (
              <div className="alert-card alert-danger">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <span>Cannot connect to backend server. Make sure it is running on <code>http://localhost:8000</code>.</span>
              </div>
            )}

            {error && (
              <div className="alert-card alert-danger">
                <span>{error}</span>
              </div>
            )}

            {results.length > 0 && (
              <div className="upload-results-box">
                <div className="results-header">
                  <span className="results-title">Upload Status</span>
                  <button className="dismiss-btn" onClick={() => setResults([])}>
                    Dismiss
                  </button>
                </div>
                <ul className="results-list">
                  {results.map((r, i) => (
                    <li
                      key={i}
                      className={`result-item ${r.status === "rejected" ? "result-rejected" : "result-uploaded"}`}
                    >
                      <strong className="result-name">{r.filename}</strong>
                      <span className="result-msg">
                        {r.status === "rejected" ? ` — ${r.error}` : " — uploaded & queuing for OCR…"}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="sidebar-section-header">
              <span className="section-label">Uploaded Documents</span>
              <span className="section-badge">{files.length}</span>
            </div>

            <FileList
              files={files}
              selectedId={selectedId}
              onSelect={handleSelect}
              onRetry={(id) => handleRetry(id)}
            />
          </div>
        </aside>

        {/* Column 2: Conversational QA / Retrieval Explorer Workspace */}
        <section className="studio-col studio-center">
          {centerTab === "chat" ? (
            <Chat files={readyFiles} onSelectFile={handleSelect} />
          ) : (
            <SearchTest onSelectFile={handleSelect} />
          )}
        </section>

        {/* Column 3: Document Inspector & Source Viewer */}
        <section className="studio-col studio-inspector">
          <TextPreview file={selectedFile} focus={focus} onReread={handleRetry} />
        </section>
      </main>
    </div>
  );
}
