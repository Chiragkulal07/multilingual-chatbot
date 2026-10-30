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
      // Auto-select first file if none is selected
      if (!selectedId && data.length > 0) {
        setSelectedId(data[0].file_id);
      }
    } catch {
      setBackendDown(true);
    }
  }, [selectedId]);

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

  const selectedFile = files.find((f) => f.file_id === selectedId) || files[0] || null;
  const readyFiles = files.filter((f) => f.status === "ready");

  return (
    <div className="docusense-app-shell">
      {/* Top Header Matching Screenshot */}
      <header className="docusense-top-nav">
        <div className="nav-left">
          <button className="nav-hamburger-btn" title="Toggle Navigation">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>

          <div className="nav-brand-group">
            <div className="nav-brand-logo">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path
                  d="M12 2L14.2 9.8L22 12L14.2 14.2L12 22L9.8 14.2L2 12L9.8 9.8L12 2Z"
                  fill="#ffffff"
                />
              </svg>
            </div>
            <div className="nav-brand-titles">
              <div className="brand-logo-text">
                DocuSense <span className="brand-ai-terracotta">AI</span>
              </div>
              <div className="brand-sub-tag">Multilingual OCR & Document Intelligence</div>
            </div>
          </div>
        </div>

        {/* Center Mode Switcher Tabs */}
        <div className="nav-center-tabs">
          <button
            className={`nav-mode-pill ${centerTab === "chat" ? "active-terracotta-pill" : ""}`}
            onClick={() => setCenterTab("chat")}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <span>Document Q&A</span>
          </button>

          <button
            className={`nav-mode-pill ${centerTab === "retrieval" ? "active-terracotta-pill" : ""}`}
            onClick={() => setCenterTab("retrieval")}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.93 4.93l2.12 2.12M16.95 16.95l2.12 2.12M4.93 19.07l2.12-2.12M16.95 7.05l2.12-2.12" />
            </svg>
            <span>Vector Explorer</span>
          </button>
        </div>

        {/* Right Status Group */}
        <div className="nav-right-group">
          <div className={`api-status-pill ${backendDown ? "offline" : "online"}`}>
            <span className="api-dot"></span>
            <span>{backendDown ? "API Offline" : "API Connected"}</span>
          </div>

          <div className="docs-count-badge">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <span>{files.length} Docs</span>
          </div>

          <button className="user-avatar-btn" title="User Settings">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
          </button>
        </div>
      </header>

      {/* Responsive Breakpoint Switcher */}
      <div className="responsive-mobile-bar">
        <button
          className={`mobile-bar-btn ${mobileView === "sidebar" ? "active" : ""}`}
          onClick={() => setMobileView("sidebar")}
        >
          Documents ({files.length})
        </button>
        <button
          className={`mobile-bar-btn ${mobileView === "chat" ? "active" : ""}`}
          onClick={() => setMobileView("chat")}
        >
          {centerTab === "chat" ? "Assistant" : "Explorer"}
        </button>
        <button
          className={`mobile-bar-btn ${mobileView === "inspector" ? "active" : ""}`}
          onClick={() => setMobileView("inspector")}
        >
          Viewer
        </button>
      </div>

      {/* Main 3-Column Studio Workspace */}
      <main className={`docusense-main-studio show-${mobileView}`}>
        {/* Column 1: Left Document Management Sidebar */}
        <aside className="studio-sidebar-column">
          <div className="sidebar-inner-content">
            <UploadArea onFiles={handleFiles} disabled={uploading} />

            {error && (
              <div className="sidebar-error-toast">
                <span>{error}</span>
              </div>
            )}

            {results.length > 0 && (
              <div className="sidebar-results-toast">
                <div className="results-toast-top">
                  <span>Upload Results</span>
                  <button className="results-dismiss" onClick={() => setResults([])}>
                    ✕
                  </button>
                </div>
                {results.map((r, i) => (
                  <div key={i} className={`toast-row ${r.status}`}>
                    <strong>{r.filename}</strong>: {r.status === "rejected" ? r.error : "processing…"}
                  </div>
                ))}
              </div>
            )}

            <FileList
              files={files}
              selectedId={selectedId}
              onSelect={handleSelect}
              onRetry={(id) => handleRetry(id)}
            />
          </div>
        </aside>

        {/* Column 2: Center Conversational Assistant / Explorer */}
        <section className="studio-center-column">
          {centerTab === "chat" ? (
            <Chat files={readyFiles} onSelectFile={handleSelect} />
          ) : (
            <SearchTest onSelectFile={handleSelect} />
          )}
        </section>

        {/* Column 3: Right Document Inspector */}
        <section className="studio-inspector-column">
          <TextPreview file={selectedFile} focus={focus} onReread={handleRetry} />
        </section>
      </main>
    </div>
  );
}
