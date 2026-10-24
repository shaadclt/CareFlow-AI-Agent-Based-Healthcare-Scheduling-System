
import { useEffect, useState } from "react";

import {
  Activity,
  BarChart3,
  Bot,
  CalendarDays,
  CheckCircle2,
  Clock,
  Database,
  FileJson,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  Stethoscope,
  Trash2,
  Upload,
  UserRound,
  Users,
} from "lucide-react";

import { sendMessage } from "./services/api";
import "./App.css";

const API_BASE_URL = (
  import.meta.env.VITE_API_URL || ""
).replace(/\/$/, "");

function createThreadId() {
  return crypto.randomUUID();
}

const INITIAL_MESSAGE = {
  role: "assistant",
  content:
    "Hello! I can help you find a doctor and schedule an appointment. What would you like to do?",
};

const EMPTY_APPOINTMENT = {
  doctor: "",
  specialty: "",
  date: "",
  time: "",
  patient: "",
};

async function requestJson(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, options);

  let data = {};

  try {
    data = await response.json();
  } catch {
    // Some errors may not return JSON.
  }

  if (!response.ok) {
    const detail = data.detail;

    const message =
      typeof detail === "string"
        ? detail
        : detail?.message ||
          (Array.isArray(detail?.errors)
            ? detail.errors.join("\n")
            : "") ||
          `Request failed with status ${response.status}.`;

    throw new Error(message);
  }

  return data;
}

function toFileFormData(file) {
  const formData = new FormData();
  formData.append("file", file);
  return formData;
}

