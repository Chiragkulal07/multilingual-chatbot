import { useEffect, useRef, useState } from "react";
import { askQuestion, getUsage } from "../api";

export default function Chat({ files, onSelectFile }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [scope, setScope] = useState("all");
  const [answerLang, setAnswerLang] = useState("auto");
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState(null);
  const listRef = useRef(null);

  const activeScope = scope === "all" || files.some((f) => f.file_id === scope) ? scope : "all";

  useEffect(() => {
    getUsage().then(setUsage).catch(() => {});
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, loading]);

  const handleCopy = (text, index) => {
    navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  const send = async (overrideText) => {
    const question = (overrideText || input).trim();
    if (!question || loading) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", text: question }]);
    setLoading(true);
    try {
      const res = await askQuestion(question, activeScope === "all" ? null : [activeScope], answerLang);
      setMessages((m) => [...m, { role: "assistant", ...res }]);
      if (res.gemini_daily_limit !== undefined) {
        setUsage({ gemini_calls_today: res.gemini_calls_today, gemini_daily_limit: res.gemini_daily_limit });
      }
    } catch (e) {
      const error = e.message === "Failed to fetch" ? "Cannot reach the backend. Check port 8000." : e.message;
      setMessages((m) => [...m, { role: "assistant", error }]);
      getUsage().then(setUsage).catch(() => {});
    } finally {
      setLoading(false);
    }
  };

  const handlePromptCard = (prompt, targetLang = "auto") => {
    setAnswerLang(targetLang);
    setInput(prompt);
    send(prompt);
  };

  return (
    <div className="center-workspace">
      {/* Background Decorative Warm Shapes */}
      <div className="bg-glow bg-glow-left"></div>
      <div className="bg-glow bg-glow-right"></div>

      <div className="center-thread" ref={listRef}>
        {messages.length === 0 ? (
          <div className="welcome-hero-section">
            <div className="hero-sparkle-badge">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
                <path
                  d="M12 2L14.2 9.8L22 12L14.2 14.2L12 22L9.8 14.2L2 12L9.8 9.8L12 2Z"
                  fill="url(#sparkle-grad)"
                />
                <defs>
                  <linearGradient id="sparkle-grad" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
                    <stop stopColor="#e05d26" />
                    <stop offset="1" stopColor="#f59e0b" />
                  </linearGradient>
                </defs>
              </svg>
            </div>

            <h1 className="hero-main-title">
              Hello, I'm <span className="title-serif-highlight">DocuSense AI</span>
            </h1>
            <h2 className="hero-secondary-title">Ask anything about your documents</h2>
            <p className="hero-description">
              Get precise, grounded answers backed by verified source citations across English, Hindi, and Kannada.
            </p>

            {/* 2x2 Suggestion Cards Matching the User's Screenshot Exactly */}
            <div className="hero-cards-grid">
              {/* Card 1: Orange */}
              <div
                className="hero-card"
                role="button"
                tabIndex={0}
                onClick={() => handlePromptCard("Summarize key points from the uploaded documents")}
              >
                <div className="card-icon-box box-orange">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                </div>
                <div className="card-text-group">
                  <span className="card-title">Summarize key points</span>
                  <span className="card-sub">from the uploaded documents</span>
                </div>
                <svg className="card-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </div>

              {/* Card 2: Green */}
              <div
                className="hero-card"
                role="button"
                tabIndex={0}
                onClick={() => handlePromptCard("List all important dates, figures, and numerical amounts")}
              >
                <div className="card-icon-box box-green">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                    <line x1="16" y1="2" x2="16" y2="6" />
                    <line x1="8" y1="2" x2="8" y2="6" />
                    <line x1="3" y1="10" x2="21" y2="10" />
                  </svg>
                </div>
                <div className="card-text-group">
                  <span className="card-title">List all important dates,</span>
                  <span className="card-sub">figures, and amounts</span>
                </div>
                <svg className="card-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </div>

              {/* Card 3: Purple */}
              <div
                className="hero-card"
                role="button"
                tabIndex={0}
                onClick={() => handlePromptCard("मुख्य बिंदु हिन्दी में बताएं", "hi")}
              >
                <div className="card-icon-box box-purple">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 8l6 6" />
                    <path d="M4 14l6-6 2-3" />
                    <path d="M2 5h12" />
                    <path d="M7 2h1" />
                    <path d="M22 22l-5-10-5 10" />
                    <path d="M14 18h6" />
                  </svg>
                </div>
                <div className="card-text-group">
                  <span className="card-title">Summarize in Hindi</span>
                  <span className="card-sub">(मुख्य बिंदु हिन्दी में बताएं)</span>
                </div>
                <svg className="card-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </div>

              {/* Card 4: Blue */}
              <div
                className="hero-card"
                role="button"
                tabIndex={0}
                onClick={() => handlePromptCard("ಪ್ರಮುಖಾಂಶಗಳನ್ನು ಕನ್ನಡದಲ್ಲಿ ತಿಳಿಸಿ", "kn")}
              >
                <div className="card-icon-box box-blue">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="2" y1="12" x2="22" y2="12" />
                    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                  </svg>
                </div>
                <div className="card-text-group">
                  <span className="card-title">Summarize in Kannada</span>
                  <span className="card-sub">(ಪ್ರಮುಖಾಂಶಗಳನ್ನು ಕನ್ನಡದಲ್ಲಿ ತಿಳಿಸಿ)</span>
                </div>
                <svg className="card-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </div>
            </div>
          </div>
        ) : (
          <div className="messages-stream">
            <div className="chat-stream-header">
              <span className="stream-badge">Conversation Active</span>
              <button className="clear-stream-btn" onClick={() => setMessages([])}>
                Clear thread
              </button>
            </div>

            {messages.map((m, i) => {
              if (m.role === "user") {
                return (
                  <div key={i} className="message-row user-row">
                    <div className="message-bubble user-bubble">
                      <div className="bubble-text">{m.text}</div>
                    </div>
                  </div>
                );
              }

              if (m.error) {
                return (
                  <div key={i} className="message-row assistant-row">
                    <div className="message-bubble error-bubble">
                      <div className="bubble-error-header">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <circle cx="12" cy="12" r="10" />
                          <line x1="12" y1="8" x2="12" y2="12" />
                          <line x1="12" y1="16" x2="12.01" y2="16" />
                        </svg>
                        <span>Error</span>
                      </div>
                      <div className="bubble-error-msg">{m.error}</div>
                    </div>
                  </div>
                );
              }

              return (
                <div key={i} className="message-row assistant-row">
                  <div className={`message-bubble assistant-bubble ${m.answerable ? "" : "no-answer"}`}>
                    <div className="assistant-card-header">
                      <div className="assistant-tag">
                        <span className="terracotta-sparkle">✦</span>
                        <span>DocuSense</span>
                      </div>

                      <div className="assistant-actions">
                        {m.cached && <span className="cache-pill">⚡ Cached</span>}
                        <button
                          className="copy-answer-btn"
                          onClick={() => handleCopy(m.answer, i)}
                          title="Copy Answer"
                        >
                          {copiedIndex === i ? "Copied" : "Copy"}
                        </button>
                      </div>
                    </div>

                    <div className="assistant-answer-body">{m.answer}</div>

                    {m.sources?.length > 0 && (
                      <div className="assistant-sources-box">
                        <div className="sources-header-bar">
                          <span>Grounding Sources ({m.sources.length})</span>
                        </div>
                        <div className="sources-list-cards">
                          {m.sources.map((s) => (
                            <div key={s.chunk_id} className="source-card">
                              <div className="source-card-top">
                                <span className="source-doc-name">{s.filename}</span>
                                <span className="source-page-tag">
                                  {s.file_type === "pdf" ? `Page ${s.page_number}` : "Image"}
                                </span>
                                <span className="source-score-tag">
                                  {Math.round(s.score * 100)}% match
                                </span>
                              </div>
                              <p className="source-snippet">{s.text}</p>
                              <div className="source-inspect-row">
                                <button
                                  className="inspect-source-btn"
                                  onClick={() => onSelectFile(s.file_id, s.page_number, s.text)}
                                >
                                  Inspect in Document →
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            {loading && (
              <div className="message-row assistant-row">
                <div className="message-bubble assistant-bubble loading-bubble">
                  <span className="loading-dot dot-1"></span>
                  <span className="loading-dot dot-2"></span>
                  <span className="loading-dot dot-3"></span>
                  <span className="loading-msg">Searching documents & generating verified response…</span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Modern Floating Chat Input Box Matching Screenshot */}
      <div className="center-input-anchor">
        <div className="floating-input-card">
          <form
            className="input-card-form"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <input
              className="main-chat-input"
              value={input}
              placeholder="Ask anything about the indexed documents... (Press Enter)"
              maxLength={1000}
              onChange={(e) => setInput(e.target.value)}
              disabled={loading}
            />

            <div className="input-card-bottom-row">
              <div className="scope-select-pill">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <ellipse cx="12" cy="5" rx="9" ry="3" />
                  <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
                  <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
                </svg>
                <select
                  className="scope-dropdown"
                  value={activeScope}
                  onChange={(e) => setScope(e.target.value)}
                >
                  <option value="all">All Documents ({files.length})</option>
                  {files.map((f) => (
                    <option key={f.file_id} value={f.file_id}>
                      {f.filename}
                    </option>
                  ))}
                </select>
                <svg className="dropdown-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </div>

              <button
                type="submit"
                className="terracotta-send-btn"
                disabled={loading || !input.trim()}
                title="Send Question"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13" />
                  <polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
              </button>
            </div>
          </form>
        </div>

        <div className="input-card-subtext-bar">
          <div className="grounding-badge">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#c85627" strokeWidth="2">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
            <span>Grounded with OCR & vector similarity</span>
          </div>

          <div className="api-calls-quota">
            Daily API Calls: {usage ? `${usage.gemini_calls_today} / ${usage.gemini_daily_limit}` : "3 / 15"}
          </div>
        </div>
      </div>
    </div>
  );
}
