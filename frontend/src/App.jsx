import { useCallback, useEffect, useRef, useState } from "react";
import { askQuestion, getFile, listFiles, originalUrl, reprocessFile, uploadFiles } from "./api";
import "./App.css";

const ALLOWED_EXT = [".jpg", ".jpeg", ".png", ".pdf"];
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB

function precheck(file) {
  const dot = file.name.lastIndexOf(".");
  const ext = dot === -1 ? "" : file.name.slice(dot).toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) return "Unsupported file type. Allowed: PDF, PNG, JPG, JPEG.";
  if (file.size === 0) return "File is empty.";
  if (file.size > MAX_SIZE) return "File exceeds the 10 MB limit.";
  return null;
}

function formatSize(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Map backend stages to human-readable stage labels
const STAGE_LABELS = {
  uploading: { label: "Uploading file…", step: 1 },
  analyzing_img: { label: "Analyzing image…", step: 2 },
  analyzing_doc: { label: "Reading document…", step: 2 },
  extracting: { label: "Extracting content…", step: 3 },
  preparing_context: { label: "Preparing document context…", step: 4 },
  ready: { label: "Document ready", step: 5 },
  failed: { label: "Processing failed", step: 0 },
};

export default function App() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [activeFile, setActiveFile] = useState(null); // currently attached document
  const [allFiles, setAllFiles] = useState([]);
  const [language, setLanguage] = useState("auto");
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [copiedId, setCopiedId] = useState(null);
  const [detailsOpen, setDetailsOpen] = useState({});

  const fileInputRef = useRef(null);
  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);
  const isUploadingRef = useRef(false);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading, uploading]);

  // Load uploaded files list
  const refreshFiles = useCallback(async () => {
    try {
      const data = await listFiles();
      setAllFiles(data);
    } catch {
      // Backend may be offline
    }
  }, []);

  useEffect(() => {
    refreshFiles();
  }, [refreshFiles]);

  // Auto-resize input textarea
  const handleInputChange = (e) => {
    setInput(e.target.value);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 160)}px`;
    }
  };

  const handleCopy = (text, id) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const toggleDetails = (id) => {
    setDetailsOpen((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  // Upload and process a file with live backend stage tracking
  const handleUploadFile = async (file) => {
    if (isUploadingRef.current) return;

    const errorMsg = precheck(file);
    if (errorMsg) {
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now(),
          role: "assistant",
          text: `Upload error: ${errorMsg}`,
          isError: true,
        },
      ]);
      return;
    }

    const tempId = Date.now();
    isUploadingRef.current = true;
    setUploading(true);

    const isImage = file.type.startsWith("image/") || /\.(jpg|jpeg|png)$/i.test(file.name);
    const localPreviewUrl = isImage ? URL.createObjectURL(file) : null;

    // Immediately insert animated processing card into chat stream
    setMessages((prev) => [
      ...prev,
      {
        id: tempId,
        role: "assistant",
        isProcessing: true,
        fileInfo: {
          name: file.name,
          size: file.size,
          type: file.name.split(".").pop().toUpperCase(),
          isImage,
          previewUrl: localPreviewUrl,
        },
        stage: "uploading",
        stageText: "Uploading file…",
      },
    ]);

    try {
      const results = await uploadFiles([file], language);
      const uploaded = results[0];

      if (uploaded.status === "rejected") {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === tempId
              ? {
                  ...m,
                  isProcessing: false,
                  stage: "failed",
                  isError: true,
                  text: `Could not process ${file.name}: ${uploaded.error}`,
                }
              : m
          )
        );
        isUploadingRef.current = false;
        setUploading(false);
        return;
      }

      const fileId = uploaded.file_id;

      // Poll real backend stages from /api/files/{file_id}
      let isReady = false;
      let attempts = 0;

      while (!isReady && attempts < 80) {
        await new Promise((res) => setTimeout(res, 900));
        attempts += 1;
        try {
          const detail = await getFile(fileId);
          const currentStage = detail.stage || detail.status;

          // Determine stage text based on file type and real backend stage
          let stageLabel = "Analyzing…";
          if (currentStage === "analyzing") {
            stageLabel = isImage ? "Analyzing image…" : "Reading document…";
          } else if (currentStage === "extracting") {
            stageLabel = "Extracting content…";
          } else if (currentStage === "preparing_context") {
            stageLabel = "Preparing document context…";
          } else if (currentStage === "ready") {
            stageLabel = "Document ready";
          }

          if (detail.status === "ready") {
            isReady = true;
            setActiveFile(detail);
            refreshFiles();

            setMessages((prev) =>
              prev.map((m) =>
                m.id === tempId
                  ? {
                      ...m,
                      isProcessing: false,
                      isFileAttached: true,
                      stage: "ready",
                      stageText: "Document ready",
                      fileInfo: {
                        ...m.fileInfo,
                        id: fileId,
                        detected_language: detail.detected_language,
                      },
                      text: `I've analyzed and indexed **${file.name}**. You can now ask questions about this document.`,
                    }
                  : m
              )
            );
            break;
          } else if (detail.status === "failed") {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === tempId
                  ? {
                      ...m,
                      isProcessing: false,
                      stage: "failed",
                      isError: true,
                      fileId,
                      text: `Failed to process ${file.name}: ${detail.error_message || "Recognition error."}`,
                    }
                  : m
              )
            );
            break;
          } else {
            // Update live stage in chat UI
            setMessages((prev) =>
              prev.map((m) =>
                m.id === tempId
                  ? {
                      ...m,
                      stage: currentStage,
                      stageText: stageLabel,
                    }
                  : m
              )
            );
          }
        } catch {
          // Retry poll
        }
      }
    } catch (e) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === tempId
            ? {
                ...m,
                isProcessing: false,
                stage: "failed",
                isError: true,
                text: `Upload failed: ${e.message}`,
              }
            : m
        )
      );
    } finally {
      isUploadingRef.current = false;
      setUploading(false);
    }
  };

  // Retry processing a failed file
  const handleRetryProcessing = async (messageId, fileId, filename) => {
    if (!fileId) return;
    setMessages((prev) =>
      prev.map((m) =>
        m.id === messageId
          ? {
              ...m,
              isProcessing: true,
              isError: false,
              stage: "analyzing",
              stageText: "Reading content…",
            }
          : m
      )
    );
    setUploading(true);

    try {
      await reprocessFile(fileId, language);
      let isReady = false;
      let attempts = 0;

      while (!isReady && attempts < 80) {
        await new Promise((res) => setTimeout(res, 1000));
        attempts += 1;
        const detail = await getFile(fileId);
        if (detail.status === "ready") {
          isReady = true;
          setActiveFile(detail);
          refreshFiles();
          setMessages((prev) =>
            prev.map((m) =>
              m.id === messageId
                ? {
                    ...m,
                    isProcessing: false,
                    stage: "ready",
                    stageText: "Document ready",
                    isFileAttached: true,
                    text: `Successfully reprocessed **${filename}**. You can now ask questions about it.`,
                  }
                : m
            )
          );
          break;
        } else if (detail.status === "failed") {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === messageId
                ? {
                    ...m,
                    isProcessing: false,
                    stage: "failed",
                    isError: true,
                    text: `Reprocessing failed: ${detail.error_message || "Error"}`,
                  }
                : m
            )
          );
          break;
        }
      }
    } catch (e) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? {
                ...m,
                isProcessing: false,
                stage: "failed",
                isError: true,
                text: `Retry failed: ${e.message}`,
              }
            : m
        )
      );
    } finally {
      setUploading(false);
    }
  };

  // Send message
  const handleSend = async (overrideText) => {
    const question = (overrideText || input).trim();
    if (!question || loading || uploading) return;

    setInput("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }

    const userMessageId = Date.now();
    const newUserMsg = {
      id: userMessageId,
      role: "user",
      text: question,
      attachedFile: activeFile ? { name: activeFile.filename } : null,
    };

    setMessages((prev) => [...prev, newUserMsg]);
    setLoading(true);

    // Build history for multi-turn conversation memory
    const historyPayload = messages
      .filter((m) => !m.isProcessing && !m.isError && m.text)
      .slice(-6);

    try {
      const fileIds = activeFile ? [activeFile.file_id] : null;
      const res = await askQuestion(question, fileIds, language, historyPayload);

      setMessages((prev) => [
        ...prev,
        {
          id: Date.now() + 1,
          role: "assistant",
          text: res.answer,
          sources: res.sources || [],
          fromDocuments: res.from_documents,
          cached: res.cached,
        },
      ]);
    } catch (e) {
      const errText =
        e.message === "Failed to fetch"
          ? "Unable to reach the server. Make sure the backend is running."
          : e.message;
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now() + 1,
          role: "assistant",
          text: errText,
          isError: true,
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleNewChat = () => {
    setMessages([]);
    setActiveFile(null);
    setInput("");
  };

  // Drag and drop handler
  const [dragging, setDragging] = useState(false);
  const handleDragOver = (e) => {
    e.preventDefault();
    setDragging(true);
  };
  const handleDragLeave = () => {
    setDragging(false);
  };
  const handleDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleUploadFile(e.dataTransfer.files[0]);
    }
  };

  return (
    <div
      className={`chat-app-root ${dragging ? "file-drag-active" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Left Sidebar for Document Library & History */}
      <aside className={`chat-sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <div className="sidebar-header">
          <button className="new-chat-btn" onClick={handleNewChat}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span>New Chat</span>
          </button>
          <button className="sidebar-close-btn" onClick={() => setSidebarOpen(false)} title="Close Sidebar">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="sidebar-content">
          <div className="sidebar-section-title">Documents</div>
          {allFiles.length === 0 ? (
            <p className="sidebar-empty">No documents uploaded yet.</p>
          ) : (
            <ul className="sidebar-file-list">
              {allFiles.map((f) => {
                const isCurrent = activeFile?.file_id === f.file_id;
                const isPdf = f.file_type === "pdf";
                return (
                  <li
                    key={f.file_id}
                    className={`sidebar-file-item ${isCurrent ? "file-item-active" : ""}`}
                    onClick={() => {
                      setActiveFile(f);
                      setSidebarOpen(false);
                    }}
                  >
                    <span className={`sidebar-type-tag ${isPdf ? "tag-pdf" : "tag-img"}`}>
                      {f.file_type.toUpperCase()}
                    </span>
                    <span className="sidebar-file-name" title={f.filename}>
                      {f.filename}
                    </span>
                    {isCurrent && <span className="active-dot"></span>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>

      {/* Main Chat Area */}
      <div className="chat-main-container">
        {/* Top Navbar */}
        <header className="chat-navbar">
          <div className="navbar-left">
            <button
              className="nav-icon-btn"
              onClick={() => setSidebarOpen(!sidebarOpen)}
              title="Toggle Sidebar"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            </button>

            <span className="navbar-title">
              {activeFile ? (
                <span className="active-doc-badge">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                  <span className="doc-badge-name">{activeFile.filename}</span>
                  <button
                    className="detach-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      setActiveFile(null);
                    }}
                    title="Detach document (Switch to normal chat)"
                  >
                    ✕
                  </button>
                </span>
              ) : (
                "Chat"
              )}
            </span>
          </div>

          <div className="navbar-right">
            <select
              className="nav-language-select"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              title="Response Language"
            >
              <option value="auto">Auto Language</option>
              <option value="en">English</option>
              <option value="hi">हिन्दी (Hindi)</option>
              <option value="kn">ಕನ್ನಡ (Kannada)</option>
            </select>

            <button className="nav-new-chat-btn" onClick={handleNewChat} title="New Chat">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </div>
        </header>

        {/* Message Thread */}
        <main className="chat-messages-scroll">
          <div className="chat-thread-inner">
            {messages.length === 0 ? (
              <div className="chat-empty-state">
                <h1 className="empty-heading">What would you like to know?</h1>
                <p className="empty-subheading">
                  Chat naturally, or attach an image or PDF to ask questions about your documents.
                </p>

                <div className="empty-suggestions-grid">
                  <button
                    className="suggestion-box"
                    onClick={() => handleSend("What is the capital of Karnataka and what is it known for?")}
                  >
                    <span className="suggestion-text">What is the capital of Karnataka?</span>
                    <span className="suggestion-category">General chat</span>
                  </button>

                  <button
                    className="suggestion-box"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <span className="suggestion-text">Attach an image or PDF</span>
                    <span className="suggestion-category">Upload document</span>
                  </button>

                  <button
                    className="suggestion-box"
                    onClick={() => handleSend("Summarize the key information in this document")}
                  >
                    <span className="suggestion-text">Summarize key document points</span>
                    <span className="suggestion-category">Document analysis</span>
                  </button>

                  <button
                    className="suggestion-box"
                    onClick={() => handleSend("Extract all dates, figures, and amounts")}
                  >
                    <span className="suggestion-text">Extract all dates and numbers</span>
                    <span className="suggestion-category">Information extraction</span>
                  </button>
                </div>
              </div>
            ) : (
              messages.map((m) => {
                // User Message
                if (m.role === "user") {
                  return (
                    <div key={m.id} className="message-turn user-turn">
                      <div className="bubble user-bubble">
                        {m.attachedFile && (
                          <div className="attached-file-pill">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                              <polyline points="14 2 14 8 20 8" />
                            </svg>
                            <span>{m.attachedFile.name}</span>
                          </div>
                        )}
                        <div className="bubble-text">{m.text}</div>
                      </div>
                    </div>
                  );
                }

                // File Upload Card with Animated Scanning Effect
                if (m.fileInfo) {
                  const isScanning = m.isProcessing;
                  const isDone = m.stage === "ready";
                  const isFail = m.stage === "failed" || m.isError;
                  const isImg = m.fileInfo.isImage;

                  return (
                    <div key={m.id} className="message-turn assistant-turn">
                      <div className="bubble assistant-bubble file-process-bubble">
                        {/* 1. Image Preview with Active Laser Scanning Effect */}
                        {isImg ? (
                          <div className={`scan-card-image-wrap ${isScanning ? "is-scanning" : ""} ${isDone ? "is-ready" : ""}`}>
                            <div className="image-viewport-container">
                              <img
                                src={m.fileInfo.previewUrl || (m.fileInfo.id ? originalUrl(m.fileInfo.id) : "")}
                                alt={m.fileInfo.name}
                                className="scanned-image-preview"
                              />

                              {/* Horizontal laser scanning line moving top-to-bottom */}
                              {isScanning && (
                                <div className="scanning-laser-line">
                                  <div className="laser-beam"></div>
                                  <div className="laser-glow-trail"></div>
                                </div>
                              )}

                              {/* Subtle scanning grid overlay */}
                              {isScanning && <div className="scanning-grid-overlay"></div>}
                            </div>
                          </div>
                        ) : (
                          /* 2. PDF Document Card with Animated Page-Scanning Effect */
                          <div className={`scan-card-pdf-wrap ${isScanning ? "is-scanning-pdf" : ""} ${isDone ? "is-ready" : ""}`}>
                            <div className="pdf-card-media">
                              <div className="pdf-sheet-illustration">
                                <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                  <polyline points="14 2 14 8 20 8" />
                                  <line x1="16" y1="13" x2="8" y2="13" />
                                  <line x1="16" y1="17" x2="8" y2="17" />
                                  <line x1="10" y1="9" x2="8" y2="9" />
                                </svg>
                                {isScanning && <div className="pdf-scan-light-sweep"></div>}
                              </div>
                            </div>
                          </div>
                        )}

                        {/* File Details & Dynamic Processing Stages */}
                        <div className="file-process-meta-area">
                          <div className="file-title-row">
                            <span className="file-chip-badge">{m.fileInfo.type}</span>
                            <span className="file-title-text" title={m.fileInfo.name}>
                              {m.fileInfo.name}
                            </span>
                            <span className="file-size-muted">{formatSize(m.fileInfo.size)}</span>
                          </div>

                          {/* Dynamic Processing Status Indicator */}
                          <div className="stage-status-row">
                            {isScanning && (
                              <div className="active-stage-indicator">
                                <span className="radar-pulse-dot"></span>
                                <span className="stage-text-label">{m.stageText || "Reading content…"}</span>
                              </div>
                            )}

                            {isDone && (
                              <div className="ready-stage-indicator">
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.5">
                                  <polyline points="20 6 9 17 4 12" />
                                </svg>
                                <span className="stage-text-success">Document ready</span>
                              </div>
                            )}

                            {isFail && (
                              <div className="fail-stage-indicator">
                                <span className="fail-dot"></span>
                                <span className="stage-text-fail">Processing failed</span>
                                {m.fileId && (
                                  <button
                                    className="retry-process-btn"
                                    onClick={() => handleRetryProcessing(m.id, m.fileId, m.fileInfo.name)}
                                  >
                                    Retry
                                  </button>
                                )}
                              </div>
                            )}

                            {/* Optional Expandable Processing Details (Internal info hidden by default) */}
                            {isDone && (
                              <button
                                className="details-toggle-link"
                                onClick={() => toggleDetails(m.id)}
                              >
                                {detailsOpen[m.id] ? "Hide info" : "Processing details"}
                              </button>
                            )}
                          </div>

                          {/* Expandable Processing Details Content */}
                          {detailsOpen[m.id] && isDone && (
                            <div className="processing-details-panel">
                              <div className="detail-row">
                                <span className="detail-label">Status:</span>
                                <span className="detail-value">Completed & Indexed</span>
                              </div>
                              <div className="detail-row">
                                <span className="detail-label">Language:</span>
                                <span className="detail-value">
                                  {m.fileInfo.detected_language?.toUpperCase() || "Auto-detected"}
                                </span>
                              </div>
                              <div className="detail-row">
                                <span className="detail-label">Context:</span>
                                <span className="detail-value">Ready for natural questions</span>
                              </div>
                            </div>
                          )}
                        </div>

                        {/* Confirmation text once indexed */}
                        {m.text && isDone && (
                          <div className="post-upload-text">{m.text}</div>
                        )}
                        {m.text && isFail && (
                          <div className="post-upload-fail-text">{m.text}</div>
                        )}
                      </div>
                    </div>
                  );
                }

                // Assistant Regular Message
                return (
                  <div key={m.id} className="message-turn assistant-turn">
                    <div className={`bubble assistant-bubble ${m.isError ? "error-bubble" : ""}`}>
                      <div className="assistant-text-content">{m.text}</div>

                      {/* Optional Collapsed Citations */}
                      {m.sources && m.sources.length > 0 && (
                        <div className="sources-collapsible">
                          <button
                            className="sources-toggle-btn"
                            onClick={() => toggleDetails(`src-${m.id}`)}
                          >
                            <span>Sources ({m.sources.length})</span>
                            <svg
                              className={`chevron-icon ${detailsOpen[`src-${m.id}`] ? "rotated" : ""}`}
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                            >
                              <polyline points="6 9 12 15 18 9" />
                            </svg>
                          </button>

                          {detailsOpen[`src-${m.id}`] && (
                            <div className="sources-drawer">
                              {m.sources.map((s, idx) => (
                                <div key={idx} className="source-item">
                                  <div className="source-meta">
                                    <span className="source-file">{s.filename}</span>
                                    <span className="source-page">Page {s.page_number}</span>
                                  </div>
                                  <p className="source-quote">{s.text}</p>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      {!m.isError && (
                        <div className="assistant-footer-actions">
                          <button
                            className="copy-btn"
                            onClick={() => handleCopy(m.text, m.id)}
                            title="Copy message"
                          >
                            {copiedId === m.id ? (
                              <>
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <polyline points="20 6 9 17 4 12" />
                                </svg>
                                <span>Copied</span>
                              </>
                            ) : (
                              <>
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                                </svg>
                                <span>Copy</span>
                              </>
                            )}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}

            {/* Answer Generating Thinking State */}
            {loading && (
              <div className="message-turn assistant-turn">
                <div className="bubble assistant-bubble thinking-bubble">
                  <div className="thinking-row">
                    <span className="thinking-spinner"></span>
                    <span className="thinking-label">Thinking…</span>
                  </div>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        </main>

        {/* Floating Chat Input Area */}
        <div className="chat-input-wrapper">
          <div className="chat-input-box">
            {/* Active File Chip inside input bar */}
            {activeFile && (
              <div className="input-active-file-chip">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
                <span className="chip-name">{activeFile.filename}</span>
                <button
                  className="chip-remove-btn"
                  onClick={() => setActiveFile(null)}
                  title="Detach document (Switch to normal chat)"
                >
                  ✕
                </button>
              </div>
            )}

            <div className="input-row">
              {/* Paperclip File Upload Button */}
              <input
                ref={fileInputRef}
                type="file"
                accept=".jpg,.jpeg,.png,.pdf"
                style={{ display: "none" }}
                onChange={(e) => {
                  if (e.target.files && e.target.files[0]) {
                    handleUploadFile(e.target.files[0]);
                  }
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                className="attach-file-btn"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading || loading}
                title="Attach PDF or image"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                </svg>
              </button>

              {/* Text Input Area */}
              <textarea
                ref={textareaRef}
                className="chat-textarea"
                rows={1}
                value={input}
                placeholder={
                  activeFile
                    ? `Ask about ${activeFile.filename}…`
                    : "Message or attach a document…"
                }
                onChange={handleInputChange}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
              />

              {/* Send Button */}
              <button
                type="button"
                className="send-message-btn"
                disabled={loading || uploading || !input.trim()}
                onClick={() => handleSend()}
                title="Send"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13" />
                  <polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
              </button>
            </div>
          </div>

          <div className="input-footer-text">
            Attach PDFs or images directly in chat. Ask questions to query document content or chat freely.
          </div>
        </div>
      </div>
    </div>
  );
}