function App() {
  const [activeView, setActiveView] = useState("chat");
  const [adminToken, setAdminToken] = useState("");
  const [adminUsername, setAdminUsername] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState("");

  // Existing scheduling assistant state.
  const [threadId, setThreadId] = useState(() => createThreadId());
  const [messages, setMessages] = useState([INITIAL_MESSAGE]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("ready");
  const [appointment, setAppointment] = useState(EMPTY_APPOINTMENT);

  // Doctor administration state.
  const [doctorFile, setDoctorFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [importResult, setImportResult] = useState(null);
  const [adminLoading, setAdminLoading] = useState(false);
  const [adminError, setAdminError] = useState("");
  const [summary, setSummary] = useState(null);
  const [doctors, setDoctors] = useState([]);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [directoryError, setDirectoryError] = useState("");

  // Persistent observability dashboard state.
  const [observability, setObservability] = useState(null);
  const [observabilityLoading, setObservabilityLoading] = useState(false);
  const [observabilityError, setObservabilityError] = useState("");

  const adminRequestJson = (path, options = {}) => {
    const headers = new Headers(options.headers || {});
    if (adminToken) headers.set("Authorization", `Bearer ${adminToken}`);
    return requestJson(path, { ...options, headers });
  };

  const handleAdminLogin = async (event) => {
    event.preventDefault();
    setLoginLoading(true);
    setLoginError("");
    try {
      const result = await requestJson("/api/v1/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: adminUsername.trim(),
          password: adminPassword,
        }),
      });
      setAdminToken(result.access_token);
      setAdminPassword("");
      setActiveView("admin");
    } catch (error) {
      setLoginError(error.message || "Unable to sign in.");
    } finally {
      setLoginLoading(false);
    }
  };

  const handleAdminLogout = () => {
    setAdminToken("");
    setAdminPassword("");
    setAdminUsername("");
    setPreview(null);
    setDoctorFile(null);
    setImportResult(null);
    setDoctors([]);
    setSummary(null);
    setAdminError("");
    setDirectoryError("");
    setActiveView("chat");
  };

  // ==========================================================
  // Start a new conversation
  // ==========================================================

  const startNewConversation = () => {
    setThreadId(createThreadId());
    setMessages([INITIAL_MESSAGE]);
    setInput("");
    setLoading(false);
    setStatus("ready");
    setAppointment({ ...EMPTY_APPOINTMENT });
  };

  // ==========================================================
  // Send a scheduling message
  // ==========================================================

  const handleSubmit = async (event) => {
    event.preventDefault();

    const query = input.trim();

    if (!query || loading) {
      return;
    }

    setMessages((previous) => [
      ...previous,
      { role: "user", content: query },
    ]);

    setInput("");
    setLoading(true);

    try {
      const result = await sendMessage(query, threadId);

      setMessages((previous) => [
        ...previous,
        {
          role: "assistant",
          content:
            result.response || "I couldn't generate a response.",
        },
      ]);

      setStatus(result.status || "completed");
      updateAppointmentFromTrace(result.trace || []);
    } catch (error) {
      console.error("Scheduling error:", error);

      setMessages((previous) => [
        ...previous,
        {
          role: "assistant",
          content:
            "Sorry, I couldn't connect to the scheduling service. Please make sure the scheduling service is running.",
        },
      ]);

      setStatus("error");
    } finally {
      setLoading(false);
    }
  };

  // ==========================================================
  // Parse appointment details from the agent trace
  // ==========================================================

  const updateAppointmentFromTrace = (items) => {
    if (!Array.isArray(items) || items.length === 0) {
      return;
    }

    const analyzeNodes = items.filter(
      (item) => item && item.node === "analyze_request"
    );

    if (analyzeNodes.length === 0) {
      return;
    }

    const latest = analyzeNodes[analyzeNodes.length - 1];
    const parsed = parseTraceDetails(latest.details);

    if (!parsed) {
      return;
    }

    if (
      parsed.intent === "doctor_search" ||
      parsed.intent === "availability_dates"
    ) {
      setAppointment({
        doctor: parsed.doctor_name || "",
        specialty: parsed.specialty || "",
        date: "",
        time: "",
        patient: "",
      });

      return;
    }

    if (parsed.intent === "appointment_booking") {
      setAppointment((previous) => ({
        doctor: parsed.doctor_name || previous.doctor,
        specialty: parsed.specialty || previous.specialty,
        date: parsed.appointment_date || previous.date,
        time: parsed.appointment_time || previous.time,
        patient: parsed.patient_name || previous.patient,
      }));
    }
  };

  // ==========================================================
  // Load doctor directory and summary
  // ==========================================================

  const loadDoctorDirectory = async () => {
    setDirectoryLoading(true);
    setDirectoryError("");

    try {
      const [summaryData, directoryData] = await Promise.all([
        adminRequestJson("/api/v1/admin/doctors/summary"),
        adminRequestJson("/api/v1/admin/doctors"),
      ]);

      setSummary(summaryData);

      setDoctors(
        Array.isArray(directoryData.doctors)
          ? directoryData.doctors
          : []
      );
    } catch (error) {
      console.error("Doctor directory request failed:", error);
      setDirectoryError(error.message);
    } finally {
      setDirectoryLoading(false);
    }
  };

  const loadObservability = async () => {
    setObservabilityLoading(true);
    setObservabilityError("");
    try {
      const result = await adminRequestJson("/api/v1/admin/observability");
      setObservability(result);
    } catch (error) {
      setObservabilityError(
        error.message || "Could not load observability metrics."
      );
    } finally {
      setObservabilityLoading(false);
    }
  };

  useEffect(() => {
    if (activeView === "admin" && adminToken) {
      loadDoctorDirectory();
    }
    if (activeView === "observability" && adminToken) {
      loadObservability();
    }
  }, [activeView, adminToken]);

  // ==========================================================
  // Handle doctor JSON file selection
  // ==========================================================

  const handleFileChange = (event) => {
    const file = event.target.files?.[0] || null;

    setDoctorFile(file);
    setPreview(null);
    setImportResult(null);
    setAdminError("");

    if (file && !file.name.toLowerCase().endsWith(".json")) {
      setAdminError("Please choose a .json file.");
    } else if (file && file.size > 2 * 1024 * 1024) {
      setAdminError("The selected file exceeds the 2 MB limit.");
    }
  };

  // ==========================================================
  // Validate and preview doctor JSON
  // ==========================================================

  const handlePreview = async () => {
    if (!doctorFile) {
      setAdminError("Choose a JSON file first.");
      return;
    }

    if (!doctorFile.name.toLowerCase().endsWith(".json")) {
      setAdminError("Please choose a .json file.");
      return;
    }

    if (doctorFile.size > 2 * 1024 * 1024) {
      setAdminError("The selected file exceeds the 2 MB limit.");
      return;
    }

    setAdminLoading(true);
    setAdminError("");
    setPreview(null);
    setImportResult(null);

    try {
      const result = await adminRequestJson(
        "/api/v1/admin/doctors/preview",
        {
          method: "POST",
          body: toFileFormData(doctorFile),
        }
      );

      setPreview(result);

      if (!result.valid) {
        setAdminError(
          (result.errors || []).join("\n") ||
            "The file did not pass validation."
        );
      }
    } catch (error) {
      setAdminError(error.message);
    } finally {
      setAdminLoading(false);
    }
  };

  // ==========================================================
  // Explicit database initialization/import
  // ==========================================================

  const handleInitialize = async () => {
    if (!doctorFile || !preview?.valid) {
      setAdminError(
        "Choose a file and complete a successful preview first."
      );
      return;
    }

    const confirmed = window.confirm(
      "Import these doctor records? Existing matching doctors may be updated. Records omitted from the file will not be deleted."
    );

    if (!confirmed) {
      return;
    }

    setAdminLoading(true);
    setAdminError("");
    setImportResult(null);

    try {
      const result = await adminRequestJson(
        "/api/v1/admin/doctors/initialize",
        {
          method: "POST",
          body: toFileFormData(doctorFile),
        }
      );

      setImportResult(result);
      setPreview(null);
      setDoctorFile(null);

      const fileInput = document.getElementById("doctor-json-file");

      if (fileInput) {
        fileInput.value = "";
      }

      await loadDoctorDirectory();
    } catch (error) {
      setAdminError(error.message);
    } finally {
      setAdminLoading(false);
    }
  };

  // ==========================================================
  // Reset the complete doctor directory
  // ==========================================================

  const handleResetDoctorDirectory = async () => {
    const confirmed = window.confirm(
      "RESET THE DOCTOR DIRECTORY? This permanently deletes all doctors, their availability slots, and all appointments. Patient records will be retained. This cannot be undone. Continue only if you have a backup or intend to re-import the directory."
    );
    if (!confirmed) return;

    const secondConfirmation = window.prompt(
      'Type RESET to confirm deletion of the doctor directory and appointments.'
    );
    if (secondConfirmation !== "RESET") {
      setAdminError("Reset cancelled. You must type RESET exactly to confirm.");
      return;
    }

    setAdminLoading(true);
    setAdminError("");
    setDirectoryError("");
    setImportResult(null);
    setPreview(null);

    try {
      const result = await adminRequestJson(
        "/api/v1/admin/doctors/reset",
        { method: "POST" }
      );
      setDoctorFile(null);
      const fileInput = document.getElementById("doctor-json-file");
      if (fileInput) fileInput.value = "";
      setImportResult({
        reset: true,
        message: result.message,
        total_processed: 0,
        inserted: 0,
        updated: 0,
        total_doctors: 0,
        ...result,
      });
      await loadDoctorDirectory();
    } catch (error) {
      setAdminError(error.message || "Could not reset the doctor directory.");
    } finally {
      setAdminLoading(false);
    }
  };

  // ==========================================================
  // Render application
  // ==========================================================

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <div className="brand-icon">
            <Activity size={22} />
          </div>

          <div>
            <h1>CareFlow AI</h1>
            <p>Agentic Healthcare Scheduling</p>
          </div>
        </div>

        <div className="header-actions">
          <div className="status-indicator">
            <span />
            Agent Online
          </div>

          {activeView === "chat" && (
            <button
              type="button"
              className="new-chat-button"
              onClick={startNewConversation}
            >
              <Plus size={16} />
              New Conversation
            </button>
          )}
        </div>
      </header>

      <nav className="view-tabs" aria-label="Application views">
        <button
          type="button"
          className={`view-tab ${
            activeView === "chat" ? "active" : ""
          }`}
          onClick={() => setActiveView("chat")}
        >
          <Bot size={17} />
          Scheduling Assistant
        </button>

        <button
          type="button"
          className={`view-tab ${
            activeView === "admin" ? "active" : ""
          }`}
          onClick={() => setActiveView("admin")}
        >
          <Database size={17} />
          {adminToken ? "Doctor Management" : "Admin Login"}
        </button>

        {adminToken && (
          <button
            type="button"
            className={`view-tab ${activeView === "observability" ? "active" : ""}`}
            onClick={() => setActiveView("observability")}
          >
            <BarChart3 size={17} />
            Observability
          </button>
        )}
      </nav>

      {activeView === "chat" ? (
        <main className="dashboard">
          <section className="chat-section">
            <div className="section-header">
              <div>
                <h2>Scheduling Assistant</h2>
                <p>
                  Talk naturally with the AI scheduling agent.
                </p>
              </div>
            </div>

            <div className="messages">
              {messages.map((message, index) => (
                <div
                  key={`${index}-${message.role}`}
                  className={`message ${message.role}`}
                >
                  <div className="message-icon">
                    {message.role === "assistant" ? (
                      <Bot size={17} />
                    ) : (
                      <UserRound size={17} />
                    )}
                  </div>

                  <div className="message-content">
                    {message.content}
                  </div>
                </div>
              ))}

              {loading && (
                <div className="message assistant">
                  <div className="message-icon">
                    <Bot size={17} />
                  </div>

                  <div className="message-content loading-message">
                    <span className="loading-dot" />
                    <span className="loading-dot" />
                    <span className="loading-dot" />
                    <span className="loading-text">
                      Processing...
                    </span>
                  </div>
                </div>
              )}
            </div>

            <form className="input-area" onSubmit={handleSubmit}>
              <input
                type="text"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="e.g. I need to see a dermatologist..."
                disabled={loading}
                autoComplete="off"
              />

              <button
                type="submit"
                disabled={loading || !input.trim()}
                aria-label="Send message"
              >
                <Send size={18} />
              </button>
            </form>
          </section>

          <aside className="sidebar">
            <AppointmentCard
              appointment={appointment}
              status={status}
            />
          </aside>
        </main>
      ) : activeView === "observability" && adminToken ? (
        <ObservabilityPage
          data={observability}
          loading={observabilityLoading}
          error={observabilityError}
          onRefresh={loadObservability}
          onBack={() => setActiveView("admin")}
        />
      ) : !adminToken ? (
        <main className="admin-login-page">
          <form className="admin-login-card" onSubmit={handleAdminLogin}>
            <div className="admin-login-icon"><ShieldCheck size={28} /></div>
            <p className="eyebrow">RESTRICTED ACCESS</p>
            <h2>Administrator login</h2>
            <p className="admin-login-description">
              Sign in with your authorized administrator credentials to manage the doctor directory.
            </p>
            <label htmlFor="admin-username">Username</label>
            <input
              id="admin-username"
              type="text"
              autoComplete="username"
              value={adminUsername}
              onChange={(event) => setAdminUsername(event.target.value)}
              required
            />
            <label htmlFor="admin-password">Password</label>
            <input
              id="admin-password"
              type="password"
              autoComplete="current-password"
              value={adminPassword}
              onChange={(event) => setAdminPassword(event.target.value)}
              required
            />
            {loginError && <div className="feedback error-feedback" role="alert">{loginError}</div>}
            <button className="primary-button admin-login-submit" type="submit" disabled={loginLoading}>
              {loginLoading ? "Signing in..." : "Sign in"}
            </button>
          </form>
        </main>
      ) : (
        <main className="admin-page">
          <div className="admin-heading">
            <div>
              <p className="eyebrow">ADMINISTRATION</p>
              <h2>Doctor Management</h2>
              <p>
                Upload a JSON file, review its records, and explicitly
                import the validated doctors into the database.
              </p>
            </div>

            <div className="admin-heading-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={loadDoctorDirectory}
                disabled={directoryLoading}
              >
                <RefreshCw size={16} />
                Refresh directory
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={handleResetDoctorDirectory}
                disabled={adminLoading || directoryLoading}
                title="Permanently delete doctors, availability, and appointments"
              >
                <Trash2 size={16} />
                Reset directory
              </button>
              <button type="button" className="secondary-button" onClick={handleAdminLogout}>
                Sign out
              </button>
            </div>
          </div>

          <section className="summary-grid">
            <SummaryCard
              icon={<Users size={21} />}
              label="Total doctors"
              value={summary?.total_doctors ?? "—"}
            />

            <SummaryCard
              icon={<Stethoscope size={21} />}
              label="Specialties"
              value={summary?.total_specialties ?? "—"}
            />

            <SummaryCard
              icon={<ShieldCheck size={21} />}
              label="File validation"
              value={
                preview
                  ? preview.valid
                    ? "Passed"
                    : "Failed"
                  : "Pending"
              }
            />
          </section>

          <section className="admin-card">
            <div className="admin-card-heading">
              <div className="admin-card-icon">
                <FileJson size={21} />
              </div>

              <div>
                <h3>Import doctors from JSON</h3>
                <p>
                  JSON array · Maximum 2 MB · Preview before importing
                </p>
              </div>
            </div>

            <label
              className="file-drop"
              htmlFor="doctor-json-file"
            >
              <Upload size={26} />

              <strong>
                {doctorFile
                  ? doctorFile.name
                  : "Choose your doctors.json file"}
              </strong>

              <span>
                {doctorFile
                  ? `${(doctorFile.size / 1024).toFixed(1)} KB`
                  : "Choose a JSON file from your computer"}
              </span>

              <input
                id="doctor-json-file"
                type="file"
                accept=".json,application/json"
                onChange={handleFileChange}
              />
            </label>

            <div className="admin-actions">
              <button
                type="button"
                className="primary-button"
                onClick={handlePreview}
                disabled={!doctorFile || adminLoading}
              >
                {adminLoading
                  ? "Please wait..."
                  : "Validate and preview"}
              </button>

              <button
                type="button"
                className="initialize-button"
                onClick={handleInitialize}
                disabled={
                  !doctorFile || !preview?.valid || adminLoading
                }
              >
                <Database size={17} />
                Initialize database
              </button>
            </div>

            <p className="helper-text">
              Preview does not change the database. Import can insert
              new doctors and update existing matching records.
              Omitted doctors are not automatically deleted.
            </p>

            {adminError && (
              <div
                className="feedback error-feedback"
                role="alert"
              >
                <strong>Action required</strong>
                <pre>{adminError}</pre>
              </div>
            )}

            {preview?.valid && (
              <div
                className="feedback success-feedback"
                role="status"
              >
                <CheckCircle2 size={19} />

                <div>
                  <strong>Validation successful</strong>

                  <p>
                    {preview.total_doctors ??
                      preview.doctors?.length ??
                      0}{" "}
                    doctor records are ready to import.
                    {preview.preview_truncated
                      ? " Only the first 100 records are shown below."
                      : ""}
                  </p>
                </div>
              </div>
            )}

            {importResult && (
              <div
                className="feedback success-feedback"
                role="status"
              >
                <CheckCircle2 size={19} />

                <div>
                  <strong>{importResult.reset ? "Directory reset completed" : "Import completed"}</strong>

                  {importResult.reset ? (
                    <p>
                      Deleted {importResult.doctors_deleted ?? 0} doctors, {importResult.availability_slots_deleted ?? 0} availability slots, and {importResult.appointments_deleted ?? 0} appointments. Patient records were retained.
                    </p>
                  ) : (
                    <p>
                      Successfully processed {importResult.total_processed ?? 0} doctor records.
                    </p>
                  )}

                  <p>
                    Inserted: {importResult.inserted ?? 0} · Updated:{" "}
                    {importResult.updated ?? 0} · Total in database:{" "}
                    {importResult.total_doctors ?? "—"}
                  </p>
                </div>
              </div>
            )}

            {preview?.doctors?.length > 0 && (
              <div className="preview-table-wrap">
                <h4>Preview records</h4>
                <DoctorTable doctors={preview.doctors} />
              </div>
            )}
          </section>

          <section className="admin-card">
            <div className="admin-card-heading">
              <div className="admin-card-icon">
                <Stethoscope size={21} />
              </div>

              <div>
                <h3>Doctor directory</h3>
                <p>Records currently stored in the database</p>
              </div>
            </div>

            {directoryLoading ? (
              <p className="empty-directory">
                Loading doctor directory...
              </p>
            ) : directoryError ? (
              <div
                className="feedback error-feedback"
                role="alert"
              >
                <strong>Could not load the directory</strong>
                <pre>{directoryError}</pre>
              </div>
            ) : doctors.length ? (
              <DoctorTable doctors={doctors} />
            ) : (
              <div className="empty-directory">
                <Stethoscope size={28} />
                <strong>No doctors found</strong>
                <p>
                  Import a validated JSON file to populate the directory.
                </p>
              </div>
            )}
          </section>
        </main>
      )}
    </div>
  );
}

// ============================================================
// Observability dashboard
// ============================================================

function formatNumber(value, digits = 0) {
  const number = Number(value ?? 0);
  return Number.isFinite(number)
    ? number.toLocaleString(undefined, { maximumFractionDigits: digits })
    : "0";
}

function ObservabilityPage({ data, loading, error, onRefresh, onBack }) {
  const http = data?.http || {};
  const workflows = data?.workflows || {};

  return (
    <main className="admin-page observability-page">
      <div className="admin-heading">
        <div>
          <p className="eyebrow">SYSTEM HEALTH</p>
          <h2>Observability Dashboard</h2>
          <p>
            Persistent API and scheduling-workflow metrics collected by the backend.
            Metrics exclude request bodies, patient names, and conversation IDs.
          </p>
          {data?.generated_at && (
            <p className="observability-generated">
              Last refreshed: {new Date(data.generated_at).toLocaleString()}
            </p>
          )}
        </div>
        <div className="admin-heading-actions">
          <button type="button" className="secondary-button" onClick={onRefresh} disabled={loading}>
            <RefreshCw size={16} />
            {loading ? "Refreshing..." : "Refresh metrics"}
          </button>
          <button type="button" className="secondary-button" onClick={onBack}>
            Doctor Management
          </button>
        </div>
      </div>

      {error && (
        <div className="feedback error-feedback" role="alert">
          <strong>Could not load observability data</strong>
          <pre>{error}</pre>
        </div>
      )}

      {loading && !data ? (
        <div className="admin-card"><p>Loading observability metrics...</p></div>
      ) : (
        <>
          <section className="summary-grid observability-summary-grid">
            <SummaryCard icon={<Activity size={21} />} label="HTTP requests" value={formatNumber(http.total_requests)} />
            <SummaryCard icon={<ShieldCheck size={21} />} label="Failed HTTP requests" value={formatNumber(http.failed_requests)} />
            <SummaryCard icon={<Clock size={21} />} label="Average API latency" value={`${formatNumber(http.avg_latency_ms, 2)} ms`} />
            <SummaryCard icon={<Bot size={21} />} label="Scheduling workflows" value={formatNumber(workflows.total)} />
            <SummaryCard icon={<CheckCircle2 size={21} />} label="Booking completions" value={formatNumber(workflows.completed)} />
            <SummaryCard icon={<Clock size={21} />} label="Average workflow duration" value={`${formatNumber(workflows.avg_duration_ms, 2)} ms`} />
          </section>

          <section className="admin-card">
            <div className="admin-card-heading">
              <div className="admin-card-icon"><Activity size={21} /></div>
              <div><h3>API routes</h3><p>Request volume, average latency, and failures by route</p></div>
            </div>
            {http.routes?.length ? (
              <div className="doctor-table-wrap">
                <table className="doctor-table observability-table">
                  <thead><tr><th>Method</th><th>Route</th><th>Requests</th><th>Avg latency</th><th>Failures</th></tr></thead>
                  <tbody>{http.routes.map((route, index) => (
                    <tr key={`${route.method}-${route.path}-${index}`}>
                      <td><span className="method-pill">{route.method}</span></td>
                      <td><code>{route.path}</code></td>
                      <td>{formatNumber(route.requests)}</td>
                      <td>{formatNumber(route.avg_latency_ms, 2)} ms</td>
                      <td>{formatNumber(route.failures)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            ) : <div className="empty-directory"><Activity size={28} /><strong>No API metrics yet</strong><p>Requests will appear here after the metrics store is initialized and traffic reaches the API.</p></div>}
          </section>

          <section className="admin-card">
            <div className="admin-card-heading">
              <div className="admin-card-icon"><Bot size={21} /></div>
              <div><h3>Recent scheduling workflows</h3><p>Latest workflow outcomes and execution duration</p></div>
            </div>
            {workflows.recent?.length ? (
              <div className="doctor-table-wrap">
                <table className="doctor-table observability-table">
                  <thead><tr><th>Time (UTC)</th><th>Status</th><th>Outcome</th><th>Duration</th><th>Trace nodes</th></tr></thead>
                  <tbody>{workflows.recent.map((item, index) => (
                    <tr key={`${item.created_at}-${index}`}>
                      <td>{item.created_at ? new Date(item.created_at).toLocaleString() : "—"}</td>
                      <td>{item.workflow_status || "—"}</td>
                      <td><span className={`outcome-pill ${item.outcome === "booking_completed" ? "outcome-success" : item.outcome === "failure" ? "outcome-failure" : ""}`}>{item.outcome || "—"}</span></td>
                      <td>{formatNumber(item.duration_ms, 2)} ms</td>
                      <td>{formatNumber(item.trace_node_count)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            ) : <div className="empty-directory"><Bot size={28} /><strong>No workflow metrics yet</strong><p>Send a scheduling request to start collecting workflow metrics.</p></div>}
          </section>

          <section className="admin-card">
            <div className="admin-card-heading">
              <div className="admin-card-icon"><Clock size={21} /></div>
              <div><h3>Recent HTTP requests</h3><p>Latest API request outcomes</p></div>
            </div>
            {http.recent?.length ? (
              <div className="doctor-table-wrap">
                <table className="doctor-table observability-table">
                  <thead><tr><th>Time (UTC)</th><th>Method</th><th>Route</th><th>Status</th><th>Duration</th></tr></thead>
                  <tbody>{http.recent.map((item, index) => (
                    <tr key={`${item.created_at}-${index}`}>
                      <td>{item.created_at ? new Date(item.created_at).toLocaleString() : "—"}</td>
                      <td><span className="method-pill">{item.method}</span></td>
                      <td><code>{item.path}</code></td>
                      <td><span className={`outcome-pill ${item.status_code < 400 ? "outcome-success" : "outcome-failure"}`}>{item.status_code}</span></td>
                      <td>{formatNumber(item.duration_ms, 2)} ms</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            ) : <div className="empty-directory"><Clock size={28} /><strong>No HTTP metrics yet</strong><p>API request history will appear here as requests are recorded.</p></div>}
          </section>
        </>
      )}
    </main>
  );
}

// ============================================================
// Summary card
// ============================================================

function SummaryCard({ icon, label, value }) {
  return (
    <div className="summary-card">
      <div className="summary-icon">{icon}</div>

      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

// ============================================================
// Doctor directory / preview table
// ============================================================

function DoctorTable({ doctors }) {
  return (
    <div className="doctor-table-wrap">
      <table className="doctor-table">
        <thead>
          <tr>
            <th>Doctor</th>
            <th>Specialty</th>
            <th>Experience</th>
            <th>Description</th>
          </tr>
        </thead>

        <tbody>
          {doctors.map((doctor, index) => (
            <tr key={`${doctor.name}-${index}`}>
              <td>
                <div className="doctor-name-cell">
                  <div className="doctor-avatar">
                    <UserRound size={17} />
                  </div>

                  <strong>{doctor.name}</strong>
                </div>
              </td>

              <td>
                <span className="specialty-pill">
                  {doctor.specialty}
                </span>
              </td>

              <td>{doctor.experience} years</td>
              <td>{doctor.description || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ============================================================
// Appointment summary card
// ============================================================

function AppointmentCard({ appointment, status }) {
  const confirmed =
    status === "confirmed" || status === "booking_completed";

  const hasInformation = Boolean(
    appointment.doctor ||
      appointment.specialty ||
      appointment.date ||
      appointment.time ||
      appointment.patient
  );

  return (
    <div
      className={`card appointment-card ${
        confirmed ? "appointment-confirmed" : ""
      }`}
    >
      <div className="card-title">
        <div className="card-title-icon">
          <CalendarDays size={18} />
        </div>

        <div>
          <h3>Appointment</h3>
          <p>
            {confirmed
              ? "Your appointment details"
              : "Booking details"}
          </p>
        </div>
      </div>

      {!hasInformation && (
        <div className="appointment-empty">
          <CalendarDays size={28} />
          <p>
            Your doctor, date, time, and patient details will appear
            here as you continue.
          </p>
        </div>
      )}

      {hasInformation && (
        <div className="appointment-info">
          <InfoRow
            icon={<UserRound size={17} />}
            label="Doctor"
            value={appointment.doctor || "Not selected"}
          />

          {appointment.specialty && (
            <InfoRow
              icon={<Activity size={17} />}
              label="Specialty"
              value={appointment.specialty}
            />
          )}

          <InfoRow
            icon={<CalendarDays size={17} />}
            label="Date"
            value={appointment.date || "Not selected"}
          />

          <InfoRow
            icon={<Clock size={17} />}
            label="Time"
            value={appointment.time || "Not selected"}
          />

          <InfoRow
            icon={<UserRound size={17} />}
            label="Patient"
            value={appointment.patient || "Not selected"}
          />
        </div>
      )}

      {confirmed && (
        <div className="confirmed">
          <CheckCircle2 size={17} />
          Appointment Confirmed
        </div>
      )}
    </div>
  );
}

// ============================================================
// Appointment information row
// ============================================================

function InfoRow({ icon, label, value }) {
  return (
    <div className="info-row">
      <div className="info-icon">{icon}</div>

      <div className="info-content">
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

// ============================================================
// Parse agent trace details
// ============================================================

function parseTraceDetails(details) {
  if (!details) {
    return null;
  }

  if (typeof details === "object") {
    return details;
  }

  if (typeof details !== "string") {
    return null;
  }

  try {
    return JSON.parse(details);
  } catch {
    // Continue to the limited Python-dict fallback below.
  }

  try {
    const normalized = details
      .replace(/'/g, '"')
      .replace(/\bNone\b/g, "null")
      .replace(/\bTrue\b/g, "true")
      .replace(/\bFalse\b/g, "false");

    return JSON.parse(normalized);
  } catch {
    return null;
  }
}

export default App;
